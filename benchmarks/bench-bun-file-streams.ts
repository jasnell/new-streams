// Compare Bun's Web Streams vs New Streams reference implementation
// for file I/O through two transform stages: uppercase + gzip compression.
//
// Run with:
//   bun run benchmarks/bench-bun-file-streams.ts
//
// Bun's Bun.file().stream() returns an optimized ReadableStream backed by
// native Zig I/O. For compression, Bun provides Bun.gzipSync() (native Zig
// zlib) but does NOT have CompressionStream as a global. We use node:zlib
// createGzip() for the streaming paths and Bun.gzipSync() for the non-
// streaming ceiling.

import { pull } from '../src/index.ts';
import type { TransformCallbackOptions } from '../src/types.ts';
import { createGzip, type Gzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const FILE_SIZES = [1 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024];
const ITERATIONS = 5;
const WARMUP = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const filename = join(tmpdir(), `bench-bun-streams-${process.pid}`);

function createFixture(size: number): void {
  const chunk = new Uint8Array(Math.min(size, 64 * 1024));
  for (let i = 0; i < chunk.length; i++) {
    chunk[i] = 0x61 + (i % 26); // a-z
  }
  // Build the full buffer (Bun's writeFileSync is fast)
  const buf = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const n = Math.min(size - offset, chunk.length);
    buf.set(n < chunk.length ? chunk.subarray(0, n) : chunk, offset);
    offset += n;
  }
  writeFileSync(filename, buf);
}

function cleanup(): void {
  try { unlinkSync(filename); } catch { /* ignore */ }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function formatRate(bytes: number, ms: number): string {
  const mbps = (bytes / (1024 * 1024)) / (ms / 1000);
  if (mbps >= 1024) return `${(mbps / 1024).toFixed(1)} GB/s`;
  return `${mbps.toFixed(1)} MB/s`;
}

// ---------------------------------------------------------------------------
// Uppercase transform (shared logic)
// ---------------------------------------------------------------------------
function uppercaseByte(b: number): number {
  return (b >= 0x61 && b <= 0x7a) ? b - 0x20 : b;
}

// ---------------------------------------------------------------------------
// Path 1: Bun Web Streams (Bun.file().stream() + node:zlib in TransformStream)
// ---------------------------------------------------------------------------

function createGzipTransformStream(): TransformStream<Uint8Array, Uint8Array> {
  // Wrap node:zlib createGzip() in a Web Streams TransformStream.
  // This is the best available streaming gzip for Bun since it lacks
  // CompressionStream.
  const gz: Gzip = createGzip();
  const chunks: Uint8Array[] = [];
  let resolveRead: (() => void) | null = null;

  gz.on('data', (chunk: Buffer) => {
    chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (resolveRead) {
      const r = resolveRead;
      resolveRead = null;
      r();
    }
  });

  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const written = gz.write(chunk);
      if (!written) {
        await new Promise<void>(resolve => gz.once('drain', resolve));
      }
      // Flush any data that zlib has produced
      if (chunks.length > 0) {
        for (const c of chunks) controller.enqueue(c);
        chunks.length = 0;
      }
    },
    async flush(controller) {
      await new Promise<void>((resolve, reject) => {
        gz.end(() => {
          // Drain remaining
          if (chunks.length > 0) {
            for (const c of chunks) controller.enqueue(c);
            chunks.length = 0;
          }
          resolve();
        });
        gz.on('error', reject);
      });
      // Final drain after end event
      if (chunks.length > 0) {
        for (const c of chunks) controller.enqueue(c);
        chunks.length = 0;
      }
    },
  });
}

async function runWebStream(): Promise<number> {
  // Bun.file().stream() returns a native Zig-backed ReadableStream
  const rs = Bun.file(filename).stream();

  const upper = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const buf = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        buf[i] = uppercaseByte(chunk[i]);
      }
      controller.enqueue(buf);
    },
  });

  const compress = createGzipTransformStream();
  const output = rs.pipeThrough(upper).pipeThrough(compress);
  const reader = output.getReader();

  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
  }
  return totalBytes;
}

// ---------------------------------------------------------------------------
// Path 2: New Streams (reference impl) with node:zlib stateful transform
//
// Uses node:zlib createGzip() wrapped as a New Streams TransformObject —
// same compression engine as the Web Streams path, different pipeline.
// ---------------------------------------------------------------------------

