# Redesigning the Web Streams API

**Status:** Design exploration
**Author:** (design discussion)
**Date:** January 2026

## Executive Summary

The WHATWG Streams Standard[^1] provides a foundation for streaming data on the web platform, but
suffers from significant usability issues stemming from its design predating async iteration and
from attempting to serve too many use cases with a single complex abstraction. This document
explores practical improvements that could form the basis of a next-generation streams API.

## Table of Contents

1. [Background](#1-background)
2. [Criticisms of the Current Spec](#2-criticisms-of-the-current-spec)
3. [Pathological Antipatterns Encouraged by the API](#3-pathological-antipatterns-encouraged-by-the-api)
4. [Case Studies: Real-World Failures](#4-case-studies-real-world-failures)
5. [Implementation Challenges and Workarounds](#5-implementation-challenges-and-workarounds)
6. [Design Principles for Improvement](#6-design-principles-for-improvement)
7. [Proposed API Design](#7-proposed-api-design)
8. [WebIDL Interface Definitions](#8-webidl-interface-definitions)
9. [Implementation Optimization Opportunities](#9-implementation-optimization-opportunities)
10. [System Stream Use Cases](#10-system-stream-use-cases)
11. [Migration and Compatibility](#11-migration-and-compatibility)
12. [API Comparison: New Stream vs Web Streams](#12-api-comparison-new-stream-vs-web-streams)
13. [Potential Pitfalls of the New API](#13-potential-pitfalls-of-the-new-api)
14. [Design Validation: Addressing Identified Issues](#14-design-validation-addressing-identified-issues)
15. [Open Questions](#15-open-questions)
16. [References](#16-references)
17. [Document History](#17-document-history)

---

## 1. Background

The Streams Standard was developed to provide "APIs for creating, composing, and consuming streams
of data that map efficiently to low-level I/O primitives."[^1] The standard defines three stream
types:

- **ReadableStream**: Represents a source of data
- **WritableStream**: Represents a destination for data
- **TransformStream**: A pair connecting a writable input to a readable output

The API was designed circa 2014-2016, before JavaScript had native async iteration (`for await...of`,
added in ES2018). This timing significantly influenced the design, resulting in an explicit
reader/writer acquisition model rather than leveraging language-level iteration primitives.

---

## 2. Criticisms of the Current Spec

### 1. Excessive Ceremony for Common Operations

The most frequent complaint is the amount of boilerplate required for simple tasks.

**Reading a stream to completion:**

```javascript
const reader = stream.getReader();
const chunks = [];
try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
} finally {
  reader.releaseLock();
}
```

This pattern appears repeatedly in real-world code. The `{ value, done }` iterator protocol result
object adds verbosity, and the manual lock management is error-prone.

Jake Archibald noted in his 2016 streams introduction: "Because piping isn't supported yet,
combining the streams has to be done manually, making things a little messy."[^2] While piping was
later added, many common operations still require manual iteration.

### 2. Confusing Locking Semantics

Streams use a locking model where acquiring a reader or writer prevents other access:

- A locked stream cannot be read, cancelled, or piped
- Forgetting to call `releaseLock()` permanently breaks the stream
- The `locked` property indicates _that_ locking occurred but not _why_ or _by whom_
- Piping internally acquires locks, making streams unusable during pipe operations

This model was chosen to prevent interleaved reads, but creates footguns for developers who
don't understand the ownership implications.

### 3. Specification and Implementation Complexity

The Streams Standard is one of the most complex specifications on the web platform. The spec
document itself is over 100 pages of dense algorithmic prose, defining:

- **70+ abstract operations** with intricate interdependencies
- **Multiple state machines** for stream states (readable, closed, errored) and controller states
- **Complex promise wiring** between readers, controllers, and underlying sources/sinks

This complexity has real consequences:

**For implementers:**

- Browser engines have struggled with correct implementations; interoperability bugs persist years
  after the spec was finalized
- The reference implementation in the spec repository is thousands of lines of JavaScript
- Edge cases around error handling, cancellation, and backpressure are notoriously difficult to
  get right

**For spec authors integrating streams:**

- Other specifications (Fetch, File API, WebTransport, etc.) must use lengthy "set up" algorithms
  to create streams correctly
- The distinction between "JS-created" streams (via constructor) and "IDL-created" streams
  (via spec algorithms) adds another layer of complexity[^6]

**For polyfill authors:**

- Complete polyfills are tens of thousands of lines of code
- Matching spec behavior exactly requires implementing all the internal slots and algorithms

### 4. Controller API Complexity

The controller objects (`ReadableStreamDefaultController`, `ReadableByteStreamController`,
`WritableStreamDefaultController`) expose an awkward API that conflates multiple concerns:

**The controller is passed to user code but has limited utility:**

```javascript
new ReadableStream({
  start(controller) {
    // controller.enqueue() - useful
    // controller.close() - useful
    // controller.error() - useful
    // controller.desiredSize - confusing (can be null, 0, negative, or positive)
  },
  pull(controller) {
    // Same controller, but now we're expected to respond to backpressure
    // How do we know when to stop? Check desiredSize? Return a promise?
  },
});
```

**Problems with the controller model:**

1. **Inverted control flow**: The controller is passed _into_ callbacks rather than being
   something you call _out to_. This makes it hard to integrate with existing event-based APIs.

2. **`desiredSize` is confusing**: It can be `null` (closed), positive (wants data), zero
   (at capacity), or negative (over capacity). Developers must handle all cases.

3. **`pull()` semantics are non-obvious**: It's called when data is needed, but:
   - Only after `start()` completes
   - Only if `desiredSize > 0`
   - Not called again until the previous `pull()` promise resolves
   - These rules are documented but frequently misunderstood

4. **No way to "push back"**: If a push source produces data faster than it can be consumed,
   the only option is to let `desiredSize` go negative and hope the source checks it.

### 5. The Value/Byte Stream Dichotomy

The spec defines two fundamentally different stream types with different controllers:

| Aspect       | Value Streams                     | Byte Streams                   |
| ------------ | --------------------------------- | ------------------------------ |
| Controller   | `ReadableStreamDefaultController` | `ReadableByteStreamController` |
| Reader types | Default only                      | Default + BYOB                 |
| Chunk types  | Any JS value                      | `ArrayBufferView` only         |
| Creation     | `type: undefined`                 | `type: "bytes"`                |

This split creates several problems:

- **No conversion path**: You cannot easily convert a value stream to a byte stream or vice versa
- **`autoAllocateChunkSize` workaround**: This option exists solely to let byte streams behave
  like value streams when consumers use default readers—a workaround for the dichotomy itself

### 6. BYOB Reader Complexity

The "bring your own buffer" (BYOB) API for byte streams is particularly complex and error-prone.
The intent is to allow zero-copy reads by letting consumers provide buffers, but the reality
involves numerous subtle requirements:

**Buffer detachment semantics:**

```javascript
const reader = byteStream.getReader({ mode: 'byob' });
const buffer = new Uint8Array(1024);

// After this call, `buffer` is DETACHED and unusable
const { value, done } = await reader.read(buffer);

// `value` is a NEW Uint8Array viewing the same underlying memory
// but buffer.byteLength is now 0
console.log(buffer.byteLength); // 0 (detached!)
console.log(value.byteLength); // actual bytes read
```

This detachment behavior is necessary for safety but surprising to developers who expect to
reuse their buffer.

**Partial fill handling:**

BYOB reads may return fewer bytes than the buffer size. Developers must track how much was
filled and potentially issue multiple reads:

```javascript
async function readExactly(reader, size) {
  let buffer = new ArrayBuffer(size);
  let offset = 0;
  while (offset < size) {
    const view = new Uint8Array(buffer, offset, size - offset);
    const { value, done } = await reader.read(view);
    if (done) throw new Error('Unexpected end of stream');
    buffer = value.buffer; // Buffer may have been transferred!
    offset += value.byteLength;
  }
  return new Uint8Array(buffer);
}
```

**Sources can ignore BYOB requests:**

A readable byte stream source can choose to call `controller.enqueue()` instead of using
`controller.byobRequest`. In this case, the BYOB buffer is ignored and the implementation
must copy data from the enqueued chunk to the provided buffer:

```javascript
new ReadableStream({
  type: 'bytes',
  pull(controller) {
    // Source COULD use controller.byobRequest.view
    // But instead just enqueues data directly
    controller.enqueue(new Uint8Array([1, 2, 3]));
    // The stream implementation must now copy this to the BYOB buffer
  },
});
```

This means BYOB doesn't guarantee zero-copy—it merely _enables_ it for cooperative sources.

**`ReadableStreamBYOBRequest` complexity:**

The `byobRequest` object exposed to byte stream sources has its own lifecycle:

```javascript
new ReadableStream({
  type: 'bytes',
  pull(controller) {
    const request = controller.byobRequest;
    if (request) {
      // Fill request.view with data
      request.view.set(someData);
      request.respond(someData.length);
      // After respond(), request is invalidated
    } else {
      // No BYOB request pending, must enqueue normally
      controller.enqueue(someData);
    }
  },
});
```

The `byobRequest` can be `null` in several cases, requiring sources to handle both paths.

### 7. Backpressure Model Is Non-Intuitive

The backpressure mechanism uses `desiredSize`, defined as `highWaterMark - queueSize`:

- Positive `desiredSize` = space available, keep producing
- Zero or negative `desiredSize` = backpressure, stop producing

This inverted logic (where "desired" becomes negative) confuses developers. Additionally:

- The relationship between `highWaterMark` and actual memory usage is unclear
- The `size()` function in queuing strategies adds complexity
- There's no simple "pause/resume" primitive for push sources
- The `pull()` callback model requires understanding when it will and won't be called

### 8. Missing Common Combinators

Unlike Rust's `Iterator` trait, RxJS Observables, or even Node.js streams (with `pipeline()`),
Web Streams lack built-in combinators:

| Operation        | Web Streams            | Typical Stream Libraries |
| ---------------- | ---------------------- | ------------------------ |
| Map              | Manual TransformStream | `.map(fn)`               |
| Filter           | Manual TransformStream | `.filter(fn)`            |
| Take N items     | Manual with counter    | `.take(n)`               |
| Collect to array | Manual loop            | `.toArray()`             |
| Merge streams    | Not provided           | `.merge(s1, s2)`         |
| Concatenate      | Not provided           | `.concat(s1, s2)`        |

There are open proposals for some of these operations[^3], but they're not part of the core spec.

### 9. Tee Has Fundamental Memory Issues

The `tee()` method creates two branches from one stream. The spec states:

> "The backpressure signals from its two branches will aggregate, such that if neither branch is
> read from, a backpressure signal will be sent to the underlying source."[^1]

However, if branches are consumed at different rates, the faster branch's data must be buffered
for the slower branch. This buffer is unbounded—there's no way to:

- Limit the buffer size before blocking the faster consumer
- Drop data for a slow consumer
- Apply independent backpressure per branch

### 10. Transform Stream Awkwardness

Creating transforms requires verbose object literals:

```javascript
new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk.toUpperCase());
  },
});
```

For simple stateless transforms, this is excessive. Additionally:

- The `flush()` method's purpose isn't immediately obvious
- Error handling between readable and writable sides is complex
- There's no way to emit multiple chunks per input without multiple `enqueue()` calls
- The `{ readable, writable }` pair pattern requires destructuring everywhere

### 11. Error Handling Inconsistencies

The spec allows errors to be arbitrary JavaScript values, not just `Error` objects. This creates
problems:

- No guaranteed stack trace
- No standard way to check error types
- Confusion between `cancel()` (reader disinterest), `abort()` (writer error), and stream erroring

The distinction between these operations is subtle:

| Operation             | Who calls it | Meaning                    | Stream state after |
| --------------------- | ------------ | -------------------------- | ------------------ |
| `cancel(reason)`      | Consumer     | "I don't want more data"   | Closed             |
| `abort(reason)`       | Producer     | "I can't continue writing" | Errored            |
| `controller.error(e)` | Source/Sink  | "Something went wrong"     | Errored            |

### 12. Async Iteration Was Retrofitted

Async iteration support was added after the initial design[^4]. As a result:

- It's defined via `async_iterable<any>` in WebIDL, not as a core primitive
- The `preventCancel` option on the iterator is non-obvious
- Breaking out of a `for await` loop cancels the stream, which may not be desired
- There's no way to pass options (like timeout) through the iteration protocol

### 13. No Seekable Stream Support

The spec explicitly does not support seeking:

> "Readable streams are not seekable... if random access to a resource's bytes is required, the
> stream model does not apply."[^1]

This limitation means file I/O APIs must either:

- Use a different abstraction entirely
- Wrap streams with position tracking externally

There's an open proposal for adding seek support[^5], but it's not clear how it would integrate.

---

## 3. Pathological Antipatterns Encouraged by the API

Beyond usability issues, the Web Streams API's design actively encourages developers to write
code with serious correctness, performance, and reliability problems. These aren't edge cases—
they're the natural result of following the API's affordances.

### A1. "Read Everything First" Pattern

The ceremony required to iterate a stream encourages developers to collect all data before
processing:

```javascript
// The API practically begs you to write this
async function processStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  reader.releaseLock();

  // Now process all at once - defeating the purpose of streaming
  return processAllChunks(chunks);
}
```

**Why the API encourages this:**

- The `{ value, done }` destructuring is verbose for inline processing
- No built-in `toArray()` or `collect()` means everyone writes this loop
- The finally/releaseLock ceremony makes streaming processing look complicated
- No `.forEach()` or `.reduce()` methods for incremental processing

**Consequences:**

- Memory usage scales with total stream size, not chunk size
- Latency to first result equals total stream time
- Defeats the entire purpose of streaming

### A2. Unbounded Memory Accumulation

The default queuing strategy has no upper bound, and nothing warns developers about this:

```javascript
// This stream can consume unlimited memory
const stream = new ReadableStream({
  start(controller) {
    // Producer is fast
    setInterval(() => {
      controller.enqueue(generateLargeChunk()); // 1MB each
    }, 10);
  },
});

// Consumer is slow
for await (const chunk of stream) {
  await slowProcess(chunk); // Takes 1 second
}
// Queue grows by ~100MB/second until OOM
```

**Why the API encourages this:**

- Default `highWaterMark` is just a suggestion, not a limit
- `desiredSize` going negative doesn't stop `enqueue()` from working
- No built-in way to block the producer
- The "pull" model is documented but push sources are common in practice

**Consequences:**

- Memory exhaustion and OOM crashes
- Cascading failures in server environments
- Unpredictable latency spikes during GC

### A3. Forgotten Lock Leaks

The lock acquisition pattern makes it easy to permanently break streams:

```javascript
async function tryReadSome(stream) {
  const reader = stream.getReader();
  try {
    const { value } = await reader.read();
    if (!isValid(value)) {
      return null; // BUG: forgot to release lock!
    }
    // ... more processing
    reader.releaseLock();
    return result;
  } catch (e) {
    // BUG: forgot to release lock in error path!
    throw e;
  }
}

// Stream is now permanently locked and unusable
await anotherOperation(stream); // Throws: "Cannot read from a locked stream"
```

**Why the API encourages this:**

- Lock release is manual, not automatic via RAII/using
- Easy to forget in early returns and error paths
- The `finally` pattern isn't enforced or even shown in many examples
- No warning when a stream is garbage collected while locked

**Consequences:**

- Resource leaks that are hard to debug
- Streams become unusable mid-application
- No way to recover without recreating the stream

### A4. Ignoring Backpressure Entirely

The confusing `desiredSize` API means most developers simply ignore backpressure:

```javascript
// Real-world pattern: ignore backpressure completely
new ReadableStream({
  start(controller) {
    websocket.onmessage = (event) => {
      // Just enqueue regardless of buffer state
      controller.enqueue(event.data);
      // desiredSize? What's that?
    };
  },
});
```

**Why the API encourages this:**

- `desiredSize` is confusing (null? negative? what do I do?)
- Checking `desiredSize` before every `enqueue()` is tedious
- No simple "wait for space" primitive
- Push sources (WebSocket, EventSource, etc.) don't naturally fit the pull model
- The examples in tutorials often omit backpressure handling

**Consequences:**

- See A2 (unbounded memory)
- Slow consumers cause fast producer queues to explode
- No feedback mechanism to slow down upstream

### A5. Tee() for Unbalanced Consumers

`tee()` is often used when consumers have very different consumption rates:

```javascript
const [forLogging, forProcessing] = stream.tee();

// Logging consumer: fast, fire-and-forget
forLogging.pipeTo(logSink);

// Processing consumer: slow, careful
for await (const chunk of forProcessing) {
  await carefullyProcess(chunk); // Takes 10 seconds per chunk
}
// The logging branch buffers ALL data waiting for processing to catch up
```

**Why the API encourages this:**

- `tee()` is the only built-in way to "share" a stream
- No documentation warning about the unbounded buffer
- No alternative like bounded-buffer tee or lossy multicast
- The name "tee" (from Unix) implies lightweight copying

**Consequences:**

- Unbounded memory growth proportional to consumer speed difference
- The fast consumer is blocked waiting for the slow consumer
- No way to drop data for slow consumers

### A6. Silent Data Loss on Cancellation

Cancellation can lose data that's already been read but not processed:

```javascript
async function processWithTimeout(stream, timeout) {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        sleep(timeout).then(() => ({ timeout: true })),
      ]);

      if (result.timeout) {
        reader.cancel('timeout'); // Cancels the stream
        break;
      }

      if (result.done) break;
      process(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}
// If timeout fires AFTER read() resolved but BEFORE we processed,
// that chunk is silently lost
```

**Why the API encourages this:**

- `cancel()` is the only way to stop a stream
- No "pause" or "stop reading but keep data" option
- Racing promises is a common timeout pattern but has this footgun
- The spec doesn't define what happens to in-flight data

**Consequences:**

- Data corruption in protocols that require exactly-once delivery
- Difficult to reproduce bugs (timing-dependent)
- No way to "uncancel" or peek at buffered data

### A7. Promise Accumulation in Long-Running Streams

Long-lived streams can accumulate promises that never resolve:

```javascript
const stream = new ReadableStream({
  pull(controller) {
    // Return a promise that resolves when data is available
    return new Promise((resolve) => {
      eventSource.once('data', (data) => {
        controller.enqueue(data);
        resolve();
      });
    });
  },
});

// Used for hours/days in a server process
for await (const chunk of stream) {
  // Each iteration creates promises in the stream internals
  // These accumulate over time
}
```

**Why the API encourages this:**

- The pull() promise chain is internal and invisible
- No lifecycle management for long-running streams
- Reader/stream internal slots accumulate state
- No documentation of memory characteristics over time

**Consequences:**

- Slow memory growth in long-running processes
- Eventually causes GC pressure or OOM
- Very hard to diagnose (no obvious leak source)

### A8. Transform Streams That Swallow Errors

The transform stream error model makes it easy to lose errors:

```javascript
const transform = new TransformStream({
  transform(chunk, controller) {
    try {
      controller.enqueue(riskyOperation(chunk));
    } catch (e) {
      // BUG: swallowed error! Stream continues as if nothing happened
      console.error('Transform error:', e);
    }
  },
});

// Downstream has no idea chunks were skipped
source.pipeThrough(transform).pipeTo(sink);
```

**Why the API encourages this:**

- `controller.error()` stops the entire stream (often not desired)
- No "skip this chunk but continue" mechanism
- The error vs. enqueue choice is binary
- Common instinct is to catch and log, not propagate

**Consequences:**

- Silent data loss
- Downstream consumers process incomplete data
- Hard to audit which chunks succeeded or failed

### A9. Quadratic Behavior in Naive Concatenation

Without built-in concat, developers write quadratic implementations:

```javascript
// Naive concatenation - O(n * m) where n = streams, m = total chunks
async function concatStreams(streams) {
  const allChunks = [];
  for (const stream of streams) {
    for await (const chunk of stream) {
      allChunks.push(chunk);
    }
  }
  return new ReadableStream({
    start(controller) {
      for (const chunk of allChunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}
// Collects EVERYTHING into memory before producing output
```

**Why the API encourages this:**

- No `Stream.concat()` built-in
- The simplest "make it work" solution buffers everything
- Creating a proper lazy concat requires understanding the pull model deeply

**Consequences:**

- Memory usage equals total data size
- No streaming benefit
- Latency proportional to total size, not first chunk

### A10. Mixing Async Iteration with Direct Reader Access

The API allows patterns that corrupt stream state:

```javascript
async function process(stream) {
  // Start async iteration
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();

  // But also get a reader (seems reasonable?)
  const reader = stream.getReader(); // THROWS! Stream is locked by iterator

  // Or worse, release and re-acquire
  await iterator.return(); // Release lock
  const reader = stream.getReader();
  // Now we've lost whatever was buffered by the iterator
}
```

**Why the API encourages this:**

- Both APIs exist on the same object
- No clear guidance on when to use which
- Iterator doesn't "feel like" it holds a lock
- Error message doesn't explain the iterator connection

**Consequences:**

- Confusing runtime errors
- Potential data loss
- Difficult to understand ownership model

### A11. Incorrect `pipeTo()` Error Handling

The pipeTo() error model is subtle and often mishandled:

```javascript
try {
  await source.pipeTo(dest);
} catch (e) {
  // Did the source error? The dest error? Either? Both?
  // What state is each stream in now?
  console.error('Pipe failed:', e);
}

// Can we retry? Which stream needs recreating?
await source.pipeTo(newDest); // Might throw "stream is errored"
```

**Why the API encourages this:**

- Single error thrown, but two potential error sources
- No structured error type distinguishing source vs dest failures
- Both streams may be in undefined states after error
- `preventAbort`/`preventCancel` options add more confusion

**Consequences:**

- Incorrect error recovery
- Resource leaks when streams aren't properly cleaned up
- Retry logic that can't determine what to retry

### A12. Backpressure Signals That Arrive Too Late

The pull-based model means backpressure is inherently delayed:

```javascript
const readable = new ReadableStream({
  pull(controller) {
    // This is called when buffer is LOW, not when it's FULL
    // We've already buffered up to highWaterMark

    // If we fetch data here, it arrives AFTER consumer already waited
    const data = await fetchFromNetwork();
    controller.enqueue(data);

    // Round-trip latency means buffer oscillates between empty and full
  }
});
```

**Why the API encourages this:**

- The pull model signals "need data" not "stop producing"
- Producers must prefetch to avoid consumer stalls
- But prefetching defeats backpressure
- No way to signal "I might need data soon" vs "I need data now"

**Consequences:**

- Bursty behavior instead of smooth flow
- Latency spikes when buffer drains
- Over-buffering to compensate

### Summary: API Affordances vs. Correct Usage

| What the API Makes Easy  | What Correct Code Requires      |
| ------------------------ | ------------------------------- |
| Collect all then process | Incremental processing          |
| Ignore backpressure      | Monitor desiredSize constantly  |
| Forget to release locks  | Rigorous try/finally discipline |
| Unbounded buffering      | Custom queuing strategies       |
| Silent error swallowing  | Explicit error propagation      |
| Quadratic concatenation  | Understanding pull semantics    |
| Data loss on cancel      | Complex promise coordination    |

The fundamental issue is that the API's "path of least resistance" leads to buggy code. Good
stream usage requires fighting against the API's natural affordances.

---

## 4. Case Studies: Real-World Failures

The following case studies illustrate how the antipatterns described above manifest in realistic
scenarios. These are composites drawn from common patterns observed in production code, bug
reports, and developer forums.

### Case Study 1: The JSON Lines Parser That Ate All Memory

**Scenario:** A log processing service receives newline-delimited JSON (NDJSON) from an HTTP
endpoint. Each line is a separate JSON object that should be parsed and forwarded to a database.

**The Code:**

```javascript
async function processLogStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const records = [];

  // Collect all records first (A1: Read Everything First)
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line

    for (const line of lines) {
      if (line.trim()) {
        records.push(JSON.parse(line)); // Accumulating in memory
      }
    }
  }

  // Process final incomplete line
  if (buffer.trim()) {
    records.push(JSON.parse(buffer));
  }

  reader.releaseLock();

  // NOW insert all records
  await database.insertMany(records);
  return records.length;
}
```

**What Went Wrong:**

The endpoint occasionally received large log dumps (500MB+). The code:

1. Accumulated all parsed JSON objects in the `records` array
2. Held them all in memory until the stream completed
3. Only then attempted the database insert

**Impact:**

- Worker instances hit memory limits and crashed
- Partial failures left no indication of how much was processed
- Retries re-downloaded and re-processed the entire stream
- During incidents, cascading OOM failures took down the service

**The Fix That Was Needed:**

```javascript
async function processLogStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let count = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    // Process incrementally in batches
    const batch = [];
    for (const line of lines) {
      if (line.trim()) {
        batch.push(JSON.parse(line));
        if (batch.length >= 100) {
          await database.insertMany(batch);
          count += batch.length;
          batch.length = 0;
        }
      }
    }
    if (batch.length > 0) {
      await database.insertMany(batch);
      count += batch.length;
    }
  }

  reader.releaseLock();
  return count;
}
```

**Why the API Failed the Developer:**

- No `stream.lines()` or `stream.splitOn('\n')` combinator
- No `stream.batch(100).forEach(...)` for chunked processing
- The manual reader loop encourages "collect then process" thinking
- No streaming JSON lines parser in the platform

---

### Case Study 2: The WebSocket Bridge That Crashed Under Load

**Scenario:** An edge service bridges WebSocket connections to a backend, transforming messages
in transit. It uses streams to model the bidirectional flow.

**The Code:**

```javascript
function bridgeWebSocket(clientWs, backendWs) {
  // Client -> Backend direction
  const clientStream = new ReadableStream({
    start(controller) {
      clientWs.onmessage = (e) => {
        controller.enqueue(e.data); // A2: No backpressure check
      };
      clientWs.onclose = () => controller.close();
      clientWs.onerror = (e) => controller.error(e);
    },
  });

  // Transform and forward
  clientStream
    .pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          const transformed = expensiveTransform(chunk); // 50ms per message
          controller.enqueue(transformed);
        },
      })
    )
    .pipeTo(
      new WritableStream({
        write(chunk) {
          backendWs.send(chunk);
        },
      })
    );

  // Backend -> Client direction (similar pattern)
  // ...
}
```

**What Went Wrong:**

A client sent messages faster than `expensiveTransform()` could process them:

1. WebSocket `onmessage` fires rapidly (1000 msg/sec)
2. `controller.enqueue()` accepts all messages (no backpressure)
3. Internal queue grows unboundedly
4. Transform processes at 20 msg/sec (50ms each)
5. Queue grows by 980 messages/second

**Impact:**

- Memory usage grew linearly with connection duration
- Long-lived connections eventually OOMed the worker
- Clients experienced increasing latency (queued messages)
- No way to signal the client to slow down

**The Ideal Fix (Not Possible with Current API):**

```javascript
// What we WANTED to write:
const clientStream = Stream.fromEvents(clientWs, 'message', {
  buffer: {
    max: 100,
    onOverflow: 'drop-oldest', // Or 'block' with WebSocket flow control
  },
});

clientStream
  .mapAsync(expensiveTransform, { concurrency: 4 })
  .pipeTo(backendWritable);
```

**Actual Workaround Required:**

```javascript
function bridgeWebSocket(clientWs, backendWs) {
  let queue = [];
  let processing = false;
  const MAX_QUEUE = 100;

  clientWs.onmessage = async (e) => {
    if (queue.length >= MAX_QUEUE) {
      // Drop message or close connection
      console.warn('Queue full, dropping message');
      return;
    }
    queue.push(e.data);
    processQueue();
  };

  async function processQueue() {
    if (processing) return;
    processing = true;
    while (queue.length > 0) {
      const chunk = queue.shift();
      const transformed = await expensiveTransform(chunk);
      backendWs.send(transformed);
    }
    processing = false;
  }
}
// We've abandoned streams entirely because they couldn't help
```

**Why the API Failed the Developer:**

- Push sources (WebSocket) don't fit the pull-based `pull()` model
- No way to apply backpressure to event emitters
- `desiredSize` requires polling, not natural integration
- Ended up reimplementing a queue manually

---

### Case Study 3: The Tee That Took Down Production

**Scenario:** An API gateway needs to both log requests and forward them to a backend. The
obvious solution: `tee()` the request body.

**The Code:**

```javascript
async function handleRequest(request) {
  const [forLogging, forBackend] = request.body.tee();

  // Start logging asynchronously (fire and forget)
  logRequestBody(forLogging).catch(console.error);

  // Forward to backend synchronously
  const backendResponse = await fetch(backendUrl, {
    method: request.method,
    headers: request.headers,
    body: forBackend,
  });

  return backendResponse;
}

async function logRequestBody(stream) {
  // Simulate slow logging (writes to cold storage)
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  await coldStorage.write(chunks); // Slow: 2-3 seconds
}
```

**What Went Wrong:**

The backend fetch consumed `forBackend` quickly (milliseconds), but `logRequestBody` was slow:

1. Backend fetch completes in 100ms
2. Logging takes 3 seconds
3. During those 3 seconds, all request body data buffers in the tee
4. Large request bodies (file uploads, 100MB+) accumulate entirely in memory
5. Under load, dozens of concurrent requests each buffer 100MB

**Impact:**

- Memory usage spiked during traffic bursts
- Workers OOMed during peak hours
- Logging was "fire and forget" so failures were silent
- The bug was subtle—small requests worked fine

**What We Actually Wanted:**

```javascript
// Option 1: Bounded tee that blocks fast consumer
const [forLogging, forBackend] = request.body.tee({
  bufferLimit: 1024 * 1024, // 1MB max
  onSlowConsumer: 'block', // Slow down the fetch if logging falls behind
});

// Option 2: Lossy tee that drops for slow consumers
const [forLogging, forBackend] = request.body.tee({
  bufferLimit: 1024 * 1024,
  onSlowConsumer: 'drop-oldest', // Lose some log data rather than OOM
});

// Option 3: Don't use tee at all—replay from buffer
const buffer = await request.body.toArrayBuffer({ limit: 10 * 1024 * 1024 });
await Promise.all([
  logRequestBody(buffer),
  fetch(backendUrl, { body: buffer }),
]);
```

**Actual Workaround Required:**

```javascript
async function handleRequest(request) {
  // Read entire body into memory first (defeats streaming)
  const bodyBuffer = await request.arrayBuffer();

  // Now we can use it twice
  logRequestBody(bodyBuffer).catch(console.error);

  const backendResponse = await fetch(backendUrl, {
    method: request.method,
    headers: request.headers,
    body: bodyBuffer,
  });

  return backendResponse;
}
// Lost all streaming benefits, but at least it's bounded
```

**Why the API Failed the Developer:**

- `tee()` is the only way to "share" a stream
- No documentation warning about unbounded buffering
- No way to configure buffer limits or overflow behavior
- The "obvious" solution is a memory bomb

---

### Case Study 4: The Transform Stream That Lost Data

**Scenario:** A service validates and transforms incoming JSON payloads, rejecting invalid
records but continuing to process valid ones.

**The Code:**

```javascript
const validationTransform = new TransformStream({
  transform(chunk, controller) {
    try {
      const record = JSON.parse(chunk);
      if (!isValidRecord(record)) {
        // A8: Swallow the error, continue processing
        console.warn('Invalid record, skipping:', record.id);
        return; // Don't enqueue, but don't error either
      }
      controller.enqueue(processRecord(record));
    } catch (e) {
      // JSON parse error - skip this chunk
      console.error('Parse error, skipping chunk');
      // Don't call controller.error() - that would stop everything
    }
  },
});

source.pipeThrough(validationTransform).pipeTo(destination);
```

**What Went Wrong:**

The code silently dropped invalid records with no aggregate tracking:

1. Invalid records logged individually but not counted
2. No way for downstream to know records were dropped
3. Destination received subset of source with no indication
4. Auditing found 15% of records "missing" with no explanation
5. Logs were too verbose to correlate with specific runs

**Impact:**

- Data integrity issues discovered weeks later
- No way to replay or recover dropped records
- Compliance audit failed due to unexplained data loss
- Had to build separate reconciliation system

**What We Actually Wanted:**

```javascript
// Option 1: Out-of-band error channel
const { stream, errors } = source.validateWith(isValidRecord, {
  onInvalid: 'skip', // Continue processing
  collectErrors: true, // Track what was skipped
});

stream.pipeTo(destination);
const skipped = await errors.toArray();
console.log(`Skipped ${skipped.length} invalid records`);

// Option 2: Transform that can emit to multiple outputs
const { valid, invalid } = source.partition((record) => isValidRecord(record));
valid.pipeTo(mainDestination);
invalid.pipeTo(deadLetterQueue);

// Option 3: Result wrapper type
source
  .map((chunk) => {
    try {
      const record = JSON.parse(chunk);
      return isValidRecord(record)
        ? { ok: true, value: processRecord(record) }
        : { ok: false, error: 'validation', record };
    } catch (e) {
      return { ok: false, error: 'parse', chunk };
    }
  })
  .pipeTo(resultHandler); // Handler deals with ok/error cases
```

**Actual Workaround Required:**

```javascript
let validCount = 0;
let invalidCount = 0;
const invalidRecords = [];

const validationTransform = new TransformStream({
  transform(chunk, controller) {
    try {
      const record = JSON.parse(chunk);
      if (!isValidRecord(record)) {
        invalidCount++;
        invalidRecords.push({ record, reason: 'validation' });
        return;
      }
      validCount++;
      controller.enqueue(processRecord(record));
    } catch (e) {
      invalidCount++;
      invalidRecords.push({ chunk, reason: 'parse', error: e.message });
    }
  },
  flush(controller) {
    // Emit summary as final chunk (hacky)
    controller.enqueue({
      type: 'summary',
      valid: validCount,
      invalid: invalidCount,
    });
  },
});
// Now destination must handle mixed record/summary types
// And invalidRecords is a side-channel that grows unboundedly
```

**Why the API Failed the Developer:**

- Only two options: `enqueue()` or `error()`
- `error()` stops the entire stream
- No concept of "soft errors" or skip-with-metadata
- No `partition()` or multi-output transforms
- Side-channel tracking requires manual state management

---

### Case Study 5: The Response Stream That Hung Forever

**Scenario:** A proxy service streams responses from an upstream server to clients, with a
timeout to prevent hung connections.

**The Code:**

```javascript
async function proxyWithTimeout(request) {
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  // Stream the response body with a timeout
  const timedBody = addTimeout(upstream.body, 30000);

  return new Response(timedBody, {
    status: upstream.status,
    headers: upstream.headers,
  });
}

function addTimeout(stream, ms) {
  const reader = stream.getReader();

  return new ReadableStream({
    async pull(controller) {
      const timeout = setTimeout(() => {
        controller.error(new Error('Stream timeout'));
      }, ms);

      try {
        const { value, done } = await reader.read();
        clearTimeout(timeout);

        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        clearTimeout(timeout);
        controller.error(e);
      }
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
}
```

**What Went Wrong:**

The timeout implementation had subtle bugs:

1. **A6: Race condition on timeout:** If timeout fires after `read()` resolves but before
   `clearTimeout()`, the stream errors despite having data
2. **A3: Lock leak on error:** If `controller.error()` is called, the original reader's lock
   is never released
3. **Timeout per-chunk, not total:** A slow trickle of data (one byte per 29 seconds) never
   times out
4. **No cleanup on cancel:** If the client disconnects, upstream reader isn't always cancelled

**Impact:**

- Intermittent "Stream timeout" errors on fast responses (race condition)
- Leaked connections to upstream under certain error conditions
- Slow loris attacks worked because per-chunk timeout was satisfied
- Difficult to reproduce—timing-dependent

**What We Actually Wanted:**

```javascript
function proxyWithTimeout(request) {
  const upstream = await fetch(upstreamUrl, { ... });

  return new Response(
    upstream.body.timeout(30000, {
      type: 'total',           // Total time, not per-chunk
      onTimeout: 'error',      // Or 'close' to end gracefully
    }),
    { status: upstream.status, headers: upstream.headers }
  );
}

// Or with AbortSignal integration
const controller = new AbortController();
setTimeout(() => controller.abort(), 30000);

upstream.body.pipeTo(destination, { signal: controller.signal });
```

**Actual Workaround Required:**

```javascript
function addTimeout(stream, ms) {
  const reader = stream.getReader();
  let totalTimeout;
  let cancelled = false;

  const timedStream = new ReadableStream({
    start() {
      totalTimeout = setTimeout(() => {
        cancelled = true;
        reader.cancel('timeout').catch(() => {});
      }, ms);
    },
    async pull(controller) {
      if (cancelled) {
        controller.error(new Error('Stream timeout'));
        return;
      }

      try {
        const { value, done } = await reader.read();
        if (cancelled) {
          controller.error(new Error('Stream timeout'));
          return;
        }
        if (done) {
          clearTimeout(totalTimeout);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        clearTimeout(totalTimeout);
        controller.error(e);
      }
    },
    cancel(reason) {
      clearTimeout(totalTimeout);
      cancelled = true;
      return reader.cancel(reason);
    },
  });

  return timedStream;
}
// Still has edge cases, but better
```

**Why the API Failed the Developer:**

- No built-in timeout support
- No integration with AbortSignal for streams (added later, still awkward)
- Race conditions between promise resolution and side effects
- Manual cleanup coordination is error-prone
- The "obvious" implementation is buggy

---

### Case Study 6: The Pipeline That Couldn't Report Progress

**Scenario:** A file processing service needs to report upload progress to users while
streaming a large file through multiple transformation stages.

**The Code:**

```javascript
async function processUpload(request, progressCallback) {
  let bytesProcessed = 0;

  // Try to track progress through the pipeline
  const progressTransform = new TransformStream({
    transform(chunk, controller) {
      bytesProcessed += chunk.byteLength;
      progressCallback(bytesProcessed);
      controller.enqueue(chunk);
    },
  });

  await request.body
    .pipeThrough(progressTransform)
    .pipeThrough(decompressionTransform)
    .pipeThrough(validationTransform)
    .pipeThrough(encryptionTransform)
    .pipeTo(storageDestination);

  return { totalBytes: bytesProcessed };
}
```

**What Went Wrong:**

Progress tracking was misleading and incomplete:

1. **Progress reflects input, not output:** Decompression changes byte counts
2. **Buffering hides true progress:** Data buffered between stages isn't "processed"
3. **No per-stage visibility:** Can't tell where data is in the pipeline
4. **Backpressure makes progress non-linear:** Fast input + slow output = misleading progress
5. **Errors lose progress state:** If pipeline fails, unclear how much was durably processed

**Impact:**

- Progress bar jumped erratically (buffering effects)
- Progress showed 100% but processing continued (decompression expanding data)
- On error, no way to tell user how much succeeded
- Users retried uploads that were actually complete

**What We Actually Wanted:**

```javascript
const pipeline = Stream.pipeline(
  [
    request.body,
    decompressionTransform,
    validationTransform,
    encryptionTransform,
  ],
  {
    progress: {
      interval: 100, // ms
      callback: (stats) => {
        // stats.stages[0].bytesIn, stats.stages[0].bytesOut
        // stats.stages[1].bytesIn, stats.stages[1].bytesOut, stats.stages[1].buffered
        // stats.totalBytesIn, stats.totalBytesOut
        // stats.currentStage, stats.complete
        progressCallback(stats);
      },
    },
    checkpoint: {
      interval: 1000,
      callback: (checkpoint) => {
        // Durable progress marker for resume on failure
        saveCheckpoint(checkpoint);
      },
    },
  }
);

await pipeline.pipeTo(storageDestination);
```

**Actual Workaround Required:**

```javascript
// Gave up on accurate progress, just show "processing..."
async function processUpload(request) {
  const startTime = Date.now();
  let lastProgressUpdate = 0;

  const fakeProgress = setInterval(() => {
    // Fake progress that asymptotically approaches 90%
    const elapsed = Date.now() - startTime;
    const fakePercent = Math.min(90, 90 * (1 - Math.exp(-elapsed / 30000)));
    progressCallback(fakePercent);
  }, 100);

  try {
    await request.body
      .pipeThrough(decompressionTransform)
      .pipeThrough(validationTransform)
      .pipeThrough(encryptionTransform)
      .pipeTo(storageDestination);

    progressCallback(100);
  } finally {
    clearInterval(fakeProgress);
  }
}
// Yes, we're faking progress because real progress is impossible
```

**Why the API Failed the Developer:**

- No visibility into pipeline internal state
- No standard way to tap into flow between stages
- Backpressure and buffering are invisible
- No checkpoint/resume capability
- Progress tracking requires reimplementing the pipeline

---

### Summary: Patterns in the Failures

| Case Study           | Primary Antipatterns | Root Cause                             |
| -------------------- | -------------------- | -------------------------------------- |
| JSON Lines Parser    | A1, A2               | No incremental processing helpers      |
| WebSocket Bridge     | A2, A4               | Push sources don't fit pull model      |
| Tee Gateway          | A5                   | Unbounded tee buffering                |
| Validation Transform | A8                   | Binary error model (continue vs stop)  |
| Timeout Proxy        | A3, A6               | Manual resource management             |
| Progress Pipeline    | (none directly)      | No observability into stream internals |

**Common themes:**

1. **The simple solution is wrong** — Obvious code has subtle bugs
2. **Workarounds abandon streams** — Fixes often reimplement queues/buffers manually
3. **No visibility** — Can't observe what's happening inside the pipeline
4. **Memory is the failure mode** — Most issues manifest as OOM or memory pressure
5. **Error handling is inadequate** — All-or-nothing error model doesn't fit reality

---

## 5. Implementation Challenges and Workarounds

The Web Streams spec is notoriously difficult to implement correctly. This section documents
the challenges faced by browser vendors and runtime implementers, the workarounds required for
correct behavior, and the optimizations necessary for acceptable performance.

### The Spec's Internal Complexity

#### Promise Machinery

The spec defines numerous internal promise-related operations that interact in subtle ways:

- `[[readRequests]]` - Queue of pending read promises
- `[[closeRequest]]` / `[[inFlightCloseRequest]]` - Close operation tracking
- `[[writeRequests]]` / `[[inFlightWriteRequest]]` - Write operation tracking
- `[[readyPromise]]` - Writer ready state
- `[[closedPromise]]` - Stream closed notification

These internal slots create a web of promise dependencies:

```
ReadableStream                    WritableStream
├── [[reader]]                    ├── [[writer]]
│   ├── [[readRequests]]          │   ├── [[readyPromise]]
│   ├── [[closedPromise]]         │   ├── [[closedPromise]]
│   └── [[forAuthorCode]]         │   └── [[writeRequests]]
├── [[controller]]                ├── [[controller]]
│   ├── [[pullAlgorithm]]         │   ├── [[writeAlgorithm]]
│   ├── [[cancelAlgorithm]]       │   ├── [[closeAlgorithm]]
│   └── [[strategySizeAlgorithm]] │   └── [[abortAlgorithm]]
└── [[state]] / [[storedError]]   └── [[state]] / [[storedError]]
```

**Implementation challenge:** Every state transition must correctly resolve or reject the
appropriate promises. Missing a single promise resolution causes hangs; resolving twice causes
crashes or undefined behavior.

#### State Machine Interactions

The spec defines multiple interacting state machines:

**ReadableStream states:** `"readable"` → `"closed"` | `"errored"`

**ReadableStreamDefaultController states:** (implicit via queue and flags)

- Has pending pull?
- Is pulling?
- Is close requested?
- Pull again?

**WritableStream states:** `"writable"` → `"erroring"` → `"errored"` | `"closed"`

**WritableStreamDefaultController states:**

- Is started?
- Is writing?
- Is close/abort in progress?

**Implementation challenge:** These state machines interact through shared promises and
callbacks. A single incorrect state check can cause:

- Deadlocks (waiting for a promise that will never resolve)
- Double-execution (calling algorithms twice)
- Use-after-close (operating on closed streams)
- Memory leaks (promises held indefinitely)

### Specific Implementation Difficulties

#### 1. The `pipeTo` Algorithm

The `pipeTo` algorithm is approximately 100 lines of spec prose and one of the most complex
parts of the specification. It must handle:

- Concurrent reads and writes with backpressure
- Four different abort/close/cancel signal sources
- Error propagation in both directions
- The `preventClose`, `preventAbort`, `preventCancel` options
- AbortSignal integration
- Cleanup on all exit paths

**Known implementation bugs across engines:**

| Bug Type        | Description                                    |
| --------------- | ---------------------------------------------- |
| Premature close | Destination closed before source fully drained |
| Error masking   | Original error replaced by cleanup error       |
| Memory leak     | Pending operations not cleaned up on abort     |
| Deadlock        | Waiting for write that will never complete     |
| Double-cancel   | Source cancelled multiple times                |

**Workaround implementations need:** Careful tracking of "shutdown" state with flags for
each possible shutdown trigger:

```cpp
// Typical implementation needs these flags
bool shuttingDown = false;
bool shutdownWithAction = false;
kj::Maybe<kj::Exception> shutdownError;
enum class ShutdownKind { NONE, CLOSE, ABORT, CANCEL, ERROR };
ShutdownKind shutdownKind = ShutdownKind::NONE;
```

#### 2. The `tee` Algorithm

The byte stream tee algorithm is even more complex than pipeTo. It must:

- Create two branches that can be read independently
- Forward backpressure correctly (aggregate of both branches)
- Handle cancellation of either branch
- Support BYOB reading on both branches simultaneously
- Manage the "reading" flag across async operations
- Handle the case where one branch errors while the other continues

**The spec's approach:**

```
// Simplified tee state (actual spec has much more)
let reading = false;
let readAgainForBranch1 = false;
let readAgainForBranch2 = false;
let canceled1 = false;
let canceled2 = false;
let reason1, reason2;
let branch1, branch2;
```

**Implementation challenge:** The interleaving of reads, cancellations, and errors creates
a combinatorial explosion of states. Browser implementations have had bugs where:

- Cancelling branch1 while branch2 is mid-read corrupts state
- BYOB reads on both branches simultaneously cause data duplication
- Error on one branch doesn't properly propagate to the other
- Memory accumulates unboundedly (the fundamental design issue)

#### 3. BYOB Request Lifecycle

The `ReadableStreamBYOBRequest` object has a complex lifecycle:

1. Created when BYOB read is requested and no data is queued
2. Exposed via `controller.byobRequest`
3. Can be "responded to" with `respond(bytesWritten)` or `respondWithNewView(view)`
4. Becomes invalid after response
5. Can be "released" if the stream errors or is cancelled
6. The view can be transferred to a different ArrayBuffer

**Implementation challenges:**

```javascript
// The source sees this
pull(controller) {
  const request = controller.byobRequest;
  if (request) {
    // Fill request.view
    request.respond(n);
    // After this, request is invalid
    // But what if we stored a reference to request.view?
  }
}
```

- Must track whether byobRequest has been responded to
- Must handle view detachment correctly
- Must handle the case where source calls `enqueue()` instead of using byobRequest
- Must copy data correctly when byobRequest is ignored

**Workaround:** Many implementations have a separate "pending BYOB request" state machine:

```cpp
enum class ByobRequestState {
  NONE,           // No BYOB read pending
  PENDING,        // BYOB read pending, request not yet accessed
  ACCESSED,       // controller.byobRequest was read
  RESPONDED,      // respond() or respondWithNewView() called
  INVALIDATED,    // Stream errored or cancelled
};
```

#### 4. Queuing Strategy Size Functions

The spec allows user-defined size functions for queuing strategies:

```javascript
new ReadableStream(source, {
  size(chunk) {
    return chunk.byteLength; // Or any user code
  },
  highWaterMark: 1024,
});
```

**Implementation challenges:**

- Size function can throw → must handle without corrupting stream state
- Size function can return non-finite numbers → must validate
- Size function can have side effects → must call at correct time
- Size function is called synchronously during enqueue → reentrancy issues
- Size function might access the stream itself → potential deadlock

**The reentrancy problem:**

```javascript
new ReadableStream(
  {
    start(controller) {
      controller.enqueue('a'); // Calls size()
    },
  },
  {
    size(chunk) {
      // What if this calls controller.enqueue()?
      // Or reads from the stream?
      // Or throws after modifying external state?
    },
  }
);
```

**Workaround:** Implementations must carefully order operations to be reentrant-safe, often
requiring deferred execution or reentrancy guards.

### Performance-Critical Optimizations

A naive spec-compliant implementation is unusably slow. Production implementations require
optimizations that are not obvious from the spec text.

#### 1. Avoiding Promise Allocation

The spec creates promises for nearly every operation:

```javascript
// Spec says each read() creates a new promise
reader.read(); // Promise 1
reader.read(); // Promise 2
reader.read(); // Promise 3
```

**Optimization:** Pool or reuse promise objects where possible. Track pending reads with
a more efficient data structure than a queue of promise capability records.

```cpp
// Instead of: Vector<PromiseCapability> readRequests;
// Use: Single promise + count, or ring buffer
struct PendingReads {
  uint32_t count = 0;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<ReadResult>>> fulfiller;
  // ... batch multiple reads into single promise chain
};
```

#### 2. Fast-Path for Synchronous Data

When data is already available, the spec still requires promise resolution:

```javascript
controller.enqueue(data); // Data is now queued
reader.read(); // Spec: return promise that resolves to data
// But data is RIGHT THERE - why create a promise?
```

**Optimization:** Detect when data is immediately available and resolve synchronously
(or use a pre-resolved promise singleton).

```cpp
kj::Promise<ReadResult> read() {
  if (!queue.empty()) {
    // Fast path: data available
    return kj::Promise<ReadResult>(dequeue());  // Immediate
  }
  // Slow path: must wait
  return pendingReadPromise();
}
```

#### 3. Avoiding Copies in `pipeTo`

The spec's pipeTo algorithm conceptually:

1. Reads chunk from source
2. Writes chunk to destination

A naive implementation copies data at each step.

**Optimization:** Identify when source and destination can share buffers:

- Same-origin streams can transfer ArrayBuffers
- Internal platform streams can use zero-copy paths
- Byte streams can use splice/sendfile on supported platforms

```cpp
// Detect optimizable pipe
if (source.isInternalByteStream() && dest.isInternalByteStream()) {
  return optimizedBytePipe(source, dest);  // Zero-copy
}
// Fall back to spec algorithm
return specCompliantPipe(source, dest);
```

#### 4. Identity Transform Elision

A TransformStream that doesn't modify data:

```javascript
new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk); // Pass-through
  },
});
```

**Optimization:** Detect identity transforms and bypass the transform machinery:

```cpp
if (transform.isIdentity()) {
  // Connect source directly to destination
  return source.pipeTo(dest);
}
```

This optimization is critical for `pipeThrough` chains where some stages are conditionally
identity transforms.

#### 5. Batch Processing

The spec processes one chunk at a time:

```javascript
// Spec: each chunk flows through individually
source → transform → transform → transform → sink
  [a]  →    [a']   →    [a'']  →   [a'''] → written
  [b]  →    [b']   →    [b'']  →   [b'''] → written
```

**Optimization:** Batch chunks through the pipeline when possible:

```cpp
// Batch multiple chunks
Vector<Chunk> batch;
while (!source.empty() && batch.size() < BATCH_SIZE) {
  batch.push(source.dequeue());
}
// Process batch through transform chain
for (auto& transform : transforms) {
  batch = transform.processBatch(batch);
}
sink.writeBatch(batch);
```

#### 6. Lazy Reader/Writer Creation

The spec creates internal objects eagerly:

```javascript
const stream = new ReadableStream(source);
// Spec: controller is created immediately
// Spec: internal slots are initialized
```

**Optimization:** Defer creation until actually needed:

```cpp
class ReadableStream {
  kj::Maybe<Controller> controller;  // Lazy

  Controller& getController() {
    KJ_IF_SOME(c, controller) {
      return c;
    }
    controller = createController();
    return KJ_ASSERT_NONNULL(controller);
  }
};
```

### Platform Integration Challenges

#### Fetch Response Bodies

The Fetch spec requires response bodies to be ReadableStreams:

```javascript
const response = await fetch(url);
const stream = response.body; // ReadableStream
```

**Implementation challenges:**

1. Network data arrives asynchronously from a different thread/process
2. Must bridge between platform I/O and JS stream semantics
3. Must handle abort signals that cancel both fetch and stream
4. Must correctly propagate errors from network layer
5. Must support both streaming and buffered consumption patterns

**Common bugs:**

- Data arriving after stream is cancelled causes crashes
- Abort signal not properly linked to underlying connection
- Memory not released when stream is partially consumed

#### Compression Streams

`CompressionStream` and `DecompressionStream` wrap native compression libraries:

```javascript
const compressed = input.pipeThrough(new CompressionStream('gzip'));
```

**Implementation challenges:**

1. Native compression libraries have their own buffering
2. Must handle partial output (compressor hasn't flushed)
3. Must handle native library errors
4. Must clean up native resources on stream error/cancel
5. Decompression can produce much more output than input (zip bomb)

**Workaround:** Implement internal limits not in the spec:

```cpp
class DecompressionStream {
  static constexpr size_t MAX_EXPANSION_RATIO = 1000;
  size_t inputBytes = 0;
  size_t outputBytes = 0;

  void checkExpansion() {
    if (outputBytes > inputBytes * MAX_EXPANSION_RATIO) {
      throw Error("Decompression bomb detected");
    }
  }
};
```

### Interoperability Issues

Despite the detailed spec, implementations differ in edge cases:

| Behavior                     | Chrome    | Firefox   | Safari    | workerd      |
| ---------------------------- | --------- | --------- | --------- | ------------ |
| Error type for locked stream | TypeError | TypeError | TypeError | TypeError    |
| `tee()` buffer limit         | None      | None      | None      | Configurable |
| BYOB on value stream         | Throws    | Throws    | Throws    | Throws       |
| `pipeTo` abort timing        | Immediate | Deferred  | Immediate | Immediate    |
| Size function `this` binding | undefined | undefined | undefined | undefined    |
| Async iterator `return()`    | Cancels   | Cancels   | Cancels   | Cancels      |

**Known interop bugs that have been filed:**

1. Order of promise resolution when multiple reads are pending
2. Whether `cancel()` waits for pending `pull()` to complete
3. Exact error message text (not specified)
4. Behavior when `highWaterMark` is 0
5. Whether `getReader()` on errored stream throws or returns errored reader

### Workarounds Implementers Actually Use

#### 1. Simplified Internal Streams

For platform-created streams (fetch bodies, file reads), implementations often use simplified
internal representations that bypass the full spec machinery:

```cpp
// Internal stream: just a queue + state
class InternalReadableStream {
  Queue<Chunk> buffer;
  enum State { READABLE, CLOSED, ERRORED } state;
  kj::Maybe<kj::Exception> error;

  // Much simpler than full spec
  Chunk read() {
    KJ_REQUIRE(state == READABLE);
    return buffer.pop();
  }
};

// Only create full spec-compliant wrapper when JS accesses it
class ReadableStreamJSWrapper {
  InternalReadableStream& internal;
  kj::Maybe<FullSpecController> controller;  // Lazy
};
```

#### 2. Optimized Pipe Paths

Direct connections between known stream types:

```cpp
Promise<void> optimizedPipe(ReadableStream& source, WritableStream& dest) {
  // Check for known optimizable combinations
  if (auto* fetchBody = source.tryGetFetchBody()) {
    if (auto* httpResponse = dest.tryGetHttpResponse()) {
      // Direct splice from network to network
      return fetchBody->spliceTo(httpResponse);
    }
  }

  // Fall back to generic pipe
  return genericPipe(source, dest);
}
```

#### 3. Reference Implementation Divergence

The spec's reference implementation in JavaScript is considered normative, but native
implementations must diverge for performance:

| Spec Reference Implementation  | Native Implementation         |
| ------------------------------ | ----------------------------- |
| `[[readRequests]]` is a List   | Ring buffer or intrusive list |
| Promise per read               | Batched promise resolution    |
| Full algorithm on each enqueue | Deferred state updates        |
| GC handles cleanup             | Explicit ref counting         |

#### 4. Testing Infrastructure

Correct implementation requires extensive testing beyond WPT (Web Platform Tests):

- Reentrancy tests (call stream methods from callbacks)
- Timing tests (verify promise resolution order)
- Memory tests (verify no leaks in error paths)
- Cancellation tests (all combinations of cancel timing)
- Fuzz testing (random sequences of operations)

```javascript
// Example test that catches many implementation bugs
async function reentrancyTest() {
  let enqueueCount = 0;
  const stream = new ReadableStream(
    {
      start(controller) {
        controller.enqueue('first');
      },
      pull(controller) {
        if (enqueueCount++ < 3) {
          controller.enqueue(`chunk-${enqueueCount}`);
        } else {
          controller.close();
        }
      },
    },
    {
      size(chunk) {
        // Size function called during enqueue
        // What happens if we read here?
        return chunk.length;
      },
      highWaterMark: 0, // Triggers pull immediately
    }
  );

  const reader = stream.getReader();
  const results = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    results.push(value);
  }

  assert(results.length === 4);
}
```

### Summary: The Implementation Tax

Implementing Web Streams correctly requires:

| Requirement                | Effort                           |
| -------------------------- | -------------------------------- |
| Understand spec prose      | High (100+ pages)                |
| Implement state machines   | High (multiple interacting)      |
| Handle all error paths     | Very High (combinatorial)        |
| Pass WPT tests             | Medium (tests exist)             |
| Achieve acceptable perf    | High (many optimizations)        |
| Handle edge cases          | Very High (discovered over time) |
| Maintain over spec changes | Ongoing                          |

**The result:** Only a handful of correct, performant implementations exist (browser engines
plus a few server runtimes). The complexity is a significant barrier to:

- New runtime implementations
- Alternative JavaScript engines
- Embedded/constrained environments
- Formal verification efforts

A simpler spec would enable a broader ecosystem of implementations and reduce the ongoing
maintenance burden for existing implementers.

---

## 6. Design Principles for Improvement

Based on the criticisms above, a redesigned streams API should follow these principles:

### P1: Async Iteration as Primary Interface

Streams should be async iterables first. The `for await...of` syntax should be the idiomatic way
to consume a stream, with reader objects available only for advanced use cases.

### P2: Sensible Defaults, Explicit Complexity

Common operations (read all, pipe, transform) should require minimal code. Advanced features
(BYOB, custom backpressure) should be opt-in.

### P3: Bounded Buffers by Default

Unbounded buffering should never occur implicitly. All buffering should have explicit limits with
configurable overflow policies (block, drop, error).

### P4: Partial Consumption Without Locking

Unlike Web Streams which lock on any reader access, streams should support partial consumption:

```javascript
const header = await stream.take(1024).bytes(); // Read first 1KB
const body = await stream.bytes(); // Continue with rest
```

This works like file handles — reading advances a position, subsequent reads continue.
Explicit sharing (tee, multicast) is only needed for true concurrent access.

### P5: First-Class Combinators

Common stream operations should be built-in methods, not manual TransformStream constructions:

- **Slicing**: `take(n)`, `drop(n)`, `limit(n)` for byte-level control
- **Combining**: `Stream.merge()`, `Stream.concat()` for multi-stream operations
- **Transforming**: `pipeThrough(fn)` accepts a simple function for stateless transforms
- **Collecting**: `bytes()`, `text()`, `arrayBuffer()` for consumption

Note: Unlike iterator-style APIs, there's no separate `.map(fn)` or `.filter(fn)` — for bytes-only
streams, `pipeThrough(fn)` serves this purpose with `fn` receiving and returning byte chunks.

### P6: Unified Stream Type

Byte mode should be a configuration option on a single stream type, not a fundamentally different
controller architecture.

### P7: Errors Are Error Objects

Reasons/errors should always be `Error` instances (wrapping primitives if necessary), ensuring
stack traces and type checking.

---

## 7. Proposed API Design

### Fundamental Design Decision: Bytes Only

The new Stream API deals **exclusively with bytes**. This is a deliberate simplification:

| Current Web Streams            | New Stream API                      |
| ------------------------------ | ----------------------------------- |
| Value streams (any JS value)   | Not supported — use async iterables |
| Byte streams (`type: "bytes"`) | The only mode                       |
| Two controller types           | One Writer type                     |
| BYOB optional                  | Always available                    |

**Rationale:**

1. **Async iterables handle values** — `for await...of` with generators is the right primitive
   for streaming arbitrary JS values. No need to duplicate this in a Stream API.

2. **Real streaming is bytes** — Network I/O, file I/O, compression, encryption, parsing —
   these all fundamentally operate on bytes.

3. **Eliminates complexity** — The value/byte dichotomy in Web Streams is a major source of
   confusion and implementation complexity.

4. **Type safety** — A bytes-only stream has a clear type: chunks are always `Uint8Array`.

### Stream Creation

```javascript
// Generator-based (pull source) - yields bytes on demand
const stream = Stream.pull(async function* () {
  for await (const row of database.query('SELECT * FROM logs')) {
    yield JSON.stringify(row) + '\n'; // String auto-encoded to UTF-8
  }
});

// Push source - returns [Stream, Writer] pair (like Promise.withResolvers())
const [stream, writer] = Stream.push();

// Writer accepts bytes or strings (strings auto-encoded)
const socket = new WebSocket(url);
socket.onmessage = (e) => writer.write(e.data); // string or ArrayBuffer
socket.onclose = () => writer.close();
socket.onerror = (e) => writer.abort(e);

// From bytes or strings
const stream = Stream.from(uint8array);
const stream = Stream.from(arrayBuffer);
const stream = Stream.from('hello world'); // UTF-8 encoded
const stream = Stream.from('hello world', 'utf-16le'); // Other encodings

// Empty stream
const stream = Stream.empty();
```

**Accepted input types (auto-converted to Uint8Array):**

| Input                  | Conversion                                         |
| ---------------------- | -------------------------------------------------- |
| `Uint8Array`           | Used directly                                      |
| `ArrayBuffer`          | Wrapped in Uint8Array                              |
| `TypedArray` (other)   | Copied to Uint8Array                               |
| `DataView`             | Copied to Uint8Array                               |
| `string`               | Encoded to UTF-8 (default) or specified encoding   |
| `Iterable<above>`      | Each element converted, yielded as separate chunks |
| `AsyncIterable<above>` | Each element converted, yielded as separate chunks |

**Atomic vs. iterable inputs:**

Strings and BufferSource types are emitted as a **single chunk** (not iterated byte-by-byte):

```javascript
// Single-chunk inputs (atomic)
Stream.from('hello world'); // One Uint8Array chunk (UTF-8)
Stream.from(new Uint8Array([1, 2, 3])); // One Uint8Array chunk
Stream.from(arrayBuffer); // One Uint8Array chunk

// Multi-chunk inputs (iterated)
Stream.from([chunk1, chunk2, chunk3]); // Three chunks
Stream.from(asyncGenerator()); // One chunk per yield
```

**Encoding options for strings:**

```javascript
Stream.from('hello', 'utf-8'); // Default: UTF-8
Stream.from('hello', 'utf-16le'); // Little-endian UTF-16
Stream.from('hello', 'iso-8859-1'); // Latin-1
// All encodings from the Encoding Standard are supported
```

The distinction between `Stream.pull()` and `Stream.push()` makes the fundamental difference
explicit:

| Method          | Data Flow              | Backpressure               | Use Case                                  |
| --------------- | ---------------------- | -------------------------- | ----------------------------------------- |
| `Stream.pull()` | Consumer requests data | Natural (generator pauses) | Files, paginated APIs, computed sequences |
| `Stream.push()` | Producer sends data    | Must be configured         | WebSockets, events, external callbacks    |

**Why `Stream.push()` returns a pair:**

The callback-based pattern in the current Web Streams API (`new ReadableStream({ start(controller) { ... } })`)
has several problems:

1. **Closure overhead** — Every stream creation allocates a closure
2. **Awkward cleanup** — Must return a cancel callback or store controller reference anyway
3. **Inverted control** — Controller is passed _in_ rather than returned _out_
4. **Lifecycle confusion** — When does `start()` run? What if it throws?

Returning `[Stream, Writer]` directly:

```javascript
// Clean: writer is a first-class value you own
const [stream, writer] = Stream.push();

// Can pass writer to other code
startWebSocketBridge(url, writer);

// Can store and use later
class DataSource {
  #writer;
  #stream;

  constructor() {
    [this.#stream, this.#writer] = Stream.push();
  }

  get stream() {
    return this.#stream;
  }

  write(data) {
    this.#writer.write(data);
  }
  finish() {
    this.#writer.close();
  }
}
```

This pattern is similar to `Promise.withResolvers()` (ES2024) which returns
`{ promise, resolve, reject }` instead of requiring a callback.

**Writer API:**

The Writer returned by `Stream.push()` is the same type used for writing to any Writable:

| Method/Property        | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `write(data, opts)`    | Write bytes or string; returns promise (see `onOverflow` policy) |
| `writev(chunks, opts)` | Vectored write — write multiple chunks atomically                |
| `flush(opts)`          | Sync point — resolves when all prior writes complete             |
| `close()`              | Signal end of stream                                             |
| `abort(reason)`        | Signal error, cancel stream                                      |
| `closed`               | Promise that resolves when writer is closed                      |
| `desiredSize`          | Bytes available before `max` (null if closed; negative if over)  |

All write operations (`write`, `writev`, `flush`) accept an options object with an `AbortSignal`.
When the signal aborts, the operation is cancelled along with **all subsequent queued operations**.

**Vectored writes:**

`writev()` writes multiple chunks in a single operation:

```javascript
// Instead of multiple writes:
await writer.write(header);
await writer.write(body);
await writer.write(trailer);

// Single vectored write — more efficient, atomic
await writer.writev([header, body, trailer]);
```

Benefits:

- Reduces syscall overhead when backed by OS I/O
- Atomic from the consumer's perspective — no interleaving with other writers
- Same backpressure semantics as `write()` — based on total size of all chunks

**Flush (synchronization point):**

`flush()` acts as a zero-length write that queues behind pending writes:

```javascript
await writer.write(chunk1);
await writer.write(chunk2);
writer.write(chunk3); // Don't await — fire and forget

// flush() resolves when chunk3 (and all prior writes) complete
await writer.flush();
console.log('All writes complete');
```

Use cases:

- Ensure data has reached the underlying sink before proceeding
- Synchronization without allocating dummy data
- Similar to `fsync()` semantics in file I/O

Unlike `close()`, `flush()` doesn't end the stream — you can continue writing after a flush.

**Cancelling writes with AbortSignal:**

All write operations accept an `AbortSignal` for cancellation. When a signal aborts, the
operation is cancelled **along with all subsequent queued operations**:

```javascript
const controller = new AbortController();

// Queue multiple writes
writer.write(chunk1);
writer.write(chunk2, { signal: controller.signal }); // Has signal
writer.write(chunk3); // No signal, but queued after chunk2
writer.write(chunk4);
await writer.flush();

// If we abort while chunk2 is pending:
controller.abort();
// - chunk1: already written (unaffected)
// - chunk2: CANCELLED (AbortError)
// - chunk3: CANCELLED (cascaded from chunk2)
// - chunk4: CANCELLED (cascaded)
// - flush: CANCELLED (cascaded)
```

This cascading behavior ensures that aborting a write doesn't leave subsequent dependent
writes in an inconsistent state. If you need independent cancellation, use separate writers.

**Timeout example:**

```javascript
// Write with a timeout — if it takes too long, cancel this and all subsequent writes
await writer.write(largeChunk, { signal: AbortSignal.timeout(5000) });
```

**No `ready` promise:** Unlike Web Streams, there's no separate `ready` promise. Just
`await write()` — the promise behavior is controlled by the `onOverflow` policy (see
Backpressure section). For proactive backpressure checking, inspect `desiredSize`.

### Consumption

```javascript
// Primary: async iteration
for await (const chunk of stream) {
  process(chunk);
}

// Collection methods (naming aligned with Response/Blob APIs)
// These are TERMINAL operations - they consume the stream
const bytes = await stream.bytes(); // Uint8Array (concatenated)
const buffer = await stream.arrayBuffer(); // ArrayBuffer (concatenated)
const str = await stream.text(); // string (UTF-8 decoded)
const str = await stream.text('iso-8859-1'); // string (other encoding)

// All collection methods accept an options object with AbortSignal
const bytes = await stream.bytes({ signal: AbortSignal.timeout(5000) });
const text = await stream.text('utf-8', { signal });
```

Since streams are bytes-only, each chunk is a `Uint8Array`. The collection methods differ in
how they aggregate:

| Method          | Return Type   | Behavior                                   |
| --------------- | ------------- | ------------------------------------------ |
| `bytes()`       | `Uint8Array`  | All bytes concatenated into single buffer  |
| `arrayBuffer()` | `ArrayBuffer` | All bytes concatenated as ArrayBuffer      |
| `text()`        | `string`      | All bytes concatenated and decoded as text |

If you need access to individual chunks (rare), use async iteration:

```javascript
const chunks = [];
for await (const chunk of stream) {
  chunks.push(chunk);
}
```

**Partial consumption and continuation:**

Unlike Web Streams (which lock on any access), the new API supports partial consumption:

```javascript
// Read first 1KB, then continue with the rest
const header = await stream.take(1024).bytes();
const body = await stream.bytes(); // Continues from byte 1025

// Or read in stages
const magic = await stream.take(4).bytes(); // First 4 bytes
const length = await stream.take(4).bytes(); // Next 4 bytes
const payload = await stream.take(1000).bytes(); // Next 1000 bytes
// stream is still usable for remaining bytes
```

This works like file handles — reading some bytes advances a position, and subsequent reads
continue from there.

**How `take(n)` works:**

```javascript
const first1k = stream.take(1024); // Returns new Stream for next 1024 bytes
// At this point, nothing has been consumed yet

await first1k.bytes(); // NOW consumes 1024 bytes from the underlying source
await stream.bytes(); // Continues from byte 1025
```

The `take(n)` call itself doesn't consume data — it creates a "view" of the next n bytes.
Consumption happens when you actually read from either stream. This enables patterns like:

```javascript
// Peek at content type without consuming if not needed
const contentStream = stream.take(1024);
const preview = await contentStream.bytes();

if (looksLikeJSON(preview)) {
  // Parse the preview + rest of stream as JSON
  const full = await Stream.concat(Stream.from(preview), stream).text();
  return JSON.parse(full);
} else {
  // Different handling...
}
```

**Collection with limits:**

```javascript
// Limit to 1MB
const limited = await stream.take(1024 * 1024).bytes();

// Remaining data is still available
const rest = await stream.bytes();
```

With bytes-only streams, `take(n)` always means "take n bytes" — the concept of "chunks" is an
implementation detail, not something users typically care about.

**How `drop(n)` works:**

`drop(n)` is the counterpart to `take(n)`. Both create "views" of a byte range, but they differ
in what they return:

| Operation | Returns             | Bytes 0 to n-1        | Parent stream continues at |
| --------- | ------------------- | --------------------- | -------------------------- |
| `take(n)` | Readable stream     | Available to read     | Byte n                     |
| `drop(n)` | Closed/empty stream | Immediately discarded | Byte n                     |

```javascript
// drop(n) returns a closed stream representing the discarded bytes
const discarded = stream.drop(100); // Returns closed stream (bytes 0-99 discarded)
const body = await stream.bytes(); // Continues from byte 100

// The returned stream is closed/empty — there's nothing to read from it
await discarded.bytes(); // Returns empty Uint8Array (bytes were discarded)
```

**Why `drop(n)` returns a closed stream (not void):**

For consistency with `take(n)`, both operations create views of byte ranges. The difference:

- `take(n)` view has a cursor that needs to be consumed or cancelled
- `drop(n)` view has a cursor that is **immediately done** (bytes discarded)

This means `drop(n)` doesn't participate in the abandoned cursor problem — its cursor is
already advanced, so it doesn't hold up the buffer or cause backpressure.

**Combining `take(n)` and `drop(n)`:**

```javascript
// Skip 100 bytes, read next 50, skip another 200, read the rest
stream.drop(100); // Discard bytes 0-99
const chunk = await stream.take(50).bytes(); // Read bytes 100-149
stream.drop(200); // Discard bytes 150-349
const rest = await stream.bytes(); // Read bytes 350+
```

**`drop(n)` vs `take(n).cancel()`:**

These are semantically equivalent but `drop(n)` is more efficient:

```javascript
// These produce the same result:
stream.take(100).cancel(); // Creates cursor, then immediately cancels it
stream.drop(100); // Discards bytes without creating a lingering cursor

// drop() is preferred when you know you don't want the bytes
```

In the cursor model, `drop(n)` is like creating a cursor that's instantly marked as complete,
allowing those bytes to be flushed immediately without buffering.

**Error vs. Cancellation Semantics in Partial Consumption:**

When using `take(n)` to create multiple derived streams from a single source, the semantics of
errors and cancellation differ importantly:

```javascript
const magic = await stream.take(4).bytes(); // Stream A: bytes 0-3
const length = await stream.take(4).bytes(); // Stream B: bytes 4-7
const payload = await stream.take(1000).bytes(); // Stream C: bytes 8-1007
const rest = await stream.bytes(); // Stream D: bytes 1008+
```

**Errors propagate to all derived streams:**

If the underlying source encounters an error (network failure, I/O error, etc.), that error
propagates to ALL derived streams that haven't yet completed:

```javascript
// If underlying source errors after byte 500:
// - magic (bytes 0-3): Already completed successfully ✓
// - length (bytes 4-7): Already completed successfully ✓
// - payload (bytes 8-1007): ERRORS - was waiting for bytes 500-1007
// - rest: ERRORS - hadn't started yet
```

This is the expected behavior — an error in the source means the data is unavailable, and all
consumers waiting for that data should be notified.

**Cancellation is isolated — it doesn't break other derived streams:**

If a consumer cancels one of the derived streams, other derived streams remain usable.
Cancelling a stream simply means "I don't want these bytes" — they are discarded:

```javascript
const magic = stream.take(4);
const length = stream.take(4);
const payload = stream.take(1000);

// Consumer decides they don't want the payload
payload.cancel('not needed');

// magic and length are UNAFFECTED - they can still be consumed
const magicBytes = await magic.bytes(); // Works fine (bytes 0-3)
const lengthBytes = await length.bytes(); // Works fine (bytes 4-7)
// Bytes 8-1007 (payload's range) are discarded
```

**Cancelling earlier streams skips their bytes:**

If you cancel an earlier stream, its bytes are dropped, and later streams continue from where
the cancelled stream would have ended:

```javascript
const header = stream.take(100);
const body = stream.take(1000);

// Cancel header - we don't want those bytes
header.cancel();

// body is still readable! Bytes 0-99 are simply discarded.
const bodyBytes = await body.bytes(); // Reads bytes 100-1099
```

**Cancelling the parent stream cancels all derived streams:**

If you cancel the original stream (not a derived `take()` stream), ALL derived streams are
cancelled:

```javascript
const header = stream.take(100);
const body = stream.take(1000);

// Cancel the parent stream
stream.cancel('abort everything');

// ALL derived streams are now cancelled
await header.bytes(); // Rejects with cancellation error
await body.bytes(); // Rejects with cancellation error
```

This follows the principle that the parent stream is the "root" — cancelling it means
"I'm done with all of this data."

**Underlying source cancellation:**

The underlying source is cancelled when either:

1. The parent stream is explicitly cancelled, OR
2. All derived streams have been fully consumed or cancelled

```javascript
const a = stream.take(100); // Bytes 0-99
const b = stream.take(100); // Bytes 100-199
const c = stream.take(100); // Bytes 200-299

a.cancel(); // Underlying NOT cancelled - b and c still want data
await b.bytes(); // Underlying NOT cancelled - c still wants data
c.cancel(); // NOW underlying is cancelled - no one wants more data

// OR: cancel everything at once
stream.cancel(); // Underlying cancelled immediately, a/b/c all cancelled
```

**Underlying source cancellation is deferred:**

The underlying source is only cancelled when ALL preceding streams have been consumed or
cancelled. This prevents data loss:

```javascript
const header = stream.take(100);
const body = stream.take(1000);

// If we cancel body before consuming header:
body.cancel();

// The underlying source is NOT cancelled yet!
// We can still read the header:
const headerBytes = await header.bytes(); // Reads bytes 0-99 from source

// Only NOW is the underlying source cancelled (if body was the last reference)
```

**Out-of-order consumption:**

Streams created by `take(n)` can be consumed in any order, but the underlying source is read
sequentially. Reading a later stream before earlier ones requires buffering:

```javascript
const first = stream.take(100); // Bytes 0-99
const second = stream.take(100); // Bytes 100-199
const third = stream.take(100); // Bytes 200-299

// Consume in reverse order:
const thirdBytes = await third.bytes();
// This internally reads and buffers bytes 0-199, then returns bytes 200-299

const firstBytes = await first.bytes();
// Returns bytes 0-99 from the internal buffer (already read)

const secondBytes = await second.bytes();
// Returns bytes 100-199 from the internal buffer
```

Alternatively, if you know you don't need earlier streams, cancel them to skip without buffering:

```javascript
const first = stream.take(100); // Bytes 0-99
const second = stream.take(100); // Bytes 100-199
const third = stream.take(100); // Bytes 200-299

// Skip to third without buffering:
first.cancel(); // Discard bytes 0-99
second.cancel(); // Discard bytes 100-199
const thirdBytes = await third.bytes(); // Read bytes 200-299
```

**Memory implications:**

Out-of-order consumption is governed by the unified buffer model (see "Unified Buffer and
Cursor Model" below). Each `take()` stream holds a cursor, and the buffer retains bytes until
ALL cursors have passed them:

```javascript
// Potentially problematic pattern:
const streams = [];
for (let i = 0; i < 1000; i++) {
  streams.push(stream.take(1024)); // 1KB each = 1000 cursors
}

// Consuming last one first: all earlier cursors are "slow consumers"
const last = await streams[999].bytes();
// Buffer held ~1MB until this point (bytes 0-1023999 for cursors 0-998)

// Better: cancel streams you don't need (advances their cursors)
for (let i = 0; i < 999; i++) {
  streams[i].cancel(); // Cursor advances, bytes can flush
}
const last = await streams[999].bytes(); // Only buffers last 1KB
```

For large streams, prefer consuming in order, explicitly cancelling unneeded streams, or using
the `drop(n)` operator to skip bytes:

```javascript
// drop() is more efficient than take().cancel() — no lingering cursor
stream.drop(1000); // Discard first 1000 bytes immediately
const data = await stream.bytes(); // Continue from byte 1001
```

**Buffer limits protect against runaway memory:**

If the root stream has buffer limits configured, out-of-order consumption that exceeds those
limits will trigger the `onOverflow` policy:

```javascript
const [stream, writer] = Stream.push({
  buffer: { max: 1024 * 1024, onOverflow: 'error' },
});

const header = stream.take(100);
const body = stream.take(10_000_000); // 10MB

await body.bytes(); // ERROR: header's cursor 10MB behind, exceeds 1MB limit
```

**`limit(n)` — Cap stream and cancel source:**

Unlike `take(n)` which creates a branch (parent continues after), `limit(n)` caps the stream
at n bytes and **cancels the source** once the limit is reached or the limited stream is
consumed:

```javascript
// take(n) — branching: parent continues at byte n
const header = stream.take(16);
const body = stream; // Continues from byte 16

// limit(n) — capping: source cancelled after n bytes
const capped = stream.limit(1024 * 1024); // Max 1MB
await capped.bytes(); // At most 1MB; source cancelled after
// stream is now cancelled — no continuation
```

Use cases for `limit(n)`:

- Protect against oversized responses: `response.body.limit(maxSize).bytes()`
- Preview/sampling: only need first chunk of data
- Memory protection: ensure you never buffer more than N bytes

```javascript
// Defensive fetch — reject responses over 10MB
async function safeFetch(url) {
  const response = await fetch(url);
  return response.body.limit(10 * 1024 * 1024).bytes();
  // If response > 10MB, only first 10MB read, rest cancelled
}

// Contrast with take() — would need manual cleanup
async function fetchWithTake(url) {
  const response = await fetch(url);
  const data = await response.body.take(10 * 1024 * 1024).bytes();
  response.body.cancel(); // Must explicitly cancel remainder
  return data;
}
```

**Unified Branching Model: `take()`, `drop()`, `limit()`, and `tee()`**

These operations create derived streams from a parent, differing in how they partition data
and handle the source:

| Operation  | Branching Type | Data Distribution                        | Source after         |
| ---------- | -------------- | ---------------------------------------- | -------------------- |
| `take(n)`  | Sequential     | New stream gets next n bytes             | Continues at byte n  |
| `drop(n)`  | Sequential     | Bytes discarded immediately              | Continues at byte n  |
| `limit(n)` | Terminal       | Stream capped at n bytes                 | Cancelled after n    |
| `tee()`    | Parallel       | New stream + original both get all bytes | Shared (both active) |

`drop(n)` is essentially `take(n)` with immediate cancellation — the cursor is created and
instantly marked as done, so those bytes can be flushed without buffering.

`limit(n)` is simpler than `take(n)` — it doesn't create a branching cursor, just caps the
stream and cancels the underlying source when done.

**Cancellation rules:**

1. **Cancel a branch** → Only affects that branch; other branches unaffected
2. **Errors in source** → Propagate to all branches (via shared buffer)
3. **Source closes** → All branches receive EOF when they reach end of data

With `tee()`, there is no "parent" — all branches are peers with independent cursors into
the shared buffer. Cancelling any one branch just removes its cursor; others continue.

```javascript
// Sequential branching with take()
const header = stream.take(100); // Bytes 0-99
const body = stream.take(1000); // Bytes 100-1099

header.cancel(); // Only header cancelled; body still readable
body.cancel(); // Only body cancelled; stream still readable at byte 1100

// Parallel branching with tee()
const branch = stream.tee();

// Branches are peers - cancelling one doesn't affect others
branch.cancel(); // Only branch cancelled; stream still readable
stream.cancel(); // Only stream cancelled; branch still readable (if data available)
// Both have independent cursors into the shared buffer
```

**Combining `take()` and `tee()`:**

Since both create derived streams, they compose naturally:

```javascript
const branch = stream.tee();

// Each branch can use take() independently
const streamHeader = await stream.take(100).bytes();
const branchHeader = await branch.take(100).bytes();
// Both get the same bytes 0-99

// Continuing from each branch is independent
const streamRest = await stream.bytes(); // Bytes 100+ from stream
const branchRest = await branch.bytes(); // Bytes 100+ from branch
```

**Tee'ing a limited stream (`take()` then `tee()`):**

When you call `tee()` on a stream created by `take(n)`, the tee'd branch inherits the same
byte limit. Both branches will yield the same limited data:

```javascript
const stream = Stream.from('hello world');
const first5 = stream.take(5);   // Limited to bytes 0-4
const branch = first5.tee();     // Branch inherits the 5-byte limit

const [t1, t2] = await Promise.all([
  first5.text(),
  branch.text(),
]);
// Both t1 and t2 are 'hello' — the limit propagates to the tee'd branch
```

This ensures that `tee()` always produces a semantically equivalent branch — if the original
stream has a limit, the branch has the same limit. The key invariant: **tee'd branches always
yield identical data**.

**Unified Buffer and Cursor Model:**

Both `take()` and `tee()` share the same underlying buffer model. There is ONE buffer at the
root stream level, and all derived streams hold **cursors** into this buffer:

```
Root Stream Buffer: [byte 0] [byte 1] [byte 2] ... [byte N]
                        ↑        ↑                    ↑
                     Cursor A  Cursor B            Cursor C
```

**Key principles:**

1. **One buffer per root stream** — All derived streams (from any depth of `take()`/`tee()`)
   share the same underlying buffer
2. **Each derived stream has a cursor** — Tracks which bytes it has consumed
3. **Backpressure = slowest cursor** — The cursor furthest behind determines buffer pressure
4. **Bytes flush when all cursors pass** — Data is only released when every cursor has moved past it

**Example with `take()` (sequential branching):**

```javascript
const header = stream.take(100); // Cursor A: wants bytes 0-99
const body = stream.take(1000); // Cursor B: wants bytes 100-1099

// Read body first (out of order)
await body.bytes(); // Cursor B advances to 1099
// Buffer state: holds bytes 0-99 (Cursor A still at 0)
// Cursor A is now the "slowest consumer"

await header.bytes(); // Cursor A advances to 99
// Buffer state: bytes 0-99 can now be flushed (all cursors past them)
```

**Example with `tee()` (parallel branching):**

```javascript
const branch = stream.tee(); // stream and branch both want ALL bytes

await stream.bytes(); // stream's cursor at end
// Buffer state: holds ALL bytes (branch's cursor still at 0)
// branch is the "slowest consumer"

await branch.bytes(); // branch's cursor at end
// Buffer state: all bytes can be flushed
```

**Same model, different cursor patterns:**

| Operation | Cursor Pattern           | Buffer grows when...                   |
| --------- | ------------------------ | -------------------------------------- |
| `take(n)` | Disjoint ranges          | Later ranges read before earlier ones  |
| `tee()`   | Overlapping (same bytes) | One branch reads faster than the other |

**Buffer configuration applies uniformly:**

The root stream's buffer configuration applies to ALL branching scenarios:

```javascript
const [stream, writer] = Stream.push({
  buffer: {
    max: 1024 * 1024, // 1MB: hard limit
    onOverflow: 'error', // What to do when limit exceeded
  },
});

// These settings apply whether slow consumer is from take() or tee():

// Scenario 1: take() with out-of-order read
const header = stream.take(100);
const body = stream.take(10_000_000); // 10MB
await body.bytes(); // ERROR: header's cursor 10MB behind, exceeds 1MB limit

// Scenario 2: tee() with unbalanced consumers
const branch = stream.tee();
consumeQuickly(stream); // Reads 10MB
// ERROR: branch's cursor 10MB behind (after 1MB buffered), exceeds limit
```

**`onOverflow` policies:**

| Policy          | Behavior                                              |
| --------------- | ----------------------------------------------------- |
| `'error'`       | Error all streams when buffer limit exceeded          |
| `'block'`       | Block writes/fast consumers until space available     |
| `'drop-oldest'` | Discard oldest bytes, advance slow cursor (data loss) |
| `'drop-newest'` | Discard newest bytes, don't buffer more (data loss)   |

**Cancellation advances cursor immediately:**

When a derived stream is cancelled, its cursor is effectively advanced past its range,
allowing those bytes to be flushed (if no other cursor needs them):

```javascript
const a = stream.take(1_000_000); // Cursor A: bytes 0-999999
const b = stream.take(1000); // Cursor B: bytes 1000000-1000999

a.cancel(); // Cursor A marked as "done" — bytes 0-999999 can flush immediately
await b.bytes(); // No buffering needed! Bytes 0-999999 were discarded, not buffered
```

**Abandoned Branch Semantics:**

A critical question for the unified buffer model: what happens when a branch is created but
never consumed or cancelled? This is the "abandoned cursor" problem.

```javascript
const branch = stream.tee();
await stream.bytes(); // Consumes entire stream
// branch never touched — its cursor is stuck at byte 0
```

**The problem:** Since backpressure is determined by the slowest cursor, an abandoned branch
prevents the buffer from ever being flushed. Depending on the `onOverflow` policy:

| Policy          | Behavior with abandoned branch                                |
| --------------- | ------------------------------------------------------------- |
| `'block'`       | **Deadlock** — fast consumer blocks forever waiting for space |
| `'error'`       | Error when buffer fills — surfaces the bug                    |
| `'drop-oldest'` | Silent data loss — branch gets partial/no data if read later  |
| `'drop-newest'` | Silent data loss — new data discarded                         |

**Design decision: Branches are a commitment.**

Creating a branch (via `tee()`, `take()`, or `pipeThrough()`) is a commitment to either:

1. Consume the branch (read it to completion or to the point you need), OR
2. Explicitly cancel it when you're done

This is analogous to opening a file handle — you must close it when done. The API enforces
this through the `onOverflow` policy:

- **Default (`'error'`)**: Abandoned branches cause errors when the buffer fills. This is
  fail-fast behavior that catches bugs during development.
- **Explicit opt-in for lossy behavior**: Use `'drop-oldest'` or `'drop-newest'` if you
  intentionally want to ignore slow/abandoned consumers.

**Why not GC-based cleanup?**

It's tempting to treat a garbage-collected branch as implicitly cancelled. However:

1. **Non-deterministic**: GC timing varies; code might work in testing but fail in production
2. **Can't rely on for correctness**: You can't write correct code that depends on GC timing
3. **Hides bugs**: An abandoned branch is usually a bug; GC cleanup would mask it

**Why not lazy cursor creation?**

Another option: don't create the cursor until the first read. This avoids the abandoned cursor
problem but creates a different one:

```javascript
const branch = stream.tee();
await stream.bytes(); // Consumes everything
// Later...
await branch.bytes(); // Gets nothing! Data already gone
```

This is surprising and violates the principle that `tee()` creates an independent copy.
Lazy cursors make the API harder to reason about.

**The `detached` option for intentional late binding:**

For use cases where you genuinely want late binding (branch created but might not be used,
or might be used much later), we provide an explicit opt-in:

```javascript
// Normal tee: cursor starts at current position, must be consumed or cancelled
const branch = stream.tee();

// Detached tee: no cursor created yet; branch starts empty
const lateBranch = stream.tee({ detached: true });

await stream.bytes(); // No buffer pressure from lateBranch

// Later, if we decide to use it:
lateBranch.attach(); // Cursor created NOW, at current stream position
// lateBranch only sees data from this point forward
```

**Implicit attachment on first read:**

Detached branches are automatically attached when any consumption method is called:

```javascript
const branch = stream.tee({ detached: true });

// ... time passes, data flows through stream ...

// Any of these will implicitly attach the branch at THIS moment:
await branch.bytes(); // Attaches, then reads
await branch.read(); // Attaches, then reads
for await (const c of branch) {
} // Attaches on first iteration
await branch.pipeTo(dest); // Attaches, then pipes
```

The `attach()` method is for when you want to control the _exact_ moment of attachment:

```javascript
const branch = stream.tee({ detached: true });

console.log(branch.detached); // true

// Wait for some condition before attaching
await someCondition();

branch.attach(); // Attach NOW, at current stream position
console.log(branch.detached); // false

// Later reads get data from the attachment point
await branch.bytes();
```

**The `detached` attribute:**

The `detached` attribute indicates whether a stream is currently detached:

```javascript
const normalBranch = stream.tee();
console.log(normalBranch.detached); // false — normal branches are never detached

const detachedBranch = stream.tee({ detached: true });
console.log(detachedBranch.detached); // true — not yet attached

detachedBranch.attach();
console.log(detachedBranch.detached); // false — now attached

// Auto-attachment also clears the detached flag
const another = stream.tee({ detached: true });
console.log(another.detached); // true
await another.read(); // Auto-attaches
console.log(another.detached); // false
```

**Detached branches:**

| Aspect              | Normal branch                   | Detached branch                      |
| ------------------- | ------------------------------- | ------------------------------------ |
| `detached` property | Always `false`                  | `true` until attached                |
| Cursor created      | Immediately on `tee()`/`take()` | On first read or explicit `attach()` |
| Backpressure        | Contributes immediately         | No contribution until attached       |
| Data availability   | All data from branch point      | Only data after attachment           |
| Use case            | "I will read this"              | "I might read this later"            |

```javascript
// Detached branch example: conditional logging
const logBranch = stream.tee({ detached: true });

const data = await stream.bytes();
if (shouldLog(data)) {
  // Too late — logBranch missed the data
  // This is the expected behavior for detached branches
}

// Correct pattern for conditional logging:
const logBranch = stream.tee(); // Normal branch
const data = await stream.bytes();
if (shouldLog(data)) {
  await logBranch.pipeTo(logger);
} else {
  logBranch.cancel(); // Must cancel if not using
}
```

**Summary of abandoned branch handling:**

| Scenario                             | Default behavior (`'error'`) | With `detached: true`           |
| ------------------------------------ | ---------------------------- | ------------------------------- |
| Branch created, never read           | Error when buffer fills      | No error; branch gets no data   |
| Branch created, read later           | Works if buffer large enough | Gets only data after attachment |
| Branch created, explicitly cancelled | Works; cursor removed        | Works; no cursor existed        |

**Best practices:**

1. **Always consume or cancel branches** — Treat them like file handles
2. **Use `detached: true` for optional branches** — When you might not read the branch
3. **Size buffers appropriately** — If branches might lag, ensure buffer can hold the gap
4. **Prefer `'error'` policy during development** — Catches abandoned branch bugs early
5. **Use `'drop-oldest'` for lossy scenarios** — Video frames, real-time data where old data is stale

### Operators (Combinators)

The core API provides a minimal set of operators. Additional functionality (parsing, compression,
timing, etc.) can be implemented in user code or separate libraries via `pipeThrough()`.

**Built-in operators:**

```javascript
// Slicing (always in bytes) — see "How take(n)/drop(n) works" above
stream.take(1024); // View of next 1024 bytes; parent continues at byte 1025
stream.drop(1024); // Discard next 1024 bytes; parent continues at byte 1025

// Combination (static methods)
Stream.merge(s1, s2, s3); // Interleaved, first-come
Stream.concat(s1, s2, s3); // Sequential

// Error handling
stream.catch((err) => Stream.from('fallback data'));
```

**Operators left to user code / libraries:**

The following are intentionally NOT part of the core API to keep it minimal:

| Category    | Examples                                | How to implement                                |
| ----------- | --------------------------------------- | ----------------------------------------------- |
| Parsing     | `lines()`, `split()`, `rechunk()`       | Custom transform via `pipeThrough()`            |
| Compression | `compress()`, `decompress()`            | Use `CompressionStream` / `DecompressionStream` |
| Encoding    | `decode()`                              | Use `TextDecoderStream`                         |
| Timing      | `debounce()`, `throttle()`, `timeout()` | Custom transform with timers                    |
| Retry       | `retry()`                               | Wrapper function around stream creation         |

**Example: implementing a line parser as a transform:**

```javascript
async function* lineParser(stream) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line
    for (const line of lines) {
      yield line;
    }
  }

  if (buffer) yield buffer; // Yield final line
}

// Usage
for await (const line of lineParser(stream)) {
  console.log(line);
}
```

### Piping

```javascript
// Pipe to writable (consumes source)
await source.pipeTo(destination);

// Pipe through transform — returns readable output Stream
const transformed = source.pipeThrough(transformFn);

// With transform options (chunkSize, buffer config)
const transformed = source.pipeThrough(transformFn, {
  chunkSize: 1024,
  buffer: { max: 1024 * 1024, onOverflow: 'error' },
});

// Chain transforms (each can have its own buffer config)
const result = await source
  .pipeThrough(decompress, { buffer: { max: 10 * 1024 * 1024 } })
  .pipeThrough(parse)
  .bytes();

// pipeTo options (including AbortSignal for cancellation/timeout)
await source.pipeTo(destination, {
  signal: AbortSignal.timeout(30000), // Cancel if not complete in 30s
  limit: 1024 * 1024, // Limit: pipe at most 1MB
  preventClose: false,
  preventAbort: false,
  preventCancel: false,
});

// Limit bytes piped (more efficient than stream.limit(n).pipeTo())
await source.pipeTo(destination, { limit: 10 * 1024 * 1024 }); // Max 10MB

// pipeThrough also accepts signal and limit
const result = await source
  .pipeThrough(transform, { signal, limit: 1024 })
  .bytes({ signal });
```

**`pipeThrough` creates a branch:**

Like `tee()`, `take()`, and `limit()`, calling `pipeThrough()` creates a **branch** on the
underlying stream. The original stream remains usable and continues from where the branch
left off:

```javascript
// pipeThrough creates a branch — original stream continues
const compressed = stream.pipeThrough(new CompressionStream('gzip'));

// Original stream is still usable! Continues after compressed data
const remainder = await stream.bytes();
```

**With `limit` option:**

The `limit` option on `pipeThrough` pipes only the specified number of bytes through the
transform, then the transform receives its flush signal (`null`). The parent stream continues
at the byte after the limit:

```javascript
// Transform only the first 1KB, then continue with raw stream
const header = stream.pipeThrough(headerParser, { limit: 1024 });
const parsedHeader = await header.bytes();

// Original stream continues at byte 1024
const body = await stream.bytes();
```

This is equivalent to `stream.take(n).pipeThrough(transform)` but more efficient (no
intermediate stream object).

**No `preventClose`/`preventAbort`/`preventCancel` on `pipeThrough`:**

Unlike Web Streams, `pipeThrough` does **not** support the `prevent*` options. This is a
deliberate departure from the spec because:

1. **Transform is created internally** — `pipeThrough` creates the transform's writer internally
   from your transformer; there's no external writer to reuse or manage independently
2. **Flush requires close** — if you prevent closing the transform's writer, it won't receive
   the flush signal (`transform(null)`), breaking stateful transforms
3. **Branching handles continuation** — `pipeThrough` creates a branch, so the parent stream
   continues regardless; you don't need `preventCancel` to preserve the source

If you need fine-grained control over the transform lifecycle, use `Stream.transform()` directly
to get the `[Stream, Writer]` pair and manage it manually:

```javascript
// Manual control when needed
const [output, writer] = Stream.transform(myTransformer);
source.pipeTo(writer, { preventClose: true }); // Now you control when to close
```

**Pipeline buffer considerations:**

Each stage in a pipeline has its own buffer. With N transforms, there are N+1 potential buffers:

```
source ──→ [buf₁] ──→ transform₁ ──→ [buf₂] ──→ transform₂ ──→ [buf₃] ──→ consumer
```

This has important implications:

| Consideration    | Impact                                                       |
| ---------------- | ------------------------------------------------------------ |
| **Memory**       | Total memory = sum of all buffer `max` values (worst case)   |
| **Latency**      | Data traverses multiple buffers; each adds potential latency |
| **Backpressure** | Propagates backwards through stages; each buffer adds delay  |

**Best practices for pipeline buffer configuration:**

1. **Size buffers according to the transform's characteristics:**

   ```javascript
   source
     // Decompression can expand data significantly — larger buffer
     .pipeThrough(decompress, { buffer: { max: 10 * 1024 * 1024 } })
     // Parsing is typically 1:1 — smaller buffer sufficient
     .pipeThrough(parse, { buffer: { max: 64 * 1024 } });
   ```

2. **Consider total pipeline memory:**

   ```javascript
   // 3 transforms × 1MB = 3MB max buffered
   // Is this acceptable for your use case?
   ```

3. **Match policies to transform behavior:**

   ```javascript
   // Lossy transform (e.g., video frames) — dropping is acceptable
   .pipeThrough(videoDecoder, { buffer: { onOverflow: 'drop-oldest' } })

   // Lossless transform — must not drop data
   .pipeThrough(cryptoDecrypt, { buffer: { onOverflow: 'block', hardMax: 50 * 1024 * 1024 } })
   ```

4. **Use `'error'` during development** to surface backpressure issues early, then tune
   buffer sizes based on observed behavior.

**Pipeline error propagation:**

Errors propagate **bidirectionally** through a pipeline. If any stage errors, the entire
pipeline is torn down:

```
source ──→ transform₁ ──→ transform₂ ──→ destination
   ↑           ↑              ↑              ↑
   └───────────┴──────────────┴──────────────┘
              errors propagate both ways
```

| Error origin     | Forward propagation                | Backward propagation               |
| ---------------- | ---------------------------------- | ---------------------------------- |
| Source errors    | All transforms and dest error      | N/A (source is origin)             |
| Transform errors | Downstream transforms + dest error | Source cancelled, upstream errored |
| Dest errors      | N/A (dest is terminus)             | All transforms + source cancelled  |

```javascript
// Example: destination error propagates backward
const [stream, writer] = Stream.push();

// Start pipeline
stream
  .pipeThrough(transform1)
  .pipeThrough(transform2)
  .pipeTo(destination)
  .catch((e) => console.log('Pipeline failed:', e));

// If destination errors (e.g., disk full):
// 1. pipeTo() promise rejects
// 2. transform2's readable side errors
// 3. transform1's readable side errors
// 4. source stream is cancelled
// 5. writer.closed rejects with the error

// The writer sees the error even though it's at the opposite end:
writer.closed.catch((e) => console.log('Writer saw error:', e));
```

This bidirectional propagation ensures:

- **No dangling resources** — all stages are cleaned up regardless of where the error occurred
- **No silent failures** — the initiator always learns about errors, even from distant stages
- **Consistent state** — the entire pipeline fails atomically; no partial success

**Cancellation vs. error propagation:**

| Signal     | Forward direction        | Backward direction         |
| ---------- | ------------------------ | -------------------------- |
| **Error**  | Error propagates forward | Error propagates backward  |
| **Cancel** | N/A                      | Cancel propagates backward |

When a consumer cancels (e.g., `stream.cancel()` or breaking out of `for await`), cancellation
propagates backward to the source but does NOT error downstream stages — they simply see EOF.

### Branching (Tee)

Branching creates derived streams with cursors into the unified buffer (see "Unified Buffer
and Cursor Model" above).

```javascript
// Tee: create a new branch — both stream and branch see the same bytes
// The original stream remains usable as one branch
const branch = stream.tee({
  buffer: {
    max: 1024 * 1024, // Override: 1MB limit between branches
    onOverflow: 'drop-oldest', // Override: drop for slow branch
  },
});

// Now both `stream` and `branch` can be consumed independently
// Both see the same bytes (parallel branching)
consumeForLogging(branch);
const data = await stream.bytes(); // Original stream still usable

// Multiple branches: just call tee() multiple times
const branch1 = stream.tee();
const branch2 = stream.tee();
const branch3 = stream.tee();
// stream, branch1, branch2, branch3 all see the same bytes
// Slowest cursor determines backpressure
```

**Note:** `take()` is also a branching operation (sequential branching), using the same
buffer and cursor model. See "Unified Branching Model" above.

### Backpressure

Backpressure is managed through the unified buffer model (see "Unified Buffer and Cursor Model"
above). The key insight: **backpressure is determined by the slowest cursor** across all
derived streams.

```javascript
// Buffer configuration at stream creation
const [stream, writer] = Stream.push({
  buffer: {
    max: 1024 * 1024, // 1MB: hard limit
    onOverflow: 'error', // or 'block', 'drop-oldest', 'drop-newest'
  },
});

// Just await write() — backpressure handled by onOverflow policy
source.ondata = async (data) => {
  await writer.write(data); // Blocks, errors, or drops based on policy
};

// Pull sources get natural backpressure - generator pauses until consumer reads
const stream = Stream.pull(async function* () {
  for await (const row of database.cursor()) {
    yield JSON.stringify(row) + '\n'; // Pauses here until consumer needs data
  }
});
```

**Defense against uncontrolled buffer growth:**

The `max` limit provides a hard defense. The `write()` promise behavior depends on buffer state:

| Buffer state      | `writer.write()` behavior      | `desiredSize`    |
| ----------------- | ------------------------------ | ---------------- |
| Below `max`       | Resolves immediately           | Positive         |
| At or above `max` | Depends on `onOverflow` policy | Zero or negative |

**`onOverflow` policies** (when buffer would exceed `max`):

| Policy          | `write()` behavior                            | Data loss | Use case                             |
| --------------- | --------------------------------------------- | --------- | ------------------------------------ |
| `'error'`       | Rejects with error                            | No        | Fail-fast; surface bugs              |
| `'block'`       | Promise doesn't resolve until space available | No        | Strict backpressure                  |
| `'drop-oldest'` | Resolves; discards oldest buffered data       | Yes       | Lossy streaming (e.g., live video)   |
| `'drop-newest'` | Resolves; discards the data being written     | Yes       | Lossy streaming; preserve older data |

**Error propagation:**

When `'error'` policy triggers (or `'block'` hits its hard limit — see below):

1. The `write()` promise rejects
2. The writer transitions to an **errored state**
3. All subsequent writes immediately reject
4. The `closed` promise rejects
5. The readable Stream **also errors** — consumers see the failure

This ensures that even if the producer ignores write errors, the consumer will see the failure:

```javascript
const [stream, writer] = Stream.push({
  buffer: { max: 1024, onOverflow: 'error' },
});

// Producer ignores write results (bad practice, but happens)
writer.write(hugeData); // Exceeds buffer, rejects (ignored by producer)
writer.write(moreData); // Writer now errored, rejects immediately

// Consumer sees the error even though producer ignored it
await stream.bytes(); // Rejects with buffer overflow error
```

**Hard limit for `'block'` policy:**

The `'block'` policy can be a footgun — if the consumer stalls, pending `write()` promises
accumulate indefinitely. To prevent unbounded growth, use `hardMax`:

```javascript
const [stream, writer] = Stream.push({
  buffer: {
    max: 1024 * 1024, // 1MB: start blocking here
    hardMax: 10 * 1024 * 1024, // 10MB: error here (fallback)
    onOverflow: 'block',
  },
});
```

| Buffer state                | Behavior                                            |
| --------------------------- | --------------------------------------------------- |
| Below `max`                 | `write()` resolves immediately                      |
| Between `max` and `hardMax` | `write()` blocks until space available              |
| At or above `hardMax`       | Falls back to `'error'` — rejects and errors stream |

If `hardMax` is not specified, `'block'` will block indefinitely (use with caution).

**Default behavior:**

If no buffer configuration is specified:

- `max`: 1MB
- `onOverflow`: `'error'`

The default `'error'` policy ensures that ignoring backpressure is surfaced as a bug rather
than causing silent memory growth or data loss.

**Proactive backpressure checking:**

For cases where you want to check buffer state before writing, inspect `desiredSize`:

```javascript
if (writer.desiredSize > 0) {
  // Buffer has space — safe to write without hitting limits
  writer.write(data);
} else {
  // Buffer full or nearly full — consider slowing down
  await writer.write(data); // Will block/error/drop per policy
}
```

**Backpressure propagates through branches:**

When you create derived streams via `take()` or `tee()`, the buffer configuration propagates
from the root. The slowest cursor among ALL derived streams determines backpressure:

```javascript
const [stream, writer] = Stream.push({
  buffer: { max: 4096, onOverflow: 'block' },
});

const branch = stream.tee();
const header = stream.take(100);
const body = stream.take(1000);

// Now there are multiple cursors: header, body, branch
// Buffer fills when slowest cursor falls behind
// write() blocks when buffer hits 4KB (waiting for slowest cursor)
```

**Overriding buffer config on branches:**

Branches can override the parent's buffer configuration for their subtree:

```javascript
const branch = stream.tee({
  buffer: {
    max: 10 * 1024 * 1024, // Allow 10MB buffer between branches
    onOverflow: 'drop-oldest', // Drop data for slow branch instead of blocking
  },
});
// This buffer config applies to stream vs branch, not to the root stream's source
```

### Explicit Resource Management

Both `Stream` and `Writer` support TC39 Explicit Resource Management via `Symbol.asyncDispose`,
enabling the `await using` syntax for automatic cleanup:

```javascript
// Stream: automatically cancelled when block exits
async function processResponse(response) {
  await using stream = response.body;

  const header = await stream.take(100).bytes();
  if (!isValidHeader(header)) {
    return null; // Stream automatically cancelled here
  }

  return await stream.bytes();
} // Stream cancelled if not fully consumed

// Writer: automatically closed when block exits
async function writeData(data) {
  const [stream, writer] = Stream.push();

  await using _ = writer; // Will close on block exit

  for (const chunk of data) {
    await writer.write(chunk);
  }
} // Writer automatically closed here
```

**Semantics:**

| Type     | `[Symbol.asyncDispose]()` calls | Rationale                                      |
| -------- | ------------------------------- | ---------------------------------------------- |
| `Stream` | `cancel()`                      | Signal disinterest; release upstream resources |
| `Writer` | `close()`                       | Graceful shutdown; flush pending writes        |

**Idempotency:** Both `cancel()` and `close()` are idempotent. Calling dispose on an
already-closed/cancelled stream or writer is a no-op.

**Error handling with writers:**

The `await using` pattern calls `close()` regardless of whether the block exited normally
or via exception. If you want to abort on error instead:

```javascript
async function writeWithAbortOnError(data) {
  const [stream, writer] = Stream.push();

  try {
    for (const chunk of data) {
      await writer.write(chunk);
    }
    await writer.close(); // Explicit close on success
  } catch (err) {
    await writer.abort(err); // Abort on error
    throw err;
  }
}
```

Or use a helper:

```javascript
// Helper for "close on success, abort on error"
async function withWriter(writer, fn) {
  try {
    await fn(writer);
    await writer.close();
  } catch (err) {
    await writer.abort(err);
    throw err;
  }
}

// Usage
await withWriter(writer, async (w) => {
  await w.write('hello');
  await w.write('world');
});
```

**Nested resources:**

```javascript
async function copyFile(srcPath, dstPath) {
  await using srcStream = (await openFile(srcPath)).stream();
  const [dstStream, writer] = Stream.push();
  await using _ = writer;

  await srcStream.pipeTo(writer);
} // Both srcStream and writer cleaned up, even on error
```

**Why `close()` instead of `abort()` for Writer dispose?**

The `await using` pattern is typically used when you _intend_ to complete the operation.
Calling `close()` ensures buffered data is flushed. If an exception occurs:

1. `close()` is still called (per ERM semantics)
2. If `close()` also throws (e.g., flush fails), both errors are aggregated into `SuppressedError`
3. The original error is preserved as the primary error

This matches the behavior of file handles and database connections in other languages.

### BYOB (Bring Your Own Buffer) Reading

Since all streams are byte streams, BYOB reading is available on all streams via the `read()`
method.

**What BYOB means in this API:**

BYOB means the **read operation** will not allocate a new buffer for the result. Instead, data
is copied into the buffer you provide. This avoids one allocation per read.

**What BYOB does NOT mean:**

BYOB does **not** provide end-to-end zero-copy. Data is still copied from the internal buffer
(or source) into your provided buffer. True zero-copy would require the source to write
directly into your buffer, which is:

- Difficult to achieve in practice (requires cooperation from I/O subsystems)
- Rarely implemented even in the current Web Streams ecosystem (`controller.byobRequest` is
  largely unused)
- Not worth the API complexity for marginal gains in most use cases

**The guarantee:** Enables zero-copy data transfer. The provided buffer is detached and
ownership transfers to the stream implementation.

**IMPORTANT: Buffers are detached after use.**

When you provide a buffer to `read()`, or pass a buffer to `write()`/`writev()`, that
buffer is **detached** (its `ArrayBuffer` becomes zero-length and unusable). This:

- Enables zero-copy optimizations in the implementation
- Prevents use-after-transfer bugs where caller continues using transferred data
- Is consistent with `postMessage()` transferables and other modern APIs

```javascript
const buffer = new Uint8Array(64 * 1024);
const { value, done } = await stream.read({ buffer });

// `buffer` is now DETACHED — do not reuse it!
console.log(buffer.byteLength); // 0 (detached)

// `value` is the new view into the (now-owned) buffer
console.log(value.byteLength); // Number of bytes read

// For subsequent reads, use `value` as your buffer (or allocate new)
const { value: value2, done: done2 } = await stream.read({ buffer: value });
// Now `value` is detached, `value2` is the new view
```

**BYOB read loop pattern:**

```javascript
let buffer = new Uint8Array(64 * 1024);
while (true) {
  const { value, done } = await stream.read({ buffer });
  if (value) {
    process(value); // Process the data
    buffer = value; // Reuse for next iteration (value becomes the buffer)
  }
  if (done) break;
}
```

**Same applies to writes:**

```javascript
const data = new Uint8Array([1, 2, 3, 4]);
await writer.write(data);

// `data` is now DETACHED — do not reuse it!
console.log(data.byteLength); // 0 (detached)
```

**Non-BYOB reads (no buffer provided) allocate fresh buffers:**

```javascript
// Without buffer option, read() allocates a new Uint8Array each time
const { value, done } = await stream.read();
// `value` is a freshly allocated Uint8Array (caller owns it)
```

**value can be non-null when done=true (final chunk):**

```javascript
// IMPORTANT: value can be non-null even when done=true (final chunk)
// This differs from Web Streams which requires an extra read to see done
const { value, done } = await stream.read({ buffer });
if (done) {
  console.log('Stream ended');
  if (value) console.log(`Final ${value.byteLength} bytes received`);
}
```

### Read Options: `atLeast` and `signal`

The `read()` method accepts options that improve performance and control:

**`max` — Bound allocation size (non-BYOB only):**

When not using BYOB, `max` limits how many bytes are returned, bounding the allocation:

```javascript
// Without max: returned buffer could be any size
const { value } = await stream.read(); // value.length unbounded

// With max: returned buffer is at most 16KB
const { value, done } = await stream.read({ max: 16384 });
// value.length <= 16384

// Useful for processing in bounded chunks without providing your own buffer
while (true) {
  const { value, done } = await stream.read({ max: 64 * 1024 });
  if (value) await processChunk(value); // Chunks are at most 64KB
  if (done) break;
}
```

When using BYOB (`buffer` option), `max` is ignored — the buffer's `byteLength` is the
implicit maximum.

**`atLeast` — Batch small chunks for efficiency:**

By default, `read()` returns as soon as any data is available, which can result in many
small reads. The `atLeast` option waits until at least N bytes are available:

```javascript
// Without atLeast: may return small chunks (1 byte, 100 bytes, etc.)
const { value } = await stream.read(); // value.length could be anything

// With atLeast: waits for at least 16KB before returning
const { value, done } = await stream.read({ atLeast: 16384 });
// value.length >= 16384, unless stream ended (then value has remaining bytes)

// If stream ends before atLeast bytes: returns what's available with done=true
// Example: stream has 5000 bytes remaining, atLeast is 16384
const { value, done } = await stream.read({ atLeast: 16384 });
// value.length === 5000, done === true
```

**Combining `atLeast` and `max`:**

Use both to request a range: at least N bytes, at most M bytes.

```javascript
// Wait for at least 4KB, return at most 64KB
const { value, done } = await stream.read({ atLeast: 4096, max: 65536 });
// 4096 <= value.length <= 65536 (unless stream ends with fewer bytes)

// Error: atLeast > max
await stream.read({ atLeast: 1000, max: 100 }); // RangeError
```

**Performance impact:** In Cloudflare Workers, using `atLeast` can significantly reduce
read call overhead, especially for streams that produce many small chunks (e.g., chunked
HTTP responses, WebSocket messages).

```javascript
// Efficient large reads with BYOB + atLeast
const buffer = new Uint8Array(64 * 1024);
while (true) {
  const { value, done } = await stream.read({ buffer, atLeast: 16384 });
  if (value) await processChunk(value); // Chunks are at least 16KB (or final)
  if (done) break;
}
```

**Performance impact:** In Cloudflare Workers, using `atLeast` can significantly reduce
read call overhead, especially for streams that produce many small chunks (e.g., chunked
HTTP responses, WebSocket messages).

```javascript
// Efficient large reads with BYOB + atLeast
const buffer = new Uint8Array(64 * 1024);
while (true) {
  const { value, done } = await stream.read({ buffer, atLeast: 16384 });
  if (value) await processChunk(value); // Chunks are at least 16KB (or final)
  if (done) break;
}
```

**`signal` — Cancel a pending read:**

```javascript
const controller = new AbortController();

// Set a timeout for this specific read
setTimeout(() => controller.abort(), 5000);

try {
  const { value, done } = await stream.read({ signal: controller.signal });
} catch (e) {
  if (e.name === 'AbortError') {
    console.log('Read timed out or was cancelled');
  }
}

// Or use AbortSignal.timeout() directly
const { value, done } = await stream.read({
  signal: AbortSignal.timeout(5000),
});
```

**Combining all options:**

```javascript
// BYOB mode: buffer + atLeast + signal
const buffer = new Uint8Array(64 * 1024);
const { value, done } = await stream.read({
  buffer, // BYOB: use my buffer (max is buffer.byteLength)
  atLeast: 16384, // Wait for at least 16KB
  signal: AbortSignal.timeout(10000), // Give up after 10 seconds
});

// Non-BYOB mode: max + atLeast + signal
const { value, done } = await stream.read({
  max: 65536, // Allocate at most 64KB
  atLeast: 16384, // Wait for at least 16KB
  signal: AbortSignal.timeout(10000), // Give up after 10 seconds
});
```

**Performance impact:** In Cloudflare Workers, using `atLeast` can significantly reduce
read call overhead, especially for streams that produce many small chunks (e.g., chunked
HTTP responses, WebSocket messages).

```javascript
// Efficient large reads with BYOB + atLeast
const buffer = new Uint8Array(64 * 1024);
while (true) {
  const { value, done } = await stream.read(buffer, { atLeast: 16384 });
  if (value) await processChunk(value); // Chunks are at least 16KB (or final)
  if (done) break;
}
```

**`signal` — Cancel a pending read:**

```javascript
const controller = new AbortController();

// Set a timeout for this specific read
setTimeout(() => controller.abort(), 5000);

try {
  const { value, done } = await stream.read(buffer, {
    signal: controller.signal,
  });
} catch (e) {
  if (e.name === 'AbortError') {
    console.log('Read timed out or was cancelled');
  }
}

// Or use AbortSignal.timeout() directly
const { value, done } = await stream.read(buffer, {
  signal: AbortSignal.timeout(5000),
});
```

**Combining options:**

```javascript
// Wait for at least 16KB, but give up after 10 seconds
const { value, done } = await stream.read(buffer, {
  atLeast: 16384,
  signal: AbortSignal.timeout(10000),
});
```

### Concurrent Reads

Multiple concurrent `read()` calls on the same stream are **queued and executed in order**.
This provides deterministic behavior unlike Web Streams where concurrent reads can produce
unpredictable results:

```javascript
const [stream, writer] = Stream.push();

// Write data asynchronously
(async () => {
  await writer.write('a');
  await writer.write('b');
  await writer.write('c');
  await writer.close();
})();

// Multiple reads issued concurrently
const [r1, r2, r3] = await Promise.all([
  stream.read(),
  stream.read(),
  stream.read(),
]);

// Reads complete in order: r1 gets 'a', r2 gets 'b', r3 gets 'c'
// (or combined chunks depending on timing, but always in FIFO order)
```

**How it works:**
- Each `read()` call is added to an internal queue
- Reads execute sequentially, waiting for the previous read to complete
- This ensures consistent cursor advancement and prevents data races

**Performance note:** For maximum throughput, prefer using async iteration or the `bytes()`
method rather than issuing many concurrent `read()` calls. The queuing adds minimal overhead
but async iteration is more idiomatic:

```javascript
// Preferred: async iteration (implicitly serialized)
for await (const chunk of stream) {
  process(chunk);
}

// Or: single consumption call
const allData = await stream.bytes();
```

### Final Chunk with EOF (differs from Web Streams)

Unlike Web Streams, this API allows `read()` to return **both data and done=true** in
a single result. This eliminates the extra read call required by Web Streams to detect EOF:

```javascript
// Web Streams pattern (extra read required):
while (true) {
  const { value, done } = await reader.read();
  if (done) break; // No value on final read
  process(value);
}

// This API (final chunk included):
while (true) {
  const { value, done } = await stream.read();
  if (value) process(value); // May be final chunk
  if (done) break; // Check done AFTER processing
}
```

**Result combinations:**

| `value`  | `done`  | Meaning                                  |
| -------- | ------- | ---------------------------------------- |
| non-null | `false` | Data available, more may come            |
| non-null | `true`  | Final data chunk, stream ended           |
| `null`   | `true`  | Stream ended, no remaining data          |
| `null`   | `false` | Never returned (always has data or done) |

**When to use BYOB:**

- High-frequency reads where allocation overhead matters
- When you want to control buffer lifecycle (e.g., pooling)
- When processing data in fixed-size chunks

**When NOT to use BYOB:**

- Simple stream consumption — just use `stream.bytes()` or async iteration
- When you don't care about allocation overhead (most cases)

### Custom Transforms

`Stream.transform()` returns a `[Stream, Writer]` pair, just like `Stream.push()`. Data
written to the Writer is passed to the transform function; output from the transform
is available from the Stream side.

```javascript
// Stream.transform() returns [Stream, Writer]
const [readable, writer] = Stream.transform(transformFn);

// Write input to the writer
await writer.write(inputData);
await writer.close();

// Read output from the readable side
const result = await readable.bytes();
```

**Transform options:**

`Stream.transform()` and `pipeThrough()` accept the same options:

```javascript
const [readable, writable] = Stream.transform(transformFn, {
  // Chunk size — transform receives fixed-size chunks (except final)
  chunkSize: 1024,

  // Buffer configuration — same as Stream.push()
  buffer: {
    max: 1024 * 1024, // 1MB: buffer limit
    hardMax: 10 * 1024 * 1024, // 10MB: hard limit for 'block' policy
    onOverflow: 'error', // 'error', 'block', 'drop-oldest', 'drop-newest'
  },
});

// Same options work with pipeThrough()
const output = source.pipeThrough(transformFn, {
  chunkSize: 16,
  buffer: { max: 64 * 1024, onOverflow: 'block' },
});
```

**`chunkSize`:** Ensures the transform receives fixed-size chunks. Useful for:

- Block ciphers (e.g., 16-byte AES blocks)
- Fixed-width record parsers
- Compression algorithms with specific block sizes

Without `chunkSize`, transforms receive chunks as written — sizes are determined by the
writer, and data may be split arbitrarily across chunk boundaries.

**`buffer`:** Same configuration as `Stream.push()`. Controls backpressure between the
writable input side and the readable output side. If the consumer of the transform's output
is slow, the buffer fills up and the configured `onOverflow` policy applies.

**Simple transform (function):**

```javascript
// Transform function: chunk is null when input ends (flush)
// Return bytes to emit, or null to emit nothing
const uppercase = (chunk) => {
  if (chunk === null) return null; // No flush output
  const result = new Uint8Array(chunk.length);
  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i];
    // Uppercase ASCII letters (a-z → A-Z)
    result[i] = byte >= 97 && byte <= 122 ? byte - 32 : byte;
  }
  return result;
};

// Use with pipeThrough()
const uppercased = await source.pipeThrough(uppercase).bytes();

// Or with Stream.transform() for manual control
const [readable, writer] = Stream.transform(uppercase);
await writer.write(inputData);
await writer.close();
const result = await readable.bytes();
```

**Stateful transforms (object with `transform()` method):**

For transforms that need to maintain state across chunks (e.g., buffering partial data),
use any object with a `transform(chunk)` method. No base class required — this is duck
typing. The method receives `null` when input ends, signaling it should emit any remaining
buffered data. See "StreamTransformer protocol" in the WebIDL Notes for details.

**Example: Line parser using factory function (1:N transform):**

```javascript
function createLineParser() {
  let buffer = new Uint8Array(0);
  const decoder = new TextDecoder();

  return {
    // Sync generator: yields zero or more output values per input chunk
    // When chunk is null, input has ended — emit any remaining data
    *transform(chunk) {
      if (chunk === null) {
        // Flush: emit any remaining buffered data
        if (buffer.length > 0) {
          yield decoder.decode(buffer);
        }
        return;
      }

      // Append to buffer
      const combined = new Uint8Array(buffer.length + chunk.length);
      combined.set(buffer);
      combined.set(chunk, buffer.length);

      // Find and yield complete lines
      let start = 0;
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] === 10) {
          // newline
          yield decoder.decode(combined.slice(start, i));
          start = i + 1;
        }
      }

      // Keep incomplete line for next chunk
      buffer = combined.slice(start);
    },
  };
}
```

**Example: Accumulator using factory function (N:1 transform):**

```javascript
function createChunkAccumulator(targetSize = 64 * 1024) {
  let chunks = [];
  let totalSize = 0;

  function emit() {
    const result = concatenate(chunks);
    chunks = [];
    totalSize = 0;
    return result;
  }

  return {
    // Returns null to accumulate, or bytes when target reached
    // When chunk is null (flush), emit any remaining accumulated data
    transform(chunk) {
      if (chunk === null) {
        // Flush: emit remaining
        return chunks.length > 0 ? emit() : null;
      }

      chunks.push(chunk);
      totalSize += chunk.byteLength;

      if (totalSize >= targetSize) {
        return emit(); // Returns Uint8Array
      }
      return null; // Accumulate more
    },
  };
}
```

**Example: Async transform using class (async 1:1):**

```javascript
// Classes work too — any object with transform() method
class AsyncEncryptor {
  #key;

  constructor(key) {
    this.#key = key;
  }

  // Async function: returns Promise<Uint8Array>
  // No special flush handling needed for stateless transforms
  async transform(chunk) {
    if (chunk === null) return null; // No flush output
    return await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: generateIV() },
      this.#key,
      chunk
    );
  }
}
```

**Usage:**

```javascript
// Factory function
const lines = [];
for await (const line of source.pipeThrough(createLineParser())) {
  lines.push(line); // line is a string (UTF-8 encoded when emitted)
}

// Class instance
const encrypted = await source.pipeThrough(new AsyncEncryptor(key)).bytes();

// Or with Stream.transform() for manual control
const [readable, writer] = Stream.transform(createLineParser());
(async () => {
  for await (const chunk of source) await writer.write(chunk);
  await writer.close();
})();

for await (const line of readable) {
  console.log(line);
}
```

Note: When a transform yields strings (like the line parser), they are UTF-8 encoded to
bytes. The output stream is still a byte stream.

**Convenience: `stream.pipeThrough()`**

For the common case of piping a source through a transform, use `pipeThrough()`. It accepts the
same arguments as `Stream.transform()` but returns just the readable Stream (not a tuple):

```javascript
// pipeThrough() connects source to transform and returns the readable output
const output = source.pipeThrough(new LineParser());

// Iterate to get lines
for await (const line of output) {
  console.log(line);
}
```

**Chaining transforms:**

Since `pipeThrough()` returns a Stream, transforms can be chained:

```javascript
const result = await source
  .pipeThrough(decompressor)
  .pipeThrough(validator)
  .bytes();

// With options (same as Stream.transform options)
const result = await source.pipeThrough(blockCipher, { chunkSize: 16 }).bytes();
```

**When to use `Stream.transform()` vs `pipeThrough()`:**

| Use case                                  | Method                                            |
| ----------------------------------------- | ------------------------------------------------- |
| Chain transforms, just need output        | `pipeThrough()` — returns Stream                  |
| Need explicit access to writer            | `Stream.transform()` — returns `[Stream, Writer]` |
| Multiple sources writing to one transform | `Stream.transform()`                              |
| Manual control over write lifecycle       | `Stream.transform()`                              |

### Static Pipeline Construction

`Stream.pipeline()` constructs an optimized pipeline from source through transforms to a
destination. Similar to Node.js's `stream.pipeline()`, it allows the implementation to
optimize the entire pipeline as a unit.

```javascript
// Basic pipeline: source → transforms → destination
const bytesWritten = await Stream.pipeline(
  source,
  decompressor,
  parser,
  validator,
  destination
);

// With options
const bytesWritten = await Stream.pipeline(
  source,
  transform1,
  transform2,
  destination,
  {
    signal: AbortSignal.timeout(30000), // Cancel entire pipeline after 30s
    limit: 10 * 1024 * 1024, // Max 10MB through pipeline
  }
);

// Equivalent to (but potentially more efficient than):
await source
  .pipeThrough(decompressor)
  .pipeThrough(parser)
  .pipeThrough(validator)
  .pipeTo(destination);
```

**Why use `Stream.pipeline()` over chaining?**

| Aspect           | `pipeThrough().pipeTo()` chain | `Stream.pipeline()`                |
| ---------------- | ------------------------------ | ---------------------------------- |
| Promise overhead | N+1 promises for N transforms  | Single promise for entire pipeline |
| Optimization     | Each stage independent         | Implementation can fuse stages     |
| Cancellation     | Must pass signal to each stage | Single signal cancels everything   |
| Error handling   | Errors propagate through chain | Same, but simpler to reason about  |
| Syntax           | Fluent chaining                | Single call with all stages        |

**Pipeline stages:**

The stages after the source can be any mix of:

- `StreamTransformer` (function or object with `transform()` method)
- `Writer` (must be the final stage)

```javascript
// Transforms can be functions, objects, or class instances
await Stream.pipeline(
  source,
  (chunk) => chunk?.map((b) => b ^ 0xff), // Function transform
  createLineParser(), // Factory-created object
  new Encryptor(key), // Class instance
  destination // Final Writer
);
```

**Return value:**

Returns a promise that resolves with the total number of bytes that flowed through the
pipeline (same as `pipeTo()`).

**Multiple pipelines to the same destination:**

Use `preventClose` to run multiple pipelines to the same destination sequentially:

```javascript
const destination = Stream.writer(fileSink);

// First pipeline — don't close destination yet
await Stream.pipeline(source1, transform, destination, { preventClose: true });

// Second pipeline — still don't close
await Stream.pipeline(source2, transform, destination, { preventClose: true });

// Final pipeline — now close destination
await Stream.pipeline(source3, transform, destination);
```

Note: Unlike `pipeTo`, `pipeline()` does not include `preventAbort` or `preventCancel` options.
The pipeline is treated as a single optimized unit with unified error handling. If you need
fine-grained error control between stages, use manual `pipeThrough().pipeTo()` chains instead.

**Error propagation in pipelines:**

Errors propagate **bidirectionally** through the pipeline. When any stage errors, the entire
pipeline is torn down:

```javascript
await Stream.pipeline(source, transform1, transform2, destination);

// If source errors:
//   → transform1, transform2, destination all abort
//   → pipeline() rejects with the source error
//
// If transform1 errors:
//   → source is cancelled
//   → transform2, destination abort
//   → pipeline() rejects with transform1's error
//
// If destination errors:
//   → source is cancelled
//   → transform1, transform2 abort
//   → pipeline() rejects with destination error
```

**Error handling example:**

```javascript
try {
  const bytesWritten = await Stream.pipeline(
    source,
    decompressor,
    parser,
    destination,
    { signal: AbortSignal.timeout(30000) }
  );
  console.log(`Success: ${bytesWritten} bytes written`);
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Pipeline timed out or was cancelled');
  } else {
    console.log('Pipeline failed:', error.message);
    // Error could be from source, any transform, or destination
    // All stages have been cleaned up automatically
  }
}
```

**Cleanup with stateful transforms:**

If any transform in the pipeline has an `abort()` method, it will be called when the pipeline
errors (unless that transform was the source of the error):

```javascript
const statefulTransform = {
  #buffer: [],
  transform(chunk) {
    if (chunk === null) return this.#flush();
    this.#buffer.push(chunk);
    return null;
  },
  abort(reason) {
    // Called if pipeline errors (source, downstream, or signal)
    // Clean up resources, release buffers, etc.
    this.#buffer = [];
    console.log('Transform aborted:', reason);
  },
};

// If destination errors, statefulTransform.abort() is called
await Stream.pipeline(source, statefulTransform, destination);
```

### Writers and Custom Sinks

All write operations use the unified `Writer` type. Writers can be obtained from:

- `Stream.push()` — Returns `[Stream, Writer]` for push sources
- `Stream.transform()` — Returns `[Stream, Writer]` for transforms
- `Stream.writer(sink)` — Creates a Writer with custom sink callbacks

```javascript
// Create a writer with custom sink implementation
const writer = Stream.writer(
  {
    async write(chunk) {
      // chunk is always Uint8Array
      await file.write(chunk);
    },
    async close() {
      await file.close();
    },
    async abort(reason) {
      await file.close();
    },
  },
  {
    buffer: { max: 64 * 1024 },
  }
);

// Write directly
await writer.write(new Uint8Array([1, 2, 3]));
await writer.write('hello world'); // Auto-encoded to UTF-8
await writer.close();

// Or pipe a stream to it
await readable.pipeTo(writer);
```

**Unified Writer model:**

The same Writer type is used everywhere — no separate "Writable" container:

```javascript
// From Stream.push()
const [stream, writer] = Stream.push();

// From Stream.transform()
const [readable, writer] = Stream.transform(fn);

// From Stream.writer() with custom sink
const writer = Stream.writer({ write, close, abort });

// All have the same API
await writer.write(data);
await writer.writev([chunk1, chunk2]);
await writer.close();
```

This is simpler than Web Streams' model where you have `WritableStream` (container) and
`WritableStreamDefaultWriter` (active interface) — we just have `Writer`.

---

## 8. WebIDL Interface Definitions

The following WebIDL defines the proposed API surface exposed at global scope.

```webidl
// =============================================================================
// Stream - The primary readable byte stream
// =============================================================================

[Exposed=*]
interface Stream {
  // --- Static factory methods ---

  // Create from sync/async generator (pull source)
  [NewObject] static Stream pull(
    StreamPullSource source,
    optional StreamPullOptions options = {}
  );

  // Create push source - returns [Stream, Writer] pair
  [NewObject] static StreamWithWriter push(optional StreamPushOptions options = {});

  // Create from various byte sources
  [NewObject] static Stream from(
    StreamSource source,
    optional StreamFromOptions options = {}
  );

  // Create empty (already closed) stream
  [NewObject] static Stream empty();

  // Create empty/errored stream that never produces data
  [NewObject] static Stream never(optional any reason = undefined);

  // Combine multiple streams
  [NewObject] static Stream merge(Stream... streams);
  [NewObject] static Stream concat(Stream... streams);

  // Create transform - returns [Stream, Writer] pair
  [NewObject] static StreamWithWriter transform(
    StreamTransformer transformer,
    optional StreamTransformOptions options = {}
  );

  // Create writer with custom sink
  [NewObject] static Writer writer(
    WriterSink sink,
    optional WriterOptions options = {}
  );

  // Construct optimized pipeline: source → transforms → destination
  // More efficient than chaining pipeThrough().pipeTo() — implementation can fuse stages
  // Returns total bytes that flowed through the pipeline
  [NewObject] static Promise<unsigned long long> pipeline(
    Stream source,
    (StreamTransformer or Writer)... stages,  // Zero or more transforms, then a Writer
    optional StreamPipelineOptions options = {}
  );

  // --- Consumption methods (terminal operations) ---

  // Collect all bytes as Uint8Array
  [NewObject] Promise<Uint8Array> bytes(optional StreamConsumeOptions options = {});

  // Collect all bytes as ArrayBuffer
  [NewObject] Promise<ArrayBuffer> arrayBuffer(optional StreamConsumeOptions options = {});

  // Collect and decode as text
  [NewObject] Promise<USVString> text(
    optional DOMString encoding = "utf-8",
    optional StreamConsumeOptions options = {}
  );

  // --- Slicing operators ---

  // View of next n bytes; parent continues at byte n
  [NewObject] Stream take(unsigned long long byteCount);

  // Discard next n bytes; returns closed stream
  [NewObject] Stream drop(unsigned long long byteCount);

  // Cap stream at n bytes; cancels source after limit reached
  // Returns this stream (not a new object) - limit() is terminal, not branching
  Stream limit(unsigned long long byteCount);

  // --- Branching ---

  // Create a new branch; both this stream and the returned stream see the same bytes
  // Can be called multiple times to create multiple branches
  // If options.detached is true, the branch starts without a cursor and must be
  // attached before reading (or will auto-attach on first read)
  [NewObject] Stream tee(optional StreamTeeOptions options = {});

  // True if this stream was created with { detached: true } and has not yet been attached
  // False for normal streams and for detached streams after attach() or first read
  readonly attribute boolean detached;

  // Attach a detached branch to the parent stream at the current position
  // After attachment, the branch sees all future data but not past data
  // No-op if already attached (including auto-attached via read)
  // Throws if called on a stream that was not created with { detached: true }
  undefined attach();

  // --- Piping ---

  // Pipe through transform, return readable output
  [NewObject] Stream pipeThrough(
    StreamTransformer transformer,
    optional StreamPipeOptions options = {}
  );

  // Pipe to destination (consumes this stream); resolves with total bytes piped
  [NewObject] Promise<unsigned long long> pipeTo(
    Writer destination,
    optional StreamPipeToOptions options = {}
  );

  // --- Cancellation ---

  // Cancel the stream (signal disinterest); resolves with total bytes read before cancel
  // Note: Returned promise is marked as handled — rejections won't cause unhandled rejection
  [NewObject] Promise<unsigned long long> cancel(optional any reason);

  // --- Low-level read access ---

  // Read bytes from stream
  // - options.buffer: if provided, copies into your buffer (BYOB)
  // - options.max: max bytes to return (non-BYOB only; bounds allocation)
  // - options.atLeast: wait for at least N bytes before returning
  // - options.signal: abort signal for cancellation
  // Note: result can have both value AND done=true (final chunk with EOF)
  [NewObject] Promise<StreamReadResult> read(optional StreamReadOptions options = {});

  // Promise that resolves with total bytes read when stream closes, or rejects on error
  // Note: Promise is marked as handled — rejections won't cause unhandled rejection
  readonly attribute Promise<unsigned long long> closed;

  // --- Async iterable ---

  async iterable<Uint8Array>;

  // --- Explicit Resource Management ---

  // Enables: await using stream = response.body;
  // Calls cancel() when block exits (ensures resources are released)
  // Idempotent: no-op if already closed/cancelled
  [NewObject] Promise<undefined> asyncDispose();
};

// Return type for Stream.push() and Stream.transform()
[Exposed=*]
interface StreamWithWriter {
  readonly attribute Stream stream;
  readonly attribute Writer writer;

  // Enable destructuring: const [stream, writer] = Stream.push();
  iterable<(Stream or Writer)>;
};

// =============================================================================
// Writer - Unified writer for push streams and custom sinks
// =============================================================================

[Exposed=*]
interface Writer {
  // Write bytes (strings auto-encoded to UTF-8)
  // IMPORTANT: ArrayBuffer/TypedArray/DataView arguments are DETACHED after this call
  // If signal aborts, this write AND all subsequent queued writes/flushes are cancelled
  [NewObject] Promise<undefined> write(
    StreamWriteData data,
    optional WriterWriteOptions options = {}
  );

  // Vectored write - multiple chunks atomically
  // IMPORTANT: All ArrayBuffer/TypedArray/DataView arguments are DETACHED after this call
  // If signal aborts, this write AND all subsequent queued writes/flushes are cancelled
  [NewObject] Promise<undefined> writev(
    sequence<StreamWriteData> chunks,
    optional WriterWriteOptions options = {}
  );

  // Flush — synchronization point; resolves when all prior writes complete
  // Semantically a zero-length write: queues behind pending writes, no allocation needed
  // If signal aborts, this flush AND all subsequent queued writes/flushes are cancelled
  [NewObject] Promise<undefined> flush(optional WriterWriteOptions options = {});

  // Signal end of stream; resolves with total bytes written
  [NewObject] Promise<unsigned long long> close();

  // Signal error, cancel stream; resolves with total bytes written before abort
  // Note: Returned promise is marked as handled — rejections won't cause unhandled rejection
  [NewObject] Promise<unsigned long long> abort(optional any reason);

  // Promise that resolves with total bytes written when writer is closed
  // Note: Promise is marked as handled — rejections won't cause unhandled rejection
  readonly attribute Promise<unsigned long long> closed;

  // Bytes available before buffer limit (null if closed, negative if over)
  readonly attribute long? desiredSize;

  // --- Explicit Resource Management ---

  // Enables: await using writer = Stream.push()[1];
  // Calls close() when block exits normally
  // Idempotent: no-op if already closed/aborted
  [NewObject] Promise<undefined> asyncDispose();
};

dictionary WriterWriteOptions {
  // Abort signal — if triggered, cancels this operation AND all subsequent queued operations
  AbortSignal signal;
};

dictionary StreamReadResult {
  // The bytes read; null only when done=true AND no final bytes available
  Uint8Array? value;

  // True when stream has ended
  // IMPORTANT: Unlike Web Streams, value CAN be non-null when done=true
  // This allows returning the final chunk and EOF in a single read
  boolean done;
};

dictionary StreamReadOptions {
  // BYOB: provide your own buffer; data written into it, result.value is a view into this buffer
  // IMPORTANT: The buffer is DETACHED after this call — caller must not reuse it
  // When provided, `max` is ignored (buffer size is the implicit max)
  AllowSharedBufferSource buffer;

  // Maximum bytes to return (only applies when buffer is not provided)
  // Bounds the allocation size for the returned Uint8Array
  // Ignored when buffer is provided (buffer.byteLength is the implicit max)
  [EnforceRange] unsigned long long max;

  // Wait for at least this many bytes before returning
  // If stream ends before atLeast bytes available, returns what's available with done=true
  // Throws RangeError if atLeast > max, or atLeast > buffer.byteLength (when BYOB)
  [EnforceRange] unsigned long long atLeast;

  // Abort signal — rejects with AbortError if signaled
  AbortSignal signal;
};

// =============================================================================
// StreamTransformer - Protocol for transforms
// =============================================================================

// Simple transform: stateless function, no error handling needed
// chunk is null when input ends (flush signal)
// See "StreamTransformer protocol" below for acceptable return values
callback StreamTransformCallback = any (Uint8Array? chunk);

// Stateful transform: object with transform() and optional abort() for cleanup
// Use this when you need to handle errors (e.g., cleanup resources, rollback)
callback interface StreamTransformerObject {
  // Process chunk; chunk is null when input ends normally (flush signal)
  any transform(Uint8Array? chunk);

  // Optional: Called when pipeline errors (input error or downstream error)
  // Use for cleanup (close connections, rollback transactions, release resources)
  // Return value ignored — cannot emit bytes after an error
  // NOT called if transform() itself threw (you already know about your own error)
  undefined abort(optional any reason);
};

// =============================================================================
// Callback interfaces and types
// =============================================================================

// Pull source: sync or async generator function that yields byte data
// Returns Generator or AsyncGenerator that yields StreamPullYieldType
// When a Stream or generator is yielded, it is fully consumed before the next pull
callback StreamPullSource = object ();

// Types that can be yielded from a pull source generator
// When Stream, Generator, or AsyncGenerator is yielded, it is consumed inline
// (all its values are emitted before pulling the next value from the source)
typedef (
  BufferSource or          // Bytes — emitted directly
  USVString or             // String — encoded to bytes
  Stream or                // Stream — consumed fully before continuing
  object                   // Generator or AsyncGenerator — consumed fully before continuing
) StreamPullYieldType;

// Transformer: function or object with transform() method — same signature either way
typedef (StreamTransformCallback or StreamTransformerObject) StreamTransformer;

// Data that can be written (auto-converted to Uint8Array)
// IMPORTANT: BufferSource (ArrayBuffer/TypedArray/DataView) is DETACHED after use
typedef (BufferSource or USVString) StreamWriteData;

// Sources for Stream.from()
typedef (
  BufferSource or
  USVString or
  sequence<StreamWriteData> or
  Stream
) StreamSource;


// =============================================================================
// Sink interface for Stream.writer()
// =============================================================================

dictionary WriterSink {
  WriteCallback write;
  CloseCallback close;
  AbortCallback abort;
};

callback WriteCallback = Promise<undefined> (Uint8Array chunk);
callback CloseCallback = Promise<undefined> ();
callback AbortCallback = Promise<undefined> (optional any reason);


// =============================================================================
// Options dictionaries
// =============================================================================

dictionary StreamBufferOptions {
  // Soft limit: backpressure threshold (implementation-defined default)
  [EnforceRange] unsigned long long max;

  // Hard limit: for 'block' policy, error at this point
  [EnforceRange] unsigned long long hardMax;

  // Policy when buffer exceeds max
  StreamOverflowPolicy onOverflow = "error";
};

enum StreamOverflowPolicy {
  "error",        // Reject writes, error the stream
  "block",        // Block writes until space available
  "drop-oldest",  // Discard oldest buffered bytes
  "drop-newest"   // Discard the data being written
};

dictionary StreamPullOptions {
  // Default encoding for strings yielded by the generator (default: "utf-8")
  DOMString encoding = "utf-8";
};

dictionary StreamPushOptions {
  // Default encoding for strings written to the Writer (default: "utf-8")
  DOMString encoding = "utf-8";

  StreamBufferOptions buffer;
};

dictionary StreamFromOptions {
  // Encoding for string sources (default: "utf-8")
  DOMString encoding = "utf-8";
};

dictionary StreamTransformOptions {
  // Default encoding for strings written to the Writer (default: "utf-8")
  DOMString encoding = "utf-8";

  // Fixed chunk size for transform input (except final chunk)
  [EnforceRange] unsigned long chunkSize;

  // Buffer configuration for transform output
  StreamBufferOptions buffer;
};

dictionary StreamPipeOptions {
  AbortSignal signal;
  [EnforceRange] unsigned long chunkSize;
  StreamBufferOptions buffer;

  // Maximum bytes to pipe through; parent stream continues after limit
  // pipeThrough creates a branch — original stream remains usable
  [EnforceRange] unsigned long long limit;
};

dictionary StreamPipeToOptions {
  AbortSignal signal;

  // Maximum bytes to pipe; cancels source after limit reached
  // More efficient than stream.limit(n).pipeTo(dest) — no intermediate stream
  [EnforceRange] unsigned long long limit;

  // If true, destination is NOT closed when source ends normally
  // Use when piping multiple sources to the same destination sequentially
  boolean preventClose = false;

  // If true, destination is NOT aborted when source errors
  // Use when you want to handle source errors without affecting the destination
  boolean preventAbort = false;

  // If true, source is NOT cancelled when destination errors
  // Use when you want to handle destination errors without affecting the source
  boolean preventCancel = false;
};

dictionary StreamConsumeOptions {
  AbortSignal signal;
};

dictionary StreamPipelineOptions {
  // Cancel the entire pipeline if signaled
  AbortSignal signal;

  // Maximum bytes to flow through the pipeline
  [EnforceRange] unsigned long long limit;

  // If true, destination is NOT closed when pipeline completes normally
  // Use when running multiple pipelines to the same destination sequentially
  boolean preventClose = false;
};

dictionary StreamTeeOptions {
  StreamBufferOptions buffer;

  // If true, the branch starts detached — no cursor is created until the first read
  // or explicit attach() call. Detached branches don't contribute to backpressure
  // but miss any data that flows before attachment.
  boolean detached = false;
};

dictionary WriterOptions {
  // Default encoding for strings written to the Writer (default: "utf-8")
  DOMString encoding = "utf-8";

  StreamBufferOptions buffer;
};
```

### WebIDL Notes

**Buffer detachment (zero-copy transfers):**

When a `BufferSource` (ArrayBuffer, TypedArray, DataView) is passed to any stream operation,
it is **detached** — its underlying `ArrayBuffer` becomes zero-length and unusable. This applies to:

- `writer.write(buffer)` — buffer is detached
- `writer.writev([buf1, buf2])` — all buffers are detached
- `stream.read({ buffer })` — buffer is detached, result.value is the new view
- `Stream.from(buffer)` — buffer is detached
- Generator `yield buffer` — buffer is detached after consumption

This design:

- Enables zero-copy optimizations (no defensive copying needed)
- Prevents use-after-transfer bugs
- Is consistent with `postMessage()` transferables

```javascript
const data = new Uint8Array([1, 2, 3]);
await writer.write(data);
console.log(data.byteLength); // 0 (detached!)

// For BYOB reads, the returned value becomes your new buffer
let buffer = new Uint8Array(64 * 1024);
const { value } = await stream.read({ buffer });
// buffer is detached, value is the new view
buffer = value; // Use value for next read
```

Strings are not affected (they're copied during UTF-8 encoding).

**Destructuring support:**

The `StreamWithWriter` interface includes `iterable<>` to enable destructuring assignment:

```javascript
const [stream, writer] = Stream.push();
const [readable, writer] = Stream.transform(fn);
```

Both `Stream.push()` and `Stream.transform()` return the same `StreamWithWriter` type, providing
a consistent pattern for creating streams with write capability.

**Pull source generators:**

`StreamPullSource` returns `object` in WebIDL because WebIDL doesn't have a native representation
for JavaScript generators. The runtime accepts either a **sync generator** or an **async generator**
that yields byte data (`BufferSource` or `USVString`). Yielding other types throws a `TypeError`.

```javascript
// Sync generator — efficient for in-memory data, no promise overhead
const stream = Stream.pull(function* () {
  yield 'line 1\n'; // string → UTF-8 bytes
  yield new Uint8Array([1, 2, 3]); // bytes
  yield 'line 2\n';
});

// Async generator — for I/O-bound sources with backpressure
const stream = Stream.pull(async function* () {
  for await (const row of database.query('SELECT * FROM logs')) {
    yield JSON.stringify(row) + '\n'; // string → UTF-8 bytes
  }
});

// Sync generator chunking in-memory data
const stream = Stream.pull(function* () {
  const data = new Uint8Array(largeBuffer);
  for (let i = 0; i < data.length; i += 65536) {
    yield data.subarray(i, Math.min(i + 65536, data.length));
  }
});

// Invalid — would throw TypeError (not byte data)
const bad = Stream.pull(function* () {
  yield { foo: 'bar' }; // TypeError: not a valid byte source
  yield 42; // TypeError: not a valid byte source
});
```

**Sync vs async generator behavior:**

| Generator type | Backpressure              | Use case                           |
| -------------- | ------------------------- | ---------------------------------- |
| Sync           | Yields processed in batch | In-memory data, computed values    |
| Async          | Awaits between yields     | I/O-bound, database queries, fetch |

Sync generators are more efficient when data is already available — no promise allocation
per yield. The runtime processes all synchronous yields in a batch before the next microtask.

**Yielding streams and generators (inline consumption):**

Pull source generators can yield not just bytes and strings, but also `Stream` objects, sync
generators, or async generators. When one of these is yielded, it is **consumed fully** before
the source generator is pulled again:

```javascript
// Yielding a Stream — consumed inline before continuing
const aggregated = Stream.pull(async function* () {
  yield '{"users":';
  yield usersStream; // Stream is fully consumed here
  yield ',"products":';
  yield productsStream; // Then this Stream is consumed
  yield '}';
});

// Yielding another generator — also consumed inline
const composed = Stream.pull(async function* () {
  yield '<html><body>';
  yield renderHeader(); // Returns async generator — consumed inline
  yield renderContent(); // Returns async generator — consumed inline
  yield '</body></html>';
});

function* renderHeader() {
  yield '<header>';
  yield headerContent;
  yield '</header>';
}
```

This is cleaner than using `yield*` because:

1. Works with `Stream` objects directly (not just iterables)
2. The runtime can optimize the consumption
3. More intuitive — just `yield` the stream, it "expands" in place

**Nested consumption:**

```javascript
// Nested streams/generators work recursively
const deeply = Stream.pull(async function* () {
  yield outerStream; // If outerStream yields innerStream, that's consumed too
});
```

| Yielded type     | Behavior                                      |
| ---------------- | --------------------------------------------- |
| `BufferSource`   | Emitted as bytes                              |
| `USVString`      | Encoded and emitted                           |
| `Stream`         | Fully consumed, then source generator resumes |
| `Generator`      | Fully consumed (sync), then source resumes    |
| `AsyncGenerator` | Fully consumed (async), then source resumes   |
| Other object     | `TypeError`                                   |

**Transform functions:**

Transform functions follow the unified signature: `(chunk: Uint8Array | null) => any`.
The `chunk` is `null` when input ends (flush signal). Return `null` or `undefined` to
emit nothing.

```javascript
// Simple 1:1 transform — return transformed bytes
const upper = source.pipeThrough((chunk) => {
  if (chunk === null) return null; // No flush output needed
  return chunk.map((b) => (b >= 97 && b <= 122 ? b - 32 : b));
});

// Filter — return null to skip chunks
const filtered = source.pipeThrough((chunk) => {
  if (chunk === null) return null;
  return shouldKeep(chunk) ? chunk : null;
});

// Stateful function using closure
function createCounter() {
  let count = 0;
  return (chunk) => {
    if (chunk === null) {
      return `Total: ${count} bytes`; // Flush: emit summary
    }
    count += chunk.byteLength;
    return chunk; // Pass through
  };
}
source.pipeThrough(createCounter());
```

For transforms with state organized as object properties, use an object with a
`transform()` method (see "StreamTransformer protocol" below).

**Async iterable:**

The `async iterable<Uint8Array>` declaration makes `Stream` usable with `for await...of`:

```javascript
for await (const chunk of stream) {
  // chunk is Uint8Array
}
```

**Type coercion and string encoding:**

`StreamWriteData` accepts both `BufferSource` (ArrayBuffer, TypedArray, DataView) and `USVString`.
Strings are encoded to bytes using the encoding specified at creation time (default: UTF-8).

```javascript
// Default: UTF-8 encoding
const [stream, writer] = Stream.push();
await writer.write('hello'); // Encoded as UTF-8

// Custom encoding
const [stream, writer] = Stream.push({ encoding: 'utf-16le' });
await writer.write('hello'); // Encoded as UTF-16LE

// Pull source with custom encoding
const stream = Stream.pull(
  function* () {
    yield 'données'; // Encoded as ISO-8859-1
  },
  { encoding: 'iso-8859-1' }
);

// Transform with custom encoding
const [readable, writer] = Stream.transform(fn, { encoding: 'utf-16be' });

// Writer with custom encoding
const writer = Stream.writer(sink, { encoding: 'windows-1252' });

// Stream.from() with custom encoding
const stream = Stream.from('hello', { encoding: 'utf-16le' });
```

The encoding affects all string-to-bytes conversions for that Stream/Writer. BufferSource
values are passed through unchanged (already bytes).

**Byte counts returned from operations:**

Unlike Web Streams where operations resolve to `undefined`, this API returns byte counts
from completion operations. This is useful for progress tracking, logging, and debugging.

```javascript
// Stream.closed — total bytes read
const stream = response.body;
for await (const chunk of stream) {
  process(chunk);
}
const totalBytesRead = await stream.closed;
console.log(`Read ${totalBytesRead} bytes`);

// Stream.cancel() — bytes read before cancellation
const bytesBeforeCancel = await stream.cancel('no longer needed');

// Writer.close() — total bytes written
const [stream, writer] = Stream.push();
await writer.write('hello');
await writer.write(new Uint8Array([1, 2, 3]));
const totalWritten = await writer.close();
console.log(`Wrote ${totalWritten} bytes`); // 8 (5 UTF-8 + 3)

// Writer.abort() — bytes written before abort
const bytesBeforeAbort = await writer.abort('error occurred');

// Writer.closed — same value as close()/abort() returned
const bytesWritten = await writer.closed;

// pipeTo() — total bytes piped
const bytesPiped = await source.pipeTo(destination);
console.log(`Piped ${bytesPiped} bytes`);

// Useful for progress tracking, logging, debugging
async function downloadWithStats(url) {
  const response = await fetch(url);
  const data = await response.body.bytes();
  const bytesRead = await response.body.closed;
  console.log(`Downloaded ${bytesRead} bytes`);
  return data;
}
```

If the stream errors, `closed` rejects with that error (byte count not available).

**Handled rejections (no unhandled rejection errors):**

The following promises are "marked as handled" — if they reject, it will NOT trigger
unhandled rejection warnings or errors:

- `stream.closed`
- `stream.cancel()`
- `writer.closed`
- `writer.abort()`

This is important because these promises often reject in normal usage patterns where the
rejection is expected or unimportant:

```javascript
// Fire-and-forget cancellation — rejection is expected if stream already errored
stream.cancel(); // No await, no .catch() — still no unhandled rejection warning

// closed may reject if stream errors, but caller may not care
const stream = response.body;
processStream(stream); // Async processing
// stream.closed may reject, but we're not awaiting it — no warning

// abort() may reject if writer already closed/errored
writer.abort('cleanup'); // No await needed, no warning
```

The caller can still `.catch()` or `await` these promises to handle errors if desired,
but ignoring the rejection is safe and won't pollute error logs.

**Bidirectional error propagation in pipelines:**

Errors propagate **both directions** through a pipeline to ensure proper cleanup:

- **Forward:** If source or a transform errors, all downstream stages error
- **Backward:** If destination or a transform errors, all upstream stages are cancelled/errored

This ensures no stage is left dangling when any part of the pipeline fails. The `pipeTo()`
promise rejects with the error regardless of where it originated. Writers connected to the
pipeline see the error via their `closed` promise.

See "Pipeline error propagation" in the Piping section for details and examples.

**Consolidated global namespace:**

The API exposes only the `Stream` class at global scope. Related types are accessed via static
methods:

| Operation                      | Method                        | Returns            |
| ------------------------------ | ----------------------------- | ------------------ |
| Create readable (pull)         | `Stream.pull(generator)`      | `Stream`           |
| Create readable (push)         | `Stream.push(options)`        | `[Stream, Writer]` |
| Create readable from data      | `Stream.from(source)`         | `Stream`           |
| Create writer with custom sink | `Stream.writer(sink)`         | `Writer`           |
| Create transform               | `Stream.transform(fn)`        | `[Stream, Writer]` |
| Combine streams                | `Stream.merge()` / `concat()` | `Stream`           |

The `Writer` interface exists but is not directly constructible — it is returned by `Stream`
methods. There is no separate `Writable` or `Reader` type; `Writer` serves as the write
interface and pipe destination, while `Stream` itself provides read methods directly.

**StreamTransformer protocol:**

A `StreamTransformer` is either:

1. **A function** — `(chunk: Uint8Array | null) => any`
2. **An object with a `transform()` method** — `{ transform(chunk: Uint8Array | null): any }`

Both follow the **same signature and semantics**. The only difference is how you organize
state (closure vs object properties). This is duck typing — no base class required.

```javascript
// Function with closure state
function createParser() {
  let buffer = '';
  return function transform(chunk) {
    if (chunk === null) return buffer; // Flush
    buffer += decode(chunk);
    return null;
  };
}

// Function (stateless)
const upperCase = (chunk) => {
  if (chunk === null) return null; // No flush output
  return chunk.map((b) => (b >= 97 && b <= 122 ? b - 32 : b));
};

// Object with closure state (factory)
function createLineParser() {
  let buffer = '';
  return {
    *transform(chunk) {
      /* uses buffer via closure */
    },
  };
}

// Object with properties
const parser = {
  buffer: '',
  *transform(chunk) {
    /* uses this.buffer */
  },
};

// Class
class Parser {
  #buffer = '';
  *transform(chunk) {
    /* ... */
  }
}

// All work the same way:
source.pipeThrough(createParser());
source.pipeThrough(upperCase);
source.pipeThrough(createLineParser());
source.pipeThrough(parser);
source.pipeThrough(new Parser());
```

**The `chunk` parameter:**

Both functions and `transform()` methods receive:

- `Uint8Array` — A chunk of input data to process
- `null` — Signal that input has ended; emit any remaining buffered data (flush)

```javascript
// Function form
const myTransform = (chunk) => {
  if (chunk === null) {
    // Input ended — emit any buffered/accumulated data
    return emitRemaining();
  }
  // Normal chunk processing
  return process(chunk);
};

// Object form (equivalent)
const myTransform = {
  transform(chunk) {
    if (chunk === null) {
      return this.#emitRemaining();
    }
    return this.#process(chunk);
  },
};
```

**Return types:**

The return value determines what gets emitted to the output stream:

| Return type                       | Behavior                                     | Use case                      |
| --------------------------------- | -------------------------------------------- | ----------------------------- |
| `Uint8Array` / `BufferSource`     | Emit single chunk                            | 1:1 transforms                |
| `string`                          | Emit single chunk (UTF-8 encoded)            | Text output                   |
| `null` / `undefined`              | Emit nothing                                 | Filtering, accumulating       |
| `Iterable<StreamWriteData>`       | Emit each element as a chunk                 | 1:N transforms (sync)         |
| `AsyncIterable<StreamWriteData>`  | Emit each element as a chunk (awaiting each) | 1:N transforms (async)        |
| `Promise<T>` where T is any above | Await, then process result per above rules   | Async single-chunk transforms |

**Method signatures (sync vs async vs generator):**

The `transform()` method can be implemented as a regular function, async function, sync
generator, or async generator. The runtime handles all variants:

```javascript
// Option 1: Sync function returning bytes (1:1 transform)
const transform1 = {
  transform(chunk) {
    if (chunk === null) return null; // No flush output
    return processSync(chunk); // Returns Uint8Array or string
  },
};

// Option 2: Sync function with accumulation
function createAccumulator() {
  const buffer = [];
  return {
    transform(chunk) {
      if (chunk === null) {
        return concatenate(buffer); // Flush: emit accumulated
      }
      buffer.push(chunk);
      return null; // Accumulate, emit nothing yet
    },
  };
}

// Option 3: Async function (async 1:1 transform)
const transform3 = {
  async transform(chunk) {
    if (chunk === null) return null;
    return await processAsync(chunk); // Returns Promise<Uint8Array>
  },
};

// Option 4: Sync generator (1:N transform)
function createSplitter() {
  let remaining = null;
  return {
    *transform(chunk) {
      if (chunk === null) {
        if (remaining) yield remaining; // Flush
        return;
      }
      for (const part of splitChunk(chunk)) {
        yield part; // Emit multiple chunks synchronously
      }
    },
  };
}

// Option 5: Async generator (async 1:N transform)
const transform5 = {
  async *transform(chunk) {
    if (chunk === null) return; // No flush output
    for await (const part of processAsyncParts(chunk)) {
      yield part; // Emit multiple chunks with async processing
    }
  },
};

// Option 6: Return an iterable (alternative to generator)
const transform6 = {
  transform(chunk) {
    if (chunk === null) return null;
    return splitChunk(chunk); // Returns Iterable<Uint8Array>
  },
};
```

**Processing order and backpressure:**

- **Sync returns** (`Uint8Array`, `null`, `Iterable`): Processed immediately, no microtask boundary
- **Async returns** (`Promise`, `AsyncIterable`): Each await is a potential suspension point
- **Generators**: Sync yields processed in batch; async yields await between each

For performance-critical transforms, prefer sync returns when possible. Async generators
(`async *transform()`) provide the most flexibility but have the highest overhead.

**Type coercion:**

All emitted values go through the same coercion as `writer.write()`:

- `Uint8Array` → used directly
- `ArrayBuffer` / `TypedArray` / `DataView` → wrapped/copied to `Uint8Array`
- `string` → UTF-8 encoded to `Uint8Array`
- Other types → `TypeError`

**Error handling with `abort()` (stateful transforms only):**

Stateful transforms (objects with `transform()` method) can optionally implement `abort(reason)`
to handle pipeline errors. This is called when:

- The input stream errors
- A downstream consumer errors
- The pipeline is aborted via `AbortSignal`

```javascript
// Stateful transform with error handling
function createTransactionalTransform(connection) {
  return {
    transform(chunk) {
      if (chunk === null) {
        // Normal end — commit transaction
        connection.commit();
        return null;
      }
      connection.write(chunk);
      return chunk;
    },

    abort(reason) {
      // Pipeline errored — rollback and cleanup
      connection.rollback();
      connection.close();
      console.log('Transform aborted:', reason);
      // Return value ignored — cannot emit bytes after error
    },
  };
}

// Usage
source.pipeThrough(createTransactionalTransform(conn)).pipeTo(dest);
// If any part of pipeline errors, abort() is called for cleanup
```

**`abort()` semantics:**

| Aspect              | Behavior                                              |
| ------------------- | ----------------------------------------------------- |
| When called         | Pipeline error (input, downstream, or AbortSignal)    |
| Parameter           | The error/reason that caused the abort                |
| Return value        | Ignored — cannot emit bytes after an error            |
| Optional            | Yes — omit if no cleanup needed                       |
| Called on own error | No — if `transform()` throws, `abort()` is not called |

**Simple function transforms don't need `abort()`:**

If you're using a simple function (not an object), you're assumed to be stateless:

```javascript
// Stateless — no abort() needed, just use a function
source.pipeThrough((chunk) => chunk?.map((b) => b ^ 0xff));

// Stateful with cleanup — use an object with abort()
source.pipeThrough({
  #resource: acquireResource(),
  transform(chunk) { /* ... */ },
  abort(reason) { this.#resource.release(); },
});
```

---

## 9. Implementation Optimization Opportunities

This section analyzes the proposed API from an implementer's perspective, identifying optimization
opportunities that this design enables compared to Web Streams. While the previous section
("Implementation Challenges and Workarounds") documented the difficulties with Web Streams, this
section shows how the new design is specifically crafted to be implementer-friendly.

### Structural Simplifications

The most impactful optimizations come from structural simplifications that eliminate entire
categories of complexity.

#### Bytes-Only Streams Eliminate the Value/Byte Dichotomy

Web Streams maintains two parallel implementations:

| Aspect           | Web Streams Value Mode            | Web Streams Byte Mode          |
| ---------------- | --------------------------------- | ------------------------------ |
| Controller       | `ReadableStreamDefaultController` | `ReadableByteStreamController` |
| Reader types     | Default only                      | Default + BYOB                 |
| Queue contents   | Any JS value                      | `ArrayBufferView` only         |
| BYOB support     | No                                | Yes                            |
| Size calculation | Via `size()` strategy function    | Via `byteLength`               |

The new API has **one mode**: bytes. Chunks are always `Uint8Array`.

**Optimization impact:**

```cpp
// Web Streams: runtime type checks everywhere
void enqueue(v8::Local<v8::Value> chunk) {
  if (isDefaultController()) {
    // Value stream path
    queue.push(chunk);
    queueSize += strategySizeFunction(chunk);  // JS callback!
  } else {
    // Byte stream path
    if (!chunk->IsArrayBufferView()) throw TypeError;
    auto view = chunk.As<v8::ArrayBufferView>();
    queue.push(view);
    queueSize += view->ByteLength();
  }
}

// New API: single optimized path
void enqueue(jsg::BufferSource chunk) {
  // Always bytes, always Uint8Array-compatible
  queue.push(chunk.asArrayPtr());
  queueSize += chunk.size();  // No JS callback, no type check
}
```

The single code path means:

- No runtime branching on stream type
- No virtual dispatch between controller implementations
- Predictable memory layout (queue always contains byte arrays)
- Simpler JIT optimization (monomorphic call sites)

#### No Reader/Writer Acquisition Ceremony

Web Streams requires acquiring a reader before reading:

```javascript
// Web Streams
const reader = stream.getReader(); // Creates ReadableStreamDefaultReader
const { value, done } = await reader.read();
reader.releaseLock();

// New API
const { value, done } = await stream.read();
```

**Optimization impact:**

Web Streams `getReader()` must:

1. Check stream state (readable/closed/errored)
2. Check if already locked
3. Allocate `ReadableStreamDefaultReader` object
4. Set `[[reader]]` internal slot on stream
5. Set `[[stream]]` internal slot on reader
6. Create `[[closedPromise]]` on reader
7. Initialize `[[readRequests]]` list

The new API's `read()` method:

1. Check stream state
2. If buffer has data, return it
3. Otherwise, queue a pending read

```cpp
// Web Streams: multiple object allocations
v8::Local<v8::Object> getReader() {
  auto reader = ReadableStreamDefaultReader::create();
  reader->setStream(this);
  this->setReader(reader);
  reader->setClosedPromise(v8::Promise::Resolver::New());
  reader->setReadRequests(v8::Array::New());
  return reader;
}

// New API: no intermediate object
Promise<ReadResult> read(ReadOptions options) {
  if (auto data = buffer.tryDequeue()) {
    return resolvedPromise(ReadResult{data, false});
  }
  return pendingReadPromise();
}
```

#### Unified Buffer/Cursor Model

Web Streams creates separate queues for each stream in a pipeline:

```
source.queue → transform1.queue → transform2.queue → sink
     ↓              ↓                  ↓
  [chunks]       [chunks]           [chunks]
```

The new API uses **one buffer per root stream** with cursors:

```
Root Buffer: [██████████████████████████████████████]
              ↑         ↑              ↑          ↑
           cursor A  cursor B      cursor C   write pos
           (tee)     (take)        (main)
```

**Optimization impact:**

```cpp
// Web Streams: N queues for N-way tee
struct TeedStreams {
  std::array<ChunkQueue, N> queues;  // Each holds copies of data

  void enqueue(Chunk chunk) {
    for (auto& q : queues) {
      q.push(chunk.clone());  // Copy for each branch!
    }
  }
};

// New API: one buffer, N cursors (8-16 bytes each)
struct UnifiedBuffer {
  RingBuffer<byte> data;
  std::vector<Cursor> cursors;  // Cursor = { uint64_t pos; uint32_t flags; }

  void write(ArrayPtr<byte> chunk) {
    data.append(chunk);  // One copy into buffer
    // Cursors just read from the same buffer
  }

  ArrayPtr<byte> read(Cursor& c, size_t maxBytes) {
    auto available = data.slice(c.pos, std::min(c.pos + maxBytes, writePos));
    c.pos += available.size();
    maybeReclaimBuffer();
    return available;  // Zero-copy view into buffer
  }

  void maybeReclaimBuffer() {
    uint64_t minPos = UINT64_MAX;
    for (auto& c : cursors) {
      if (c.isActive()) minPos = std::min(minPos, c.pos);
    }
    data.discardBefore(minPos);  // Free memory behind all cursors
  }
};
```

Benefits:

- `tee()` is O(1) — just add a cursor, no data copying
- `take(n)` is O(1) — just add a cursor with a limit
- Memory scales with data size, not branch count
- Single point for buffer limit enforcement

### Zero-Copy Opportunities

#### Buffer Detachment Semantics

The API specifies that `BufferSource` arguments are **detached** after use:

```javascript
const data = new Uint8Array([1, 2, 3, 4]);
await writer.write(data);
console.log(data.byteLength); // 0 — detached!
```

**Why this matters for zero-copy:**

Without detachment, the implementation must defensively copy:

```cpp
// Without detachment: must copy (caller might mutate)
void write(v8::Local<v8::Uint8Array> data) {
  auto copy = copyBuffer(data);  // Defensive copy
  queue.push(std::move(copy));
}

// With detachment: can take ownership
void write(v8::Local<v8::Uint8Array> data) {
  auto backing = data->Buffer()->GetBackingStore();
  data->Buffer()->Detach();  // Caller can't use it anymore
  queue.push(std::move(backing));  // Zero-copy ownership transfer
}
```

**Integration with system I/O:**

For internal streams (fetch bodies, file I/O), detachment enables true zero-copy paths:

```cpp
// Fetch response body → file write
// With detachment, can potentially:
// 1. Have network layer write directly into V8 ArrayBuffer
// 2. Transfer that ArrayBuffer to file write
// 3. Use splice() or sendfile() on Linux for kernel-level zero-copy
```

#### BYOB Reads Avoid Allocation

```javascript
const buffer = new Uint8Array(64 * 1024);
const { value, done } = await stream.read({ buffer });
// value is a view into buffer (now detached)
```

**Optimization:** No allocation per read. The caller provides the buffer, implementation fills it.

```cpp
Promise<ReadResult> read(jsg::Optional<ReadOptions> options) {
  KJ_IF_SOME(opts, options) {
    KJ_IF_SOME(buf, opts.buffer) {
      // BYOB path: write directly into caller's buffer
      size_t bytesRead = fillBuffer(buf.asArrayPtr());
      return ReadResult{ buf.slice(0, bytesRead), isEof() };
    }
  }
  // Non-BYOB path: allocate new buffer
  auto buf = kj::heapArray<byte>(defaultChunkSize);
  size_t bytesRead = fillBuffer(buf);
  return ReadResult{ toUint8Array(buf.slice(0, bytesRead)), isEof() };
}
```

#### Vectored Writes Enable Scatter-Gather I/O

```javascript
await writer.writev([header, body, trailer]);
```

**Optimization:** Maps directly to `writev()` syscall:

```cpp
Promise<void> writev(std::vector<jsg::BufferSource> chunks) {
  // Build iovec array for syscall
  std::vector<struct iovec> iov;
  for (auto& chunk : chunks) {
    iov.push_back({
      .iov_base = chunk.asArrayPtr().begin(),
      .iov_len = chunk.size()
    });
  }

  // Single syscall writes all chunks
  return asyncWritev(fd, iov);
}
```

Benefits over multiple `write()` calls:

- Single syscall instead of N syscalls
- Single promise instead of N promises
- Potential for single DMA operation
- Atomic from the stream consumer's perspective

### Batching Opportunities

A major performance problem with Web Streams is promise/microtask overhead. Each chunk flowing
through a pipeline triggers multiple promise resolutions:

```
chunk flows: read() → Promise → microtask → write() → Promise → microtask → ...
```

The new API provides several mechanisms to reduce this overhead.

#### `writev()` Batches Multiple Writes

```javascript
// Web Streams pattern: 4 promises, 4 microtasks, 4 potential syscalls
await writer.write(chunk1);
await writer.write(chunk2);
await writer.write(chunk3);
await writer.write(chunk4);

// New API: 1 promise, 1 microtask, 1 syscall
await writer.writev([chunk1, chunk2, chunk3, chunk4]);
```

**Implementation can aggregate even non-writev writes:**

```cpp
class Writer {
  std::vector<PendingWrite> pendingWrites;
  bool flushScheduled = false;

  Promise<void> write(jsg::BufferSource data) {
    pendingWrites.push_back({std::move(data), kj::newPromiseAndFulfiller()});

    if (!flushScheduled) {
      flushScheduled = true;
      // Schedule microtask to flush all pending writes together
      scheduleMicrotask([this]() {
        flushScheduled = false;
        flushPendingWrites();  // Batch all accumulated writes
      });
    }

    return pendingWrites.back().promise;
  }
};
```

#### `atLeast` Batches Small Reads

```javascript
// Without atLeast: many small reads
while (!done) {
  const { value, done } = await stream.read(); // Might return 1 byte
  process(value);
}

// With atLeast: fewer, larger reads
while (!done) {
  const { value, done } = await stream.read({ atLeast: 16384 });
  process(value); // Guaranteed at least 16KB (unless EOF)
}
```

**Implementation:**

```cpp
Promise<ReadResult> read(ReadOptions options) {
  size_t atLeast = options.atLeast.orDefault(1);
  size_t available = buffer.availableBytes();

  if (available >= atLeast || isEof()) {
    // Fast path: enough data available
    return resolvedPromise(dequeueUpTo(options.max, available));
  }

  // Slow path: wait for more data
  return pendingRead(atLeast, options.max);
}
```

In workerd, this is particularly valuable for chunked HTTP responses where the network layer
might deliver many small chunks.

#### Sync Generators Processed Without Async Overhead

```javascript
const stream = Stream.pull(function* () {
  for (const item of largeInMemoryArray) {
    yield serialize(item);
  }
});
```

**Optimization:** Detect sync generator, drain synchronously:

```cpp
void pullFromGenerator() {
  if (generator.isSync()) {
    // Drain all available values in one go
    while (!generator.done()) {
      auto value = generator.next();
      if (!value.done) {
        buffer.enqueue(toBytes(value.value));
      }
      // No microtask boundary — stay synchronous
    }
  } else {
    // Async generator: must await between yields
    pullAsyncGenerator();
  }
}
```

Benefits:

- No promise allocation per yield
- No microtask queue entries
- Entire in-memory dataset can be enqueued in single turn

#### Final Chunk + EOF in Single Result

```javascript
// Web Streams: always need extra read to see done=true
let result = await reader.read(); // { value: <data>, done: false }
result = await reader.read(); // { value: undefined, done: true }

// New API: final chunk and EOF together
const { value, done } = await stream.read(); // { value: <final data>, done: true }
```

**Optimization:** Eliminates one promise resolution per stream:

```cpp
ReadResult dequeue() {
  auto chunk = buffer.dequeue();
  bool done = buffer.isEmpty() && sourceExhausted;
  return { chunk, done };  // Can return data AND done=true
}
```

### Fast Paths

#### Synchronous Resolution When Data Available

```cpp
Promise<ReadResult> read() {
  if (buffer.hasData()) {
    // Fast path: data already buffered, no async needed
    return kj::Promise<ReadResult>(dequeue());  // Immediate resolution
  }
  // Slow path: must wait for data
  return pendingReadPromise();
}
```

V8 optimizes already-resolved promises, but avoiding the promise entirely is even better when
possible (e.g., internal C++ consumers).

#### `drop(n)` Is Pure Bookkeeping

```javascript
stream.drop(1000); // Discard first 1000 bytes
```

Unlike `take(n).cancel()` which creates a cursor then removes it, `drop(n)` is purely
synchronous bookkeeping:

```cpp
Stream drop(size_t n) {
  // Just advance the minimum readable position
  minReadablePos += n;
  maybeReclaimBuffer();
  return Stream::empty();  // Return closed stream
}
```

No cursor created, no async operation, bytes immediately eligible for reclamation.

#### `Stream.from()` with In-Memory Data

```javascript
const stream = Stream.from(existingUint8Array);
```

**Optimization:** Entire stream contents known upfront:

```cpp
class FromBufferStream {
  ArrayPtr<byte> data;
  size_t pos = 0;

  Promise<ReadResult> read(ReadOptions opts) {
    if (pos >= data.size()) {
      return ReadResult{nullptr, true};
    }
    size_t n = std::min(opts.max.orDefault(data.size()), data.size() - pos);
    auto chunk = data.slice(pos, pos + n);
    pos += n;
    return ReadResult{chunk, pos >= data.size()};
  }

  Promise<Uint8Array> bytes() {
    // Super fast path: just return the data directly
    return data.slice(pos);
  }
};
```

No pull machinery, no buffering, no promises for `bytes()` — just return the data.

### Memory Efficiency

#### Ring Buffer with Cursor-Based Reclamation

```cpp
class RingBuffer {
  std::vector<byte> storage;
  size_t head = 0;  // Oldest data
  size_t tail = 0;  // Write position

  void append(ArrayPtr<byte> data) {
    ensureSpace(data.size());
    // Write data at tail, wrapping if needed
    memcpy(&storage[tail % storage.size()], data.begin(), data.size());
    tail += data.size();
  }

  void discardBefore(size_t pos) {
    head = std::max(head, pos);
    // If head catches up to tail, buffer is empty
    // Could shrink storage here if desired
  }

  ArrayPtr<byte> slice(size_t from, size_t to) {
    // Return view into buffer (handles wraparound)
    // ...
  }
};
```

**Memory lifecycle:**

1. Data written at tail
2. Cursors read and advance their positions
3. `maybeReclaimBuffer()` advances head to minimum cursor position
4. Memory between old head and new head is freed/reusable

#### Bounded Buffers with `onOverflow` Policies

```javascript
const [stream, writer] = Stream.push({
  buffer: { max: 1024 * 1024, onOverflow: 'drop-oldest' },
});
```

**Optimization:** Pre-allocate fixed-size buffer, never grow:

```cpp
class BoundedBuffer {
  std::array<byte, MAX_SIZE> storage;  // Fixed allocation
  // ... ring buffer logic

  void enqueue(ArrayPtr<byte> data) {
    if (usedSpace() + data.size() > MAX_SIZE) {
      switch (overflowPolicy) {
        case DropOldest:
          discardOldest(data.size());  // Make room
          break;
        case DropNewest:
          return;  // Don't enqueue
        case Error:
          throw BufferOverflow();
        case Block:
          return blockUntilSpace(data.size());
      }
    }
    append(data);
  }
};
```

Predictable memory footprint, no reallocation, no GC pressure from buffer growth.

#### Detached Branches Have Zero Overhead

```javascript
const branch = stream.tee({ detached: true });
// Later, maybe:
if (needBranch) {
  branch.attach();
  await branch.bytes();
}
```

**Optimization:** No cursor created until attachment:

```cpp
Stream tee(TeeOptions options) {
  if (options.detached) {
    // Create a "potential" branch with no cursor
    return DetachedBranch{this};
  }
  // Normal branch: create cursor immediately
  cursors.push_back(Cursor{currentPos});
  return BranchStream{this, &cursors.back()};
}

class DetachedBranch {
  Stream* parent;
  std::optional<Cursor> cursor;  // Empty until attach()

  void attach() {
    if (!cursor) {
      cursor = Cursor{parent->currentWritePos()};
      parent->cursors.push_back(*cursor);
    }
  }
};
```

Zero memory overhead for branches that might not be used.

### Pipeline Optimization

#### `Stream.pipeline()` Enables Whole-Pipeline Optimization

```javascript
await Stream.pipeline(source, transform1, transform2, destination);
```

The implementation sees the entire pipeline structure at construction time, enabling
optimizations that aren't possible with incremental `pipeThrough()` chains.

**Stage Fusion:**

Adjacent compatible transforms can be fused into a single transform:

```cpp
// User code:
stream.pipeThrough(decompressGzip)
      .pipeThrough(parseJson);

// Implementation detects:
// - decompressGzip is internal DecompressionStream
// - parseJson is simple stateless transform
// Can fuse into single stage that decompresses and parses without
// intermediate buffering
```

**Direct Source-to-Sink:**

When source and destination are both internal, can bypass JS entirely:

```cpp
Promise<void> optimizedPipeline(Stream source, Writer dest) {
  // Both are internal (e.g., fetch body → file)
  if (auto* fetchBody = source.tryGetInternal<FetchBody>()) {
    if (auto* fileWriter = dest.tryGetInternal<FileWriter>()) {
      // Use splice() or sendfile() — data never enters JS
      return kernelSplice(fetchBody->fd(), fileWriter->fd());
    }
  }
  // Fall back to JS-mediated pipeline
  return standardPipeline(source, dest);
}
```

**Batched Chunk Flow:**

Instead of flowing one chunk at a time:

```
read₁ → transform₁ → enqueue₁ → read₂ → transform₂ → enqueue₂ → ...
```

Batch multiple chunks:

```
read[₁,₂,₃] → transform[₁,₂,₃] → enqueue[₁,₂,₃]
```

**Shared Backpressure:**

Single backpressure check for entire pipeline instead of per-stage:

```cpp
class FusedPipeline {
  size_t totalBuffered = 0;
  size_t maxBuffer;

  bool shouldPull() {
    // One check for entire pipeline
    return totalBuffered < maxBuffer;
  }
};
```

#### `limit` Option Avoids Intermediate Streams

```javascript
// Without limit option: creates intermediate stream
stream.take(1024).pipeThrough(transform);

// With limit option: no intermediate stream
stream.pipeThrough(transform, { limit: 1024 });
```

**Optimization:**

```cpp
Stream pipeThrough(Transformer t, PipeOptions opts) {
  if (opts.limit) {
    // Fused: limit check inside the pipe loop
    return FusedLimitedPipe{this, t, *opts.limit};
  }
  // Standard: separate limit stream
  return StandardPipe{this, t};
}
```

Avoids one stream object allocation, one cursor, and associated bookkeeping.

### Internal vs JS-Created Streams

A key optimization strategy: maintain a fast internal representation for platform-created
streams, only creating the full JS wrapper when JavaScript actually accesses the stream.

```cpp
// Internal representation (C++ only, no JS overhead)
class InternalStream {
  RingBuffer buffer;
  std::vector<Cursor> cursors;
  enum State { READABLE, CLOSED, ERRORED } state;

  // Fast internal operations
  kj::ArrayPtr<byte> readSync(size_t max) {
    return buffer.dequeue(max);
  }
};

// JS wrapper (created lazily on first JS access)
class StreamJSWrapper : public jsg::Object {
  kj::Own<InternalStream> internal;

  // Full JS API delegating to internal
  jsg::Promise<ReadResult> read(jsg::Lock& js, ReadOptions opts) {
    // ... marshal to/from JS
  }
};

// Usage in fetch implementation
kj::Own<InternalStream> createResponseBody(HttpInputStream& input) {
  auto stream = kj::heap<InternalStream>();
  // Pump data from HTTP layer directly into internal buffer
  // No JS involvement until user accesses response.body
  return stream;
}
```

**Benefits:**

- Fetch responses, file reads, etc. are pure C++ until JS touches them
- Internal consumers (like `pipeTo` to internal sink) stay in C++
- JS wrapper created on-demand, not speculatively

### Promise Pooling and Reuse

For high-frequency operations, pooling promise objects can reduce GC pressure:

```cpp
class PromisePool {
  std::vector<v8::Global<v8::Promise::Resolver>> free;

  v8::Local<v8::Promise::Resolver> acquire(v8::Isolate* isolate) {
    if (!free.empty()) {
      auto resolver = free.back().Get(isolate);
      free.pop_back();
      return resolver;
    }
    return v8::Promise::Resolver::New(isolate->GetCurrentContext())
        .ToLocalChecked();
  }

  void release(v8::Local<v8::Promise::Resolver> resolver) {
    // Reset state if possible, return to pool
    free.push_back(v8::Global<v8::Promise::Resolver>(isolate, resolver));
  }
};
```

**Caveat:** Promise pooling has diminishing returns with modern V8 and may complicate GC.
Profile before implementing.

### Transform Fast Paths

#### Simple Function Transforms

Detect at creation time whether a transform is a simple stateless function:

```cpp
Transform createTransform(v8::Local<v8::Value> transformer) {
  if (transformer->IsFunction()) {
    // Simple function — no state, no abort()
    return SimpleFunctionTransform{transformer.As<v8::Function>()};
  }

  auto obj = transformer.As<v8::Object>();
  bool hasAbort = obj->Has(context, v8::String::NewFromUtf8(isolate, "abort"));

  if (!hasAbort) {
    // Object with transform() but no abort() — stateless
    return StatelessObjectTransform{obj};
  }

  // Full stateful transform with abort() support
  return StatefulTransform{obj};
}
```

**SimpleFunctionTransform** can:

- Skip abort() dispatch on error
- Potentially inline the function call
- Avoid storing state between chunks

#### Generator vs Non-Generator Detection

```cpp
class Transform {
  enum class Kind { SYNC_FUNCTION, ASYNC_FUNCTION, SYNC_GENERATOR, ASYNC_GENERATOR };
  Kind kind;

  void process(ArrayPtr<byte> chunk) {
    switch (kind) {
      case SYNC_FUNCTION: {
        // Fastest path: call, get result, done
        auto result = callSync(chunk);
        if (result) enqueue(result);
        break;
      }
      case SYNC_GENERATOR: {
        // Drain all sync yields
        auto gen = callSync(chunk);
        while (auto value = gen.next()) {
          enqueue(value);
        }
        break;
      }
      case ASYNC_FUNCTION:
      case ASYNC_GENERATOR:
        // Must go through promise machinery
        processAsync(chunk);
        break;
    }
  }
};
```

### Summary: Optimization Hierarchy

From most to least impactful:

| Optimization                     | Impact    | Complexity |
| -------------------------------- | --------- | ---------- |
| Bytes-only (eliminate dichotomy) | Very High | Low        |
| Unified buffer/cursor model      | Very High | Medium     |
| Internal stream representation   | High      | Medium     |
| Buffer detachment (zero-copy)    | High      | Low        |
| `writev()` / batched operations  | High      | Low        |
| Sync generator fast path         | Medium    | Low        |
| `atLeast` read batching          | Medium    | Low        |
| `Stream.pipeline()` fusion       | Medium    | High       |
| Promise pooling                  | Low       | Medium     |
| Transform kind detection         | Low       | Low        |

The first three provide the largest gains and should be prioritized in any implementation.
The bytes-only decision in particular eliminates entire categories of complexity and enables
most other optimizations.

---

## 10. System Stream Use Cases

This section validates the proposed API against real-world I/O scenarios. For each use case, we
show how the API would be used and note any gaps or awkwardness discovered.

### Use Case 1: Consuming a Fetch Response Body

**Simple consumption (collect all bytes):**

```javascript
const response = await fetch(url);
const data = await response.body.bytes(); // Uint8Array

// Or as text
const text = await response.body.text(); // string (UTF-8)

// Or as ArrayBuffer
const buffer = await response.body.arrayBuffer(); // ArrayBuffer
```

✅ **Clean and simple** — single method call, no reader acquisition or lock management.

**Streaming consumption (process incrementally):**

```javascript
const response = await fetch(url);

for await (const chunk of response.body) {
  await processChunk(chunk); // chunk is Uint8Array
}
```

✅ **Idiomatic** — standard async iteration, automatic cleanup on break/return/throw.

**Partial consumption (read header, then body):**

```javascript
const response = await fetch(url);

// Read fixed-size header
const header = await response.body.take(16).bytes();
const bodyLength = parseHeader(header);

// Read body based on header
const body = await response.body.take(bodyLength).bytes();

// Remaining bytes available if needed
const trailer = await response.body.bytes();
```

✅ **Natural sequential access** — no locking, no explicit position tracking.

**Partial consumption with early termination:**

```javascript
const response = await fetch(url);

// Only want first 1MB — limit() caps and cancels source after
const preview = await response.body.limit(1024 * 1024).bytes();
// Source automatically cancelled after 1MB
```

✅ **Clean limiting** — `limit(n)` caps the stream and cancels source automatically.

**Protecting against oversized responses:**

```javascript
const response = await fetch(url);

// Defensive: limit to 10MB, cancel if larger
const data = await response.body.limit(10 * 1024 * 1024).bytes();

// Or use take() if you need to continue with the rest
const header = await response.body.take(16).bytes();
const body = await response.body.bytes(); // Continues from byte 16
```

**Comparison: `limit()` vs `take()`:**

| Method     | Parent stream after | Use case                              |
| ---------- | ------------------- | ------------------------------------- |
| `limit(n)` | Cancelled           | Cap total size, protect against large |
| `take(n)`  | Continues at byte n | Read prefix, then continue with rest  |

---

### Use Case 2: Streaming a Request Body to Fetch

**From a pull source (generator):**

```javascript
const body = Stream.pull(async function* () {
  for await (const record of database.query('SELECT * FROM logs')) {
    yield JSON.stringify(record) + '\n';
  }
});

const response = await fetch(url, {
  method: 'POST',
  body: body,
  headers: { 'Content-Type': 'application/x-ndjson' },
});
```

✅ **Natural backpressure** — generator pauses when network can't accept more data.

**From a push source (external events):**

```javascript
const [body, writer] = Stream.push({
  buffer: { max: 64 * 1024, onOverflow: 'block' },
});

// Start the fetch (runs concurrently)
const fetchPromise = fetch(url, {
  method: 'POST',
  body: body,
});

// Feed data from event source
eventSource.onmessage = async (e) => {
  await writer.write(e.data); // Blocks if buffer full
};

eventSource.onclose = () => writer.close();
eventSource.onerror = (e) => writer.abort(e);

const response = await fetchPromise;
```

✅ **Explicit backpressure handling** — `onOverflow: 'block'` prevents unbounded buffering.

**From existing data with chunking:**

```javascript
const largeBuffer = await file.arrayBuffer();

// Stream in 64KB chunks using sync generator (no async overhead)
const body = Stream.pull(function* () {
  const view = new Uint8Array(largeBuffer);
  for (let offset = 0; offset < view.length; offset += 65536) {
    yield view.subarray(offset, Math.min(offset + 65536, view.length));
  }
});

const response = await fetch(url, { method: 'PUT', body });
```

✅ **Chunked upload from memory** — sync generator is efficient for in-memory data.
✅ **No promise overhead** — yields processed in batch, backpressure applied at chunk boundaries.

---

### Use Case 3: File Reading and Writing

**Reading a file as a stream:**

```javascript
// Assuming file.stream() returns our new Stream type
const stream = file.stream();

// Process incrementally
for await (const chunk of stream) {
  await processChunk(chunk);
}

// Or collect all
const contents = await file.stream().bytes();
```

✅ **Same patterns as fetch** — consistent API across I/O sources.

**Writing a stream to a file:**

```javascript
// Assuming writable file handle
const writable = fileHandle.writable();

await sourceStream.pipeTo(writable);
```

✅ **Simple pipe** — backpressure handled automatically.

**Copying with transformation:**

```javascript
const input = inputFile.stream();
const output = outputFile.writable();

await input.pipeThrough(compressionTransform).pipeTo(output);
```

✅ **Pipeline composition** — clean chaining.

**Reading specific byte ranges (seek-like behavior):**

```javascript
const stream = file.stream();

// Skip first 1000 bytes, read next 500
stream.drop(1000);
const data = await stream.take(500).bytes();

// Continue from byte 1500...
const more = await stream.take(100).bytes();
```

✅ **Sequential access works** — but true random access (seeking backwards) not supported.

**Gap identified:** No random access / seeking. This is intentional (streams are sequential), but
means file APIs might need separate `read(offset, length)` methods for random access patterns.

---

### Use Case 4: WebSocket to Stream Bridging

**WebSocket messages as a stream:**

```javascript
function websocketToStream(ws) {
  const [stream, writer] = Stream.push({
    buffer: {
      max: 1024 * 1024, // 1MB buffer
      hardMax: 10 * 1024 * 1024, // 10MB hard limit
      onOverflow: 'block', // Backpressure via blocking
    },
  });

  ws.onmessage = async (e) => {
    // e.data is string or ArrayBuffer
    await writer.write(e.data); // Auto-converts to bytes
  };

  ws.onclose = () => writer.close();
  ws.onerror = (e) => writer.abort(new Error('WebSocket error'));

  return stream;
}

// Usage
const stream = websocketToStream(socket);
for await (const chunk of stream) {
  await handleMessage(chunk);
}
```

✅ **Push source pattern works** — clear backpressure via `onOverflow` policy.

**Stream to WebSocket:**

```javascript
async function streamToWebsocket(stream, ws) {
  for await (const chunk of stream) {
    // WebSocket.send() is sync but may buffer internally
    ws.send(chunk);

    // Check WebSocket buffering (platform-specific)
    while (ws.bufferedAmount > 1024 * 1024) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  ws.close();
}
```

⚠️ **Gap identified:** WebSocket doesn't expose backpressure cleanly. The stream API is fine, but
WebSocket's `bufferedAmount` polling is awkward. This is a WebSocket API limitation, not a streams
issue.

**Bidirectional WebSocket bridge:**

```javascript
function createWebSocketDuplex(ws) {
  // Readable side (messages from server)
  const [readable, readWriter] = Stream.push({
    buffer: { max: 1024 * 1024, onOverflow: 'drop-oldest' },
  });

  ws.onmessage = (e) => readWriter.write(e.data);
  ws.onclose = () => readWriter.close();
  ws.onerror = (e) => readWriter.abort(e);

  // Writer side (messages to server)
  const writer = Stream.writer({
    write(chunk) {
      ws.send(chunk);
    },
    close() {
      ws.close();
    },
    abort(reason) {
      ws.close(1000, String(reason).slice(0, 123));
    },
  });

  return { readable, writer };
}
```

✅ **Duplex via separate streams** — works, though Open Question #3 asks if a first-class
`DuplexStream` would be better.

---

### Use Case 5: HTTP Server Request/Response Handling

**Simple request handler:**

```javascript
async function handler(request) {
  // Read request body (respects client disconnect via request.signal)
  const body = await request.body.text('utf-8', { signal: request.signal });
  const data = JSON.parse(body);

  // Process and respond
  const result = await processData(data);

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

✅ **Simple and familiar** — same as current Workers API. The `request.signal` automatically
cancels body consumption if the client disconnects.

**Streaming request processing:**

```javascript
async function handler(request) {
  let count = 0;

  // Process request body incrementally
  for await (const chunk of request.body) {
    count += countRecords(chunk);
  }

  return new Response(`Processed ${count} records`);
}
```

✅ **Memory-efficient** — doesn't buffer entire request.

**Streaming response:**

```javascript
async function handler(request) {
  const stream = Stream.pull(async function* () {
    for await (const row of database.query('SELECT * FROM large_table')) {
      yield JSON.stringify(row) + '\n';
    }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}
```

✅ **Pull-based streaming response** — data generated on demand as client reads.

**Transform pipeline in handler:**

```javascript
async function handler(request) {
  // Decompress, process, recompress
  const output = request.body
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(transformRecords)
    .pipeThrough(new CompressionStream('gzip'));

  return new Response(output, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Encoding': 'gzip',
    },
  });
}
```

✅ **Pipeline composition** — clean transform chaining.

**Echoing with inspection (tee for logging):**

```javascript
async function handler(request) {
  const forLogging = request.body.tee({
    buffer: {
      max: 1024 * 1024,
      onOverflow: 'drop-oldest', // Don't block processing if logging is slow
    },
  });

  // Log asynchronously (fire and forget)
  logRequestBody(forLogging).catch(console.error);

  // Process and respond (original request.body still usable)
  const result = await processStream(request.body);
  return new Response(result);
}
```

✅ **Bounded tee** — explicit buffer limits prevent the memory issues from Case Study 3.

---

### Use Case 6: Stateful Transform (NDJSON Parser)

Stateful transforms use objects with a `transform()` method when they need to buffer data
across chunks or emit multiple outputs per input. A common example is parsing newline-delimited
JSON (NDJSON).

Since streams are bytes-only, there are two approaches for NDJSON parsing:

**Approach A: Validate and re-emit as bytes (stateful transform object)**

Use this when you want to validate JSON and pass it through a pipeline:

```javascript
function createNDJSONValidator() {
  let buffer = '';
  const decoder = new TextDecoder();

  return {
    // Sync generator: yields validated JSON lines as strings (→ UTF-8 bytes)
    // chunk is null when input ends (flush)
    *transform(chunk) {
      if (chunk === null) {
        // Flush: validate and emit any remaining data
        if (buffer.trim()) {
          JSON.parse(buffer); // Validate
          yield buffer;
        }
        return;
      }

      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line

      for (const line of lines) {
        if (line.trim()) {
          JSON.parse(line); // Validate (throws on invalid JSON)
          yield line + '\n'; // Re-emit as string → UTF-8 encoded
        }
      }
    },
  };
}

// Usage: validate NDJSON in a pipeline
const validated = source
  .pipeThrough(createNDJSONValidator())
  .pipeTo(destination);
```

**Approach B: Parse to objects using async generator (not StreamTransformer)**

Use this when you want to consume parsed objects directly. This uses a plain async generator
function, not a `StreamTransformer`, because the output is JS objects (not bytes):

```javascript
async function* parseNDJSON(stream) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (line.trim()) {
        yield JSON.parse(line); // Yield parsed object
      }
    }
  }

  if (buffer.trim()) {
    yield JSON.parse(buffer);
  }
}

// Usage: consume parsed objects directly
async function handler(request) {
  const response = await fetch('https://api.example.com/stream');

  let count = 0;
  let totalValue = 0;

  for await (const record of parseNDJSON(response.body)) {
    count++;
    totalValue += record.value;
    await saveToDatabase(record);
  }

  return Response.json({ count, totalValue });
}
```

✅ **Memory-efficient** — processes records one at a time, doesn't buffer entire response.

✅ **Backpressure** — if `saveToDatabase()` is slow, backpressure propagates to the fetch.

**When to use transform object vs async generator:**

| Scenario                              | Use                      |
| ------------------------------------- | ------------------------ |
| Output is bytes (pipeline continues)  | Transform object         |
| Output is JS objects (terminal)       | Async generator function |
| Need to compose with other transforms | Transform object         |
| One-off consumption                   | Async generator function |

**Comparison: simple function vs transform object:**

| Aspect              | Simple function           | Transform object                 |
| ------------------- | ------------------------- | -------------------------------- |
| State across chunks | No (stateless)            | Yes (closure or instance fields) |
| Output per input    | Zero or one               | Zero, one, or many (generator)   |
| Flush on end        | No                        | Yes (chunk === null)             |
| Use case            | Map, filter, pass-through | Parsers, framers, accumulators   |

```javascript
// Simple function: 1:1 stateless transform
source.pipeThrough((chunk) => encrypt(chunk));

// Transform object: stateful with buffering
source.pipeThrough(createNDJSONValidator());
source.pipeThrough(createChunkAccumulator(64 * 1024)); // Combine small chunks
source.pipeThrough(createLengthPrefixedFramer()); // Parse framed protocol
```

---

### Use Case 7: Fetch → Transform → File Pipeline

**Download, decompress, and save:**

```javascript
async function downloadAndSave(url, filePath, signal) {
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const fileHandle = await fs.open(filePath, 'w');

  try {
    await response.body
      .pipeThrough(new DecompressionStream('gzip'))
      .pipeTo(fileHandle.writable(), { signal });
  } finally {
    await fileHandle.close();
  }
}

// Usage with timeout
await downloadAndSave(url, path, AbortSignal.timeout(60000));
```

✅ **Clean pipeline with cancellation** — signal propagates through fetch and pipe.

**With progress tracking:**

```javascript
async function downloadWithProgress(url, filePath, onProgress) {
  const response = await fetch(url);
  const totalSize = parseInt(response.headers.get('Content-Length') || '0');

  let downloaded = 0;

  // Progress tracking transform (pass-through with side effect)
  const progressTracker = (chunk) => {
    downloaded += chunk.byteLength;
    onProgress({
      downloaded,
      totalSize,
      percent: totalSize ? downloaded / totalSize : 0,
    });
    return chunk; // Pass through unchanged
  };

  await response.body
    .pipeThrough(progressTracker)
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeTo(fileHandle.writable());
}
```

✅ **Transform for side effects** — progress tracking fits naturally.

**Note:** Progress reflects compressed bytes downloaded, not decompressed bytes written. For
decompressed progress, add another tracker after decompression.

**With retry on failure:**

```javascript
async function downloadWithRetry(url, filePath, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await downloadAndSave(url, filePath);
      return; // Success
    } catch (e) {
      if (attempt === maxRetries) throw e;
      console.log(`Attempt ${attempt} failed, retrying...`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
```

⚠️ **Gap identified:** No built-in retry. Retry logic wraps the entire operation, not integrated
into the stream. This is intentional (retry is left to user code), but means:

- Can't resume partial downloads without Range request support
- Each retry starts from scratch

For resumable downloads, you'd need:

```javascript
async function resumableDownload(url, filePath) {
  const fileHandle = await fs.open(filePath, 'a');
  const existingSize = (await fileHandle.stat()).size;

  const response = await fetch(url, {
    headers: existingSize > 0 ? { Range: `bytes=${existingSize}-` } : {},
  });

  await response.body.pipeTo(fileHandle.writable());
}
```

This works but requires manual Range header handling — streams don't know about HTTP semantics.

---

### Use Case 8: Proxy with Transformation

**Simple pass-through proxy:**

```javascript
async function proxy(request) {
  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  });
}
```

✅ **Zero-copy pass-through** — request body pipes directly to upstream, response body pipes
directly to client.

**Proxy with body transformation:**

```javascript
async function transformingProxy(request) {
  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: filterHeaders(request.headers),
    body: request.body,
  });

  // Transform response body
  const transformedBody = upstreamResponse.body
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(contentFilter)
    .pipeThrough(new CompressionStream('gzip'));

  return new Response(transformedBody, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  });
}
```

✅ **Transform pipeline in proxy** — clean composition.

**Proxy with request and response transformation:**

```javascript
async function bidirectionalProxy(request) {
  // Transform request body
  const transformedRequest = request.body.pipeThrough(requestTransform);

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    body: transformedRequest,
  });

  // Transform response body
  const transformedResponse =
    upstreamResponse.body.pipeThrough(responseTransform);

  return new Response(transformedResponse, {
    status: upstreamResponse.status,
  });
}
```

✅ **Both directions transformed** — symmetric API.

**Proxy with timeout:**

```javascript
async function proxyWithTimeout(request, timeoutMs = 30000) {
  // Single signal covers both fetch and response body streaming
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    request.signal, // Also cancel if client disconnects
  ]);

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    body: request.body,
    signal,
  });

  // For streaming responses, the signal propagates through the pipe
  // If we need to collect the body with timeout protection:
  const body = await upstreamResponse.body.bytes({ signal });
  return new Response(body, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  });
}
```

✅ **AbortSignal composes cleanly** — single signal handles fetch timeout, body streaming timeout,
and client disconnect.

**For true streaming proxy (not buffering the response):**

```javascript
async function streamingProxyWithTimeout(request, timeoutMs = 30000) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    request.signal,
  ]);

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    body: request.body,
    signal,
  });

  // Stream response body through with signal — aborts if timeout or client disconnect
  const [output, writable] = Stream.transform((chunk) => chunk);
  upstreamResponse.body.pipeTo(writable, { signal }).catch(() => {});

  return new Response(output, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  });
}
```

⚠️ **Caveat:** The timeout here is a _total_ timeout from request start, not an idle timeout
(time between chunks). See below for why idle timeout requires a transform.

**Why timeout is NOT built into the API:**

Built-in timeout mechanisms create **timing side-channel risks**. A stream timeout could leak:

- How much data was processed before the timeout triggered
- Buffer states and backpressure behavior
- Processing time correlations with data content or size

By leaving timeout to user code, developers can make security-appropriate decisions:

- Use constant-time waits to avoid leaking processing information
- Add jitter to timeout values
- Omit timeouts entirely for security-sensitive streams
- Implement timeouts at a higher level (e.g., overall request timeout via AbortSignal)

**Solution: First-class `AbortSignal` support**

The API includes `AbortSignal` support on consumption methods and piping, allowing users to
control cancellation (including timeout) as appropriate for their security context:

```javascript
// Total timeout using AbortSignal.timeout()
const data = await response.body.bytes({ signal: AbortSignal.timeout(30000) });

// Or with AbortController for manual control
const controller = new AbortController();
setTimeout(() => controller.abort(), 30000);

await response.body.pipeTo(destination, { signal: controller.signal });

// Compose multiple abort conditions with AbortSignal.any()
const signal = AbortSignal.any([AbortSignal.timeout(30000), userCancelSignal]);
const data = await response.body.bytes({ signal });
```

This approach:

- Uses the standard JS cancellation primitive
- Composes with `AbortSignal.timeout()`, `AbortSignal.any()`, etc.
- Lets users decide if/when to use timeouts based on their security context
- Consistent with `fetch()` and other web APIs

**For idle timeouts (time between chunks)**, a transform is still needed:

```javascript
function idleTimeoutTransform(ms) {
  let lastChunkTime = Date.now();
  return (chunk) => {
    const now = Date.now();
    if (now - lastChunkTime > ms) {
      throw new Error('Stream idle timeout');
    }
    lastChunkTime = now;
    return chunk; // Pass through unchanged
  };
}

const timedBody = response.body.pipeThrough(idleTimeoutTransform(30000));
```

Idle timeout via transform gives users explicit control over timing behavior.

**Proxy with tee for logging:**

```javascript
async function loggingProxy(request) {
  // Tee request body for logging
  const reqLog = request.body.tee({
    buffer: { max: 1024 * 1024, onOverflow: 'drop-oldest' },
  });

  // Log request asynchronously
  logStream('request', reqLog).catch(console.error);

  // Original request.body goes to upstream
  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    body: request.body,
  });

  // Tee response body for logging
  const respLog = upstreamResponse.body.tee({
    buffer: { max: 1024 * 1024, onOverflow: 'drop-oldest' },
  });

  // Log response asynchronously
  logStream('response', respLog).catch(console.error);

  // Original response body goes to client
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  });
}
```

✅ **Bounded tee with drop policy** — logging can fall behind without blocking the proxy or
causing OOM. Data loss in logs is acceptable; data loss in proxy is not.

---

### Use Case 9: Server-Side Rendering (SSR)

SSR involves generating HTML incrementally, often with async components and streaming to the
client as content becomes available.

**Basic streaming HTML generation:**

```javascript
async function renderPage(request) {
  const stream = Stream.pull(async function* () {
    yield '<!DOCTYPE html><html><head>';
    yield '<title>My Page</title>';
    yield '</head><body>';

    // Header renders quickly
    yield '<header>' + renderHeader() + '</header>';

    // Main content may involve async data fetching
    yield '<main>';
    for await (const section of renderSections(request)) {
      yield section;
    }
    yield '</main>';

    // Footer
    yield '<footer>' + renderFooter() + '</footer>';
    yield '</body></html>';
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
```

✅ **Generator-based SSR** — yields strings (auto-encoded to UTF-8), natural async/await for data.

**SSR with parallel component rendering:**

```javascript
async function renderWithSuspense(request) {
  const stream = Stream.pull(async function* () {
    yield '<!DOCTYPE html><html><body>';

    // Start async component fetches in parallel
    const headerPromise = renderHeaderAsync();
    const contentPromise = renderContentAsync(request);
    const sidebarPromise = renderSidebarAsync();

    // Yield placeholder, then content as each resolves
    yield '<div id="header">';
    yield await headerPromise;
    yield '</div>';

    yield '<div id="content">';
    yield await contentPromise;
    yield '</div>';

    yield '<div id="sidebar">';
    yield await sidebarPromise;
    yield '</div>';

    yield '</body></html>';
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/html' },
  });
}
```

✅ **Parallel data fetching** — promises started early, awaited when needed.

**SSR with component streams:**

```javascript
async function renderWithComponentStreams(request) {
  const stream = Stream.pull(async function* () {
    yield '<!DOCTYPE html><html><body>';

    // Some components return streams or generators — just yield them directly
    yield '<div id="feed">';
    yield renderFeedStream(request.user); // Generator consumed inline
    yield '</div>';

    yield '</body></html>';
  });

  return new Response(stream);
}

async function* renderFeedStream(user) {
  for await (const post of database.streamPosts(user)) {
    yield `<article>${escapeHtml(post.content)}</article>`;
  }
}
```

✅ **Composable generators** — yielding a generator (or Stream) consumes it inline; no `yield*` needed.

---

### Use Case 10: API Gateway Patterns

API gateways route, transform, and aggregate requests across multiple backends.

**Request routing with body forwarding:**

```javascript
async function apiGateway(request) {
  const url = new URL(request.url);
  const backend = selectBackend(url.pathname);

  // Forward request body as a branch (gateway can continue reading if needed)
  const bodyForBackend = request.body.tee();

  const response = await fetch(backend + url.pathname, {
    method: request.method,
    headers: filterHeaders(request.headers),
    body: bodyForBackend,
  });

  // Original request.body still available if gateway needs to inspect it
  // (e.g., for logging, validation, or retry to different backend)

  return response;
}
```

✅ **Branching for flexible routing** — gateway can forward body while retaining access.

**Fan-out to multiple backends:**

```javascript
async function fanOutGateway(request) {
  // Create branches for each backend
  const body1 = request.body.tee();
  const body2 = request.body.tee();
  const body3 = request.body; // Original for third backend

  // Fan out to multiple backends in parallel
  const [resp1, resp2, resp3] = await Promise.all([
    fetch(backend1, { method: 'POST', body: body1 }),
    fetch(backend2, { method: 'POST', body: body2 }),
    fetch(backend3, { method: 'POST', body: body3 }),
  ]);

  // Aggregate responses
  const results = await Promise.all([resp1.json(), resp2.json(), resp3.json()]);

  return Response.json({ results });
}
```

✅ **Multi-tee for fan-out** — multiple `tee()` calls create independent branches.

**Response aggregation from multiple backends:**

```javascript
async function aggregatingGateway(request) {
  const [users, products, orders] = await Promise.all([
    fetch(usersService + '/api/users').then((r) => r.body),
    fetch(productsService + '/api/products').then((r) => r.body),
    fetch(ordersService + '/api/orders').then((r) => r.body),
  ]);

  // Stream concatenated responses — yielding a Stream consumes it inline
  const aggregated = Stream.pull(async function* () {
    yield '{"users":';
    yield users; // Stream is fully consumed before continuing
    yield ',"products":';
    yield products; // Then this Stream is consumed
    yield ',"orders":';
    yield orders; // And this one
    yield '}';
  });

  return new Response(aggregated, {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

✅ **Clean stream aggregation** — yielding a `Stream` (or generator) consumes it inline before
the source generator continues. No need for `yield*` or manual iteration.

**Request/response transformation gateway:**

```javascript
async function transformGateway(request) {
  // Transform request: add auth, modify headers, transform body
  const authHeader = await getAuthToken();

  const transformedBody = request.body.pipeThrough({
    transform(chunk) {
      if (chunk === null) return null;
      return addRequestMetadata(chunk);
    },
  });

  const response = await fetch(backend, {
    method: request.method,
    headers: { ...request.headers, Authorization: authHeader },
    body: transformedBody,
  });

  // Transform response: filter sensitive data, add gateway headers
  const filteredBody = response.body.pipeThrough(sensitiveDataFilter);

  return new Response(filteredBody, {
    status: response.status,
    headers: { ...response.headers, 'X-Gateway': 'processed' },
  });
}
```

✅ **Bidirectional transformation** — clean request and response pipeline.

---

### Use Case 11: Duplex Streams and Sockets

Duplex streams involve bidirectional communication over a single connection.

**TCP socket as duplex (conceptual API):**

```javascript
// Assuming socket API returns { readable, writer }
async function handleConnection(socket) {
  const { readable, writer } = socket;

  // Echo server: pipe input back to output with transformation
  await readable.pipeThrough(processMessage).pipeTo(writer);
}

// Or handle read/write independently
async function chatHandler(socket) {
  const { readable, writer } = socket;

  // Read loop
  (async () => {
    for await (const message of readable) {
      handleIncomingMessage(message);
    }
  })();

  // Write loop (separate concern)
  for await (const outgoing of outgoingMessages) {
    await writer.write(outgoing);
  }
  await writer.close();
}
```

✅ **Separate readable/writer** — works for most duplex patterns.

**Request/response protocol over socket:**

```javascript
async function httpOverSocket(socket) {
  const { readable, writer } = socket;

  // Read request
  const requestLine = await readable.take(8192).text(); // Limit request size
  const { method, path, headers } = parseHttpRequest(requestLine);

  // Read body based on Content-Length
  const contentLength = parseInt(headers['content-length'] || '0');
  const body = await readable.take(contentLength).bytes();

  // Process request
  const response = await handleRequest(method, path, body);

  // Write response
  await writer.write(`HTTP/1.1 ${response.status} OK\r\n`);
  for (const [key, value] of Object.entries(response.headers)) {
    await writer.write(`${key}: ${value}\r\n`);
  }
  await writer.write('\r\n');
  await response.body.pipeTo(writer, { preventClose: true });

  // Keep connection open for next request (HTTP keep-alive)
  // readable continues at next request...
}
```

✅ **Sequential protocol with `take()`** — read exact byte counts, stream continues.

---

### Use Case 12: StartTLS and Protocol Upgrades

StartTLS involves upgrading a plaintext connection to TLS mid-stream.

**StartTLS pattern:**

```javascript
async function handleSmtpConnection(socket) {
  let { readable, writer } = socket;

  // Phase 1: Plaintext SMTP handshake
  await writer.write('220 mail.example.com ESMTP\r\n');

  for await (const line of parseLines(readable)) {
    if (line.startsWith('EHLO')) {
      await writer.write('250-mail.example.com\r\n');
      await writer.write('250 STARTTLS\r\n');
    } else if (line === 'STARTTLS') {
      await writer.write('220 Ready to start TLS\r\n');

      // Phase 2: Upgrade to TLS
      // The socket API handles the TLS handshake and returns new streams
      const tlsSocket = await socket.startTls({
        cert: serverCert,
        key: serverKey,
      });

      // Now use TLS-wrapped streams
      readable = tlsSocket.readable;
      writer = tlsSocket.writer;

      // Continue with encrypted communication
      break;
    }
  }

  // Phase 3: Encrypted SMTP
  for await (const line of parseLines(readable)) {
    await handleEncryptedCommand(line, writer);
  }
}
```

⚠️ **Gap identified:** The stream API itself handles this fine, but requires the socket/TLS API
to provide a way to "upgrade" the connection and return new stream handles. This is outside
the streams API scope but shows how streams integrate with protocol upgrades.

**Alternative: TLS as transform (if supported):**

```javascript
async function startTlsAsTransform(socket) {
  const { readable, writer } = socket;

  // Plaintext phase...
  await doPlaintextHandshake(readable, writer);

  // Upgrade using transforms
  const tlsTransform = new TLSTransform({ cert, key });

  // Wrap both directions
  const encryptedReadable = readable.pipeThrough(tlsTransform.decryptor);
  const encryptedWriter = Stream.writer({
    async write(chunk) {
      const encrypted = await tlsTransform.encrypt(chunk);
      await writer.write(encrypted);
    },
    close: () => writer.close(),
    abort: (r) => writer.abort(r),
  });

  // Continue with encrypted streams
  return { readable: encryptedReadable, writer: encryptedWriter };
}
```

⚠️ **Complex but possible** — TLS as transform works but is awkward. Platform-level TLS
upgrade is cleaner.

---

### Use Case 13: System Stream Sources

Integration with various system I/O sources.

**File streams:**

```javascript
// Reading
const file = await fs.open('/path/to/file', 'r');
const stream = file.stream(); // Returns Stream
const contents = await stream.bytes();

// Writing
const outFile = await fs.open('/path/to/output', 'w');
await sourceStream.pipeTo(outFile.writable()); // writable() returns Writer

// Copy with transform
const input = (await fs.open('input.gz', 'r')).stream();
const output = (await fs.open('output.txt', 'w')).writable();
await Stream.pipeline(input, new DecompressionStream('gzip'), output);
```

✅ **Clean file integration** — `stream()` for reading, `writable()` for writing.

**Process stdio:**

```javascript
// Spawned process with stream I/O
const proc = spawn('grep', ['pattern']);

// proc.stdin is a Writer, proc.stdout/stderr are Streams
await inputData.pipeTo(proc.stdin);

const output = await proc.stdout.bytes();
const errors = await proc.stderr.text();
```

✅ **Process streams** — stdin as Writer, stdout/stderr as Streams.

**Pipe between processes:**

```javascript
// cat file | grep pattern | wc -l
const cat = spawn('cat', ['largefile.txt']);
const grep = spawn('grep', ['pattern']);
const wc = spawn('wc', ['-l']);

// Pipeline: cat.stdout → grep.stdin → grep.stdout → wc.stdin
await Stream.pipeline(cat.stdout, grep.stdin);
await Stream.pipeline(grep.stdout, wc.stdin);

const lineCount = parseInt(await wc.stdout.text());
```

⚠️ **Note:** This works but each `pipeline()` is sequential. For true concurrent piping,
you'd need parallel execution:

```javascript
// Concurrent piping
await Promise.all([
  cat.stdout.pipeTo(grep.stdin),
  grep.stdout.pipeTo(wc.stdin),
]);
const lineCount = parseInt(await wc.stdout.text());
```

✅ **Works with parallel `pipeTo()`** — concurrent piping for process chains.

---

### Use Case 14: Node.js Stream Interoperability

Many applications need to bridge between Node.js streams and the new Stream API, especially
when using Node.js libraries or working with Node.js compatibility layers in workerd.

**Converting Node.js Readable to Stream:**

```javascript
// Utility: Wrap a Node.js Readable stream
function fromNodeReadable(nodeReadable) {
  return Stream.pull(async function* () {
    for await (const chunk of nodeReadable) {
      // Node.js streams may yield strings or Buffers
      if (typeof chunk === 'string') {
        yield chunk; // Auto-encoded to UTF-8
      } else {
        yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
    }
  });
}

// Usage
import { createReadStream } from 'node:fs';

const nodeStream = createReadStream('/path/to/file');
const stream = fromNodeReadable(nodeStream);

// Now use with new Stream API
const contents = await stream.bytes();
```

✅ **Async iteration bridging** — Node.js Readable streams support `for await...of`, making
conversion straightforward.

**Converting Node.js Readable with backpressure control:**

```javascript
// More sophisticated wrapper with explicit backpressure
function fromNodeReadableWithBackpressure(nodeReadable) {
  const [stream, writer] = Stream.push({
    buffer: { max: 64 * 1024, onOverflow: 'block' },
  });

  nodeReadable.on('data', async (chunk) => {
    nodeReadable.pause(); // Pause while we write
    try {
      if (typeof chunk === 'string') {
        await writer.write(chunk);
      } else {
        await writer.write(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        );
      }
    } finally {
      nodeReadable.resume(); // Resume after write completes
    }
  });

  nodeReadable.on('end', () => writer.close());
  nodeReadable.on('error', (err) => writer.abort(err));

  return stream;
}
```

✅ **Explicit backpressure** — Pause/resume pattern ensures Node.js stream respects our buffer limits.

**Converting Stream to Node.js Readable:**

```javascript
import { Readable } from 'node:stream';

// Utility: Create Node.js Readable from Stream
function toNodeReadable(stream) {
  return Readable.from(stream);
}

// Usage
const stream = Stream.pull(async function* () {
  yield 'Hello, ';
  yield 'Node.js!';
});

const nodeReadable = toNodeReadable(stream);

// Use with Node.js APIs
nodeReadable.pipe(process.stdout);
```

✅ **Readable.from() works** — Node.js `Readable.from()` accepts any async iterable, and
`Stream` is async iterable.

**Converting Node.js Writable to Writer:**

```javascript
import { createWriteStream } from 'node:fs';

// Utility: Wrap a Node.js Writable stream
function toWriter(nodeWritable) {
  return Stream.writer({
    write(chunk) {
      return new Promise((resolve, reject) => {
        const ok = nodeWritable.write(chunk, (err) => {
          if (err) reject(err);
        });
        if (ok) {
          resolve();
        } else {
          // Backpressure: wait for drain
          nodeWritable.once('drain', resolve);
          nodeWritable.once('error', reject);
        }
      });
    },

    close() {
      return new Promise((resolve, reject) => {
        nodeWritable.end(() => resolve());
        nodeWritable.once('error', reject);
      });
    },

    abort(reason) {
      nodeWritable.destroy(
        reason instanceof Error ? reason : new Error(String(reason))
      );
      return Promise.resolve();
    },
  });
}

// Usage
const fileWriter = toWriter(createWriteStream('/path/to/output'));

await stream.pipeTo(fileWriter);
```

✅ **Backpressure via drain** — Respects Node.js writable's backpressure signal.

**Converting Writer to Node.js Writable:**

```javascript
import { Writable } from 'node:stream';

// Utility: Create Node.js Writable from Writer factory
function toNodeWritable(writerFactory) {
  const writer = writerFactory();

  return new Writable({
    async write(chunk, encoding, callback) {
      try {
        await writer.write(chunk);
        callback();
      } catch (err) {
        callback(err);
      }
    },

    async final(callback) {
      try {
        await writer.close();
        callback();
      } catch (err) {
        callback(err);
      }
    },

    destroy(err, callback) {
      writer.abort(err).then(() => callback(), callback);
    },
  });
}

// Usage with Stream.push()
const [stream, writer] = Stream.push();
const nodeWritable = toNodeWritable(() => writer);

// Pipe Node.js readable to our stream via Node.js writable
someNodeReadable.pipe(nodeWritable);

// Consume our stream
const data = await stream.bytes();
```

**Full bidirectional bridge example:**

```javascript
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';

// Bridge: Node.js file → new Stream API transform → Node.js file
async function compressFile(inputPath, outputPath) {
  // Source: Node.js readable → Stream
  const input = fromNodeReadable(createReadStream(inputPath));

  // Destination: Writer → Node.js writable
  const output = toWriter(createWriteStream(outputPath));

  // Transform: Use new Stream API's pipeThrough with Node.js zlib
  // Option A: Use Node.js transform directly
  const gzip = createGzip();
  const compressed = fromNodeReadable(createReadStream(inputPath).pipe(gzip));
  await compressed.pipeTo(output);

  // Option B: Bridge Node.js transform stream
  // (see below for transform bridging)
}
```

**Bridging Node.js Transform streams:**

```javascript
import { Transform } from 'node:stream';

// Utility: Use Node.js Transform as a StreamTransformer
function fromNodeTransform(nodeTransform) {
  // Node.js transforms are duplex — we need to bridge both sides
  const [output, outputWriter] = Stream.push({
    buffer: { max: 64 * 1024, onOverflow: 'block' },
  });

  // Forward transform output to our stream
  nodeTransform.on('data', async (chunk) => {
    nodeTransform.pause();
    await outputWriter.write(
      typeof chunk === 'string'
        ? chunk
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    );
    nodeTransform.resume();
  });

  nodeTransform.on('end', () => outputWriter.close());
  nodeTransform.on('error', (err) => outputWriter.abort(err));

  // Return object compatible with pipeThrough expectations
  return {
    readable: output,
    writable: {
      write(chunk) {
        return new Promise((resolve, reject) => {
          const ok = nodeTransform.write(Buffer.from(chunk), (err) => {
            if (err) reject(err);
          });
          if (ok) resolve();
          else {
            nodeTransform.once('drain', resolve);
            nodeTransform.once('error', reject);
          }
        });
      },
      close() {
        return new Promise((resolve) => {
          nodeTransform.end(resolve);
        });
      },
      abort(reason) {
        nodeTransform.destroy(reason);
        return Promise.resolve();
      },
    },
  };
}

// Usage: Pipe through Node.js gzip transform
import { createGzip } from 'node:zlib';

async function compressStream(input) {
  const gzipBridge = fromNodeTransform(createGzip());

  // Manual piping through the bridge
  const pipePromise = input.pipeTo(Stream.writer(gzipBridge.writable));

  // Return the transformed output
  // Note: Must consume output while pipe is running
  return {
    stream: gzipBridge.readable,
    done: pipePromise,
  };
}

// Better: Helper that handles the coordination
async function pipeThruNodeTransform(input, nodeTransform) {
  const bridge = fromNodeTransform(nodeTransform);

  // Start piping input to transform (don't await yet)
  const inputDone = input.pipeTo(Stream.writer(bridge.writable));

  // Return readable that also waits for input completion
  return Stream.pull(async function* () {
    try {
      for await (const chunk of bridge.readable) {
        yield chunk;
      }
    } finally {
      await inputDone; // Ensure input pipe completes
    }
  });
}

// Usage
const compressed = await pipeThruNodeTransform(inputStream, createGzip());
const data = await compressed.bytes();
```

**Complete interop helper module:**

```javascript
// node-stream-bridge.js — Utilities for Node.js stream interoperability

export function fromNodeReadable(nodeReadable) {
  return Stream.pull(async function* () {
    for await (const chunk of nodeReadable) {
      yield typeof chunk === 'string'
        ? chunk
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
  });
}

export function toNodeReadable(stream) {
  const { Readable } = require('node:stream');
  return Readable.from(stream);
}

export function fromNodeWritable(nodeWritable) {
  return Stream.writer({
    write(chunk) {
      return new Promise((resolve, reject) => {
        const ok = nodeWritable.write(Buffer.from(chunk), (err) =>
          err ? reject(err) : null
        );
        if (ok) resolve();
        else {
          nodeWritable.once('drain', resolve);
          nodeWritable.once('error', reject);
        }
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        nodeWritable.end(resolve);
        nodeWritable.once('error', reject);
      });
    },
    abort(reason) {
      nodeWritable.destroy(
        reason instanceof Error ? reason : new Error(String(reason))
      );
      return Promise.resolve();
    },
  });
}

export function toNodeWritable(writer) {
  const { Writable } = require('node:stream');
  return new Writable({
    write(chunk, enc, cb) {
      writer.write(chunk).then(() => cb(), cb);
    },
    final(cb) {
      writer.close().then(() => cb(), cb);
    },
    destroy(err, cb) {
      writer.abort(err).then(() => cb(), cb);
    },
  });
}

// Usage example: Pipe fetch response through Node.js gzip to file
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';

const response = await fetch('https://example.com/large-file');
const gzip = createGzip();

// response.body (Stream) → Node.js gzip → Node.js file
toNodeReadable(response.body).pipe(gzip).pipe(createWriteStream('output.gz'));
```

✅ **Clean interop utilities** — Small helper functions bridge the two APIs.

⚠️ **Performance note:** Bridging involves extra copying (Buffer ↔ Uint8Array) and promise
overhead. For performance-critical paths, prefer native APIs when possible. The bridge is
best for interop with existing Node.js libraries where rewriting isn't practical.

**When to use bridging vs native:**

| Scenario                                | Recommendation                          |
| --------------------------------------- | --------------------------------------- |
| Using existing Node.js library          | Bridge to/from Node.js streams          |
| New code in workerd                     | Use new Stream API directly             |
| Performance-critical pipeline           | Avoid bridging; use one API throughout  |
| Quick prototyping with Node.js tools    | Bridge freely; optimize later if needed |
| Streaming to/from Node.js child process | Bridge at process boundary              |

---

### Use Case 15: Web Streams Interoperability

For completeness, interop with the existing Web Streams API (which workerd also supports):

**Converting ReadableStream to Stream:**

```javascript
// Utility: Wrap a Web Streams ReadableStream
function fromReadableStream(webReadable) {
  return Stream.pull(async function* () {
    const reader = webReadable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  });
}

// Usage
const webStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3]));
    controller.close();
  },
});

const stream = fromReadableStream(webStream);
const data = await stream.bytes();
```

**Converting Stream to ReadableStream:**

```javascript
// Utility: Create Web Streams ReadableStream from Stream
function toReadableStream(stream) {
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await stream.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },

    cancel(reason) {
      return stream.cancel(reason);
    },
  });
}

// Usage
const stream = Stream.from('Hello, Web Streams!');
const webStream = toReadableStream(stream);

// Use with Web Streams APIs
const response = new Response(webStream);
```

**Converting WritableStream to Writer:**

```javascript
// Utility: Wrap a Web Streams WritableStream
function fromWritableStream(webWritable) {
  const writer = webWritable.getWriter();

  return Stream.writer({
    async write(chunk) {
      await writer.ready;
      await writer.write(chunk);
    },

    async close() {
      await writer.close();
    },

    async abort(reason) {
      await writer.abort(reason);
    },
  });
}
```

**Converting Writer to WritableStream:**

```javascript
// Utility: Create Web Streams WritableStream from Writer
function toWritableStream(writer) {
  return new WritableStream({
    async write(chunk) {
      await writer.write(chunk);
    },

    async close() {
      await writer.close();
    },

    async abort(reason) {
      await writer.abort(reason);
    },
  });
}
```

**Bridging TransformStream:**

```javascript
// Use Web Streams TransformStream with new Stream API
async function pipeThruWebTransform(stream, webTransform) {
  const webReadable = toReadableStream(stream);
  const transformed = webReadable.pipeThrough(webTransform);
  return fromReadableStream(transformed);
}

// Usage with built-in transforms
const compressed = await pipeThruWebTransform(
  inputStream,
  new CompressionStream('gzip')
);
```

✅ **Built-in transforms work** — `CompressionStream`, `DecompressionStream`, `TextEncoderStream`,
`TextDecoderStream` can all be bridged.

**Native interop on Stream class (proposed):**

```javascript
// If implemented natively on Stream:
const webStream = stream.toReadableStream();
const stream = Stream.fromReadable(webReadable);

// These would be more efficient than the JS bridges above,
// potentially sharing internal buffers
```

---

### Summary: API Validation Results

| Use Case                   | Status | Notes                                     |
| -------------------------- | ------ | ----------------------------------------- |
| Fetch response (simple)    | ✅     | Clean single-method consumption           |
| Fetch response (streaming) | ✅     | Standard async iteration                  |
| Fetch response (partial)   | ✅     | `take()`/`drop()`/`limit()` work well     |
| Request body (pull)        | ✅     | Generator-based, natural backpressure     |
| Request body (push)        | ✅     | `Stream.push()` with buffer config        |
| File reading               | ✅     | Same patterns as fetch                    |
| File writing               | ✅     | `pipeTo()` works cleanly                  |
| WebSocket → Stream         | ✅     | Push source pattern                       |
| Stream → WebSocket         | ⚠️     | Works, but WS backpressure is awkward     |
| HTTP handler (simple)      | ✅     | Familiar patterns                         |
| HTTP handler (streaming)   | ✅     | Both request and response streaming work  |
| HTTP handler (transform)   | ✅     | Pipeline composition                      |
| Stateful transform         | ✅     | `StreamTransformerObject` for parsers     |
| Fetch → Transform → File   | ✅     | Clean pipeline                            |
| Progress tracking          | ✅     | Transform for side effects                |
| Retry/resume               | ⚠️     | Manual; no built-in resume support        |
| Proxy (pass-through)       | ✅     | Efficient pass-through                    |
| Proxy (transforming)       | ✅     | Transform pipelines work                  |
| Proxy (with timeout)       | ✅     | User-implemented; no built-in (security)  |
| Proxy (with logging)       | ✅     | Bounded tee prevents OOM                  |
| SSR (basic)                | ✅     | Generator-based HTML streaming            |
| SSR (parallel components)  | ✅     | Async/await with parallel promises        |
| SSR (composable)           | ✅     | `yield*` delegates to sub-generators      |
| API Gateway (routing)      | ✅     | `tee()` for flexible body forwarding      |
| API Gateway (fan-out)      | ✅     | Multiple `tee()` for parallel backends    |
| API Gateway (transform)    | ✅     | Bidirectional request/response transforms |
| Duplex (echo server)       | ✅     | `{ readable, writer }` pattern works      |
| Duplex (protocol)          | ✅     | `take()` for request/response framing     |
| StartTLS                   | ⚠️     | Works but requires platform TLS support   |
| File streams               | ✅     | `stream()` / `writable()` integration     |
| Process stdio              | ✅     | stdin as Writer, stdout/stderr as Streams |
| Process pipelines          | ✅     | Parallel `pipeTo()` for process chains    |
| Node.js Readable → Stream  | ✅     | Async iteration or push-based bridge      |
| Stream → Node.js Readable  | ✅     | `Readable.from()` accepts async iterables |
| Node.js Writable → Writer  | ✅     | Drain-based backpressure handling         |
| Node.js Transform bridge   | ⚠️     | Works but requires manual coordination    |
| Web Streams → Stream       | ✅     | Simple wrapper with reader loop           |
| Stream → Web Streams       | ✅     | ReadableStream with pull source           |

### Gaps and Potential Additions

Based on this validation, the following additions might be worth considering:

| Gap                        | Potential Addition                         | Priority |
| -------------------------- | ------------------------------------------ | -------- |
| Random file access         | Out of scope (use file API directly)       | N/A      |
| Resumable transfers        | Out of scope (HTTP Range semantics)        | N/A      |
| WebSocket backpressure     | Out of scope (WebSocket API limitation)    | N/A      |
| First-class duplex         | Not needed — `{ readable, writer }` works  | Resolved |
| StartTLS/upgrades          | Platform API concern, not streams          | N/A      |
| Response aggregation       | `Stream.concat()` with mixed string/stream | Low      |
| Native Web Streams interop | `toReadableStream()`, `fromReadable()`     | Medium   |
| Native Node.js interop     | Built-in bridge utilities                  | Medium   |

### Intentionally Omitted: Built-in Timeout

Stream timeout is **intentionally left to user code** due to timing side-channel concerns. Built-in
timeouts would create observable timing behavior that could leak information about data processing.
Users can implement timeouts appropriate to their security context using transforms, AbortSignal,
or promise racing (see "Proxy with timeout" example above).

---

## 11. Migration and Compatibility

A new API would need to coexist with Web Streams for backward compatibility. Possible approaches:

### Option A: New Global Names

Introduce `Stream` as a new global alongside existing `ReadableStream`, `WritableStream`,
`TransformStream`. The new API consolidates all functionality under the single `Stream` class.

### Option B: Static Factory Methods

Add new static methods to existing classes:

```javascript
ReadableStream.generate(async function* () { ... });
ReadableStream.prototype.map(fn);
```

### Option C: Wrapper Library

Provide the new API as a library that wraps Web Streams internally, allowing gradual adoption.

### Interoperability

Regardless of approach, interoperability is essential:

```javascript
// Convert between APIs
const webStream = newStream.toReadableStream();
const newStream = Stream.fromReadable(webStream);
```

---

## 12. API Comparison: New Stream vs Web Streams

This section provides a detailed comparison between the proposed Stream API and the existing
Web Streams API, highlighting the trade-offs, advantages, and disadvantages of each approach.

### High-Level Comparison

| Aspect                  | Web Streams                       | New Stream API                         |
| ----------------------- | --------------------------------- | -------------------------------------- |
| **Global types**        | 3 classes + readers + controllers | 1 class + Writer                       |
| **Data model**          | Any JS value OR bytes             | Bytes only                             |
| **Creation**            | Constructor with config object    | Static factory methods                 |
| **Reading**             | Acquire reader, then read         | Direct `stream.read()`                 |
| **Writing**             | Acquire writer, then write        | Writer returned from factory           |
| **Transforms**          | TransformStream class             | Function or object protocol            |
| **Branching**           | `tee()` → [branch1, branch2]      | `tee()` → branch; original continues   |
| **Backpressure**        | Queuing strategy + desiredSize    | Buffer options + overflow policies     |
| **BYOB**                | Separate reader type              | Option on `read()`                     |
| **Partial consumption** | Manual reader management          | Built-in `take()`, `drop()`, `limit()` |
| **Standards**           | WHATWG standard                   | Non-standard (workerd-specific)        |
| **Browser support**     | All modern browsers               | None (server-side only)                |

### API Surface Area

**Web Streams — 9+ types:**

```
ReadableStream
├── ReadableStreamDefaultReader
├── ReadableStreamBYOBReader
├── ReadableStreamDefaultController
└── ReadableByteStreamController

WritableStream
├── WritableStreamDefaultWriter
└── WritableStreamDefaultController

TransformStream
└── TransformStreamDefaultController
```

**New Stream API — 2 types:**

```
Stream (readable, with static factories)
Writer (writable interface)
```

#### Web Streams Pros

- **Fine-grained control**: Separate reader/writer types allow independent lifecycle management
- **Locking semantics**: Explicit locking prevents concurrent access bugs (though rarely needed)
- **Controller flexibility**: Controllers can be passed to other code for custom enqueueing

#### Web Streams Cons

- **Cognitive overhead**: Developers must understand 9+ types and their relationships
- **Boilerplate**: Simple operations require multiple steps (get reader, read, release)
- **Easy to misuse**: Forgetting to release reader/writer causes resource leaks

#### New Stream API Pros

- **Minimal surface area**: Two types cover all use cases
- **Discoverable**: All functionality on Stream class, easy to explore
- **Less boilerplate**: Direct methods without intermediate objects

#### New Stream API Cons

- **Less granular control**: No separate locking/unlocking ceremony
- **Writer lifecycle tied to creation**: Can't "get a writer" from an existing stream

### Data Model

**Web Streams:**

```javascript
// Value stream — any JS value
const stream = new ReadableStream({
  pull(controller) {
    controller.enqueue({ user: 'alice', score: 42 }); // Objects OK
    controller.enqueue([1, 2, 3]); // Arrays OK
    controller.enqueue('hello'); // Strings OK
  },
});

// Byte stream — ArrayBufferView only
const byteStream = new ReadableStream({
  type: 'bytes',
  pull(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3]));
  },
});
```

**New Stream API:**

```javascript
// Bytes only — strings auto-encoded
const stream = Stream.pull(function* () {
  yield new Uint8Array([1, 2, 3]); // Bytes
  yield 'hello'; // String → UTF-8 encoded to bytes
  // yield { user: 'alice' };  // TypeError! Not bytes
});
```

#### Web Streams Pros

- **Flexibility**: Can stream any JS value (objects, arrays, primitives)
- **No encoding overhead**: Strings passed through without UTF-8 encoding
- **Generic**: Same API works for byte streams and object streams

#### Web Streams Cons

- **Two code paths**: Runtime must handle both value and byte modes
- **Type confusion**: Easy to mix up value/byte streams, causing subtle bugs
- **BYOB complexity**: Only available for byte streams, requires `type: 'bytes'`
- **Size calculation**: Value streams need custom `size()` function in queuing strategy

#### New Stream API Pros

- **Predictable**: Chunks are always `Uint8Array`, no type checking needed
- **Simpler implementation**: Single code path, easier to optimize
- **BYOB always available**: No special stream type needed
- **Clear mental model**: Streams are for bytes; use async iterables for objects

#### New Stream API Cons

- **No object streaming**: Must serialize/deserialize if streaming structured data
- **Encoding overhead**: Strings always UTF-8 encoded (though typically desired)
- **Less flexible**: Can't use streams as generic async queues

### Stream Creation

**Web Streams:**

```javascript
// Readable — constructor with underlying source
const readable = new ReadableStream({
  start(controller) {
    // Called once at creation
  },
  pull(controller) {
    // Called when more data needed
    controller.enqueue(data);
    // controller.close();
    // controller.error(err);
  },
  cancel(reason) {
    // Called on cancellation
  },
});

// Writable — constructor with underlying sink
const writable = new WritableStream({
  start(controller) {},
  write(chunk, controller) {},
  close(controller) {},
  abort(reason) {},
});

// Transform — constructor with transformer
const transform = new TransformStream({
  start(controller) {},
  transform(chunk, controller) {
    controller.enqueue(transformed);
  },
  flush(controller) {},
});
```

**New Stream API:**

```javascript
// Pull-based readable — generator function
const readable = Stream.pull(async function* () {
  yield data;
  // Generator return = close
  // Generator throw = error
});

// Push-based readable — returns [Stream, Writer]
const [stream, writer] = Stream.push();
await writer.write(data);
await writer.close();

// From existing data
const fromData = Stream.from(uint8Array);
const fromString = Stream.from('hello');

// Transform — returns [Stream, Writer]
const [output, input] = Stream.transform((chunk) => transform(chunk));

// Writer with custom sink
const writer = Stream.writer({
  write(chunk) {},
  close() {},
  abort(reason) {},
});
```

#### Web Streams Pros

- **Familiar pattern**: Constructor with options object is common JS pattern
- **Controller access**: Can store controller reference for later use
- **Explicit lifecycle**: `start()`, `pull()`, `cancel()` clearly defined

#### Web Streams Cons

- **Verbose**: Simple streams require lots of boilerplate
- **Indirect control flow**: Controller callbacks invert control
- **Error-prone**: Easy to forget `controller.close()` or misuse `controller.error()`

#### New Stream API Pros

- **Concise**: Generator syntax is natural for data production
- **Direct control flow**: `yield`, `return`, `throw` map naturally to stream operations
- **Factory methods**: Clear intent (`pull` vs `push` vs `from`)
- **Tuple returns**: `[stream, writer]` enables immediate use of both

#### New Stream API Cons

- **Different paradigm**: Developers must learn generator patterns
- **No stored controller**: Can't enqueue from arbitrary code locations (use `push()` instead)
- **Less familiar**: Static factories less common than constructors

### Reading Data

**Web Streams:**

```javascript
// Manual reader management
const reader = stream.getReader();
try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    process(value);
  }
} finally {
  reader.releaseLock();
}

// Async iteration (cleaner, but still acquires reader internally)
for await (const chunk of stream) {
  process(chunk);
}

// BYOB reading (byte streams only)
const byobReader = stream.getReader({ mode: 'byob' });
const { value, done } = await byobReader.read(new Uint8Array(1024));
```

**New Stream API:**

```javascript
// Direct read
const { value, done } = await stream.read();

// With options
const { value, done } = await stream.read({
  buffer: myBuffer, // BYOB
  atLeast: 1024, // Wait for at least 1KB
  max: 65536, // Cap allocation at 64KB
  signal: abortSignal, // Cancellation
});

// Async iteration
for await (const chunk of stream) {
  process(chunk);
}

// Convenience methods
const allBytes = await stream.bytes();
const text = await stream.text();
const buffer = await stream.arrayBuffer();
```

#### Web Streams Pros

- **Explicit locking**: Clear when stream is locked vs available
- **Reader reuse**: Can read multiple times with same reader
- **Separate BYOB type**: Type system enforces BYOB-only operations

#### Web Streams Cons

- **Boilerplate**: Must acquire reader, manage lifecycle, release lock
- **Easy to leak**: Forgetting `releaseLock()` leaves stream locked forever
- **No convenience methods**: Must manually collect bytes, decode text
- **BYOB awkward**: Different reader type, only for byte streams

#### New Stream API Pros

- **Direct access**: `stream.read()` without intermediate objects
- **BYOB as option**: Same method, just pass `buffer` option
- **Convenience methods**: `bytes()`, `text()`, `arrayBuffer()` built-in
- **Batching support**: `atLeast` option for efficient buffered reads

#### New Stream API Cons

- **No explicit locking**: Can't prevent concurrent reads (concurrent reads are queued instead)
- **No reader reuse**: Each `read()` is independent (not a real limitation)

### Writing Data

**Web Streams:**

```javascript
// Must acquire writer
const writer = writable.getWriter();
try {
  await writer.write(chunk1);
  await writer.write(chunk2);
  await writer.close();
} catch (e) {
  await writer.abort(e);
} finally {
  writer.releaseLock();
}

// Backpressure via ready
await writer.ready; // Wait for backpressure to clear
await writer.write(chunk);
```

**New Stream API:**

```javascript
// Writer returned from creation
const [stream, writer] = Stream.push();
await writer.write(chunk1);
await writer.write(chunk2);
await writer.close();

// Or with abort on error
try {
  await writer.write(chunk);
} catch (e) {
  await writer.abort(e);
}

// Vectored write
await writer.writev([chunk1, chunk2, chunk3]);

// Explicit flush
await writer.flush(); // Wait for all prior writes to complete
```

#### Web Streams Pros

- **Separate from stream**: Writer acquired independently, can be passed around
- **Explicit ready signal**: `writer.ready` for manual backpressure handling
- **Lock semantics**: Only one writer at a time enforced by API

#### Web Streams Cons

- **Acquisition ceremony**: Must get writer before writing
- **Lock management**: Forgetting `releaseLock()` is common bug
- **No vectored writes**: Must write chunks one at a time
- **No flush**: No way to wait for writes to complete without closing

#### New Stream API Pros

- **Direct access**: Writer returned from factory, ready to use
- **No lock management**: Writer lifecycle tied to stream creation
- **Vectored writes**: `writev()` for efficient multi-chunk writes
- **Explicit flush**: `flush()` for synchronization without closing

#### New Stream API Cons

- **Tied to creation**: Can't get a new writer for an existing writable
- **No separate ready signal**: Use `desiredSize` or buffer policies instead

### Transform Streams

**Web Streams:**

```javascript
// TransformStream with controller
const transform = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk.toUpperCase());
  },
  flush(controller) {
    controller.enqueue('END');
  },
});

// Usage
const transformed = readable.pipeThrough(transform);

// Accessing writable/readable sides
const { writable, readable } = transform;
```

**New Stream API:**

```javascript
// Simple function (stateless)
const transformed = source.pipeThrough((chunk) => {
  if (chunk === null) return 'END'; // Flush
  return chunk.toUpperCase();
});

// Object with transform method (stateful)
const transformed = source.pipeThrough({
  buffer: '',
  *transform(chunk) {
    if (chunk === null) {
      yield this.buffer; // Flush
      return;
    }
    this.buffer += decode(chunk);
    while (this.buffer.includes('\n')) {
      const line = this.buffer.slice(0, this.buffer.indexOf('\n'));
      this.buffer = this.buffer.slice(this.buffer.indexOf('\n') + 1);
      yield line + '\n';
    }
  },
  abort(reason) {
    // Cleanup on error
  },
});

// Factory for writable transforms
const [output, input] = Stream.transform(transformFn);
```

#### Web Streams Pros

- **Separate readable/writable**: Can access each side independently
- **Controller pattern**: Consistent with ReadableStream/WritableStream
- **Class-based**: Easy to extend and share transform logic

#### Web Streams Cons

- **Verbose**: Simple transforms require lots of boilerplate
- **Controller confusion**: `controller.enqueue()` vs `controller.terminate()` vs return
- **Separate flush**: Easy to forget, separate method from transform
- **No error cleanup**: No `abort()` hook for cleanup on pipeline error

#### New Stream API Pros

- **Concise**: Simple function for simple transforms
- **Generators**: Natural for 1:N transforms (yield multiple outputs)
- **Unified flush**: `null` chunk signals end, no separate method
- **Error cleanup**: `abort(reason)` hook for stateful transforms

#### New Stream API Cons

- **Different pattern**: Functions/generators instead of classes
- **No separate sides**: Can't independently access readable/writable of transform

### Branching (Tee)

**Web Streams:**

```javascript
// tee() returns array of two new streams
const [branch1, branch2] = readable.tee();

// Original stream is now locked/consumed
// Both branches must be consumed to avoid memory leak

// No buffer control — unbounded buffering
```

**New Stream API:**

```javascript
// tee() returns one branch; original continues
const branch = stream.tee();

// Original stream still usable as the "other branch"
await Promise.all([processBranch(branch), processMain(stream)]);

// Buffer control
const branch = stream.tee({
  buffer: {
    max: 1024 * 1024,
    onOverflow: 'drop-oldest', // Or 'error', 'block', 'drop-newest'
  },
});

// Detached branch (no buffer until attached)
const lazyBranch = stream.tee({ detached: true });
// Later...
lazyBranch.attach();
```

#### Web Streams Pros

- **Symmetric**: Both branches are new streams, neither is "special"
- **Familiar pattern**: Array destructuring is common

#### Web Streams Cons

- **Memory danger**: No buffer limits, easy to OOM
- **Both must consume**: Slow consumer blocks fast consumer
- **Original consumed**: Can't continue using original stream

#### New Stream API Pros

- **Buffer control**: Explicit limits and overflow policies
- **Original continues**: `stream` itself is one branch
- **Detached option**: Lazy branching for conditional use cases
- **Prevents OOM**: `onOverflow: 'error'` fails fast on abandoned branches

#### New Stream API Cons

- **Asymmetric**: Original and branch have different "feel"
- **Different mental model**: Must understand cursor-based semantics

### Partial Consumption

**Web Streams:**

```javascript
// Read first N bytes — awkward
const reader = stream.getReader();
const chunks = [];
let bytesRead = 0;
try {
  while (bytesRead < n) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytesRead += value.byteLength;
  }
} finally {
  reader.releaseLock();
}
// Stream is now in unknown state — remaining data buffered in reader's queue?

// Skip first N bytes — no built-in way
// Must read and discard manually

// Limit total consumption — no built-in way
// Must track bytes and cancel manually
```

**New Stream API:**

```javascript
// Read first N bytes — stream continues after
const first1KB = await stream.take(1024).bytes();
const rest = await stream.bytes(); // Continues from byte 1024

// Skip first N bytes
stream.drop(1000);
const afterSkip = await stream.bytes();

// Limit total consumption (cancels source after N bytes)
const capped = await stream.limit(1024 * 1024).bytes();

// Sequential partial reads
const header = await stream.take(16).bytes();
const bodyLength = parseHeader(header);
const body = await stream.take(bodyLength).bytes();
const trailer = await stream.bytes();
```

#### Web Streams Pros

- **Explicit control**: Developer manages exactly what happens
- **No hidden state**: Everything is manual, nothing implicit

#### Web Streams Cons

- **No built-in support**: Must implement partial consumption manually
- **Error-prone**: Easy to leak reader, lose data, or corrupt state
- **Verbose**: Simple operations require lots of code

#### New Stream API Pros

- **Built-in methods**: `take()`, `drop()`, `limit()` for common patterns
- **Clean semantics**: Stream continues after partial consumption
- **Composable**: Can chain partial operations

#### New Stream API Cons

- **Hidden complexity**: Cursor management invisible to user
- **Different from Web Streams**: Must learn new patterns

### Backpressure

**Web Streams:**

```javascript
// Queuing strategy controls buffer size
const stream = new ReadableStream(
  {
    pull(controller) {
      // Check backpressure
      if (controller.desiredSize <= 0) {
        // Should slow down
      }
      controller.enqueue(data);
    },
  },
  new ByteLengthQueuingStrategy({ highWaterMark: 65536 })
);

// Writer backpressure
const writer = writable.getWriter();
if (writer.desiredSize <= 0) {
  await writer.ready; // Wait for backpressure to clear
}
await writer.write(chunk);
```

**New Stream API:**

```javascript
// Buffer options on creation
const [stream, writer] = Stream.push({
  buffer: {
    max: 65536, // Soft limit (backpressure threshold)
    hardMax: 1024 * 1024, // Hard limit (for 'block' policy)
    onOverflow: 'block', // 'error', 'block', 'drop-oldest', 'drop-newest'
  },
});

// Writer backpressure via desiredSize
if (writer.desiredSize <= 0) {
  // Buffer is full
}

// Or let buffer policy handle it
await writer.write(chunk); // Blocks if onOverflow: 'block' and buffer full
```

#### Web Streams Pros

- **Standard queuing strategies**: `CountQueuingStrategy`, `ByteLengthQueuingStrategy`
- **Explicit ready signal**: `writer.ready` promise for waiting
- **Customizable size**: Can provide custom `size()` function

#### Web Streams Cons

- **Complex configuration**: Queuing strategy is separate object
- **No overflow protection**: Buffer can grow unbounded
- **Manual handling**: Developer must check `desiredSize` and wait on `ready`

#### New Stream API Pros

- **Overflow policies**: Built-in protection against unbounded growth
- **Simple configuration**: Options object instead of strategy classes
- **Automatic handling**: `'block'` policy handles backpressure automatically

#### New Stream API Cons

- **Less flexible**: No custom size function (bytes only, so not needed)
- **No ready promise**: Must use `desiredSize` or rely on policies

### Error Handling

**Web Streams:**

```javascript
// Errors via controller
const stream = new ReadableStream({
  pull(controller) {
    if (somethingWrong) {
      controller.error(new Error('failed'));
    }
  },
});

// Catching errors
try {
  for await (const chunk of stream) {
    process(chunk);
  }
} catch (e) {
  // Stream errored
}

// Pipeline errors — manual propagation
readable.pipeTo(writable).catch((e) => {
  // Error from either side
});
```

**New Stream API:**

```javascript
// Errors via throw in generator
const stream = Stream.pull(async function* () {
  if (somethingWrong) {
    throw new Error('failed');
  }
  yield data;
});

// Errors via writer
await writer.abort(new Error('failed'));

// Transform error cleanup
source.pipeThrough({
  transform(chunk) {
    return process(chunk);
  },
  abort(reason) {
    // Called when pipeline errors
    cleanup();
  },
});

// Pipeline errors — bidirectional propagation
// Errors automatically flow both upstream and downstream
await stream.pipeThrough(transform).pipeTo(writer);
// If any stage errors, all stages see the error
```

#### Web Streams Pros

- **Explicit**: `controller.error()` clearly signals error
- **Standard patterns**: try/catch, `.catch()` for error handling

#### Web Streams Cons

- **Manual propagation**: Must wire up error handling for pipelines
- **No cleanup hook**: Transforms can't clean up on pipeline error
- **Asymmetric**: Different error patterns for readable vs writable

#### New Stream API Pros

- **Natural error flow**: `throw` in generator, `abort()` on writer
- **Bidirectional propagation**: Errors flow through pipelines automatically
- **Cleanup hooks**: `abort(reason)` on transforms for error handling

#### New Stream API Cons

- **Less explicit**: Automatic propagation may surprise developers
- **Generator errors**: Stack traces may be less clear

### Pipeline Construction

**Web Streams:**

```javascript
// pipeThrough for transforms
const result = await source
  .pipeThrough(transform1)
  .pipeThrough(transform2)
  .pipeTo(dest);

// No single pipeline construction
// Each pipeThrough creates intermediate stream
```

**New Stream API:**

```javascript
// Same chaining
const result = await source
  .pipeThrough(transform1)
  .pipeThrough(transform2)
  .pipeTo(dest);

// Or single pipeline call (allows optimization)
await Stream.pipeline(source, transform1, transform2, dest, {
  signal: abortSignal,
  limit: 1024 * 1024,
});
```

#### Web Streams Pros

- **Standard pattern**: Chaining is familiar

#### Web Streams Cons

- **No pipeline()**: Can't construct entire pipeline at once
- **No optimization opportunity**: Each stage is independent

#### New Stream API Pros

- **pipeline() method**: Whole-pipeline construction enables optimization
- **Pipeline options**: Signal, limit apply to entire pipeline

#### New Stream API Cons

- **Different from spec**: `pipeline()` is non-standard

### Summary: When to Use Each

| Scenario                                   | Recommended API | Why                                         |
| ------------------------------------------ | --------------- | ------------------------------------------- |
| **Browser code**                           | Web Streams     | Only option; standard API                   |
| **Cross-platform library**                 | Web Streams     | Maximum compatibility                       |
| **Server-side (workerd)**                  | New Stream API  | Better ergonomics, performance              |
| **Streaming structured data (objects)**    | Web Streams     | Supports any JS value                       |
| **Streaming bytes (files, HTTP)**          | New Stream API  | Optimized for bytes, BYOB always available  |
| **Complex transform pipelines**            | New Stream API  | Generator transforms, pipeline optimization |
| **Simple fetch/response handling**         | Either          | Similar ergonomics for basic use            |
| **Partial consumption (take/drop)**        | New Stream API  | Built-in support                            |
| **Branching with buffer control**          | New Stream API  | Bounded tee with overflow policies          |
| **Interop with existing Web Streams code** | Web Streams     | Use conversion methods if needed            |

### Trade-off Summary

**Choose Web Streams when:**

- ✅ You need browser compatibility
- ✅ You're building a cross-platform library
- ✅ You need to stream non-byte data (objects, arrays)
- ✅ You need to interop with existing Web Streams code
- ✅ You want to follow web standards strictly

**Choose New Stream API when:**

- ✅ You're building server-side code in workerd
- ✅ You're working with byte streams (files, HTTP, network)
- ✅ You want simpler, more ergonomic code
- ✅ You need partial consumption (take/drop/limit)
- ✅ You need bounded branching with overflow protection
- ✅ You want better performance (optimization opportunities)
- ✅ You're building complex transform pipelines

**The New Stream API sacrifices:**

- ❌ Browser compatibility
- ❌ Standards compliance
- ❌ Object streaming capability
- ❌ Familiarity for Web Streams users

**In exchange for:**

- ✅ Simpler mental model (2 types vs 9+)
- ✅ Better ergonomics (direct methods, generators)
- ✅ Built-in safety (buffer limits, overflow policies)
- ✅ Better performance (optimization opportunities)
- ✅ Partial consumption primitives

---

## 13. Potential Pitfalls of the New API

While the new API addresses many Web Streams issues, it introduces its own potential pitfalls
and trade-offs. This section provides an honest examination of problems developers might
encounter.

### 1. New Mental Model Required

**The pitfall:** Developers familiar with Web Streams must learn a fundamentally different
mental model. The new API's concepts (cursors, branches, generators as sources) don't map
directly to Web Streams concepts.

**Specific confusions:**

```javascript
// Web Streams: tee() returns two new streams
const [a, b] = stream.tee();

// New API: tee() returns ONE new stream; original is the other "branch"
const branch = stream.tee();
// Now use 'stream' and 'branch' — which is which?
```

```javascript
// Web Streams: pipeThrough consumes the source
const result = source.pipeThrough(transform);
// source is now locked/consumed

// New API: pipeThrough creates a BRANCH
const result = source.pipeThrough(transform);
// source is still usable! This might surprise Web Streams developers.
```

**Mitigation:** Clear documentation, migration guides, and linter rules to catch common
mistakes during transition.

**Severity:** Medium — One-time learning cost, but could cause bugs during migration.

---

### 2. Generator Learning Curve

**The pitfall:** Generators (`function*`, `async function*`) are powerful but not universally
understood. Developers unfamiliar with generators may struggle with `Stream.pull()`.

**Specific confusions:**

```javascript
// Common mistake: forgetting the * makes it a regular function
const stream = Stream.pull(async function () {  // Missing *!
  yield data;  // SyntaxError: yield outside generator
});

// Common mistake: returning instead of yielding
const stream = Stream.pull(async function* () {
  return data;  // Stream closes immediately with no data!
  // Should be: yield data;
});

// Common mistake: not understanding yield suspends execution
const stream = Stream.pull(async function* () {
  console.log('Before yield');
  yield chunk1;
  console.log('After yield');  // Only runs when consumer reads again!
  yield chunk2;
});
```

**Mitigation:** Good error messages when common mistakes are detected; examples in docs
emphasize generator syntax; provide `Stream.from()` for simple cases.

**Severity:** Medium — Generators are standard JS, but less familiar to many developers.

---

### 3. Bytes-Only Limitation

**The pitfall:** The API only supports byte streams. Developers wanting to stream objects
must serialize/deserialize manually, adding boilerplate and potential bugs.

**Impact:**

```javascript
// Web Streams: Can stream objects directly
const objectStream = new ReadableStream({
  pull(controller) {
    controller.enqueue({ user: 'alice', score: 42 });
  },
});

// New API: Must serialize
const stream = Stream.pull(async function* () {
  yield JSON.stringify({ user: 'alice', score: 42 });
});

// Consumer must parse
for await (const chunk of stream) {
  const text = new TextDecoder().decode(chunk);
  const obj = JSON.parse(text); // Extra step, potential errors
}
```

**When this hurts:**

- Internal pipelines where objects would be more natural
- Streaming database results that will be processed as objects
- Event streams where each event is a structured object

**Workaround:** Use async generators directly for object streaming (not `Stream`):

```javascript
// For object streaming, just use async generators
async function* streamObjects() {
  for await (const row of database.query()) {
    yield row; // Objects, not bytes
  }
}

for await (const obj of streamObjects()) {
  process(obj);
}
```

**Mitigation:** Document that `Stream` is for bytes/I/O; use async generators for objects.

**Severity:** Medium — Forces a pattern change for some use cases, but async generators
work well for object streaming.

---

### 4. Buffer Detachment Surprises

**The pitfall:** Buffer detachment (for zero-copy) is still confusing, even with better
documentation. Developers will still accidentally use detached buffers.

```javascript
const data = new Uint8Array([1, 2, 3, 4, 5]);
await writer.write(data);
console.log(data[0]); // undefined! Buffer is detached.

// BYOB read has the same issue
const buffer = new Uint8Array(1024);
const { value } = await stream.read({ buffer });
console.log(buffer.byteLength); // 0! Must use 'value' instead.
```

**Why it persists:** This is fundamental to zero-copy semantics. Any API that avoids copying
must transfer ownership.

**Mitigation:** TypeScript types could potentially flag this; runtime could throw clear
error on detached buffer access; documentation emphasizes this heavily.

**Severity:** Medium — Same issue as Web Streams BYOB, but affects more operations (write, writev).

---

### 5. Silent Data Loss with Overflow Policies

**The pitfall:** `onOverflow: 'drop-oldest'` and `'drop-newest'` silently discard data.
Developers might not realize data is being lost.

```javascript
const [stream, writer] = Stream.push({
  buffer: { max: 1024, onOverflow: 'drop-oldest' },
});

// If consumer is slow, data is silently dropped
for (let i = 0; i < 10000; i++) {
  await writer.write(new Uint8Array(100));
  // Some of these writes may lose data with no indication!
}
```

**When this is dangerous:**

- Financial transactions
- Audit logs
- Any data that must not be lost

**Mitigation:**

- Default to `'error'` (fail-fast)
- `'drop-*'` policies should be opt-in with clear naming
- Consider adding a callback or counter for dropped bytes

**Potential addition:**

```javascript
const [stream, writer] = Stream.push({
  buffer: {
    max: 1024,
    onOverflow: 'drop-oldest',
    onDrop: (bytesDropped) => {
      metrics.increment('stream.bytes_dropped', bytesDropped);
    },
  },
});
```

**Severity:** High for certain use cases — Silent data loss is dangerous. The API should
make lossy modes very explicit.

---

### 6. `take()` vs `limit()` Confusion

**The pitfall:** Both `take(n)` and `limit(n)` restrict bytes, but with different semantics.
Easy to use the wrong one.

```javascript
// take(n): Read n bytes, parent stream CONTINUES after
const first100 = await stream.take(100).bytes();
const rest = await stream.bytes(); // Continues from byte 100

// limit(n): Read up to n bytes, parent stream is CANCELLED after
const capped = await stream.limit(100).bytes();
// stream.bytes() would return empty — stream was cancelled!
```

**Common mistake:**

```javascript
// Developer wants to cap response size for safety
const body = await response.body.take(1024 * 1024).bytes(); // WRONG!
// take() doesn't cancel — if response is 10GB, it's still downloading!

// Correct:
const body = await response.body.limit(1024 * 1024).bytes();
// limit() cancels after 1MB — stops the download
```

**Mitigation:** Clear naming? (`take` vs `limitAndCancel`?), documentation, linter rules.

**Severity:** Medium — Semantic difference is subtle but important.

---

### 7. `pipeThrough` Branching Semantics

**The pitfall:** Unlike Web Streams, `pipeThrough()` creates a branch — the parent stream
continues independently. This could cause unexpected memory growth.

```javascript
// Developer thinks this consumes the stream:
const transformed = source.pipeThrough(myTransform);
await transformed.pipeTo(dest);

// But source is still "alive" — if it's a tee branch, the buffer keeps growing!
// Must explicitly consume or cancel source if not needed.
```

**When this causes problems:**

- Forgetting that the source stream is still buffering data
- Memory growth when parent stream isn't consumed
- Confusion about which stream is "primary"

**Mitigation:** Document clearly; consider making `pipeTo()` consume the source (unlike
`pipeThrough()`); warning in debug mode if parent stream isn't consumed.

**Severity:** Medium — Different from Web Streams behavior; could cause memory issues.

---

### 8. Implicit String Encoding

**The pitfall:** Strings are implicitly encoded to bytes (UTF-8 by default). This could
cause subtle bugs with encoding assumptions.

```javascript
await writer.write('hello'); // Implicitly UTF-8 encoded

// But what if the stream expects Latin-1?
// The encoding is set at creation time, not at write time
const [stream, writer] = Stream.push({ encoding: 'latin1' });
await writer.write('café'); // Now Latin-1 encoded

// Can't change encoding mid-stream — what if you need to?
```

**Specific issues:**

- Can't mix encodings in one stream
- Encoding is invisible at the write site
- BOM handling unclear

**Mitigation:** Make encoding visible; consider requiring explicit encode step for strings;
warn in docs about encoding assumptions.

**Severity:** Low-Medium — Usually UTF-8 is correct, but edge cases exist.

---

### 9. Error Handling in Generator Cleanup

**The pitfall:** If a generator's cleanup code (after `return`/`break`) throws, it's unclear
how errors propagate.

```javascript
const stream = Stream.pull(async function* () {
  const conn = await database.connect();
  try {
    for await (const row of conn.query()) {
      yield serialize(row);
    }
  } finally {
    await conn.close(); // What if this throws?
  }
});

// If consumer breaks early:
for await (const chunk of stream) {
  if (done) break; // Triggers generator cleanup
  // If conn.close() throws, where does that error go?
}
```

**Questions:**

- Does cleanup error supersede the break?
- Is the error surfaced to the consumer?
- What about `stream.cancel()` — does it await generator cleanup?

**Mitigation:** Define clear semantics for generator cleanup errors; consider swallowing
cleanup errors (like destructors) or providing an error callback.

**Severity:** Medium — Edge case, but could cause confusing behavior.

---

### 10. Detached Branch Timing

**The pitfall:** Detached branches auto-attach on first read, but the timing could cause
race conditions or missed data.

```javascript
const branch = stream.tee({ detached: true });

// Main stream starts flowing...
processMain(stream);

// Later, decide to attach branch
await delay(1000);
branch.attach(); // What data is available? Depends on timing!

// Or: auto-attach on read
const data = await branch.bytes(); // Attaches here — but missed 1 second of data
```

**Specific issues:**

- Data between detach and attach is not available to the branch
- Auto-attach timing is implicit, not explicit
- Hard to reason about what data the branch will see

**Mitigation:** Document that detached branches miss data before attachment; consider
requiring explicit `attach()` call with no auto-attach.

**Severity:** Medium — The feature is intentionally lossy, but that might not be obvious.

---

### 11. No Ready Signal for Manual Backpressure

**The pitfall:** Web Streams has `writer.ready` for explicit backpressure handling. The new
API relies on `desiredSize` and automatic policies, which may not fit all patterns.

```javascript
// Web Streams: Explicit wait for backpressure
await writer.ready;
await writer.write(chunk);

// New API: Check desiredSize manually
if (writer.desiredSize <= 0) {
  // ... what do we wait on?
}
await writer.write(chunk); // Blocks if onOverflow: 'block'
```

**When this matters:**

- Custom backpressure logic that doesn't fit `onOverflow` policies
- Integrating with external systems that need explicit signals
- Fine-grained control over when to apply backpressure

**Mitigation:** Add a `writer.ready` promise that resolves when `desiredSize > 0`?

**Severity:** Low-Medium — Most cases handled by policies, but some advanced patterns harder.

---

### 12. Ecosystem Fragmentation

**The pitfall:** A non-standard API fragments the JavaScript streams ecosystem. Code written
for the new API won't work in browsers or other runtimes.

**Impact:**

- Libraries must choose which API to support (or both)
- Code portability reduced
- More bridging code needed
- Community knowledge split

**Example friction:**

```javascript
// Library author must decide:
export function processStream(stream) {
  // Is 'stream' a Web Streams ReadableStream or new Stream?
  // Must check and handle both, or pick one and require conversion
}
```

**Mitigation:**

- Excellent Web Streams interop (`toReadableStream()`, `fromReadable()`)
- Clear guidance on when to use which
- Potentially propose improvements to Web Streams spec based on lessons learned

**Severity:** Medium-High — Real ecosystem cost, though limited to server-side.

---

### 13. Transform Function vs Generator Ambiguity

**The pitfall:** Transforms can be functions OR generator functions, with different semantics.
The difference might not be obvious.

```javascript
// Function: return value is the output
source.pipeThrough((chunk) => process(chunk));

// Generator: yield values are the outputs
source.pipeThrough(function* (chunk) {
  yield part1;
  yield part2;
});

// What about async function vs async generator?
source.pipeThrough(async (chunk) => process(chunk)); // Returns promise of output
source.pipeThrough(async function* (chunk) {
  yield x;
}); // Yields async

// Easy to confuse which to use
```

**Specific confusion:**

```javascript
// Want to emit multiple outputs — which is correct?
source.pipeThrough((chunk) => [part1, part2]); // Returns array (ONE output)
source.pipeThrough(function* (chunk) {
  yield part1;
  yield part2;
}); // Correct: TWO outputs
```

**Mitigation:** Clear documentation; consider making the distinction more explicit in the API.

**Severity:** Low-Medium — Learnable, but could cause bugs initially.

---

### 14. Sync Generator Event Loop Blocking

**The pitfall:** Sync generators are processed without yielding to the event loop. A long-
running sync generator blocks everything.

```javascript
// This blocks the event loop until all data is processed
const stream = Stream.pull(function* () {
  for (let i = 0; i < 1_000_000; i++) {
    yield computeExpensiveData(i); // No await = no event loop yield
  }
});
```

**When this happens:**

- Large in-memory datasets processed synchronously
- CPU-intensive per-chunk computation
- Accidentally using sync generator for I/O

**Mitigation:** Document when to use sync vs async generators; consider chunking sync
generators internally (process N items, then yield to event loop).

**Severity:** Medium — Same issue as any sync code, but generators might obscure it.

---

### 15. `null` as Flush Signal

**The pitfall:** Transforms receive `null` to signal end-of-input. This overloads `null`
with special meaning.

```javascript
source.pipeThrough((chunk) => {
  if (chunk === null) {
    // Flush — emit any buffered data
    return buffered;
  }
  // Process chunk
});

// What if the API evolves to support options on flush?
// null can't carry additional information
```

**Issues:**

- `null` can't carry metadata (like "cancelled" vs "completed")
- Sentinel value pattern is sometimes considered an antipattern
- TypeScript types are slightly awkward (`Uint8Array | null`)

**Alternative considered:** Separate `flush()` method on transform object. Rejected for
simplicity, but has trade-offs.

**Severity:** Low — Works fine in practice; minor TypeScript ergonomics issue.

---

### 16. Writer Lifetime Constraints

**The pitfall:** Writers are created with `Stream.push()` or `Stream.transform()` and can't
be "re-acquired" for an existing stream.

```javascript
const [stream, writer] = Stream.push();

// If writer is closed or errored, can't get a new one
await writer.close();

// No way to get a fresh writer for 'stream'
// In Web Streams: writable.getWriter() can be called again after releaseLock()
```

**When this matters:**

- Passing writer to different parts of code with independent lifecycles
- Error recovery where you want to "reset" the writer
- Patterns that rely on acquiring/releasing writers

**Mitigation:** This is intentional (simpler model), but document the constraint; recommend
creating new push streams if needed.

**Severity:** Low — Different pattern, not necessarily worse.

---

### 17. Cursor Memory Not Obvious

**The pitfall:** The cursor-based model keeps data in memory until ALL cursors pass it.
This isn't visible in the API.

```javascript
const branch = stream.tee();

// Even if we fully consume 'stream':
await stream.bytes();

// The buffer isn't freed until 'branch' also consumes it
// If we forget about 'branch', memory stays allocated
```

**Invisible memory pressure:**

```javascript
// Multiple take() calls create cursors
const a = stream.take(100);
const b = stream.take(200);
const c = stream.take(300);

// All data up to byte 300 stays buffered until a, b, c are consumed
// Not obvious from looking at the code
```

**Mitigation:** Documentation; debug mode that warns about unconsumed cursors; explicit
cursor count on stream for debugging.

**Severity:** Medium — Memory behavior is hidden; could cause unexpected memory growth.

---

### Summary: Pitfall Severity Matrix

| Pitfall                         | Severity   | Mitigation Difficulty      |
| ------------------------------- | ---------- | -------------------------- |
| New mental model                | Medium     | Low (docs)                 |
| Generator learning curve        | Medium     | Low (docs/examples)        |
| Bytes-only limitation           | Medium     | N/A (design choice)        |
| Buffer detachment surprises     | Medium     | Medium (types/runtime)     |
| Silent data loss (overflow)     | **High**   | Medium (callbacks)         |
| `take()` vs `limit()` confusion | Medium     | Low (naming/docs)          |
| `pipeThrough` branching         | Medium     | Low (docs/warnings)        |
| Implicit string encoding        | Low-Medium | Low (docs)                 |
| Generator cleanup errors        | Medium     | Medium (define semantics)  |
| Detached branch timing          | Medium     | Low (docs/explicit attach) |
| No ready signal                 | Low-Medium | Low (add if needed)        |
| Ecosystem fragmentation         | **High**   | Medium (interop)           |
| Transform function ambiguity    | Low-Medium | Low (docs)                 |
| Sync generator blocking         | Medium     | Low (docs/chunking)        |
| `null` as flush signal          | Low        | N/A (acceptable)           |
| Writer lifetime constraints     | Low        | N/A (design choice)        |
| Cursor memory not obvious       | Medium     | Medium (debugging)         |

### Recommendations

Based on this analysis, the following changes should be considered:

1. **Add `onDrop` callback** for `'drop-oldest'` and `'drop-newest'` policies to surface
   data loss.

2. **Consider renaming `take()` and `limit()`** to make the difference clearer
   (e.g., `take()` vs `limitAndCancel()` or `take()` vs `cap()`).

3. **Add `writer.ready` promise** for manual backpressure patterns.

4. **Document cursor/memory behavior** explicitly with examples of memory implications.

5. **Require explicit `attach()`** for detached branches instead of auto-attach.

6. **Add debug mode** that warns about:
   - Unconsumed branches/cursors
   - Detached buffers being accessed
   - Sync generators running too long

7. **Excellent interop utilities** to minimize ecosystem fragmentation cost.

8. **Clear migration guide** from Web Streams with common pitfall warnings.

---

## 14. Design Validation: Addressing Identified Issues

This section validates that the proposed API actually addresses the issues identified earlier
in this document. We systematically examine each criticism, antipattern, case study,
implementation challenge, and design principle to verify the new design provides solutions.

### Addressing Criticisms of the Current Spec

The following table maps each criticism from Section 2 to how the new API addresses it:

| Criticism                        | Status | How New API Addresses It                                       |
| -------------------------------- | ------ | -------------------------------------------------------------- |
| **Spec complexity (1200 pages)** | ✅     | 2 types vs 9+; simpler state machines; no controller layer     |
| **Controller API awkwardness**   | ✅     | No controllers; generators/callbacks for production            |
| **BYOB complexity**              | ✅     | BYOB is just an option on `read()`, not separate reader type   |
| **Queuing strategy confusion**   | ✅     | Simple `buffer` options with `max`, `onOverflow` policies      |
| **Lack of convenience methods**  | ✅     | `bytes()`, `text()`, `arrayBuffer()`, `take()`, `drop()`, etc. |
| **Tee memory issues**            | ✅     | Bounded buffers with `onOverflow` policies; detached branches  |
| **Reader/writer lock ceremony**  | ✅     | Direct `stream.read()`; Writer from factory, no lock release   |
| **Value vs byte dichotomy**      | ✅     | Bytes-only; single code path; strings auto-encoded             |
| **No partial consumption**       | ✅     | Built-in `take()`, `drop()`, `limit()`                         |
| **Error propagation complexity** | ✅     | Automatic bidirectional propagation; `abort()` cleanup hook    |

#### Detailed Analysis

**Spec complexity:** The new API reduces surface area from 9+ types to 2 (`Stream` + `Writer`).
There are no internal controllers, no separate reader types, and no queuing strategy classes.
The entire API can be understood by reading the `Stream` interface — everything is discoverable
from there.

```javascript
// Web Streams: Must understand 5+ types to read data
const reader = stream.getReader(); // What's a reader?
const { value, done } = await reader.read();
reader.releaseLock(); // What happens if I forget?

// New API: One method on Stream
const { value, done } = await stream.read();
```

**Controller API:** The new API eliminates controllers entirely. Data production is handled by:

- Generators (`Stream.pull()`) — natural `yield`/`return`/`throw` semantics
- Writers (`Stream.push()`) — explicit `write()`/`close()`/`abort()` methods

```javascript
// Web Streams: Indirect control via controller
new ReadableStream({
  pull(controller) {
    controller.enqueue(data);
    if (done) controller.close();
    if (error) controller.error(err);
  },
});

// New API: Direct control via generator
Stream.pull(async function* () {
  yield data; // enqueue
  return; // close
  throw err; // error
});
```

**BYOB complexity:** In Web Streams, BYOB requires a separate reader type, only works with
byte streams (must specify `type: 'bytes'`), and has complex semantics around `respond()` and
`respondWithNewView()`. The new API makes BYOB just an option:

```javascript
// Web Streams: Separate reader type, complex setup
const stream = new ReadableStream({
  type: 'bytes', // Must specify
  pull(controller) {
    const view = controller.byobRequest.view;
    // Fill view...
    controller.byobRequest.respond(bytesWritten);
  },
});
const reader = stream.getReader({ mode: 'byob' }); // Different reader!
const { value } = await reader.read(new Uint8Array(1024));

// New API: Just an option on read()
const { value } = await stream.read({ buffer: new Uint8Array(1024) });
```

**Queuing strategy:** The new API replaces `CountQueuingStrategy`, `ByteLengthQueuingStrategy`,
and custom `size()` functions with a simple options object:

```javascript
// Web Streams: Separate strategy object, confusing size semantics
new ReadableStream(
  source,
  new ByteLengthQueuingStrategy({ highWaterMark: 65536 })
);
new ReadableStream(source, {
  highWaterMark: 10,
  size: (chunk) => chunk.length,
}); // What units?

// New API: Simple buffer options
Stream.push({ buffer: { max: 65536, onOverflow: 'block' } });
```

**Convenience methods:** The new API provides commonly-needed operations directly:

```javascript
// Web Streams: Manual collection
const chunks = [];
for await (const chunk of stream) chunks.push(chunk);
const all = concatenate(chunks);

// New API: Built-in
const all = await stream.bytes();
const text = await stream.text();
const buffer = await stream.arrayBuffer();
```

**Tee memory issues:** Web Streams `tee()` has unbounded buffering — if one branch is slow,
memory grows without limit. The new API provides explicit control:

```javascript
// Web Streams: Unbounded, can OOM
const [a, b] = stream.tee(); // If b is slow, memory grows forever

// New API: Bounded with policies
const branch = stream.tee({
  buffer: { max: 1024 * 1024, onOverflow: 'drop-oldest' }, // Bounded!
});
```

---

### Addressing Pathological Antipatterns

The following table maps each antipattern from Section 3 to how the new API prevents or
mitigates it:

| #   | Antipattern                         | Status | How New API Addresses It                                    |
| --- | ----------------------------------- | ------ | ----------------------------------------------------------- |
| 1   | Forgetting to release reader/writer | ✅     | No locks to release; direct `read()`; `await using` support |
| 2   | Unbounded tee buffering             | ✅     | Mandatory buffer config; `onOverflow` policies              |
| 3   | Controller reference retention      | ✅     | No controllers; generators naturally scope data production  |
| 4   | Mixing push and pull semantics      | ✅     | Explicit `Stream.pull()` vs `Stream.push()` separation      |
| 5   | Ignoring backpressure signals       | ✅     | `onOverflow` policies handle automatically; `'block'` waits |
| 6   | Improper error propagation          | ✅     | Automatic bidirectional propagation; `abort()` hooks        |
| 7   | Double-reading a stream             | ⚠️     | Still possible; `tee()` is the solution (same as before)    |
| 8   | Incorrect BYOB usage                | ✅     | Simpler model; buffer detachment semantics are explicit     |
| 9   | Transform controller confusion      | ✅     | No controllers; return values / generators for output       |
| 10  | Memory leaks from abandoned ops     | ✅     | `onOverflow: 'error'` surfaces abandoned branches           |
| 11  | Racing reads incorrectly            | ✅     | Single `read()` method; no separate reader state to corrupt |
| 12  | Incorrect tee for fan-out           | ✅     | Multiple `tee()` calls; bounded buffers prevent issues      |

#### Detailed Analysis

**Antipattern 1: Forgetting to release reader/writer locks**

```javascript
// Web Streams: Easy to forget releaseLock()
async function readSome(stream) {
  const reader = stream.getReader();
  const { value } = await reader.read();
  // Forgot reader.releaseLock() — stream is permanently locked!
  return value;
}

// New API: No locks to release
async function readSome(stream) {
  const { value } = await stream.read();
  return value; // No cleanup needed
}

// New API: Explicit Resource Management for Writers
async function writeSome(writer) {
  await using w = writer; // Automatically closes on exit
  await w.write(data);
} // w.close() called automatically
```

**Antipattern 2: Unbounded tee buffering**

```javascript
// Web Streams: Silent memory bomb
const [forLogging, forProcessing] = stream.tee();
logAsync(forLogging); // If slow, memory grows forever
process(forProcessing);

// New API: Explicit bounds
const forLogging = stream.tee({
  buffer: { max: 1024 * 1024, onOverflow: 'drop-oldest' },
});
logAsync(forLogging); // Bounded; drops old data if slow
process(stream); // Original stream continues
```

**Antipattern 3: Controller reference retention**

```javascript
// Web Streams: Controller can be stored, used after stream should be done
let savedController;
new ReadableStream({
  start(controller) {
    savedController = controller;
  },
});
// Later: savedController.enqueue(data);  // Zombie stream!

// New API: No controllers to retain
// Generators naturally end when function returns
// Writers are tied to stream lifecycle
```

**Antipattern 4: Mixing push and pull semantics**

```javascript
// Web Streams: Confusing hybrid
new ReadableStream({
  start(controller) {
    // Push in start...
    controller.enqueue(initialData);
  },
  pull(controller) {
    // Pull here...
    controller.enqueue(nextData);
  },
}); // Which model is this? Confusing.

// New API: Explicit choice
Stream.pull(async function* () {
  /* pull model */
});
Stream.push(); // [stream, writer] — push model

// Can't mix them — the API guides correct usage
```

**Antipattern 5: Ignoring backpressure signals**

```javascript
// Web Streams: Manual, easy to forget
const writer = writable.getWriter();
for (const chunk of data) {
  await writer.write(chunk); // Should check desiredSize or ready!
}

// New API: Automatic with policies
const [stream, writer] = Stream.push({
  buffer: { max: 65536, onOverflow: 'block' },
});
for (const chunk of data) {
  await writer.write(chunk); // Automatically blocks when buffer full
}
```

**Antipattern 6: Improper error propagation**

```javascript
// Web Streams: Must manually wire up error handling
readable.pipeTo(writable).catch(handleError);
// But what about transforms in between? What if source errors?

// New API: Automatic bidirectional propagation
await stream.pipeThrough(transform).pipeTo(writer);
// Errors propagate both ways automatically
// Transform's abort() called for cleanup

// Transform with cleanup
source.pipeThrough({
  transform(chunk) {
    return process(chunk);
  },
  abort(reason) {
    // Called on ANY pipeline error — can clean up resources
    connection.rollback();
  },
});
```

**Antipattern 7: Double-reading a stream**

```javascript
// Both APIs: Can't read same stream twice
const data1 = await stream.bytes();
const data2 = await stream.bytes(); // Error or empty!

// Solution is the same: use tee()
const branch = stream.tee();
const data1 = await branch.bytes();
const data2 = await stream.bytes();
```

This antipattern is **not fully addressed** — it's inherent to stream semantics. However,
the new API makes `tee()` more ergonomic (returns one branch, original continues) and safer
(bounded buffers).

**Antipattern 8: Incorrect BYOB usage**

```javascript
// Web Streams: Complex, error-prone
const reader = stream.getReader({ mode: 'byob' });
let buffer = new Uint8Array(1024);
const { value, done } = await reader.read(buffer);
// buffer is now detached! Must use value for next read.
buffer = value; // Easy to forget

// New API: Same semantics, but clearer documentation and simpler path
const { value, done } = await stream.read({ buffer: myBuffer });
// myBuffer is detached, value is the filled view
// Documentation emphasizes this clearly
```

The semantics are similar, but the new API's simpler overall model means developers
have fewer concepts to juggle, making BYOB usage less error-prone.

**Antipattern 9: Transform controller confusion**

```javascript
// Web Streams: Three ways to output, unclear which to use
new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(result); // Option 1
    controller.enqueue(result2); // Can call multiple times
    // Or just return? No, that doesn't work.
  },
  flush(controller) {
    // Different method for end-of-stream
    controller.enqueue(final);
    controller.terminate(); // Or close()? What's the difference?
  },
});

// New API: Natural return/yield semantics
source.pipeThrough((chunk) => {
  if (chunk === null) return finalData; // Flush
  return transformed; // Single output
});

// Or generator for multiple outputs
source.pipeThrough(function* (chunk) {
  if (chunk === null) {
    yield finalData;
    return;
  }
  yield part1;
  yield part2;
});
```

**Antipattern 10: Memory leaks from abandoned operations**

```javascript
// Web Streams: Silent leak
const [a, b] = stream.tee();
await process(a);
// Forgot about b — memory grows forever as stream continues

// New API: Fail-fast by default
const b = stream.tee(); // Default: onOverflow: 'error'
await process(stream);
// If b isn't consumed, error surfaces when buffer fills

// Or explicit lossy mode
const b = stream.tee({
  buffer: { max: 1024, onOverflow: 'drop-oldest' },
});
// Explicitly choosing to drop data if branch falls behind
```

**Antipattern 11: Racing reads incorrectly**

```javascript
// Web Streams: Reader state can be corrupted by racing
const reader = stream.getReader();
const [a, b] = await Promise.all([reader.read(), reader.read()]); // Results may be swapped or corrupted!

// New API: No shared reader state
const [a, b] = await Promise.all([stream.read(), stream.read()]); // Each read is independent, order preserved
```

**Antipattern 12: Incorrect tee for fan-out**

```javascript
// Web Streams: Creates chain of dependencies
const [a, b] = stream.tee();
const [b1, b2] = b.tee(); // b1 and b2 both depend on b

// New API: Multiple independent branches
const a = stream.tee();
const b = stream.tee();
const c = stream.tee();
// All branches are independent peers
```

---

### Addressing Case Studies

Let's revisit each case study from Section 4 and show how the new API prevents the failure.

#### Case Study 1: Memory Leak from Reader Lock

**Original problem:** Developer forgot `reader.releaseLock()`, leaving stream permanently locked.

```javascript
// Original buggy code (Web Streams)
async function processChunks(stream) {
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    await processChunk(value);
    if (shouldStop()) break; // Early exit — forgot releaseLock()!
  }
  // reader.releaseLock() missing
}

// New API: No lock to release
async function processChunks(stream) {
  while (true) {
    const { value, done } = await stream.read();
    if (done) break;
    await processChunk(value);
    if (shouldStop()) break; // Early exit is safe
  }
  // Nothing to clean up
}

// Or with async iteration (also safe)
for await (const chunk of stream) {
  await processChunk(chunk);
  if (shouldStop()) break; // Automatically cancels stream
}
```

✅ **Addressed:** No reader lock mechanism to forget.

#### Case Study 2: OOM from Unbounded Tee

**Original problem:** Tee'd stream for logging; slow logger caused unbounded memory growth.

```javascript
// Original buggy code (Web Streams)
const [forLogging, forResponse] = stream.tee();
logRequestBody(forLogging); // Async, might be slow
return new Response(forResponse); // Memory grows if logging is slow

// New API: Bounded tee
const forLogging = stream.tee({
  buffer: {
    max: 1024 * 1024, // 1MB limit
    onOverflow: 'drop-oldest', // Log what we can, drop old data
  },
});
logRequestBody(forLogging); // Can't cause OOM
return new Response(stream);
```

✅ **Addressed:** Bounded buffers with explicit overflow policy.

#### Case Study 3: Backpressure Ignored in Logging Tee

**Original problem:** Fast producer overwhelmed slow logger; no backpressure signal.

```javascript
// Original buggy code (Web Streams)
const [forLogging, forProcessing] = stream.tee();
// Producer doesn't slow down even though forLogging consumer is slow

// New API: Multiple options

// Option A: Block producer if logging falls behind
const forLogging = stream.tee({
  buffer: { max: 1024 * 1024, onOverflow: 'block' },
});

// Option B: Drop old logs if falling behind (don't block)
const forLogging = stream.tee({
  buffer: { max: 1024 * 1024, onOverflow: 'drop-oldest' },
});

// Option C: Error if logging can't keep up (fail-fast)
const forLogging = stream.tee({
  buffer: { max: 1024 * 1024, onOverflow: 'error' },
});
```

✅ **Addressed:** Explicit backpressure policies for tee.

#### Case Study 4: Transform Confusion Causing Data Loss

**Original problem:** Developer returned data from `transform()` instead of using
`controller.enqueue()`, causing silent data loss.

```javascript
// Original buggy code (Web Streams)
new TransformStream({
  transform(chunk, controller) {
    return processChunk(chunk); // WRONG! Data lost. Should use controller.enqueue()
  },
});

// New API: Return IS the output
source.pipeThrough((chunk) => {
  return processChunk(chunk); // Correct! Return value is emitted
});

// For multiple outputs, use generator
source.pipeThrough(function* (chunk) {
  yield part1; // All yields are emitted
  yield part2;
});
```

✅ **Addressed:** Return value semantics are intuitive; no controller to misuse.

#### Case Study 5: BYOB Misuse Causing Data Corruption

**Original problem:** Developer reused buffer after BYOB read without understanding detachment.

```javascript
// Original buggy code (Web Streams)
const buffer = new Uint8Array(1024);
const reader = stream.getReader({ mode: 'byob' });
const { value } = await reader.read(buffer);
// Developer continues using 'buffer' instead of 'value'
processData(buffer); // WRONG! buffer is detached, contains garbage

// New API: Same semantics, but...
// 1. Simpler overall API means less cognitive load
// 2. Documentation emphasizes detachment clearly
// 3. Option is named 'buffer' making it clear it's special

const { value } = await stream.read({ buffer: myBuffer });
// API name reminds you: myBuffer was consumed
processData(value); // Use the returned value
```

⚠️ **Partially addressed:** Detachment is inherent to zero-copy; new API documents it
clearly and has simpler overall model, but fundamentally same semantics.

#### Case Study 6: Error Propagation Failure in Pipeline

**Original problem:** Error in transform didn't propagate to source, leaving connection open.

```javascript
// Original buggy code (Web Streams)
const transform = new TransformStream({
  transform(chunk, controller) {
    if (invalid(chunk)) throw new Error('bad data');
  },
});
source.pipeThrough(transform).pipeTo(dest);
// If transform throws, does source get cancelled? Depends on options...

// New API: Automatic bidirectional propagation
source
  .pipeThrough((chunk) => {
    if (invalid(chunk)) throw new Error('bad data');
    return process(chunk);
  })
  .pipeTo(dest);
// Error propagates to source (cancelled) AND dest (aborted)

// Plus: Cleanup hook for transforms
source.pipeThrough({
  transform(chunk) {
    if (invalid(chunk)) throw new Error('bad data');
    return process(chunk);
  },
  abort(reason) {
    // Called on any pipeline error (including our own throw)
    connection.close();
    logger.error('Pipeline failed', reason);
  },
});
```

✅ **Addressed:** Automatic bidirectional propagation; `abort()` hook for cleanup.

---

### Addressing Implementation Challenges

The following table maps implementation challenges from Section 5 to how the new API
simplifies them:

| Challenge                          | Status | How New API Addresses It                                     |
| ---------------------------------- | ------ | ------------------------------------------------------------ |
| **Complex state machines**         | ✅     | Fewer states; no lock/unlock transitions; simpler lifecycle  |
| **Promise/microtask overhead**     | ⚠️     | `writev()`, sync generators help; not fully solved           |
| **Value vs byte dichotomy**        | ✅     | Bytes-only; single code path                                 |
| **Controller lifecycle**           | ✅     | No controllers                                               |
| **Optimization difficulty**        | ✅     | Unified buffer model; `pipeline()` for fusion; see Section 9 |
| **Backpressure complexity**        | ✅     | Simple buffer options; automatic policies                    |
| **BYOB implementation complexity** | ✅     | Single read path; option instead of separate type            |
| **Tee implementation complexity**  | ✅     | Cursor-based model; bounded buffers built-in                 |

#### Promise/Microtask Overhead (Partially Addressed)

This is the one area where the new API doesn't fully solve the problem. Web Streams'
promise-per-chunk model creates significant overhead, and while the new API provides
mitigations, it doesn't eliminate async boundaries entirely.

**Mitigations in the new API:**

1. **`writev()`** — Batch multiple writes into single promise
2. **Sync generators** — Multiple sync yields processed in single microtask
3. **`atLeast` option** — Batch reads to reduce promise count
4. **`Stream.pipeline()`** — Enables internal optimizations, stage fusion
5. **Final chunk + EOF** — One less promise per stream

**What's NOT solved:**

- Still promise-per-read in general case
- Async generators still have promise-per-yield
- Pipeline stages still have async boundaries

See Open Question #8 for further discussion.

---

### Validating Design Principles

The following table validates that the API design fulfills each design principle from Section 6:

| Principle                          | Status | How API Fulfills It                                           |
| ---------------------------------- | ------ | ------------------------------------------------------------- |
| **P1: Generator-First**            | ✅     | `Stream.pull()` takes generator; no controller indirection    |
| **P2: Sensible Defaults**          | ✅     | `bytes()`, `text()` for simple cases; BYOB opt-in via options |
| **P3: Bounded Buffers by Default** | ✅     | `buffer.max`, `onOverflow` policies; no implicit unbounded    |
| **P4: Partial Consumption**        | ✅     | `take(n)`, `drop(n)`, `limit(n)`; no reader locks             |
| **P5: First-Class Combinators**    | ✅     | Built-in slicing, combining, transforming, collecting methods |
| **P6: Unified Stream Type**        | ✅     | Single `Stream` type; bytes-only; BYOB is read option         |
| **P7: Errors Are Error Objects**   | ⚠️     | Convention, not enforced; API accepts `any` for compatibility |

#### Detailed Principle Validation

**P1: Generator-First Design**

The API fully embraces generators as the primary production mechanism:

```javascript
// Primary pattern: async generator
const stream = Stream.pull(async function* () {
  for await (const record of database.query()) {
    yield serialize(record);
  }
});

// Alternative: push-based when generators don't fit
const [stream, writer] = Stream.push();
socket.onmessage = (e) => writer.write(e.data);
```

Generators provide natural backpressure (execution suspends at `yield` until consumer is ready),
cleanup (`finally` blocks run on cancellation), and error handling (`try`/`catch` works naturally).

**P2: Sensible Defaults, Explicit Complexity**

Common operations require minimal code:

```javascript
// Simple: one-liner consumption
const data = await response.body.bytes();
const text = await response.body.text();

// Simple: transform with function
const encrypted = await source.pipeThrough(encrypt).bytes();

// Advanced (opt-in): BYOB for zero-copy
const result = await stream.read({ buffer: myBuffer });

// Advanced (opt-in): custom backpressure
const [stream, writer] = Stream.push({
  buffer: { max: 64 * 1024, onOverflow: 'block' },
});
```

**P3: Bounded Buffers by Default**

Every buffering context has explicit limits:

```javascript
// Push source: bounded by default
const [stream, writer] = Stream.push({
  buffer: { max: 1024 * 1024, onOverflow: 'error' },
});

// Tee: bounded divergence
const branch = stream.tee({
  buffer: { max: 64 * 1024, onOverflow: 'drop-oldest' },
});

// Transform output: bounded
source.pipeThrough(transform, {
  buffer: { max: 256 * 1024 },
});
```

**P4: Partial Consumption Without Locking**

The cursor-based model enables partial reads without locking:

```javascript
// Sequential partial reads (no locks!)
const magic = await stream.take(4).bytes();
const header = await stream.take(100).bytes();
const body = await stream.bytes();

// Concurrent reads via explicit branching
const branch = stream.tee();
processA(stream); // Original continues
processB(branch); // Branch sees same data
```

**P5: First-Class Combinators**

All common operations are built-in:

```javascript
// Slicing
stream.take(n); // First n bytes as new stream
stream.drop(n); // Skip n bytes
stream.limit(n); // Cap at n bytes, cancel after

// Combining
Stream.concat(a, b, c); // Sequential
Stream.merge(a, b, c); // Interleaved

// Transforming
stream.pipeThrough(fn); // Simple function
stream.pipeThrough(transformObj); // Stateful object

// Collecting
stream.bytes(); // → Uint8Array
stream.text(); // → string (decoded)
stream.arrayBuffer(); // → ArrayBuffer
```

**P6: Unified Stream Type**

There's exactly one stream type — `Stream` — which is always byte-oriented:

| Web Streams (9+ types)          | New API (2 types)             |
| ------------------------------- | ----------------------------- |
| ReadableStream                  | Stream                        |
| ReadableStreamDefaultReader     | (none — read directly)        |
| ReadableStreamBYOBReader        | (none — BYOB is read option)  |
| ReadableStreamDefaultController | (none — use generators)       |
| ReadableByteStreamController    | (none — bytes-only anyway)    |
| WritableStream                  | (none — Writer is standalone) |
| WritableStreamDefaultWriter     | Writer                        |
| WritableStreamDefaultController | (none — sink callbacks)       |
| TransformStream                 | (none — pipeThrough + fn)     |

**P7: Errors Are Error Objects (Partially Fulfilled)**

The API encourages Error objects but doesn't enforce them for compatibility:

```javascript
// Encouraged: Error objects
writer.abort(new Error('Connection lost'));
stream.cancel(new Error('User cancelled'));

// Allowed: any value (for compatibility)
writer.abort('connection lost'); // Works, but loses stack trace
```

This is marked as partially fulfilled because:

- The API signature accepts `any` for error/reason parameters
- Runtime doesn't wrap primitives in Error objects automatically
- Documentation encourages Error objects but code may pass primitives

**Recommendation:** Consider adding a debug mode that warns when non-Error values are used
as abort/cancel reasons, helping developers adopt the Error-first pattern.

---

### Summary: Issue Resolution

| Category                  | Total Issues | Fully Addressed | Partially Addressed | Not Addressed |
| ------------------------- | ------------ | --------------- | ------------------- | ------------- |
| Spec Criticisms           | 10           | 10              | 0                   | 0             |
| Antipatterns              | 12           | 10              | 2                   | 0             |
| Case Studies              | 6            | 5               | 1                   | 0             |
| Implementation Challenges | 8            | 7               | 1                   | 0             |
| Design Principles         | 7            | 6               | 1                   | 0             |
| **Total**                 | **43**       | **38 (88%)**    | **5 (12%)**         | **0**         |

**Partially addressed items:**

1. **Antipattern 7 (Double-reading)** — Inherent to streams; `tee()` is the solution (same as Web Streams, but more ergonomic)
2. **Antipattern 8 (BYOB misuse)** — Buffer detachment is inherent to zero-copy; better documentation helps
3. **Case Study 5 (BYOB corruption)** — Same as above
4. **Promise/microtask overhead** — Mitigated but not eliminated
5. **P7 (Errors Are Error Objects)** — Convention encouraged but not enforced; accepts `any` for compatibility

**Key wins:**

- **100% of lock-related issues eliminated** — No reader/writer locks
- **100% of controller issues eliminated** — No controllers
- **100% of unbounded buffer issues addressed** — Mandatory limits and policies
- **100% of error propagation issues addressed** — Automatic bidirectional propagation
- **100% of complexity issues addressed** — 2 types vs 9+, simpler state machines
- **100% of design principles fulfilled or partially fulfilled** — API delivers on stated goals

---

## 15. Open Questions

1. **Should streams be lazy or eager by default?** ✅ **RESOLVED**

   **Decision:** The API supports both, with clear separation:
   - **`Stream.pull(generator)`** — Lazy (pull-based). Generator runs on demand.
   - **`Stream.push()`** — Eager (push-based). Writer can push data independently.

   There is no "default" — developers explicitly choose the model that fits their use case.

   **Guidance:**

   | Use case                    | Model                | Why                                  |
   | --------------------------- | -------------------- | ------------------------------------ |
   | File reading, HTTP response | Pull (`Stream.pull`) | Data exists; read on demand          |
   | WebSocket, event source     | Push (`Stream.push`) | Data arrives independently           |
   | Computed/generated data     | Pull (`Stream.pull`) | Generate only what's consumed        |
   | Real-time sensor data       | Push (`Stream.push`) | Data flows regardless of consumption |

   **Key insight:** The question "lazy or eager?" is really about the **source**, not the stream
   abstraction. The API makes this explicit rather than hiding it behind a single constructor.

2. **How should cancellation propagate?** ✅ **RESOLVED**

   **Decision:** Cancellation always propagates to the source by default. This is the safe default
   that prevents resource leaks.

   **Rationale:**
   - When a consumer stops iterating (breaks out of `for await`), the stream is cancelled
   - Cancellation propagates backward through pipelines to the source
   - This ensures resources (file handles, network connections) are released

   **When you don't want cancellation to propagate:**

   Use `tee()` to create a branch. Cancelling a branch doesn't cancel the parent:

   ```javascript
   const branch = stream.tee();
   branch.cancel(); // Only branch cancelled; stream continues
   ```

   Or use `pipeTo()` with `preventCancel: true`:

   ```javascript
   await source.pipeTo(dest, { preventCancel: true });
   // source is NOT cancelled when dest closes
   ```

   **Why not make it configurable on iteration?**

   Adding a `{ preventCancel: true }` option to `for await` would be confusing and error-prone.
   The `tee()` pattern is explicit and composable.

3. **What's the right model for duplex streams?** ✅ **RESOLVED**

   **Decision:** Use `{ readable: Stream, writer: Writer }` pairs. No first-class `DuplexStream`.

   **Rationale:**
   - **Simplicity**: A duplex is just two independent streams. Adding a `DuplexStream` class
     would duplicate functionality and add API surface without clear benefit.
   - **Flexibility**: The pair pattern allows different buffer configurations, error handling,
     and lifecycles for each direction.
   - **Composition**: Pairs work naturally with destructuring and can be passed to functions
     that only need one direction.
   - **Precedent**: Node.js `Duplex` streams are notoriously complex; the pair pattern avoids
     that complexity.

   **Pattern for duplex APIs:**

   ```javascript
   // Socket-like APIs return { readable, writer }
   const { readable, writer } = await connect('tcp://example.com:8080');

   // Independent read/write
   const response = await readable.bytes();
   await writer.write(request);
   await writer.close();

   // Or pipe through transform
   await readable.pipeThrough(transform).pipeTo(writer);
   ```

   **When you need coordinated close:**

   ```javascript
   // Helper for "close both when either closes"
   function linkDuplex(readable, writer) {
     readable.closed.then(() => writer.close());
     writer.closed.then(() => readable.cancel());
   }
   ```

   See Use Case 11 (Duplex Streams and Sockets) for detailed examples.

4. **How should TypeScript types work?** The current spec's types are complex. A redesign could
   improve type inference.

5. **What about Node.js stream interop?** Many developers need to work with both. Should the
   new API provide direct Node.js stream compatibility?

6. **Should there be sync iteration support?** ✅ **RESOLVED**

   **Decision:** No sync iteration. Streams are inherently async; use `Stream.from()` for
   in-memory data that doesn't need streaming.

   **Rationale:**
   - **Streams are for I/O**: The primary use case is network/file I/O, which is async
   - **In-memory data doesn't need streams**: If you have all data in memory, just use arrays
   - **Mixed sync/async is confusing**: A stream that's "sometimes sync" creates footguns
   - **`Stream.from()` handles the common case**: Creating a stream from in-memory data is easy

   **For in-memory data:**

   ```javascript
   // If you have all data in memory, you probably don't need a stream
   const data = new Uint8Array([1, 2, 3, 4, 5]);

   // But if you need a stream (e.g., to pass to an API that expects one):
   const stream = Stream.from(data);

   // Consumption is still async, but that's fine — it's just one await
   const bytes = await stream.bytes();
   ```

   **Why not add sync iteration anyway?**
   1. **API complexity**: Adding `[Symbol.iterator]` alongside `[Symbol.asyncIterator]` doubles
      the iteration surface area
   2. **Blocking risk**: Sync iteration on a stream backed by I/O would block the event loop
   3. **Inconsistent behavior**: Some streams would support sync, others wouldn't
   4. **Marginal benefit**: The overhead of `await` on an already-buffered stream is negligible

7. **What happens to abandoned cursors/branches?** ✅ **RESOLVED**

   See "Abandoned Branch Semantics" section below for the full resolution.

   **Summary:** Branches are a commitment. The default `onOverflow: 'error'` policy surfaces
   abandoned branches as errors when the buffer fills. This is fail-fast behavior that catches
   bugs early. Developers who intentionally want to ignore branches can use `'drop-oldest'`
   (lossy) or `{ detached: true }` (branch starts empty, misses prior data).

8. **Promise and microtask overhead in pipelines?** A key performance problem with Web Streams
   is the combinatorial explosion of promises and microtask continuations, especially when
   transforms are involved. For each chunk flowing through a transform pipeline:

   ```
   read() → Promise → microtask
     → write() → Promise → microtask
       → transform() → Promise → microtask
         → enqueue() → triggers read
           → ... next stage
   ```

   With N transforms, a single chunk can trigger 4N+ promise resolutions and microtask queue
   entries. This is why Web Streams are significantly slower than Node.js streams.

   **The current design does not fundamentally solve this.** We still have:
   - Promise per write/read operation
   - Microtask interleaving between pipeline stages
   - Multiple async boundaries in a pipeline

   **Mitigations already in the design:**

   The `writev()` method on Writer helps here — multiple chunks can be written in a single
   operation (one promise) instead of N separate `write()` calls (N promises):

   ```javascript
   // Instead of: 4 promises, 4 microtasks
   await writer.write(chunk1);
   await writer.write(chunk2);
   await writer.write(chunk3);
   await writer.write(chunk4);

   // With writev: 1 promise, 1 microtask
   await writer.writev([chunk1, chunk2, chunk3, chunk4]);
   ```

   **Gap: `Stream.pull()` doesn't benefit from this.** Pull streams are generator-based and
   yield one chunk at a time. Potential solutions:

   ```javascript
   // Option A: Yield arrays for batching
   const stream = Stream.pull(async function* () {
     const batch = await fetchBatch();
     yield batch; // Yield Uint8Array[] instead of Uint8Array?
   });

   // Option B: Batched read API on consumer side
   const chunks = await stream.readMany(10); // Read up to 10 chunks in one call

   // Option C: Generator can yield multiple times synchronously between awaits
   const stream = Stream.pull(async function* () {
     const rows = await database.fetchBatch(100);
     for (const row of rows) {
       yield serialize(row); // Sync yields processed in single microtask
     }
   });
   ```

   Option C may already work if the implementation processes all synchronous yields before
   the next microtask checkpoint.

   **Other potential optimizations:**

   | Optimization                   | Description                                                    |
   | ------------------------------ | -------------------------------------------------------------- |
   | **Synchronous fast path**      | If buffer has data, return synchronously without promise       |
   | **Fused pipelines**            | Combine adjacent transforms to reduce async boundaries         |
   | **Internal sync coordination** | Use callbacks internally, only expose promises at API boundary |

   This is a critical performance consideration. The API design should not preclude these
   optimizations, but the extent to which they're implemented affects whether the new API
   can achieve performance parity with Node.js streams.

---

## 16. References

[^1]: WHATWG Streams Standard. https://streams.spec.whatwg.org/

[^2]: Archibald, Jake. "2016 - the year of web streams." January 2016. https://jakearchibald.com/2016/streams-ftw/

[^3]: WHATWG Streams Issues - Addition/Proposal label. https://github.com/whatwg/streams/issues?q=label%3A%22addition%2Fproposal%22

[^4]: WHATWG Streams PR #980 - Async iteration. https://github.com/whatwg/streams/pull/980

[^5]: WHATWG Streams Issue #1128 - Adding generic seek or read/write-at-offset abilities. https://github.com/whatwg/streams/issues/1128

[^6]: WHATWG Streams Issue #1253 - Simplify "set up" algorithms for IDL-created streams. https://github.com/whatwg/streams/issues/1253

---

## 17. Document History

| Date       | Change                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------- |
| 2026-01-21 | Initial draft                                                                            |
| 2026-01-21 | Expanded criticisms: spec complexity, controller API, BYOB complexity                    |
| 2026-01-21 | Added pathological antipatterns section (12 antipatterns)                                |
| 2026-01-21 | Added 6 real-world case studies demonstrating antipatterns                               |
| 2026-01-21 | Added implementation challenges section for runtime implementers                         |
| 2026-01-21 | Renamed Stream.generate→Stream.pull, Stream.create→Stream.push                           |
| 2026-01-21 | Changed Stream.push() to return [Stream, Sink] pair                                      |
| 2026-01-21 | Renamed to sink.push() to avoid confusion with current API                               |
| 2026-01-21 | Unified Sink and Writer into single Writer type                                          |
| 2026-01-21 | Stream.transform() returns [Stream, Writable] tuple like Stream.push()                   |
| 2026-01-21 | Added chunkSize option to Stream.transform() for fixed-size chunks                       |
| 2026-01-21 | Added buffer overflow defenses; unified on `onOverflow` policy name                      |
| 2026-01-21 | Removed `ready` promise; simplified to just `write()` + `desiredSize`                    |
| 2026-01-21 | Added error propagation to readable side; `hardMax` for 'block' policy                   |
| 2026-01-21 | Added `writev()` for vectored writes                                                     |
| 2026-01-21 | Clarified pipeThrough() returns Stream; same args as Stream.transform()                  |
| 2026-01-21 | Added buffer config (max, hardMax, onOverflow) to transform options                      |
| 2026-01-21 | Added pipeline buffer considerations and best practices                                  |
| 2026-01-21 | Added open question #8: promise/microtask overhead in pipelines                          |
| 2026-01-21 | Noted writev() helps with batching; identified gap for Stream.pull()                     |
| 2026-01-21 | Added special handling for strings/BufferSource in Stream.from()                         |
| 2026-01-21 | Renamed collection methods; removed first()/single() due to undefined                    |
| 2026-01-21 | Separated take()/takeBytes() from collection; added orthogonal design                    |
| 2026-01-21 | **Major**: Made streams bytes-only; strings auto-encode to UTF-8                         |
| 2026-01-21 | Unified take() to always mean bytes; removed chunk-based operators                       |
| 2026-01-21 | Added partial consumption semantics; streams continue after take()                       |
| 2026-01-21 | Added error vs cancellation semantics for partial consumption                            |
| 2026-01-21 | Unified take() and tee() as branching operations with same semantics                     |
| 2026-01-21 | Added unified buffer/cursor model: one buffer, multiple cursors                          |
| 2026-01-21 | Added open question #7: abandoned cursor/branch semantics                                |
| 2026-01-21 | Clarified drop(n) semantics: returns closed stream, no lingering cursor                  |
| 2026-01-21 | Simplified operators: removed parsing/compression/timing/retry from core                 |
| 2026-01-21 | Clarified BYOB: avoids read allocation, NOT end-to-end zero-copy                         |
| 2026-01-21 | Added System Stream Use Cases section validating API with real I/O                       |
| 2026-01-21 | Timeout intentionally omitted due to timing side-channel concerns                        |
| 2026-01-21 | Added first-class AbortSignal support to consumption methods and piping                  |
| 2026-01-21 | Updated use cases to demonstrate AbortSignal patterns throughout                         |
| 2026-01-21 | Added WebIDL interface definitions for global scope exposure                             |
| 2026-01-21 | Consolidated API: Stream.writable() instead of separate Writable class                   |
| 2026-01-21 | Stream.transform() returns [Stream, Writer] like push(); removed StreamWithWritable      |
| 2026-01-21 | pipeTo() accepts Writer                                                                  |
| 2026-01-21 | Removed Writable; Stream.writer(sink) returns Writer directly                            |
| 2026-01-21 | Removed StreamReader; added read() and closed directly to Stream                         |
| 2026-01-21 | tee() returns single Stream; original stream remains usable as other branch              |
| 2026-01-21 | Removed array() collection method; bytes() and arrayBuffer() suffice                     |
| 2026-01-21 | Removed StreamMulticast; multiple tee() calls achieve the same result                    |
| 2026-01-21 | StreamTransformCallback returns bytes directly (not a generator)                         |
| 2026-01-21 | Added Use Case 6: Stateful Transform (NDJSON Parser) demonstrating StreamTransformer     |
| 2026-01-21 | Clarified StreamTransformer return types: sync/async, single/iterable, generator         |
| 2026-01-21 | Added "StreamTransformer return types" section to WebIDL Notes                           |
| 2026-01-21 | Updated StreamTransformer examples: LineParser, ChunkAccumulator, AsyncEncryptor         |
| 2026-01-21 | Clarified NDJSON: StreamTransformer for bytes, async generator for parsed objects        |
| 2026-01-21 | Simplified: removed flush(), transform(null) signals end-of-input                        |
| 2026-01-21 | Simplified: StreamTransformer is protocol (duck typing), not a base class                |
| 2026-01-21 | Unified: functions and transform() methods use same signature (Uint8Array? chunk)        |
| 2026-01-21 | Stream.pull() accepts both sync and async generators                                     |
| 2026-01-21 | Added limit(n) — caps stream at n bytes and cancels source after                         |
| 2026-01-21 | Enhanced read(): atLeast option, signal option, value+done in single result              |
| 2026-01-21 | Moved buffer arg into StreamReadOptions for cleaner non-BYOB usage                       |
| 2026-01-21 | Added max option to read() — bounds allocation size in non-BYOB mode                     |
| 2026-01-21 | Specified buffer detachment semantics — all BufferSource args are detached               |
| 2026-01-21 | Added encoding option to Stream.pull/push/transform/from and Stream.writer               |
| 2026-01-21 | Byte counts returned: closed, close(), abort(), cancel(), pipeTo() return bytes          |
| 2026-01-21 | Removed hardcoded 1MB default from StreamBufferOptions (implementation-defined)          |
| 2026-01-21 | Added Writer.flush() — sync point, resolves when all prior writes complete               |
| 2026-01-21 | Added AbortSignal to write/writev/flush; cancellation cascades to subsequent ops         |
| 2026-01-21 | Removed Stream.catch() — error recovery mid-stream is not a valid use case               |
| 2026-01-21 | Documented bidirectional error propagation in pipelines (source↔dest)                   |
| 2026-01-21 | Added optional abort(reason) to stateful transforms for error cleanup                    |
| 2026-01-21 | Added `limit` option to StreamPipeToOptions — limits bytes piped, cancels after          |
| 2026-01-21 | Clarified pipeThrough creates a branch (like tee/take/limit); parent continues           |
| 2026-01-21 | Added `limit` option to StreamPipeOptions — limits bytes through transform               |
| 2026-01-21 | Documented: pipeThrough omits prevent\* options (departure from Web Streams spec)        |
| 2026-01-21 | Added Stream.pipeline() — optimized pipeline construction (like Node.js)                 |
| 2026-01-21 | Added StreamPipelineOptions.preventClose for multiple pipelines to same dest             |
| 2026-01-21 | Added pipeline error propagation documentation with examples                             |
| 2026-01-21 | Added Use Cases 9-13: SSR, API Gateway, Duplex, StartTLS, System Sources                 |
| 2026-01-21 | Updated validation summary with new use cases and gaps                                   |
| 2026-01-21 | **Resolved Open Question #7**: Abandoned branch semantics                                |
| 2026-01-21 | Added "Abandoned Branch Semantics" section with design rationale                         |
| 2026-01-21 | Added `detached` option to StreamTeeOptions for late-binding branches                    |
| 2026-01-21 | Added `attach()` method to Stream for detached branches                                  |
| 2026-01-21 | **Resolved Open Question #3**: Duplex streams — use `{ readable, writer }` pairs         |
| 2026-01-21 | **Resolved Open Question #1**: Lazy vs eager — both supported, explicit choice           |
| 2026-01-21 | **Resolved Open Question #2**: Cancellation propagates by default; use tee() to prevent  |
| 2026-01-21 | **Resolved Open Question #6**: No sync iteration; streams are async, use arrays if sync  |
| 2026-01-21 | Clarified detached branches auto-attach on first consumption method call                 |
| 2026-01-21 | Added Explicit Resource Management (`await using`) support to Stream and Writer          |
| 2026-01-21 | Stream.asyncDispose() calls cancel(); Writer.asyncDispose() calls close()                |
| 2026-01-21 | Added "Explicit Resource Management" section with usage patterns and rationale           |
| 2026-01-21 | Added `Stream.detached` boolean attribute to check attachment state                      |
| 2026-01-21 | Added "Implementation Optimization Opportunities" section                                |
| 2026-01-21 | Documented structural simplifications: bytes-only, no reader ceremony, unified buffer    |
| 2026-01-21 | Documented zero-copy opportunities: detachment, BYOB, writev scatter-gather              |
| 2026-01-21 | Documented batching: writev, atLeast, sync generators, final chunk+EOF                   |
| 2026-01-21 | Documented fast paths: sync resolution, drop(), Stream.from()                            |
| 2026-01-21 | Documented memory efficiency: ring buffer, bounded buffers, detached branches            |
| 2026-01-21 | Documented pipeline optimization: fusion, direct source-to-sink, limit option            |
| 2026-01-21 | Documented internal vs JS-created streams optimization strategy                          |
| 2026-01-21 | Added optimization impact hierarchy summary table                                        |
| 2026-01-21 | Added "API Comparison: New Stream vs Web Streams" section                                |
| 2026-01-21 | Detailed comparison: API surface area (9+ types vs 2 types)                              |
| 2026-01-21 | Detailed comparison: Data model (any value vs bytes-only)                                |
| 2026-01-21 | Detailed comparison: Stream creation patterns                                            |
| 2026-01-21 | Detailed comparison: Reading and writing data                                            |
| 2026-01-21 | Detailed comparison: Transform streams                                                   |
| 2026-01-21 | Detailed comparison: Branching (tee) semantics                                           |
| 2026-01-21 | Detailed comparison: Partial consumption (take/drop/limit)                               |
| 2026-01-21 | Detailed comparison: Backpressure mechanisms                                             |
| 2026-01-21 | Detailed comparison: Error handling and propagation                                      |
| 2026-01-21 | Detailed comparison: Pipeline construction                                               |
| 2026-01-21 | Added "When to Use Each" guidance table                                                  |
| 2026-01-21 | Added trade-off summary with pros/cons for each API                                      |
| 2026-01-21 | Added Use Case 14: Node.js Stream Interoperability                                       |
| 2026-01-21 | Node.js bridge: fromNodeReadable, toNodeReadable, fromNodeWritable, toNodeWritable       |
| 2026-01-21 | Node.js bridge: Transform stream bridging with backpressure                              |
| 2026-01-21 | Node.js bridge: Complete interop helper module example                                   |
| 2026-01-21 | Added Use Case 15: Web Streams Interoperability                                          |
| 2026-01-21 | Web Streams bridge: fromReadableStream, toReadableStream                                 |
| 2026-01-21 | Web Streams bridge: fromWritableStream, toWritableStream                                 |
| 2026-01-21 | Web Streams bridge: TransformStream bridging for CompressionStream etc.                  |
| 2026-01-21 | Added native interop methods to gaps table (toReadableStream, fromReadable)              |
| 2026-01-21 | Updated validation summary with interop use cases                                        |
| 2026-01-21 | Added "Design Validation: Addressing Identified Issues" section                          |
| 2026-01-21 | Mapped all 10 spec criticisms to solutions (100% addressed)                              |
| 2026-01-21 | Mapped all 12 antipatterns to solutions (10 fully, 2 partially addressed)                |
| 2026-01-21 | Revisited all 6 case studies showing how new API prevents failures                       |
| 2026-01-21 | Mapped all 8 implementation challenges to solutions (7 fully, 1 partially)               |
| 2026-01-21 | Added issue resolution summary: 89% fully addressed, 11% partially, 0% unaddressed       |
| 2026-01-21 | Documented remaining gaps: double-reading, BYOB detachment, promise overhead             |
| 2026-01-21 | Added "Potential Pitfalls of the New API" section — honest critical examination          |
| 2026-01-21 | Pitfall 1: New mental model required (tee asymmetry, pipeThrough branching)              |
| 2026-01-21 | Pitfall 2: Generator learning curve (syntax, yield vs return, suspension)                |
| 2026-01-21 | Pitfall 3: Bytes-only limitation (must serialize objects, async generators for objects)  |
| 2026-01-21 | Pitfall 4: Buffer detachment surprises (same as Web Streams, fundamental to zero-copy)   |
| 2026-01-21 | Pitfall 5: Silent data loss with drop-\* overflow policies                               |
| 2026-01-21 | Pitfall 6: take() vs limit() confusion (continues vs cancels)                            |
| 2026-01-21 | Pitfall 7: pipeThrough branching semantics different from Web Streams                    |
| 2026-01-21 | Pitfall 8: Implicit string encoding (UTF-8 default, set at creation)                     |
| 2026-01-21 | Pitfall 9: Generator cleanup error handling undefined                                    |
| 2026-01-21 | Pitfall 10: Detached branch timing and auto-attach behavior                              |
| 2026-01-21 | Pitfall 11: No ready signal for manual backpressure patterns                             |
| 2026-01-21 | Pitfall 12: Ecosystem fragmentation (non-standard, server-only)                          |
| 2026-01-21 | Pitfall 13: Transform function vs generator ambiguity                                    |
| 2026-01-21 | Pitfall 14: Sync generator event loop blocking                                           |
| 2026-01-21 | Pitfall 15: null as flush signal limitations                                             |
| 2026-01-21 | Pitfall 16: Writer lifetime tied to creation                                             |
| 2026-01-21 | Pitfall 17: Cursor memory behavior not obvious                                           |
| 2026-01-21 | Added pitfall severity matrix and recommendations for API improvements                   |
| 2026-01-21 | Added section numbers to all headers (1-17)                                              |
| 2026-01-21 | Fixed terminology: StreamTransform → StreamTransformer in validation table               |
| 2026-01-21 | Updated changelog entries for correct type names (StreamTransformCallback, etc.)         |
| 2026-01-21 | Added Document History (Section 17) to Table of Contents                                 |
| 2026-01-21 | Clarified P5 (First-Class Combinators): no .map()/.filter(), pipeThrough(fn) serves role |
| 2026-01-21 | Added "Validating Design Principles" subsection to Section 14                            |
| 2026-01-21 | Validated all 7 design principles (P1-P7): 6 fully addressed, 1 partially (P7)           |
| 2026-01-21 | Updated issue resolution summary: 43 total items, 88% fully addressed                    |

