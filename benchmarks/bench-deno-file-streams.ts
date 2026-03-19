// Compare Deno's native Web Streams vs New Streams reference implementation
// for file I/O through two transform stages: uppercase + gzip compression.
//
// Run with:
//   deno run --allow-read --allow-write --allow-env benchmarks/bench-deno-file-streams.ts
//
// Both paths use the same Rust-backed FsFile.readable as source, so the
// only difference is pipeline machinery. CompressionStream is natively
// implemented via Rust zlib; the New Streams path wraps it via an adapter
// (adding some Web Streams overhead inside the New Streams pipeline).

import { pull } from '../src/index.ts';
import type { TransformObject, TransformCallbackOptions } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const FILE_SIZES = [1 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024];
const ITERATIONS = 5;
const WARMUP = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const tmpDir = await Deno.makeTempDir();
const filename = `${tmpDir}/bench-deno-streams-${Deno.pid}`;

function createFixture(size: number): void {
  const chunk = new Uint8Array(Math.min(size, 64 * 1024));
  // Fill with repeating lowercase ASCII
  for (let i = 0; i < chunk.length; i++) {
    chunk[i] = 0x61 + (i % 26); // a-z
  }
  const file = Deno.openSync(filename, { write: true, create: true, truncate: true });
  let remaining = size;
  while (remaining > 0) {
    const toWrite = Math.min(remaining, chunk.length);
    file.writeSync(toWrite < chunk.length ? chunk.subarray(0, toWrite) : chunk);
    remaining -= toWrite;
  }
  file.close();
}

function cleanup(): void {
  try { Deno.removeSync(filename); } catch { /* ignore */ }
  try { Deno.removeSync(tmpDir); } catch { /* ignore */ }
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
// Path 1: Deno Web Streams (native Rust-backed ReadableStream)
// ---------------------------------------------------------------------------
async function runWebStream(): Promise<number> {
  const file = await Deno.open(filename, { read: true });
  try {
    // file.readable is a native Rust-backed ReadableStream
    const upper = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const buf = new Uint8Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          buf[i] = uppercaseByte(chunk[i]);
        }
        controller.enqueue(buf);
      },
    });

    const compress = new CompressionStream('gzip');
    const output = file.readable.pipeThrough(upper).pipeThrough(compress);
    const reader = output.getReader();

    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
    }
    return totalBytes;
  } catch (e) {
    file.close();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Path 2: New Streams (reference impl) with CompressionStream adapter
//
// Uses Deno's native CompressionStream (Rust zlib) wrapped as a New Streams
// stateful transform — same compression engine as the Web Streams path,
// different pipeline machinery.
// ---------------------------------------------------------------------------

function compressGzip(): TransformObject {
  return {
    async *transform(
      source: AsyncIterable<Uint8Array[] | null>,
      options: TransformCallbackOptions,
    ) {
      // Create a native CompressionStream and wire it up.
      // Use a two-task pattern: one async task feeds the compressor,
      // the generator reads compressed output as it becomes available.
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();

      // Background task: feed source chunks into the compressor
      const writeTask = (async () => {
        try {
          for await (const chunks of source) {
            if (options.signal.aborted) break;
            if (chunks === null) break; // flush signal
            for (const chunk of chunks) {
              await writer.write(chunk);
            }
          }
        } finally {
          try { await writer.close(); } catch { /* ignore if already closed */ }
        }
      })();

      // Read compressed output as it becomes available
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally {
        await writeTask; // Ensure the writer task completes
      }
    },
  };
}

async function runNewStreams(): Promise<number> {
  const file = await Deno.open(filename, { read: true });

  // Use file.readable (Rust-backed ReadableStream) as an async iterable,
  // identical source to the Web Streams path — the only difference is
  // pipeline machinery.
  async function* fileSource(): AsyncGenerator<Uint8Array[]> {
    for await (const chunk of file.readable) {
      yield [chunk];
    }
    // file.readable auto-closes the file when exhausted
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
// Path 3: Non-streaming ceiling (Deno.readFile + bulk transform + compress)
// ---------------------------------------------------------------------------
async function runNonStreaming(): Promise<number> {
  const data = await Deno.readFile(filename);

  // Uppercase in-place
  const upper = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    upper[i] = uppercaseByte(data[i]);
  }

  // One-shot compress via CompressionStream
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();

  // Write entire buffer and close
  writer.write(upper);
  writer.close();

  // Read all compressed output
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
  }
  return totalBytes;
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
console.log('Deno File Stream Benchmark');
console.log(`  Runtime: Deno ${Deno.version.deno} (V8 ${Deno.version.v8})`);
console.log(`  Iterations: ${ITERATIONS} (warmup: ${WARMUP})`);
console.log('');

console.log('Scenario                       | Deno WebStream | New Streams    | Non-streaming  | NS vs WS');
console.log('-------------------------------+----------------+----------------+----------------+---------');

try {
  for (const size of FILE_SIZES) {
    createFixture(size);
    const label = `File ${formatSize(size)} → upper → gzip`;

    const ws = await bench('webstream', runWebStream, ITERATIONS);
    const ns = await bench('newstreams', runNewStreams, ITERATIONS);
    const bulk = await bench('nonstreaming', runNonStreaming, ITERATIONS);

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
console.log('  - Both paths read from the same Rust-backed FsFile.readable source');
console.log('  - Deno WebStream: native ReadableStream pipeline + native CompressionStream');
console.log('  - New Streams: reference TypeScript pipeline + CompressionStream adapter');
console.log('  - DISCLOSURE: New Streams compression wraps CompressionStream via reader/writer,');
console.log('    adding Web Streams overhead inside the New Streams pipeline. This disadvantages');
console.log('    New Streams — a native zlib binding (as in the Node.js port) would be faster.');
console.log('  - Non-streaming reads entire file into memory, transforms in bulk');
console.log('  - "NS vs WS" compares New Streams against Deno Web Streams');
