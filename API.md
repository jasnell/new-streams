# New Streams API Reference

A bytes-only stream API that simplifies Web Streams while providing better ergonomics and performance characteristics.

## Table of Contents

- [Stream Class](#stream-class)
  - [Static Factory Methods](#static-factory-methods)
  - [Consumption Methods](#consumption-methods)
  - [Slicing Operators](#slicing-operators)
  - [Branching](#branching)
  - [Piping](#piping)
  - [Cancellation](#cancellation)
  - [Low-level Read Access](#low-level-read-access)
  - [Properties](#stream-properties)
- [Writer Class](#writer-class)
  - [Methods](#writer-methods)
  - [Properties](#writer-properties)
- [StreamWithWriter Class](#streamwithwriter-class)
- [Types](#types)
- [Options Objects](#options-objects)

---

## Stream Class

```typescript
class Stream implements AsyncIterable<Uint8Array>
```

The primary readable byte stream class. Streams are consumed by reading data from them using various methods.

### Static Factory Methods

#### `Stream.from(source, options?)`

Create a stream from various byte sources.

```typescript
static from(
  source: string | BufferSource | Array<string | BufferSource> | Stream,
  options?: StreamFromOptions
): Stream
```

**Parameters:**
- `source` - Data to create stream from:
  - `string` - UTF-8 encoded (or custom encoding via options)
  - `Uint8Array` - Passed through directly
  - `ArrayBuffer` - Wrapped in Uint8Array
  - `Array` - Each element yielded as a chunk
  - `Stream` - Returns the same stream instance
- `options` - Optional configuration
  - `encoding?: string` - Encoding for strings (default: `"utf-8"`)

**Returns:** `Stream`

**Example:**
```typescript
const stream1 = Stream.from('Hello, World!');
const stream2 = Stream.from(new Uint8Array([1, 2, 3]));
const stream3 = Stream.from(['chunk1', 'chunk2']);
const stream4 = Stream.from('UTF-16 text', { encoding: 'utf-16le' });
```

---

#### `Stream.pull(source, options?)`

Create a stream from a sync or async generator (pull-based).

```typescript
static pull(
  source: () => Generator<unknown> | AsyncGenerator<unknown>,
  options?: StreamPullOptions
): Stream
```

**Parameters:**
- `source` - Generator function that yields:
  - `string` - Encoded using the specified encoding
  - `Uint8Array` - Passed through directly
  - `ArrayBuffer` - Wrapped in Uint8Array
  - `Stream` - Consumed inline (nested streams)
  - `Generator` / `AsyncGenerator` - Consumed inline
- `options` - Optional configuration
  - `encoding?: string` - Encoding for strings (default: `"utf-8"`)

**Returns:** `Stream`

**Notes:**
- Generator is pulled on-demand (lazy evaluation)
- Natural backpressure: generator pauses until consumer reads
- Generator's `finally` block is called on stream cancellation

**Example:**
```typescript
// Sync generator
const stream1 = Stream.pull(function* () {
  yield 'line 1\n';
  yield 'line 2\n';
});

// Async generator with I/O
const stream2 = Stream.pull(async function* () {
  for await (const record of database.query()) {
    yield JSON.stringify(record) + '\n';
  }
});

// Nested streams
const stream3 = Stream.pull(function* () {
  yield 'header\n';
  yield anotherStream;  // Consumed inline
  yield 'footer\n';
});
```

---

#### `Stream.push(options?)`

Create a push-based stream with a writer.

```typescript
static push(options?: StreamPushOptions): StreamWithWriter
```

**Parameters:**
- `options` - Optional configuration
  - `encoding?: string` - Default encoding for strings (default: `"utf-8"`)
  - `buffer?: StreamBufferOptions` - Buffer configuration

**Returns:** `StreamWithWriter` - Destructurable as `[Stream, Writer]`

**Example:**
```typescript
// Array destructuring
const [stream, writer] = Stream.push();

// Object destructuring
const { stream, writer } = Stream.push();

// With buffer configuration
const [stream, writer] = Stream.push({
  buffer: {
    max: 1024,
    onOverflow: 'block'
  }
});
```

---

#### `Stream.empty()`

Create an already-closed empty stream.

```typescript
static empty(): Stream
```

**Returns:** `Stream` - A stream that immediately returns `done: true` on read

**Example:**
```typescript
const empty = Stream.empty();
const bytes = await empty.bytes(); // Uint8Array(0)
```

---

#### `Stream.never(reason?)`

Create a stream that never produces data, or an already-errored stream.

```typescript
static never(reason?: unknown): Stream
```

**Parameters:**
- `reason` - If provided, creates an errored stream
  - `Error` - Used directly
  - Other types - Wrapped in `Error`

**Returns:** `Stream`

**Example:**
```typescript
// Never produces data (would hang if consumed)
const hanging = Stream.never();

// Already errored
const errored = Stream.never(new Error('Something went wrong'));
```

---

#### `Stream.merge(...streams)`

Merge multiple streams with interleaved output (first-come ordering).

```typescript
static merge(...streams: Stream[]): Stream
```

**Parameters:**
- `streams` - Streams to merge

**Returns:** `Stream` - Combined stream with chunks from all sources

**Notes:**
- Empty array returns `Stream.empty()`
- Single stream returns that stream
- Order is based on which source produces data first (not round-robin)
- Error in any source stream errors the merged stream

**Example:**
```typescript
const merged = Stream.merge(stream1, stream2, stream3);
for await (const chunk of merged) {
  // Chunks arrive in first-come order
}
```

---

#### `Stream.concat(...streams)`

Concatenate multiple streams sequentially.

```typescript
static concat(...streams: Stream[]): Stream
```

**Parameters:**
- `streams` - Streams to concatenate

**Returns:** `Stream` - Combined stream with sequential output

**Notes:**
- Empty array returns `Stream.empty()`
- Single stream returns that stream
- Each stream is fully consumed before moving to the next
- Error in any stream errors the result

**Example:**
```typescript
const combined = Stream.concat(header, body, footer);
const text = await combined.text();
```

---

#### `Stream.transform(transformer, options?)`

Create a transform stream with an input writer.

```typescript
static transform(
  transformer: StreamTransformer,
  options?: StreamTransformOptions
): StreamWithWriter
```

**Parameters:**
- `transformer` - Transform function or object (see [StreamTransformer](#streamtransformer))
- `options` - Optional configuration
  - `encoding?: string` - Encoding for output strings (default: `"utf-8"`)
  - `chunkSize?: number` - Fixed input chunk size (except final chunk)
  - `buffer?: StreamBufferOptions` - Output buffer configuration

**Returns:** `StreamWithWriter` - Destructurable as `[Stream, Writer]`

**Example:**
```typescript
// Function transform
const [output, writer] = Stream.transform((chunk) => {
  if (chunk === null) return null; // Flush signal
  return new TextDecoder().decode(chunk).toUpperCase();
});

// Generator transform (1:N)
const [output, writer] = Stream.transform(function* (chunk) {
  if (chunk === null) return;
  for (const byte of chunk) {
    yield new Uint8Array([byte]);
  }
});

// Object transform with abort handler
const [output, writer] = Stream.transform({
  transform(chunk) {
    return chunk;
  },
  abort(reason) {
    console.log('Transform aborted:', reason);
  }
});
```

---

#### `Stream.writer(sink, options?)`

Create a writer with a custom sink.

```typescript
static writer(
  sink: WriterSink,
  options?: { encoding?: string; buffer?: StreamBufferOptions }
): Writer
```

**Parameters:**
- `sink` - Object with write/close/abort methods
- `options` - Optional configuration

**Returns:** `Writer`

**Example:**
```typescript
const writer = Stream.writer({
  async write(chunk) {
    await fs.appendFile('output.txt', chunk);
  },
  async close() {
    console.log('Done writing');
  },
  async abort(reason) {
    console.log('Aborted:', reason);
  }
});
```

---

#### `Stream.pipeline(source, ...stages, options?)`

Construct an optimized pipeline from source through transforms to destination.

```typescript
static async pipeline(
  source: Stream,
  ...stages: Array<StreamTransformer | Writer>,
  options?: StreamPipelineOptions
): Promise<number>
```

**Parameters:**
- `source` - Source stream
- `stages` - Transform functions/objects, with final stage being a `Writer`
- `options` - Optional configuration
  - `signal?: AbortSignal` - Cancellation signal
  - `limit?: number` - Maximum bytes through pipeline
  - `preventClose?: boolean` - Don't close destination when done

**Returns:** `Promise<number>` - Total bytes that flowed through

**Example:**
```typescript
const bytes = await Stream.pipeline(
  source,
  (chunk) => chunk === null ? null : transform(chunk),
  (chunk) => chunk === null ? null : anotherTransform(chunk),
  destination,
  { limit: 10000 }
);
```

---

### Consumption Methods

#### `stream.bytes(options?)`

Collect all bytes as a `Uint8Array`.

```typescript
async bytes(options?: StreamConsumeOptions): Promise<Uint8Array>
```

**Parameters:**
- `options.signal?: AbortSignal` - Cancellation signal

**Returns:** `Promise<Uint8Array>` - All bytes concatenated

---

#### `stream.arrayBuffer(options?)`

Collect all bytes as an `ArrayBuffer`.

```typescript
async arrayBuffer(options?: StreamConsumeOptions): Promise<ArrayBuffer>
```

**Parameters:**
- `options.signal?: AbortSignal` - Cancellation signal

**Returns:** `Promise<ArrayBuffer>` - All bytes in a new ArrayBuffer

---

#### `stream.text(encoding?, options?)`

Collect and decode as text.

```typescript
async text(encoding?: string, options?: StreamConsumeOptions): Promise<string>
```

**Parameters:**
- `encoding` - Text encoding (default: `"utf-8"`)
- `options.signal?: AbortSignal` - Cancellation signal

**Returns:** `Promise<string>` - Decoded text

---

### Slicing Operators

#### `stream.take(byteCount)`

Create a branch with the next n bytes. Parent stream continues at byte n.

```typescript
take(byteCount: number): Stream
```

**Parameters:**
- `byteCount` - Number of bytes to take

**Returns:** `Stream` - New branch stream with the taken bytes

**Notes:**
- Creates a **new branch** (parent continues)
- Does NOT cancel the source when done
- Use for splitting a stream

**Example:**
```typescript
const first10 = stream.take(10);
const rest = await stream.text(); // Continues from byte 10
```

---

#### `stream.drop(byteCount)`

Discard the next n bytes.

```typescript
drop(byteCount: number): Stream
```

**Parameters:**
- `byteCount` - Number of bytes to skip

**Returns:** `Stream` - Returns `this` (mutates position), or `Stream.empty()` if n=0

**Example:**
```typescript
stream.drop(5); // Skip first 5 bytes
const rest = await stream.text();
```

---

#### `stream.limit(byteCount)`

Cap stream at n bytes. Cancels source when limit is reached.

```typescript
limit(byteCount: number): Stream
```

**Parameters:**
- `byteCount` - Maximum bytes to allow

**Returns:** `Stream` - Returns `this` (terminal operation)

**Notes:**
- **Terminal operation** - returns same stream, not a branch
- **Cancels source** when limit reached (unlike `take()`)
- Multiple `limit()` calls use the smallest limit
- Use to cap total consumption

**Example:**
```typescript
stream.limit(1000);
const bytes = await stream.bytes(); // At most 1000 bytes
```

---

### Branching

#### `stream.tee(options?)`

Create a branch that sees the same bytes as this stream.

```typescript
tee(options?: StreamTeeOptions): Stream
```

**Parameters:**
- `options.buffer?: StreamBufferOptions` - Buffer configuration for branch
- `options.detached?: boolean` - Create detached (inactive) branch

**Returns:** `Stream` - New branch stream

**Notes:**
- Both streams see the same data
- Cancelling one branch does not affect others
- Errors propagate to all branches
- Slowest consumer determines backpressure

**Example:**
```typescript
const branch = stream.tee();

// Process in parallel
const [result1, result2] = await Promise.all([
  stream.text(),
  branch.text()
]);
```

---

#### `stream.attach()`

Attach a detached branch to start receiving data.

```typescript
attach(): void
```

**Notes:**
- No-op if already attached
- Auto-attaches on first `read()` or async iteration

---

### Piping

#### `stream.pipeThrough(transformer, options?)`

Transform the stream and return the readable output.

```typescript
pipeThrough(
  transformer: StreamTransformer,
  options?: StreamPipeOptions
): Stream
```

**Parameters:**
- `transformer` - Transform function or object
- `options` - Optional configuration
  - `signal?: AbortSignal` - Cancellation signal
  - `chunkSize?: number` - Fixed input chunk size
  - `buffer?: StreamBufferOptions` - Output buffer configuration
  - `limit?: number` - Maximum bytes to pipe through

**Returns:** `Stream` - Transformed output stream

**Example:**
```typescript
const upper = stream.pipeThrough((chunk) => {
  if (chunk === null) return null;
  return new TextDecoder().decode(chunk).toUpperCase();
});

// Chaining
const result = await stream
  .pipeThrough(transform1)
  .pipeThrough(transform2)
  .text();
```

---

#### `stream.pipeTo(destination, options?)`

Pipe to a writer (consumes this stream).

```typescript
async pipeTo(
  destination: Writer,
  options?: StreamPipeToOptions
): Promise<number>
```

**Parameters:**
- `destination` - Writer to pipe to
- `options` - Optional configuration
  - `signal?: AbortSignal` - Cancellation signal
  - `limit?: number` - Maximum bytes to pipe
  - `preventClose?: boolean` - Don't close destination when done
  - `preventAbort?: boolean` - Don't abort destination on error
  - `preventCancel?: boolean` - Don't cancel source on destination error

**Returns:** `Promise<number>` - Total bytes piped

**Error Handling:**
- Source error: aborts destination (unless `preventAbort`)
- Destination error: cancels source (unless `preventCancel`)
- Signal abort: aborts destination and cancels source

---

### Cancellation

#### `stream.cancel(reason?)`

Cancel the stream (signal disinterest).

```typescript
async cancel(reason?: unknown): Promise<number>
```

**Parameters:**
- `reason` - Optional cancellation reason

**Returns:** `Promise<number>` - Bytes read before cancel

**Notes:**
- Idempotent (multiple calls safe)
- Subsequent reads return `done: true`
- Resolves `stream.closed` promise

---

### Low-level Read Access

#### `stream.read(options?)`

Read bytes from stream with fine-grained control.

```typescript
async read(options?: StreamReadOptions): Promise<StreamReadResult>
```

**Parameters:**
- `options.buffer?: Uint8Array` - BYOB: provide your own buffer
- `options.max?: number` - Maximum bytes to return
- `options.atLeast?: number` - Wait for at least this many bytes
- `options.signal?: AbortSignal` - Cancellation signal

**Returns:** `Promise<StreamReadResult>`
- `value: Uint8Array | null` - Bytes read (null only when done with no final bytes)
- `done: boolean` - True when stream has ended

**Notes:**
- `value` can be non-null even when `done` is true (final chunk)
- BYOB mode: provided buffer is detached after call
- Concurrent reads are queued and executed in order

**Example:**
```typescript
// Basic read
const { value, done } = await stream.read();

// With constraints
const { value } = await stream.read({ 
  atLeast: 10,
  max: 100 
});

// BYOB mode
const myBuffer = new Uint8Array(1024);
const { value } = await stream.read({ buffer: myBuffer });
```

---

### Stream Properties

#### `stream.closed`

Promise that resolves when stream closes.

```typescript
readonly closed: Promise<number>
```

**Returns:** `Promise<number>` - Total bytes read when resolved

**Notes:**
- Rejects if stream errors
- Marked as handled (no unhandled rejection warnings)

---

#### `stream.detached`

Whether this stream is detached.

```typescript
readonly detached: boolean
```

---

#### `stream[Symbol.asyncIterator]()`

Async iteration support.

```typescript
async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array>
```

**Example:**
```typescript
for await (const chunk of stream) {
  process(chunk);
}
```

---

#### `stream[Symbol.asyncDispose]()`

Explicit resource management (calls `cancel()`).

```typescript
async [Symbol.asyncDispose](): Promise<void>
```

**Example:**
```typescript
{
  await using stream = Stream.from('data');
  // Use stream...
} // stream.cancel() called automatically
```

---

## Writer Class

```typescript
class Writer
```

Writes data to a push stream or custom sink.

### Writer Methods

#### `writer.write(data, options?)`

Write bytes or string to the stream.

```typescript
async write(data: string | BufferSource, options?: WriterWriteOptions): Promise<void>
```

**Parameters:**
- `data` - Data to write (strings encoded using writer's encoding)
- `options.signal?: AbortSignal` - Cancellation signal

**Notes:**
- BufferSource arguments are **detached** after call
- Throws if writer is closed or aborted
- Respects buffer backpressure

---

#### `writer.writev(chunks, options?)`

Write multiple chunks atomically.

```typescript
async writev(
  chunks: Array<string | BufferSource>,
  options?: WriterWriteOptions
): Promise<void>
```

**Parameters:**
- `chunks` - Array of data chunks
- `options.signal?: AbortSignal` - Cancellation signal

**Notes:**
- All BufferSource arguments are **detached** after call
- For sinks, concatenated into single write for atomicity

---

#### `writer.flush(options?)`

Synchronization point; resolves when all prior writes complete.

```typescript
async flush(options?: WriterWriteOptions): Promise<void>
```

**Parameters:**
- `options.signal?: AbortSignal` - Cancellation signal

---

#### `writer.close()`

Signal end of stream.

```typescript
async close(): Promise<number>
```

**Returns:** `Promise<number>` - Total bytes written

**Notes:**
- Idempotent (multiple calls safe)
- Resolves `writer.closed` promise

---

#### `writer.abort(reason?)`

Signal error and cancel stream.

```typescript
async abort(reason?: unknown): Promise<number>
```

**Parameters:**
- `reason` - Error or reason for abort

**Returns:** `Promise<number>` - Bytes written before abort

**Notes:**
- Subsequent writes will reject
- Rejects `writer.closed` promise

---

### Writer Properties

#### `writer.closed`

Promise that resolves when writer is closed.

```typescript
readonly closed: Promise<number>
```

**Returns:** `Promise<number>` - Total bytes written when resolved

**Notes:**
- Rejects if aborted or errored
- Marked as handled (no unhandled rejection warnings)

---

#### `writer.desiredSize`

Bytes available before buffer limit.

```typescript
readonly desiredSize: number | null
```

**Returns:**
- `number` - Available space (can be negative if over limit)
- `null` - If writer is closed

---

#### `writer[Symbol.asyncDispose]()`

Explicit resource management (calls `close()`).

```typescript
async [Symbol.asyncDispose](): Promise<void>
```

**Example:**
```typescript
{
  await using writer = Stream.push()[1];
  await writer.write('data');
} // writer.close() called automatically
```

---

## StreamWithWriter Class

Result type for `Stream.push()` and `Stream.transform()`.

```typescript
class StreamWithWriter {
  readonly stream: Stream;
  readonly writer: Writer;
}
```

Supports both array and object destructuring:

```typescript
// Array destructuring
const [stream, writer] = Stream.push();

// Object destructuring  
const { stream, writer } = Stream.push();
```

---

## Types

### BufferSource

```typescript
type BufferSource = ArrayBuffer | ArrayBufferView;
```

### StreamWriteData

Data that can be written (auto-converted to Uint8Array).

```typescript
type StreamWriteData = BufferSource | string;
```

### StreamOverflowPolicy

```typescript
type StreamOverflowPolicy = 'error' | 'block' | 'drop-oldest' | 'drop-newest';
```

- `'error'` - Reject writes when buffer is full
- `'block'` - Block writes until space available
- `'drop-oldest'` - Discard oldest buffered data
- `'drop-newest'` - Discard data being written

### StreamTransformer

```typescript
type StreamTransformer = StreamTransformCallback | StreamTransformerObject;

type StreamTransformCallback = (chunk: Uint8Array | null) => StreamTransformResult;

interface StreamTransformerObject {
  transform(chunk: Uint8Array | null): StreamTransformResult;
  abort?(reason?: unknown): void;
}
```

**Transform Function:**
- Receives `Uint8Array` chunks
- Receives `null` as flush signal when input ends
- Can return:
  - `Uint8Array` - Emitted as-is
  - `string` - Encoded and emitted
  - `null` / `undefined` - Nothing emitted
  - `Iterable` / `AsyncIterable` - Each element emitted
  - `Promise` - Awaited, then processed
  - `Generator` / `AsyncGenerator` - Each yield emitted

### StreamReadResult

```typescript
interface StreamReadResult {
  value: Uint8Array | null;
  done: boolean;
}
```

### WriterSink

```typescript
interface WriterSink {
  write(chunk: Uint8Array): Promise<void>;
  close?(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}
```

---

## Options Objects

### StreamBufferOptions

```typescript
interface StreamBufferOptions {
  /** Soft limit: backpressure threshold */
  max?: number;
  /** Hard limit: error if exceeded (block mode only) */
  hardMax?: number;
  /** Policy when buffer exceeds max */
  onOverflow?: StreamOverflowPolicy;
}
```

### StreamPullOptions

```typescript
interface StreamPullOptions {
  /** Encoding for strings (default: "utf-8") */
  encoding?: string;
}
```

### StreamPushOptions

```typescript
interface StreamPushOptions {
  /** Encoding for strings (default: "utf-8") */
  encoding?: string;
  /** Buffer configuration */
  buffer?: StreamBufferOptions;
}
```

### StreamFromOptions

```typescript
interface StreamFromOptions {
  /** Encoding for strings (default: "utf-8") */
  encoding?: string;
}
```

### StreamTransformOptions

```typescript
interface StreamTransformOptions {
  /** Encoding for output strings (default: "utf-8") */
  encoding?: string;
  /** Fixed input chunk size (except final chunk) */
  chunkSize?: number;
  /** Output buffer configuration */
  buffer?: StreamBufferOptions;
}
```

### StreamPipeOptions

```typescript
interface StreamPipeOptions {
  signal?: AbortSignal;
  chunkSize?: number;
  buffer?: StreamBufferOptions;
  /** Maximum bytes to pipe through */
  limit?: number;
}
```

### StreamPipeToOptions

```typescript
interface StreamPipeToOptions {
  signal?: AbortSignal;
  /** Maximum bytes to pipe */
  limit?: number;
  /** Don't close destination when source ends */
  preventClose?: boolean;
  /** Don't abort destination when source errors */
  preventAbort?: boolean;
  /** Don't cancel source when destination errors */
  preventCancel?: boolean;
}
```

### StreamConsumeOptions

```typescript
interface StreamConsumeOptions {
  signal?: AbortSignal;
}
```

### StreamTeeOptions

```typescript
interface StreamTeeOptions {
  buffer?: StreamBufferOptions;
  /** Create detached (inactive) branch */
  detached?: boolean;
}
```

### StreamReadOptions

```typescript
interface StreamReadOptions {
  /** BYOB: provide your own buffer */
  buffer?: Uint8Array;
  /** Maximum bytes to return */
  max?: number;
  /** Wait for at least this many bytes */
  atLeast?: number;
  signal?: AbortSignal;
}
```

### StreamPipelineOptions

```typescript
interface StreamPipelineOptions {
  signal?: AbortSignal;
  limit?: number;
  preventClose?: boolean;
}
```

### WriterWriteOptions

```typescript
interface WriterWriteOptions {
  signal?: AbortSignal;
}
```

---

## Supported Encodings

The API supports the following text encodings:

| Encoding | Aliases |
|----------|---------|
| `utf-8` | `utf8` (default) |
| `utf-16le` | `utf-16`, `ucs-2` |
| `utf-16be` | |
| `iso-8859-1` | `latin1`, `latin-1` |
| `windows-1252` | `cp1252` |

And other single-byte encodings supported by `TextDecoder`.

---

## Error Handling

### Error Propagation

- **Source errors** propagate forward to consumers
- **Consumer errors** propagate back to source (cancel)
- **Pipeline errors** tear down all stages
- **Bidirectional propagation** in `pipeTo()`:
  - Source error → abort destination
  - Destination error → cancel source

### AbortSignal Behavior

When an `AbortSignal` is aborted:
- Pending reads reject with `AbortError`
- Pending writes reject with `AbortError`
- `pipeTo()` aborts destination and cancels source
- Resources are cleaned up

### Promise Handling

Both `stream.closed` and `writer.closed` are marked as handled internally, so they won't cause unhandled promise rejection warnings if not awaited.

---

## Buffer Detachment

When writing `BufferSource` data (ArrayBuffer, TypedArray views):
- The source buffer is **detached** (transferred)
- The original ArrayBuffer becomes zero-length
- This ensures no accidental data modification after write

```typescript
const buffer = new Uint8Array([1, 2, 3]);
await writer.write(buffer);
console.log(buffer.byteLength); // 0 (detached)
```

---

## Explicit Resource Management

Both `Stream` and `Writer` implement `Symbol.asyncDispose` for use with `await using`:

```typescript
// Stream: cancel() called on exit
{
  await using stream = Stream.pull(...);
  const data = await stream.take(100).bytes();
} // Automatically cancelled

// Writer: close() called on exit
{
  await using writer = Stream.push()[1];
  await writer.write('data');
} // Automatically closed
```

This ensures proper cleanup even when exceptions occur.
