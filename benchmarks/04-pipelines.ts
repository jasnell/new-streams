/**
 * Benchmark: Pipeline Performance
 *
 * Measures performance of full pipelines: source -> transforms -> destination.
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
  // Scenario 1: Simple pipeline (source -> destination)
  // ============================================================================
  console.log('Running: Simple pipeline...');
  {
    const chunkSize = 8 * 1024;
    const chunkCount = 1000;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const source = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        let total = 0;
        const dest = Stream.writer({
          write(chunk) {
            total += chunk.length;
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        });

        await source.pipeTo(dest);
        if (total !== totalBytes) throw new Error('Wrong size');
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

        let total = 0;
        const dest = new WritableStream<Uint8Array>({
          write(chunk) {
            total += chunk.length;
          },
        });

        await source.pipeTo(dest);
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Simple pipeline (8KB x 1000)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 2: Pipeline with transform
  // ============================================================================
  console.log('Running: Pipeline with transform...');
  {
    const chunkSize = 8 * 1024;
    const chunkCount = 1000;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);
    const xorKey = 0x42;

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const source = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        const transform = (chunk: Uint8Array | null) => {
          if (chunk === null) return null;
          const result = new Uint8Array(chunk.length);
          for (let i = 0; i < chunk.length; i++) {
            result[i] = chunk[i] ^ xorKey;
          }
          return result;
        };

        let total = 0;
        const dest = Stream.writer({
          write(chunk) {
            total += chunk.length;
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        });

        await Stream.pipeline(source, transform, dest);
        if (total !== totalBytes) throw new Error('Wrong size');
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

        let total = 0;
        const dest = new WritableStream<Uint8Array>({
          write(chunk) {
            total += chunk.length;
          },
        });

        await source.pipeThrough(transform).pipeTo(dest);
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Pipeline + XOR (8KB x 1000)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 3: Multi-stage pipeline
  // ============================================================================
  console.log('Running: Multi-stage pipeline...');
  {
    const chunkSize = 8 * 1024;
    const chunkCount = 500;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const source = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        const t1 = (chunk: Uint8Array | null) => chunk;
        const t2 = (chunk: Uint8Array | null) => chunk;
        const t3 = (chunk: Uint8Array | null) => chunk;

        let total = 0;
        const dest = Stream.writer({
          write(chunk) {
            total += chunk.length;
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        });

        await Stream.pipeline(source, t1, t2, t3, dest);
        if (total !== totalBytes) throw new Error('Wrong size');
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

        const createTransform = () =>
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              controller.enqueue(chunk);
            },
          });

        let total = 0;
        const dest = new WritableStream<Uint8Array>({
          write(chunk) {
            total += chunk.length;
          },
        });

        await source
          .pipeThrough(createTransform())
          .pipeThrough(createTransform())
          .pipeThrough(createTransform())
          .pipeTo(dest);
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Multi-stage 3x (8KB x 500)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 4: High-frequency small chunks
  // ============================================================================
  console.log('Running: High-frequency small chunks...');
  {
    const chunkSize = 64;
    const chunkCount = 20000;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const source = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        let total = 0;
        const dest = Stream.writer({
          write(chunk) {
            total += chunk.length;
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        });

        await source.pipeTo(dest);
        if (total !== totalBytes) throw new Error('Wrong size');
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

        let total = 0;
        const dest = new WritableStream<Uint8Array>({
          write(chunk) {
            total += chunk.length;
          },
        });

        await source.pipeTo(dest);
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 15, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('High-freq (64B x 20000)', newStreamResult, webStreamResult));
  }

  return comparisons;
}

// Main
console.log('Benchmark: Pipeline Performance');
console.log('Measuring full pipeline throughput');
console.log('(minimum 15-20 samples, 3 seconds per test)\n');

runBenchmarks()
  .then(printComparison)
  .catch(console.error);