function compressGzip() {
  return {
    async *transform(
      source: AsyncIterable<Uint8Array[] | null>,
      options: TransformCallbackOptions,
    ) {
      const gz: Gzip = createGzip();
      const pending: Uint8Array[] = [];

      gz.on('data', (chunk: Buffer) => {
        pending.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });

      function drainPending(): Uint8Array[] {
        const batch = pending.slice();
        pending.length = 0;
        return batch;
      }

      try {
        for await (const chunks of source) {
          if (options.signal.aborted) break;

          if (chunks === null) {
            // Flush: finalize the compressor
            await new Promise<void>((resolve, reject) => {
              gz.end(() => resolve());
              gz.on('error', reject);
            });
            if (pending.length > 0) yield drainPending();
            return;
          }

          // Feed chunks to compressor
          for (const chunk of chunks) {
            const ok = gz.write(chunk);
            if (!ok) {
              await new Promise<void>(resolve => gz.once('drain', resolve));
            }
          }

          // Yield any compressed output
          if (pending.length > 0) yield drainPending();
        }

        // Source ended — finalize
        if (!options.signal.aborted) {
          await new Promise<void>((resolve, reject) => {
            gz.end(() => resolve());
            gz.on('error', reject);
          });
          if (pending.length > 0) yield drainPending();
        }
      } finally {
        gz.destroy();
      }
    },
  };
}

async function runNewStreams(): Promise<number> {
  // Async generator source: use Bun.file().stream() as an async iterable,
  // identical source to the Web Streams path — the only difference is
  // pipeline machinery.
  async function* fileSource(): AsyncGenerator<Uint8Array[]> {
    for await (const chunk of Bun.file(filename).stream()) {
      yield [chunk];
    }
  }

  // Stateless uppercase transform
  const upper = (chunks: Uint8Array[] | null) => {
    if (chunks === null) return null;
    const out = new Array<Uint8Array>(chunks.length);
    for (let j = 0; j < chunks.length; j++) {
      const src = chunks[j];
      const buf = new Uint8Array(src.length);
      for (let i = 0; i < src.length; i++) {
        buf[i] = uppercaseByte(src[i]);
      }
      out[j] = buf;
    }
    return out;
  };

  const readable = pull(fileSource(), upper, compressGzip());

  let totalBytes = 0;
  for await (const chunks of readable) {
    for (const chunk of chunks) {
      totalBytes += chunk.byteLength;
    }
  }
  return totalBytes;
}

// ---------------------------------------------------------------------------
// Path 3: Bun native ceiling (Bun.file().bytes() + bulk + Bun.gzipSync())
//
// The absolute fastest path: read entire file into memory, transform in
// bulk, compress synchronously with Bun's native Zig gzip. No streaming
// overhead at all. This represents the performance ceiling.
// ---------------------------------------------------------------------------
async function runNonStreaming(): Promise<number> {
  const data = await Bun.file(filename).bytes();

  // Uppercase in bulk
  const upper = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    upper[i] = uppercaseByte(data[i]);
  }

  // Native Zig gzip — synchronous, no streaming overhead
  const compressed = Bun.gzipSync(upper);
  return compressed.byteLength;
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------
type BenchFn = () => Promise<number>;

async function bench(name: string, fn: BenchFn, n: number): Promise<{ avgMs: number; totalBytes: number }> {
  // Warmup
  for (let i = 0; i < WARMUP; i++) await fn();

  const start = performance.now();
  let totalBytes = 0;
  for (let i = 0; i < n; i++) {
    totalBytes += await fn();
  }
  const elapsed = performance.now() - start;
  return { avgMs: elapsed / n, totalBytes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Bun File Stream Benchmark');
console.log(`  Runtime: Bun ${Bun.version}`);
console.log(`  Iterations: ${ITERATIONS} (warmup: ${WARMUP})`);
console.log('');

console.log('Scenario                       | Bun WebStream  | New Streams    | Bun Native     | NS vs WS');
console.log('-------------------------------+----------------+----------------+----------------+---------');

try {
  for (const size of FILE_SIZES) {
    createFixture(size);
    const label = `File ${formatSize(size)} → upper → gzip`;

    const ws = await bench('webstream', runWebStream, ITERATIONS);
    const ns = await bench('newstreams', runNewStreams, ITERATIONS);
    const bulk = await bench('native', runNonStreaming, ITERATIONS);

    const ratio = ws.avgMs / ns.avgMs;
    const ratioStr = ratio >= 1
      ? `${ratio.toFixed(1)}x faster`
      : `${(1 / ratio).toFixed(1)}x slower`;

    console.log(
      `${label.padEnd(31)}| ` +
      `${formatRate(size, ws.avgMs).padEnd(15)}| ` +
      `${formatRate(size, ns.avgMs).padEnd(15)}| ` +
      `${formatRate(size, bulk.avgMs).padEnd(15)}| ` +
      `${ratioStr}`
    );
  }
} finally {
  cleanup();
}

console.log('');
console.log('Notes:');
console.log('  - Both streaming paths read from the same Zig-backed Bun.file().stream() source');
console.log('  - Bun WebStream: native ReadableStream pipeline + node:zlib in TransformStream wrapper');
console.log('  - New Streams: reference TypeScript pipeline + node:zlib in stateful transform wrapper');
console.log('  - Bun lacks CompressionStream; both streaming paths use node:zlib for gzip');
console.log('  - The node:zlib wrappers are roughly equivalent in overhead for both paths');
console.log('  - Bun Native uses Bun.file().bytes() + bulk uppercase + Bun.gzipSync() (Zig)');
console.log('  - "NS vs WS" compares New Streams against Bun Web Streams');
