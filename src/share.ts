/**
 * Share - Pull-model multi-consumer streaming
 *
 * Shares a single source among multiple consumers with explicit buffering.
 * Complements broadcast (push model) with a pull model.
 */

import {
  type Share as ShareInterface,
  type SyncShare as SyncShareInterface,
  type ShareOptions,
  type ShareSyncOptions,
  type Transform,
  type SyncTransform,
  type PullOptions,
  type Streamable,
  type SyncStreamable,
  type Shareable,
  type SyncShareable,
  shareProtocol,
  shareSyncProtocol,
} from './types.js';

import { isAsyncIterable, isSyncIterable } from './from.js';
import { pull as pullWithTransforms, pullSync as pullSyncWithTransforms } from './pull.js';
import { parsePullArgs } from './utils.js';
import { RingBuffer } from './ringbuffer.js';

// =============================================================================
// Consumer State
// =============================================================================

interface AsyncConsumerState {
  /** Position in buffer (index of next chunk to read) */
  cursor: number;
  /** Resolve function for pending read */
  resolve: ((value: IteratorResult<Uint8Array[]>) => void) | null;
  /** Reject function for pending read */
  reject: ((error: Error) => void) | null;
  /** Whether consumer has been detached */
  detached: boolean;
}

interface SyncConsumerState {
  /** Position in buffer (index of next chunk to read) */
  cursor: number;
  /** Whether consumer has been detached */
  detached: boolean;
}

// =============================================================================
// Async Share Implementation
// =============================================================================

class ShareImpl implements ShareInterface {
  private buffer = new RingBuffer<Uint8Array[]>();
  private bufferStart = 0;
  private consumers: Set<AsyncConsumerState> = new Set();
  private sourceIterator: AsyncIterator<Uint8Array[]> | null = null;
  private sourceExhausted = false;
  private sourceError: Error | null = null;
  private cancelled = false;
  private pulling = false;
  private pullWaiters: (() => void)[] = [];

