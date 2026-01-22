/**
 * Profiling target - runs a focused benchmark for CPU profiling
 * 
 * Usage:
 *   node --prof --no-logfile-per-isolate dist/benchmarks/profile-target.js
 *   node --prof-process isolate-*.log > profile.txt
 * 
 * Or with tsx for quick profiling:
 *   npx tsx benchmarks/profile-target.ts
 */

import { Stream } from '../src/stream.js';

const CHUNK_SIZE = 8 * 1024; // 8KB
const NUM_CHUNKS = 10000;
const TOTAL_BYTES = CHUNK_SIZE * NUM_CHUNKS;

async function runNewStreamThroughput(): Promise<number> {
  const chunk = new Uint8Array(CHUNK_SIZE);
  let bytesRead = 0;
  
  const stream = Stream.pull(async function* () {
    for (let i = 0; i < NUM_CHUNKS; i++) {
      yield chunk;
    }
  });

  for await (const data of stream) {
    bytesRead += data.length;
  }
  
  return bytesRead;
}

async function runNewStreamPull(): Promise<number> {
  const chunk = new Uint8Array(CHUNK_SIZE);
  let bytesRead = 0;
  
  const stream = Stream.pull(async function* () {
    for (let i = 0; i < NUM_CHUNKS; i++) {
      yield chunk;
    }
  });

  while (true) {
    const result = await stream.read();
    if (result.done) break;
    bytesRead += result.value!.length;
  }
  
  return bytesRead;
}

async function runNewStreamWithTransform(): Promise<number> {
  // Generate fresh chunks for each iteration (Writer detaches buffers)
  const chunks = Array.from({ length: NUM_CHUNKS }, () => new Uint8Array(CHUNK_SIZE));
  let bytesRead = 0;
  
  const stream = Stream.pull(async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  });

  // Simple identity transform (returns the chunk unchanged)
  const transformed = stream.pipeThrough((data) => data);

  for await (const data of transformed) {
    bytesRead += data.length;
  }
  
  return bytesRead;
}

async function main() {
  console.log('Profiling New Stream Implementation');
  console.log(`Chunk size: ${CHUNK_SIZE} bytes`);
  console.log(`Number of chunks: ${NUM_CHUNKS}`);
  console.log(`Total data: ${(TOTAL_BYTES / 1024 / 1024).toFixed(1)} MB`);
  console.log('');

  // Warm up
  console.log('Warming up...');
  for (let i = 0; i < 3; i++) {
    await runNewStreamThroughput();
  }

  // Profile async iteration (the slowest case)
  console.log('');
  console.log('=== Profiling async iteration ===');
  const iterations = 20;
  const startIteration = performance.now();
  for (let i = 0; i < iterations; i++) {
    await runNewStreamThroughput();
  }
  const endIteration = performance.now();
  const iterationTime = (endIteration - startIteration) / iterations;
  const iterationThroughput = TOTAL_BYTES / (iterationTime / 1000) / 1024 / 1024 / 1024;
  console.log(`Async iteration: ${iterationTime.toFixed(2)}ms per run, ${iterationThroughput.toFixed(2)} GB/s`);

  // Profile read() loop
  console.log('');
  console.log('=== Profiling read() loop ===');
  const startPull = performance.now();
  for (let i = 0; i < iterations; i++) {
    await runNewStreamPull();
  }
  const endPull = performance.now();
  const pullTime = (endPull - startPull) / iterations;
  const pullThroughput = TOTAL_BYTES / (pullTime / 1000) / 1024 / 1024 / 1024;
  console.log(`Pull (read()): ${pullTime.toFixed(2)}ms per run, ${pullThroughput.toFixed(2)} GB/s`);

  // Profile with transform
  console.log('');
  console.log('=== Profiling with transform ===');
  const startTransform = performance.now();
  for (let i = 0; i < iterations; i++) {
    await runNewStreamWithTransform();
  }
  const endTransform = performance.now();
  const transformTime = (endTransform - startTransform) / iterations;
  const transformThroughput = TOTAL_BYTES / (transformTime / 1000) / 1024 / 1024 / 1024;
  console.log(`With transform: ${transformTime.toFixed(2)}ms per run, ${transformThroughput.toFixed(2)} GB/s`);

  console.log('');
  console.log('Profiling complete.');
}

main().catch(console.error);
