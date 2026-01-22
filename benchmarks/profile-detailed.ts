/**
 * Detailed timing breakdown
 */

import { Stream } from '../src/stream.js';

async function timeOperation<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  console.log(`${name}: ${elapsed.toFixed(2)}ms`);
  return result;
}

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

  console.log(`Setup: ${chunkCount} chunks of ${chunkSize} bytes = ${totalBytes} total\n`);

  // Test 1: Just async generator iteration (no stream)
  await timeOperation('Raw async generator (no stream)', async () => {
    async function* gen() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    let total = 0;
    for await (const chunk of gen()) {
      total += chunk.length;
    }
    return total;
  });

  // Test 2: Stream.pull with async generator, async iteration
  await timeOperation('Stream.pull + for await', async () => {
    const stream = Stream.pull(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.length;
    }
    return total;
  });

  // Test 3: Stream.pull with bytes()
  await timeOperation('Stream.pull + bytes()', async () => {
    const stream = Stream.pull(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    const result = await stream.bytes();
    return result.length;
  });

  // Test 4: Stream.pull with sync generator + bytes()
  await timeOperation('Stream.pull (sync gen) + bytes()', async () => {
    const stream = Stream.pull(function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    const result = await stream.bytes();
    return result.length;
  });

  // Test 5: Stream.from with pre-built data
  const allData = new Uint8Array(totalBytes);
  await timeOperation('Stream.from (prebuilt) + bytes()', async () => {
    const stream = Stream.from(allData);
    const result = await stream.bytes();
    return result.length;
  });

  // Test 6: Compare with Web Streams
  await timeOperation('Web ReadableStream + collect', async () => {
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
    const collected: Uint8Array[] = [];
    let totalLen = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      collected.push(value);
      totalLen += value.length;
    }
    
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of collected) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result.length;
  });

  console.log('\nRunning 20 iterations each for more stable numbers...\n');

  for (const [name, fn] of [
    ['Raw async gen', async () => {
      async function* gen() { for (const chunk of chunks) yield chunk; }
      let t = 0; for await (const c of gen()) t += c.length; return t;
    }],
    ['Stream (async gen)', async () => {
      const s = Stream.pull(async function* () { for (const c of chunks) yield c; });
      return (await s.bytes()).length;
    }],
    ['Stream (sync gen)', async () => {
      const s = Stream.pull(function* () { for (const c of chunks) yield c; });
      return (await s.bytes()).length;
    }],
    ['Web Stream', async () => {
      let i = 0;
      const s = new ReadableStream<Uint8Array>({
        pull(ctrl) { if (i < chunks.length) ctrl.enqueue(chunks[i++]); else ctrl.close(); }
      });
      const r = s.getReader(); const coll: Uint8Array[] = []; let tl = 0;
      while (true) { const { value, done } = await r.read(); if (done) break; coll.push(value); tl += value.length; }
      const res = new Uint8Array(tl); let off = 0;
      for (const c of coll) { res.set(c, off); off += c.length; }
      return res.length;
    }],
  ] as [string, () => Promise<number>][]) {
    const start = performance.now();
    for (let i = 0; i < 20; i++) await fn();
    const elapsed = (performance.now() - start) / 20;
    const throughput = totalBytes / (elapsed / 1000) / 1e9;
    console.log(`${name.padEnd(20)}: ${elapsed.toFixed(2)}ms (${throughput.toFixed(2)} GB/s)`);
  }
}

main().catch(console.error);
