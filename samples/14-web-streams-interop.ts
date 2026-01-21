/**
 * Web Streams Interoperability
 *
 * This file demonstrates adapting between the new Stream API and the standard
 * Web Streams API (ReadableStream, WritableStream, TransformStream).
 *
 * Unlike Node.js streams, Web Streams are available in browsers and have
 * slightly different semantics. This sample shows bidirectional conversion
 * with proper error propagation and lifecycle management.
 */

import { Stream } from '../src/stream.js';
import type { WriterSink } from '../src/types.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// ============================================================================
// Adapter: Web ReadableStream -> New Stream API
// ============================================================================

/**
 * Convert a Web ReadableStream to the new Stream API.
 *
 * Features:
 * - Proper backpressure handling (pull-based)
 * - Error propagation from ReadableStream to new Stream
 * - Cleanup on cancel (cancels the underlying ReadableStream)
 */
function fromReadableStream<T extends ArrayBufferView | ArrayBuffer | string>(
  readable: ReadableStream<T>
): Stream {
  return Stream.pull(async function* () {
    const reader = readable.getReader();
    let completed = false;

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          completed = true;
          break;
        }

        // Handle different chunk types
        if (typeof value === 'string') {
          yield value;
        } else if (value instanceof ArrayBuffer) {
          yield new Uint8Array(value);
        } else if (ArrayBuffer.isView(value)) {
          yield new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        } else {
          throw new Error(`Unexpected chunk type: ${typeof value}`);
        }
      }
    } finally {
      // If we didn't complete normally, cancel the underlying stream
      if (!completed) {
        await reader.cancel('Stream consumer cancelled');
      }
      // Release the reader lock
      reader.releaseLock();
    }
  });
}

// ============================================================================
// Adapter: New Stream API -> Web ReadableStream
// ============================================================================

/**
 * Convert a new Stream to a Web ReadableStream.
 *
 * Features:
 * - Proper backpressure (underlying source pull model)
 * - Error propagation
 * - Cleanup when ReadableStream is cancelled
 *
 * Note: Uses ReadableStream.from() where available (Node 20+), otherwise
 * falls back to manual async iteration with a push source.
 */
function toReadableStream(stream: Stream): ReadableStream<Uint8Array> {
  // Use the async iterator protocol - simpler and more reliable
  const iterator = stream[Symbol.asyncIterator]();
  let cancelled = false;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (cancelled) return;

        try {
          const { value, done } = await iterator.next();

          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          controller.error(error);
        }
      },

      async cancel(reason) {
        cancelled = true;
        // Call return() on the iterator to trigger cleanup
        if (iterator.return) {
          await iterator.return(undefined);
        }
        await stream.cancel(reason);
      },
    },
    // Use a queuing strategy that provides some buffering
    new CountQueuingStrategy({ highWaterMark: 1 })
  );
}

// ============================================================================
// Adapter: Web WritableStream -> New Stream Writer interface
// ============================================================================

/**
 * Create a Writer sink that writes to a Web WritableStream.
 *
 * Features:
 * - Proper backpressure handling (waits for ready)
 * - Error propagation
 * - Proper close/abort handling
 */
function toWritableStreamSink(writable: WritableStream<Uint8Array>): WriterSink {
  const writer = writable.getWriter();

  return {
    async write(chunk: Uint8Array) {
      // Wait for the stream to be ready (backpressure)
      await writer.ready;
      await writer.write(chunk);
    },

    async close() {
      await writer.close();
    },

    async abort(reason) {
      await writer.abort(reason);
    },
  };
}

// ============================================================================
// Adapter: New Stream API -> Web WritableStream
// ============================================================================

/**
 * Create a Web WritableStream that writes to the new Stream API via a Writer.
 *
 * Returns both the WritableStream and the Stream that receives the data.
 *
 * Features:
 * - Proper backpressure via highWaterMark
 * - Error propagation
 * - Clean lifecycle management
 */
function toWritableStream(options?: {
  highWaterMark?: number;
}): { writable: WritableStream<Uint8Array>; stream: Stream } {
  const [stream, writer] = Stream.push({
    buffer: { max: options?.highWaterMark ?? 16384 },
  });

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      await writer.write(chunk);
    },

    async close() {
      await writer.close();
    },

    async abort(reason) {
      await writer.abort(reason);
    },
  });

  return { writable, stream };
}

// ============================================================================
// Adapter: Web TransformStream -> pipeThrough compatible
// ============================================================================

