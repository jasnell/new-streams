/**
 * Compression and Decompression with Streams
 *
 * This file demonstrates using Node.js zlib APIs with the new Stream API
 * for streaming compression and decompression (gzip, deflate, brotli).
 *
 * Key patterns demonstrated:
 * - Using stateful transform objects with Stream.pull()
 * - Using async generators in transforms to yield compressed data
 * - Using Stream.pipeTo() to write through compression
 * - Multi-stage processing with variadic transforms
 * - Proper error handling and failure propagation
 */

import { Stream, type TransformObject } from '../src/index.js';
import * as zlib from 'node:zlib';
import { section, uppercaseTransform } from './util.js';

// Shared encoder/decoder instances for efficiency
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ============================================================================
// Helper: Copy chunk to owned buffer (handles detached ArrayBuffers)
// ============================================================================

function copyToBuffer(chunk: Uint8Array): Buffer {
  return Buffer.from(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
}

// ============================================================================
// Stateful Compression Transform Objects for Stream.pull()
//
// These implement TransformObject interface with:
// - transform(source): receives entire source as async iterable, yields compressed output
//
// The transform's signal parameter enables cleanup on failure or cancellation.
// Using an object (vs a plain function) indicates this is a stateful transform.
// ============================================================================

/**
 * Create a gzip compression transform object for use with Stream.pull().
 *
 * Usage: Stream.pull(source, createGzipCompressTransform())
 */
function createGzipCompressTransform(options?: zlib.ZlibOptions): TransformObject {
  const gzip = zlib.createGzip(options);
  const pending: Uint8Array[] = [];
  let error: Error | null = null;
  let pendingReject: ((err: Error) => void) | null = null;

  // Collect output from gzip
  gzip.on('data', (chunk: Buffer) => {
    pending.push(new Uint8Array(chunk));
  });

  gzip.on('error', (err) => {
    error = err;
    // Immediately reject any pending operation
    if (pendingReject) {
      pendingReject(err);
      pendingReject = null;
    }
  });

  // Helper to process a single chunk
  async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
    return new Promise((resolve, reject) => {
      if (error) {
        reject(error);
        return;
      }

      // Store reject for async error handling
      pendingReject = reject;

      if (chunk === null) {
        // Flush: end the gzip stream and collect all remaining output
        // Use 'end' event (not 'finish') because 'end' fires AFTER final data is emitted
        gzip.once('end', () => {
          pendingReject = null;
          if (error) {
            reject(error);
          } else {
            resolve(pending.splice(0));
          }
        });
        gzip.end();
        return;
      }

      // Write chunk to gzip, then flush to force output
      gzip.write(copyToBuffer(chunk), (err) => {
        if (err) {
          pendingReject = null;
          reject(err);
          return;
        }
        if (error) {
          pendingReject = null;
          reject(error);
          return;
        }
        // Flush forces zlib to emit all buffered compressed data
        gzip.flush(() => {
          pendingReject = null;
          if (error) {
            reject(error);
          } else {
            resolve(pending.splice(0));
          }
        });
      });
    });
  }

  return {

    async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
      const onAbort = () => {
        gzip.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        for await (const batches of source) {
          if (batches === null) {
            // Flush signal
            const output = await processChunk(null);
            for (const chunk of output) {
              yield chunk;
            }
            continue;
          }
          // Process each chunk in the batch
          for (const chunk of batches) {
            const output = await processChunk(chunk);
            for (const out of output) {
              yield out;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        gzip.destroy();
      }
    },
  };
}

/**
 * Create a gzip decompression transform object for use with Stream.pull().
 */
function createGunzipTransform(options?: zlib.ZlibOptions): TransformObject {
  const gunzip = zlib.createGunzip(options);
  const pending: Uint8Array[] = [];
  let error: Error | null = null;
  let pendingReject: ((err: Error) => void) | null = null;

  gunzip.on('data', (chunk: Buffer) => {
    pending.push(new Uint8Array(chunk));
  });

  gunzip.on('error', (err) => {
    error = err;
    // Immediately reject any pending operation
    if (pendingReject) {
      pendingReject(err);
      pendingReject = null;
    }
  });

  async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
    return new Promise((resolve, reject) => {
      if (error) {
        reject(error);
        return;
      }

      // Store reject for async error handling
      pendingReject = reject;

      if (chunk === null) {
        // Use 'end' event (not 'finish') because 'end' fires AFTER final data is emitted
        gunzip.once('end', () => {
          pendingReject = null;
          if (error) {
            reject(error);
          } else {
            resolve(pending.splice(0));
          }
        });
        gunzip.end();
        return;
      }

      // Write and flush to get all decompressed output
      gunzip.write(copyToBuffer(chunk), (err) => {
        if (err) {
          pendingReject = null;
          reject(err);
          return;
        }
        if (error) {
          pendingReject = null;
          reject(error);
          return;
        }
        gunzip.flush(() => {
          pendingReject = null;
          if (error) {
            reject(error);
          } else {
            resolve(pending.splice(0));
          }
        });
      });
    });
  }

  return {

    async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
      const onAbort = () => {
        gunzip.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        for await (const batches of source) {
          if (batches === null) {
            const output = await processChunk(null);
            for (const chunk of output) {
              yield chunk;
            }
            continue;
          }
          for (const chunk of batches) {
            const output = await processChunk(chunk);
            for (const out of output) {
              yield out;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        gunzip.destroy();
      }
    },
  };
}

/**
 * Generic factory for creating zlib transform objects.
 */
function createZlibTransformObject(
  createZlib: () => zlib.Gzip | zlib.Gunzip | zlib.Deflate | zlib.Inflate | zlib.BrotliCompress | zlib.BrotliDecompress
): TransformObject {
  const zlibStream = createZlib();
  const pending: Uint8Array[] = [];
  let error: Error | null = null;
  let pendingReject: ((err: Error) => void) | null = null;

  zlibStream.on('data', (chunk: Buffer) => {
    pending.push(new Uint8Array(chunk));
  });

  zlibStream.on('error', (err) => {
    error = err;
    // Immediately reject any pending operation
    if (pendingReject) {
      pendingReject(err);
      pendingReject = null;
    }
  });

  async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
    return new Promise((resolve, reject) => {
      if (error) {
        reject(error);
        return;
      }

      // Store reject for async error handling
      pendingReject = reject;

      if (chunk === null) {
        // Use 'end' event (not 'finish') because 'end' fires AFTER final data is emitted
        zlibStream.once('end', () => {
          pendingReject = null;
          if (error) {
            reject(error);
          } else {
            resolve(pending.splice(0));
          }
        });
        zlibStream.end();
        return;
      }

      // Write and flush to get all output
      zlibStream.write(copyToBuffer(chunk), (err) => {
        if (err) {
          pendingReject = null;
          reject(err);
          return;
        }
        if (error) {
          pendingReject = null;
          reject(error);
          return;
        }
        zlibStream.flush(() => {
          pendingReject = null;
          if (error) {
            reject(error);
          } else {
            resolve(pending.splice(0));
          }
        });
      });
    });
  }

  return {

    async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
      const onAbort = () => {
        zlibStream.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        for await (const batches of source) {
          if (batches === null) {
            const output = await processChunk(null);
            for (const chunk of output) {
              yield chunk;
            }
            continue;
          }
          for (const chunk of batches) {
            const output = await processChunk(chunk);
            for (const out of output) {
              yield out;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        zlibStream.destroy();
      }
    },
  };
}

// Convenience factories for different algorithms
const createDeflateTransform = (options?: zlib.ZlibOptions) =>
  createZlibTransformObject(() => zlib.createDeflate(options));

const createInflateTransform = (options?: zlib.ZlibOptions) =>
  createZlibTransformObject(() => zlib.createInflate(options));

const createBrotliCompressTransform = (options?: zlib.BrotliOptions) =>
  createZlibTransformObject(() => zlib.createBrotliCompress(options));

const createBrotliDecompressTransform = (options?: zlib.BrotliOptions) =>
  createZlibTransformObject(() => zlib.createBrotliDecompress(options));

// ============================================================================
// Main Examples
// ============================================================================

async function main() {
  // ============================================================================
  // Example 1: Basic Stream.pull() with compression transform object
  // ============================================================================
  section('Example 1: Stream.pull() with Compression Transform');

  {
    const originalText = 'Hello, this is some text that will be compressed with gzip!';

    // Use Stream.pull with transform object
    const compressed = await Stream.bytes(
      Stream.pull(Stream.from(originalText), createGzipCompressTransform())
    );

    console.log('Original size:', originalText.length, 'bytes');
    console.log('Compressed size:', compressed.length, 'bytes');

    // Decompress with Stream.pull
    const decompressed = await Stream.text(
      Stream.pull(Stream.from(compressed), createGunzipTransform())
    );

    console.log('Round-trip successful:', decompressed === originalText);
  }

  // ============================================================================
  // Example 2: Chained transforms via Stream.pull()
  // ============================================================================
  section('Example 2: Chained Stream.pull() Transforms');

  {
    // Chain compression and decompression with variadic transforms
    const result = await Stream.text(
      Stream.pull(
        Stream.from('Data flowing through compression pipeline'),
        createGzipCompressTransform({ level: 9 }),
        createGunzipTransform()
      )
    );

    console.log('Result:', result);
    console.log('Pipeline preserved data:', result === 'Data flowing through compression pipeline');
  }

  // ============================================================================
  // Example 3: Combining text transform with compression
  // ============================================================================
  section('Example 3: Combining Text Transform with Compression');

  {
    function* generateLines() {
      yield 'line one\n';
      yield 'line two\n';
      yield 'line three\n';
    }

    // Chain: uppercase transform -> compression -> decompression
    const result = await Stream.text(
      Stream.pull(
        generateLines(),
        uppercaseTransform(),  // Stateless function transform
        createGzipCompressTransform(),  // Stateful compression
        createGunzipTransform()  // Stateful decompression
      )
    );

    console.log('Transformed and round-tripped:');
    console.log(result);
  }

  // ============================================================================
  // Example 4: Using Stream.push() with compression
  // ============================================================================
  section('Example 4: Stream.push() with Compression');

  {
    // Create a push stream
    const { writer, readable } = Stream.push({
      highWaterMark: 1
    });

    // Create transform pipeline
    const compressedOutput = Stream.pull(readable, createGzipCompressTransform());

    // Write data to the push stream
    const writePromise = (async () => {
      await writer.write('First chunk\n');
      await writer.write('Second chunk\n');
      await writer.write('Third chunk\n');
      await writer.end();
    })();

    // Read compressed output
    const compressed = await Stream.bytes(compressedOutput);
    await writePromise;

    console.log('Compressed via Stream.push():', compressed.length, 'bytes');

    // Verify by decompressing
    const decompressed = await Stream.text(
      Stream.pull(Stream.from(compressed), createGunzipTransform())
    );

    console.log('Decompressed:', decompressed.trim());
  }

  // ============================================================================
  // Example 5: Stream.pull() pipeline with generator source
  // ============================================================================
  section('Example 5: Stream.pull() Pipeline with Generator Source');

  {
    // Generator source with compression transform
    async function* generateData() {
      for (let i = 0; i < 10; i++) {
        yield `Line ${i}: ${'x'.repeat(50)}\n`;
      }
    }
    const pipeline = Stream.pull(
      generateData(),
      createGzipCompressTransform({ level: 6 })
    );

    // Collect chunks from the async iterable
    const compressed = await Stream.bytes(pipeline);

    console.log('Pipeline output:', compressed.length, 'bytes');

    // Verify
    const decompressed = await Stream.text(
      Stream.pull(Stream.from(compressed), createGunzipTransform())
    );

    console.log('Lines recovered:', decompressed.trim().split('\n').length);
  }

  // ============================================================================
  // Example 6: Comparing compression algorithms with Stream.pull()
  // ============================================================================
  section('Example 6: Comparing Algorithms with Stream.pull()');

  {
    const testData = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `User ${i}`,
        email: `user${i}@example.com`,
      }))
    );

    console.log('Original size:', testData.length, 'bytes\n');

    const algorithms = [
      { name: 'Gzip', compress: createGzipCompressTransform, decompress: createGunzipTransform },
      { name: 'Deflate', compress: createDeflateTransform, decompress: createInflateTransform },
      { name: 'Brotli', compress: createBrotliCompressTransform, decompress: createBrotliDecompressTransform },
    ];

    for (const { name, compress, decompress } of algorithms) {
      const startCompress = performance.now();
      const compressed = await Stream.bytes(
        Stream.pull(Stream.from(testData), compress())
      );
      const compressTime = performance.now() - startCompress;

      const startDecompress = performance.now();
      const decompressed = await Stream.text(
        Stream.pull(Stream.from(compressed), decompress())
      );
      const decompressTime = performance.now() - startDecompress;

      const ratio = ((1 - compressed.length / testData.length) * 100).toFixed(1);
      console.log(`${name}: ${compressed.length} bytes (${ratio}% reduction)`);
      console.log(`  Compress: ${compressTime.toFixed(2)}ms, Decompress: ${decompressTime.toFixed(2)}ms`);
      console.log(`  Valid: ${decompressed === testData}`);
    }
  }

  // ============================================================================
  // Example 7: Streaming large data with Stream.pull()
  // ============================================================================
  section('Example 7: Streaming Large Data');

  {
    let bytesIn = 0;
    let bytesOut = 0;

    // Source with input tracking
    async function* generateRecords() {
      for (let i = 0; i < 1000; i++) {
        const chunk = `Record ${i}: ${'data'.repeat(25)}\n`;
        bytesIn += chunk.length;
        yield chunk;
      }
    }

    // Compress with Stream.pull and track output
    const compressed = Stream.pull(generateRecords(), createGzipCompressTransform());

    for await (const batches of compressed) {
      for (const chunk of batches) {
        bytesOut += chunk.length;
      }
    }

    console.log('Input bytes:', bytesIn);
    console.log('Output bytes:', bytesOut);
    console.log('Compression ratio:', ((1 - bytesOut / bytesIn) * 100).toFixed(1) + '%');
  }

  // ============================================================================
  // Example 8: Stream.share() with compression via Stream.pull()
  // ============================================================================
  section('Example 8: Stream.share() with Compression');

  {
    const source = Stream.from('Data to be both stored raw and compressed');

    // Create a shared source
    const shared = Stream.share(source);

    // Create two consumers - raw and compressed
    const rawConsumer = shared.pull();
    // Apply compression transform directly on pull (transforms applied lazily when consumer pulls)
    const compressedConsumer = shared.pull(createGzipCompressTransform());

    // Process both in parallel
    const [rawResult, compressedResult] = await Promise.all([
      Stream.text(rawConsumer),
      Stream.bytes(compressedConsumer),
    ]);

    console.log('Raw length:', rawResult.length);
    console.log('Compressed length:', compressedResult.length);

    // Verify compressed data
    const decompressed = await Stream.text(
      Stream.pull(Stream.from(compressedResult), createGunzipTransform())
    );

    console.log('Compression branch valid:', decompressed === rawResult);
  }

  // ============================================================================
  // Example 9: Error handling with transform signal
  // ============================================================================
  section('Example 9: Error Handling with Transform Signal');

  {
    // Try to decompress invalid data - transform's signal should fire
    try {
      await Stream.bytes(
        Stream.pull(Stream.from(new Uint8Array([1, 2, 3, 4, 5])), createGunzipTransform())
      );
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Caught decompression error:', (error as Error).message);
    }

    // Truncated compressed data
    const validCompressed = await Stream.bytes(
      Stream.pull(Stream.from('Hello World'), createGzipCompressTransform())
    );

    const truncated = validCompressed.slice(0, validCompressed.length - 5);

    try {
      await Stream.bytes(
        Stream.pull(Stream.from(truncated), createGunzipTransform())
      );
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Caught truncation error:', (error as Error).message);
    }
  }

  // ============================================================================
  // Example 10: Stream.pipeTo() through compression transform
  // ============================================================================
  section('Example 10: Stream.pipeTo() with Compression');

  {
    // Create push stream for output
    const { writer, readable } = Stream.push(createGzipCompressTransform());

    // Source stream
    const source = Stream.from('Data sent via pipeTo() through compression transform');

    // Write source data to the push stream's writer
    const writePromise = Stream.pipeTo(source, writer);

    // Collect compressed output
    const compressed = await Stream.bytes(readable);
    await writePromise;

    console.log('Compressed via pipeTo():', compressed.length, 'bytes');

    // Verify
    const decompressed = await Stream.text(
      Stream.pull(Stream.from(compressed), createGunzipTransform())
    );

    console.log('Decompressed:', decompressed);
  }

  // ============================================================================
  // Example 11: HTTP Content-Encoding with Stream.pull()
  // ============================================================================
  section('Example 11: HTTP Content-Encoding');

  {
    type Encoding = 'gzip' | 'deflate' | 'br' | 'identity';

    function getEncoder(encoding: Encoding): TransformObject | null {
      switch (encoding) {
        case 'gzip': return createGzipCompressTransform();
        case 'deflate': return createDeflateTransform();
        case 'br': return createBrotliCompressTransform();
        case 'identity': return null;
      }
    }

    function getDecoder(encoding: Encoding): TransformObject | null {
      switch (encoding) {
        case 'gzip': return createGunzipTransform();
        case 'deflate': return createInflateTransform();
        case 'br': return createBrotliDecompressTransform();
        case 'identity': return null;
      }
    }

    const responseBody = JSON.stringify({ message: 'Hello!', timestamp: Date.now() });
    console.log('Response body:', responseBody.length, 'bytes\n');

    for (const encoding of ['identity', 'gzip', 'deflate', 'br'] as Encoding[]) {
      const enc = getEncoder(encoding);
      const dec = getDecoder(encoding);

      // Encode (server side) using Stream.pull
      let encoded: Uint8Array;
      if (enc) {
        encoded = await Stream.bytes(Stream.pull(Stream.from(responseBody), enc));
      } else {
        encoded = encoder.encode(responseBody);
      }

      // Decode (client side) using Stream.pull
      let decoded: string;
      if (dec) {
        decoded = await Stream.text(Stream.pull(Stream.from(encoded), dec));
      } else {
        decoded = decoder.decode(encoded);
      }

      console.log(`${encoding}: ${encoded.length} bytes, valid: ${decoded === responseBody}`);
    }
  }

  // ============================================================================
  // Example 12: Multi-stage processing with separate pipelines
  // ============================================================================
  section('Example 12: Multi-stage Processing');

  {
    // When you need to apply both a stateless transform and stateful compression,
    // you can chain them by first applying the stateless transform, then compressing.

    // Stateless function transform for prefixing
    const prefixTransform = (batches: Uint8Array[] | null) => {
      if (batches === null) return null;
      return batches.map(chunk => {
        const text = decoder.decode(chunk);
        return encoder.encode('RECORD:' + text);
      });
    };

    // Generate source data
    async function* generateJsonRecords() {
      for (let i = 0; i < 5; i++) {
        yield JSON.stringify({ id: i, value: Math.random() }) + '\n';
      }
    }

    // First apply the stateless transform
    const prefixed = Stream.pull(
      Stream.from(generateJsonRecords()),
      prefixTransform
    );

    // Then compress the prefixed output
    const compressed = await Stream.bytes(
      Stream.pull(prefixed, createGzipCompressTransform())
    );

    console.log('Multi-stage pipeline output:', compressed.length, 'bytes');

    // Verify by decompressing
    const decompressed = await Stream.text(
      Stream.pull(Stream.from(compressed), createGunzipTransform())
    );

    console.log('Decompressed content:');
    console.log(decompressed);
  }

  console.log('\n--- Compression Examples Complete! ---\n');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
