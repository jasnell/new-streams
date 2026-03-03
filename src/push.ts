/**
 * Push Stream Implementation
 *
 * Creates a bonded pair of writer and async iterable for push-based streaming
 * with built-in backpressure.
 */

import type {
  Writer,
  WriteOptions,
  ByteStreamReadable,
  BackpressurePolicy,
  PushStreamOptions,
  PushStreamResult,
  Transform,
  Drainable,
} from './types.js';
import { drainableProtocol } from './types.js';
import { toUint8Array } from './utils.js';
import { pull as pullWithTransforms } from './pull.js';

// =============================================================================
// Internal Queue State
// =============================================================================

/** Writer state */
type WriterState = 'open' | 'closed' | 'errored';

/** Consumer state */
type ConsumerState = 'active' | 'returned' | 'thrown';

/** Pending write waiting for buffer space (strict and block policies) */
interface PendingWrite {
  chunks: Uint8Array[];
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Pending read waiting for data */
interface PendingRead {
  resolve: (result: IteratorResult<Uint8Array[], void>) => void;
  reject: (error: Error) => void;
}

/** Pending drain waiting for backpressure to clear */
interface PendingDrain {
  resolve: (canWrite: boolean) => void;
  reject: (error: Error) => void;
}

/**
 * Internal queue with chunk-based backpressure.
 *
 * This implements the core buffering logic shared between writer and readable.
 * - Chunk-oriented backpressure: counts write/writev calls, not bytes
 * - Configurable highWaterMark (default: 1)
 * - Four backpressure policies: strict, block, drop-oldest, drop-newest
 *
 * The queue has two parts:
 * - slots: buffer of data ready for consumer (limited by highWaterMark)
 * - pendingWrites: writes waiting to enter slots when buffer is full
 *
 * Backpressure policies control pendingWrites behavior:
 * - strict: pendingWrites limited to highWaterMark (catches ignored backpressure)
 * - block: pendingWrites unbounded (waits indefinitely)
 * - drop-oldest: drops oldest slot to make room (pendingWrites unused)
 * - drop-newest: discards new write (pendingWrites unused)
 */
class PushQueue {
  /** Buffered chunks (each slot is from one write/writev call) */
  private slots: Uint8Array[][] = [];

  /** Pending writes waiting for buffer space (strict policy only) */
  private pendingWrites: PendingWrite[] = [];

  /** Pending reads waiting for data */
  private pendingReads: PendingRead[] = [];

  /** Pending drains waiting for backpressure to clear */
  private pendingDrains: PendingDrain[] = [];

  /** Writer state */
  private writerState: WriterState = 'open';

  /** Consumer state */
  private consumerState: ConsumerState = 'active';

  /** Error that closed the stream */
  private error: Error | null = null;

  /** Total bytes written */
  private bytesWritten = 0;

  /** Configuration */
  private readonly highWaterMark: number;
  private readonly backpressure: BackpressurePolicy;

  /** Abort signal */
  private signal?: AbortSignal;
  private abortHandler?: () => void;

  constructor(options: PushStreamOptions = {}) {
    this.highWaterMark = options.highWaterMark ?? 1;
    this.backpressure = options.backpressure ?? 'strict';
    this.signal = options.signal;

    if (this.signal) {
      if (this.signal.aborted) {
        this.fail(this.signal.reason instanceof Error
          ? this.signal.reason
          : new DOMException('Aborted', 'AbortError'));
      } else {
        this.abortHandler = () => {
          this.fail(this.signal!.reason instanceof Error
            ? this.signal!.reason
            : new DOMException('Aborted', 'AbortError'));
        };
        this.signal.addEventListener('abort', this.abortHandler, { once: true });
      }
    }
  }

  // ===========================================================================
  // Writer Methods
  // ===========================================================================

