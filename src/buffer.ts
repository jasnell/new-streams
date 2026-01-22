/**
 * Unified Buffer with Cursor-based management
 * 
 * This implements the core buffer model described in the README:
 * - One buffer per root stream
 * - Multiple cursors for derived streams (take, tee, etc.)
 * - Backpressure determined by slowest cursor
 * - Bytes reclaimed when all cursors pass them
 */

import type { Cursor, StreamBufferOptions, StreamOverflowPolicy } from './types.js';

export interface BufferState {
  chunks: Uint8Array[];
  totalBytes: number;
  writePosition: number;
  closed: boolean;
  error: Error | null;
}

export interface PendingRead {
  cursor: Cursor;
  atLeast: number;
  max: number;
  target?: Uint8Array;  // BYOB target buffer
  allowView?: boolean;  // If true, may return view into internal buffer
  resolve: (result: { value: Uint8Array | null; done: boolean }) => void;
  reject: (error: Error) => void;
}

export interface PendingWrite {
  data: Uint8Array;
  resolve: () => void;
  reject: (error: Error) => void;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024; // 1MB default

export class UnifiedBuffer {
  private chunks: Uint8Array[] = [];
  private chunkEndPositions: number[] = [];  // End position of each chunk for O(1) lookup
  private totalBytes = 0;
  private writePosition = 0;
  private minPosition = 0; // Position of oldest byte still needed
  private cursors: Map<number, Cursor> = new Map();
  private nextCursorId = 0;
  private closed = false;
  private error: Error | null = null;
  
  private pendingReads: PendingRead[] = [];
  private pendingWrites: PendingWrite[] = [];
  
  readonly maxBuffer: number;
  private readonly hardMax: number;
  private readonly onOverflow: StreamOverflowPolicy;

  // Callbacks for when buffer state changes
  private onDataAvailable?: () => void;
  private onSpaceAvailable?: () => void;
  private onClose?: () => void;
  private onError?: (error: Error) => void;

  constructor(options: StreamBufferOptions = {}) {
    this.maxBuffer = options.max ?? DEFAULT_MAX_BUFFER;
    this.hardMax = options.hardMax ?? this.maxBuffer * 10;
    this.onOverflow = options.onOverflow ?? 'error';
  }

  /**
   * Create a new cursor at the current write position
   * @param limitBytes - Optional limit in bytes (relative to cursor's starting position)
   */
  createCursor(limitBytes?: number): Cursor {
    const cursor: Cursor = {
      id: this.nextCursorId++,
      position: this.writePosition,
      // Store limit as absolute end position for consistent calculations
      limit: limitBytes !== undefined ? this.writePosition + limitBytes : undefined,
      isActive: true,
    };
    this.cursors.set(cursor.id, cursor);
    return cursor;
  }

  /**
   * Create a cursor at a specific position (for sequential branching)
   * @param position - Starting position in the buffer
   * @param limitBytes - Optional limit in bytes (relative to the starting position)
   */
  createCursorAt(position: number, limitBytes?: number): Cursor {
    const cursor: Cursor = {
      id: this.nextCursorId++,
      position,
      // Store limit as absolute end position for consistent calculations
      limit: limitBytes !== undefined ? position + limitBytes : undefined,
      isActive: true,
    };
    this.cursors.set(cursor.id, cursor);
    return cursor;
  }

  /**
   * Remove a cursor (e.g., when stream is cancelled)
   */
  removeCursor(cursor: Cursor): void {
    cursor.isActive = false;
    this.cursors.delete(cursor.id);
    this.maybeReclaimMemory();
    this.maybeResolveBlockedWrites();
  }

  /**
   * Get available bytes for a cursor
   */
  getAvailableBytes(cursor: Cursor): number {
    // cursor.limit is stored as an absolute end position
    const endPosition = cursor.limit !== undefined
      ? Math.min(this.writePosition, cursor.limit)
      : this.writePosition;
    return Math.max(0, endPosition - cursor.position);
  }

  /**
   * Check if cursor has reached its limit or EOF
   */
  isCursorDone(cursor: Cursor): boolean {
    if (cursor.limit !== undefined && cursor.position >= cursor.limit) {
      return true;
    }
    return this.closed && this.getAvailableBytes(cursor) === 0;
  }

