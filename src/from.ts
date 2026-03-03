/**
 * Stream Factories - from() and fromSync()
 *
 * Creates normalized byte stream iterables from various input types.
 * Handles recursive flattening of nested iterables and protocol conversions.
 */

import {
  toStreamable,
  toAsyncStreamable,
  type ByteInput,
  type SyncStreamable,
  type Streamable,
  type SyncStreamableYield,
  type AsyncStreamableYield,
  type ToStreamable,
  type ToAsyncStreamable,
  type ByteStreamReadable,
  type SyncByteStreamReadable,
} from './types.js';

// Shared TextEncoder instance for string conversion
const encoder = new TextEncoder();

// =============================================================================
// Type Guards and Detection
// =============================================================================

/**
 * Check if value is a primitive chunk (string, ArrayBuffer, or ArrayBufferView).
 */
function isPrimitiveChunk(value: unknown): value is string | ArrayBuffer | ArrayBufferView {
  if (typeof value === 'string') return true;
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  return false;
}

/**
 * Check if value implements ToStreamable protocol.
 */
function isToStreamable(value: unknown): value is ToStreamable {
  return (
    value !== null &&
    typeof value === 'object' &&
    toStreamable in value &&
    typeof (value as ToStreamable)[toStreamable] === 'function'
  );
}

/**
 * Check if value implements ToAsyncStreamable protocol.
 */
function isToAsyncStreamable(value: unknown): value is ToAsyncStreamable {
  return (
    value !== null &&
    typeof value === 'object' &&
    toAsyncStreamable in value &&
    typeof (value as ToAsyncStreamable)[toAsyncStreamable] === 'function'
  );
}

/**
 * Check if value is a sync iterable (has Symbol.iterator).
 */
function isSyncIterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.iterator in value &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
  );
}

/**
 * Check if value is an async iterable (has Symbol.asyncIterator).
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Check if object has a custom toString() (not Object.prototype.toString).
 */
function hasCustomToString(obj: object): boolean {
  const toString = (obj as { toString?: unknown }).toString;
  return typeof toString === 'function' && toString !== Object.prototype.toString;
}

/**
 * Check if object has Symbol.toPrimitive.
 */
function hasToPrimitive(obj: object): boolean {
  return (
    Symbol.toPrimitive in obj &&
    typeof (obj as { [Symbol.toPrimitive]: unknown })[Symbol.toPrimitive] === 'function'
  );
}

// =============================================================================
// Primitive Conversion
// =============================================================================

/**
 * Convert a primitive chunk to Uint8Array.
 * - string: UTF-8 encoded
 * - ArrayBuffer: wrapped as Uint8Array view (no copy)
 * - ArrayBufferView: converted to Uint8Array view of same memory
 */
function primitiveToUint8Array(chunk: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof chunk === 'string') {
    return encoder.encode(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  // Other ArrayBufferView types (Int8Array, DataView, etc.)
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * Try to coerce an object to string using custom methods.
 * Returns null if object has no custom string coercion.
 */
function tryStringCoercion(obj: object): string | null {
  // Check for Symbol.toPrimitive first
  if (hasToPrimitive(obj)) {
    const toPrimitive = (obj as { [Symbol.toPrimitive]: (hint: string) => unknown })[
      Symbol.toPrimitive
    ];
    const result = toPrimitive.call(obj, 'string');
    if (typeof result === 'string') {
      return result;
    }
    // toPrimitive returned non-string, fall through to toString
  }

  // Check for custom toString
  if (hasCustomToString(obj)) {
    const result = obj.toString();
    return result;
  }

  return null;
}

// =============================================================================
// Sync Normalization (for fromSync and sync contexts)
// =============================================================================

/**
 * Normalize a sync streamable yield value to Uint8Array chunks.
 * Recursively flattens arrays, iterables, and protocol conversions.
 *
 * @yields Uint8Array chunks
 */
function* normalizeSyncValue(value: SyncStreamableYield): Generator<Uint8Array, void, unknown> {
  // Handle primitives
  if (isPrimitiveChunk(value)) {
    yield primitiveToUint8Array(value);
    return;
  }

  // Handle ToStreamable protocol
  if (isToStreamable(value)) {
    const result = value[toStreamable]();
    yield* normalizeSyncValue(result);
    return;
  }

  // Handle arrays (which are also iterable, but check first for efficiency)
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* normalizeSyncValue(item as SyncStreamableYield);
    }
    return;
  }

  // Handle other sync iterables
  if (isSyncIterable(value)) {
    for (const item of value) {
      yield* normalizeSyncValue(item as SyncStreamableYield);
    }
    return;
  }

  // Try string coercion for objects with custom toString/toPrimitive
  if (typeof value === 'object' && value !== null) {
    const str = tryStringCoercion(value);
    if (str !== null) {
      yield encoder.encode(str);
      return;
    }
  }

  // Reject: no valid conversion
  const val = value as unknown;
  throw new TypeError(
    `Cannot convert value to streamable: ${
      val === null ? 'null' : typeof val === 'object' ? (val as object).constructor?.name || 'Object' : typeof val
    }`
  );
}

