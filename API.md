# New Streams API Reference

A bytes-only stream API based on iterables with explicit backpressure handling.

## Table of Contents

- [Overview](#overview)
- [Stream Namespace](#stream-namespace)
- [Push Stream](#push-stream)
- [Stream Factories](#stream-factories)
- [Pull Pipeline](#pull-pipeline)
- [Write To](#write-to)
- [Consumers](#consumers)
- [Utilities](#utilities)
- [Multi-Consumer](#multi-consumer)
- [Types](#types)
- [Protocol Symbols](#protocol-symbols)

---

## Overview

This API treats streams as iterables that yield batched chunks (`Uint8Array[]`). Key principles:

1. **Streams are iterables** - No custom Stream class, just async/sync iterables
2. **Batched chunks** - Iterables yield `Uint8Array[]` to amortize async overhead
3. **Explicit backpressure** - Strict by default, configurable policies
4. **Pull-through transforms** - Transforms execute only when consumer pulls
5. **Clean sync/async separation** - Separate interfaces, no ambiguity

### Basic Usage

```typescript
import { Stream } from 'new-streams';

// Create a push stream
const { writer, readable } = Stream.push();

// Write data. Backpressure is strictly enforced by default.
await writer.write("Hello, World!");
await writer.end();

// Consume as text
const text = await Stream.text(readable);
console.log(text); // "Hello, World!"
```

See [USAGE.md](USAGE.md) for more examples.

### Batched Iteration

All stream iterables yield `Uint8Array[]` (arrays of chunks):

```typescript
for await (const chunks of readable) {
  for (const chunk of chunks) {
    // Process individual chunk
    console.log(chunk.byteLength);
  }
}
```

This is true even for single-chunk sources yielding one chunk per batch.

---

## Stream Namespace

The `Stream` namespace provides unified access to all stream functions:

```typescript
import { Stream } from 'new-streams';

// Stream Creation
Stream.push()            // Create push stream with writer and transforms
Stream.duplex()          // Create connected pair of duplex channels
Stream.from()            // Create pull stream from source
Stream.fromSync()        // Create sync-only pull stream from source

// Pipelines & Transforms
Stream.pull()            // Pull pipeline with transforms
Stream.pullSync()        // Sync pull pipeline
Stream.pipeTo()          // Pipe to destination
Stream.pipeToSync()      // Sync pipe to destination

// Consumers (Terminal)
Stream.bytes()           // Collect as Uint8Array
Stream.text()            // Collect as string
Stream.arrayBuffer()     // Collect as ArrayBuffer
Stream.array()           // Collect as Uint8Array[]

// Sync Consumers (Terminal)
Stream.bytesSync()       // Sync collect as Uint8Array
Stream.textSync()        // Sync collect as string
Stream.arrayBufferSync() // Sync collect as ArrayBuffer
Stream.arraySync()       // Sync collect as Uint8Array[]

// Multi-Consumer
Stream.broadcast()       // Push-model multi-consumer
Stream.share()           // Pull-model multi-consumer
Stream.shareSync()       // Sync pull-model multi-consumer

// Utilities
Stream.merge()           // Merge multiple sources
Stream.tap()             // Observation transform
Stream.tapSync()         // Sync observation transform
Stream.ondrain()         // Wait for backpressure to clear
```

---

## Push Stream

### `Stream.push(...transforms?, options?)`

Creates a bonded writer and async iterable pair for push-based streaming. The
writer and readable are connected—data written to the writer flows to anyone
iterating the readable.

The `highWaterMark` controls the buffer size (slots) and, for `'strict'` mode,
also limits pending writes. With the default of 1 and `'strict'` backpressure,
properly awaited writes will wait for buffer space, while "fire-and-forget"
writes (not awaited) will throw when exceeding the pending limit.

[Transforms](#transform-types) are applied to data as it flows from writer to readable.
Specifically, transforms are only invoked when the consumer pulls data from the
iterable.

```typescript
function push(
  ...args: [...Transform[], PushStreamOptions?]
): { writer: Writer; readable: AsyncIterable<Uint8Array[]> }
```

Returns a [Writer](#writer-interface) and an async iterable readable.

**Options:**
- `highWaterMark?: number` - Max pending writes before backpressure (default: 1)
- `backpressure?:` [BackpressurePolicy](#backpressure-policy) - Policy when buffer full (default: 'strict')
- `signal?: AbortSignal` - Cancellation signal

**Example:**
```typescript
// Basic push stream
const { writer, readable } = Stream.push();

// With transforms
const { writer, readable } = Stream.push(compress, encrypt);

// With options
const { writer, readable } = Stream.push({
  highWaterMark: 10,
  backpressure: 'drop-oldest'
});

// Producer
await writer.write("chunk1");
await writer.write("chunk2");
await writer.end();

// Consumer
for await (const chunks of readable) {
  for (const chunk of chunks) {
    console.log(chunk);
  }
}
```

Note that like the rest of the API, transforms are pull-driven — no data flows
until the consumer iterates the readable.

The returned `readable` is an async iterable yielding `Uint8Array[]` batches.
There is no sync variant of `Stream.push()` since push streams are inherently
async as it is waiting for data to be written via the writer.

### Writer Interface

```typescript
interface WriteOptions {
  readonly signal?: AbortSignal;
}

interface Writer {
  readonly desiredSize: number | null;  // Slots available (>= 0 or null)

  write(chunk: Uint8Array | string, options?: WriteOptions): Promise<void>;
  writev(chunks: (Uint8Array | string)[], options?: WriteOptions): Promise<void>;
  end(options?: WriteOptions): Promise<number>;
  fail(reason?: Error): Promise<void>;

  // Synchronous variants return true if accepted, false if rejected.
  writeSync(chunk: Uint8Array | string): boolean;
  writevSync(chunks: (Uint8Array | string)[]): boolean;
  endSync(): number;
  failSync(reason?: Error): boolean;
}
```

**Method details:**

- `desiredSize`: Number of write slots available before backpressure. Returns
  `null` if the writer is closed or errored.

- `write(chunk)`: Write a single chunk. Resolves when the chunk is accepted
  (which may wait for buffer space with strict backpressure).

- `writev(chunks)`: Write multiple chunks atomically as a single batch. More
  efficient than multiple `write()` calls.

- `end()`: Signal end of data. Returns total bytes written. No more writes
  accepted after calling.

- `fail(reason)`: Put the writer into an error state. Notifies consumers of failure.

The `writeSync`/`writevSync`/`failSync`,`endSync` methods return a boolean
indicating if the action was accepted (`true`) or rejected (`false`). They are
intended for high-performance scenarios, used in conjunction with
`write`/`writev`/`end`/`fail` for mixed sync/async:

```js
// Attempt to write synchronously first
if (!writer.writeSync(chunk)) {
  // If that fails, fall back to async write
  await writer.write(chunk);
}
```

`Writer` is an interface not a concrete class; any object implementing this
interface can be used as a writer.

---

## Duplex Channels

### `Stream.duplex(options?)`

Create a pair of connected duplex channels for bidirectional communication.
Similar to Unix `socketpair()` - creates two endpoints where data written to
one endpoint's writer appears in the other endpoint's readable.

```typescript
function duplex(options?: DuplexOptions): [DuplexChannel, DuplexChannel]
```

**Options:**
- `highWaterMark?: number` - Buffer size for both directions (default: 1)
- `backpressure?:` [BackpressurePolicy](#backpressure-policy) - Policy for both directions (default: 'strict')
- `a?: DuplexDirectionOptions` - Options specific to the A→B direction (overrides shared options)
- `b?: DuplexDirectionOptions` - Options specific to the B→A direction (overrides shared options)
- `signal?: AbortSignal` - Cancellation signal for both channels

**DuplexDirectionOptions:**
- `highWaterMark?: number` - Buffer size for this direction
- `backpressure?:` [BackpressurePolicy](#backpressure-policy) - Policy for this direction

**DuplexChannel Interface:**
```typescript
interface DuplexChannel extends WriterIterablePair, AsyncDisposable {
  readonly writer: Writer;                    // Write to the remote peer
  readonly readable: AsyncIterable<Uint8Array[]>;  // Read from the remote peer
  close(): Promise<void>;                     // Close this end (idempotent)
  [Symbol.asyncDispose](): Promise<void>;     // Async dispose support
}
```

**Example: Echo server**
```typescript
const [client, server] = Stream.duplex();

// Server echoes back what it receives
(async () => {
  await using srv = server;
  for await (const chunks of srv.readable) {
    await srv.writer.writev(chunks);
  }
})();

// Client sends and receives
{
  await using conn = client;
  await conn.writer.write('Hello');
  for await (const chunks of conn.readable) {
    console.log(new TextDecoder().decode(chunks[0])); // "Hello"
    break;
  }
} // Automatically closed here
```

**Example: Different buffer sizes per direction**
```typescript
// High-throughput server responses, low-throughput client requests
const [client, server] = Stream.duplex({
  a: { highWaterMark: 2 },   // Client→Server: small buffer
  b: { highWaterMark: 16 },  // Server→Client: larger buffer for responses
});
```

### Custom DuplexChannel Implementations

`Stream.duplex()` is a convenience function, but it's not the only way to create
duplex channels. Applications and runtimes can implement their own duplex channels
as long as they conform to the `DuplexChannel` interface.

For example, a runtime might provide a native socket implementation:

```typescript
class NativeSocket implements DuplexChannel {
  readonly writer: Writer;
  readonly readable: AsyncIterable<Uint8Array[]>;

  constructor(private handle: NativeHandle) {
    this.writer = new SocketWriter(handle);
    this.readable = new SocketReadable(handle);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
```

Or an application might wrap a WebSocket:

```typescript
function wrapWebSocket(ws: WebSocket): DuplexChannel {
  const { writer, readable } = Stream.push();

  ws.onmessage = (event) => {
    writer.writeSync(new Uint8Array(event.data));
  };
  ws.onclose = () => writer.endSync();
  ws.onerror = (e) => writer.failSync(new Error('WebSocket error'));

  return {
    writer: {
      // Delegate writes to WebSocket.send()
      async write(chunk) { ws.send(chunk); },
      writeSync(chunk) { ws.send(chunk); return true; },
      // ... implement other Writer methods
    },
    readable,
    async close() { ws.close(); },
    [Symbol.asyncDispose]() { return this.close(); },
  };
}
```

The key requirement is conforming to the `DuplexChannel` interface, which extends
`WriterIterablePair` (providing `writer` and `readable`) and `AsyncDisposable`
(providing `Symbol.asyncDispose` for `await using` support).

---

## Stream Factories

### `Stream.from(input)`

Create an async iterable from various types of sources. Even when the input is already a
[Streamable](#streamable-types), `from()` performs important normalization:

1. **Batch normalization** - Ensures consistent `Uint8Array[]` batch output format
2. **Type conversion** - Strings → UTF-8 encoded bytes, ArrayBuffer/ArrayBufferView → Uint8Array
3. **Recursive flattening** - Nested arrays and iterables are flattened to a single stream
4. **Protocol handling** - Invokes [`toStreamable`/`toAsyncStreamable`](#tostreamable--toasyncstreamable) on objects implementing those protocols
5. **Batching optimization** - Groups synchronous values together to amortize async iteration overhead

```typescript
function from(
  input: ByteInput | Streamable
): AsyncIterable<Uint8Array[]>
```

**Supported inputs:**
- `string` - UTF-8 encoded
- `ArrayBuffer` - Wrapped as Uint8Array (zero-copy)
- `ArrayBufferView` - Converted to Uint8Array (zero-copy)
- `Iterable` / `AsyncIterable` - Normalized and wrapped

**Example:**
```typescript
const readable = Stream.from("Hello, World!");
const readable = Stream.from(new Uint8Array([1, 2, 3]));
const readable = Stream.from(["chunk1", "chunk2"]);
const readable = Stream.from(asyncGenerator());
```

### `Stream.fromSync(input)`

Create a sync iterable from various sources. Like `from()`, this normalizes
inputs to the consistent `Uint8Array[]` batch format, handling type conversions,
recursive flattening, and [protocol handling](#tostreamable--toasyncstreamable)—but for synchronous sources only.

```typescript
function fromSync(
  input: ByteInput | SyncStreamable
): Iterable<Uint8Array[]>
```

---

## Pull Pipeline

### `Stream.pull(source, ...transforms?, options?)`

Create a pull-through pipeline with [transforms](#transform-types). The pipeline is lazy—no data
flows until the consumer iterates. Each iteration pulls data through the
transform chain on demand. Transforms receive a `null` flush signal after all
source data has been consumed, allowing them to emit any buffered final output.

When aborted via signal, on error, or when the consumer stops iterating,
transforms are notified via the `AbortSignal` in their `TransformOptions`
parameter. Transforms can use the signal to clean up resources, cancel
sub-operations, or bail out of long-running work.

```typescript
function pull(
  source: Streamable,
  ...args: [...Transform[], PullOptions?]
): AsyncIterable<Uint8Array[]>
```

See [Streamable Types](#streamable-types) for supported source types.

**Options:**
- `signal?: AbortSignal` - Cancellation signal

**Example:**
```typescript
// No transforms
const output = Stream.pull(source);

// With transforms
const output = Stream.pull(source, compress, encrypt);

// With options
const output = Stream.pull(source, compress, { signal: controller.signal });

// Consume
for await (const chunks of output) {
  for (const chunk of chunks) {
    process(chunk);
  }
}
```

### `Stream.pullSync(source, ...transforms)`

Sync pull pipeline. Works identically to `pull()` but for synchronous sources
and transforms.

```typescript
function pullSync(
  source: SyncStreamable,
  ...transforms: SyncTransform[]
): Iterable<Uint8Array[]>
```

### Transform Types

Transforms come in two forms, distinguished by whether they are a plain function
or an object:

- **Stateless (function)**: Called once per batch. Receives `Uint8Array[] | null`,
  returns transformed output. The `null` input is a flush signal indicating
  end-of-stream—return any buffered data or `null`.

- **Stateful (object)**: Wraps the entire source as a generator. Has full control
  over iteration and can maintain internal state across batches. Use for
  compression, encryption, or any transform needing to buffer across chunks.

```typescript
// Options passed to transform functions by the pipeline
interface TransformOptions {
  /** Signal that fires when the pipeline is cancelled, errors, or
   *  the consumer stops iteration. */
  readonly signal: AbortSignal;
}

// Stateless transform - receives batch and pipeline options, returns batch
type TransformFn = (
  chunks: Uint8Array[] | null,
  options: TransformOptions
) => AsyncTransformResult;

// Stateful transform - generator wrapping source, receives pipeline options
type StatefulTransformFn = (
  source: AsyncIterable<Uint8Array[] | null>,
  options: TransformOptions
) => AsyncIterable<TransformYield>;

// Transform object for stateful transforms
// Using an object (vs a plain function) indicates this is a stateful transform
interface TransformObject {
  transform: StatefulTransformFn;
}

// Function = stateless, Object = stateful
type Transform = TransformFn | TransformObject;
```

**Transform Return Types:**

Transforms have flexible return types for convenience:

- `null` - No output for this batch
- `Uint8Array[]` - Batch of chunks (most common)
- `Uint8Array` - Single chunk (wrapped into batch)
- `string` - UTF-8 encoded to Uint8Array
- `Iterable<...>` / `AsyncIterable<...>` - Flattened to chunks
- `Promise<...>` - Awaited (async transforms only)

**Transform Example:**
```typescript
// Stateless transform (plain function)
const uppercase: TransformFn = (chunks, { signal }) => {
  if (chunks === null) return null; // Flush signal
  return chunks.map(chunk => {
    const text = new TextDecoder().decode(chunk);
    return new TextEncoder().encode(text.toUpperCase());
  });
};

// Stateful transform (object with generator function)
const compress: TransformObject = {
  async *transform(source, { signal }) {
    const compressor = createCompressor();
    try {
      for await (const chunks of source) {
        if (chunks === null) {
          yield compressor.finish();
        } else {
          for (const chunk of chunks) {
            yield compressor.push(chunk);
          }
        }
      }
    } finally {
      // Clean up compressor resources on error/cancellation
      compressor.destroy();
    }
  }
};
```

---

## Pipe To

### `Stream.pipeTo(source, ...transforms?, writer, options?)`

Consume source and write to a [writer](#writer-interface) with optional [transforms](#transform-types). This is the primary way to pipe data to a destination. It handles:

- Applying transforms in order before writing
- Calling `writer.writev()` when available for batch efficiency
- Calling `writer.end()` on successful completion (unless `preventClose`)
- Calling `writer.fail()` on error (unless `preventFail`)
- Propagating the pipeline's `AbortSignal` to `writer.write()` and `writer.end()`
- Respecting cancellation via `AbortSignal`

Returns the total number of bytes written to the writer.

```typescript
function pipeTo(
  source: AsyncIterable<Uint8Array[]> | Iterable<Uint8Array[]>,
  ...args: [...Transform[], Writer, PipeToOptions?]
): Promise<number>  // Total bytes written
```

**Options:**
- `signal?: AbortSignal` - Cancellation signal
- `preventClose?: boolean` - Don't call writer.end() on completion
- `preventFail?: boolean` - Don't call writer.fail() on error

**Example:**
```typescript
// Direct pipe
const bytesWritten = await Stream.pipeTo(source, fileWriter);

// With transforms
const bytesWritten = await Stream.pipeTo(
  source,
  compress,
  encrypt,
  networkWriter
);

// With options
const bytesWritten = await Stream.pipeTo(
  source,
  compress,
  fileWriter,
  { signal: controller.signal }
);
```

### `Stream.pipeToSync(source, ...transforms?, writer, options?)`

Sync pipe to destination.

```typescript
function pipeToSync(
  source: Iterable<Uint8Array[]>,
  ...args: [...SyncTransform[], SyncWriter, PipeToSyncOptions?]
): number
```

---

## Consumers

Terminal consumers that collect an entire stream into memory. These accept any
[Streamable](#streamable-types) source. Use the `limit` option to protect against
unbounded memory growth from untrusted sources.

### `Stream.bytes(source, options?)`

Collect all bytes from source into a single `Uint8Array`. Efficiently
concatenates all chunks, avoiding unnecessary copies when possible.

```typescript
function bytes(
  source: AsyncIterable<Uint8Array[]> | Iterable<Uint8Array[]>,
  options?: ConsumeOptions
): Promise<Uint8Array>
```

**Options:**
- `signal?: AbortSignal` - Cancellation signal
- `limit?: number` - Max bytes (throws `RangeError` if exceeded)

### `Stream.text(source, options?)`

Collect and decode as text. Uses `TextDecoder` with `fatal: true` by default,
throwing on invalid byte sequences.

```typescript
function text(
  source: AsyncIterable<Uint8Array[]> | Iterable<Uint8Array[]>,
  options?: TextOptions
): Promise<string>
```

**Options:**
- `signal?: AbortSignal` - Cancellation signal
- `limit?: number` - Max bytes (throws `RangeError` if exceeded)
- `encoding?: string` - Text encoding (default: 'utf-8')

### `Stream.arrayBuffer(source, options?)`

Collect as ArrayBuffer. Returns the underlying buffer directly when possible,
or copies when the Uint8Array is a view of a larger buffer.

```typescript
function arrayBuffer(
  source: AsyncIterable<Uint8Array[]> | Iterable<Uint8Array[]>,
  options?: ConsumeOptions
): Promise<ArrayBuffer>
```

### `Stream.array(source, options?)`

Collect all chunks as an array of `Uint8Array`. Unlike `bytes()` which concatenates
all chunks into a single `Uint8Array`, `array()` preserves the original chunk
boundaries. This is useful when you need to process or forward chunks individually
while still collecting them all.

```typescript
function array(
  source: AsyncIterable<Uint8Array[]> | Iterable<Uint8Array[]>,
  options?: ConsumeOptions
): Promise<Uint8Array[]>
```

**Options:**
- `signal?: AbortSignal` - Cancellation signal
- `limit?: number` - Max bytes (throws `RangeError` if exceeded)

**Example:**
```typescript
// Collect chunks preserving boundaries
const chunks = await Stream.array(source);
console.log(`Received ${chunks.length} chunks`);

// Compare with bytes() which concatenates
const concatenated = await Stream.bytes(source);
console.log(`Total bytes: ${concatenated.byteLength}`);

// Forward chunks individually
for (const chunk of chunks) {
  await destination.write(chunk);
}
```

### Sync Variants

Synchronous versions for use with sync sources. Same behavior as async versions.

```typescript
Stream.bytesSync(source, options?)
Stream.textSync(source, options?)
Stream.arrayBufferSync(source, options?)
Stream.arraySync(source, options?)
```

---

## Utilities

### `Stream.tap(callback)`

Create a pass-through [transform](#transform-types) that observes chunks without modifying them.

Note that it's up to the callback to not modify the chunks in place, as that would affect downstream consumers. The key difference with `tap` is that return values are ignored
preventing the callback from replacing the chunks in the stream, but since the data
flows through by-reference, in-place modifications would still be visible downstream.

The intended use case is for logging, metrics, or side-effects based on the data flowing
without altering the stream itself.

```typescript
function tap(callback: TapCallbackAsync): Transform
function tapSync(callback: TapCallback): SyncTransform

type TapCallback = (chunks: Uint8Array[] | null) => void;
type TapCallbackAsync = (
  chunks: Uint8Array[] | null,
  options: TransformOptions
) => void | Promise<void>;
```

**Example:**
```typescript
// Log chunks as they flow through
const output = Stream.pull(
  source,
  Stream.tap((chunks) => {
    if (chunks === null) {
      console.log('Stream complete');
    } else {
      console.log('Received', chunks.length, 'chunks');
    }
  }),
  compress
);

// Hash while streaming
const hasher = crypto.createHash('sha256');
const output = Stream.pull(
  source,
  Stream.tap((chunks) => {
    if (chunks === null) {
      console.log('Hash:', hasher.digest('hex'));
    } else {
      for (const chunk of chunks) hasher.update(chunk);
    }
  })
);
```

### `Stream.merge(...sources, options?)`

Merge multiple async sources by temporal order (whichever produces a value
first gets yielded first). All sources are consumed concurrently using
`Promise.race()`. When the merged stream is closed or cancelled, all source
iterators are properly cleaned up via their `return()` method.

This is useful for combining multiple independent data feeds into a single
stream while preserving arrival order.

```typescript
function merge(
  ...args: [...AsyncIterable<Uint8Array[]>[], MergeOptions?]
): AsyncIterable<Uint8Array[]>
```

**Options:**
- `signal?: AbortSignal` - Cancellation signal

**Example:**
```typescript
// Merge WebSocket feeds
const merged = Stream.merge(prices, news, alerts);

for await (const chunks of merged) {
  // Process in order of arrival
}
```

### `Stream.ondrain(drainable)`

Wait for a [Writer](#writer-interface)'s backpressure to clear. This is the primary mechanism
for integrating event-driven sources (like Node.js EventEmitters, WebSockets, etc.)
with the streams API.

Writers from `Stream.push()` and `Stream.broadcast()` implement the Drainable protocol.

```typescript
function ondrain(drainable: unknown): Promise<boolean> | null
```

**Returns:**
- `null` - Object doesn't implement the Drainable protocol, or drain is not applicable (e.g., `desiredSize` is `null`)
- `Promise<true>` - Resolves immediately if ready to write (`desiredSize > 0`), or resolves when backpressure clears
- `Promise<false>` - Resolves when writer closes while waiting (no more writes accepted)
- `Promise` rejects - If writer fails/errors while waiting

**Important:** Due to TOCTOU (time-of-check-time-of-use) races, callers should still
check `desiredSize` and await writes even after the drain promise resolves with `true`.
The buffer may fill again between the drain signal and your write.

**Example: Event source integration:**
```typescript
const { writer, readable } = Stream.push({ highWaterMark: 4 });

// Consume in background
const consumePromise = Stream.text(readable);

// Event source integration pattern
eventSource.on('data', async (chunk) => {
  // Check backpressure before writing
  if (writer.desiredSize === 0) {
    eventSource.pause();

    // await works on null (returns null), and null is falsy
    const canWrite = await Stream.ondrain(writer);
    if (!canWrite) {
      // Writer closed or doesn't support drain - stop the source
      eventSource.destroy();
      return;
    }

    eventSource.resume();
  }

  // Still await - desiredSize may have changed (TOCTOU)
  await writer.write(chunk);
});

eventSource.on('end', () => writer.end());
eventSource.on('error', (err) => writer.fail(err));
```

Note: `await null` returns `null`, which is falsy, so the pattern `const canWrite = await Stream.ondrain(x)`
works correctly even when the protocol isn't supported. Explicit `null` checking is only needed when you
must distinguish "protocol not supported" from "writer closed".

**Why use ondrain instead of polling desiredSize?**

Polling `desiredSize` in a loop wastes CPU cycles and may miss the moment when
space becomes available. `ondrain()` provides an efficient notification mechanism
that resolves exactly when the buffer has space, without busy-waiting.

```typescript
// BAD: Polling (wastes CPU)
while (writer.desiredSize === 0) {
  await new Promise(r => setTimeout(r, 10));
}

// GOOD: Efficient notification
const canWrite = await Stream.ondrain(writer);
if (!canWrite) return; // closed or unsupported
```

---

## Multi-Consumer

Two patterns for sharing a single source among multiple consumers:

- **[Broadcast](#streambroadcastoptions) (push model)**: Broadcast is effectively a multi-consumer version of `Stream.push()`, where data written to the writer is delivered to all subscribed consumers.

- **[Share](#streamsharesource-options) (pull model)**: Share is a multi-consumer version of `Stream.from()`/`Stream.pull()`, where a single source is consumed on-demand as consumers pull data.

### `Stream.broadcast(options?)`

Create a push-model multi-consumer channel. Data written to the [writer](#writer-interface) is
delivered to all consumers that have subscribed via `broadcast.push()`.
Late-joining consumers miss data written before they subscribed.

```typescript
function broadcast(options?: BroadcastOptions): {
  writer: Writer;
  broadcast: Broadcast;
}
```

**Options:**
- `highWaterMark?: number` - Max slots in buffer; in strict mode, also limits pending writes (default: 16)
- `backpressure?:` [BackpressurePolicy](#backpressure-policy) - Policy when buffer full (default: 'strict')
- `signal?: AbortSignal` - Cancellation signal

Backpressure is applied based on the slowest consumer and follows the same rules as `Stream.push()`. Because the backpressure is slowest-consumer based, be cautious when multiple consumers are
pulling at different rates, as a very slow consumer can cause the entire broadcast to back up.

**Broadcast Interface:**
```typescript
interface Broadcast {
  push(...transforms?, options?): AsyncIterable<Uint8Array[]>;
  readonly consumerCount: number;
  readonly bufferSize: number;

  // Cancel all consumers
  cancel(reason?: Error): void;
  [Symbol.dispose](): void;
}
```

**Example:**
```typescript
const { writer, broadcast } = Stream.broadcast({ highWaterMark: 100 });

// Create consumers
const consumer1 = broadcast.push();
const consumer2 = broadcast.push(decompress);

// Producer pushes to all consumers
await writer.write("shared data");
await writer.end();

// Each consumer receives independently
const [result1, result2] = await Promise.all([
  Stream.text(consumer1),
  Stream.text(consumer2)
]);
```

### `Stream.share(source, options?)`

Create a pull-model multi-consumer wrapper. The source is consumed on-demand as
consumers pull data. Chunks are buffered so slower consumers can catch up, and
the buffer is trimmed as all consumers advance past buffered data.

The source iterator is created lazily on first pull and shared across all
consumers. Each consumer maintains its own cursor position in the buffer.

```typescript
function share(
  source: AsyncIterable<Uint8Array[]> | Iterable<Uint8Array[]>,
  options?: ShareOptions
): Share
```

**Options:**
- `highWaterMark?: number` - Max slots in buffer (default: 16)
- `backpressure?:` [BackpressurePolicy](#backpressure-policy) - Policy when buffer full (default: 'strict')
- `signal?: AbortSignal` - Cancellation signal

**Share Interface:**
```typescript
interface Share {
  pull(...transforms?, options?): AsyncIterable<Uint8Array[]>;
  readonly consumerCount: number;
  readonly bufferSize: number;
  cancel(reason?: Error): void;
  [Symbol.dispose](): void;
}
```

**Example:**
```typescript
const shared = Stream.share(fileStream, { highWaterMark: 100 });

// Create consumers with different transforms
const consumer1 = shared.pull();
const consumer2 = shared.pull(decompress);
const consumer3 = shared.pull(decompress, parse);

// All share the same source, buffered
const [raw, decompressed, parsed] = await Promise.all([
  Stream.bytes(consumer1),
  Stream.bytes(consumer2),
  Stream.bytes(consumer3)
]);
```

### `Stream.shareSync(source, options?)`

Sync pull-model multi-consumer wrapper.
`
```typescript
function shareSync(
  source: Iterable<Uint8Array[]>,
  options?: ShareSyncOptions
): SyncShare
```

### Static Namespaces

```typescript
// Get or create from Broadcastable or Streamable
Broadcast.from(input, options?): { writer, broadcast }

// Get or create from Shareable or Streamable
Share.from(input, options?): Share
SyncShare.fromSync(input, options?): SyncShare
```

See [Broadcastable / Shareable](#broadcastable--shareable) for implementing custom multi-consumer sources.

---

## Types

### Backpressure Policy

Controls behavior when internal buffers reach their limit:

```typescript
type BackpressurePolicy =
  | 'strict'       // Catches ignored backpressure (default)
  | 'block'        // Async writes block until space; sync writes return false
  | 'drop-oldest'  // Drop oldest buffered chunks to make room for new data
  | 'drop-newest'; // Discard incoming chunks when buffer full
```

- **strict**: (Default) Catches when producers ignore backpressure. Allows
  properly awaited writes to proceed (waiting for space when buffer is full),
  but rejects when too many writes are pending without being awaited. The
  `highWaterMark` limits both the slots buffer AND the pending writes queue.
  Sync writes return `false` when the slots buffer is full. Async writes will
  reject when both the slots buffer and pending write buffers are full. Use
  this to ensure producers properly respect backpressure signals.

- **block**: Async writes wait for buffer space; sync writes return `false`.
  Unlike strict, the pending writes queue is unbounded, so "fire-and-forget"
  writes will accumulate without error. Use this for flow control where the
  producer should wait for consumers to catch up, but be careful to await
  writes to avoid memory issues. This is the mode that existing Node.js and
  Web streams APIs default to.

- **drop-oldest**: Prioritizes recent data. Old buffered data is discarded to
  make room. Useful for live feeds where stale data is less valuable.

- **drop-newest**: Prioritizes existing data. New writes are silently discarded
  when buffer is full. Useful when you want to process what you have without
  being overwhelmed.

### How highWaterMark Works

The `highWaterMark` controls flow between producer and consumer using a two-part
buffering system. Think of it like a bucket (slots) being filled through a hose
(pending writes), with a float valve that closes when the bucket is full:

```
                          highWaterMark (e.g., 3)
                                 |
    Producer                     v
       |                    +---------+
       v                    |         |
  [ write() ] ----+    +--->| slots   |---> Consumer pulls
  [ write() ]     |    |    | (bucket)|     for await (...)
  [ write() ]     v    |    +---------+
              +--------+         ^
              | pending|         |
              | writes |    float valve
              | (hose) |    (backpressure)
              +--------+
                   ^
                   |
          'strict' mode limits this too!
```

When both the slots and pending writes are full, backpressure is signaled.

**The Two Buffers:**

1. **Slots (the bucket)**: Data ready for the consumer, limited by `highWaterMark`
2. **Pending writes (the hose)**: Writes waiting when slots are full

**How policies use these buffers:**

| Policy | Slots limit | Pending writes limit |
|--------|-------------|---------------------|
| `strict` | `highWaterMark` | `highWaterMark` |
| `block` | `highWaterMark` | Unbounded |
| `drop-oldest` | `highWaterMark` | N/A (never waits) |
| `drop-newest` | `highWaterMark` | N/A (never waits) |

Important: The key rule of thumb is that with `strict` mode, the total number of
unacknowledged writes (in both slots + pending) can never exceed
`highWaterMark * 2`.

#### Strict Mode in Detail

Strict mode catches "fire-and-forget" patterns where the producer calls `write()`
without awaiting, which would cause unbounded memory growth:

```typescript
// BAD: Fire-and-forget (strict mode will catch this)
for (const item of hugeDataset) {
  writer.write(item);  // Not awaited! Queues up unboundedly
}

// GOOD: Properly awaited (works in both strict and block)
for (const item of hugeDataset) {
  await writer.write(item);  // Waits for backpressure
}
```

**How strict mode works step-by-step** (with `highWaterMark: 3`):

```
Initial state:
  slots: []           (0/3)
  pendingWrites: []   (0/3)

Write #1 (awaited): Goes directly to slots
  slots: [chunk1]     (1/3)
  pendingWrites: []   (0/3)

Write #2 (awaited): Goes directly to slots
  slots: [chunk1, chunk2]  (2/3)
  pendingWrites: []        (0/3)

Write #3 (awaited): Goes directly to slots
  slots: [chunk1, chunk2, chunk3]  (3/3) FULL
  pendingWrites: []                (0/3)

Write #4 (awaited): Slots full, waits in pendingWrites
  slots: [chunk1, chunk2, chunk3]  (3/3) FULL
  pendingWrites: [write4]          (1/3)
  --> write4 is waiting (Promise not resolved)

Consumer reads: Drains slots, pending write moves to slots
  slots: [chunk4]     (1/3)
  pendingWrites: []   (0/3)
  --> write4's Promise resolves, producer continues
```

**Fire-and-forget detection:**

```
Write #1 (NOT awaited): Goes to slots
Write #2 (NOT awaited): Goes to slots
Write #3 (NOT awaited): Goes to slots (FULL)
Write #4 (NOT awaited): Waits in pendingWrites
Write #5 (NOT awaited): Waits in pendingWrites
Write #6 (NOT awaited): Waits in pendingWrites (pendingWrites at limit)
Write #7 (NOT awaited): THROWS! Too many pending writes
  --> "Backpressure violation: too many pending writes"
```

If you're properly awaiting writes, you can only have ONE
pending write at a time (yours), so you'll never hit the pendingWrites limit.

#### Block Mode in Detail

Block mode is simpler: it always waits for space, with no limit on pending writes:

```typescript
const { writer, readable } = Stream.push({
  highWaterMark: 3,
  backpressure: 'block'
});

// Works, but dangerous without await:
for (const item of hugeDataset) {
  writer.write(item);  // Queues indefinitely, may exhaust memory!
}

// Safe usage:
for (const item of hugeDataset) {
  await writer.write(item);  // Waits for consumer
}
```

Block mode trusts the producer to properly await writes. Use it when:
- You control the producer code and know it awaits properly
- You intentionally want to queue writes (e.g., small bounded datasets)
- You're migrating from systems that don't enforce backpressure

#### Choosing Between Strict and Block

| Use Case | Recommended Policy |
|----------|-------------------|
| Untrusted/third-party producers | `strict` |
| Development/debugging | `strict` |
| High-performance trusted code | `block` |
| Intentional queuing of small data | `block` |
| Real-time data (drop is acceptable) | `drop-oldest` or `drop-newest` |

**Example: Safe streaming with strict mode:**

```typescript
const { writer, readable } = Stream.push({
  highWaterMark: 16,
  backpressure: 'strict'  // Default, explicit for clarity
});

// Consumer
const consumer = (async () => {
  for await (const chunks of readable) {
    await processChunks(chunks);  // Slow consumer
  }
})();

// Producer - this pattern is safe with strict mode
async function produce() {
  for (const data of largeDataset) {
    await writer.write(data);  // Awaited = safe
  }
  await writer.end();
}

await Promise.all([consumer, produce()]);
```

### Streamable Types

```typescript
// Primitive chunk types
type PrimitiveChunk = string | ArrayBuffer | ArrayBufferView;

// Raw byte input (single value)
type ByteInput = string | ArrayBuffer | ArrayBufferView;

// Sync streamable - has Symbol.iterator
interface SyncStreamable {
  [Symbol.iterator](): Iterator<SyncStreamableYield>;
}

// Async streamable - has Symbol.asyncIterator
interface AsyncStreamable {
  [Symbol.asyncIterator](): AsyncIterator<AsyncStreamableYield>;
}

// Either sync or async
type Streamable = SyncStreamable | AsyncStreamable;
```

---

## Protocol Symbols

For custom implementations that want to participate in streaming. These symbols
enable objects to integrate with [Stream.from()](#streamfrominput),
[Stream.share()](#streamsharesource-options), and other stream functions:

```typescript
import {
  toStreamable,        // Symbol for ToStreamable protocol
  toAsyncStreamable,   // Symbol for ToAsyncStreamable protocol
  broadcastProtocol,   // Symbol for Broadcastable protocol
  shareProtocol,       // Symbol for Shareable protocol
  shareSyncProtocol,   // Symbol for SyncShareable protocol
  drainableProtocol,   // Symbol for Drainable protocol
} from 'new-streams';
```

### ToStreamable / ToAsyncStreamable

Allow objects to convert themselves to streamable data.

```typescript
class JsonMessage {
  constructor(private data: object) {}

  [toStreamable]() {
    return JSON.stringify(this.data);
  }
}

await writer.write(new JsonMessage({ hello: "world" }));
```

The return value of `toStreamable` can be any supported input type (string,
ArrayBuffer, iterable, etc). For async conversions, implement `toAsyncStreamable`.

### Broadcastable / Shareable

Allow objects to provide optimized multi-consumer implementations:

```typescript
class OptimizedSource {
  [shareProtocol](options?: ShareOptions): Share {
    return new OptimizedShare(this, options);
  }
}

// Automatically uses optimized implementation
const shared = Share.from(new OptimizedSource());
```

### Drainable

Allow objects to signal when backpressure clears. Used by [Stream.ondrain()](#streamondraindrainable)
to efficiently wait for write capacity.

Writers from `Stream.push()` and `Stream.broadcast()` automatically implement this protocol.

```typescript
interface Drainable {
  [drainableProtocol](): Promise<boolean> | null;
}
```

The method returns:
- `null` if drain is not applicable (e.g., writer is closed)
- `Promise<true>` resolving immediately if ready, or when backpressure clears
- `Promise<false>` if writer closes while waiting
- Promise rejects if writer fails while waiting

**Custom implementation example:**

```typescript
class CustomWriter implements Writer, Drainable {
  private drainPromises: Array<{
    resolve: (v: boolean) => void;
    reject: (e: Error) => void;
  }> = [];

  [drainableProtocol](): Promise<boolean> | null {
    if (this.desiredSize === null) return null;
    if (this.desiredSize > 0) return Promise.resolve(true);

    return new Promise((resolve, reject) => {
      this.drainPromises.push({ resolve, reject });
    });
  }

  // Call when buffer space becomes available
  private notifyDrain() {
    for (const p of this.drainPromises) {
      p.resolve(true);
    }
    this.drainPromises = [];
  }

  // Call when writer closes
  private notifyClose() {
    for (const p of this.drainPromises) {
      p.resolve(false);
    }
    this.drainPromises = [];
  }

  // Call when writer errors
  private notifyError(error: Error) {
    for (const p of this.drainPromises) {
      p.reject(error);
    }
    this.drainPromises = [];
  }
}
```
