/**
 * Utility functions for the streams implementation
 */

import type { StreamWriteData, BufferSource } from './types.js';

/**
 * Encode a string to bytes using the specified encoding.
 * 
 * TextEncoder only supports UTF-8, so we need custom handling for other encodings:
 * - UTF-8: Use native TextEncoder (fast path)
 * - UTF-16LE/UTF-16BE: Manual encoding using DataView
 * - Single-byte encodings (ISO-8859-1, Windows-1252, etc.): Use TextDecoder roundtrip
 *   or direct mapping for latin1
 * 
 * @param str - The string to encode
 * @param encoding - The target encoding (default: 'utf-8')
 * @returns Uint8Array containing the encoded bytes
 */
// TODO: Consider caching TextEncoder instance for UTF-8 (minor perf optimization)
// TODO: Consider caching the charToByte lookup tables for repeated encoding operations
// TODO: UTF-16 encoding doesn't handle surrogate pairs for characters outside BMP (U+10000+)
// TODO: Some runtimes may not fully support all WHATWG Encoding Standard encodings
//       (e.g., Node.js treats windows-1252 like iso-8859-1 in the 0x80-0x9F range)
export function encodeString(str: string, encoding = 'utf-8'): Uint8Array {
  const normalizedEncoding = encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  // Fast path: UTF-8 using native TextEncoder
  if (normalizedEncoding === 'utf8') {
    return new TextEncoder().encode(str);
  }
  
  // UTF-16 Little Endian
  // TODO: This assumes all characters fit in a single UTF-16 code unit (BMP only).
  //       Characters outside BMP (emoji, etc.) would need surrogate pair handling.
  if (normalizedEncoding === 'utf16le' || normalizedEncoding === 'utf16' || normalizedEncoding === 'ucs2') {
    const buffer = new ArrayBuffer(str.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < str.length; i++) {
      view.setUint16(i * 2, str.charCodeAt(i), true); // little-endian
    }
    return new Uint8Array(buffer);
  }
  
  // UTF-16 Big Endian
  // TODO: Same BMP-only limitation as UTF-16LE above
  if (normalizedEncoding === 'utf16be') {
    const buffer = new ArrayBuffer(str.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < str.length; i++) {
      view.setUint16(i * 2, str.charCodeAt(i), false); // big-endian
    }
    return new Uint8Array(buffer);
  }
  
  // ISO-8859-1 (Latin-1) - direct code point to byte mapping for 0-255
  // TODO: ASCII should only accept 0-127, not 0-255. Currently treats ASCII same as Latin-1.
  if (normalizedEncoding === 'iso88591' || normalizedEncoding === 'latin1' || 
      normalizedEncoding === 'ascii' || normalizedEncoding === 'usascii') {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      // For latin1, code points 0-255 map directly to bytes
      // Characters outside this range become '?' (0x3F) 
      bytes[i] = code <= 255 ? code : 0x3F;
    }
    return bytes;
  }
  
  // For other single-byte encodings (windows-1252, iso-8859-*, etc.),
  // we use a roundtrip through TextDecoder to get the correct mapping.
  // This works because TextDecoder can decode bytes in that encoding,
  // so we can find which byte maps to which character.
  // 
  // Build a reverse lookup table: character -> byte
  // TODO: This approach rebuilds the lookup table on every call. Consider caching
  //       lookup tables per encoding for better performance with repeated encoding.
  // TODO: This only works for single-byte encodings. Multi-byte encodings like
  //       Shift_JIS, EUC-KR, GB2312 would need different handling.
  try {
    const decoder = new TextDecoder(encoding);
    const charToByte = new Map<string, number>();
    
    // Build lookup table for all single bytes
    for (let byte = 0; byte < 256; byte++) {
      const char = decoder.decode(new Uint8Array([byte]));
      if (!charToByte.has(char)) {
        charToByte.set(char, byte);
      }
    }
    
    // Encode the string using the lookup table
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const byte = charToByte.get(char);
      // If character not in encoding, use '?' (0x3F)
      bytes[i] = byte !== undefined ? byte : 0x3F;
    }
    return bytes;
  } catch {
    // If TextDecoder doesn't support the encoding, fall back to UTF-8
    console.warn(`Encoding '${encoding}' not supported, falling back to UTF-8`);
    return new TextEncoder().encode(str);
  }
}

/**
 * Detach an ArrayBuffer by transferring it to a new buffer.
 * After this call, the original buffer will have byteLength of 0.
 * Returns a new Uint8Array view of the transferred buffer.
 * 
 * @param view - The Uint8Array or ArrayBufferView to detach
 * @returns A new Uint8Array with the transferred data
 */
export function detachBuffer(view: Uint8Array): Uint8Array {
  // Get the underlying ArrayBuffer
  const originalBuffer = view.buffer;
  const byteOffset = view.byteOffset;
  const byteLength = view.byteLength;
  
  // Transfer the buffer - this detaches the original
  // @ts-ignore - transfer() is available on modern runtimes
  const newBuffer: ArrayBuffer = originalBuffer.transfer();
  
  // Return a new view into the transferred buffer at the same offset
  return new Uint8Array(newBuffer, byteOffset, byteLength);
}

/**
 * Detach an ArrayBuffer from a BufferSource (ArrayBuffer or ArrayBufferView).
 * For strings, this is a no-op and returns the encoded bytes.
 * For buffers, returns detached copy and invalidates the original.
 */
export function toUint8ArrayAndDetach(data: StreamWriteData, encoding = 'utf-8'): Uint8Array {
  if (typeof data === 'string') {
    // Strings are encoded to a new buffer, no detachment needed
    return encodeString(data, encoding);
  }
  
  // For all buffer types, convert to Uint8Array and detach
  let view: Uint8Array;
  
  if (data instanceof Uint8Array) {
    view = data;
  } else if (data instanceof ArrayBuffer) {
    view = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw new TypeError('Invalid data type for stream write');
  }
  
  // Detach and return the new view
  return detachBuffer(view);
}

/**
 * Convert StreamWriteData to Uint8Array
 */
export function toUint8Array(data: StreamWriteData, encoding = 'utf-8'): Uint8Array {
  if (typeof data === 'string') {
    return encodeString(data, encoding);
  }
  
  if (data instanceof Uint8Array) {
    return data;
  }
  
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  
  throw new TypeError('Invalid data type for stream write');
}

/**
 * Concatenate multiple Uint8Arrays into one
 */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  
  if (chunks.length === 1) {
    return chunks[0];
  }
  
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  
  return result;
}

/**
 * Check if a value is an async generator
 */
export function isAsyncGenerator(value: unknown): value is AsyncGenerator {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncGenerator).next === 'function'
  );
}

/**
 * Check if a value is a sync generator
 */
export function isGenerator(value: unknown): value is Generator {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.iterator in value &&
    typeof (value as Generator).next === 'function' &&
    !isAsyncGenerator(value)
  );
}

/**
 * Check if a value is iterable (sync)
 */
export function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.iterator in value
  );
}

/**
 * Check if a value is async iterable
 */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value
  );
}

/**
 * Check if value is a transformer object (has transform method)
 */
export function isTransformerObject(value: unknown): value is { transform: (chunk: Uint8Array | null) => unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'transform' in value &&
    typeof (value as { transform: unknown }).transform === 'function'
  );
}

/**
 * Create a deferred promise
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  
  return { promise, resolve, reject };
}
