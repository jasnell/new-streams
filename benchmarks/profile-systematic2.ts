/**
 * Systematic profiling - fixed version
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
  console.log(`${name.padEnd(40)} ${perIter.toFixed(2).padStart(8)}ms  ${(throughput / 1e9).toFixed(2).padStart(8)} GB/s`);
  return perIter;
}

async function main() {
  const iterations = 50;
  
  console.log('=== Systematic Performance Profile ===');
  console.log(`Data: ${chunkCount} x ${chunkSize/1024}KB = ${totalBytes/1024/1024}MB`);
  console.log(`Iterations: ${iterations}\n`);
  
  console.log('--- KEY BOTTLENECKS TO INVESTIGATE ---\n');
  
  // 1. bytes() consumer - slow
  console.log('1. BYTES() CONSUMER');
  const rawConcat = await measure('  Just concat (no streaming)', iterations, () => {
    const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (result.length !== totalBytes) throw new Error('Wrong');
  });
  
  const bytesTime = await measure('  Stream.bytes(from(array))', iterations, async () => {
    const result = await Stream.bytes(Stream.from(chunks));
    if (result.length !== totalBytes) throw new Error('Wrong');
  });
  
  const bytesSyncTime = await measure('  Stream.bytesSync(fromSync(array))', iterations, () => {
    const result = Stream.bytesSync(Stream.fromSync(chunks));
    if (result.length !== totalBytes) throw new Error('Wrong');
  });
  
  console.log(`  → bytes() overhead vs raw concat: ${(bytesTime / rawConcat).toFixed(1)}x\n`);
  
  // 2. Generator source - slow
  console.log('2. GENERATOR SOURCES');
  async function* asyncGen() {
    for (const chunk of chunks) yield chunk;
  }
  const asyncGenTime = await measure('  Stream.from(async generator)', iterations, async () => {
    for await (const batch of Stream.from(asyncGen())) {
      for (const chunk of batch) chunk.length;
    }
  });
  
  function* syncGen() {
    for (const chunk of chunks) yield chunk;
  }
  const syncGenTime = await measure('  Stream.from(sync generator)', iterations, async () => {
    for await (const batch of Stream.from(syncGen())) {
      for (const chunk of batch) chunk.length;
    }
  });
  
  const arrayTime = await measure('  Stream.from(array) - baseline', iterations, async () => {
    for await (const batch of Stream.from(chunks)) {
      for (const chunk of batch) chunk.length;
    }
  });
  
  console.log(`  → async gen overhead vs array: ${(asyncGenTime / arrayTime).toFixed(1)}x`);
  console.log(`  → sync gen overhead vs array: ${(syncGenTime / arrayTime).toFixed(1)}x\n`);
  
  // 3. Push streams - slow for small writes
  console.log('3. PUSH STREAMS');
  const pushInterleaved = await measure('  push() per-chunk writes', iterations, async () => {
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
    if (total !== totalBytes) throw new Error('Wrong');
  });
  
  const pushBatch = await measure('  push() writev (batches of 100)', iterations, async () => {
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
    if (total !== totalBytes) throw new Error('Wrong');
  });
  
  console.log(`  → per-chunk vs batch: ${(pushInterleaved / pushBatch).toFixed(1)}x slower\n`);
  
  // 4. Share/broadcast
  console.log('4. SHARE');
  await measure('  share() single consumer', iterations, async () => {
    const shared = Stream.share(Stream.from(chunks));
    const consumer = shared.consume();
    let total = 0;
    for await (const batch of consumer) {
      for (const chunk of batch) total += chunk.length;
    }
    if (total !== totalBytes) throw new Error('Wrong');
  });
  
  // 5. pipeTo
  console.log('\n5. WRITE TO');
  await measure('  pipeTo() counting sink', iterations, async () => {
    let total = 0;
    await Stream.pipeTo(Stream.from(chunks), {
      write(chunk) { total += chunk.length; },
      end() {},
      fail() {},
    });
    if (total !== totalBytes) throw new Error('Wrong');
  });
  
  await measure('  pipeToSync() counting sink', iterations, () => {
    let total = 0;
    Stream.pipeToSync(Stream.fromSync(chunks), {
      write(chunk) { total += chunk.length; },
      end() {},
      fail() {},
    });
    if (total !== totalBytes) throw new Error('Wrong');
  });
}

main().catch(console.error);
