/**
 * Benchmark: Sync vs Async Generators
 *
 * Measures the performance difference between sync and async generators
 * in Stream.pull() to validate the sync generator fast path optimization.
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
  // Scenario 1: Large chunks - sync vs async generator
  // ============================================================================
  console.log('Running: Large chunks (sync vs async generator)...');
  {
    const chunkSize = 64 * 1024;
    const chunkCount = 500;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const syncResult = await benchmark(
      'Sync Generator',
      async () => {
        const stream = Stream.pull(function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });
        const result = await stream.bytes();
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const asyncResult = await benchmark(
      'Async Generator',
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

    comparisons.push(createComparison('Large chunks (64KB x 500)', syncResult, asyncResult));
  }

  // ============================================================================
  // Scenario 2: Medium chunks - sync vs async generator
  // ============================================================================
  console.log('Running: Medium chunks (sync vs async generator)...');
  {
    const chunkSize = 8 * 1024;
    const chunkCount = 2000;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const syncResult = await benchmark(
      'Sync Generator',
      async () => {
        const stream = Stream.pull(function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });
        const result = await stream.bytes();
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const asyncResult = await benchmark(
      'Async Generator',
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

    comparisons.push(createComparison('Medium chunks (8KB x 2000)', syncResult, asyncResult));
  }

  // ============================================================================
  // Scenario 3: Small chunks - sync vs async generator
  // ============================================================================
  console.log('Running: Small chunks (sync vs async generator)...');
  {
    const chunkSize = 1024;
    const chunkCount = 5000;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const syncResult = await benchmark(
      'Sync Generator',
      async () => {
        const stream = Stream.pull(function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });
        const result = await stream.bytes();
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const asyncResult = await benchmark(
      'Async Generator',
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

    comparisons.push(createComparison('Small chunks (1KB x 5000)', syncResult, asyncResult));
  }

  // ============================================================================
  // Scenario 4: Tiny chunks - sync vs async generator (most visible difference)
  // ============================================================================
  console.log('Running: Tiny chunks (sync vs async generator)...');
  {
    const chunkSize = 100;
    const chunkCount = 10000;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const syncResult = await benchmark(
      'Sync Generator',
      async () => {
        const stream = Stream.pull(function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });
        const result = await stream.bytes();
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const asyncResult = await benchmark(
      'Async Generator',
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

    comparisons.push(createComparison('Tiny chunks (100B x 10000)', syncResult, asyncResult));
  }

  // ============================================================================
  // Scenario 5: Many tiny chunks (extreme case)
  // ============================================================================
  console.log('Running: Many tiny chunks (extreme case)...');
  {
    const chunkSize = 10;
    const chunkCount = 50000;
    const totalBytes = chunkSize * chunkCount;
    const chunks = generateChunks(chunkSize, chunkCount);

    const syncResult = await benchmark(
      'Sync Generator',
      async () => {
        const stream = Stream.pull(function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        });
        const result = await stream.bytes();
        if (result.length !== totalBytes) throw new Error('Wrong size');
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    const asyncResult = await benchmark(
      'Async Generator',
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

    comparisons.push(createComparison('Many tiny (10B x 50000)', syncResult, asyncResult));
  }

  return comparisons;
}

// Main
console.log('Benchmark: Sync vs Async Generators');
console.log('Measuring performance difference of sync generator fast path');
console.log('(minimum 20 samples, 3 seconds per test)\n');

runBenchmarks()
  .then(printComparison)
  .catch(console.error);
