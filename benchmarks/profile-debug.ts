/**
 * Debug profiling target to understand read patterns
 */

import { Stream } from '../src/stream.js';

const CHUNK_SIZE = 8 * 1024; // 8KB
const NUM_CHUNKS = 100;  // Smaller for debugging

async function runNewStreamDebug(): Promise<void> {
  const chunk = new Uint8Array(CHUNK_SIZE);
  let readCount = 0;
  let yieldCount = 0;
  
  const stream = Stream.pull(async function* () {
    for (let i = 0; i < NUM_CHUNKS; i++) {
      yieldCount++;
      yield chunk;
    }
    console.log(`Generator yielded ${yieldCount} chunks`);
  });

  for await (const data of stream) {
    readCount++;
    if (data.length !== CHUNK_SIZE) {
      console.log(`Unexpected chunk size: ${data.length} at read ${readCount}`);
    }
  }
  
  console.log(`Total reads: ${readCount}`);
}

async function runWithTransform(): Promise<void> {
  const chunk = new Uint8Array(CHUNK_SIZE);
  let readCount = 0;
  let transformCount = 0;
  
  const stream = Stream.pull(async function* () {
    for (let i = 0; i < NUM_CHUNKS; i++) {
      yield chunk;
    }
    console.log(`Generator yielded ${NUM_CHUNKS} chunks`);
  });

  const transformed = stream.pipeThrough((data) => {
    transformCount++;
    return data;
  });

  for await (const data of transformed) {
    readCount++;
    if (data.length !== CHUNK_SIZE) {
      console.log(`Unexpected chunk size: ${data.length} at read ${readCount}`);
    }
  }
  
  console.log(`Transform calls: ${transformCount}`);
  console.log(`Total reads: ${readCount}`);
}

async function main() {
  console.log('Debug: Understanding read patterns');
  console.log(`Chunk size: ${CHUNK_SIZE} bytes`);
  console.log(`Number of chunks: ${NUM_CHUNKS}`);
  console.log('');

  console.log('=== Without Transform ===');
  await runNewStreamDebug();
  
  console.log('');
  console.log('=== With Transform ===');
  await runWithTransform();
}

main().catch(console.error);