  /**
   * Get slots available before hitting highWaterMark.
   * Returns null if writer is closed/errored or consumer has terminated.
   */
  get desiredSize(): number | null {
    if (this.writerState !== 'open' || this.consumerState !== 'active') {
      return null;
    }
    return Math.max(0, this.highWaterMark - this.slots.length);
  }

  /**
   * Check if a sync write would be accepted (without actually writing).
   * Returns true if writeSync would accept a write, false otherwise.
   */
  canWriteSync(): boolean {
    if (this.writerState !== 'open') {
      return false;
    }
    if (this.consumerState !== 'active') {
      return false;
    }
    // For strict and block policies, check if there's space
    // For drop-oldest and drop-newest, writes are always accepted
    if ((this.backpressure === 'strict' || this.backpressure === 'block') && this.slots.length >= this.highWaterMark) {
      return false;
    }
    return true;
  }

  /**
   * Write chunks synchronously if possible.
   * Returns true if write completed, false if buffer is full.
   *
   * Note: Caller should check canWriteSync() first if they want to avoid
   * unnecessary work before calling this method.
   */
  writeSync(chunks: Uint8Array[]): boolean {
    // Check if write is possible
    if (this.writerState !== 'open') {
      return false;
    }
    if (this.consumerState !== 'active') {
      return false;
    }

    // Handle based on backpressure policy
    if (this.slots.length >= this.highWaterMark) {
      switch (this.backpressure) {
        case 'strict':
        case 'block':
          return false; // Can't write synchronously

        case 'drop-oldest':
          // Drop oldest slot to make room
          if (this.slots.length > 0) {
            this.slots.shift();
          }
          break;

        case 'drop-newest':
          // Discard this write, but return true (write "succeeded")
          // Track bytes for accounting
          for (const chunk of chunks) {
            this.bytesWritten += chunk.byteLength;
          }
          return true;
      }
    }

    // Add to buffer
    this.slots.push(chunks);
    for (const chunk of chunks) {
      this.bytesWritten += chunk.byteLength;
    }

    // Resolve any pending reads
    this.resolvePendingReads();

    return true;
  }

  /**
   * Write chunks asynchronously.
   * - 'strict': Queues if buffer full but rejects if too many pending writes (>= highWaterMark)
   * - 'block': Waits for buffer space (unbounded pending writes)
   * - 'drop-*': Always succeeds (handled by writeSync)
   *
   * If signal is provided, a write blocked on backpressure will reject immediately
   * when the signal fires. The cancelled write is removed from pendingWrites so it
   * does not occupy a slot. The queue itself is NOT put into an error state — this
   * is per-operation cancellation, not terminal failure.
   */
  async writeAsync(chunks: Uint8Array[], signal?: AbortSignal): Promise<void> {
    // Check for pre-aborted signal
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    // Check if write is possible
    if (this.writerState !== 'open') {
      throw new Error('Writer is closed');
    }
    if (this.consumerState !== 'active') {
      throw this.consumerState === 'thrown' && this.error
        ? this.error
        : new Error('Stream closed by consumer');
    }

    // Try sync first
    if (this.writeSync(chunks)) {
      return;
    }

    // Buffer is full - handle based on policy
    switch (this.backpressure) {
      case 'strict':
        // In strict mode, highWaterMark limits pendingWrites (the "hose")
        // If too many writes are already pending, caller is ignoring backpressure
        if (this.pendingWrites.length >= this.highWaterMark) {
          throw new Error(
            'Backpressure violation: too many pending writes. ' +
            'Await each write() call to respect backpressure.'
          );
        }
        // Otherwise, queue this write and wait for space
        return this.createPendingWrite(chunks, signal);

      case 'block':
        // Wait for space (unbounded pending writes)
        return this.createPendingWrite(chunks, signal);

      default:
        // This shouldn't happen - writeSync handles drop-* policies
        throw new Error('Unexpected: writeSync should have handled non-strict policy');
    }
  }

