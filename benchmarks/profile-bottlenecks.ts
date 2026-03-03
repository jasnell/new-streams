/**
 * Profile known bottlenecks for optimization opportunities
 */
import { Stream } from '../src/index.js';
import type { Transform } from '../src/index.js';
import { generateChunks } from './utils.js';

const chunkSize = 8 * 1024;
const chunkCount = 1000;
const totalBytes = chunkSize * chunkCount;
const chunks = generateChunks(chunkSize, chunkCount);

async function measure(name: string, iterations: number, fn: () => Promise<void> | void): Promise<number> {
  // Warmup
  for (let i = 0; i < 10; i++) await fn();
  
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const time = performance.now() - start;
  
  const perIter = time / iterations;
  const throughput = totalBytes / (perIter / 1000);
  console.log(`${name.padEnd(45)} ${perIter.toFixed(3).padStart(10)}ms  ${(throughput / 1e9).toFixed(2).padStart(8)} GB/s`);
  return perIter;
}

async function main() {
  const iterations = 100;
  
  console.log('=== Bottleneck Analysis ===');
  console.log(`Data: ${chunkCount} x ${chunkSize/1024}KB = ${totalBytes/1024/1024}MB`);
  console.log(`Iterations: ${iterations}\n`);
  
  // =========================================================================
  // BOTTLENECK 1: Generator sources are 12-18x slower than array
  // =========================================================================
  console.log('▶ BOTTLENECK 1: Generator Sources\n');
  
  const arrayTime = await measure('  Baseline: from(Uint8Array[])', iterations, async () => {
    for await (const batch of Stream.from(chunks)) {
      for (const chunk of batch) chunk.length;
    }
  });
  
  function* syncGen() {
    for (const chunk of chunks) yield chunk;
  }
  const syncGenTime = await measure('  from(sync generator)', iterations, async () => {
    for await (const batch of Stream.from(syncGen())) {
      for (const chunk of batch) chunk.length;
    }
  });
  
  async function* asyncGen() {
    for (const chunk of chunks) yield chunk;
  }
  const asyncGenTime = await measure('  from(async generator)', iterations, async () => {
    for await (const batch of Stream.from(asyncGen())) {
      for (const chunk of batch) chunk.length;
    }
  });
  
  // Test: What if we batch the generator output?
  async function* batchedAsyncGen() {
    const batch: Uint8Array[] = [];
    for (const chunk of chunks) {
      batch.push(chunk);
      if (batch.length >= 100) {
        yield batch.splice(0);
      }
    }
    if (batch.length > 0) yield batch;
  }
  const batchedGenTime = await measure('  from(batched async gen, 100/batch)', iterations, async () => {
    for await (const batch of Stream.from(batchedAsyncGen())) {
      for (const chunk of batch) chunk.length;
    }
  });
  
  console.log(`\n  Analysis:`);
  console.log(`    sync gen overhead:    ${(syncGenTime / arrayTime).toFixed(1)}x slower`);
  console.log(`    async gen overhead:   ${(asyncGenTime / arrayTime).toFixed(1)}x slower`);
  console.log(`    batched gen overhead: ${(batchedGenTime / arrayTime).toFixed(1)}x slower`);
  console.log(`    → Batching helps: ${(asyncGenTime / batchedGenTime).toFixed(1)}x faster\n`);
  
  // =========================================================================
  // BOTTLENECK 2: Push streams per-chunk overhead
  // =========================================================================
  console.log('▶ BOTTLENECK 2: Push Stream Per-Write Overhead\n');
  
  const pushPerChunk = await measure('  push() per-chunk write', iterations, async () => {
    const { writer, readable } = Stream.push<Uint8Array>();
    let total = 0;
    const readPromise = (async () => {
      for await (const batch of readable) {
        for (const chunk of batch) total += chunk.length;
      }
    })();
    for (const chunk of chunks) {
      await writer.write(chunk);
    }
    await writer.end();
    await readPromise;
  });
  
  const pushWritev = await measure('  push() writev (100 chunks/batch)', iterations, async () => {
    const { writer, readable } = Stream.push<Uint8Array>();
    let total = 0;
    const readPromise = (async () => {
      for await (const batch of readable) {
        for (const chunk of batch) total += chunk.length;
      }
    })();
    for (let i = 0; i < chunks.length; i += 100) {
      await writer.writev(chunks.slice(i, i + 100));
    }
    await writer.end();
    await readPromise;
  });
  
  // Test: writeSync
  const pushWriteSync = await measure('  push() writeSync (sync writes)', iterations, async () => {
    const { writer, readable } = Stream.push<Uint8Array>({ highWaterMark: Infinity });
    const readPromise = (async () => {
      let total = 0;
      for await (const batch of readable) {
        for (const chunk of batch) total += chunk.length;
      }
    })();
    for (const chunk of chunks) {
      writer.writeSync(chunk);
    }
    await writer.end();
    await readPromise;
  });
  
  console.log(`\n  Analysis:`);
  console.log(`    per-chunk vs writev: ${(pushPerChunk / pushWritev).toFixed(1)}x slower`);
  console.log(`    writeSync vs write:  ${(pushPerChunk / pushWriteSync).toFixed(1)}x slower`);
  console.log(`    → writeSync with high watermark is fastest\n`);
  
  // =========================================================================
  // BOTTLENECK 3: Share overhead
  // =========================================================================
  console.log('▶ BOTTLENECK 3: Share Overhead\n');
  
  const directIter = await measure('  Direct iteration (baseline)', iterations, async () => {
    for await (const batch of Stream.from(chunks)) {
      for (const chunk of batch) chunk.length;
    }
  });
  
  const shareOnce = await measure('  share().pull() single consumer', iterations, async () => {
    const shared = Stream.share(Stream.from(chunks));
    for await (const batch of shared.pull()) {
      for (const chunk of batch) chunk.length;
    }
  });
  
  console.log(`\n  Analysis:`);
  console.log(`    share() overhead: ${(shareOnce / directIter).toFixed(1)}x slower\n`);
  
  // =========================================================================
  // BOTTLENECK 4: pipeTo overhead
  // =========================================================================
  console.log('▶ BOTTLENECK 4: pipeTo Overhead\n');
  
  const manualWrite = await measure('  Manual iteration + write', iterations, async () => {
    let total = 0;
    for await (const batch of Stream.from(chunks)) {
      for (const chunk of batch) total += chunk.length;
    }
  });
  
  const pipeToAsync = await measure('  pipeTo() async', iterations, async () => {
    let total = 0;
    await Stream.pipeTo(Stream.from(chunks), {
      write(chunk) { total += chunk.length; },
      end() {},
      fail() {},
    });
  });
  
  const pipeToSync = await measure('  pipeToSync()', iterations, () => {
    let total = 0;
    Stream.pipeToSync(Stream.fromSync(chunks), {
      write(chunk) { total += chunk.length; },
      end() {},
      fail() {},
    });
  });
  
  console.log(`\n  Analysis:`);
  console.log(`    pipeTo() overhead vs manual: ${(pipeToAsync / manualWrite).toFixed(1)}x`);
  console.log(`    pipeToSync() vs pipeTo(): ${(pipeToAsync / pipeToSync).toFixed(1)}x slower\n`);
}

main().catch(console.error);