  /**
   * Read bytes for a cursor
   * @param cursor - The cursor to read from
   * @param maxBytes - Maximum bytes to read
   * @param allowView - If true, may return a view into internal buffer (faster but caller must not detach)
   */
  read(cursor: Cursor, maxBytes: number, allowView = false): Uint8Array | null {
    const available = this.getAvailableBytes(cursor);
    if (available === 0) {
      return null;
    }

    const toRead = Math.min(maxBytes, available);
    const data = allowView 
      ? this.sliceBytesView(cursor.position, cursor.position + toRead)
      : this.sliceBytes(cursor.position, cursor.position + toRead);
    cursor.position += toRead;
    
    // Only reclaim memory when buffer is getting full (>50% of max)
    // This avoids expensive reclaim operations on every read
    if (this.totalBytes > this.maxBuffer / 2) {
      this.maybeReclaimMemory();
    }
    this.maybeResolveBlockedWrites();
    
    return data;
  }

  /**
   * Read bytes directly into a provided buffer (BYOB - Bring Your Own Buffer)
   * Returns the number of bytes actually read
   */
  readInto(cursor: Cursor, target: Uint8Array): number {
    const available = this.getAvailableBytes(cursor);
    if (available === 0) {
      return 0;
    }

    const toRead = Math.min(target.byteLength, available);
    this.copyBytesInto(cursor.position, cursor.position + toRead, target);
    cursor.position += toRead;
    
    // Only reclaim memory when buffer is getting full (>50% of max)
    if (this.totalBytes > this.maxBuffer / 2) {
      this.maybeReclaimMemory();
    }
    this.maybeResolveBlockedWrites();
    
    return toRead;
  }