  /**
   * Create a pending write promise, optionally racing against a signal.
   * If the signal fires, the entry is removed from pendingWrites and the
   * promise rejects. Signal listeners are cleaned up on normal resolution.
   */
  private createPendingWrite(chunks: Uint8Array[], signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry: PendingWrite = { chunks, resolve, reject };
      this.pendingWrites.push(entry);

      if (!signal) return;

      const onAbort = () => {
        // Remove from queue so it doesn't occupy a slot
        const idx = this.pendingWrites.indexOf(entry);
        if (idx !== -1) this.pendingWrites.splice(idx, 1);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };

      // Wrap resolve/reject to clean up signal listener
      const origResolve = entry.resolve;
      const origReject = entry.reject;
      entry.resolve = () => {
        signal.removeEventListener('abort', onAbort);
        origResolve();
      };
      entry.reject = (reason: Error) => {
        signal.removeEventListener('abort', onAbort);
        origReject(reason);
      };

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Signal end of stream. Returns total bytes written.
   */
  end(): number {
    if (this.writerState !== 'open') {
      return this.bytesWritten;
    }

    this.writerState = 'closed';
    this.cleanup();
    this.resolvePendingReads();
    this.rejectPendingWrites(new Error('Writer closed'));
    // Resolve pending drains with false - writer closed, no more writes accepted
    this.resolvePendingDrains(false);

    return this.bytesWritten;
  }

  /**
   * Put queue into terminal error state.
   */
  fail(reason?: Error): void {
    if (this.writerState === 'errored') {
      return;
    }

    this.writerState = 'errored';
    this.error = reason ?? new Error('Failed');
    this.cleanup();
    this.rejectPendingReads(this.error);
    this.rejectPendingWrites(this.error);
    // Reject pending drains with the error
    this.rejectPendingDrains(this.error);
  }

  /**
   * Get total bytes written.
   */
  get totalBytesWritten(): number {
    return this.bytesWritten;
  }

  /**
   * Wait for backpressure to clear (desiredSize > 0).
   * Returns a Promise that:
   * - Resolves with `true` when buffer has space
   * - Resolves with `false` if writer closes while waiting
   * - Rejects if writer fails while waiting
   */
  waitForDrain(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.pendingDrains.push({ resolve, reject });
    });
  }

  // ===========================================================================
  // Consumer Methods
  // ===========================================================================

  /**
   * Read next batch of chunks.
   */
  async read(): Promise<IteratorResult<Uint8Array[], void>> {
    // If there's data in the buffer, return it immediately
    if (this.slots.length > 0) {
      const result = this.drain();
      this.resolvePendingWrites();
      return { value: result, done: false };
    }

    // If writer is done and buffer is empty, we're done
    if (this.writerState === 'closed') {
      return { value: undefined, done: true };
    }

    // If errored, throw
    if (this.writerState === 'errored' && this.error) {
      throw this.error;
    }

    // Wait for data
    return new Promise((resolve, reject) => {
      this.pendingReads.push({ resolve, reject });
    });
  }

  /**
   * Consumer returned early (break from iteration).
   */
  consumerReturn(): void {
    if (this.consumerState !== 'active') {
      return;
    }

    this.consumerState = 'returned';
    this.cleanup();
    this.rejectPendingWrites(new Error('Stream closed by consumer'));
    // Resolve pending drains with false — no more data will be consumed
    this.resolvePendingDrains(false);
  }