/**
 * Check if value is already a Uint8Array[] batch (fast path check for sync).
 */
function isSyncUint8ArrayBatch(value: unknown): value is Uint8Array[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  // Check first element - if it's a Uint8Array, assume the rest are too (common case)
  return value[0] instanceof Uint8Array;
}

/**
 * Normalize a sync streamable source, yielding batches of Uint8Array.
 *
 * @param source - The sync streamable source
 * @yields Uint8Array[] batches
 */
function* normalizeSyncSource(source: SyncStreamable): Generator<Uint8Array[], void, unknown> {
  for (const value of source) {
    // Fast path 1: value is already a Uint8Array[] batch
    if (isSyncUint8ArrayBatch(value)) {
      if (value.length > 0) {
        yield value;
      }
      continue;
    }
    // Fast path 2: value is a single Uint8Array (very common)
    if (value instanceof Uint8Array) {
      yield [value];
      continue;
    }
    // Slow path: normalize the value
    const batch: Uint8Array[] = [];
    for (const chunk of normalizeSyncValue(value)) {
      batch.push(chunk);
    }
    if (batch.length > 0) {
      yield batch;
    }
  }
}

// =============================================================================
// Async Normalization (for from and async contexts)
// =============================================================================

/**
 * Normalize an async streamable yield value to Uint8Array chunks.
 * Recursively flattens arrays, iterables, async iterables, promises, and protocol conversions.
 *
 * @yields Uint8Array chunks
 */
async function* normalizeAsyncValue(
  value: AsyncStreamableYield | Promise<AsyncStreamableYield>
): AsyncGenerator<Uint8Array, void, unknown> {
  // Handle promises first
  if (value instanceof Promise) {
    const resolved = await value;
    yield* normalizeAsyncValue(resolved);
    return;
  }

  // Handle primitives
  if (isPrimitiveChunk(value)) {
    yield primitiveToUint8Array(value);
    return;
  }

  // Handle ToAsyncStreamable protocol (check before ToStreamable)
  if (isToAsyncStreamable(value)) {
    const result = value[toAsyncStreamable]();
    if (result instanceof Promise) {
      yield* normalizeAsyncValue(await result);
    } else {
      yield* normalizeAsyncValue(result);
    }
    return;
  }

  // Handle ToStreamable protocol
  if (isToStreamable(value)) {
    const result = value[toStreamable]();
    yield* normalizeAsyncValue(result);
    return;
  }

  // Handle arrays (which are also iterable, but check first for efficiency)
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* normalizeAsyncValue(item as AsyncStreamableYield);
    }
    return;
  }

  // Handle async iterables (check before sync iterables since some objects have both)
  if (isAsyncIterable(value)) {
    for await (const item of value) {
      yield* normalizeAsyncValue(item as AsyncStreamableYield);
    }
    return;
  }

  // Handle sync iterables
  if (isSyncIterable(value)) {
    for (const item of value) {
      yield* normalizeAsyncValue(item as AsyncStreamableYield);
    }
    return;
  }

  // Try string coercion for objects with custom toString/toPrimitive
  if (typeof value === 'object' && value !== null) {
    const str = tryStringCoercion(value);
    if (str !== null) {
      yield encoder.encode(str);
      return;
    }
  }

  // Reject: no valid conversion
  const val = value as unknown;
  throw new TypeError(
    `Cannot convert value to streamable: ${
      val === null ? 'null' : typeof val === 'object' ? (val as object).constructor?.name || 'Object' : typeof val
    }`
  );
}

/**
 * Check if value is already a Uint8Array[] batch (fast path check).
 */
function isUint8ArrayBatch(value: unknown): value is Uint8Array[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  // Check first element - if it's a Uint8Array, assume the rest are too (common case)
  return value[0] instanceof Uint8Array;
}

/**
 * Normalize an async streamable source, yielding batches of Uint8Array.
 *
 * @param source - The async streamable source (can be sync or async iterable)
 * @yields Uint8Array[] batches
 */
