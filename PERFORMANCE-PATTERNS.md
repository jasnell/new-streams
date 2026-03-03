# Performance Guide

How to get the best performance from the new streams API, organized by role.

---

## For Everyone

### Use built-in consumers when collecting data

`bytes()`, `text()`, `array()`, and `pipeTo()` handle batched iteration
internally. They are the fastest and simplest way to consume a stream.

```ts
// Collect all data
const data = await Stream.bytes(readable);
const content = await Stream.text(readable);

// Pipe through transforms to a destination
await Stream.pipeTo(source, transform, writer);
```

`pipeTo` is heavily optimized — it passes entire batches to the writer via
`writevSync`, avoiding per-chunk dispatch and Promise allocation.

| Pattern | Throughput |
|---|---|
| `pipeTo` (new streams) | 36.4 GB/s |
| `pipeTo` (web streams) | 4.19 GB/s |

### Manual iteration uses a double loop

Readables yield `Uint8Array[]` batches, not individual chunks. The outer loop
is async (one promise resolution per batch); the inner loop is pure synchronous
array iteration. This amortization is the primary source of the API's
performance advantage.

```ts
for await (const batch of readable) {
  for (const chunk of batch) {
    process(chunk);
  }
}
```

| Scenario | New Streams | Web Streams | Speedup |
|---|---|---|---|
| Async iteration (8KB x 1000) | 312 GB/s | 25 GB/s | 12x |
| Tiny chunks (100B x 10000) | 1.73 GB/s | 329 MB/s | 5x |
| Chained 3x transforms (8KB x 500) | 126 GB/s | 1.92 GB/s | 66x |

### Use sync APIs when data is available synchronously

When the source data is already in memory (arrays, buffers, strings), the
`Sync` variants eliminate all Promise and microtask overhead.

```ts
const result = Stream.bytesSync(
  Stream.pullSync(Stream.fromSync(data), transform)
);
```

The API shape is identical to the async version — same composition, just with
`Sync` appended.

| Scenario | pullSync | pull (async) | Web Streams |
|---|---|---|---|
| Small chunks (256B x 10000) | 14.1 GB/s | 9.2 GB/s | 175 MB/s |
| Tiny chunks (64B x 20000) | 8.4 GB/s | 4.6 GB/s | 220 MB/s |
| 3 transforms (4KB x 500) | 382 MB/s | 369 MB/s | 296 MB/s |

For compute-bound transforms the sync/async difference is small because the
transform dominates. The sync advantage is largest with small or many chunks
where per-yield overhead is proportionally significant.

### Collect vs iterate: choose based on data volume

`Stream.bytes()` collects the entire stream into one `Uint8Array`. For large
volumes this means holding everything in memory.

| Pattern | Peak Heap (100MB pull + transform) |
|---|---|
| Manual iteration (count bytes) | 2.4 MB |
| `Stream.bytes()` | ~100 MB |

Use `bytes()` / `text()` for bounded data (HTTP responses, small files). Use
manual iteration or `pipeTo` for unbounded or large data.

### The defaults work — don't over-tune

The default `highWaterMark` is 4 for push streams and 16 for broadcast/share.
Performance is flat from HWM 4 onwards. The only value that hurts is HWM 1,
which is 1.7x slower and paradoxically uses more memory due to per-write
Promise churn.

| HWM | Time (push, 2000 x 4KB) | Peak Heap (100MB sustained) |
|---|---|---|
| 1 | 2.23 ms | 4.4 MB |
| 4 (default) | 1.35 ms | 1.7 MB |
| 16 | 1.34 ms | 1.7 MB |
| 256 | 1.33 ms | 1.7 MB |

### Choose backpressure policy based on semantics, not performance

The performance difference between policies is a natural consequence of their
semantics, not a tuning knob.

- **`strict`** (default) or **`block`**: Use when every chunk matters. Both
  apply proper backpressure. `block` waits for space instead of rejecting.
- **`drop-oldest`** or **`drop-newest`**: Use for lossy real-time scenarios
  (live metrics, video frames) where freshness matters more than completeness.