  /**
   * Consumer threw an error.
   */
  consumerThrow(error: Error): void {
    if (this.consumerState !== 'active') {
      return;
    }

    this.consumerState = 'thrown';
    this.error = error;
    this.cleanup();
    this.rejectPendingWrites(error);
    // Reject pending drains — the consumer errored
    this.rejectPendingDrains(error);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Drain all buffered chunks into a single flat array.
   */
  private drain(): Uint8Array[] {
    const result: Uint8Array[] = [];
    for (const slot of this.slots) {
      result.push(...slot);
    }
    this.slots = [];
    return result;
  }

  /**
   * Resolve pending reads if data is available.
   */
  private resolvePendingReads(): void {
    // Resolve with available data or completion
    while (this.pendingReads.length > 0) {
      if (this.slots.length > 0) {
        const pending = this.pendingReads.shift()!;
        const result = this.drain();
        this.resolvePendingWrites();
        pending.resolve({ value: result, done: false });
      } else if (this.writerState === 'closed') {
        const pending = this.pendingReads.shift()!;
        pending.resolve({ value: undefined, done: true });
      } else if (this.writerState === 'errored' && this.error) {
        const pending = this.pendingReads.shift()!;
        pending.reject(this.error);
      } else {
        // No data and not done - stop resolving
        break;
      }
    }
  }

  /**
   * Resolve pending writes if buffer has space.
   * Also resolves pending drains when buffer has space.
   */
  private resolvePendingWrites(): void {
    while (this.pendingWrites.length > 0 && this.slots.length < this.highWaterMark) {
      const pending = this.pendingWrites.shift()!;
      this.slots.push(pending.chunks);
      for (const chunk of pending.chunks) {
        this.bytesWritten += chunk.byteLength;
      }
      pending.resolve();
    }

    // Resolve pending drains if buffer has space
    if (this.slots.length < this.highWaterMark) {
      this.resolvePendingDrains(true);
    }
  }

  /**
   * Resolve all pending drains with a value.
   */
  private resolvePendingDrains(canWrite: boolean): void {
    const drains = this.pendingDrains;
    this.pendingDrains = [];
    for (const pending of drains) {
      pending.resolve(canWrite);
    }
  }

  /**
   * Reject all pending drains with an error.
   */
  private rejectPendingDrains(error: Error): void {
    const drains = this.pendingDrains;
    this.pendingDrains = [];
    for (const pending of drains) {
      pending.reject(error);
    }
  }

  /**
   * Reject all pending reads with an error.
   */
  private rejectPendingReads(error: Error): void {
    const reads = this.pendingReads;
    this.pendingReads = [];
    for (const pending of reads) {
      pending.reject(error);
    }
  }

  /**
   * Reject all pending writes with an error.
   */
  private rejectPendingWrites(error: Error): void {
    const writes = this.pendingWrites;
    this.pendingWrites = [];
    for (const pending of writes) {
      pending.reject(error);
    }
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
    if (this.signal && this.abortHandler) {
      this.signal.removeEventListener('abort', this.abortHandler);
      this.abortHandler = undefined;
    }
  }
}

// =============================================================================
// PushWriter Implementation
// =============================================================================

/**
 * Writer implementation for push streams.
 * Implements Drainable protocol for event source integration.
 */
class PushWriter implements Writer, Drainable {
  private readonly queue: PushQueue;

  constructor(queue: PushQueue) {
    this.queue = queue;
  }

  /**
   * Drainable protocol implementation.
   *
   * @returns null if desiredSize is null (writer closed/errored)
   * @returns Promise<true> immediately if desiredSize > 0
   * @returns Promise<true> when backpressure clears
   * @returns Promise<false> if writer closes while waiting
   * @throws if writer fails while waiting
   */
  [drainableProtocol](): Promise<boolean> | null {
    const desired = this.desiredSize;

    // If desiredSize is null, drain is not applicable
    if (desired === null) {
      return null;
    }

    // If there's already space, resolve immediately with true
    if (desired > 0) {
      return Promise.resolve(true);
    }

    // Buffer is full, wait for drain
    return this.queue.waitForDrain();
  }

  get desiredSize(): number | null {
    return this.queue.desiredSize;
  }

  async write(chunk: Uint8Array | string, options?: WriteOptions): Promise<void> {
    const bytes = toUint8Array(chunk);
    await this.queue.writeAsync([bytes], options?.signal);
  }

