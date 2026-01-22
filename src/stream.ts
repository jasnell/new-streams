/**
 * Stream - The primary readable byte stream
 * 
 * This is a bytes-only stream API that simplifies Web Streams while
 * providing better ergonomics and performance characteristics.
 */

import type {
  StreamPullOptions,
  StreamPushOptions,
  StreamFromOptions,
  StreamTransformOptions,
  StreamPipeOptions,
  StreamPipeToOptions,
  StreamConsumeOptions,
  StreamTeeOptions,
  StreamReadOptions,
  StreamReadResult,
  StreamPipelineOptions,
  StreamTransformer,
  StreamPullSource,
  StreamWriteData,
  WriterSink,
  StreamBufferOptions,
  Cursor,
} from './types.js';
import { UnifiedBuffer } from './buffer.js';
import { Writer } from './writer.js';
import {
  toUint8Array,
  concatBytes,
  isAsyncGenerator,
  isGenerator,
  isAsyncIterable,
  isIterable,
  isTransformerObject,
  deferred,
  detachBuffer,
} from './utils.js';

/**
 * Result type for Stream.push() and Stream.transform()
 * Supports destructuring: const [stream, writer] = Stream.push()
 */
export class StreamWithWriter {
  readonly stream: Stream;
  readonly writer: Writer;

  constructor(stream: Stream, writer: Writer) {
    this.stream = stream;
    this.writer = writer;
  }

  *[Symbol.iterator](): Iterator<Stream | Writer> {
    yield this.stream;
    yield this.writer;
  }
}

export class Stream implements AsyncIterable<Uint8Array> {
  readonly #buffer: UnifiedBuffer;
  readonly #cursor: Cursor;
  readonly #encoding: string;
  readonly #parentStream: Stream | null;
  
  #detached: boolean;
  #cancelled = false;
  #bytesRead = 0;
  
  // Read queue: ensures concurrent reads are serialized
  #readQueue: Promise<void> = Promise.resolve();
  
  readonly #closedPromise: Promise<number>;
  #resolveClose!: (bytes: number) => void;
  #rejectClose!: (error: Error) => void;