async function* normalizeAsyncSource(
  source: Streamable
): AsyncGenerator<Uint8Array[], void, unknown> {
  // Prefer async iteration if available
  if (isAsyncIterable(source)) {
    for await (const value of source) {
      // Fast path 1: value is already a Uint8Array[] batch (common in pipelines)
      if (isUint8ArrayBatch(value)) {
        if (value.length > 0) {
          yield value;
        }
        continue;
      }
      // Fast path 2: value is a single Uint8Array (very common)
      if (value instanceof Uint8Array) {
        yield [value];
        continue;
      }
      // Slow path: normalize the value
      const batch: Uint8Array[] = [];
      for await (const chunk of normalizeAsyncValue(value as AsyncStreamableYield)) {
        batch.push(chunk);
      }
      if (batch.length > 0) {
        yield batch;
      }
    }
    return;
  }

  // Fall back to sync iteration - batch all sync values together
  // This is a major optimization: sync generators yield many individual chunks,
  // but we can collect them all into a single batch since they're synchronously available
  if (isSyncIterable(source)) {
    const batch: Uint8Array[] = [];

    for (const value of source) {
      // Fast path 1: value is already a Uint8Array[] batch
      if (isUint8ArrayBatch(value)) {
        // Flush any accumulated batch first
        if (batch.length > 0) {
          yield batch.slice();
          batch.length = 0;
        }
        if (value.length > 0) {
          yield value;
        }
        continue;
      }
      // Fast path 2: value is a single Uint8Array (very common)
      if (value instanceof Uint8Array) {
        batch.push(value);
        continue;
      }
      // Slow path: normalize the value - must flush and yield individually
      // since normalizeAsyncValue is async
      if (batch.length > 0) {
        yield batch.slice();
        batch.length = 0;
      }
      const asyncBatch: Uint8Array[] = [];
      for await (const chunk of normalizeAsyncValue(value as AsyncStreamableYield)) {
        asyncBatch.push(chunk);
      }
      if (asyncBatch.length > 0) {
        yield asyncBatch;
      }
    }

    // Yield any remaining batched values
    if (batch.length > 0) {
      yield batch;
    }
    return;
  }

  throw new TypeError('Source must be iterable');
}

// =============================================================================
// Public API: from() and fromSync()
// =============================================================================

/**
 * Create a SyncByteStreamReadable from a ByteInput or SyncStreamable.
 *
 * - ByteInput (string, ArrayBuffer, ArrayBufferView): emits as single chunk
 * - SyncStreamable: wraps and normalizes chunks, flattening nested structures
 *
 * @param input - Raw byte input or sync iterable source
 * @returns A sync iterable yielding Uint8Array[] batches
 */
export function fromSync(input: ByteInput | SyncStreamable): SyncByteStreamReadable {
  // Check for primitives first (ByteInput)
  if (isPrimitiveChunk(input)) {
    const chunk = primitiveToUint8Array(input);
    return {
      *[Symbol.iterator]() {
        yield [chunk];
      },
    };
  }

  // Fast path: Uint8Array[] - yield as a single batch
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return {
        *[Symbol.iterator]() {
          // Empty - yield nothing
        },
      };
    }
    // Check if it's an array of Uint8Array (common case)
    if (input[0] instanceof Uint8Array) {
      const allUint8 = input.every((item) => item instanceof Uint8Array);
      if (allUint8) {
        const batch = input as Uint8Array[];
        return {
          *[Symbol.iterator]() {
            yield batch;
          },
        };
      }
    }
  }

  // Must be a SyncStreamable
  if (!isSyncIterable(input)) {
    throw new TypeError('Input must be a ByteInput or SyncStreamable');
  }

  return {
    *[Symbol.iterator]() {
      yield* normalizeSyncSource(input as SyncStreamable);
    },
  };
}

/**
 * Create a ByteStreamReadable from a ByteInput or Streamable.
 *
 * - ByteInput (string, ArrayBuffer, ArrayBufferView): emits as single chunk
 * - SyncStreamable: wraps as async, normalizes chunks
 * - AsyncStreamable: wraps and normalizes chunks
 *
 * @param input - Raw byte input or iterable source
 * @returns An async iterable yielding Uint8Array[] batches
 */
export function from(input: ByteInput | Streamable): ByteStreamReadable {
  // Check for primitives first (ByteInput)
  if (isPrimitiveChunk(input)) {
    const chunk = primitiveToUint8Array(input);
    return {
      async *[Symbol.asyncIterator]() {
        yield [chunk];
      },
    };
  }

  // Fast path: Uint8Array[] - yield as a single batch
  // This is a very common case (array of chunks) and should be fast
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return {
        async *[Symbol.asyncIterator]() {
          // Empty - yield nothing
        },
      };
    }
    // Check if it's an array of Uint8Array (common case)
    if (input[0] instanceof Uint8Array) {
      // Verify all elements are Uint8Array for type safety
      const allUint8 = input.every((item) => item instanceof Uint8Array);
      if (allUint8) {
        const batch = input as Uint8Array[];
        return {
          async *[Symbol.asyncIterator]() {
            yield batch;
          },
        };
      }
    }
  }

  // Must be a Streamable (sync or async iterable)
  if (!isSyncIterable(input) && !isAsyncIterable(input)) {
    throw new TypeError('Input must be a ByteInput or Streamable');
  }

  return {
    async *[Symbol.asyncIterator]() {
      yield* normalizeAsyncSource(input as Streamable);
    },
  };
}

// =============================================================================
// Exported Utilities (for use by other modules like pull, pipeTo)
// =============================================================================

export {
  normalizeSyncValue,
  normalizeSyncSource,
  normalizeAsyncValue,
  normalizeAsyncSource,
  isPrimitiveChunk,
  isToStreamable,
  isToAsyncStreamable,
  isSyncIterable,
  isAsyncIterable,
  primitiveToUint8Array,
};
