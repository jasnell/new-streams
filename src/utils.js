"use strict";
/**
 * Utility functions for the Streams API
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.toUint8Array = toUint8Array;
exports.allUint8Array = allUint8Array;
exports.concatBytes = concatBytes;
exports.isPullOptions = isPullOptions;
exports.parsePullArgs = parsePullArgs;
// Shared TextEncoder instance for string conversion
var encoder = new TextEncoder();
/**
 * Convert a chunk (string or Uint8Array) to Uint8Array.
 * Strings are UTF-8 encoded.
 */
function toUint8Array(chunk) {
    if (typeof chunk === 'string') {
        return encoder.encode(chunk);
    }
    return chunk;
}
/**
 * Check if all chunks in an array are already Uint8Array (no strings).
 * Short-circuits on the first string found.
 */
function allUint8Array(chunks) {
    for (var i = 0; i < chunks.length; i++) {
        if (typeof chunks[i] === 'string')
            return false;
    }
    return true;
}
/**
 * Calculate total byte length of an array of chunks.
 */
function totalByteLength(chunks) {
    var total = 0;
    for (var _i = 0, chunks_1 = chunks; _i < chunks_1.length; _i++) {
        var chunk = chunks_1[_i];
        total += chunk.byteLength;
    }
    return total;
}
/**
 * Concatenate multiple Uint8Arrays into a single Uint8Array.
 */
function concatBytes(chunks) {
    if (chunks.length === 0) {
        return new Uint8Array(0);
    }
    if (chunks.length === 1) {
        return chunks[0];
    }
    var total = totalByteLength(chunks);
    var result = new Uint8Array(total);
    var offset = 0;
    // It turns out that this use of set is a bit of a performance bottleneck
    // in V8, but it's still faster than manual copying.
    for (var _i = 0, chunks_2 = chunks; _i < chunks_2.length; _i++) {
        var chunk = chunks_2[_i];
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}
/**
 * Check if a value is PullOptions (object without transform or write property).
 */
function isPullOptions(value) {
    return (value !== null &&
        typeof value === 'object' &&
        !('transform' in value) &&
        !('write' in value));
}
/**
 * Parse variadic arguments for pull/pullSync.
 * Returns { transforms, options }
 */
function parsePullArgs(args) {
    if (args.length === 0) {
        return { transforms: [], options: undefined };
    }
    var last = args[args.length - 1];
    if (isPullOptions(last)) {
        return {
            transforms: args.slice(0, -1),
            options: last,
        };
    }
    return { transforms: args, options: undefined };
}
