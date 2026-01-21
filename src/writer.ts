/**
 * Writer - Unified writer for push streams and custom sinks
 */

import type {
  StreamWriteData,
  WriterWriteOptions,
  WriterSink,
  StreamBufferOptions,
} from './types.js';
import { UnifiedBuffer } from './buffer.js';
import { toUint8ArrayAndDetach } from './utils.js';

export class Writer {
  readonly #buffer: UnifiedBuffer;
  readonly #sink: WriterSink | null;
  readonly #encoding: string;
  
  #closed = false;
  #aborted = false;
  #bytesWritten = 0;
  
  readonly #closedPromise: Promise<number>;
  #resolveClose!: (bytes: number) => void;
  #rejectClose!: (error: Error) => void;

  constructor(
    buffer: UnifiedBuffer,
    options: { encoding?: string; sink?: WriterSink } = {}
  ) {
    this.#buffer = buffer;
    this.#sink = options.sink ?? null;
    this.#encoding = options.encoding ?? 'utf-8';

    this.#closedPromise = new Promise((resolve, reject) => {
      this.#resolveClose = resolve;
      this.#rejectClose = reject;
    });

    // Mark as handled to avoid unhandled rejection warnings
    this.#closedPromise.catch(() => {});
  }

  /**
   * Write bytes or string to the stream
   * BufferSource arguments are detached after this call (their ArrayBuffer becomes zero-length)
   */
  async write(data: StreamWriteData, options: WriterWriteOptions = {}): Promise<void> {
    if (this.#closed || this.#aborted) {
      throw new Error('Writer is closed');
    }

    // Check for already-aborted signal
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Convert to Uint8Array and detach the original buffer
    // This transfers ownership to the stream implementation
    const bytes = toUint8ArrayAndDetach(data, this.#encoding);

    // If we have a sink, write directly to it
    if (this.#sink) {
      await this.#sink.write(bytes);
      this.#bytesWritten += bytes.byteLength;
      return;
    }

    // Otherwise write to buffer
    await this.#buffer.writeAsync(bytes, options.signal);
    this.#bytesWritten += bytes.byteLength;
  }

  /**
   * Vectored write - write multiple chunks atomically
   * All BufferSource arguments are detached after this call
   */
  async writev(chunks: StreamWriteData[], options: WriterWriteOptions = {}): Promise<void> {
    if (this.#closed || this.#aborted) {
      throw new Error('Writer is closed');
    }

    // Check for already-aborted signal
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Convert all chunks to Uint8Array and detach the originals
    const byteChunks = chunks.map(chunk => toUint8ArrayAndDetach(chunk, this.#encoding));

    // Calculate total size
    const totalSize = byteChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

    if (this.#sink) {
      // For sinks, we concatenate and write as one chunk for atomicity
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of byteChunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await this.#sink.write(combined);
      this.#bytesWritten += totalSize;
      return;
    }

    // For buffers, write each chunk
    for (const chunk of byteChunks) {
      await this.#buffer.writeAsync(chunk, options.signal);
      this.#bytesWritten += chunk.byteLength;
    }
  }

  /**
   * Flush - synchronization point; resolves when all prior writes complete
   */
  async flush(options: WriterWriteOptions = {}): Promise<void> {
    if (this.#closed || this.#aborted) {
      throw new Error('Writer is closed');
    }

    // In this implementation, writes are already synchronous to the buffer
    // A more sophisticated implementation would track pending writes
    
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
  }

  /**
   * Signal end of stream
   */
  async close(): Promise<number> {
    if (this.#closed || this.#aborted) {
      return this.#bytesWritten;
    }

    this.#closed = true;

    try {
      if (this.#sink?.close) {
        await this.#sink.close();
      } else {
        this.#buffer.close();
      }
      this.#resolveClose(this.#bytesWritten);
    } catch (e) {
      this.#rejectClose(e as Error);
      throw e;
    }

    return this.#bytesWritten;
  }

  /**
   * Signal error, cancel stream
   */
  async abort(reason?: unknown): Promise<number> {
    if (this.#aborted) {
      return this.#bytesWritten;
    }

    this.#aborted = true;
    this.#closed = true;

    const error = reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted'));

    try {
      if (this.#sink?.abort) {
        await this.#sink.abort(reason);
      } else {
        this.#buffer.setError(error);
      }
    } catch (e) {
      // Ignore errors during abort
    }

    this.#rejectClose(error);
    return this.#bytesWritten;
  }

  /**
   * Promise that resolves with total bytes written when writer is closed
   */
  get closed(): Promise<number> {
    return this.#closedPromise;
  }

  /**
   * Bytes available before buffer limit (null if closed, negative if over)
   */
  get desiredSize(): number | null {
    if (this.#closed || this.#aborted) {
      return null;
    }
    return this.#buffer.getDesiredSize();
  }

  /**
   * Explicit Resource Management - calls close() when disposed
   */
  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.#closed && !this.#aborted) {
      await this.close();
    }
  }
}