  /**
   * Async read that waits for data
   * If target is provided (BYOB mode), reads directly into that buffer
   * @param options.allowView - If true, may return a view into internal buffer (faster)
   */
  async readAsync(
    cursor: Cursor,
    options: { atLeast?: number; max?: number; signal?: AbortSignal; target?: Uint8Array; allowView?: boolean } = {}
  ): Promise<{ value: Uint8Array | null; done: boolean }> {
    const atLeast = options.atLeast ?? 1;
    const max = options.target?.byteLength ?? options.max ?? Infinity;
    const target = options.target;
    const allowView = options.allowView ?? false;

    // Check if already satisfied
    const available = this.getAvailableBytes(cursor);

    if (this.error) {
      throw this.error;
    }

    // Return if we have enough data, OR if buffer is closed (return whatever we have)
    if (available >= atLeast || (this.closed && available > 0)) {
      const toRead = Math.min(max, available);
      
      if (target) {
        // BYOB mode: read directly into provided buffer
        const bytesRead = this.readInto(cursor, target.subarray(0, toRead));
        const value = new Uint8Array(target.buffer, target.byteOffset, bytesRead);
        return { value, done: this.isCursorDone(cursor) };
      } else {
        // Allocating mode - use view if allowed for better performance
        const value = this.read(cursor, toRead, allowView);
        return { value, done: this.isCursorDone(cursor) };
      }
    }

    // Buffer is closed with no data
    if (this.closed) {
      if (target) {
        // Return zero-length view of the BYOB buffer
        return { value: new Uint8Array(target.buffer, target.byteOffset, 0), done: true };
      }
      return { value: null, done: true };
    }

    // Need to wait for more data
    return new Promise((resolve, reject) => {
      const pendingRead: PendingRead = {
        cursor,
        atLeast,
        max,
        target,
        allowView,
        resolve,
        reject,
      };

      // Handle abort signal
      if (options.signal) {
        if (options.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        options.signal.addEventListener('abort', () => {
          const index = this.pendingReads.indexOf(pendingRead);
          if (index !== -1) {
            this.pendingReads.splice(index, 1);
            reject(new DOMException('Aborted', 'AbortError'));
          }
        });
      }

      this.pendingReads.push(pendingRead);
    });
  }

  /**
   * Write bytes to the buffer
   */
  write(data: Uint8Array): void {
    if (this.closed) {
      throw new Error('Cannot write to closed buffer');
    }
    if (this.error) {
      throw this.error;
    }

    // Check buffer limits
    const bufferUsed = this.getBufferUsage();
    
    if (bufferUsed + data.byteLength > this.maxBuffer) {
      switch (this.onOverflow) {
        case 'error':
          const err = new Error(`Buffer overflow: ${bufferUsed + data.byteLength} exceeds max ${this.maxBuffer}`);
          this.setError(err);
          throw err;
        case 'drop-newest':
          // Don't add the data
          return;
        case 'drop-oldest':
          // Drop oldest data to make room
          this.dropOldestBytes(data.byteLength);
          break;
        case 'block':
          // This shouldn't happen in sync write - async write handles blocking
          if (bufferUsed + data.byteLength > this.hardMax) {
            const err = new Error(`Hard buffer limit exceeded: ${bufferUsed + data.byteLength} exceeds ${this.hardMax}`);
            this.setError(err);
            throw err;
          }
          break;
      }
    }

    // Add data to buffer
    this.chunks.push(data);
    this.chunkEndPositions.push(this.writePosition + data.byteLength);
    this.totalBytes += data.byteLength;
    this.writePosition += data.byteLength;

    // Notify pending reads
    this.maybeResolvePendingReads();
  }

  /**
   * Async write that may block based on overflow policy
   */
  async writeAsync(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      throw new Error('Cannot write to closed buffer');
    }
    if (this.error) {
      throw this.error;
    }

    const bufferUsed = this.getBufferUsage();

    // If under limit, write immediately
    if (bufferUsed + data.byteLength <= this.maxBuffer) {
      this.write(data);
      return;
    }

    // Handle overflow based on policy
    switch (this.onOverflow) {
      case 'error':
      case 'drop-newest':
      case 'drop-oldest':
        this.write(data);
        return;

      case 'block':
        // Check hard limit - include pending writes in the calculation
        // to prevent accumulating too many blocked writes
        // TODO: Consider making hardMax calculation configurable (e.g., only count
        //       buffer usage, not pending writes) for different use cases
        const pendingBytes = this.pendingWrites.reduce((sum, pw) => sum + pw.data.byteLength, 0);
        const totalPotentialUsage = bufferUsed + pendingBytes + data.byteLength;
        
        if (totalPotentialUsage > this.hardMax) {
          const err = new Error(`Hard buffer limit exceeded: ${totalPotentialUsage} exceeds ${this.hardMax}`);
          this.setError(err);
          throw err;
        }

        // Wait for space
        // TODO: Consider adding a timeout option to blocked writes to prevent
        //       indefinite blocking when hardMax is not set
        return new Promise((resolve, reject) => {
          const pending: PendingWrite = { data, resolve, reject };
          
          if (signal) {
            if (signal.aborted) {
              reject(new DOMException('Aborted', 'AbortError'));
              return;
            }
            const abortHandler = () => {
              const index = this.pendingWrites.indexOf(pending);
              if (index !== -1) {
                this.pendingWrites.splice(index, 1);
                reject(new DOMException('Aborted', 'AbortError'));
              }
            };
            signal.addEventListener('abort', abortHandler, { once: true });
          }

          this.pendingWrites.push(pending);
        });
    }
  }

  /**
   * Close the buffer (signal end of data)
   */
  close(): void {
    this.closed = true;
    this.maybeResolvePendingReads();
    
    // Reject all pending writes - buffer is closed, they can never complete
    const closeError = new Error('Cannot write to closed buffer');
    for (const pending of this.pendingWrites) {
      pending.reject(closeError);
    }
    this.pendingWrites = [];
    
    this.onClose?.();
  }

  /**
   * Set error state
   */
  setError(error: Error): void {
    this.error = error;
    this.closed = true;
    
    // Reject all pending reads
    for (const pending of this.pendingReads) {
      pending.reject(error);
    }
    this.pendingReads = [];

    // Reject all pending writes
    for (const pending of this.pendingWrites) {
      pending.reject(error);
    }
    this.pendingWrites = [];

    this.onError?.(error);
  }

  /**
   * Get current buffer usage (bytes held for slow cursors)
   */
  getBufferUsage(): number {
    const minCursorPos = this.getMinCursorPosition();
    return this.writePosition - minCursorPos;
  }

  /**
   * Get desired size (space available before max)
   */
  getDesiredSize(): number | null {
    if (this.closed) return null;
    return this.maxBuffer - this.getBufferUsage();
  }

