/**
 * Compression and Decompression with Streams
 *
 * This file demonstrates using Node.js zlib APIs with the new Stream API
 * for streaming compression and decompression (gzip, deflate, brotli).
 *
 * Key patterns demonstrated:
 * - Using stateful transform objects with pipeThrough()
 * - Using async generators in transforms to yield compressed data
 * - Using pipeTo() to write through compression
 * - Using Stream.pipeline() for multi-stage processing
 * - Proper error handling and abort support
 */

import { Stream } from '../src/stream.js';
import type { StreamTransformerObject } from '../src/types.js';
import * as zlib from 'node:zlib';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// ============================================================================
// Helper: Copy chunk to owned buffer (handles detached ArrayBuffers)
// ============================================================================

function copyToBuffer(chunk: Uint8Array): Buffer {
  return Buffer.from(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
}

// ============================================================================
// Stateful Compression Transform Objects for pipeThrough()
//
// These implement StreamTransformerObject interface with:
// - transform(chunk): processes input, yields compressed output via async generator
// - abort(reason): cleans up the zlib stream on error
// ============================================================================

/**
 * Create a gzip compression transform object for use with pipeThrough().
 *
 * Usage: stream.pipeThrough(createGzipCompressTransform())
 */
function createGzipCompressTransform(options?: zlib.ZlibOptions): StreamTransformerObject {
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

  return {
    // Transform returns a promise that resolves to all output data
    transform(chunk: Uint8Array | null): Promise<Uint8Array[]> {
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
    },

    abort(reason) {
      gzip.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    },
  };
}

/**
 * Create a gzip decompression transform object for use with pipeThrough().
 */
function createGunzipTransform(options?: zlib.ZlibOptions): StreamTransformerObject {
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

  return {
    transform(chunk: Uint8Array | null): Promise<Uint8Array[]> {
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
    },

    abort(reason) {
      gunzip.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    },
  };
}

/**
 * Generic factory for creating zlib transform objects.
 */
function createZlibTransformObject(
  createZlib: () => zlib.Gzip | zlib.Gunzip | zlib.Deflate | zlib.Inflate | zlib.BrotliCompress | zlib.BrotliDecompress
): StreamTransformerObject {
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

  return {
    transform(chunk: Uint8Array | null): Promise<Uint8Array[]> {
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
    },

    abort(reason) {
      zlibStream.destroy(reason instanceof Error ? reason : new Error(String(reason)));
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
  // Example 1: Basic pipeThrough() with compression transform object
  // ============================================================================
  section('Example 1: pipeThrough() with Compression Transform');

  {
    const originalText = 'Hello, this is some text that will be compressed with gzip!';

    // Use pipeThrough with transform object
    const compressed = await Stream.from(originalText)
      .pipeThrough(createGzipCompressTransform())
      .bytes();

    console.log('Original size:', originalText.length, 'bytes');
    console.log('Compressed size:', compressed.length, 'bytes');

    // Decompress with pipeThrough
    const decompressed = await Stream.from(compressed)
      .pipeThrough(createGunzipTransform())
      .text();

    console.log('Round-trip successful:', decompressed === originalText);
  }

  // ============================================================================
  // Example 2: Chained pipeThrough() calls
  // ============================================================================
  section('Example 2: Chained pipeThrough() Transforms');

  {
    const source = Stream.from('Data flowing through compression pipeline');

    // Chain compression and decompression
    const result = await source
      .pipeThrough(createGzipCompressTransform({ level: 9 }))
      .pipeThrough(createGunzipTransform())
      .text();

    console.log('Result:', result);
    console.log('Pipeline preserved data:', result === 'Data flowing through compression pipeline');
  }

  // ============================================================================
  // Example 3: Combining pipeThrough() transforms
  // ============================================================================
  section('Example 3: Combining Text Transform with Compression');

  {
    const source = Stream.pull(async function* () {
      yield 'line one\n';
      yield 'line two\n';
      yield 'line three\n';
    });

    // Chain: uppercase transform -> compression -> decompression
    const result = await source
      // First: text transform (stateless function)
      .pipeThrough((chunk) => {
        if (chunk === null) return null;
        return new TextDecoder().decode(chunk).toUpperCase();
      })
      // Then: compression (stateful object)
      .pipeThrough(createGzipCompressTransform())
      // Finally: decompression (stateful object)
      .pipeThrough(createGunzipTransform())
      .text();

    console.log('Transformed and round-tripped:');
    console.log(result);
  }

  // ============================================================================
  // Example 4: Using Stream.transform() with compression
  // ============================================================================
  section('Example 4: Stream.transform() with Compression');

  {
    // Create a transform that compresses written data
    const { stream: compressedOutput, writer: inputWriter } = Stream.transform(
      createGzipCompressTransform()
    );

    // Write data to the transform
    const writePromise = (async () => {
      await inputWriter.write('First chunk\n');
      await inputWriter.write('Second chunk\n');
      await inputWriter.write('Third chunk\n');
      await inputWriter.close();
    })();

    // Read compressed output
    const compressed = await compressedOutput.bytes();
    await writePromise;

    console.log('Compressed via Stream.transform():', compressed.length, 'bytes');

    // Verify by decompressing
    const decompressed = await Stream.from(compressed)
      .pipeThrough(createGunzipTransform())
      .text();

    console.log('Decompressed:', decompressed.trim());
  }

  // ============================================================================
  // Example 5: Stream.pipeline() with compression transform
  // ============================================================================
  section('Example 5: Stream.pipeline() with Compression');

  {
    // Source generates data
    const source = Stream.pull(async function* () {
      for (let i = 0; i < 10; i++) {
        yield `Line ${i}: ${'x'.repeat(50)}\n`;
      }
    });

    // Collector destination
    const chunks: Uint8Array[] = [];
    const collector = Stream.writer({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });

    // Pipeline with compression transform object
    await Stream.pipeline(
      source,
      createGzipCompressTransform({ level: 6 }),
      collector
    );

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const compressed = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      compressed.set(chunk, offset);
      offset += chunk.length;
    }

    console.log('Pipeline output:', compressed.length, 'bytes');

    // Verify
    const decompressed = await Stream.from(compressed)
      .pipeThrough(createGunzipTransform())
      .text();

    console.log('Lines recovered:', decompressed.trim().split('\n').length);
  }

  // ============================================================================
  // Example 6: Comparing compression algorithms with pipeThrough()
  // ============================================================================
  section('Example 6: Comparing Algorithms with pipeThrough()');

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
      const compressed = await Stream.from(testData).pipeThrough(compress()).bytes();
      const compressTime = performance.now() - startCompress;

      const startDecompress = performance.now();
      const decompressed = await Stream.from(compressed).pipeThrough(decompress()).text();
      const decompressTime = performance.now() - startDecompress;

      const ratio = ((1 - compressed.length / testData.length) * 100).toFixed(1);
      console.log(`${name}: ${compressed.length} bytes (${ratio}% reduction)`);
      console.log(`  Compress: ${compressTime.toFixed(2)}ms, Decompress: ${decompressTime.toFixed(2)}ms`);
      console.log(`  Valid: ${decompressed === testData}`);
    }
  }

  // ============================================================================
  // Example 7: Streaming large data with pipeThrough()
  // ============================================================================
  section('Example 7: Streaming Large Data');

  {
    let bytesIn = 0;
    let bytesOut = 0;

    // Source with input tracking
    const source = Stream.pull(async function* () {
      for (let i = 0; i < 1000; i++) {
        const chunk = `Record ${i}: ${'data'.repeat(25)}\n`;
        bytesIn += chunk.length;
        yield chunk;
      }
    });

    // Compress with pipeThrough and track output
    const compressed = source.pipeThrough(createGzipCompressTransform());

    for await (const chunk of compressed) {
      bytesOut += chunk.length;
    }

    console.log('Input bytes:', bytesIn);
    console.log('Output bytes:', bytesOut);
    console.log('Compression ratio:', ((1 - bytesOut / bytesIn) * 100).toFixed(1) + '%');
  }

  // ============================================================================
  // Example 8: tee() with compression via pipeThrough()
  // ============================================================================
  section('Example 8: tee() with pipeThrough() Compression');

  {
    const source = Stream.from('Data to be both stored raw and compressed');

    // Create a branch for compression
    const compressedBranch = source.tee();

    // Process both in parallel using pipeThrough for compression
    const [rawResult, compressedResult] = await Promise.all([
      source.text(),
      compressedBranch.pipeThrough(createGzipCompressTransform()).bytes(),
    ]);

    console.log('Raw length:', rawResult.length);
    console.log('Compressed length:', compressedResult.length);

    // Verify compressed data
    const decompressed = await Stream.from(compressedResult)
      .pipeThrough(createGunzipTransform())
      .text();

    console.log('Compression branch valid:', decompressed === rawResult);
  }

  // ============================================================================
  // Example 9: Error handling with transform abort()
  // ============================================================================
  section('Example 9: Error Handling with Transform abort()');

  {
    // Try to decompress invalid data - transform's abort() should be called
    try {
      await Stream.from(new Uint8Array([1, 2, 3, 4, 5]))
        .pipeThrough(createGunzipTransform())
        .bytes();
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Caught decompression error:', (error as Error).message);
    }

    // Truncated compressed data
    const validCompressed = await Stream.from('Hello World')
      .pipeThrough(createGzipCompressTransform())
      .bytes();

    const truncated = validCompressed.slice(0, validCompressed.length - 5);

    try {
      await Stream.from(truncated)
        .pipeThrough(createGunzipTransform())
        .bytes();
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Caught truncation error:', (error as Error).message);
    }
  }

  // ============================================================================
  // Example 10: pipeTo() through compression transform
  // ============================================================================
  section('Example 10: pipeTo() with Compression');

  {
    // Create transform pair
    const { stream: compressedOutput, writer: compressInput } = Stream.transform(
      createGzipCompressTransform()
    );

    // Source stream
    const source = Stream.from('Data sent via pipeTo() through compression transform');

    // Use pipeTo to send data through the transform
    const pipePromise = source.pipeTo(compressInput);

    // Collect compressed output
    const compressed = await compressedOutput.bytes();
    await pipePromise;

    console.log('Compressed via pipeTo():', compressed.length, 'bytes');

    // Verify
    const decompressed = await Stream.from(compressed)
      .pipeThrough(createGunzipTransform())
      .text();

    console.log('Decompressed:', decompressed);
  }

  // ============================================================================
  // Example 11: HTTP Content-Encoding with pipeThrough()
  // ============================================================================
  section('Example 11: HTTP Content-Encoding');

  {
    type Encoding = 'gzip' | 'deflate' | 'br' | 'identity';

    function getEncoder(encoding: Encoding): StreamTransformerObject | null {
      switch (encoding) {
        case 'gzip': return createGzipCompressTransform();
        case 'deflate': return createDeflateTransform();
        case 'br': return createBrotliCompressTransform();
        case 'identity': return null;
      }
    }

    function getDecoder(encoding: Encoding): StreamTransformerObject | null {
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
      const encoder = getEncoder(encoding);
      const decoder = getDecoder(encoding);

      // Encode (server side) using pipeThrough
      let encoded: Uint8Array;
      if (encoder) {
        encoded = await Stream.from(responseBody).pipeThrough(encoder).bytes();
      } else {
        encoded = new TextEncoder().encode(responseBody);
      }

      // Decode (client side) using pipeThrough
      let decoded: string;
      if (decoder) {
        decoded = await Stream.from(encoded).pipeThrough(decoder).text();
      } else {
        decoded = new TextDecoder().decode(encoded);
      }

      console.log(`${encoding}: ${encoded.length} bytes, valid: ${decoded === responseBody}`);
    }
  }

  // ============================================================================
  // Example 12: Multi-stage pipeline with mixed transforms
  // ============================================================================
  section('Example 12: Multi-stage Pipeline with Mixed Transforms');

  {
    const source = Stream.pull(async function* () {
      for (let i = 0; i < 5; i++) {
        yield JSON.stringify({ id: i, value: Math.random() }) + '\n';
      }
    });

    // Collector
    const chunks: Uint8Array[] = [];
    const collector = Stream.writer({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });

    // Pipeline with stateless function transform AND stateful compression
    await Stream.pipeline(
      source,
      // Stateless function transform
      (chunk: Uint8Array | null) => {
        if (chunk === null) return null;
        return 'RECORD:' + new TextDecoder().decode(chunk);
      },
      // Stateful compression transform
      createGzipCompressTransform(),
      // Destination
      collector
    );

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const compressed = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      compressed.set(chunk, offset);
      offset += chunk.length;
    }

    console.log('Multi-stage pipeline output:', compressed.length, 'bytes');

    // Verify
    const decompressed = await Stream.from(compressed)
      .pipeThrough(createGunzipTransform())
      .text();

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