| Policy | Time (slow consumer, HWM 16) |
|---|---|
| strict | 13.3 ms |
| block | 13.4 ms |
| drop-oldest | 305 µs |
| drop-newest | 234 µs |

---

## For Transform Authors

### Prefer stateless functions over generators

A stateless transform receives a batch and returns a batch. No generator state
machine, no yield overhead.

```ts
const xor: Transform = (chunks) => {
  return chunks.map(c => {
    const out = new Uint8Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = c[i] ^ 0x42;
    return out;
  });
};
```

| Variant | Throughput |
|---|---|
| Stateless function | 951 MB/s |
| Stateful generator | 814 MB/s |

Use generators only when you need to buffer across calls (line splitting,
framing protocols, compression with flush).

### Handle the flush signal

Transforms receive `null` as the final call, signaling end-of-stream.
Stateful transforms must flush any buffered data here. Forgetting this
silently loses data.

```ts
function* linesSplit(chunks: Uint8Array[] | null) {
  // ... accumulate partial lines ...
  if (chunks === null) {
    // Flush remaining partial line
    if (buffer.length > 0) yield buffer;
    return;
  }
  // ... normal processing ...
}
```

Stateless transforms can ignore the flush signal by returning `undefined`,
`null`, or an empty array.

### Identity transforms are free — use them for conditional middleware

```ts
const identity: Transform = (chunks) => chunks;
```

| Scenario | Throughput |
|---|---|
| Identity (new streams) | 164 GB/s |
| Identity (web streams) | 4.7 GB/s |

This enables cheap conditional wrapping:

```ts
const maybeCompress = shouldCompress ? compressTransform : (c) => c;
const output = Stream.pull(source, validate, maybeCompress, encrypt);
```

Every pipeline stage in web streams adds measurable overhead. In new streams,
no-op stages cost effectively nothing because the batched array passes through
without per-chunk promise resolution.

### Return the batch type your consumers expect

Transforms receive `Uint8Array[]` and should return `Uint8Array[]`,
`Iterable<Uint8Array>`, or a single `Uint8Array`. Returning the same array
type as the input (`chunks.map(...)`) is the fastest path — no intermediate
normalization.

Returning a single `Uint8Array` (e.g., concatenating a batch) is valid but
collapses the batch into one chunk, reducing downstream batching benefit.

---

## For Writer / Sink Authors

### Implement sync methods for maximum `pipeTo` throughput

`pipeTo` tries `writevSync` first, then falls back to `writev`, then to
per-chunk `writeSync` / `write`. When the sync path succeeds, the entire
pipeline avoids Promise allocation for that batch.

```ts
const writer: Writer = {
  get desiredSize() { return Infinity; },

  // Sync fast paths — pipeTo uses these first
  writeSync(chunk) {
    destination.push(chunk);
    return true;
  },
  writevSync(chunks) {
    for (const c of chunks) destination.push(c);
    return true;
  },
  endSync() { return this.totalBytes; },
  failSync() { return true; },

  // Async fallbacks — used when sync returns false
  async write(chunk) { destination.push(chunk); },
  async writev(chunks) { for (const c of chunks) destination.push(c); },
  async end() { return this.totalBytes; },
  async fail() {},
};
```

| Writer variant | Time (pipeTo, 1000 x 4KB) | Heap/iter |
|---|---|---|
| Sync-capable writer | 3.67 ms | 345 KB |
| Web WritableStream | 11.79 ms | 7.49 MB |

### Opt out cleanly when sync isn't possible

If your destination is inherently async (network socket, database), return
`false` from sync methods. `pipeTo` falls back gracefully.

```ts
writeSync() { return false; },
writevSync() { return false; },
endSync() { return -1; },
failSync() { return false; },
```

There is no penalty for having sync methods that return `false` — `pipeTo`
checks the return value and falls back in the same tick.

### Prefer `writevSync` over `writeSync`

`pipeTo` sends entire batches through `writevSync`. If you only implement
`writeSync`, `pipeTo` must loop over the batch and call `writeSync` per chunk.
Implementing `writevSync` lets you handle the batch in one call.

---