  async writev(chunks: (Uint8Array | string)[], options?: WriteOptions): Promise<void> {
    const bytes = chunks.map(c => toUint8Array(c));
    await this.queue.writeAsync(bytes, options?.signal);
  }

  writeSync(chunk: Uint8Array | string): boolean {
    // Check if write would be accepted before converting
    if (!this.queue.canWriteSync()) {
      return false;
    }
    const bytes = toUint8Array(chunk);
    return this.queue.writeSync([bytes]);
  }

  writevSync(chunks: (Uint8Array | string)[]): boolean {
    // Check if write would be accepted before converting
    if (!this.queue.canWriteSync()) {
      return false;
    }
    const bytes = chunks.map(c => toUint8Array(c));
    return this.queue.writeSync(bytes);
  }

  async end(options?: WriteOptions): Promise<number> {
    // end() on PushQueue is synchronous (sets state, resolves pending reads).
    // Signal accepted for interface compliance but there is nothing to cancel.
    return this.queue.end();
  }

  endSync(): number {
    return this.queue.end();
  }

  async fail(reason?: Error): Promise<void> {
    this.queue.fail(reason);
  }

  failSync(reason?: Error): boolean {
    this.queue.fail(reason);
    return true;
  }
}

// =============================================================================
// Readable Implementation
// =============================================================================

/**
 * Create the readable async iterable from a queue.
 */
function createReadable(queue: PushQueue): ByteStreamReadable {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array[]> {
      return {
        async next(): Promise<IteratorResult<Uint8Array[], void>> {
          return queue.read();
        },
        async return(): Promise<IteratorResult<Uint8Array[], void>> {
          queue.consumerReturn();
          return { value: undefined, done: true };
        },
        async throw(error: Error): Promise<IteratorResult<Uint8Array[], void>> {
          queue.consumerThrow(error);
          return { value: undefined, done: true };
        },
      };
    },
  };
}

// =============================================================================
// Stream.push() Factory
// =============================================================================

/**
 * Detect if the last argument is options (object without 'transform' property).
 */
function isOptions(arg: unknown): arg is PushStreamOptions {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    !('transform' in arg)
  );
}

/**
 * Parse variadic arguments: [...transforms, options?]
 */
function parseArgs(
  args: (Transform | PushStreamOptions)[]
): { transforms: Transform[]; options: PushStreamOptions } {
  if (args.length === 0) {
    return { transforms: [], options: {} };
  }

  const last = args[args.length - 1];
  if (isOptions(last)) {
    return {
      transforms: args.slice(0, -1) as Transform[],
      options: last,
    };
  }

  return {
    transforms: args as Transform[],
    options: {},
  };
}

/**
 * Create a push stream with optional transforms.
 *
 * @param args - Variadic: transforms, then options (optional)
 * @returns WriterIterablePair with writer and readable
 *
 * @example
 * // Default: strict backpressure (1 pending write at a time)
 * const { writer, readable } = push();
 *
 * @example
 * // With options
 * const { writer, readable } = push({ highWaterMark: 10 });
 *
 * @example
 * // With transforms (applied lazily when consumer pulls)
 * const { writer, readable } = push(compress, encrypt, { highWaterMark: 5 });
 */
export function push(
  ...args: (Transform | PushStreamOptions)[]
): PushStreamResult {
  const { transforms, options } = parseArgs(args);

  const queue = new PushQueue(options);
  const writer = new PushWriter(queue);
  const rawReadable = createReadable(queue);

  // Apply transforms lazily if provided
  // Transforms are applied when the consumer pulls from the readable
  let readable: ByteStreamReadable;
  if (transforms.length > 0) {
    if (options.signal) {
      readable = pullWithTransforms(rawReadable, ...transforms, { signal: options.signal });
    } else {
      readable = pullWithTransforms(rawReadable, ...transforms);
    }
  } else {
    readable = rawReadable;
  }

  return { writer, readable };
}
