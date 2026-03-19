# Usage Recommendations

Best practices and anti-patterns for the new Streams API.

## Table of Contents

- [Core Concepts](#core-concepts)
- [Performance Best Practices](#performance-best-practices)
- [Memory Management](#memory-management)
- [Anti-Patterns to Avoid](#anti-patterns-to-avoid)
- [SSR and High-Concurrency Patterns](#ssr-and-high-concurrency-patterns)
- [Error Handling](#error-handling)
- [Migration from Web Streams](#migration-from-web-streams)

---

## Core Concepts

### The Batching Model

The new Streams API yields `Uint8Array[]` batches instead of individual `Uint8Array` chunks. This design amortizes async overhead across multiple chunks.

```typescript
// Each iteration yields a BATCH of chunks
for await (const batch of stream) {
  for (const chunk of batch) {
    // Process individual chunk
  }
}
```

**Why batching matters**: In JavaScript, each `await` has small but measurable overhead (e.g. ~1-5 microseconds). With 1000 small chunks:
- Per-chunk async: 1000 awaits = 1-5ms overhead
- Batched (10 batches of 100): 10 awaits = 0.01-0.05ms overhead

In high-throughput scenarios, this difference is significant. Batching enables more efficient
pipelines by allowing data available now to be processed now rather than waiting for individual async ticks to complete.

### Sync vs Async

Use sync variants when your entire pipeline is synchronous:

```typescript
// Prefer sync when possible - no async overhead
// chunks must be a sync iterable (e.g. Uint8Array[])
for (const batch of Stream.fromSync(chunks)) {
  for (const chunk of batch) process(chunk);
}

// vs async - has per-iteration overhead
// chunks can be sync or async iterable
for await (const batch of Stream.from(chunks)) {
  for (const chunk of batch) process(chunk);
}
```

---

## Performance Best Practices

### 1. Provide Data as `Uint8Array[]` When Possible

The fastest path is providing pre-batched data:

```typescript
// Faster: Single batch of all chunks
const chunks: Uint8Array[] = [chunk1, chunk2, chunk3];
Stream.from(chunks);  // Yields as single batch

// Faster: Yelding multiple batches
function* batchedGen() {
  yield [chunk1, chunk2];  // First batch
  yield [chunk3];          // Second batch
}

// Slower: Generator yielding individual chunks
function* gen() {
  yield chunk1;
  yield chunk2;
  yield chunk3;
}
Stream.from(gen());  // Must normalize each individual chunk
```

**Performance difference**: Array input is ~5-10x faster than per-chunk generators.

### 2. Batch Generator Yields

If you must use generators, yield batches:

```typescript
// Anti-pattern: Yielding individual chunks
async function* slow() {
  for (const chunk of chunks) {
    yield chunk;  // Each yield = async overhead
  }
}

// Better: Yield batches
async function* fast() {
  const batchSize = 100;
  for (let i = 0; i < chunks.length; i += batchSize) {
    yield chunks.slice(i, i + batchSize);
  }
}

// Best: Yield all at once if possible.. but keep in mind that large
// batches defeat the purpose of streaming.
async function* fastest() {
  yield chunks;  // Single yield, single await
}
```

### 3. Use `writeSync`/`writevSync` for Push Streams

When writing to push streams without backpressure concerns, and you know the
destination is capable of handling the data immediately, use sync writes:

```typescript
const { writer, readable } = Stream.push({ highWaterMark: Infinity });

// Slower: Awaiting each write
for (const chunk of chunks) {
  await writer.write(chunk);  // 1000 awaits
}

// Faster: Sync writes
for (const chunk of chunks) {
  writer.writeSync(chunk);  // No awaits
}

// Fastest: Batch write
writer.writevSync(chunks);  // Single call
```

**Performance difference**: `writevSync` is ~10x faster than per-chunk `await write()`.

If backpressure is a concern, use async writes as needed. The `*Sync` methods return
`false` if the destination is not capable of accepting/processing the data immediately:

```
if (!writer.writeSync(chunk)) {
  await writer.write(chunk);
}
```

### 4. Choose the Right Transform Style

Transform performance varies by style:

```typescript
// Faster: Sync function returning batch
const transform = (batch: Uint8Array[] | null) => batch;

// Faster: Object with sync transform method
const transform = { transform: (batch) => batch };

// Faster: Generator yielding batches (optimized in v2)
const transform = function*(batch) { if (batch) yield batch; };

// Slower: Async function (adds await overhead)
const transform = async (batch) => batch;
```

### 5. Prefer `pullSync`/`pipeToSync` for Sync Pipelines

There are `*Sync` variants of many core methods allowing to produce fully
synchronous pipelines without any async overhead when all components are sync:

```typescript
// If everything is sync, use sync variants
const result = Stream.bytesSync(
  Stream.pullSync(
    Stream.fromSync(data),
    syncTransform1,
    syncTransform2
  )
);

// Async variants add overhead even for sync operations
const result = await Stream.bytes(
  Stream.pull(
    Stream.from(data),  // Wraps in async
    transform1,
    transform2
  )
);
```

---

## Memory Management

### 1. Clean Up `share()` Consumers

When using `share()`, unconsumed consumers hold buffer references:

```typescript
const shared = Stream.share(source);

const consumer1 = shared.pull();
const consumer2 = shared.pull();  // Created but never used

// consumer1 reads everything
for await (const batch of consumer1) {
  process(batch);
}

// Problem: Buffer may still hold data for consumer2
// Solution: Cancel when done
shared.cancel();
```

Buffering overhead is unavoidable with multiple consumers. Unconsumed branches
retain references to all data read so far, leading to memory leaks.

**Best practice**: Always call `cancel()` when abandoning a share, or use `using` syntax:

```typescript
{
  using shared = Stream.share(source);
  for await (const batch of shared.pull()) {
    process(batch);
  }
}  // Automatically cancelled via Symbol.dispose
```

### 2. Use Buffer Limits for Unbalanced Consumers

When consumers read at different speeds:

```typescript
// Risk: Slow consumer causes unbounded buffering
const shared = Stream.share(source);  // Default: no limit

// Safe: Limit buffer with policy
const shared = Stream.share(source, {
  highWaterMark: 10,
  backpressure: 'drop-oldest'  // or 'drop-newest', 'strict', 'block'
});
```

**Policies**:
- `strict`: Rejects writes immediately when buffer full (default)
- `block`: Async writes wait for space; sync writes return false
- `drop-oldest`: Drops oldest buffered items when limit reached
- `drop-newest`: Stops buffering new items when limit reached

### 3. Avoid Holding References to Consumed Data

```typescript
// Anti-pattern: Accumulating all chunks
const allChunks: Uint8Array[] = [];
for await (const batch of stream) {
  allChunks.push(...batch);  // Memory grows unbounded
}

// Better: Process and discard
for await (const batch of stream) {
  for (const chunk of batch) {
    processAndForget(chunk);
  }
}

// If you need all data, use bytes() with a limit
const data = await Stream.bytes(stream, { limit: 10 * 1024 * 1024 });
```

### 4. Use `limit` Option to Prevent Memory Exhaustion

```typescript
// Protect against malicious/buggy sources
const data = await Stream.bytes(stream, {
  limit: 50 * 1024 * 1024  // 50MB max
});

const text = await Stream.text(stream, {
  limit: 10 * 1024 * 1024  // 10MB max
});
```

---

## Anti-Patterns to Avoid

### 1. Don't Yield Individual Chunks from Async Generators

```typescript
// Anti-pattern: 14x slower than batched
async function* fetchChunks() {
  const response = await fetch(url);
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield value;  // Individual chunk per yield
  }
}

// Better: Batch chunks
async function* fetchChunks() {
  const response = await fetch(url);
  const reader = response.body.getReader();
  const batch: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    batch.push(value);
    if (batch.length >= 100) {
      yield batch.splice(0);  // Yield batch, reset
    }
  }
  if (batch.length > 0) yield batch;
}
```

### 2. Don't Create Streams in Hot Loops Without Consuming

```typescript
// Anti-pattern: Stream objects accumulate
const streams = [];
for (let i = 0; i < 10000; i++) {
  streams.push(Stream.from(getData()));  // Never consumed
}

// Better: Consume immediately
for (let i = 0; i < 10000; i++) {
  for await (const batch of Stream.from(getData())) {
    process(batch);
  }
}
```

### 3. Don't Mix Sync and Async Unnecessarily

```typescript
// Anti-pattern: Async wrapper around sync data
const syncData = [chunk1, chunk2, chunk3];
for await (const batch of Stream.from(syncData)) {  // Unnecessary async
  process(batch);
}

// Better: Use sync variant
for (const batch of Stream.fromSync(syncData)) {
  process(batch);
}
```

### 4. Don't Forget to Handle the Flush Signal in Stateful Transforms

```typescript
// Anti-pattern: Ignoring null (flush) signal
const bufferingTransform = {
  buffer: [] as Uint8Array[],
  transform(batch: Uint8Array[] | null) {
    if (!batch) return null;  // Loses buffered data!
    this.buffer.push(...batch);
    if (this.buffer.length >= 10) {
      return this.buffer.splice(0, 10);
    }
    return null;
  }
};

// Correct: Flush remaining data
const bufferingTransform = {
  buffer: [] as Uint8Array[],
  transform(batch: Uint8Array[] | null) {
    if (batch === null) {
      // Flush signal - return remaining buffered data
      return this.buffer.length > 0 ? this.buffer.splice(0) : null;
    }
    this.buffer.push(...batch);
    if (this.buffer.length >= 10) {
      return this.buffer.splice(0, 10);
    }
    return null;
  }
};
```

### 5. Don't Use `bytes()` for Large Streams

```typescript
// Anti-pattern: Loading entire stream into memory. Incurs many allocations
// and copies and may cause OOM for large files.
const hugeFile = await Stream.bytes(fileStream);

// Better: Process in chunks
for await (const batch of fileStream) {
  for (const chunk of batch) {
    await writeToDestination(chunk);
  }
}

// Or use pipeTo
await Stream.pipeTo(fileStream, destinationWriter);
```

---

## SSR and High-Concurrency Patterns

### 1. Reuse Transform Instances When Stateless

```typescript
// Anti-pattern: Creating transforms per request
async function handleRequest() {
  const transform = (b: Uint8Array[] | null) => b;  // New function each time
  return Stream.pull(source, transform);
}

// Better: Reuse stateless transforms
const identityTransform = (b: Uint8Array[] | null) => b;

async function handleRequest() {
  return Stream.pull(source, identityTransform);
}
```

### 2. Use Sync Paths for CPU-Bound SSR

```typescript
// For synchronous template rendering
function renderTemplate(data: string): Uint8Array[] {
  const html = template(data);
  return [encoder.encode(html)];
}

// Use sync pipeline - no async overhead
function handleSSR(data: string) {
  return Stream.fromSync(renderTemplate(data));
}
```

### 3. Limit Concurrent Streams

```typescript
// Anti-pattern: Unbounded concurrency
const promises = urls.map(url =>
  Stream.bytes(fetchStream(url))
);
await Promise.all(promises);  // All run simultaneously

// Better: Limit concurrency
import pLimit from 'p-limit';
const limit = pLimit(10);  // Max 10 concurrent

const promises = urls.map(url =>
  limit(() => Stream.bytes(fetchStream(url)))
);
await Promise.all(promises);
```

### 4. Stream Responses Instead of Buffering

```typescript
// Anti-pattern: Buffer entire response
async function handler(req, res) {
  const data = await Stream.bytes(generateContent());
  res.send(data);  // Waits for all content
}

// Better: Stream the response
async function handler(req, res) {
  const content = generateContent();
  await Stream.pipeTo(content, {
    write(chunk) { res.write(chunk); },
    end() { res.end(); },
    fail(err) { res.destroy(err); }
  });
}
```

---

## Error Handling

### 1. Errors Propagate Through Pipelines

```typescript
// Errors in transforms propagate to consumer
try {
  for await (const batch of Stream.pull(source, riskyTransform)) {
    process(batch);
  }
} catch (error) {
  // Catches errors from source OR transform
  console.error('Pipeline failed:', error);
}
```

### 2. Use Abort Signals for Cancellation

```typescript
const controller = new AbortController();

// Set timeout
setTimeout(() => controller.abort(), 5000);

try {
  await Stream.pipeTo(source, writer, {
    signal: controller.signal
  });
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Operation timed out');
  } else {
    throw error;
  }
}
```

### 3. Clean Up Resources in Transform Abort Handlers

```typescript
const transformWithCleanup = {
  resource: null as Resource | null,

  async *transform(source: AsyncIterable<Uint8Array[] | null>,
                   { signal }: TransformCallbackOptions) {
    this.resource = acquireResource();
    signal.addEventListener('abort', () => {
      // Clean up on cancellation/error
      if (this.resource) {
        this.resource.release();
        this.resource = null;
      }
    });
    try {
      for await (const batch of source) {
        yield processWithResource(batch, this.resource);
      }
    } finally {
      if (this.resource) {
        this.resource.release();
        this.resource = null;
      }
    }
  }
};
```

---

## Migration from Web Streams

### Key Differences

| Web Streams | New Streams |
|-------------|-------------|
| `ReadableStream` | `Stream.from()` / `Stream.push()` |
| `TransformStream` | Transform functions in `Stream.pull()` |
| `WritableStream` | Writer objects in `Stream.pipeTo()` |
| `pipeThrough()` | `Stream.pull(source, ...transforms)` |
| `pipeTo()` | `Stream.pipeTo(source, writer)` |
| `tee()` | `Stream.share()` |
| Single chunks | Batched chunks (`Uint8Array[]`) |

### Migration Example

```typescript
// Web Streams
const readable = new ReadableStream({
  start(controller) {
    controller.enqueue(chunk1);
    controller.enqueue(chunk2);
    controller.close();
  }
});

const transform = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(processChunk(chunk));
  }
});

const result = await readable
  .pipeThrough(transform)
  .pipeTo(writable);

// New Streams
const readable = Stream.from([chunk1, chunk2]);

const transform = (batch: Uint8Array[] | null) => {
  if (!batch) return null;
  return batch.map(chunk => processChunk(chunk));
};

await Stream.pipeTo(
  Stream.pull(readable, transform),
  writer
);
```

### Adapting Existing Code

```typescript
// Wrap Web Streams ReadableStream
async function* fromWebStream(webStream: ReadableStream<Uint8Array>) {
  const reader = webStream.getReader();
  const batch: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      batch.push(value);
      // Yield in batches for better performance
      if (batch.length >= 100) {
        yield batch.splice(0);
      }
    }
    if (batch.length > 0) yield batch;
  } finally {
    reader.releaseLock();
  }
}

const newStream = Stream.from(fromWebStream(webReadableStream));
```

---

## Quick Reference

### Do

- Provide data as `Uint8Array[]` arrays when possible
- Use sync variants (`fromSync`, `pullSync`, `pipeToSync`) for sync pipelines
- Batch yields in generators (100+ items per yield)
- Use `writevSync` for bulk writes to push streams
- Set `highWaterMark` on `share()` with unbalanced consumers
- Use `limit` option with `bytes()`/`text()` for untrusted sources
- Call `cancel()` on abandoned `share()` instances

### Don't

- Yield individual chunks from async generators
- Use async variants for purely synchronous data
- Buffer entire streams with `bytes()` for large data
- Create `share()` consumers you don't intend to use
- Ignore the flush signal (`null`) in stateful transforms
- Hold references to processed chunks unnecessarily
