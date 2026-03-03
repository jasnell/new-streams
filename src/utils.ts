/**
 * Utility functions for the Streams API
 */

// Shared TextEncoder instance for string conversion
const encoder = new TextEncoder();

/**
 * Convert a chunk (string or Uint8Array) to Uint8Array.
 * Strings are UTF-8 encoded.
 */
export function toUint8Array(chunk: Uint8Array | string): Uint8Array {
  if (typeof chunk === 'string') {
    return encoder.encode(chunk);
  }
  return chunk;
}

/**
 * Check if all chunks in an array are already Uint8Array (no strings).
 * Short-circuits on the first string found.
 */
export function allUint8Array(chunks: (Uint8Array | string)[]): chunks is Uint8Array[] {
  for (let i = 0; i < chunks.length; i++) {
    if (typeof chunks[i] === 'string') return false;
  }
  return true;
}

/**
 * Calculate total byte length of an array of chunks.
 */
function totalByteLength(chunks: Uint8Array[]): number {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  return total;
}

/**
 * Concatenate multiple Uint8Arrays into a single Uint8Array.
 */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0];
  }

  const total = totalByteLength(chunks);
  const result = new Uint8Array(total);
  let offset = 0;
  // It turns out that this use of set is a bit of a performance bottleneck
  // in V8, but it's still faster than manual copying.
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// =============================================================================
// Options Parsing Helpers
// =============================================================================

import type { PullOptions } from './types.js';

/**
 * Check if a value is PullOptions (object without transform or write property).
 */
export function isPullOptions(value: unknown): value is PullOptions {
  return (
    value !== null &&
    typeof value === 'object' &&
    !('transform' in value) &&
    !('write' in value)
  );
}

/**
 * Parse variadic arguments for pull/pullSync.
 * Returns { transforms, options }
 */
export function parsePullArgs<T, O extends PullOptions>(
  args: (T | O)[]
): { transforms: T[]; options: O | undefined } {
  if (args.length === 0) {
    return { transforms: [], options: undefined };
  }

  const last = args[args.length - 1];
  if (isPullOptions(last)) {
    return {
      transforms: args.slice(0, -1) as T[],
      options: last as O,
    };
  }

  return { transforms: args as T[], options: undefined };
}