## For Push Stream Producers

### `await write()` is fine for most cases

The async `write()` method internally uses a cached resolved promise when the
buffer has space, avoiding allocation in the common case.

```ts
const { writer, readable } = Stream.push();

for (const chunk of data) {
  await writer.write(chunk);
}
await writer.end();
```

### Use `writeSync` + `ondrain` for high-frequency sources

For event-driven sources where you want to avoid promise overhead entirely
(network sockets, file readers, hardware interfaces):

```ts
for (const chunk of data) {
  if (!writer.writeSync(chunk)) {
    const canWrite = await Stream.ondrain(writer);
    if (!canWrite) break;  // stream closed or errored
    writer.writeSync(chunk);
  }
}
await writer.end();
```

| Pattern | Time (1000 x 4KB) | Heap/iter |
|---|---|---|
| `writeSync` + `ondrain` | 614 µs | 350 KB |
| `await write()` | 950 µs | 912 KB |

The difference is 1.5x. In real-world code with I/O latency, this gap
narrows. Use the simpler `await write()` unless profiling shows it matters.

---

## For Source Providers

### `Stream.from()` handles batching automatically

`from()` accepts arrays, iterables, async iterables, strings, and buffers.
For `Uint8Array[]` inputs, it yields data in bounded sub-batches (128 chunks)
to keep peak memory proportional to batch size rather than total data volume.

```ts
// All of these work
const s1 = Stream.from([chunk1, chunk2, chunk3]);
const s2 = Stream.from(asyncGenerator());
const s3 = Stream.from("hello world");
```

### Async generators yield batches naturally

When writing a custom async source, each `yield` produces one batch. Yielding
arrays of chunks is more efficient than yielding individual chunks because
each `yield` incurs one async iteration step.

```ts
// Efficient: one yield per batch
async function* readFileChunks(path: string) {
  const handle = await open(path);
  while (true) {
    const batch = await readMultipleChunks(handle);
    if (batch.length === 0) break;
    yield batch;  // Uint8Array[] — one async step for many chunks
  }
}

// Less efficient: one yield per chunk
async function* readFileChunks(path: string) {
  const handle = await open(path);
  while (true) {
    const chunk = await readChunk(handle);
    if (!chunk) break;
    yield [chunk];  // one async step per chunk
  }
}
```

### Use `fromSync` when data is in memory

`fromSync` creates a sync iterable — no async overhead, compatible with
`pullSync`, `bytesSync`, and all sync consumers.

```ts
const source = Stream.fromSync(existingArray);
const result = Stream.bytesSync(Stream.pullSync(source, transform));
```

---

## For Multi-Consumer Scenarios

### `broadcast` and `share` perform identically — choose by source type

| Pattern | Throughput (2 consumers, 4KB x 500) |
|---|---|
| broadcast() | 1.92 GB/s |
| share() | 1.99 GB/s |
| Web tee() | 1.66 GB/s |

Both use a shared ring buffer internally and use 4.6x less memory than web
streams' `tee()` (2.4 MB vs 11.0 MB for sustained 100MB).

- **broadcast**: Push model. Use when you have an external producer (events,
  network) writing into the stream.
- **share**: Pull model. Use when consumers drive the data flow (files,
  generators).

---

## Quick Reference

| Goal | Pattern |
|---|---|
| Collect all bytes | `await Stream.bytes(readable)` |
| Collect as text | `await Stream.text(readable)` |
| Pipe to a sink | `await Stream.pipeTo(source, ...transforms, writer)` |
| Process chunks | `for await (const batch of readable) for (const c of batch) ...` |
| Sync pipeline | `Stream.bytesSync(Stream.pullSync(Stream.fromSync(data), xform))` |
| Simple transform | `(chunks) => chunks.map(c => transform(c))` |
| Write to push stream | `await writer.write(chunk)` |
| High-freq push | `writer.writeSync(chunk)` + `Stream.ondrain(writer)` |
| Branch a stream | `Stream.share(source)` / `Stream.broadcast(opts)` |
| Real-time lossy | `Stream.push({ backpressure: 'drop-newest' })` |
