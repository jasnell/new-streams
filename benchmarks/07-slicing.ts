/**
 * Benchmark: Slicing Operations
 *
 * Measures performance of take(), drop(), and limit() operations.
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
  // Scenario 1: take() - read first N bytes
  // ============================================================================
  console.log('Running: take()...');
  {
    const chunkSize = 4 * 1024;
    const chunkCount = 500;
    const takeBytes = 100 * chunkSize;
    const totalBytes = takeBytes;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        const taken = stream.take(takeBytes);
        const result = await taken.bytes();
        if (result.length !== takeBytes) throw new Error('Wrong size');
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
        let bytesRead = 0;

        while (bytesRead < takeBytes) {
          const { value, done } = await reader.read();
          if (done) break;
          result.push(value);
          bytesRead += value.length;
        }
        reader.releaseLock();

        // Concatenate
        const concat = new Uint8Array(bytesRead);
        let offset = 0;
        for (const chunk of result) {
          concat.set(chunk, offset);
          offset += chunk.length;
        }
        if (concat.length < takeBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('take() 100 of 500 chunks', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 2: drop() - skip first N bytes
  // ============================================================================
  console.log('Running: drop()...');
  {
    const chunkSize = 4 * 1024;
    const chunkCount = 500;
    const dropBytes = 100 * chunkSize;
    const remainingBytes = (chunkCount - 100) * chunkSize;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        stream.drop(dropBytes);
        const result = await stream.bytes();
        if (result.length !== remainingBytes) throw new Error('Wrong size');
      },
      { totalBytes: remainingBytes, minSamples: 20, minTimeMs: 3000 }
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
        let bytesSkipped = 0;
        let bytesRead = 0;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (bytesSkipped < dropBytes) {
            bytesSkipped += value.length;
            continue;
          }
          result.push(value);
          bytesRead += value.length;
        }

        // Concatenate
        const concat = new Uint8Array(bytesRead);
        let offset = 0;
        for (const chunk of result) {
          concat.set(chunk, offset);
          offset += chunk.length;
        }
        if (concat.length !== remainingBytes) throw new Error('Wrong size');
      },
      { totalBytes: remainingBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('drop() 100 of 500 chunks', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 3: limit() - cap stream
  // ============================================================================
  console.log('Running: limit()...');
  {
    const chunkSize = 4 * 1024;
    const chunkCount = 500;
    const limitBytes = 250 * chunkSize;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        stream.limit(limitBytes);
        const result = await stream.bytes();
        if (result.length !== limitBytes) throw new Error('Wrong size');
      },
      { totalBytes: limitBytes, minSamples: 20, minTimeMs: 3000 }
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
        let bytesRead = 0;

        while (bytesRead < limitBytes) {
          const { value, done } = await reader.read();
          if (done) break;
          result.push(value);
          bytesRead += value.length;
        }
        reader.releaseLock();
        await stream.cancel();

        // Concatenate
        const concat = new Uint8Array(Math.min(bytesRead, limitBytes));
        let offset = 0;
        for (const chunk of result) {
          const toCopy = Math.min(chunk.length, limitBytes - offset);
          concat.set(chunk.subarray(0, toCopy), offset);
          offset += toCopy;
          if (offset >= limitBytes) break;
        }
        if (concat.length !== limitBytes) throw new Error('Wrong size');
      },
      { totalBytes: limitBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('limit() 250 of 500 chunks', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 4: Combined drop() + take()
  // ============================================================================
  console.log('Running: drop() + take()...');
  {
    const chunkSize = 4 * 1024;
    const chunkCount = 500;
    const dropBytes = 100 * chunkSize;
    const takeBytes = 150 * chunkSize;
    const chunks = generateChunks(chunkSize, chunkCount);

    const newStreamResult = await benchmark(
      'New Stream',
      async () => {
        const stream = Stream.pull(async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });

        stream.drop(dropBytes);
        const taken = stream.take(takeBytes);
        const result = await taken.bytes();
        if (result.length !== takeBytes) throw new Error('Wrong size');
      },
      { totalBytes: takeBytes, minSamples: 20, minTimeMs: 3000 }
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
        let bytesSkipped = 0;
        let bytesRead = 0;

        while (bytesRead < takeBytes) {
          const { value, done } = await reader.read();
          if (done) break;
          if (bytesSkipped < dropBytes) {
            bytesSkipped += value.length;
            continue;
          }
          result.push(value);
          bytesRead += value.length;
        }
        reader.releaseLock();

        // Concatenate
        const concat = new Uint8Array(Math.min(bytesRead, takeBytes));
        let offset = 0;
        for (const chunk of result) {
          const toCopy = Math.min(chunk.length, takeBytes - offset);
          concat.set(chunk.subarray(0, toCopy), offset);
          offset += toCopy;
          if (offset >= takeBytes) break;
        }
        if (concat.length !== takeBytes) throw new Error('Wrong size');
      },
      { totalBytes: takeBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('drop(100) + take(150)', newStreamResult, webStreamResult));
  }

  return comparisons;
}

// Main
console.log('Benchmark: Slicing Operations');
console.log('Measuring take(), drop(), limit() performance');
console.log('(minimum 20 samples, 3 seconds per test)\n');

runBenchmarks()
  .then(printComparison)
  .catch(console.error);