/**
 * Adapt a Web TransformStream for use with our pipeThrough.
 *
 * This creates a function that pipes through the TransformStream
 * and returns the result as a new Stream.
 */
function throughTransformStream<I extends Uint8Array, O extends Uint8Array>(
  transformStream: TransformStream<I, O>
): (input: Stream) => Stream {
  return (input: Stream) => {
    // Pipe input through the transform stream
    const webReadable = toReadableStream(input);
    const transformed = webReadable.pipeThrough(transformStream);
    return fromReadableStream(transformed);
  };
}

// ============================================================================
// Main examples
// ============================================================================

async function main() {
  // ============================================================================
  // Example 1: Web ReadableStream -> New Stream API
  // ============================================================================
  section('Example 1: Web ReadableStream -> New Stream API');

  {
    // Create a Web ReadableStream
    const webReadable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('Hello '));
        controller.enqueue(new TextEncoder().encode('from '));
        controller.enqueue(new TextEncoder().encode('Web Streams!'));
        controller.close();
      },
    });

    // Convert to new Stream API
    const stream = fromReadableStream(webReadable);

    // Use new Stream API methods
    const text = await stream.text();
    console.log('Read from Web ReadableStream:', text);
  }

  // ============================================================================
  // Example 2: New Stream API -> Web ReadableStream
  // ============================================================================
  section('Example 2: New Stream API -> Web ReadableStream');

  {
    // Create a new Stream
    const stream = Stream.from('Hello from new Stream API!');

    // Convert to Web ReadableStream
    const webReadable = toReadableStream(stream);

    // Use Web Streams API to consume
    const reader = webReadable.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const decoder = new TextDecoder();
    const text = chunks.map((c) => decoder.decode(c, { stream: true })).join('');
    console.log('Read from Web ReadableStream:', text);
  }

  // ============================================================================
  // Example 3: Pipe new Stream to Web WritableStream
  // ============================================================================
  section('Example 3: New Stream -> Web WritableStream');

  {
    // Collect output in an array (simulating a destination)
    const output: Uint8Array[] = [];

    // Create a Web WritableStream
    const webWritable = new WritableStream<Uint8Array>({
      write(chunk) {
        output.push(chunk);
      },
    });

    // Create source stream
    const source = Stream.from('Data flowing to Web WritableStream');

    // Pipe to Web WritableStream using our adapter
    const sink = toWritableStreamSink(webWritable);
    const writer = Stream.writer(sink);
    await source.pipeTo(writer);

    // Verify output
    const text = output.map((c) => new TextDecoder().decode(c)).join('');
    console.log('Written to Web WritableStream:', text);
  }

  // ============================================================================
  // Example 4: Web WritableStream -> New Stream (bidirectional)
  // ============================================================================
  section('Example 4: Web WritableStream -> New Stream');

  {
    // Create a writable that feeds into our Stream
    const { writable, stream } = toWritableStream();

    // Write using Web Streams API
    const writer = writable.getWriter();
    await writer.write(new TextEncoder().encode('Written '));
    await writer.write(new TextEncoder().encode('via '));
    await writer.write(new TextEncoder().encode('Web WritableStream'));
    await writer.close();

    // Read using new Stream API
    const text = await stream.text();
    console.log('Read from new Stream:', text);
  }

  // ============================================================================
  // Example 5: Using Web TransformStream with new Stream
  // ============================================================================
  section('Example 5: Web TransformStream Integration');

  {
    // Create a Web TransformStream that uppercases text
    const uppercaseTransform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        const upper = text.toUpperCase();
        controller.enqueue(new TextEncoder().encode(upper));
      },
    });

    // Create source stream
    const source = Stream.from('transform me to uppercase');

    // Apply the Web TransformStream
    const transformFn = throughTransformStream(uppercaseTransform);
    const transformed = transformFn(source);

    const text = await transformed.text();
    console.log('Transformed result:', text);
  }

  // ============================================================================
  // Example 6: Error Propagation (Web -> New Stream)
  // ============================================================================
  section('Example 6: Error Propagation (Web -> New Stream)');

  {
    // Create a Web ReadableStream that errors
    const erroringReadable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('some data'));
      },
      pull(controller) {
        controller.error(new Error('Intentional Web Stream error'));
      },
    });

    const stream = fromReadableStream(erroringReadable);

    try {
      await stream.text();
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Error correctly propagated:', (error as Error).message);
    }
  }

  // ============================================================================
  // Example 7: Error Propagation (New Stream -> Web)
  // ============================================================================
  section('Example 7: Error Propagation (New Stream -> Web)');

  {
    // Create a new Stream that errors
    const erroringStream = Stream.pull(async function* () {
      yield 'some data';
      throw new Error('Intentional new Stream error');
    });

    const webReadable = toReadableStream(erroringStream);
    const reader = webReadable.getReader();

    try {
      // First read succeeds
      const first = await reader.read();
      console.log(
        'First chunk:',
        first.value ? new TextDecoder().decode(first.value) : 'none'
      );

      // Second read throws
      await reader.read();
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Error correctly propagated:', (error as Error).message);
    }
  }

  // ============================================================================
  // Example 8: Cancellation Propagation
  // ============================================================================
  section('Example 8: Cancellation Propagation');

  {
    let cancelCalled = false;
    let readsAfterCancel = 0;

    // Create a source stream that can detect cancellation
    const source = Stream.pull(async function* () {
      for (let i = 0; i < 100; i++) {
        yield `chunk ${i}\n`;
      }
    });

    // Track when cancel propagates
    const originalCancel = source.cancel.bind(source);
    source.cancel = async (reason?: unknown) => {
      cancelCalled = true;
      return originalCancel(reason);
    };

    // Convert to Web ReadableStream
    const webReadable = toReadableStream(source);
    const reader = webReadable.getReader();

    // Read a few chunks
    await reader.read();
    await reader.read();
    console.log('Read 2 chunks');

    // Cancel the stream
    await reader.cancel('Done reading');

    // Verify cancel was called
    console.log('Cancel propagated to underlying stream:', cancelCalled);

    // Try to read more - should indicate stream is done
    try {
      const result = await source.read();
      console.log('Read after cancel returns done:', result.done);
    } catch (e) {
      console.log('Read after cancel throws (expected)');
    }
  }

  // ============================================================================
  // Example 9: Backpressure Handling
  // ============================================================================
  section('Example 9: Backpressure Handling');

  {
    let bytesProduced = 0;
    let bytesConsumed = 0;
    let readsPerformed = 0;

    // Create a producer that tracks bytes
    const source = Stream.pull(async function* () {
      for (let i = 0; i < 10; i++) {
        const chunk = `chunk ${i}\n`;
        bytesProduced += chunk.length;
        yield chunk;
      }
    });

    // Convert to Web ReadableStream
    const webReadable = toReadableStream(source);
    const reader = webReadable.getReader();

    // Consumer with simulated slow processing
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      readsPerformed++;
      bytesConsumed += value.length;

      // Simulate slow processing for first few reads
      if (readsPerformed <= 3) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    console.log(`Bytes produced: ${bytesProduced}, Bytes consumed: ${bytesConsumed}`);
    console.log(`Read operations: ${readsPerformed} (chunks may be batched)`);
    console.log('(Pull-based model: producer only runs when consumer requests data)');
  }

  // ============================================================================
  // Example 10: Full Pipeline (Web -> Transform -> Web)
  // ============================================================================
  section('Example 10: Full Pipeline (Web Source -> Transform -> Web Sink)');

  {
    // Source: Web ReadableStream
    const webSource = new ReadableStream<Uint8Array>({
      start(controller) {
        const lines = ['line one', 'line two', 'line three'];
        for (const line of lines) {
          controller.enqueue(new TextEncoder().encode(line + '\n'));
        }
        controller.close();
      },
    });

    // Destination: Web WritableStream (collecting output)
    const output: string[] = [];
    const webSink = new WritableStream<Uint8Array>({
      write(chunk) {
        output.push(new TextDecoder().decode(chunk));
      },
    });

    // Convert source to new Stream
    const inputStream = fromReadableStream(webSource);

    // Transform using new Stream API (add line numbers)
    let lineNum = 1;
    const transformed = inputStream.pipeThrough((chunk) => {
      if (chunk === null) return null;
      const text = new TextDecoder().decode(chunk);
      const lines = text.split('\n').filter((l) => l.length > 0);
      return lines.map((l) => `${lineNum++}: ${l}\n`).join('');
    });

    // Pipe to Web WritableStream
    const sink = toWritableStreamSink(webSink);
    const writer = Stream.writer(sink);
    await transformed.pipeTo(writer);

    console.log('Transformed output:');
    console.log(output.join('').trim());
  }

  // ============================================================================
  // Example 11: Teeing with Web Streams
  // ============================================================================
  section('Example 11: Tee to Web and New Stream');

  {
    // Create source data
    const source = Stream.from('Data to send to multiple destinations');

    // Create a branch that goes to Web ReadableStream
    const webBranch = source.tee();

    // Convert branch to Web ReadableStream for web consumers
    const webReadable = toReadableStream(webBranch);

    // Process main stream with new API
    const mainResult = await source.text();

    // Process web branch with Web Streams API
    const webReader = webReadable.getReader();
    const webChunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await webReader.read();
      if (done) break;
      webChunks.push(value);
    }
    const webResult = webChunks.map((c) => new TextDecoder().decode(c)).join('');

    console.log('Main stream result:', mainResult);
    console.log('Web branch result:', webResult);
    console.log('Both received same data:', mainResult === webResult);
  }

  // ============================================================================
  // Example 12: Streaming fetch() response (simulated)
  // ============================================================================
  section('Example 12: Processing fetch() Response Body (simulated)');

  {
    // Simulate a fetch() response body (which is a ReadableStream)
    const simulatedFetchBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Simulate chunked response
        const chunks = [
          '{"id": 1, "name": "Alice"}\n',
          '{"id": 2, "name": "Bob"}\n',
          '{"id": 3, "name": "Charlie"}\n',
        ];

        for (const chunk of chunks) {
          await new Promise((r) => setTimeout(r, 10)); // Simulate network delay
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    // Convert to new Stream for processing
    const stream = fromReadableStream(simulatedFetchBody);

    // Process NDJSON using new Stream API
    console.log('Processing NDJSON response:');

    let buffer = '';
    for await (const chunk of stream) {
      buffer += new TextDecoder().decode(chunk);

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line

      for (const line of lines) {
        if (line.trim()) {
          const obj = JSON.parse(line);
          console.log(`  Received: ${obj.name} (id=${obj.id})`);
        }
      }
    }
  }

  // ============================================================================
  // Example 13: Using await using with Web Streams
  // ============================================================================
  section('Example 13: Automatic Cleanup with await using');

  {
    let streamCancelled = false;

    // Create a new Stream that tracks cancellation
    const source = Stream.pull(async function* () {
      for (let i = 0; i < 1000; i++) {
        yield `line ${i}\n`;
      }
    });

    // Track cancel
    const originalCancel = source.cancel.bind(source);
    source.cancel = async (reason?: unknown) => {
      streamCancelled = true;
      return originalCancel(reason);
    };

    {
      // Use await using directly on our Stream
      await using stream = source;

      // Only read a small portion
      const partial = await stream.take(30).text();
      const lines = partial.split('\n').filter((l) => l).length;
      console.log('Read partial:', lines, 'lines');

      // Stream will be automatically cancelled when exiting this block
      console.log('Exiting block (stream will be auto-cancelled)...');
    }

    // The await using triggers [Symbol.asyncDispose] which calls cancel()
    console.log('Stream cancel() called by await using:', streamCancelled);
  }

  // ============================================================================
  // Example 14: Composing Web and New Stream Transforms
  // ============================================================================
  section('Example 14: Composing Web + New Stream Transforms');

  {
    // Web TransformStream: compress (simulated by adding prefix)
    const prefixTransform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const prefixed = new Uint8Array(chunk.length + 4);
        prefixed.set(new TextEncoder().encode('>>> '));
        prefixed.set(chunk, 4);
        controller.enqueue(prefixed);
      },
    });

    // New Stream transform: uppercase
    const uppercaseTransform = (chunk: Uint8Array | null) => {
      if (chunk === null) return null;
      return new TextDecoder().decode(chunk).toUpperCase();
    };

    // Source data
    const source = Stream.from('compose multiple transforms');

    // Apply Web Transform first
    const afterWebTransform = throughTransformStream(prefixTransform)(source);

    // Then apply new Stream transform
    const result = await afterWebTransform.pipeThrough(uppercaseTransform).text();

    console.log('Composed result:', result);
  }

  // ============================================================================
  // Example 15: Round-trip conversion
  // ============================================================================
  section('Example 15: Round-trip Conversion');

  {
    const originalData = 'Round-trip test data: Hello, World!';

    // Start with new Stream
    const stream1 = Stream.from(originalData);

    // Convert to Web ReadableStream
    const webReadable = toReadableStream(stream1);

    // Convert back to new Stream
    const stream2 = fromReadableStream(webReadable);

    // Verify data integrity
    const result = await stream2.text();

    console.log('Original:', originalData);
    console.log('After round-trip:', result);
    console.log('Data preserved:', originalData === result);
  }

  console.log('\n--- Web Streams Interop Examples Complete! ---\n');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
