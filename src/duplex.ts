/**
 * Duplex channel implementation for bidirectional streaming.
 *
 * Creates a pair of connected channels where data written to one
 * channel's writer appears in the other channel's readable.
 */

import { push } from './push.js';
import type { DuplexChannel, DuplexOptions, Writer } from './types.js';

/**
 * Create a pair of connected duplex channels for bidirectional communication.
 *
 * Similar to Unix socketpair() - creates two endpoints where data written
 * to one endpoint's writer appears in the other endpoint's readable.
 *
 * @param options - Optional configuration for both channels
 * @returns A tuple of two connected DuplexChannel instances
 *
 * @example
 * ```typescript
 * const [client, server] = Stream.duplex();
 *
 * // Server echoes back what it receives
 * (async () => {
 *   await using srv = server;
 *   for await (const chunks of srv.readable) {
 *     await srv.writer.writev(chunks);
 *   }
 * })();
 *
 * // Client sends and receives
 * {
 *   await using conn = client;
 *   await conn.writer.write('Hello');
 *   for await (const chunks of conn.readable) {
 *     console.log(new TextDecoder().decode(chunks[0])); // "Hello"
 *     break;
 *   }
 * }
 * ```
 */
export function duplex(options?: DuplexOptions): [DuplexChannel, DuplexChannel] {
  const { highWaterMark, backpressure, signal, a, b } = options ?? {};

  // Channel A writes to B's readable (A→B direction)
  const { writer: aWriter, readable: bReadable } = push({
    highWaterMark: a?.highWaterMark ?? highWaterMark,
    backpressure: a?.backpressure ?? backpressure,
    signal,
  });

  // Channel B writes to A's readable (B→A direction)
  const { writer: bWriter, readable: aReadable } = push({
    highWaterMark: b?.highWaterMark ?? highWaterMark,
    backpressure: b?.backpressure ?? backpressure,
    signal,
  });

  // Track closed state for idempotency
  let aWriterRef: Writer | null = aWriter;
  let bWriterRef: Writer | null = bWriter;

  const channelA: DuplexChannel = {
    get writer() {
      return aWriter;
    },
    readable: aReadable,
    async close() {
      if (aWriterRef === null) return;
      const writer = aWriterRef;
      aWriterRef = null;
      // Try sync first, fall back to async
      if (writer.endSync() < 0) {
        await writer.end();
      }
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  };

  const channelB: DuplexChannel = {
    get writer() {
      return bWriter;
    },
    readable: bReadable,
    async close() {
      if (bWriterRef === null) return;
      const writer = bWriterRef;
      bWriterRef = null;
      // Try sync first, fall back to async
      if (writer.endSync() < 0) {
        await writer.end();
      }
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  };

  return [channelA, channelB];
}