  /**
   * Check if buffer is closed
   */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Check if buffer has error
   */
  hasError(): boolean {
    return this.error !== null;
  }

  /**
   * Get the error if any
   */
  getError(): Error | null {
    return this.error;
  }

  // Private methods

  private getMinCursorPosition(): number {
    if (this.cursors.size === 0) {
      return this.writePosition;
    }
    let min = Infinity;
    for (const cursor of this.cursors.values()) {
      if (cursor.isActive) {
        min = Math.min(min, cursor.position);
      }
    }
    return min === Infinity ? this.writePosition : min;
  }

  private maybeReclaimMemory(): void {
    const minPos = this.getMinCursorPosition();
    
    // Remove chunks that are before minPos
    let bytesToDiscard = minPos - this.minPosition;
    while (bytesToDiscard > 0 && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      if (chunk.byteLength <= bytesToDiscard) {
        this.chunks.shift();
        this.chunkEndPositions.shift();
        bytesToDiscard -= chunk.byteLength;
        this.totalBytes -= chunk.byteLength;
      } else {
        // Partial chunk - slice it
        this.chunks[0] = chunk.slice(bytesToDiscard);
        // Update the first chunk end position (it's still at the same global position)
        this.totalBytes -= bytesToDiscard;
        bytesToDiscard = 0;
      }
    }
    this.minPosition = minPos;
  }

  private maybeResolvePendingReads(): void {
    const toResolve: PendingRead[] = [];
    const remaining: PendingRead[] = [];

    for (const pending of this.pendingReads) {
      const available = this.getAvailableBytes(pending.cursor);

      if (this.error) {
        pending.reject(this.error);
      } else if (available >= pending.atLeast || (this.closed && available > 0)) {
        // Have enough data, or buffer closed with some data - resolve with what we have
        toResolve.push(pending);
      } else if (this.closed) {
        // Buffer closed with no data
        if (pending.target) {
          // Return zero-length view of the BYOB buffer
          pending.resolve({ 
            value: new Uint8Array(pending.target.buffer, pending.target.byteOffset, 0), 
            done: true 
          });
        } else {
          pending.resolve({ value: null, done: true });
        }
      } else {
        remaining.push(pending);
      }
    }

    this.pendingReads = remaining;

    for (const pending of toResolve) {
      const available = this.getAvailableBytes(pending.cursor);
      const toRead = Math.min(pending.max, available);
      
      if (pending.target) {
        // BYOB mode: read directly into provided buffer
        const bytesRead = this.readInto(pending.cursor, pending.target.subarray(0, toRead));
        const value = new Uint8Array(pending.target.buffer, pending.target.byteOffset, bytesRead);
        pending.resolve({ value, done: this.isCursorDone(pending.cursor) });
      } else {
        // Allocating mode - use view if allowed
        const value = this.read(pending.cursor, toRead, pending.allowView);
        pending.resolve({ value, done: this.isCursorDone(pending.cursor) });
      }
    }
  }

  /**
   * Resolve blocked writes in FIFO order.
   * 
   * IMPORTANT: Blocked writes MUST be resolved in order. We cannot skip a large
   * write to resolve a smaller one that fits, as this would violate write ordering
   * guarantees. The first blocked write must complete before any subsequent ones.
   * 
   * TODO: Consider adding an option to allow out-of-order resolution for use cases
   *       where write ordering is not important (e.g., independent log entries)
   * TODO: Consider adding metrics/callbacks for monitoring blocked write queue depth
   */
  private maybeResolveBlockedWrites(): void {
    if (this.onOverflow !== 'block') return;

    // Process writes in FIFO order - stop at first one that doesn't fit
    while (this.pendingWrites.length > 0) {
      const pending = this.pendingWrites[0];
      const bufferUsed = this.getBufferUsage();
      
      // Check if first pending write fits under max
      if (bufferUsed + pending.data.byteLength <= this.maxBuffer) {
        // Remove from queue and write
        this.pendingWrites.shift();
        try {
          this.write(pending.data);
          pending.resolve();
        } catch (e) {
          pending.reject(e as Error);
        }
        // Continue to check next write
      } else {
        // First write doesn't fit - stop processing (maintain FIFO order)
        break;
      }
    }
  }

