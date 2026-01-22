/**
 * Benchmark: Push Stream Performance
 *
 * Measures performance of push-based streams where a producer
 * writes data and a consumer reads it concurrently.
 *
 * Both APIs run with concurrent read/write for fair comparison.
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
  // Scenario 1: Concurrent write/read (medium chunks)
  // ============================================================================
  console.log('Running: Concurrent push (medium chunks)...');
  {
    const chunkSize = 4 * 1024;
    const chunkCount = 1000;
    const totalBytes = chunkSize * chunkCount;

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        // Generate fresh chunks each iteration (Writer detaches buffers)
        const chunks = generateChunks(chunkSize, chunkCount);
        const { stream, writer } = Stream.push();

        const writePromise = (async () => {
          for (const chunk of chunks) {
            await writer.write(chunk);
          }
          await writer.close();
        })();

        const readPromise = stream.bytes();

        const [, result] = await Promise.all([writePromise, readPromise]);
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        // Generate fresh chunks each iteration for fair comparison
        const chunks = generateChunks(chunkSize, chunkCount);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });

        const writePromise = (async () => {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
            await Promise.resolve(); // Yield to simulate async
          }
          controller.close();
        })();

        const readPromise = (async () => {
          const reader = stream.getReader();
          const result: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            result.push(value);
            total += value.length;
          }
          return total;
        })();

        const [, total] = await Promise.all([writePromise, readPromise]);
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Concurrent push (4KB x 1000)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 2: Many small writes
  // ============================================================================
  console.log('Running: Many small writes...');
  {
    const chunkSize = 64;
    const chunkCount = 10000;
    const totalBytes = chunkSize * chunkCount;

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        // Generate fresh chunks each iteration (Writer detaches buffers)
        const chunks = generateChunks(chunkSize, chunkCount);
        const { stream, writer } = Stream.push();

        const writePromise = (async () => {
          for (const chunk of chunks) {
            await writer.write(chunk);
          }
          await writer.close();
        })();

        const readPromise = stream.bytes();

        const [, result] = await Promise.all([writePromise, readPromise]);
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 15, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        // Generate fresh chunks for fair comparison
        const chunks = generateChunks(chunkSize, chunkCount);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });

        const writePromise = (async () => {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
            await Promise.resolve();
          }
          controller.close();
        })();

        const readPromise = (async () => {
          const reader = stream.getReader();
          let total = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
          }
          return total;
        })();

        const [, total] = await Promise.all([writePromise, readPromise]);
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 15, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Many small writes (64B x 10000)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 3: Batch writes (writev)
  // ============================================================================
  console.log('Running: Batch writes...');
  {
    const chunkSize = 512;
    const chunksPerBatch = 20;
    const batchCount = 200;
    const totalBytes = chunkSize * chunksPerBatch * batchCount;

    // Helper to generate fresh batches
    const generateBatches = () => {
      const batches: Uint8Array[][] = [];
      for (let i = 0; i < batchCount; i++) {
        batches.push(generateChunks(chunkSize, chunksPerBatch));
      }
      return batches;
    };

    const newStreamResult = await benchmark(
      'New Stream (writev)',
      async () => {
        // Generate fresh batches (Writer detaches buffers)
        const batches = generateBatches();
        const { stream, writer } = Stream.push();

        const writePromise = (async () => {
          for (const batch of batches) {
            await writer.writev(batch);
          }
          await writer.close();
        })();

        const readPromise = stream.bytes();

        const [, result] = await Promise.all([writePromise, readPromise]);
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream (multi-enqueue)',
      async () => {
        // Generate fresh batches for fair comparison
        const batches = generateBatches();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });

        const writePromise = (async () => {
          for (const batch of batches) {
            for (const chunk of batch) {
              controller.enqueue(chunk);
            }
            await Promise.resolve();
          }
          controller.close();
        })();

        const readPromise = (async () => {
          const reader = stream.getReader();
          let total = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
          }
          return total;
        })();

        const [, total] = await Promise.all([writePromise, readPromise]);
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Batch writes (512B x 20 x 200)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 4: Async iteration consumption
  // ============================================================================
  console.log('Running: Push + async iteration...');
  {
    const chunkSize = 2 * 1024;
    const chunkCount = 1000;
    const totalBytes = chunkSize * chunkCount;

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        // Generate fresh chunks (Writer detaches buffers)
        const chunks = generateChunks(chunkSize, chunkCount);
        const { stream, writer } = Stream.push();

        const writePromise = (async () => {
          for (const chunk of chunks) {
            await writer.write(chunk);
          }
          await writer.close();
        })();

        let total = 0;
        for await (const chunk of stream) {
          total += chunk.length;
        }
        await writePromise;
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const webStreamResult = await benchmark(
      'Web Stream',
      async () => {
        // Generate fresh chunks for fair comparison
        const chunks = generateChunks(chunkSize, chunkCount);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });

        const writePromise = (async () => {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
            await Promise.resolve();
          }
          controller.close();
        })();

        let total = 0;
        // @ts-ignore
        for await (const chunk of stream) {
          total += chunk.length;
        }
        await writePromise;
        if (total !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Push + async iter (2KB x 1000)', newStreamResult, webStreamResult));
  }

  return comparisons;
}

// Main
console.log('Benchmark: Push Stream Performance');
console.log('Measuring concurrent write/read patterns');
console.log('(minimum 15-20 samples, 3 seconds per test)\n');

runBenchmarks()
  .then(printComparison)
  .catch(console.error);