  constructor(
    private source: AsyncIterable<Uint8Array[]> | Iterable<Uint8Array[]>,
    private options: Required<ShareOptions>
  ) {
    // Initialize source iterator lazily
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  get bufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Create a new consumer that pulls from the shared source.
   * Optionally apply transforms to the consumer's data.
   */
  pull(...args: (Transform | PullOptions)[]): AsyncIterable<Uint8Array[]> {
    const { transforms, options } = parsePullArgs<Transform, PullOptions>(args);

    // Create raw consumer
    const rawConsumer = this.createRawConsumer();

    // If transforms provided, wrap with pull() pipeline
    if (transforms.length > 0) {
      if (options) {
        return pullWithTransforms(rawConsumer, ...transforms, options);
      }
      return pullWithTransforms(rawConsumer, ...transforms);
    }

    return rawConsumer;
  }

  /**
   * Create a raw consumer iterable (internal helper).
   */
  private createRawConsumer(): AsyncIterable<Uint8Array[]> {
    const state: AsyncConsumerState = {
      cursor: this.bufferStart, // Start from beginning of available buffer
      resolve: null,
      reject: null,
      detached: false,
    };

    this.consumers.add(state);

    const self = this;

    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array[]>> {
            // Check for error first (even if detached, propagate the error)
            if (self.sourceError) {
              state.detached = true;
              self.consumers.delete(state);
              throw self.sourceError;
            }

            if (state.detached) {
              return { done: true, value: undefined };
            }

            if (self.cancelled) {
              state.detached = true;
              self.consumers.delete(state);
              return { done: true, value: undefined };
            }

            // Check if data is available in buffer
            const bufferIndex = state.cursor - self.bufferStart;
            if (bufferIndex < self.buffer.length) {
              const chunk = self.buffer.get(bufferIndex);
              state.cursor++;
              self.tryTrimBuffer();
              return { done: false, value: chunk };
            }

            // Check if source is exhausted
            if (self.sourceExhausted) {
              state.detached = true;
              self.consumers.delete(state);
              return { done: true, value: undefined };
            }

            // Need to pull from source - but check buffer limit first
            const canPull = await self.waitForBufferSpace(state);
            if (!canPull) {
              // Cancelled while waiting
              state.detached = true;
              self.consumers.delete(state);
              if (self.sourceError) throw self.sourceError;
              return { done: true, value: undefined };
            }

            // Pull from source
            await self.pullFromSource();

            // Check again
            if (self.sourceError) {
              state.detached = true;
              self.consumers.delete(state);
              throw self.sourceError;
            }

            const newBufferIndex = state.cursor - self.bufferStart;
            if (newBufferIndex < self.buffer.length) {
              const chunk = self.buffer.get(newBufferIndex);
              state.cursor++;
              self.tryTrimBuffer();
              return { done: false, value: chunk };
            }

            if (self.sourceExhausted) {
              state.detached = true;
              self.consumers.delete(state);
              return { done: true, value: undefined };
            }

            // Shouldn't get here
            return { done: true, value: undefined };
          },

          async return(): Promise<IteratorResult<Uint8Array[]>> {
            state.detached = true;
            state.resolve = null;
            state.reject = null;
            self.consumers.delete(state);
            self.tryTrimBuffer();
            return { done: true, value: undefined };
          },

          async throw(_error?: Error): Promise<IteratorResult<Uint8Array[]>> {
            state.detached = true;
            state.resolve = null;
            state.reject = null;
            self.consumers.delete(state);
            self.tryTrimBuffer();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  /**
   * Cancel all consumers and close source.
   */
  cancel(reason?: Error): void {
    if (this.cancelled) return;
    this.cancelled = true;

    if (reason) {
      this.sourceError = reason;
    }

    // Close source iterator if open
    if (this.sourceIterator?.return) {
      this.sourceIterator.return().catch(() => {});
    }

    // Notify all waiting consumers
    for (const consumer of this.consumers) {
      if (consumer.resolve) {
        if (reason) {
          consumer.reject?.(reason);
        } else {
          consumer.resolve({ done: true, value: undefined });
        }
        consumer.resolve = null;
        consumer.reject = null;
      }
      consumer.detached = true;
    }
    this.consumers.clear();

    // Wake up any pull waiters
    for (const waiter of this.pullWaiters) {
      waiter();
    }
    this.pullWaiters = [];
  }

  [Symbol.dispose](): void {
    this.cancel();
  }

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  /**
   * Wait for buffer space based on backpressure policy.
   * Returns false if cancelled while waiting, or throws if strict policy.
   */
  private async waitForBufferSpace(_state: AsyncConsumerState): Promise<boolean> {
    while (this.buffer.length >= this.options.highWaterMark) {
      if (this.cancelled || this.sourceError || this.sourceExhausted) {
        return !this.cancelled;
      }

      switch (this.options.backpressure) {
        case 'strict':
          // Reject - buffer limit exceeded
          throw new RangeError(
            `Share buffer limit of ${this.options.highWaterMark} exceeded`
          );
        case 'block':
          // Wait for slow consumers to catch up
          await new Promise<void>((resolve) => {
            this.pullWaiters.push(resolve);
          });
          break;
        case 'drop-oldest':
          // Drop oldest and advance cursors
          this.buffer.shift();
          this.bufferStart++;
          for (const consumer of this.consumers) {
            if (consumer.cursor < this.bufferStart) {
              consumer.cursor = this.bufferStart;
            }
          }
          return true;
        case 'drop-newest':
          // Don't pull, just return what we have
          return true;
      }
    }
    return true;
  }

  /**
   * Pull next chunk from source into buffer.
   * Returns a promise that resolves when the pull completes (or immediately if already pulling).
   */
  private pullFromSource(): Promise<void> {
    if (this.sourceExhausted || this.cancelled) {
      return Promise.resolve();
    }

    // If already pulling, wait for that pull to complete
    if (this.pulling) {
      return new Promise<void>((resolve) => {
        this.pullWaiters.push(resolve);
      });
    }

    this.pulling = true;

    return (async () => {
      try {
        // Initialize iterator if needed
        if (!this.sourceIterator) {
          if (isAsyncIterable(this.source)) {
            this.sourceIterator = this.source[Symbol.asyncIterator]();
          } else if (isSyncIterable(this.source)) {
            // Wrap sync iterator
            const syncIterator = (this.source as Iterable<Uint8Array[]>)[Symbol.iterator]();
            this.sourceIterator = {
              async next() {
                return syncIterator.next();
              },
              async return() {
                return syncIterator.return?.() ?? { done: true, value: undefined };
              },
            };
          } else {
            throw new TypeError('Source must be iterable');
          }
        }

        const result = await this.sourceIterator.next();

        if (result.done) {
          this.sourceExhausted = true;
        } else {
          this.buffer.push(result.value);
        }
      } catch (error) {
        this.sourceError = error instanceof Error ? error : new Error(String(error));
        this.sourceExhausted = true;
      } finally {
        this.pulling = false;
        // Wake up waiters so they can check the buffer
        for (const waiter of this.pullWaiters) {
          waiter();
        }
        this.pullWaiters = [];
      }
    })();
  }

  /**
   * Get the slowest consumer's cursor position.
   */
  private getMinCursor(): number {
    let min = Infinity;
    for (const consumer of this.consumers) {
      if (consumer.cursor < min) {
        min = consumer.cursor;
      }
    }
    return min === Infinity ? this.bufferStart + this.buffer.length : min;
  }

  /**
   * Trim buffer from front if all consumers have advanced.
   */
  private tryTrimBuffer(): void {
    const minCursor = this.getMinCursor();
    const trimCount = minCursor - this.bufferStart;
    if (trimCount > 0) {
      this.buffer.trimFront(trimCount);
      this.bufferStart = minCursor;
      // Wake up any waiting pullers
      for (const waiter of this.pullWaiters) {
        waiter();
      }
      this.pullWaiters = [];
    }
  }
}

// =============================================================================
// Sync Share Implementation
// =============================================================================

class SyncShareImpl implements SyncShareInterface {
  private buffer = new RingBuffer<Uint8Array[]>();
  private bufferStart = 0;
  private consumers: Set<SyncConsumerState> = new Set();
  private sourceIterator: Iterator<Uint8Array[]> | null = null;
  private sourceExhausted = false;
  private sourceError: Error | null = null;
  private cancelled = false;

  constructor(
    private source: Iterable<Uint8Array[]>,
    private options: Required<ShareSyncOptions>
  ) {}

  get consumerCount(): number {
    return this.consumers.size;
  }

  get bufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Create a new consumer that pulls from the shared source.
   * Optionally apply transforms to the consumer's data.
   */
  pull(...transforms: SyncTransform[]): Iterable<Uint8Array[]> {
    // Create raw consumer
    const rawConsumer = this.createRawConsumer();

    // If transforms provided, wrap with pullSync() pipeline
    if (transforms.length > 0) {
      return pullSyncWithTransforms(rawConsumer, ...transforms);
    }

    return rawConsumer;
  }

  /**
   * Create a raw consumer iterable (internal helper).
   */
  private createRawConsumer(): Iterable<Uint8Array[]> {
    const state: SyncConsumerState = {
      cursor: this.bufferStart,
      detached: false,
    };

    this.consumers.add(state);

    const self = this;

    return {
      [Symbol.iterator]() {
        return {
          next(): IteratorResult<Uint8Array[]> {
            if (state.detached) {
              return { done: true, value: undefined };
            }

            if (self.sourceError) {
              state.detached = true;
              self.consumers.delete(state);
              throw self.sourceError;
            }

            if (self.cancelled) {
              state.detached = true;
              self.consumers.delete(state);
              return { done: true, value: undefined };
            }

            // Check if data is available in buffer
            const bufferIndex = state.cursor - self.bufferStart;
            if (bufferIndex < self.buffer.length) {
              const chunk = self.buffer.get(bufferIndex);
              state.cursor++;
              self.tryTrimBuffer();
              return { done: false, value: chunk };
            }

            // Check if source is exhausted
            if (self.sourceExhausted) {
              state.detached = true;
              self.consumers.delete(state);
              return { done: true, value: undefined };
            }

            // Need to pull from source - check buffer limit
            if (self.buffer.length >= self.options.highWaterMark) {
              switch (self.options.backpressure) {
                case 'strict':
                  throw new RangeError(
                    `Share buffer limit of ${self.options.highWaterMark} exceeded`
                  );
                case 'block':
                  // In sync context, we can't block - throw an error
                  throw new RangeError(
                    `Share buffer limit of ${self.options.highWaterMark} exceeded (blocking not available in sync context)`
                  );
                case 'drop-oldest':
                  self.buffer.shift();
                  self.bufferStart++;
                  for (const consumer of self.consumers) {
                    if (consumer.cursor < self.bufferStart) {
                      consumer.cursor = self.bufferStart;
                    }
                  }
                  break;
                case 'drop-newest':
                  // Return done - can't pull more
                  state.detached = true;
                  self.consumers.delete(state);
                  return { done: true, value: undefined };
              }
            }

            // Pull from source
            self.pullFromSource();

            // Check again
            if (self.sourceError) {
              state.detached = true;
              self.consumers.delete(state);
              throw self.sourceError;
            }

            const newBufferIndex = state.cursor - self.bufferStart;
            if (newBufferIndex < self.buffer.length) {
              const chunk = self.buffer.get(newBufferIndex);
              state.cursor++;
              self.tryTrimBuffer();
              return { done: false, value: chunk };
            }

            if (self.sourceExhausted) {
              state.detached = true;
              self.consumers.delete(state);
              return { done: true, value: undefined };
            }

            return { done: true, value: undefined };
          },

          return(): IteratorResult<Uint8Array[]> {
            state.detached = true;
            self.consumers.delete(state);
            self.tryTrimBuffer();
            return { done: true, value: undefined };
          },

          throw(_error?: Error): IteratorResult<Uint8Array[]> {
            state.detached = true;
            self.consumers.delete(state);
            self.tryTrimBuffer();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  /**
   * Cancel all consumers and close source.
   */
  cancel(reason?: Error): void {
    if (this.cancelled) return;
    this.cancelled = true;

    if (reason) {
      this.sourceError = reason;
    }

    // Close source iterator if open
    if (this.sourceIterator?.return) {
      this.sourceIterator.return();
    }

    for (const consumer of this.consumers) {
      consumer.detached = true;
    }
    this.consumers.clear();
  }

  [Symbol.dispose](): void {
    this.cancel();
  }

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  /**
   * Pull next chunk from source into buffer.
   */
  private pullFromSource(): void {
    if (this.sourceExhausted || this.cancelled) return;

    try {
      // Initialize iterator if needed
      if (!this.sourceIterator) {
        this.sourceIterator = this.source[Symbol.iterator]();
      }

      const result = this.sourceIterator.next();

      if (result.done) {
        this.sourceExhausted = true;
      } else {
        this.buffer.push(result.value);
      }
    } catch (error) {
      this.sourceError = error instanceof Error ? error : new Error(String(error));
      this.sourceExhausted = true;
    }
  }

  /**
   * Get the slowest consumer's cursor position.
   */
  private getMinCursor(): number {
    let min = Infinity;
    for (const consumer of this.consumers) {
      if (consumer.cursor < min) {
        min = consumer.cursor;
      }
    }
    return min === Infinity ? this.bufferStart + this.buffer.length : min;
  }

  /**
   * Trim buffer from front if all consumers have advanced.
   */
  private tryTrimBuffer(): void {
    const minCursor = this.getMinCursor();
    const trimCount = minCursor - this.bufferStart;
    if (trimCount > 0) {
      this.buffer.trimFront(trimCount);
      this.bufferStart = minCursor;
    }
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Create a shared source for pull-model multi-consumer streaming.
 *
 * @param source - The source to share
 * @param options - Buffer limit and backpressure policy
 * @returns Share instance
 */
export function share(
  source: AsyncIterable<Uint8Array[]> | Iterable<Uint8Array[]>,
  options?: ShareOptions
): ShareInterface {
  const opts: Required<ShareOptions> = {
    highWaterMark: Math.max(1, options?.highWaterMark ?? 16),
    backpressure: options?.backpressure ?? 'strict',
    signal: options?.signal as AbortSignal,
  };

  const shareImpl = new ShareImpl(source, opts);

  // Handle abort signal - cancel without error (clean shutdown)
  if (opts.signal) {
    if (opts.signal.aborted) {
      shareImpl.cancel();
    } else {
      opts.signal.addEventListener('abort', () => {
        shareImpl.cancel();
      }, { once: true });
    }
  }

  return shareImpl;
}

/**
 * Create a sync shared source for pull-model multi-consumer streaming.
 *
 * @param source - The sync source to share
 * @param options - Buffer limit and backpressure policy
 * @returns SyncShare instance
 */
export function shareSync(
  source: Iterable<Uint8Array[]>,
  options?: ShareSyncOptions
): SyncShareInterface {
  const opts: Required<ShareSyncOptions> = {
    highWaterMark: Math.max(1, options?.highWaterMark ?? 16),
    backpressure: options?.backpressure ?? 'strict',
  };

  return new SyncShareImpl(source, opts);
}

/**
 * Check if value implements Shareable protocol.
 */
function isShareable(value: unknown): value is Shareable {
  return (
    value !== null &&
    typeof value === 'object' &&
    shareProtocol in value &&
    typeof (value as Shareable)[shareProtocol] === 'function'
  );
}

/**
 * Check if value implements SyncShareable protocol.
 */
function isSyncShareable(value: unknown): value is SyncShareable {
  return (
    value !== null &&
    typeof value === 'object' &&
    shareSyncProtocol in value &&
    typeof (value as SyncShareable)[shareSyncProtocol] === 'function'
  );
}

/**
 * Namespace for Share.from() static method.
 */
export const Share = {
  /**
   * Get or create a Share from a Shareable or Streamable.
   */
  from(input: Shareable | Streamable, options?: ShareOptions): ShareInterface {
    if (isShareable(input)) {
      return input[shareProtocol](options);
    }

    if (isAsyncIterable(input) || isSyncIterable(input)) {
      return share(input as AsyncIterable<Uint8Array[]> | Iterable<Uint8Array[]>, options);
    }

    throw new TypeError('Input must be Shareable or Streamable');
  },
};

/**
 * Namespace for SyncShare.fromSync() static method.
 */
export const SyncShare = {
  /**
   * Get or create a SyncShare from a SyncShareable or SyncStreamable.
   */
  fromSync(input: SyncShareable | SyncStreamable, options?: ShareSyncOptions): SyncShareInterface {
    if (isSyncShareable(input)) {
      return input[shareSyncProtocol](options);
    }

    if (isSyncIterable(input)) {
      return shareSync(input as Iterable<Uint8Array[]>, options);
    }

    throw new TypeError('Input must be SyncShareable or SyncStreamable');
  },
};
