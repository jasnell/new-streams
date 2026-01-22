/**
 * Benchmark: Transform Performance
 *
 * Measures performance of data transformations through streams.
 * Both APIs use equivalent transform patterns for fair comparison.
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
  // Scenario 1: Identity transform (pass-through baseline)
  // ============================================================================
  console.log('Running: Identity transform...');
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

        const transformed = stream.pipeThrough((chunk) => chunk);
        const result = await transformed.bytes();
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        let index = 0;
        const source = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        });

        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });

        const reader = source.pipeThrough(transform).getReader();
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

    comparisons.push(createComparison('Identity transform (8KB x 1000)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 2: Byte manipulation (XOR)
  // ============================================================================
  console.log('Running: XOR transform...');
  {
    const chunkSize = 8 * 1024;
    const chunkCount = 500;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);
    const xorKey = 0x42;

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        const transformed = stream.pipeThrough((chunk) => {
          if (chunk === null) return null;
          const result = new Uint8Array(chunk.length);
          for (let i = 0; i < chunk.length; i++) {
            result[i] = chunk[i] ^ xorKey;
          }
          return result;
        });
        const result = await transformed.bytes();
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        let index = 0;
        const source = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        });

        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            const result = new Uint8Array(chunk.length);
            for (let i = 0; i < chunk.length; i++) {
              result[i] = chunk[i] ^ xorKey;
            }
            controller.enqueue(result);
          },
        });

        const reader = source.pipeThrough(transform).getReader();
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

    comparisons.push(createComparison('XOR transform (8KB x 500)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 3: Expanding transform (1:2)
  // ============================================================================
  console.log('Running: Expanding transform...');
  {
    const chunkSize = 4 * 1024;
    const chunkCount = 500;
    const inputBytes = chunkSize * chunkCount;
    const outputBytes = inputBytes * 2;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        const transformed = stream.pipeThrough(function* (chunk) {
          if (chunk === null) return;
          yield chunk;
          yield chunk;
        });
        const result = await transformed.bytes();
        if (result.length !== outputBytes) throw new Error('Wrong size');
      },
      { totalBytes: outputBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        let index = 0;
        const source = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        });

        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            controller.enqueue(chunk);
          },
        });

        const reader = source.pipeThrough(transform).getReader();
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.length;
        }
        if (total !== outputBytes) throw new Error('Wrong size');
      },
      { totalBytes: outputBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Expanding 1:2 (4KB x 500)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 4: Chained transforms (3 stages)
  // ============================================================================
  console.log('Running: Chained transforms...');
  {
    const chunkSize = 8 * 1024;
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

        const transformed = stream
          .pipeThrough((chunk) => chunk)
          .pipeThrough((chunk) => chunk)
          .pipeThrough((chunk) => chunk);

        const result = await transformed.bytes();
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        let index = 0;
        const source = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        });

        const t1 = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });
        const t2 = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });
        const t3 = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });

        const reader = source.pipeThrough(t1).pipeThrough(t2).pipeThrough(t3).getReader();
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

    comparisons.push(createComparison('Chained 3x (8KB x 500)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 5: Async transform
  // ============================================================================
  console.log('Running: Async transform...');
  {
    const chunkSize = 8 * 1024;
    const chunkCount = 300;
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

        const transformed = stream.pipeThrough(async (chunk) => {
          await Promise.resolve();
          return chunk;
        });
        const result = await transformed.bytes();
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 15, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        let index = 0;
        const source = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        });

        const transform = new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, controller) {
            await Promise.resolve();
            controller.enqueue(chunk);
          },
        });

        const reader = source.pipeThrough(transform).getReader();
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.length;
        }
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 15, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Async transform (8KB x 300)', newStreamResult, webStreamResult));
  }

  return comparisons;
}

// Main
console.log('Benchmark: Transform Performance');
console.log('Measuring data transformation speed');
console.log('(minimum 15-20 samples, 3 seconds per test)\n');

runBenchmarks()
  .then(printComparison)
  .catch(console.error);
