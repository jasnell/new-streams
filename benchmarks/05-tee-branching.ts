/**
 * Benchmark: Tee/Branching Performance
 *
 * Measures performance of stream branching with tee().
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
  // Scenario 1: Single tee (2 readers)
  // ============================================================================
  console.log('Running: Single tee...');
  {
    const chunkSize = 4 * 1024;
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

        const branch = source.tee();

        const [result1, result2] = await Promise.all([source.bytes(), branch.bytes()]);

        if (result1.length !== totalBytes || result2.length !== totalBytes) {
          throw new Error('Wrong size');
        }
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

        const [branch1, branch2] = source.tee();

        const readBranch = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          let total = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
          }
          return total;
        };

        const [total1, total2] = await Promise.all([readBranch(branch1), readBranch(branch2)]);

        if (total1 !== totalBytes || total2 !== totalBytes) {
          throw new Error('Wrong size');
        }
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Single tee (4KB x 500)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 2: Tee with different processing per branch
  // ============================================================================
  console.log('Running: Tee with transforms...');
  {
    const chunkSize = 4 * 1024;
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

        const branch = source.tee();

        // Different processing per branch
        const result1Promise = source.pipeThrough((chunk) => chunk).bytes();

        const result2Promise = branch
          .pipeThrough((chunk) => {
            if (chunk === null) return null;
            const result = new Uint8Array(chunk.length);
            for (let i = 0; i < chunk.length; i++) {
              result[i] = chunk[i] ^ 0x42;
            }
            return result;
          })
          .bytes();

        const [result1, result2] = await Promise.all([result1Promise, result2Promise]);

        if (result1.length !== totalBytes || result2.length !== totalBytes) {
          throw new Error('Wrong size');
        }
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

        const [branch1, branch2] = source.tee();

        const t1 = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });

        const t2 = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            const result = new Uint8Array(chunk.length);
            for (let i = 0; i < chunk.length; i++) {
              result[i] = chunk[i] ^ 0x42;
            }
            controller.enqueue(result);
          },
        });

        const readBranch = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          let total = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
          }
          return total;
        };

        const [total1, total2] = await Promise.all([
          readBranch(branch1.pipeThrough(t1)),
          readBranch(branch2.pipeThrough(t2)),
        ]);

        if (total1 !== totalBytes || total2 !== totalBytes) {
          throw new Error('Wrong size');
        }
      },
      { totalBytes, minSamples: 20, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Tee + transforms (4KB x 500)', newStreamResult, webStreamResult));
  }

  // ============================================================================
  // Scenario 3: Small chunks tee (stress test)
  // ============================================================================
  console.log('Running: Small chunks tee...');
  {
    const chunkSize = 256;
    const chunkCount = 5000;
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

        const branch = source.tee();

        const [result1, result2] = await Promise.all([source.bytes(), branch.bytes()]);

        if (result1.length !== totalBytes || result2.length !== totalBytes) {
          throw new Error('Wrong size');
        }
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

        const [branch1, branch2] = source.tee();

        const readBranch = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          let total = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
          }
          return total;
        };

        const [total1, total2] = await Promise.all([readBranch(branch1), readBranch(branch2)]);

        if (total1 !== totalBytes || total2 !== totalBytes) {
          throw new Error('Wrong size');
        }
      },
      { totalBytes, minSamples: 15, minTimeMs: 3000 }
    );

    comparisons.push(createComparison('Small chunks tee (256B x 5000)', newStreamResult, webStreamResult));
  }

  return comparisons;
}

// Main
console.log('Benchmark: Tee/Branching Performance');
console.log('Measuring stream branching efficiency');
console.log('(minimum 15-20 samples, 3 seconds per test)\n');

runBenchmarks()
  .then(printComparison)
  .catch(console.error);
