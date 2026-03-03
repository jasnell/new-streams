# Design Trade-offs in the New Stream API

This document discusses how the new Stream API handles features present in Node.js
streams or Web Streams. Some features are intentionally omitted, while others are
reimagined with different (often simpler) approaches that better align with the API's
core principles.

## Table of Contents

1. [BYOB (Bring Your Own Buffer)](#1-byob-bring-your-own-buffer) - Omitted
2. [Object Mode / Value Streams](#2-object-mode--value-streams) - Omitted
3. [Duplex Streams](#3-duplex-streams) - Reimagined as `Stream.duplex()`
4. [Cork/Uncork Write Batching](#4-corkuncork-write-batching) - Replaced by `writev()`
5. [Custom Queuing Strategies](#5-custom-queuing-strategies) - Simplified
6. [Range Requests and Seeking](#6-range-requests-and-seeking) - Out of scope
7. [Drain Events / Push-Back Notification](#7-drain-events--push-back-notification) - Reimagined as `Stream.ondrain()`
8. [Synchronous Push Streams](#8-synchronous-push-streams) - Omitted (fundamentally async)

---

## 1. BYOB (Bring Your Own Buffer)

### What It Is

BYOB (Bring Your Own Buffer) allows consumers to provide pre-allocated buffers for reads,
theoretically enabling zero-copy operations and reduced garbage collection pressure.

**Web Streams example:**
```javascript
const reader = stream.getReader({ mode: 'byob' });
const buffer = new ArrayBuffer(1024);
const { value, done } = await reader.read(new Uint8Array(buffer));
// value is a view into the same buffer - no allocation (in theory)
```

### Why It's Omitted

The new API is explicitly **chunk-oriented, not byte-oriented** (Design Principle P9).
Beyond the architectural rationale, there are significant practical reasons for this choice.

#### The BYOB Implementation Problem

In Web Streams, BYOB support is **optional for stream implementations**. A stream source
can declare `type: 'bytes'` but still ignore the `controller.byobRequest` entirely,
choosing instead to use `controller.enqueue()`.

```javascript
// A "BYOB-capable" stream that doesn't actually use BYOB
new ReadableStream({
  type: 'bytes',
  async pull(controller) {
    const data = await fetchData();
    // Implementer ignores byobRequest and just enqueues
    controller.enqueue(data);

    // What they SHOULD do (but often don't):
    // const byobRequest = controller.byobRequest;
    // if (byobRequest) {
    //   data.copy(byobRequest.view);
    //   byobRequest.respond(data.length);
    // } else {
    //   controller.enqueue(data);
    // }
  }
});
```

Stream implementations that **do** properly support `byobRequest` must still handle
the case where a default reader (non-BYOB) is used, requiring two code paths. This
complexity discourages proper implementation, resulting in a situation where:

- **Consumers** write more complex code expecting zero-copy benefits
- **Producers** often don't actually provide those benefits
- **Neither side** can easily verify whether BYOB is actually working

In practice, streams that truly support BYOB reads are rare.

#### Architectural Reasons

Beyond the practical implementation issues:

1. **Simpler mental model**: Consumers process complete chunks without managing partial
   reads, minimum byte counts, or buffer lifecycle.

2. **Batched iteration**: The `Uint8Array[]` yield model amortizes async overhead by
   delivering multiple chunks per iteration. BYOB would require byte-level granularity
   that conflicts with this batching.

3. **No partial fill handling**: BYOB readers must handle cases where the buffer is
   partially filled. Eliminating this removes an entire class of edge cases.

4. **Alignment with KJ async-io**: The KJ library's streaming model (which this API
   aligns with) is similarly chunk-oriented rather than byte-oriented.

#### The New API Is Already Zero-Copy

It's important to understand what "zero-copy" actually means in this context. The new
streams API **is inherently zero-copy**: it treats `Uint8Array` chunks as opaque values
and passes them by reference through the entire pipeline. When data flows from source
through transforms to consumers, the same `Uint8Array` instances are passed along
without copying.

```typescript
// Data flows by reference - no copying
const pipeline = Stream.pull(source, transform1, transform2);
for await (const chunks of pipeline) {
  // These are the same Uint8Array instances produced upstream,
  // passed by reference through the pipeline
}
```

Note that transforms which modify data will naturally produce new `Uint8Array`
instances—that's their intent. A transform's purpose is to produce different output
than its input. Pass-through transforms (like `Stream.tap()` for observation) preserve
the original chunks and maintain zero-copy semantics.

```typescript
// Observation: zero-copy, chunks pass through unchanged
const observed = Stream.pull(source, Stream.tap(chunks => log(chunks)));

// Transformation: new buffers created, by design
const encrypted = Stream.pull(source, chunks => {
  if (chunks === null) return null;
  return chunks.map(chunk => encrypt(chunk));  // New Uint8Arrays expected
});
```

BYOB's notion of "zero-copy" is different—it's from the **consumer's perspective**:
"fill my buffer so I can reuse it across multiple reads." But calling this "zero-copy"
is misleading:

1. **The allocation still happens**: The consumer must allocate the `Uint8Array` that
   gets passed to `read()`. BYOB doesn't eliminate allocation—it allows the consumer
   to *reuse* that same buffer across multiple read operations if orchestrated correctly.

2. **Data still gets copied**: The producer typically has data in its own buffer and
   must copy it *into* the consumer-provided `Uint8Array`. The copy still happens
   on every read; only the allocation can potentially be amortized across reads.

3. **Benefit is reduced GC pressure, not zero-copy**: When properly implemented on both
   sides (which is rare in practice), BYOB can reduce allocation frequency by reusing
   buffers. This is "bring your own buffer to reuse" not "zero-copy."

4. **Promise overhead offsets the benefit**: While BYOB aims to reduce GC pressure
   through buffer reuse, Web Streams' reliance on promises and microtask continuations
   for each individual chunk creates its own GC pressure. The overhead from promise
   allocations often offsets any gains from buffer reuse.

The new streams API addresses GC pressure more effectively through different mechanisms:

- **Batched iteration (`Uint8Array[]`)**: Yields multiple chunks per async iteration,
  amortizing promise overhead across many chunks rather than one promise per chunk.

- **Synchronous pipeline path**: `Stream.pullSync()`, `Stream.bytesSync()`, and related
  sync APIs eliminate promise overhead entirely for in-memory or CPU-bound workloads.

These approaches reduce GC pressure in ways that are both more effective and more
reliably achieved than BYOB's buffer reuse model.

### Trade-off

**What's different:** Consumer-side buffer reuse is not supported. Applications that
want to reduce allocation pressure by reusing read buffers cannot do so through the
streaming API itself.

**What's preserved:** True zero-copy semantics (pass-by-reference) are maintained
throughout the pipeline. The chunks produced by sources flow through transforms and
to consumers without being copied.

**What's gained:** A dramatically simpler API with no `byobRequest`, no `respond()`,
no buffer lifecycle management, no minimum/maximum byte parameters. The API doesn't
promise "zero-copy" semantics that are misleading about what's actually happening.

### Workarounds

For high-performance scenarios requiring buffer reuse, implement buffer pooling at the
application level:

```typescript
const bufferPool = new BufferPool();

for await (const chunks of readable) {
  for (const chunk of chunks) {
    const pooledBuffer = bufferPool.acquire(chunk.byteLength);
    pooledBuffer.set(chunk);
    process(pooledBuffer);
    bufferPool.release(pooledBuffer);
  }
}
```

This is more explicit but keeps buffer management concerns separate from streaming logic.

---

## 2. Object Mode / Value Streams

### What It Is

Object mode allows streaming arbitrary JavaScript values rather than bytes, with
`highWaterMark` counting items rather than bytes.

**Node.js example:**
```javascript
const transform = new Transform({
  objectMode: true,
  transform(record, encoding, callback) {
    callback(null, { ...record, processed: true });
  }
});
```

### Why It's Omitted

The new API is **bytes only** (Design Principle P8). This decision:

1. **Eliminates type ambiguity**: Every stream operation works with `Uint8Array`. No
   runtime checks for "is this bytes or objects?" No mixed-mode confusion.

2. **Enables consistent semantics**: Backpressure, buffering, and transforms have
   uniform behavior. Object mode in Node.js has subtly different semantics that
   surprise developers.

3. **Simplifies interop**: Byte streams map directly to I/O primitives, network
   protocols, and file systems. Object streams are application-level abstractions.

4. **JavaScript already has object iteration**: `AsyncIterable<T>` provides a natural,
   well-supported mechanism for streaming arbitrary values.

### Trade-off

**Lost capability:** Cannot use `Stream.pull()`, `Stream.pipeTo()`, `Stream.share()`,
or `Stream.merge()` with object streams. Unified API benefits don't extend to objects.

**Gained clarity:** The API is unambiguous about its domain (bytes). Object streaming
uses standard JavaScript patterns that developers already know.

### Workarounds

Use async iterables directly for object streaming:

```typescript
// Object transform pipeline
async function* mapObjects<T, U>(
  source: AsyncIterable<T>,
  transform: (item: T) => U | Promise<U>
): AsyncIterable<U> {
  for await (const item of source) {
    yield await transform(item);
  }
}

// Usage
const processed = mapObjects(databaseCursor, record => ({
  ...record,
  processedAt: Date.now()
}));

for await (const record of processed) {
  console.log(record);
}
```

For multi-consumer object streams, libraries like `IxJS` or custom implementations
provide the equivalent of `Stream.share()` for async iterables.

---

## 3. Duplex Streams

### What It Is

Duplex streams represent bidirectional communication channels where both sides can
read and write independently.

**Node.js example:**
```javascript
class Protocol extends Duplex {
  _read() { /* receive from peer */ }
  _write(chunk, enc, cb) { /* send to peer */ }
}

const connection = new Protocol();
connection.write('request');
connection.on('data', handleResponse);
```

### How It's Reimagined

Rather than a monolithic `Duplex` class requiring inheritance, the new API provides
`Stream.duplex()` which creates a **pair** of connected channels. This approach:

1. **Composition over inheritance**: No need to subclass. Create channels and wire
   them to your protocol as needed.

2. **Clearer data flow**: Each channel has a distinct `writer` (send) and `readable`
   (receive). Data direction is explicit.

3. **Independent backpressure**: Each direction can have its own `highWaterMark` and
   backpressure policy via the `a` and `b` options.

4. **Error isolation**: Closing or erroring one direction doesn't affect the other.

5. **Modern resource management**: Channels implement `AsyncDisposable` for use with
   `await using`.

### The `Stream.duplex()` Approach

The API provides `Stream.duplex()` which creates a connected pair of duplex channels,
similar to Unix `socketpair()`. Each channel has a writer and readable, with data
written to one channel appearing in the other's readable:

```typescript
import { Stream } from 'new-streams';

// Create a connected pair of duplex channels
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

Each direction can have independent configuration:

```typescript
// High-throughput server responses, low-throughput client requests
const [client, server] = Stream.duplex({
  a: { highWaterMark: 2 },   // Client→Server: small buffer
  b: { highWaterMark: 16 },  // Server→Client: larger buffer for responses
});
```

For protocols requiring correlated request-response, consider implementing correlation
at the application layer rather than the stream layer.

---

## 4. Cork/Uncork Write Batching

### What It Is

Cork/uncork provides explicit control over when buffered writes are flushed to the
underlying resource.

**Node.js example:**
```javascript
socket.cork();
socket.write(header);
socket.write(body);
socket.uncork();  // Both writes sent as single packet
```

### Why It's Omitted

The new API provides `writev()` for atomic batch writes instead of cork/uncork:

1. **Explicit batching**: `writev()` makes batching explicit at the call site rather
   than relying on stateful cork/uncork pairing.

2. **No forgotten uncork**: A common bug with cork/uncork is forgetting to uncork,
   causing data to buffer indefinitely.

3. **No nested cork issues**: Multiple cork calls require matching uncork calls.
   This complexity is eliminated.

4. **Simpler implementation**: Writers don't need internal cork state.

### Trade-off

**Lost capability:** Cannot incrementally build up a batch across multiple code paths.
All chunks must be collected before calling `writev()`.

**Gained safety:** Impossible to leave the stream in a corked state. Batching intent
is always explicit and localized.

### Workarounds

Collect writes and use `writev()`:

```typescript
// Instead of cork/uncork
class MessageBuilder {
  private chunks: Uint8Array[] = [];

  addHeader(header: Uint8Array) {
    this.chunks.push(header);
  }

  addBody(body: Uint8Array) {
    this.chunks.push(body);
  }

  async send(writer: Writer) {
    await writer.writev(this.chunks);
    this.chunks = [];
  }
}
```

---

## 5. Custom Queuing Strategies

### What It Is

Custom queuing strategies allow fine-grained control over backpressure calculation.

**Web Streams example:**
```javascript
const customStrategy = {
  highWaterMark: 1000,
  size(chunk) {
    return chunk.priority === 'high' ? 1 : 10;  // Priority items cost less
  }
};
```

### Why It's Omitted

The new API counts **write operations**, not bytes or custom sizes:

1. **Predictable behavior**: `highWaterMark: 10` always means "10 pending writes."
   No surprises from variable chunk sizes.

2. **Simpler reasoning**: Developers don't need to understand how their size function
   affects backpressure thresholds.

3. **Memory already allocated**: Since chunks are already `Uint8Array` in memory,
   byte-based backpressure doesn't prevent memory growth—it just delays processing.
   Operation counting is equally valid and simpler.

4. **No size function bugs**: Custom size functions that return wrong values cause
   subtle backpressure issues. Eliminating this removes a bug category.

### Trade-off

**Lost capability:** Cannot implement byte-based backpressure, priority queuing, or
memory-budget-aware streaming within the API.

**Gained simplicity:** Backpressure is completely predictable. `highWaterMark: N`
means N pending operations, always.

### Workarounds

For byte-aware backpressure, implement at the application level. Writer is just
an interface, you can implement your own Writers that implement buffering any
way you'd like as long as they respect the Writer interface and expected behavior.

```typescript
class ByteAwareWriter {
  private pendingBytes = 0;
  private readonly maxBytes: number;

  constructor(private writer: Writer, maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  async write(chunk: Uint8Array) {
    while (this.pendingBytes + chunk.byteLength > this.maxBytes) {
      await this.drain();
    }
    this.pendingBytes += chunk.byteLength;
    await this.writer.write(chunk);
    this.pendingBytes -= chunk.byteLength;
  }
}
```

---

## 6. Range Requests and Seeking

### What It Is

Range requests allow reading specific byte ranges from a source, enabling video
seeking, download resumption, and partial content retrieval.

**Node.js example:**
```javascript
fs.createReadStream('video.mp4', { start: 1000000, end: 2000000 })
```

### Why It's Omitted

The new API is a **sequential iteration abstraction**, not a random-access abstraction:

1. **Separation of concerns**: Positioning is a property of the underlying resource
   (file, HTTP endpoint), not the stream. The stream handles flow, not addressing.

2. **Not universally applicable**: Many sources (network responses, pipes, generators)
   don't support seeking. Making it a stream feature would create APIs that throw
   "not supported" for most sources.

3. **HTTP Range is transport-level**: Range requests are specified in HTTP headers
   before the stream even exists. The resulting stream is still sequential.

### Trade-off

**Lost capability:** No unified API for "give me bytes N through M." Each source type
requires its own range handling.

**Gained focus:** The Stream API does one thing well: sequential byte streaming with
backpressure.

### Workarounds

Implement range support at the source level:

```typescript
async function* rangeReader(url: string, start: number, end: number) {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` }
  });
  for await (const chunk of response.body) {
    yield chunk;
  }
}

const partial = Stream.from(rangeReader(videoUrl, 1000000, 2000000));
```

For files, use platform APIs that support seeking, then wrap the result.

---

## 7. Drain Events / Push-Back Notification

### What It Is

Drain events notify producers when a previously-full buffer has space, allowing
efficient integration with event-based sources.

**Node.js example:**
```javascript
source.on('data', (chunk) => {
  const ok = writable.write(chunk);
  if (!ok) {
    source.pause();
    writable.once('drain', () => source.resume());
  }
});
```

### How It's Reimagined

Rather than event-based drain notification, the new API provides `Stream.ondrain()`
which returns a promise. This approach:

1. **Promise-based, not event-based**: No event handlers to register or clean up.
   No risk of listener leaks.

2. **Works with async/await**: Fits naturally into modern JavaScript control flow.

3. **Protocol-based**: Any object implementing the `Drainable` protocol can work with
   `ondrain()`. Writers from `Stream.push()` and `Stream.broadcast()` implement this
   automatically.

4. **Null-safe**: `await Stream.ondrain(x)` works even if `x` doesn't support the
   protocol (returns `null`, which is falsy).

5. **Rich return value**: Returns `true` (ready), `false` (closed), or rejects (error),
   giving callers complete information about the drain state.

### The `Stream.ondrain()` Approach

`Stream.ondrain()` provides efficient integration with event-driven sources by returning
a promise that resolves when backpressure clears:

```typescript
const { writer, readable } = Stream.push({ highWaterMark: 4 });

// Consume in background
const consumePromise = Stream.text(readable);

// Event source integration with ondrain
eventSource.on('data', async (chunk) => {
  if (writer.desiredSize === 0) {
    eventSource.pause();
    // await works on null (returns null), and null is falsy
    const canWrite = await Stream.ondrain(writer);
    if (!canWrite) {
      // Writer closed or doesn't support drain
      eventSource.destroy();
      return;
    }
    eventSource.resume();
  }
  await writer.write(chunk);
});

eventSource.on('end', () => writer.end());
eventSource.on('error', (err) => writer.fail(err));
```

The `ondrain()` function:
- Returns `null` if the object doesn't support drain notification (or `desiredSize` is `null`)
- Returns a resolved `Promise<true>` if ready to write (`desiredSize > 0`)
- Returns a pending `Promise<true>` that resolves when backpressure clears
- Returns `Promise<false>` if the writer closes while waiting
- Rejects if the writer errors while waiting

Since `await null` returns `null` (which is falsy), the pattern `const canWrite = await Stream.ondrain(x)`
works correctly without explicit `null` checking. Only check for `null` explicitly when you need to
distinguish "protocol not supported" from "writer closed".

### Alternative: Using async iteration

For event-based sources that can be adapted to async iteration:

```typescript
const { writer, readable } = Stream.push({ backpressure: 'block' });

// Event source integration
async function pumpEvents(eventSource: EventEmitter) {
  for await (const event of on(eventSource, 'data')) {
    await writer.write(event.data);  // Awaiting handles backpressure
  }
  await writer.end();
}
```

### Anti-pattern: Polling desiredSize

Avoid polling `desiredSize` - use `ondrain()` instead:

```typescript
// BAD: Polling wastes CPU
setInterval(() => {
  if (writer.desiredSize > 0) {
    const chunk = getNextChunk();
    if (chunk) writer.writeSync(chunk);
  }
}, 10);

// GOOD: Use ondrain() instead
if (writer.desiredSize === 0) {
  const canWrite = await Stream.ondrain(writer);
  if (!canWrite) return; // closed or unsupported
}
```

---

## 8. Synchronous Push Streams

### What It Is

A synchronous push stream would allow producers to push data to consumers without
async coordination.

### Why It's Omitted

Push streams are **inherently asynchronous**:

1. **Producer-consumer timing**: Push means "data arrives when the producer decides."
   This requires coordination between independent timing—fundamentally async.

2. **Backpressure requires waiting**: When a push stream is full, the producer must
   wait. Waiting is an async operation.

3. **Sync pull exists**: `Stream.pullSync()` exists because pull semantics work
   synchronously—the consumer controls timing. Push cannot have this property.

4. **No sync await**: JavaScript has no synchronous await mechanism. Push-with-backpressure
   requires some form of waiting.

### Trade-off

**Lost capability:** Cannot do purely synchronous push-based streaming.

**Gained correctness:** The API doesn't pretend sync push is possible when it isn't.

### Workarounds

For synchronous data flow, use pull-based patterns:

```typescript
// Sync pull: consumer controls timing
const source = Stream.fromSync(function* () {
  yield chunk1;
  yield chunk2;
  yield chunk3;
});

const result = Stream.bytesSync(source);
```

If you truly have a synchronous producer that generates data faster than it can be
consumed, the fundamental problem is that you need buffering (memory) or dropping.
Both are async concerns. Consider whether your use case actually requires sync push
or if sync pull would suffice.

---

## Summary

| Feature | Status | Approach in New API |
|---------|--------|---------------------|
| BYOB readers | Omitted | Application-level buffer pooling; API is already zero-copy |
| Object mode | Omitted | Use async iterables directly for non-byte data |
| Duplex streams | **Reimagined** | `Stream.duplex()` creates connected channel pairs |
| Cork/uncork | Replaced | `writev()` for explicit atomic batching |
| Custom queuing | Simplified | Operation-count backpressure; custom `Writer` implementations |
| Range/seeking | Out of scope | Source-level implementation (fetch headers, fs options) |
| Drain events | **Reimagined** | `Stream.ondrain()` returns promise-based notification |
| Sync push | Omitted | Use sync pull patterns (`Stream.pullSync()`, etc.) |

### Design Philosophy

The new API takes three approaches to features from Node.js/Web Streams:

1. **Omitted**: Features that conflict with core principles (bytes-only, chunk-oriented)
   or are better handled elsewhere (object streaming via async iterables).

2. **Reimagined**: Features that are valuable but benefit from a fresh approach
   (`Stream.duplex()` for bidirectional channels, `Stream.ondrain()` for drain
   notification) that better fits promise-based, composition-oriented design.

3. **Simplified**: Features where the original complexity isn't justified (custom
   queuing strategies) or where explicit alternatives are clearer (`writev()` vs
   cork/uncork).

Where functionality is needed beyond what the API provides, complexity is pushed to
the appropriate layer (application code, source implementation, or async iterables)
rather than complicating the streaming primitive.