  private constructor(
    buffer: UnifiedBuffer,
    cursor: Cursor,
    options: {
      encoding?: string;
      detached?: boolean;
      parentStream?: Stream;
    } = {}
  ) {
    this.#buffer = buffer;
    this.#cursor = cursor;
    this.#encoding = options.encoding ?? 'utf-8';
    this.#detached = options.detached ?? false;
    this.#parentStream = options.parentStream ?? null;

    this.#closedPromise = new Promise((resolve, reject) => {
      this.#resolveClose = resolve;
      this.#rejectClose = reject;
    });

    // Mark as handled to avoid unhandled rejection warnings
    this.#closedPromise.catch(() => {});
  }

  // ==================== Static Factory Methods ====================

  /**
   * Create from sync/async generator (pull source)
   */
  static pull(source: StreamPullSource, options: StreamPullOptions = {}): Stream {
    const buffer = new UnifiedBuffer();
    const cursor = buffer.createCursor();
    const stream = new Stream(buffer, cursor, { encoding: options.encoding });

    // Start pulling from generator
    const generator = source();
    stream.#startPulling(generator, options.encoding ?? 'utf-8');

    return stream;
  }

  /**
   * Create push source - returns [Stream, Writer] pair
   */
  static push(options: StreamPushOptions = {}): StreamWithWriter {
    const buffer = new UnifiedBuffer(options.buffer);
    const cursor = buffer.createCursor();
    const stream = new Stream(buffer, cursor, { encoding: options.encoding });
    const writer = new Writer(buffer, { encoding: options.encoding });

    return new StreamWithWriter(stream, writer);
  }

  /**
   * Create from various byte sources
   */
  static from(source: StreamWriteData | StreamWriteData[] | Stream, options: StreamFromOptions = {}): Stream {
    const encoding = options.encoding ?? 'utf-8';

    // If it's already a Stream, return it (or should we clone?)
    if (source instanceof Stream) {
      return source;
    }

    // If it's an array, create a stream that yields each element
    if (Array.isArray(source)) {
      return Stream.pull(function* () {
        for (const item of source) {
          yield item;
        }
      }, { encoding });
    }

    // Single value - create a simple stream
    const buffer = new UnifiedBuffer();
    const cursor = buffer.createCursor();
    const stream = new Stream(buffer, cursor, { encoding });

    const bytes = toUint8Array(source, encoding);
    buffer.write(bytes);
    buffer.close();

    return stream;
  }

  /**
   * Create empty (already closed) stream
   */
  static empty(): Stream {
    const buffer = new UnifiedBuffer();
    const cursor = buffer.createCursor();
    const stream = new Stream(buffer, cursor);
    buffer.close();
    return stream;
  }

  /**
   * Create a stream that never produces data (optionally errored)
   */
  static never(reason?: unknown): Stream {
    const buffer = new UnifiedBuffer();
    const cursor = buffer.createCursor();
    const stream = new Stream(buffer, cursor);
    
    if (reason !== undefined) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      buffer.setError(error);
      stream.#rejectClose(error);
    }
    
    return stream;
  }

  /**
   * Merge multiple streams (interleaved, first-come)
   */
  static merge(...streams: Stream[]): Stream {
    if (streams.length === 0) {
      return Stream.empty();
    }
    if (streams.length === 1) {
      return streams[0];
    }

    const buffer = new UnifiedBuffer();
    const cursor = buffer.createCursor();
    const stream = new Stream(buffer, cursor);

    // Read from all streams concurrently
    let activeCount = streams.length;
    
    for (const src of streams) {
      (async () => {
        try {
          for await (const chunk of src) {
            buffer.write(chunk);
          }
        } catch (e) {
          buffer.setError(e as Error);
        } finally {
          activeCount--;
          if (activeCount === 0) {
            buffer.close();
          }
        }
      })();
    }

    return stream;
  }

  /**
   * Concatenate multiple streams (sequential)
   */
  static concat(...streams: Stream[]): Stream {
    if (streams.length === 0) {
      return Stream.empty();
    }
    if (streams.length === 1) {
      return streams[0];
    }

    return Stream.pull(async function* () {
      for (const stream of streams) {
        yield stream;
      }
    });
  }

  /**
   * Create transform - returns [Stream, Writer] pair
   */
  static transform(
    transformer: StreamTransformer,
    options: StreamTransformOptions = {}
  ): StreamWithWriter {
    const buffer = new UnifiedBuffer(options.buffer);
    const cursor = buffer.createCursor();
    const outputStream = new Stream(buffer, cursor, { encoding: options.encoding });

    // Create internal buffer for input
    const inputBuffer = new UnifiedBuffer();
    const inputCursor = inputBuffer.createCursor();
    const writer = new Writer(inputBuffer, { encoding: options.encoding });

    // Start transform processing
    outputStream.#startTransform(inputBuffer, inputCursor, transformer, options);

    return new StreamWithWriter(outputStream, writer);
  }

  /**
   * Create writer with custom sink
   */
  static writer(sink: WriterSink, options: { encoding?: string; buffer?: StreamBufferOptions } = {}): Writer {
    const buffer = new UnifiedBuffer(options.buffer);
    return new Writer(buffer, { encoding: options.encoding, sink });
  }

  /**
   * Construct optimized pipeline: source → transforms → destination
   */
  static async pipeline(
    source: Stream,
    ...args: (StreamTransformer | Writer | StreamPipelineOptions)[]
  ): Promise<number> {
    // Parse arguments - last might be options
    let stages: (StreamTransformer | Writer)[];
    let options: StreamPipelineOptions = {};

    const lastArg = args[args.length - 1];
    if (lastArg && typeof lastArg === 'object' && !('write' in lastArg) && !('transform' in lastArg) && typeof lastArg !== 'function') {
      options = lastArg as StreamPipelineOptions;
      stages = args.slice(0, -1) as (StreamTransformer | Writer)[];
    } else {
      stages = args as (StreamTransformer | Writer)[];
    }

    if (stages.length === 0) {
      throw new Error('Pipeline requires at least a destination');
    }

    // Build pipeline
    let current: Stream = source;
    
    // Apply limit if specified
    if (options.limit !== undefined) {
      current = current.limit(options.limit);
    }

    // Process transforms (all but last must be transforms, last must be Writer)
    for (let i = 0; i < stages.length - 1; i++) {
      const stage = stages[i];
      if (stage instanceof Writer) {
        throw new Error('Only the last stage can be a Writer');
      }
      current = current.pipeThrough(stage as StreamTransformer);
    }

    // Pipe to destination
    const dest = stages[stages.length - 1];
    if (!(dest instanceof Writer)) {
      throw new Error('Last stage must be a Writer');
    }

    return current.pipeTo(dest, {
      signal: options.signal,
      preventClose: options.preventClose,
    });
  }

  // ==================== Consumption Methods ====================

  /**
   * Collect all bytes as Uint8Array
   * 
   * Optimized to read chunks directly without async iterator overhead,
   * then concatenate in a single pass.
   */
  async bytes(options: StreamConsumeOptions = {}): Promise<Uint8Array> {
    // Auto-attach if detached
    if (this.#detached) {
      this.attach();
    }

    if (this.#cancelled) {
      return new Uint8Array(0);
    }

    // Collect chunks using direct read() calls instead of async iteration
    // Use allowView: true since we're copying to a final buffer anyway
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    
    while (!this.#cancelled) {
      const { value, done } = await this.#buffer.readAsync(this.#cursor, {
        signal: options.signal,
        allowView: true,  // Safe: we copy to final result, don't detach
      });
      
      if (value) {
        chunks.push(value);
        totalLength += value.byteLength;
        this.#bytesRead += value.byteLength;
      }
      
      if (done) {
        break;
      }
    }
    
    this.#resolveClose(this.#bytesRead);
    
    // Fast path: single chunk or empty
    if (chunks.length === 0) {
      return new Uint8Array(0);
    }
    if (chunks.length === 1) {
      return chunks[0];
    }
    
    // Concatenate all chunks in single allocation
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    
    return result;
  }

  /**
   * Collect all bytes as ArrayBuffer
   * 
   * Optimized to avoid copying when the bytes result already owns
   * its underlying ArrayBuffer (single chunk case).
   */
  async arrayBuffer(options: StreamConsumeOptions = {}): Promise<ArrayBuffer> {
    const bytes = await this.bytes(options);
    
    // If bytes is a view of the entire ArrayBuffer with no offset,
    // we can return the underlying buffer directly
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes.buffer as ArrayBuffer;
    }
    
    // Otherwise copy to a new ArrayBuffer to ensure clean ownership
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  }

  /**
   * Collect and decode as text
   * 
   * Uses optimized bytes() collection then decodes the result.
   * This is faster than streaming decode due to string concatenation overhead.
   */
  async text(encoding = 'utf-8', options: StreamConsumeOptions = {}): Promise<string> {
    const bytes = await this.bytes(options);
    return new TextDecoder(encoding).decode(bytes);
  }

  // ==================== Slicing Operators ====================

  /**
   * View of next n bytes; parent continues at byte n
   */
  take(byteCount: number): Stream {
    // Create a new cursor with a limit
    const newCursor = this.#buffer.createCursorAt(this.#cursor.position, byteCount);
    
    // Advance parent cursor past these bytes
    this.#cursor.position += byteCount;
    
    return new Stream(this.#buffer, newCursor, {
      encoding: this.#encoding,
      parentStream: this,
    });
  }

  /**
   * Discard next n bytes; returns closed stream
   */
  drop(byteCount: number): Stream {
    // Simply advance our cursor
    this.#cursor.position += byteCount;
    
    // Return an empty/closed stream
    return Stream.empty();
  }

  /**
   * Cap stream at n bytes; cancels source after limit reached.
   * 
   * Unlike take(n) which creates a branch (parent continues), limit(n) is terminal:
   * - The returned stream IS this stream, capped at n bytes
   * - The source is cancelled when the limit is reached or the stream is consumed
   * - The original stream reference should not be used after calling limit()
   * 
   * TODO: Consider making limit() return a new Stream wrapper that tracks consumption
   *       and cancels when done, rather than modifying the cursor in place.
   */
  limit(byteCount: number): Stream {
    // Set a limit on the current cursor (doesn't create a branch like take())
    // Store the absolute limit position
    const limitPosition = this.#cursor.position + byteCount;
    
    // Update cursor limit if it's not already set or if new limit is smaller
    const currentLimit = this.#cursor.limit;
    if (currentLimit === undefined || limitPosition < currentLimit) {
      this.#cursor.limit = limitPosition;
    }
    
    // Set up cancellation when the limited stream is done
    // This is the key difference from take() - we cancel the source
    this.closed.then(() => {
      // Cancel the underlying source to release resources
      // The buffer's removeCursor handles cleanup
      this.#buffer.removeCursor(this.#cursor);
    }).catch(() => {
      // Ignore errors - cleanup still happens
    });
    
    // Return this stream (not a new branch) - limit() is terminal
    return this;
  }

  // ==================== Branching ====================

  /**
   * Create a new branch; both this stream and the returned stream see the same bytes
   */
  tee(options: StreamTeeOptions = {}): Stream {
    // Calculate the remaining limit for the tee'd branch
    // If this stream has a cursor limit, the new branch should have the same remaining limit
    const remainingLimit = this.#getRemainingLimit();
    
    if (options.detached) {
      // Create detached branch - cursor created on first read
      const newCursor = this.#buffer.createCursorAt(this.#cursor.position, remainingLimit);
      newCursor.isActive = false; // Mark as inactive until attached
      
      return new Stream(this.#buffer, newCursor, {
        encoding: this.#encoding,
        detached: true,
        parentStream: this,
      });
    }

    // Create active branch at current position, inheriting any limit
    const newCursor = this.#buffer.createCursorAt(this.#cursor.position, remainingLimit);
    
    return new Stream(this.#buffer, newCursor, {
      encoding: this.#encoding,
      parentStream: this,
    });
  }

  /**
   * True if this stream was created with { detached: true } and has not yet been attached
   */
  get detached(): boolean {
    return this.#detached;
  }

  /**
   * Attach a detached branch to the parent stream at the current position
   */
  attach(): void {
    if (!this.#detached) {
      return; // Already attached or was never detached
    }
    
    this.#cursor.isActive = true;
    this.#detached = false;
  }

  // ==================== Piping ====================

  /**
   * Pipe through transform, return readable output
   */
  pipeThrough(transformer: StreamTransformer, options: StreamPipeOptions = {}): Stream {
    const result = Stream.transform(transformer, {
      chunkSize: options.chunkSize,
      buffer: options.buffer,
    });
    const outputStream = result.stream;
    const writer = result.writer;

    // Pipe this stream to the transform's writer
    const pipePromise = this.pipeTo(writer, {
      signal: options.signal,
      limit: options.limit,
    });

    // Handle errors
    pipePromise.catch(error => {
      if (outputStream.#buffer.hasError()) return;
      outputStream.#buffer.setError(error);
    });

    return outputStream;
  }

  /**
   * Pipe to destination (consumes this stream); resolves with total bytes piped
   * 
   * Signal cancellation behavior:
   * - If signal is already aborted, rejects immediately with AbortError
   * - If signal is aborted during piping, stops iteration and rejects with AbortError
   * - On abort: destination.abort() is called (unless preventAbort)
   * - On abort: source.cancel() is called (unless preventCancel)
   * 
   * TODO: Consider adding onProgress callback for monitoring large transfers
   * TODO: Consider adding timeout option as convenience over manual AbortSignal.timeout()
   */
  async pipeTo(destination: Writer, options: StreamPipeToOptions = {}): Promise<number> {
    // Check for already-aborted signal before starting
    if (options.signal?.aborted) {
      const error = new DOMException('Aborted', 'AbortError');
      if (!options.preventAbort) {
        await destination.abort(error);
      }
      if (!options.preventCancel) {
        await this.cancel(error);
      }
      throw error;
    }

    let bytesPiped = 0;
    let bytesLimit = options.limit ?? Infinity;

    try {
      // TODO: Consider adding a way to pause/resume piping for flow control
      for await (const chunk of this.#iterate(options.signal)) {
        // Capture byte length BEFORE write (write may detach the buffer)
        const chunkLength = chunk.byteLength;
        
        if (bytesPiped + chunkLength > bytesLimit) {
          // Partial write to meet limit
          const remaining = bytesLimit - bytesPiped;
          if (remaining > 0) {
            await destination.write(chunk.slice(0, remaining));
            bytesPiped += remaining;
          }
          break;
        }
        
        await destination.write(chunk);
        bytesPiped += chunkLength;
      }

      if (!options.preventClose) {
        await destination.close();
      }
    } catch (error) {
      if (!options.preventAbort) {
        await destination.abort(error);
      }
      if (!options.preventCancel) {
        await this.cancel(error);
      }
      throw error;
    }

    return bytesPiped;
  }

  // ==================== Cancellation ====================

  /**
   * Cancel the stream (signal disinterest); resolves with total bytes read before cancel
   */
  async cancel(reason?: unknown): Promise<number> {
    if (this.#cancelled) {
      return this.#bytesRead;
    }

    this.#cancelled = true;
    this.#buffer.removeCursor(this.#cursor);
    this.#resolveClose(this.#bytesRead);

    return this.#bytesRead;
  }

  // ==================== Low-level Read Access ====================

  /**
   * Read bytes from stream
   * 
   * Concurrent reads are queued and executed in order. Each read waits for
   * the previous read to complete before starting.
   */
  async read(options: StreamReadOptions = {}): Promise<StreamReadResult> {
    // Queue this read behind any pending reads
    // This ensures concurrent reads are serialized in call order
    const previousRead = this.#readQueue;
    
    let resolveQueue: () => void;
    this.#readQueue = new Promise(resolve => {
      resolveQueue = resolve;
    });

    try {
      // Wait for previous read to complete
      await previousRead;
      
      // Now perform this read
      return await this.#doRead(options);
    } finally {
      // Allow next read to proceed
      resolveQueue!();
    }
  }

  /**
   * Internal read implementation (called after queue wait)
   */
  async #doRead(options: StreamReadOptions): Promise<StreamReadResult> {
    // Validate options
    if (options.atLeast !== undefined && options.max !== undefined) {
      if (options.atLeast > options.max) {
        throw new RangeError(`atLeast (${options.atLeast}) cannot be greater than max (${options.max})`);
      }
    }

    // Auto-attach if detached
    if (this.#detached) {
      this.attach();
    }

    if (this.#cancelled) {
      return { value: null, done: true };
    }

    // Handle BYOB mode - detach the provided buffer first
    let byobBuffer: Uint8Array | undefined;
    if (options.buffer) {
      // Detach the caller's buffer - this transfers ownership to us
      byobBuffer = detachBuffer(options.buffer);
    }

    // Pass BYOB target directly to buffer.readAsync for true zero-copy reads
    const result = await this.#buffer.readAsync(this.#cursor, {
      atLeast: options.atLeast,
      max: options.max,
      signal: options.signal,
      target: byobBuffer,  // BYOB: read directly into this buffer
    });

    if (result.value) {
      this.#bytesRead += result.value.byteLength;
    }

    if (result.done) {
      this.#resolveClose(this.#bytesRead);
    }

    return result;
  }

  /**
   * Promise that resolves with total bytes read when stream closes
   */
  get closed(): Promise<number> {
    return this.#closedPromise;
  }

  // ==================== Async Iterable ====================

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    yield* this.#iterate();
  }

  // ==================== Explicit Resource Management ====================

  /**
   * Calls cancel() when disposed
   */
  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.#cancelled) {
      await this.cancel();
    }
  }

  // ==================== Private Methods ====================

  /**
   * Calculate the remaining limit for this stream's cursor.
   * Used when tee'ing to propagate limits to the new branch.
   * Returns undefined if the stream has no limit.
   */
  #getRemainingLimit(): number | undefined {
    if (this.#cursor.limit === undefined) {
      return undefined;
    }
    // cursor.limit is stored as an absolute end position
    // Calculate remaining bytes from current position to limit
    return Math.max(0, this.#cursor.limit - this.#cursor.position);
  }

  async *#iterate(signal?: AbortSignal): AsyncGenerator<Uint8Array, void, unknown> {
    // Auto-attach if detached
    if (this.#detached) {
      this.attach();
    }

    while (!this.#cancelled) {
      const { value, done } = await this.read({ signal });
      
      if (value) {
        yield value;
      }
      
      if (done) {
        break;
      }
    }
  }

  async #startPulling(
    generator: Generator<unknown, void, unknown> | AsyncGenerator<unknown, void, unknown>,
    encoding: string
  ): Promise<void> {
    try {
      if (isAsyncGenerator(generator)) {
        for await (const value of generator) {
          // For async generators, always use the async handler
          // The `for await` already yields to event loop between iterations
          await this.#handlePullValueAsync(value, encoding);
        }
      } else if (isGenerator(generator)) {
        // Sync generator: try fast path, apply backpressure when buffer is full
        for (const value of generator) {
          // Check if buffer needs draining (backpressure)
          const bufferUsage = this.#buffer.getBufferUsage();
          if (bufferUsage >= this.#buffer.maxBuffer * 0.8) {
            // Buffer is mostly full - yield to let consumers catch up
            await new Promise<void>(resolve => setImmediate(resolve));
          }
          
          const needsAsync = this.#handlePullValueSync(value, encoding);
          if (needsAsync) {
            // Value requires async handling (Stream or async generator)
            await this.#handlePullValueAsync(value, encoding);
          }
        }
      }
      this.#buffer.close();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.#buffer.setError(error);
      this.#rejectClose(error);
    }
  }

  /**
   * Synchronous value handler - returns true if value needs async handling
   */
  #handlePullValueSync(value: unknown, encoding: string): boolean {
    // If it's a sync generator, consume it inline (sync)
    if (isGenerator(value)) {
      for (const chunk of value) {
        const needsAsync = this.#handlePullValueSync(chunk as StreamWriteData, encoding);
        if (needsAsync) {
          // Can't handle async in sync loop - caller must handle
          return true;
        }
      }
      return false;
    }

    // Streams and async generators require async handling
    if (value instanceof Stream || isAsyncGenerator(value)) {
      return true; // Signal to caller to use async path
    }

    // Convert to bytes and write (sync)
    const bytes = toUint8Array(value as StreamWriteData, encoding);
    this.#buffer.write(bytes);
    return false;
  }

  /**
   * Async value handler for values that need async processing
   */
  async #handlePullValueAsync(value: unknown, encoding: string): Promise<void> {
    // If it's a Stream, consume it inline
    if (value instanceof Stream) {
      for await (const chunk of value) {
        this.#buffer.write(chunk);
      }
      return;
    }

    // If it's an async generator, consume it inline
    if (isAsyncGenerator(value)) {
      for await (const chunk of value) {
        await this.#handlePullValueAsync(chunk as StreamWriteData, encoding);
      }
      return;
    }

    // If it's a sync generator, try sync first, fall back to async
    if (isGenerator(value)) {
      for (const chunk of value) {
        const needsAsync = this.#handlePullValueSync(chunk as StreamWriteData, encoding);
        if (needsAsync) {
          await this.#handlePullValueAsync(chunk as StreamWriteData, encoding);
        }
      }
      return;
    }

    // Convert to bytes and write
    const bytes = toUint8Array(value as StreamWriteData, encoding);
    this.#buffer.write(bytes);
  }

  async #startTransform(
    inputBuffer: UnifiedBuffer,
    inputCursor: Cursor,
    transformer: StreamTransformer,
    options: StreamTransformOptions
  ): Promise<void> {
    const transform = isTransformerObject(transformer) ? transformer.transform.bind(transformer) : transformer;
    const abort = isTransformerObject(transformer) && transformer.abort ? transformer.abort.bind(transformer) : undefined;

    try {
      // Read from input buffer and transform
      while (true) {
        const { value, done } = await inputBuffer.readAsync(inputCursor, {
          atLeast: options.chunkSize,
          max: options.chunkSize,
        });

        if (value) {
          await this.#processTransformResult(transform(value), options.encoding ?? 'utf-8');
        }

        if (done) {
          // Send flush signal
          await this.#processTransformResult(transform(null), options.encoding ?? 'utf-8');
          break;
        }
      }

      this.#buffer.close();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      abort?.(e);
      this.#buffer.setError(error);
      this.#rejectClose(error);
    }
  }

  async #processTransformResult(result: unknown, encoding: string): Promise<void> {
    if (result === null || result === undefined) {
      return;
    }

    // Handle Promise
    if (result instanceof Promise) {
      result = await result;
      if (result === null || result === undefined) return;
    }

    // Handle Uint8Array or BufferSource
    if (result instanceof Uint8Array || result instanceof ArrayBuffer || ArrayBuffer.isView(result)) {
      this.#buffer.write(toUint8Array(result as StreamWriteData, encoding));
      return;
    }

    // Handle string
    if (typeof result === 'string') {
      this.#buffer.write(toUint8Array(result, encoding));
      return;
    }

    // Handle async iterable (including async generators)
    if (isAsyncIterable(result)) {
      for await (const item of result) {
        await this.#processTransformResult(item, encoding);
      }
      return;
    }

    // Handle sync iterable (including generators)
    if (isIterable(result)) {
      for (const item of result) {
        await this.#processTransformResult(item, encoding);
      }
      return;
    }

    throw new TypeError(`Invalid transform result: ${typeof result}`);
  }
}
