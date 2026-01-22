/**
 * Benchmark: Consumption Methods
 *
 * Measures performance of different ways to consume stream data:
 * bytes(), text(), async iteration, read()
 *
 * Both APIs use equivalent patterns for fair comparison.
 */

import { Stream } from '../src/stream.js';
import {
  benchmark,
  createComparison,
  BenchmarkComparison,
  printComparison,
  generateChunks,
} from './utils.js';

async function runBenchmarks(): Promise<BenchmarkComparison[]> {
  const comparisons: BenchmarkComparison[] = [];

  // ============================================================================
  // Scenario 1: bytes() - collect all data
  // ============================================================================
  console.log('Running: bytes() collection...');
  {
    const chunkSize = 16 * 1024;
    const chunkCount = 500;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });
        const result = await stream.bytes();
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        let index = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        });

        const reader = stream.getReader();
        const result: Uint8Array[] = [];
        let totalLength = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          result.push(value);
          totalLength += value.length;
        }

        // Concatenate (equivalent work to bytes())
        const concat = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of result) {
          concat.set(chunk, offset);
          offset += chunk.length;
        }
        if (concat.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('bytes() (16KB x 500)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 2: text() - decode to string
  // ============================================================================
  console.log('Running: text() decode...');
  {
    const text = 'Hello, World! This is a test message. '.repeat(5000);
    const textBytes = new TextEncoder().encode(text);
    const chunkSize = 1024;
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < textBytes.length; i += chunkSize) {
      chunks.push(textBytes.subarray(i, Math.min(i + chunkSize, textBytes.length)));
    }
    const totalBytes = textBytes.length;

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });
        const result = await stream.text();
        if (result.length !== text.length) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        let index = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        });

        const reader = stream.getReader();
        const result: Uint8Array[] = [];
        let totalLength = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          result.push(value);
          totalLength += value.length;
        }
        const concat = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of result) {
          concat.set(chunk, offset);
          offset += chunk.length;
        }
        const decoded = new TextDecoder().decode(concat);
        if (decoded.length !== text.length) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('text() (1KB chunks)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 3: Async iteration
  // ============================================================================
  console.log('Running: Async iteration...');
  {
    const chunkSize = 8 * 1024;
    const chunkCount = 1000;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        let total = 0;
        for await (const chunk of stream) {
          total += chunk.length;
        }
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        let index = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        });

        let total = 0;
        // @ts-ignore
        for await (const chunk of stream) {
          total += chunk.length;
        }
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Async iteration (8KB x 1000)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 4: Low-level read() loop
  // ============================================================================
  console.log('Running: read() loop...');
  {
    const chunkSize = 8 * 1024;
    const chunkCount = 1000;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        let total = 0;
        while (true) {
          const { value, done } = await stream.read();
          if (done) break;
          total += value.length;
        }
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        let index = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        });

        const reader = stream.getReader();
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.length;
        }
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('read() loop (8KB x 1000)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 5: read({ atLeast }) - batched reads
  // ============================================================================
  console.log('Running: Batched reads...');
  {
    const chunkSize = 1024;
    const chunkCount = 3000;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);
    const readSize = 32 * 1024;

    const newStreamResult = await benchmark(
      'New Stream (atLeast)',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        let total = 0;
        while (true) {
          const { value, done } = await stream.read({ atLeast: readSize });
          if (value) total += value.length;  // Count value before checking done
          if (done) break;
        }
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    // Web Streams doesn't have atLeast, manual buffering
    const webStreamResult = await benchmark(
      'Web Stream (manual buffer)',
      async () => {
        let index = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        });

        const reader = stream.getReader();
        const buffer: Uint8Array[] = [];
        let bufferSize = 0;
        let total = 0;

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            total += bufferSize;
            break;
          }
          buffer.push(value);
          bufferSize += value.length;
          if (bufferSize >= readSize) {
            total += bufferSize;
            buffer.length = 0;
            bufferSize = 0;
          }
        }
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Batched reads (32KB batches)', newStreamResult, webStreamResult));
  }

  return comparisons;
}

// Main
console.log('Benchmark: Consumption Methods');
console.log('Measuring different ways to read stream data');
console.log('(minimum 20 samples, 3 seconds per test)\n');

runBenchmarks()
  .then(printComparison)
  .catch(console.error);