  private dropOldestBytes(bytesNeeded: number): void {
    // Move min cursor position forward to drop oldest data
    const minPos = this.getMinCursorPosition();
    const targetDrop = bytesNeeded;
    
    // Advance all cursors that are at the minimum position
    for (const cursor of this.cursors.values()) {
      if (cursor.position === minPos) {
        cursor.position += targetDrop;
      }
    }
    
    this.maybeReclaimMemory();
  }

  /**
   * Find the chunk index that contains the given position using binary search
   */
  private findChunkIndex(position: number): number {
    // Binary search for the first chunk whose end position is > position
    let low = 0;
    let high = this.chunkEndPositions.length - 1;
    
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.chunkEndPositions[mid] <= position) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /**
   * Get bytes as a view (no copy) when possible, otherwise copy.
   * WARNING: Caller must not detach the returned buffer as it may be internal data.
   */
  private sliceBytesView(start: number, end: number): Uint8Array {
    const length = end - start;
    if (length <= 0) {
      return new Uint8Array(0);
    }

    // Use binary search to find the starting chunk
    const startChunkIdx = this.findChunkIndex(start);
    
    // Check if the entire read fits within a single chunk
    if (startChunkIdx < this.chunkEndPositions.length) {
      const chunkEnd = this.chunkEndPositions[startChunkIdx];
      if (end <= chunkEnd) {
        // Single chunk case - return a view (no allocation!)
        const chunk = this.chunks[startChunkIdx];
        const chunkStart = startChunkIdx === 0 ? this.minPosition : this.chunkEndPositions[startChunkIdx - 1];
        const sliceStart = start - chunkStart;
        return chunk.subarray(sliceStart, sliceStart + length);
      }
    }

    // Multi-chunk case - must copy
    const result = new Uint8Array(length);
    this.copyBytesIntoFast(start, end, result, startChunkIdx);
    return result;
  }

  private sliceBytes(start: number, end: number): Uint8Array {
    const length = end - start;
    if (length <= 0) {
      return new Uint8Array(0);
    }

    // Always copy data to ensure caller owns the result
    // This is necessary because callers (like Writer) may detach the buffer,
    // which would corrupt our internal state if we returned a view
    
    // Use binary search to find the starting chunk
    const startChunkIdx = this.findChunkIndex(start);
    
    // Allocate result buffer
    const result = new Uint8Array(length);
    
    // Check if the entire read fits within a single chunk
    if (startChunkIdx < this.chunkEndPositions.length) {
      const chunkEnd = this.chunkEndPositions[startChunkIdx];
      if (end <= chunkEnd) {
        // Single chunk case - direct copy
        const chunk = this.chunks[startChunkIdx];
        const chunkStart = startChunkIdx === 0 ? this.minPosition : this.chunkEndPositions[startChunkIdx - 1];
        const sliceStart = start - chunkStart;
        result.set(chunk.subarray(sliceStart, sliceStart + length));
        return result;
      }
    }

    // Multi-chunk case
    this.copyBytesIntoFast(start, end, result, startChunkIdx);
    return result;
  }

  /**
   * Copy bytes from buffer range directly into target array
   */
  private copyBytesInto(start: number, end: number, target: Uint8Array): void {
    this.copyBytesIntoFast(start, end, target, 0);
  }

  /**
   * Copy bytes from buffer range into target array, starting from a known chunk index
   */
  private copyBytesIntoFast(start: number, end: number, target: Uint8Array, startChunkIdx: number): void {
    let offset = 0;
    
    for (let i = startChunkIdx; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const chunkEnd = this.chunkEndPositions[i];
      const chunkStart = i === 0 ? this.minPosition : this.chunkEndPositions[i - 1];
      
      if (chunkEnd > start && chunkStart < end) {
        // This chunk overlaps with requested range
        const sliceStart = Math.max(0, start - chunkStart);
        const sliceEnd = Math.min(chunk.byteLength, end - chunkStart);
        const copyLen = sliceEnd - sliceStart;
        
        // Use subarray to avoid allocation, then set
        target.set(chunk.subarray(sliceStart, sliceEnd), offset);
        offset += copyLen;
      }
      
      if (chunkEnd >= end) break;
    }
  }
}
