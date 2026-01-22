/**
 * Profile script for bytes() consumption
 */

import { Stream } from '../src/stream.js';

async function main() {
  const chunkSize = 8 * 1024;
  const chunkCount = 2000;
  const totalBytes = chunkSize * chunkCount;
  
  // Pre-generate chunks
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunk = new Uint8Array(chunkSize);
    chunk.fill(i % 256);
    chunks.push(chunk);
  }

  console.log(`Profile: ${chunkCount} chunks of ${chunkSize} bytes = ${totalBytes} total`);
  console.log('Running 100 iterations...\n');

  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    const stream = Stream.pull(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    const result = await stream.bytes();
    if (result.length !== totalBytes) throw new Error('Wrong size');
  }
  const elapsed = performance.now() - start;
  
  console.log(`Total time: ${elapsed.toFixed(0)}ms`);
  console.log(`Per iteration: ${(elapsed / 100).toFixed(2)}ms`);
  console.log(`Throughput: ${((totalBytes * 100) / (elapsed / 1000) / 1e9).toFixed(2)} GB/s`);
}

main().catch(console.error);
