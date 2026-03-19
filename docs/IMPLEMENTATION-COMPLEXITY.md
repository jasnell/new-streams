# Implementation Complexity Comparison: New Streams vs. Web Streams

I compare the implementation complexity of my New Streams API against the
WHATWG Web Streams specification, using four Web Streams implementations:

1. **WHATWG reference polyfill** — [web-streams-polyfill](https://github.com/MattiasBuelens/web-streams-polyfill)
   (v4.2.0, spec version `080852c`). Pure TypeScript, spec-compliant.
2. **Node.js** — `lib/internal/webstreams/` (main branch, March 2026). JavaScript with
   C++ bindings and primordials.
3. **Deno** — `ext/web/06_streams.js` + `stream_resource.rs` (main branch, March 2026).
   JavaScript with Rust native channel.
4. **Chromium/Blink** — `third_party/blink/renderer/core/streams/` (main branch, March 2026).
   Pure C++ with V8 bindings, IDL, and Oilpan GC.

Sections 1–7 use the reference polyfill for the detailed normalized comparison (fairest
apples-to-apples since both are TypeScript/JavaScript). Section 8 expands the comparison
to the three production runtime implementations, projects what a New Streams runtime
implementation would look like (§8.6), and verifies those projections against an actual
Node.js port of the New Streams API (§8.7). Section 10 evaluates specific arguments from
Domenic Denicola's [published critique](https://domenic.me/streams-standard/) against the
complexity data collected here.

---

## 1. High-Level Metrics

|                                 | Web Streams     | New Streams     |
| ------------------------------- | --------------- | --------------- |
| Source files                    | 45              | 11              |
| Total lines                     | 7,671           | 5,615           |
| Code lines (no blanks/comments) | 5,668           | 3,307           |
| Classes                         | 14              | 7 (1 exported)  |
| Exported classes                | 12              | 1 *             |
| Abstract operations / functions | ~150            | ~151            |
| Interfaces + types              | ~40             | ~50 **          |
| Explicit state machines         | 4               | 2               |
| Internal state slots (total)    | ~70+            | ~35             |
| Promise management functions    | 23              | 0 ***           |
| Brand check functions           | 12              | 0               |
| WebIDL validation functions     | 22 (485 lines)  | 0               |

\* The one exported class is `RingBuffer`, a generic data structure, not a stream
primitive. The public API exposes no stream classes — it is entirely functions + interfaces.

\** Higher type count reflects the parallel sync/async type hierarchy and protocol symbols.

\*** New Streams creates promises directly (`new Promise()` at 8 sites); Web Streams wraps
all promise operations in named management functions to track resolve/reject slots and
promise state explicitly.

### Architectural Shape

**Web Streams** is organized as a deep class hierarchy with controllers mediating between
streams and their sources/sinks. Three class families (`ReadableStream`, `WritableStream`,
`TransformStream`) each have their own controller(s), reader(s)/writer, and abstract
operation layer:

```
ReadableStream
  ├── ReadableStreamDefaultReader
  ├── ReadableStreamBYOBReader
  ├── ReadableStreamDefaultController
  ├── ReadableByteStreamController
  │     └── ReadableStreamBYOBRequest
  └── (generic-reader, async-iterator, pipe, tee, from)

WritableStream
  ├── WritableStreamDefaultWriter
  └── WritableStreamDefaultController

TransformStream
  └── TransformStreamDefaultController
       (internally creates a ReadableStream + WritableStream)
```

14 classes total, connected by ~150 abstract operation functions that implement the spec
algorithms. Each class has internal slots managed via named operations like
`ReadableStreamDefaultControllerCallPullIfNeeded`, and each public method delegates through
multiple layers of indirection.

**New Streams** is organized as a flat function-oriented architecture. Streams are plain
iterables, writers are plain interfaces, and transforms are plain functions:

```
push()        → PushQueue + PushWriter → AsyncIterable<Uint8Array[]>
pull()        → source → transforms → AsyncIterable<Uint8Array[]>
pipeTo()      → source → transforms → Writer
from()        → any input → AsyncIterable<Uint8Array[]>
broadcast()   → BroadcastImpl + BroadcastWriter
share()       → ShareImpl
duplex()      → two cross-wired push() pairs
consumers     → bytes(), text(), merge(), tap(), ondrain()
```

7 internal classes (most are implementation details), connected by exported factory
functions. No controllers, no readers, no abstract operation layer.

---

## 2. Feature-Normalized Comparison

The following compares equivalent features side-by-side, measuring only the code required
to implement each feature in both APIs. Line counts are **code lines** (non-blank,
non-comment).

### 2.1 Producer-Consumer Data Flow

The foundational feature: a producer writes data, a consumer reads it, with backpressure.

**Web Streams** requires:

| Component                               | Code Lines |
| --------------------------------------- | ---------- |
| `ReadableStream` class + operations     | 401        |
| `ReadableStreamDefaultController`       | 301        |
| `ReadableStreamDefaultReader`           | 180        |
| Generic reader operations               | 79         |
| Async iterator protocol                 | 149        |
| `WritableStream` + Writer + Controller  | 1,021      |
| Queue-with-sizes                        | 40         |
| SimpleQueue                             | 89         |
| Queuing strategies (Count + ByteLength) | 111        |
| Promise helpers (`webidl.ts`)           | 83         |
| Misc helpers                            | 42         |
| Validators (basic + stream types)       | 250        |
| Abstract ops (misc + ecmascript)        | 209        |
| **Total**                               | **2,955**  |

**New Streams** requires:

| Component                               | Code Lines |
| --------------------------------------- | ---------: |
| `push()` + PushQueue + PushWriter       | 426        |
| RingBuffer                              | 91         |
| Utilities                               | 60         |
| **Total**                               | **577**    |

**Ratio: 5.1x** — Web Streams needs 5.1x more code for the same basic capability.

The Web Streams total includes shared infrastructure (validators, abstract operations,
promise helpers) that serves the entire API, not just producer-consumer flow. However,
this infrastructure is required for the producer-consumer path to function — a minimal
working ReadableStream + WritableStream needs the validators, queue implementation, and
promise management functions. The ratio reflects the total cost of making the basic
capability work end-to-end.

The primary drivers of this difference:

- **Controllers as mediators**: Web Streams interposes a controller object between the
  stream and its source, adding an entire class with its own state, operations, and
  lifecycle. New Streams eliminates this layer; the PushQueue directly connects writer
  to consumer.

- **Reader ceremony**: Web Streams requires acquiring a reader (`stream.getReader()`) before
  consuming data, adding a class, lock management, and closed promise tracking. New Streams
  uses native `for await...of` directly on the iterable.

- **Promise management overhead**: Web Streams manually tracks promise resolve/reject
  functions and promise states (23 helper functions). New Streams creates promises directly.

- **Validation overhead**: Web Streams dedicates 485 lines to WebIDL-compliant argument
  validation. New Streams validates inline with simple type guards.

- **Queuing strategy abstraction**: Web Streams supports pluggable size functions and two
  strategy classes. New Streams counts operations, requiring no strategy objects.

### 2.2 Transform Pipelines

Applying data transformations between source and consumer.

**Web Streams** — `TransformStream` class:

| Component                            | Code Lines |
| ------------------------------------ | ---------: |
| `TransformStream` + controller ops   | 495        |
| Transformer types + validator        | 94         |
| *Internal ReadableStream creation*   | ~150 *     |
| *Internal WritableStream creation*   | ~150 *     |
| **Direct cost**                      | **589**    |
| **Effective cost (with internals)**  | **~889**   |

\* TransformStream internally creates a ReadableStream and WritableStream, reusing their
code. The "direct cost" is the new code in transform-stream.ts; the "effective cost"
includes the ReadableStream/WritableStream infrastructure it depends on.

**New Streams** — plain functions in pull pipeline:

| Component                            | Code Lines |
| ------------------------------------ | ---------: |
| Transform type checking              | 15         |
| `applyStatelessAsyncTransform()`     | 55         |
| `applyStatefulAsyncTransform()`      | 16         |
| `processTransformResultAsync()`      | 58         |
| `flattenTransformYieldAsync()`       | 25         |
| `createAsyncPipeline()`              | 90         |
| **Total**                            | **259**    |

**Ratio: 2.3x** (direct) / **3.4x** (effective).

The key design difference: Web Streams models transforms as a class that internally
creates two coupled streams with a controller mediating between them and managing a
backpressure-change promise. New Streams models transforms as functions called within a
generator pipeline — no classes, no controllers, no internal stream instantiation.

### 2.3 Piping Source to Sink

Writing all data from a source through optional transforms into a writer/sink.

**Web Streams** — `ReadableStream.prototype.pipeTo()`:

| Component                              | Code Lines |
| -------------------------------------- | ---------: |
| `ReadableStreamPipeTo` algorithm       | 213        |
| Pipe options types + validator         | 59         |
| ReadableWritablePair types + validator | 25         |
| **Total**                              | **297**    |

The pipe algorithm is a single 213-line function with 8 internal closures managing
4-directional error/close propagation (source error → dest, dest error → source,
source close → dest, dest close → source).

**New Streams** — `pipeTo()`:

| Component                              | Code Lines |
| -------------------------------------- | ---------: |
| `pipeTo()` function                    | 96         |
| Argument parsing                       | 36         |
| **Total**                              | **132**    |

**Ratio: 2.3x**.

New Streams' pipeTo is simpler because it delegates pipeline construction to
`createAsyncPipeline()` (already counted in transforms) and the generator's
try/catch/finally handles error propagation naturally. Web Streams' pipe must manually
orchestrate promise chains for shutdown sequencing.

### 2.4 Source Normalization

Creating a stream from diverse input types (iterables, buffers, etc.).

**Web Streams** — `ReadableStream.from()`:

| Component                            | Code Lines |
| ------------------------------------ | ---------- |
| `ReadableStreamFrom` + variants      | 96         |
| ECMAScript operations (shared)       | ~100       |
| **Total**                            | **~196**   |

**New Streams** — `Stream.from()` (async path only, for fair comparison):

| Component                            | Code Lines |
| ------------------------------------ | ---------: |
| `from()` + normalizers (async only)  | ~200       |
| **Total**                            | **~200**   |

**Ratio: ~1:1**. Comparable complexity, though New Streams handles more input types
(protocol symbols, string coercion, recursive iterables) while Web Streams relies on
ECMAScript abstract operations for iterator handling.

### 2.5 Multi-Consumer

Splitting one stream for consumption by multiple readers.

**Web Streams** — `ReadableStream.prototype.tee()`:

| Component                            | Code Lines |
| ------------------------------------ | ---------: |
| `ReadableStreamDefaultTee`           | ~122       |

Supports exactly 2 consumers. Unbounded internal buffering (no backpressure between
branches). The byte variant (`ReadableByteStreamTee`) adds ~245 lines but is BYOB-specific.

**New Streams** — `Stream.broadcast()` + `Stream.share()`:

| Component                            | Code Lines |
| ------------------------------------ | ---------: |
| `broadcast.ts` (push-model fan-out)  | 574        |
| `share.ts` (pull-model sharing)      | 518        |
| **Total**                            | **1,092**  |

**Ratio: 0.11x** — New Streams uses ~9x more code here.

This is the one area where New Streams is substantially more complex, but the comparison
is asymmetric: New Streams supports N consumers (not just 2), offers 4 backpressure
policies, provides bounded buffers with explicit limits, and offers both push-model and
pull-model variants. Web Streams' tee provides none of these.

### 2.6 Summary Table

| Feature                      | Web Streams     | New Streams | Ratio (WS:NS) |
| ---------------------------- | --------------- | ----------- | ------------- |
| Producer-consumer flow       | 2,955           | 577         | 5.1x          |
| Transform pipelines          | 589–889         | 259         | 2.3–3.4x      |
| Piping                       | 297             | 132         | 2.3x          |
| Source normalization         | ~196            | ~200        | ~1:1          |
| Multi-consumer               | 122             | 1,092       | 0.11x         |
| **Feature-equivalent total** | **4,159–4,459** | **2,260**   | **1.8–2.0x**  |

For features that exist in both APIs, Web Streams requires roughly **2x** the code. The
producer-consumer core — the most fundamental feature — shows a **5.1x** difference.

---

## 3. Features Unique to Each API

### 3.1 Web Streams Only

| Feature                        | Code Lines | Purpose                                      |
| ------------------------------ | ---------- | -------------------------------------------- |
| BYOB readers + byte controller | ~1,200     | Zero-copy reads into caller-supplied buffers |
| Byte stream tee variant        | ~245       | Tee with BYOB support                        |
| WebIDL validators              | 427        | Spec-compliant argument processing           |
| Brand checks (12 functions)    | ~130       | `instanceof`-style type verification         |
| Queuing strategy classes       | 111        | Pluggable size functions                     |
| Promise mgmt functions         | ~200       | Manual resolve/reject/state tracking         |
| Algorithm clearing             | ~25        | GC-related closure cleanup                   |
| Object/value mode support      | ~100 *     | Type parameterization throughout             |
| **Total unique cost**          | **~2,438** |                                              |

\* Estimated cost of generic type parameters and value-mode code paths distributed
across the codebase.

**BYOB alone costs ~1,445 lines** (19.6% of the total implementation). The README of
this project notes BYOB is "optional for producers and rarely correctly implemented" —
this is a significant complexity investment for a feature with limited real-world adoption.

### 3.2 New Streams Only

| Feature                       | Code Lines | Purpose                                         |
| ----------------------------- | ---------: | ----------------------------------------------- |
| Sync variants (all modules)   | ~600       | Zero-promise pipeline execution                 |
| Broadcast (N-consumer push)   | 574        | Push-model fan-out with backpressure            |
| Share (N-consumer pull)       | 518        | Pull-model sharing with bounded buffers         |
| Duplex channels               | 52         | Bidirectional communication pairs               |
| Consumer functions            | 349        | bytes(), text(), array(), arrayBuffer()         |
| Merge                         | ~107       | Temporal merge of multiple sources              |
| Tap                           | ~10        | Pass-through observation                        |
| ondrain                       | ~28        | Backpressure drain notification                 |
| 3 extra backpressure policies | ~150       | drop-oldest, drop-newest, block (beyond strict) |
| Protocol symbols              | ~50        | Extensibility via well-known symbols            |
| **Total unique cost**         | **~2,438** |                                                 |

Coincidentally, both APIs invest approximately the same amount of code (~2,400 lines) in
features unique to them. The difference is in _what_ that investment buys:

- Web Streams spends it on **BYOB** (a single specialized feature), **spec ceremony**
  (validators, brand checks, promise management), and **pluggable strategies**.
- New Streams spends it on **breadth of functionality** (sync variants, broadcast, share,
  duplex, consumers, merge, tap, multiple backpressure policies).

---

## 4. Structural Complexity

Beyond line counts, the implementations differ fundamentally in how complexity is
structured.

### 4.1 Indirection Depth

**Web Streams — a single read operation traverses 6+ functions across 4+ files:**

```
reader.read()
  → ReadableStreamDefaultReaderRead(reader)                  [default-reader.ts]
    → controller[PullSteps](readRequest)                     [symbol dispatch]
      → ReadableStreamDefaultControllerCallPullIfNeeded()    [default-controller.ts]
        → user's pull() callback
          → controller.enqueue(chunk)
            → ReadableStreamDefaultControllerEnqueue()       [default-controller.ts]
              → ReadableStreamFulfillReadRequest()           [default-reader.ts]
                → readRequest._chunkSteps(chunk)             [resolves promise]
```

8 function calls, 4 files, 1 symbol dispatch, 1 callback, 1 queue check.

**New Streams — same operation:**

```
for await (const chunks of readable)
  → PushQueue.read()                                         [push.ts]
    → (if data available) return immediately
    → (if no data) create pending read promise
      → writer.write(data)
        → PushQueue.writeSync()                              [push.ts]
          → resolve pending read
```

2–3 function calls, 1 file, direct resolution.

### 4.2 State Machine Complexity

**Web Streams** has 4 explicit state machines with complex interactions:

1. **ReadableStream**: 3 states (`readable` → `closed` | `errored`)
2. **WritableStream**: 4 states (`writable` → `erroring` → `errored`, `writable` → `closed`)
   - The transitional `erroring` state exists because in-flight operations must complete
     before the stream can finalize the error. This requires tracking `_inFlightWriteRequest`,
     `_inFlightCloseRequest`, and `_pendingAbortRequest` (a 5-field struct) simultaneously.
3. **Writer closed promise**: 3 states (`pending` | `resolved` | `rejected`)
4. **Writer ready promise**: 3 states (`pending` | `fulfilled` | `rejected`)

Plus implicit state machines:
- Controller pull state (`_pulling` × `_pullAgain` = 4 combinations)
- TransformStream backpressure (`_backpressure` boolean + `_backpressureChangePromise`)

**New Streams** has 2 explicit state machines:

1. **WriterState**: 3 states (`open` → `closed` | `errored`)
2. **ConsumerState**: 3 states (`active` → `returned` | `thrown`)

No transitional states, no in-flight tracking, no promise state machines. The elimination
of the `erroring` transitional state is notable — New Streams handles the same scenarios
through simpler mechanisms (the RingBuffer of pending writes rejects remaining promises
on error, without needing an intermediate state).

### 4.3 Abstraction Overhead

Web Streams has several categories of code that exist purely due to its architectural
choices, not because of feature requirements:

| Category                     | Code Lines | Why it exists                                       |
| ---------------------------- | ---------- | --------------------------------------------------- |
| Controllers (3 classes)      | ~1,700     | Mediate between streams and sources/sinks           |
| Readers (2 classes + shared) | ~500       | Required to consume a ReadableStream                |
| Brand checks                 | ~130       | Verify class instances at API boundaries            |
| Promise management           | ~200       | Track resolve/reject slots and promise states       |
| Algorithm clearing           | ~25        | Null closure references for GC                      |
| WebIDL validators            | ~427       | Spec-compliant argument processing                  |
| **Total overhead**           | **~2,982** | **~53% of code lines are architectural ceremony**   |

New Streams avoids all of these categories:
- No controllers (the queue IS the stream)
- No reader objects (iterables are consumed directly)
- No brand checks (interfaces, not classes)
- No manual promise lifecycle (create promises directly)
- No algorithm clearing (generators clean up via `finally`)
- No WebIDL layer (simple inline guards)

### 4.4 File Organization

**Web Streams**: 45 files organized by spec structure (one file per class, one file per
set of abstract operations, separate validator files). The deepest import chain is 4 levels.
Circular dependencies exist between `readable-stream.ts` and `writable-stream.ts`
(ReadableStream.pipeTo needs WritableStream; pipe.ts imports from writable-stream).

**New Streams**: 11 files organized by feature (push, pull, from, broadcast, share,
consumers, duplex, plus shared types/utils/ringbuffer). No circular dependencies. Maximum
import depth is 3 (push → pull → from).

---

## 5. Conceptual Complexity

How many distinct concepts must an implementer understand?

### Web Streams Concepts (21)

1. ReadableStream class and internal slots
2. WritableStream class and internal slots
3. TransformStream class and internal slots
4. ReadableStreamDefaultReader + lock semantics
5. ReadableStreamBYOBReader + BYOB semantics
6. ReadableStreamDefaultController + pull scheduling
7. ReadableByteStreamController + pull-into descriptors
8. ReadableStreamBYOBRequest
9. WritableStreamDefaultWriter + ready/closed promise management
10. WritableStreamDefaultController + queue processing
11. TransformStreamDefaultController + backpressure change promises
12. QueuingStrategy abstraction (size functions, two classes)
13. Queue-with-sizes (value + size pair tracking)
14. Stream state machines (readable: 3 states, writable: 4 states)
15. Promise lifecycle management (resolve/reject slot tracking, state enum)
16. Brand checking pattern
17. Algorithm clearing pattern
18. WebIDL validation rules
19. Pipe algorithm (4-directional error/close/abort propagation)
20. Tee algorithm (default + byte variants)
21. ArrayBuffer transfer/detach semantics (for BYOB)

### New Streams Concepts (16)

1. `AsyncIterable<Uint8Array[]>` as the stream primitive
2. Writer interface (async + sync methods)
3. Push stream (bonded writer/readable pair)
4. Pull pipeline (source → transforms → iterable)
5. Transform functions (stateless function vs. stateful object)
6. Backpressure policies (strict, block, drop-oldest, drop-newest)
7. Source normalization (from/fromSync)
8. PipeTo semantics (preventClose, preventFail)
9. Consumer functions (bytes, text, array, arrayBuffer)
10. Broadcast (push-model multi-consumer)
11. Share (pull-model multi-consumer)
12. Duplex channels
13. Protocol symbols (toStreamable, drainableProtocol, etc.)
14. AbortSignal integration
15. RingBuffer data structure
16. Merge semantics

**Concept count: 21 vs. 16**. But the difference in _concept depth_ is more significant
than the difference in count. Web Streams concepts 1–11 are all deeply coupled classes
with their own state, lifecycle, and interactions. New Streams concepts 1–5 are the core
(iterables, interfaces, functions), with 6–16 being relatively independent features
built on top.

---

## 6. Where New Streams Is More Complex

The comparison is not uniformly in New Streams' favor. Several areas show greater
complexity:

**Multi-consumer patterns** (1,092 vs. 122 lines): Broadcast and Share are substantially
more complex than tee. However, they are also more capable — supporting N consumers,
bounded buffers, 4 backpressure policies, and both push-model and pull-model variants.
Tee supports exactly 2 consumers with unbounded internal buffering.

**Sync variants** (~600 lines): Web Streams has no synchronous API. New Streams provides
complete sync variants for all major operations. This is additive code volume, though
each sync variant closely mirrors its async counterpart.

**Backpressure policies** (~150 lines): Web Streams has one implicit backpressure model
(equivalent to New Streams' `block` mode). New Streams implements four policies including
`strict` (which actively catches fire-and-forget patterns), `drop-oldest`, and
`drop-newest`.

**Consumer utilities** (349 lines): Web Streams provides no built-in consumers — users
must manually loop with `reader.read()`. New Streams includes `bytes()`, `text()`,
`array()`, `arrayBuffer()`, `merge()`, `tap()`, and `ondrain()`.

In all these cases, New Streams is more complex because it provides more functionality,
not because equivalent functionality requires more code.

---

## 7. Key Drivers of Complexity Difference

The 2x overall code reduction (and 5x reduction in the core producer-consumer path) stems
from a small number of fundamental architectural decisions:

### 7.1 Iterables vs. Classes

**Web Streams**: Streams are class instances that must be consumed through reader objects.
This requires: a stream class, a reader class (or two), lock management, reader
acquisition/release, and a closed promise lifecycle.

**New Streams**: Streams are `AsyncIterable<Uint8Array[]>`. Consumption is `for await...of`.
No reader class, no locks, no acquisition, no closed promise management. The language
runtime handles the iterator protocol.

**Impact**: Eliminates ~500 lines of reader code and ~200 lines of promise management.

### 7.2 No Controller Layer

**Web Streams**: Controllers are interposed between streams and their sources/sinks.
Every data operation (enqueue, pull, cancel, error) routes through the controller, which
manages its own queue, pull scheduling, and state. Three controller classes add ~1,700
lines.

**New Streams**: No controllers exist. The queue (PushQueue, BroadcastImpl, ShareImpl)
directly manages data flow. This removes an entire architectural layer and the indirection
it creates.

**Impact**: Eliminates ~1,700 lines of controller code and reduces the indirection depth
of every operation from ~8 calls to ~3.

### 7.3 Bytes-Only + Operation-Count Backpressure

**Web Streams**: Supports arbitrary value types (`ReadableStream<R>`) with pluggable
size functions. The queuing strategy abstraction, queue-with-sizes, and `{value, size}`
pair tracking exist to support byte-counting and custom sizing.

**New Streams**: Exclusively `Uint8Array`. Backpressure counts write operations, not
bytes. No queuing strategy classes, no size functions, no `{value, size}` pairs.

**Impact**: Eliminates ~250 lines of strategy/sizing code and removes type parameterization
throughout.

### 7.4 Generators vs. Manual Promise Chains

**Web Streams**: Pipeline orchestration (transforms, piping) uses manually constructed
promise chains. Error propagation requires explicit routing through 4-directional
shutdown logic.

**New Streams**: Pipelines are generator chains. Error propagation uses native
try/catch/finally. Pipeline teardown is handled by generator `.return()`. The language
runtime does the work that Web Streams implements manually.

**Impact**: Reduces transform pipeline code from ~889 to ~259 lines. Reduces pipe
algorithm from ~297 to ~132 lines.

### 7.5 No BYOB

**Web Streams**: BYOB (Bring Your Own Buffer) readers and byte stream controllers add
~1,445 lines — the single most complex subsystem, representing 20% of the entire
implementation. Pull-into descriptors (9 fields each), partial buffer filling, alignment
constraints, and ArrayBuffer transfer semantics create deep complexity.

**New Streams**: Deliberately omits BYOB. Data is passed by reference (`Uint8Array` chunks);
no buffer transfer, no pull-into descriptors, no alignment tracking. The design document
notes that BYOB's "zero-copy" is misleading — data is still copied into the consumer
buffer; only allocation is amortized — and that batched iteration provides better GC
pressure reduction.

**Impact**: Eliminates ~1,445 lines and the single most complex state management in the
entire Web Streams spec.

### 7.6 No Spec Ceremony

**Web Streams**: As a formal web standard, the implementation carries overhead from
WebIDL compliance (argument validation, dictionary conversion, callback wrapping),
brand checking (verifying class instances at every API boundary), and algorithm clearing
(nulling closure references for GC safety). These are necessary for a spec-compliant
implementation but add no user-visible functionality.

**New Streams**: Validates inputs with simple type guards. Uses interfaces instead of
classes (no brand checks needed). Generators handle cleanup naturally (no algorithm
clearing).

**Impact**: Eliminates ~780 lines of spec ceremony (validators + brand checks + promise
management + algorithm clearing).

---

## 8. Runtime Implementations

The reference polyfill provides a clean baseline, but proponents of Web Streams may argue
it is not representative of real-world implementations. This section examines the three
major production implementations to determine whether runtime-specific optimizations reduce
the complexity or whether the spec's inherent complexity carries through.

### 8.1 Overview

|                          | Polyfill   | Node.js       | Deno            | Chromium/Blink              |
| ------------------------ | ---------- | ------------- | --------------- | --------------------------- |
| Language                 | TypeScript | JS + C++      | JS + Rust       | C++ + IDL                   |
| Source files             | 45         | 9             | 3 (+ Rust)      | 91 (28 .cc, 37 .h, 21 .idl) |
| Total lines              | 7,671      | 7,839         | ~8,118          | ~15,000+ *                  |
| Code lines               | 5,668      | 6,227         | ~7,000          | ~12,000+ *                  |
| Classes                  | 14         | 24            | 17              | ~26+                        |
| Functions/operations     | ~150       | 228           | 184             | ~200+ **                    |
| Runtime-specific lines   | 0          | ~1,380        | ~1,150          | ~3,000+                     |

\* Chromium estimate includes .cc and .h files but excludes auto-generated V8 binding code
from IDL definitions and test files. The actual developer-maintained surface is larger.

\** Chromium functions are harder to count precisely due to the header/implementation split.

**Key finding: Every production runtime is larger than the polyfill, not smaller.** The
spec's inherent complexity is the floor, and runtime concerns only add to it.

### 8.2 Node.js (7,839 lines, 6,227 code)

Node.js implements Web Streams in 9 JavaScript files within `lib/internal/webstreams/`.

**Architecture**: A near-direct translation of the spec algorithms into JavaScript, with
primordials for prototype pollution protection and C++ bindings for performance-critical
operations.

| File                   | Code Lines | Purpose                                          |
| ---------------------- | ---------- | ------------------------------------------------ |
| `readablestream.js`    | 2,844      | ReadableStream + all controllers/readers         |
| `writablestream.js`    | 1,158      | WritableStream + writer + controller             |
| `adapters.js`          | 780        | Classic streams ↔ web streams adapters           |
| `transformstream.js`   | 556        | TransformStream + controller                     |
| `transfer.js`          | 264        | Worker thread stream transfer                    |
| `util.js`              | 244        | Shared utilities + queue + brand checks          |
| `encoding.js`          | 154        | TextEncoderStream / TextDecoderStream            |
| `compression.js`       | 132        | CompressionStream / DecompressionStream          |
| `queuingstrategies.js` | 95         | ByteLengthQueuingStrategy / CountQueuingStrategy |

**Runtime-specific additions (~1,380 lines):**

- **Classic stream adapters** (`adapters.js`, 780 lines): Bidirectional conversion between
  `stream.Readable`/`Writable`/`Duplex` and `ReadableStream`/`WritableStream`. Also provides
  low-level `StreamBase` adapters using C++ `WriteWrap`/`ShutdownWrap` bindings for direct
  native I/O. Entirely Node.js-specific.

- **Worker thread transfer** (`transfer.js`, 264 lines + ~50 in each stream class):
  Structured clone/transfer via `MessagePort` using `[kTransfer]`/`[kDeserialize]` methods.
  Includes `CrossRealmTransformReadableSource`/`CrossRealmTransformWritableSink` classes.

- **Primordials**: ~94 unique primordial references throughout — `ArrayPrototypePush`,
  `PromisePrototypeThen`, `FunctionPrototypeCall`, etc. Captures built-in prototypes at
  startup to prevent prototype pollution. Adds ~15–20% boilerplate to every file.

- **C++ bindings**: 9 `internalBinding()` calls for `DOMException`, buffer copying, promise
  state inspection, and native stream I/O.

- **Defensive programming**: 133 `assert()` invariant checks across the implementation.

**Notable**: `readablestream.js` alone is 3,498 lines — larger than the entire New Streams
implementation (3,307 code lines). It contains 10 classes and 107 standalone functions.
The BYOB byte controller consumes ~800 lines of this file.

### 8.3 Deno (7,286 JS + 752 Rust = ~8,118 lines)

Deno implements Web Streams as a monolithic JavaScript file backed by a Rust native
channel for high-performance I/O bridging.

**Architecture**: `06_streams.js` is a single 7,286-line file containing the complete
WHATWG spec implementation. It defines 17 classes, 184 standalone functions, and 67
symbol-based private slots. The Rust layer (`stream_resource.rs`, 752 lines) provides a
high-performance `BoundedBufferChannel` for bridging JS ReadableStreams to native resources.

**Runtime-specific additions (~1,150 lines):**

- **Native resource bridging** (~400 lines JS + 752 lines Rust):
  `readableStreamForRid(rid)` creates a ReadableStream backed by a native resource ID;
  `resourceForReadableStream(stream)` wraps a JS ReadableStream as a native resource via
  the Rust `BoundedBufferChannel`. The Rust side implements a lock-free ring buffer with
  64KB backpressure limit, 1KB write aggregation, and waker-based async polling.

- **Primordials**: ~80 primordial imports for prototype pollution protection, same
  pattern as Node.js.

- **WebIDL converters**: ~470 lines of dictionary/type validation using Deno's `webidl`
  module.

- **FinalizationRegistry**: Two registries for ensuring Rust channels and native resource
  IDs are cleaned up even if streams are garbage collected without explicit close.

**Notable**: The Rust `BoundedBufferChannel` (400 lines) represents systems-level
optimization that a pure JS implementation cannot achieve — `unsafe` ring buffer operations,
zero-copy buffer passing, and OS-level waker integration. This is complexity driven by
the need to bridge Web Streams' JavaScript-level ceremony to acceptable native I/O
performance.

### 8.4 Chromium/Blink (~15,000+ lines C++)

Chromium implements Web Streams in pure C++ within the Blink rendering engine.

**Architecture**: 91 files total (28 .cc, 37 .h, 21 .idl). Each spec class maps to a
C++ class inheriting from `ScriptWrappable` (Blink's base for C++ objects exposed to JS).
IDL files define the JavaScript-facing interface; Blink's code generator produces V8
binding glue code. The implementation uses Oilpan garbage collection (`GarbageCollected<>`,
`Member<>`, `Trace()` methods).

**Approximate .cc line counts for key files:**

| File                                    | Lines       |
| --------------------------------------- | ----------- |
| `readable_byte_stream_controller.cc`    | ~1,760      |
| `readable_stream.cc`                    | ~1,340      |
| `writable_stream.cc`                    | ~1,030      |
| `writable_stream_default_controller.cc` | ~580        |
| `writable_stream_default_writer.cc`     | ~530        |
| `transform_stream.cc`                   | ~580        |
| `readable_stream_default_controller.cc` | ~530        |
| `pipe_to_engine.cc`                     | ~530        |
| `miscellaneous_operations.cc`           | ~530        |
| `tee_engine.cc`                         | ~430        |
| 12 other production .cc files           | ~2,500      |
| **Total .cc**                           | **~10,370** |
| **Total .h (estimated)**                | **~4,000+** |

**C++ amplification factors** — things that don't exist in the JS polyfill:

- **Header/implementation split**: Every class needs both a `.h` and `.cc` file, roughly
  doubling the file count. Headers contain class declarations, forward declarations,
  include guards, and Oilpan `Trace()` declarations.

- **GC integration**: Every class has `Trace()` methods that visit all `Member<>` pointers.
  Every stored reference uses `Member<T>` (GC-traced pointer) or
  `TraceWrapperV8Reference<>` (prevents GC of stored V8 values).

- **V8 binding ceremony**: Values pass between C++ and JavaScript as `v8::Local<v8::Value>`
  with explicit `v8::Isolate*` and `ScriptState*` management. Promise handling uses
  `ScriptPromise<>`, `ScriptPromiseResolver<>`, and explicit `ThenCallable<>` subclasses
  (since C++ has no closures, each promise reaction requires a separate GC'd class).

- **Algorithm classes**: Spec algorithm callbacks (pull, cancel, write) are represented as
  C++ abstract base classes (`StreamAlgorithm`, `StreamStartAlgorithm`,
  `StrategySizeAlgorithm`) with virtual `Run()` methods. Each concrete algorithm requires
  a separate class definition.

- **IDL definitions**: 21 `.idl` files define the JavaScript-facing interface and generate
  additional binding code.

- **C++ API for browser internals**: `UnderlyingSourceBase`, `UnderlyingSinkBase`, and
  `UnderlyingByteSourceBase` are abstract C++ classes that browser APIs (Fetch, WebSocket,
  etc.) subclass to create streams without JavaScript. Plus transferable stream optimizers
  for cross-worker streaming.

**Notable**: `readable_byte_stream_controller.cc` at ~1,760 lines is the largest single
file — the BYOB complexity is the dominant cost in C++ just as it is in JavaScript. The
pipe-to algorithm required its own class (`PipeToEngine`) because C++ cannot express the
spec's closure-heavy pipe algorithm as a single function.

### 8.5 Cross-Implementation Patterns

Several patterns emerge consistently across all four implementations:

**1. The spec's architectural complexity is faithfully reproduced everywhere.**

Every implementation I examined has the same class hierarchy, the same controller mediation
layer, the same reader/writer indirection, and the same state machines. None found a way
to simplify the spec's architecture while remaining compliant. The class/controller/reader
pattern is not an artifact of the polyfill — it is inherent to the specification.

**2. BYOB is universally the most complex subsystem.**

| Implementation | BYOB complexity (approximate)               |
| -------------- | ------------------------------------------- |
| Polyfill       | ~1,445 code lines (19.6% of total)          |
| Node.js        | ~800 lines of readablestream.js (~13%)      |
| Deno           | ~600 lines of 06_streams.js (~8%)           |
| Chromium       | ~1,760 lines .cc + headers (~12%+)          |

BYOB requires pull-into descriptors (9 fields each), partial buffer filling, byte
alignment, ArrayBuffer transfer/detach semantics, and coordination between two reader
types on a single controller. This complexity appears in every implementation.

**3. Runtime concerns are strictly additive.**

No runtime optimization offsets the spec's inherent complexity. Instead, each runtime
adds 1,000–3,000+ lines for:
- Worker/process transfer (structured clone over MessagePort)
- Native I/O bridging (libuv, Rust ops, C++ StreamBase)
- Legacy API interop (Node.js classic streams ↔ web streams)
- Security hardening (primordials, brand checks)
- GC integration (Oilpan in Chromium, FinalizationRegistry in Deno)

**4. Promise management is a universal pain point.**

| Implementation | Promise management approach                             |
| -------------- | ------------------------------------------------------- |
| Polyfill       | 23 named helper functions wrapping `new Promise`        |
| Node.js        | 39 `PromiseWithResolvers()` + 80 direct calls           |
| Deno           | `Deferred` class (107 lines) + direct calls             |
| Chromium       | `ScriptPromiseResolver<>` + `ThenCallable<>` subclasses |

Web Streams requires manually tracking promise resolve/reject functions and promise states
because the spec's algorithms need to resolve/reject promises created in one function from
a different function at a later time. This pattern is awkward in every language.

**5. C++ amplifies the complexity dramatically.**

Chromium's implementation is roughly **2–3x** the polyfill by line count, primarily because:
- No closures → every callback requires a separate class
- No destructuring → verbose parameter passing
- Header/implementation split → doubled file count
- GC ceremony → `Member<>`, `Trace()`, `ScriptWrappable` on every class
- V8 interop → explicit isolate/context management on every API boundary

This is the strongest argument for New Streams' simpler architecture: the architectural
decisions that save lines in TypeScript would save **even more** in C++/Rust, because
each eliminated class, state machine, and indirection layer avoids the C++ amplification
factor.

### 8.6 Hypothesis: Projected Runtime Overhead for New Streams

A real-world New Streams implementation would face the same runtime concerns that current
Web Streams implementations face: legacy stream adapters, worker transfer, native I/O
bridging, security hardening, and platform API integration. The question is whether New
Streams' architectural simplifications reduce these runtime costs too, or only the core
spec cost.

To answer this, I analyzed every runtime-specific integration point in the Node.js Web
Streams implementation in detail, then projected what the equivalent New Streams
integration would require.

#### 8.6.1 Legacy Stream Adapters

Node.js dedicates 780 code lines to 8 adapter functions bridging classic streams
(`stream.Readable`/`Writable`/`Duplex`) to/from Web Streams. Analysis of each function
reveals that ~32% of the code (300 lines) is pure Web Streams ceremony — controller
capture patterns, underlying source/sink construction, strategy selection, `getReader()`
/`getWriter()` locking, `reader.closed`/`writer.closed` monitoring, and
`controller.enqueue()`/`controller.error()` indirection.

The projected reductions per adapter function:

| Adapter                       | Current | Projected | Reduction | Why                                                      |
| ----------------------------- | ------- | --------- | --------- | -------------------------------------------------------- |
| Node Writable → stream writer | 104     | ~20       | 81%       | Writer is a plain interface; no controller               |
| Stream writer → Node Writable | 164     | ~60       | 63%       | No `writer.ready` gate or `writer.closed` monitoring     |
| Node Readable → stream source | 101     | ~1        | 99%       | `Stream.from(nodeReadable)` — it's already AsyncIterable |
| Stream source → Node Readable | 80      | ~35       | 56%       | No reader locking, simpler iteration                     |
| Duplex → stream pair          | 46      | ~10       | 78%       | AsyncIterable + Writer wrapper                           |
| Stream pair → Duplex          | 210     | ~70       | 67%       | No dual reader/writer/closed monitoring                  |
| StreamBase → stream writer    | 71      | ~45       | 37%       | Complexity is inherent to C++ binding                    |
| StreamBase → stream source    | 67      | ~40       | 40%       | Complexity is inherent to C++ binding                    |
| **Total**                     | **843** | **~281**  | **67%**   |                                                          |

The most dramatic case: converting a Node.js `stream.Readable` to a stream source goes
from 101 lines to a **one-liner** because Node.js `stream.Readable` already implements
`Symbol.asyncIterator` — and New Streams consumes `AsyncIterable<Uint8Array[]>` natively.
Web Streams cannot leverage this because it requires wrapping in a `ReadableStream` with
an underlying source, controller, and strategy.

#### 8.6.2 Platform API Integration

Node.js APIs like `FileHandle`, `Blob`, and compression/encoding use Web Streams
internally. Analysis reveals that a large fraction of each integration's code is
dedicated to constructing ReadableStream/WritableStream/TransformStream wrappers rather
than doing actual work:

| Integration Point                | Total Lines | Ceremony | Domain Logic | Ceremony/Total * |
| -------------------------------- | ----------- | -------- | ------------ | ---------------- |
| `FileHandle.readableWebStream()` | ~37         | ~22      | ~3           | ~59%             |
| `Blob.stream()`                  | ~63         | ~55      | ~8           | ~87%             |
| `CompressionStream`              | ~50         | ~35      | ~20          | ~70%             |
| `DecompressionStream`            | ~60         | ~40      | ~20          | ~67%             |
| `TextEncoderStream`              | ~84         | ~40      | ~35          | ~48%             |
| `TextDecoderStream`              | ~82         | ~40      | ~30          | ~49%             |

\* Ceremony as a fraction of total lines. The remaining lines (not ceremony, not domain
logic) are shared concerns like state validation and imports that would be present
regardless of API. For FileHandle specifically, §8.7.6 provides a verified measurement
of 63% ceremony against 52 code lines.

The pattern is consistent: each integration must navigate a multi-step ceremony of
controller capture, underlying source/sink construction, strategy selection, and manual
backpressure signaling. With New Streams, the same integrations become generators or
protocol implementations:

- **FileHandle**: A `readableWebStream()` that constructs a ReadableStream with BYOB
  request protocol handling (~37 lines) becomes an async generator that yields chunks
  (~10 lines). The BYOB ceremony (`controller.byobRequest.view` → read → `respond(n)`)
  is replaced by `yield buf.subarray(0, bytesRead)`.

- **Blob**: A `stream()` that creates a ReadableStream with manual backpressure tracking
  via a `pendingPulls` array and `desiredSize` checks (~63 lines) becomes a generator
  where backpressure is implicit in `yield` (~10 lines).

- **Compression/encoding**: Each `TransformStream` class (~50–84 lines) becomes a
  transform function (~15–30 lines). No `.readable`/`.writable` pair, no
  `controller.enqueue()`, no `controller.terminate()`.

**Projected total for platform integration**: ~65–100 lines vs. ~376 lines currently
(73–83% reduction).

#### 8.6.3 Worker Transfer

Node.js dedicates ~364 lines to cross-worker stream transfer (264 in `transfer.js` + ~100
across stream class `[kTransfer]`/`[kDeserialize]` methods). The bulk is
`CrossRealmTransformReadableSource` and `CrossRealmTransformWritableSink` — classes that
bridge a `MessagePort` to the Web Streams controller protocol, with hand-rolled
backpressure via `PromiseWithResolvers` state machines.

With New Streams, cross-worker transfer simplifies because:
- The readable side is an async generator yielding from `port.onmessage` — backpressure
  is implicit in the generator's `yield`.
- The writable side consumes an iterable and posts chunks — backpressure uses a single
  `await waitForPull(port)` instead of the `PromiseWithResolvers` dance.
- No controllers, no underlying source/sink objects, no strategy wiring.
- Only push streams (writer/readable pairs) need transfer; pull pipelines and iterables
  are consumed in place.

**Projected**: ~120–150 lines vs. ~364 lines currently (59–67% reduction).

#### 8.6.4 Security Hardening (Primordials)

Node.js and Deno both use primordials for prototype pollution protection, adding ~15–20%
boilerplate. This cost is **API-independent** ��� it would apply equally to a New Streams
implementation. However, because there is less code overall, the absolute cost is lower.

**Projected overhead**: ~500–660 lines of primordials boilerplate on the core
implementation (same percentage, lower base).

#### 8.6.5 Aggregate Projection: Node.js

| Component                            | Web Streams (current) | New Streams (projected) |
| ------------------------------------ | --------------------: | ----------------------: |
| Core spec implementation             | 4,558 *               | ~3,800 **               |
| Classic stream adapters              | 780                   | ~280                    |
| Worker thread transfer               | 364                   | ~135                    |
| Platform API integration             | 376                   | ~80                     |
| Encoding/compression transforms      | 286                   | ~140                    |
| Queuing strategies                   | 95                    | 0                       |
| Utilities/shared                     | 244                   | ~150                    |
| Assertions/invariants                | (included)            | ~80                     |
| **Total**                            | **~6,700 ***          | **~4,665**              |

\* Core = the 6,227 code lines within `lib/internal/webstreams/` minus adapters (780),
transfer (264), encoding (154), compression (132), strategies (95), and utilities (244).
The ~6,700 total additionally includes ~476 lines of Web Streams integration code outside
the webstreams/ directory (platform API ceremony in FileHandle, Blob, etc., plus transfer
code distributed across stream class files).

\** Includes primordials overhead (~15–20% over the 3,307-line reference implementation).

**Projected reduction: ~30% fewer total lines than the current Web Streams
implementation.** The savings come from both the simpler core (~17% smaller) and
dramatically simpler runtime integration (adapters 64% smaller, transfer 63% smaller,
platform integration 79% smaller).

#### 8.6.6 Aggregate Projection: Chromium (C++)

For Chromium, the amplification factor matters most. Each eliminated Web Streams
abstraction avoids not just the TypeScript code, but the C++ header, implementation,
GC tracing, V8 binding, and IDL definition that come with it.

| Component                        | Web Streams (current) | New Streams (projected) |
| -------------------------------- | --------------------: | ----------------------: |
| Core spec classes + operations   | ~10,000 (.cc)         | ~4,500                  |
| Headers                          | ~4,000 (.h)           | ~2,000                  |
| IDL definitions                  | ~500 (21 files)       | ~200 (8-10 files)       |
| Browser API integration bases    | ~500                  | ~300                    |
| Transfer support                 | ~400                  | ~200                    |
| **Total (hand-written)**         | **~15,400**           | **~7,200**              |

**Projected reduction: ~53% fewer lines of hand-written C++.** The eliminated classes
(2 readers, 3 controllers, BYOB request, 2 queuing strategies) each avoid 200–1,760
lines of C++ plus their headers, GC tracing, and IDL files. The single largest savings
is the byte stream controller (~1,760 .cc + ~300 .h = ~2,060 lines eliminated).

### 8.7 Verification: Actual Node.js Port

An actual Node.js port of the New Streams API exists at `lib/internal/streams/new/`
in the Node.js tree. This section compares the hypothesis from §8.6 against measured
data from the real implementation.

#### 8.7.1 Overall Size

| Metric                         | TS Reference | Node.js Port | Delta          |
| ------------------------------ | -----------: | -----------: | -------------- |
| Source files                   | 11           | 11           | same count *   |
| Total lines                    | 5,615        | 4,686        | −929 (−16.5%)  |
| Code lines (no blanks/comments)| 3,307        | 3,371        | +64 (+1.9%)    |

\* The TypeScript reference has `index.ts` (re-exports, 130 code lines); the Node.js
equivalent is `lib/stream/new.js` (134 code lines), the public entry point for
`require('stream/new')`. It lives outside the `lib/internal/streams/new/` directory
and is not counted in the port's 11 files above. The Node.js port additionally has
`transform.js` (325 code lines of native zlib compression transforms) which has no
TypeScript equivalent. Excluding `transform.js`, the 10 shared modules have 3,177 vs.
3,046 code lines — the Node.js port is **4.1% smaller** for equivalent functionality.

The total-line reduction (−16.5%) is larger than the code-line change (+1.9%) because
TypeScript source carries substantial type annotations and JSDoc-style documentation
that become plain comments or disappear entirely in the JavaScript port. The code logic
itself is nearly identical.

#### 8.7.2 File-by-File Comparison

| Module       | TS Code | Node Code | Delta  | Notes                                  |
| ------------ | ------- | --------- | ------ | -------------------------------------- |
| broadcast    | 574     | 583       | +9     | Near-identical                         |
| consumers    | 349     | 347       | −2     | Near-identical                         |
| duplex       | 52      | 56        | +4     | Near-identical                         |
| from         | 365     | 388       | +23    | Extra Node.js source normalizers       |
| pull         | 533     | 514       | −19    | Slightly tighter without type guards   |
| push         | 426     | 438       | +12    | Near-identical                         |
| ringbuffer   | 91      | 92        | +1     | Near-identical                         |
| share        | 518     | 539       | +21    | Near-identical                         |
| types        | 209     | 18        | −191   | TS interfaces → JS exports symbols only|
| utils        | 60      | 71        | +11    | Extra Node.js validation helpers       |
| **Shared**   |**3,177**|**3,046**  |**−131**|                                        |
| index (TS)   | 130     | —         | —      | Barrel re-exports, not needed in CJS   |
| transform (Node) | —   | 325       | —      | Native zlib, no TS equivalent          |
| **Total**    |**3,307**|**3,371**  |**+64** |                                        |

The dominant pattern: **files are algorithmically equivalent**, with deltas of ≤ 23 lines
in either direction. The `types` module shows the expected −191 because TypeScript
interfaces and type aliases (Writer, Transform, PushOptions, etc.) have no JavaScript
representation — the Node.js version exports only the protocol symbols.

71.6% of the code lines (all shared modules except types) translate essentially 1:1 from
TypeScript to JavaScript, confirming that the reference implementation is not inflated by
TypeScript-specific overhead.

#### 8.7.3 Node.js Integration Overhead

The hypothesis in §8.6.4 predicted ~15–20% overhead from primordials and Node.js
integration boilerplate. Measured data:

| Category                        | Lines | % of port total (3,371) |
| ------------------------------- | ----: | ----------------------: |
| Primordials import blocks       | 96    | 2.8%                    |
| Primordials usage in body *     | ~144  | ~4.3%                   |
| `require()` / internal imports  | ~40   | ~1.2%                   |
| Error class imports (`ERR_*`)   | ~50   | ~1.5%                   |
| Validation calls (`validate*`)  | ~60   | ~1.8%                   |
| `internalBinding()` (transform) | 2     | <0.1%                   |
| **Total integration overhead**  |**~392**| **~11.6%**             |

\* Primordials body usage = call sites where `ArrayPrototypePush`, `PromisePrototypeThen`,
etc. replace direct method calls. Each adds ~1 line of overhead (wrapping).

The measured overhead (~11.6%) is slightly below the predicted 15–20%. The lower end is
explained by the port's relatively small per-file size — the primordials import block is
amortized across fewer body lines than in Node.js's Web Streams implementation (where
`readablestream.js` alone is 3,498 lines with 94 unique primordial references).

#### 8.7.4 The `transform.js` Addition

The Node.js port includes a file with no TypeScript equivalent: `transform.js` (463 total
lines, 325 code lines). This file provides native compression/decompression transforms
(gzip, deflate, brotli, zstd) by creating bare zlib handles via `internalBinding('zlib')`,
bypassing Node.js's existing `stream.Transform` / `ZlibBase` / `EventEmitter` machinery
entirely.

This is architecturally significant: rather than wrapping existing `zlib.createGzip()` etc.
(which are classic Node.js Transform streams), the port goes directly to the C++ binding
layer. Each factory returns a transform descriptor that plugs into `pull()` as a standard
transform — no stream construction, no event wiring, no adapter layer.

For comparison, Node.js's existing compression via Web Streams (`compression.js`, 132 code
lines) creates `TransformStream` instances with underlying transform objects, controller
capture, and manual flush/close orchestration. The New Streams version does the same work
in 325 code lines but covers **four** compression algorithms (gzip, deflate, brotli, zstd)
vs. two (gzip, deflate) — and each is a plain function, not a class.

#### 8.7.5 Hypothesis vs. Reality

The §8.6.5 aggregate projection predicted ~4,665 total lines for a Node.js New Streams
implementation. The actual port has 4,686 total lines — numerically close, but this
comparison requires qualification because the two measure different scopes. The projection
included components that the port does not yet have:

| Component                  | Projected | Actual  | Status                        |
| -------------------------- | --------- | ------- | ----------------------------- |
| Core implementation        | ~3,800    | 3,371   | ✓ 11.3% under projection      |
| Native transforms          | ???       | 325     | Unplanned addition            |
| Classic stream adapters    | ~280      | —       | Not yet implemented           |
| Worker thread transfer     | ~135      | —       | Not yet implemented           |
| Platform API integration   | ~80       | —       | Partial (FileHandle only)     |
| Encoding transforms        | ~140      | —       | Not yet implemented           |
| Utilities/shared           | ~150      | —       | Included in core              |
| Assertions                 | ~80       | —       | Included in core              |
| **Projected total**        | **4,665** | —       |                               |
| **Actual total (core)**    | —         |**4,686**| Core + native transforms      |

The core implementation came in 11.3% under the projection (3,371 vs. 3,800). The native
`transform.js` (325 lines) was an unplanned addition — the projection assumed encoding and
compression transforms would be adapters around existing Node.js classes, but the port
instead went directly to `internalBinding('zlib')`. This is more code in the port but
eliminates the need for a separate adapter layer.

If I adjust the projection to account for the same scope (core + native transforms, no
adapters/transfer/encoding yet), the prediction would have been ~3,800 + ~140 = ~3,940.
The actual is 4,686 — but 325 of those are the transform.js that replaces what would have
been separate adapter code. The effective comparison is ~3,940 projected vs. ~4,686 actual
core, with the difference largely explained by the transform.js file doing more work than
projected (covering 4 algorithms instead of 2, with full streaming flush semantics).

#### 8.7.6 Platform API Integration: FileHandle Case Study

The hypothesis in §8.6.2 predicted that platform API integrations would see 48–87%
ceremony reductions. The FileHandle implementation provides a direct test of this
prediction.

**`FileHandle.readableWebStream()`** (existing Web Streams integration):

| Metric              | Value | Detail                                           |
| ------------------- | ----: | ------------------------------------------------ |
| Total lines         | 64    | Lines 292–355                                    |
| Code lines          | 52    |                                                  |
| State checks        | 6     | fd, close, lock checks                           |
| Ceremony lines      | ~33   | ReadableStream construction, BYOB protocol,      |
|                     |       | `controller.byobRequest.view`, `respond(n)`,     |
|                     |       | `readableStreamCancel` import, `close()` event   |
| Core I/O            | ~3    | `readFn(view, ...)` + bytesRead check + close    |
| Ceremony ratio      | ~63%  |                                                  |

The ceremony includes: constructing a `new ReadableStream()` with a `{ type: 'bytes' }`
underlying source, setting `autoAllocateChunkSize`, accessing `controller.byobRequest.view`
to get the pre-allocated buffer, calling `controller.byobRequest.respond(bytesRead)` to
signal completion, calling `controller.close()` to end the stream, importing and calling
`readableStreamCancel` for handle-close cleanup, and function-binding `this.read`.

**`FileHandle.pull()`** (New Streams integration):

| Metric              | Value | Detail                                           |
| ------------------- | ----: | ------------------------------------------------ |
| Total lines         | 84    | Lines 365–448                                    |
| Code lines          | 73    |                                                  |
| State checks        | 6     | Same fd, close, lock checks                      |
| Ceremony lines      | 0     | No stream/controller/reader construction         |
| Core I/O            | ~15   | `binding.read()` → yield buffer, loop + cleanup  |
| Integration         | ~8    | Signal handling, transform pipeline delegation   |
| Ceremony ratio      | **0%**|                                                  |

The entire method is an async generator. The I/O loop is:

```javascript
const buf = Buffer.allocUnsafe(readSize);
bytesRead = await binding.read(fd, buf, 0, readSize, -1, kUsePromises);
if (bytesRead === 0) break;
yield [bytesRead < readSize ? buf.subarray(0, bytesRead) : buf];
```

No `ReadableStream` construction. No controller. No BYOB request protocol. No
`respond(n)`. No separate `readableStreamCancel` import. The generator's `finally` block
handles cleanup (unlock, unref, optional autoClose). If transforms are provided, a single
call to `newStreamsPull(source, ...transforms)` wraps the generator in a pull pipeline.

The `pull()` method is larger in total lines (84 vs. 64) because it handles more
functionality — signal-aware fast path, transform pipeline integration, and options parsing
that `readableWebStream()` does not support. But the ceremony ratio dropped from 63% to 0%:
every line of code is doing real work.

**`FileHandle.writer()`** (New Streams, no Web Streams equivalent):

| Metric              | Value | Detail                                           |
| ------------------- | ----: | ------------------------------------------------ |
| Total lines         | 158   | Lines 463–620                                    |
| Code lines          | 133   |                                                  |
| State checks        | 6     | Same fd, close, lock checks                      |
| Core I/O            | ~80   | writeAll (EAGAIN retry), writevAll (writev +     |
|                     |       | partial-write fallback), position tracking       |
| Interface methods   | ~35   | write, writev, end, fail, failSync, dispose      |
| Ceremony ratio      | **0%**|                                                  |

There is no Web Streams equivalent to compare against because Web Streams has no
concept of a writable file handle that a WritableStream could wrap without a complete
underlying sink + controller + writer + strategy construction (~250+ lines for the
equivalent). The New Streams writer is a plain closure object with `write()`, `writev()`,
`end()`, `fail()`, and `failSync()` methods — matching the Writer interface directly.

The `writev()` method is notable: it calls `binding.writeBuffers()` (a vectored write
syscall) directly, with partial-write handling that concatenates remaining buffers and
falls back to `writeAll()`. This is real I/O logic that Web Streams cannot express because
`WritableStream` has no concept of batch writes — `writer.write(chunk)` accepts exactly
one chunk at a time.

#### 8.7.7 Verification Summary

| Prediction                           | Projected    | Actual        | Assessment         |
| ------------------------------------ | ------------ | ------------- | ------------------ |
| Core implementation size             | ~3,800 lines | 3,371 lines   | ✓ 11% under        |
| Primordials overhead                 | 15–20%       | ~11.6%        | ✓ Slightly under   |
| Total Node.js implementation         | ~4,665 lines | 4,686 lines * | ~ (different scope) |
| FileHandle ceremony reduction        | 48–87%       | 63% → 0%      | ✓ Confirmed        |
| Platform APIs become generators      | Yes          | Yes           | ✓ Confirmed        |
| Writer maps directly to interface    | Yes          | Yes           | ✓ Confirmed        |
| No controller/reader construction    | Yes          | Yes           | ✓ Confirmed        |

\* The actual 4,686 lines include the core + an unplanned native transform module (325
lines) but exclude adapters, worker transfer, and encoding transforms that the projection
assumed. The comparison is approximate but the order of magnitude is correct.

The strongest verification signal is the **FileHandle case study**: the hypothesis
predicted that platform API integrations would have 48–87% ceremony ratios under Web
Streams. The actual `readableWebStream()` shows 63% ceremony. The New Streams `pull()`
replacement shows 0% ceremony — confirming not just the prediction's direction but
exceeding its magnitude. Every line of code in the New Streams integration is either
state validation (shared with the Web Streams version) or actual I/O work.

---

## 9. Conclusion

**The hypothesis holds — and the evidence from production runtimes strengthens the case.**

### Against the Reference Polyfill

For **equivalent features**, Web Streams requires **2x** the code. The core
producer-consumer pathway — the most fundamental streaming operation — shows a **5.1x**
difference. Both APIs invest roughly equal code (~2,400 lines each) in features unique
to them, but that investment buys different things: Web Streams spends it on BYOB and
spec ceremony, while New Streams spends it on breadth of functionality.

### Against Production Runtimes

Every production runtime implementation is larger than the polyfill. Runtime concerns
(worker transfer, native I/O bridging, legacy interop, security hardening, GC integration)
are strictly additive:

| Implementation    | Code Lines | vs. Polyfill (5,668) |
| ----------------- | ---------- | -------------------- |
| Node.js           | 6,227      | +9.9%                |
| Deno              | ~7,000     | +23.5%               |
| Chromium/Blink    | ~12,000+   | +112%+               |

These totals should not be compared directly against the core-only New Streams reference
(3,307 lines), which does not include adapters, worker transfer, or platform integration
code. The polyfill comparison (5,668 vs. 3,307, **1.7x**) remains the fairest same-scope
ratio. For like-for-like runtime comparisons, see the projected implementations below
(~30% reduction for Node.js, ~53% for Chromium).

Chromium/Blink (~12,000+ lines C++) is not directly comparable to the TypeScript
reference due to C++ amplification factors (header/implementation split, GC ceremony, no
closures, V8 binding overhead — see §8.5 point 5). The projected New Streams C++
implementation (§8.6.6) is ~7,200 lines vs. Chromium's ~15,400 — a **~53% reduction** in
hand-written C++, driven by the elimination of controllers, readers, BYOB, and the state
machines that accompany them.

No runtime I examined found a way to simplify the spec's controller/reader/state-machine
architecture — they all faithfully reproduce it.

### Runtime Integration Costs Are Also Reduced

The complexity advantage is not limited to the core implementation. Analysis of Node.js's
runtime integration code reveals that Web Streams ceremony accounts for 38–88% of each
integration point's code. New Streams' primitives — iterables, the Writer interface,
transform functions, and protocol symbols — align naturally with what runtimes already
have:

- Node.js `stream.Readable` is already an `AsyncIterable` — making the adapter a one-liner
- The `Writer` interface maps directly to `write()`/`end()`/`fail()` — no controller capture
- Generators provide implicit backpressure via `yield` — no `desiredSize` polling
- Transform functions replace `TransformStream` classes — no internal ReadableStream
  + WritableStream construction

Legacy stream adapters drop from ~843 to ~281 lines (67% reduction). Platform API
integrations like `FileHandle`, `Blob`, and compression streams see 48–87% ceremony
ratios.

### The Architectural Savings

The complexity reduction comes from **architectural decisions that eliminate structural
complexity**, not from doing less:

| Decision                          | Lines saved | Percentage of WS polyfill |
| --------------------------------- | ----------: | ------------------------: |
| Iterables replace stream classes  | ~700        | 9.5%                      |
| No controller layer               | ~1,700      | 23.1%                     |
| No BYOB                           | ~1,445      | 19.6%                     |
| No spec ceremony                  | ~780        | 10.6%                     |
| Generators replace promise chains | ~400        | 5.4%                      |
| Operation-count backpressure      | ~250        | 3.4%                      |
| **Total structural savings**      | **~5,275**  | **71.6%**                 |

These savings total more than the entire New Streams implementation (3,307 code lines),
which is why New Streams can provide more features in less code.

### Projected Runtime Implementations

| Runtime     | WS Current | NS Projected | Reduction |
| ----------- | ---------: | -----------: | --------: |
| Node.js     | ~6,700     | ~4,665       | ~30%      |
| Chromium    | ~15,400    | ~7,200       | ~53%      |

The reduction is larger for C++ implementations because each eliminated abstraction
avoids the C++ amplification factor (header/impl split, GC ceremony, V8 bindings, IDL
definitions). The single largest savings in Chromium is eliminating the byte stream
controller and BYOB request (~2,060 lines of C++).

### Verified Against an Actual Node.js Port

The projections are not purely theoretical. An actual Node.js port of the New Streams
core (§8.7) validates the hypothesis:

- **Core size**: 3,371 code lines — 11% under the 3,800-line projection
- **Runtime overhead**: ~11.6% from primordials and Node.js integration, consistent
  with the predicted 15–20%
- **Platform API ceremony**: FileHandle's `readableWebStream()` is 63% ceremony;
  the New Streams `pull()` replacement is **0% ceremony**
- **Architectural fit**: The port adds a `transform.js` (325 lines) that goes directly
  to `internalBinding('zlib')` — bypassing the entire `stream.Transform` / `ZlibBase` /
  `EventEmitter` stack. This was not predicted but demonstrates how New Streams'
  function-based transforms enable deeper integration than Web Streams' class-based
  `TransformStream` allows

The 10 shared modules translate at a 1:1 ratio from TypeScript to JavaScript (4.1%
smaller in the port), confirming that the reference implementation's complexity is
inherent to the design, not an artifact of TypeScript overhead.

---

## 10. Response to Critique

Domenic Denicola, the primary author of the Streams Standard, published a
[response](https://domenic.me/streams-standard/) to the New Streams proposal. This
section evaluates his arguments against the implementation complexity data I collected
above.

### 10.1 "Performance Problems Are Implementation Quality, Not Design"

Domenic's central argument is that the performance criticisms reflect naïve
implementations, not fundamental design problems. He draws an analogy to JavaScript
engines: if V8 implemented strings as a flat vector of 16-bit code units, nobody would
blame the ECMAScript spec for poor string concatenation performance. He argues that the
Streams Standard deliberately makes internal behavior unobservable so that implementations
can optimize aggressively.

This argument has theoretical merit, but my cross-implementation analysis challenges it
on three grounds: the optimizations are strictly additive, they are not universal, and the
spec's complexity cannot be opted out of.

**Optimizations are additive, not reductive.** Domenic's analogy implies that a
sophisticated implementation can optimize *away* the spec's complexity — that the
verbose spec algorithms are scaffolding that a mature implementation replaces with
something leaner. In practice, every production implementation I examined is larger than the
reference polyfill:

| Implementation  | Code Lines | vs. Polyfill |
| --------------- | ---------- | ------------ |
| WHATWG Polyfill | 5,668      | (baseline)   |
| Node.js         | 6,227      | +9.9%        |
| Deno            | ~7,000     | +23.5%       |
| Chromium/Blink  | ~12,000+   | +112%+       |

Line counts are an imperfect surrogate for complexity — C++ is naturally more verbose
than JavaScript, and Chromium's numbers reflect that. But the directional signal is
consistent across all three production implementations, including the JavaScript-based
ones: runtime concerns (worker transfer, native I/O bridging, legacy interop, security
hardening, GC integration) are strictly additive to the spec's inherent architectural
complexity. No implementation has optimized *below* the spec baseline. After 10+ years
of development, the optimizations that Domenic describes have made these implementations
*more* complex, not less.

**Optimizations are not universal.** The optimizations available to Web Streams
implementations are specific to particular integration points. Chromium's fetch body
optimizations (§10.2.2) work well when both ends are native-backed — but they do nothing
for server-side rendering scenarios where hundreds of custom `ReadableStream` instances
are created by application code. Promise elision helps when the engine can prove results
don't escape — but not when the spec requires passing promises across function boundaries
(see below). Each optimization is a local win for a specific use case, not a general
reduction in the cost of implementing the spec. The underlying spec machinery — state
machines, controller mediation, reader/writer ceremony — remains in full regardless of
how many fast paths are layered on top.

**The spec's complexity cannot be opted out of.** BYOB is the clearest example. Domenic
agrees it was a mistake (§10.4). But the spec defines it, WPT tests it, and users expect
it. An implementation could choose to not implement BYOB to spec, or to cut corners on
compliance, but that produces ecosystem inconsistencies, "bugs" that users file, and
feature gaps that other specs may depend on. The ~1,445 lines of BYOB code in the polyfill
(~800 in Node.js, ~1,760 in Chromium) cannot be optimized away — they must exist to
satisfy the spec contract. The same applies to the controller layer, the queuing strategy
abstraction, the reader lifecycle, and the promise management infrastructure: these are
not implementation choices that a clever engineer can route around; they are structural
requirements of the specification.

The real burden on implementers is therefore three-fold: (1) the inherent complexity of
the spec itself, (2) the complexity of performance optimizations layered on top, and
(3) the complexity of runtime and system integration points. Domenic's argument addresses
only whether (2) can offset (1). My data shows it cannot — it only adds to it.

**A simpler design is already faster — without system-level optimization.** The New
Streams reference implementation is pure TypeScript with no native bindings, no
engine-specific fast paths, and no system-level optimizations like `sendfile` or Mojo
pipe passthrough. Despite this, benchmarks across custom stream scenarios — application code creating
streams, piping through transforms, consuming via iteration — show it consistently
outperforming every Web Streams implementation I have tested against, including Node.js,
Bun, Deno, Cloudflare Workers, Chrome, Firefox, and Safari:

- **Small chunks (1KB)**: 2–2.5x faster; **tiny chunks (100B)**: 4–5x faster
- **Async iteration**: 12–18x faster (native `for await` consumption)
- **Simple pipelines**: 19–22x faster (source → iteration, 8KB chunks)
- **High-frequency pipelines**: 15–19x faster (64B x 20,000 chunks)
- **Chained transforms**: 70–104x faster (3 identity stages, 8KB chunks)

The largest multipliers (chained transforms, simple pipelines) are in scenarios where
per-chunk overhead dominates — identity transforms that do no per-byte work, so the
benchmark is effectively measuring the cost of the streaming machinery itself. When the
transform does significant per-byte computation (XOR), or chunks are large enough that
memory bandwidth dominates, all APIs perform equivalently — as expected. The 2–5x
advantage on small/tiny chunks reflects real-world scenarios like SSR, event streaming,
and protocol parsing where chunk sizes are naturally small.

These benchmarks test custom streams, not system-level optimized paths (like Chromium's
Mojo pipe passthrough for native-backed fetch bodies). But custom streams are precisely
the scenario where Domenic's "implementation quality" argument should apply: application
code creating `ReadableStream` instances, piping through transforms, consuming via async
iteration. This is where the spec's per-chunk ceremony — controller mediation, reader
acquisition, promise management — is fully in the critical path with no opportunity for
native bypass.

The Node.js port provides a further data point at the system integration level. A
benchmark comparing `FileHandle.pull()` (New Streams) against
`FileHandle.readableWebStream()` (Web Streams) for real file I/O through two transform
stages (uppercase + gzip compression) shows the New Streams path consistently
outperforming Web Streams by approximately 2x — reading actual files, through actual
transforms, into actual consumers. Classic Node.js streams (`createReadStream` +
`pipeline`) fall between the two.

Cross-runtime benchmarks on Deno and Bun provide additional data points. These use the
same file → uppercase → gzip pipeline with each runtime's native file I/O as the
source for *both* paths, so the primary variable is pipeline orchestration. However, the
comparison is not perfectly isolated: the New Streams path reads from `file.readable` via
`for await` (which internally uses the ReadableStream async iteration protocol), and on
Deno, wraps `CompressionStream` via reader/writer adapter — so the New Streams pipeline
is actually a hybrid that pays Web Streams overhead at both ends. A native zlib binding
(as in the Node.js port) would eliminate the compression adapter penalty. On Bun, both
paths use `node:zlib` with roughly equivalent wrappers:

| Runtime    | 1MB            | 16MB           | 64MB           |
|------------|----------------|----------------|----------------|
| Deno 2.6   | NS ~1.3x faster | ~equivalent   | ~equivalent    |
| Bun 1.3    | ~equivalent    | ~equivalent    | ~equivalent    |

At small file sizes where per-chunk overhead is a larger fraction of total work, New
Streams shows a modest advantage on Deno despite the adapter penalties. At larger sizes,
compression dominates and both paths converge — as expected. On Bun, where both paths
use equivalent wrappers, performance is effectively identical across all sizes. The
finding here is that the *reference TypeScript implementation* — with no runtime-specific
optimizations and carrying Web Streams overhead inside its own pipeline — is roughly
competitive with the native Web Streams pipeline in a compression-dominated workload.
The large advantages seen in the custom stream benchmarks above (12–104x) do not appear
here because compression cost dwarfs pipeline overhead at these file sizes. This is
consistent with an observation from Kenton Varda: pure JavaScript pipeline comparisons
isolate the machinery difference cleanly, while real I/O workloads inevitably cross the
JavaScript↔native boundary where the crossing cost and actual I/O work dominate pipeline
overhead. The custom stream benchmarks measure machinery in isolation; the file I/O
benchmarks measure a compression-dominated workload where pipeline overhead is a small
fraction of total cost.

Taking the benchmarks as a whole: the custom stream results (12–104x) demonstrate that
the pipeline machinery itself is dramatically faster; the Node.js FileHandle result (~2x)
shows this advantage carries into real system integration where the port has native
bindings (`internalBinding('zlib')`, direct `binding.read()`); and the Deno/Bun results
(~equivalent throughput) confirm that when the workload is dominated by compression and
I/O rather than pipeline orchestration, both designs converge in performance. This
convergence is expected for two reasons: the compression engine is the same in both paths
(the reference implementation has no native zlib binding and must wrap `CompressionStream`
or `node:zlib` through their existing APIs), and the pipeline overhead that New Streams
eliminates is a small fraction of total work at these file sizes.

These are not comparisons against naïve implementations. Node.js, Deno, and the browser
engines have had years of optimization work on their Web Streams implementations. In the
custom stream benchmarks — where pipeline machinery is in the critical path and I/O work
is not a factor — the performance advantage comes from the architecture itself: batched
iteration amortizes async overhead, the absence of controller/reader mediation eliminates
per-chunk ceremony, and the generator-based pipeline avoids the promise management
infrastructure that every Web Streams implementation must maintain. A simpler design that
is faster where pipeline overhead matters, and equivalent where it does not, is evidence
that the complexity gap is architectural, not a matter of implementation quality.

**On promise elimination specifically:** Domenic says *"there is no need for [the
implementation] to create those promises, unless one of them is explicitly passed out
to the developer's JavaScript."* This is correct in isolation — individual promises can
be elided when unobservable. But the spec's architecture structurally requires tracking
resolve/reject slots because promises created in one function must be resolved from a
different function at a later time (e.g., `reader.closed` is created during
`AcquireReadableStreamDefaultReader` and resolved later by
`ReadableStreamDefaultReaderRead`). The cross-implementation pattern (§8.5 point 4)
shows this remains a universal pain point:

- Polyfill: 23 named promise management functions
- Node.js: 39 `PromiseWithResolvers()` + 80 direct calls
- Deno: `Deferred` class (107 lines) + direct calls
- Chromium: `ScriptPromiseResolver<>` + `ThenCallable<>` subclasses

No implementation I examined has eliminated this machinery.

**On "this is the job":** Domenic compares Web Streams implementation to V8 implementing
the JavaScript spec, and says optimizing a standard's performance is the expected work of
a platform engineer. There is a disanalogy: V8 is a dedicated engine team focused on a
single spec. Runtimes like Node.js, Deno, or Cloudflare Workers must implement many
specs with smaller, more broadly scoped teams. My data shows that Web Streams' ceremony
ratio in platform API integrations is 48–87% (§8.6.2). The verified Node.js port (§8.7.6)
confirms this: `FileHandle`'s `readableWebStream()` is 63% ceremony (controller construction,
BYOB request protocol, stream cancellation wiring). The New Streams `FileHandle.pull()`
replacement is 0% ceremony — every line is either state validation or actual I/O. The
question is not whether optimization is possible in theory, but whether the spec's
architecture imposes a disproportionate burden — three layers of complexity instead of
one — on platform engineers who have many other responsibilities. "This is the job" is
not a sufficient argument when the same needs can be met with a simpler design that is
also faster. The optimizations Domenic describes are not impossible — they are complicated,
and they only add to the already complicated surface of the spec, and the benchmarks show
they still do not close the performance gap with a simpler architecture.

### 10.2 "The sendfile(2) Optimization Justifies Locking"

Domenic argues that the locking system enables `stream1.pipeTo(stream2)` to be
*"optimized down to a sendfile(2) call."* He later asks: *"How are you going to be able
to convert your async iterable pipeline chain into sendfile(2) when at any time JavaScript
code could call iterable.next()?"*

Exclusive ownership is important. A stream consumer needs a guarantee that no other
code can interfere with its iteration. Web Streams achieves this through locking
(acquire reader → use → release). The New Streams design addresses the same concern
through a different mechanism: the [Transfer Protocol](TRANSFER-INTEGRATION.md)
(`Object.transfer()`), which moves ownership permanently from one reference to another,
detaching the original (see TRANSFER-INTEGRATION.md §6 for a detailed comparison).

The question, then, is not whether exclusive ownership matters — it does — but whether
the *specific* Web Streams locking protocol is necessary to enable the I/O optimizations
Domenic describes.

#### 10.2.1 pipeTo Implementations

Among the three implementations I examined in detail — the WHATWG reference polyfill,
Node.js, and Chromium/Blink — none use `sendfile(2)` or any similar kernel-level
zero-copy I/O optimization in their `pipeTo` implementation:

- **Node.js** (`readablestream.js`): A single JavaScript-level fast path that drains
  already-buffered chunks in a tight loop, bypassing `PipeToReadableStreamReadRequest`
  allocation. No kernel-level I/O shortcut. Still routes through the full writer
  machinery.

- **Chromium/Blink** (`pipe_to_engine.cc`, ~530 lines): A direct C++ transcription of
  the spec algorithm. `ReadableStreamDefaultReader::Read()` feeds into
  `WritableStreamDefaultWriter::Write()` through `WrappedPromiseResolve` /
  `WrappedPromiseReject` method-pointer classes. No `sendfile`, no `splice`, no fast
  path of any kind. Chromium's `PipeToEngine` does not even include the batch-read
  optimization that Node.js added.

- **WHATWG Polyfill**: Pure JavaScript; no native I/O optimization possible.

I have not examined every implementation (Safari/WebKit, Deno's `pipeTo` specifically),
so I cannot make a universal claim. But the pattern is consistent across the
implementations I analyzed: `pipeTo` itself does not use the optimization that locking
was designed to enable.

#### 10.2.2 Chromium's Fetch Body Optimizations: A Closer Look

Chromium *does* have significant native I/O optimizations for ReadableStream bodies in
the Fetch API — specifically around `Request.body`, `Response.body`, and the consumption
of response bodies (`.blob()`, `.arrayBuffer()`, etc.). However, examining them closely
reveals that they operate **below** the ReadableStream layer, not through it — and that
locking is a bookkeeping consequence, not an enabler.

**The dual-layer architecture:** Chromium's fetch body handling has two layers:

1. **`BytesConsumer`** — a pure C++ abstract interface with a two-phase read API
   (`BeginRead`/`EndRead`) and three "drain" methods: `DrainAsBlobDataHandle()`,
   `DrainAsFormData()`, and `DrainAsDataPipe()`. These drain methods allow entire data
   sources to be transferred as native handles without reading any bytes.

2. **`ReadableStream`** — the JavaScript-visible spec-compliant wrapper.
   `BodyStreamBuffer` bridges the two layers, inheriting from both
   `UnderlyingByteSourceBase` (making it a C++ underlying source for a ReadableStream)
   and `BytesConsumer::Client`.

The optimizations happen at the `BytesConsumer` layer:

- **Mojo data pipe passthrough** (`FetchDataLoaderAsDataPipe::Start`): When a
  `DataPipeBytesConsumer` (wrapping a `mojo::ScopedDataPipeConsumerHandle` from the
  network layer) is asked to drain as a data pipe, it hands off the raw Mojo pipe
  handle. Zero copies, zero JavaScript involvement. The data flows from the network
  process through the Mojo pipe directly to the consumer.

- **Blob drain** (`BodyStreamBuffer::DrainAsBlobDataHandle`): When the body is backed
  by a native `BytesConsumer`, the entire body can be drained as a blob handle without
  reading any bytes through JavaScript.

- **Native tee** (`BodyStreamBuffer::Tee`): When the body is not from a user-provided
  ReadableStream, tee uses `BytesConsumerTee` (C++ level), bypassing the JavaScript
  `ReadableStream.tee()` algorithm entirely.

**The critical discriminator is not locking — it is provenance.** `BodyStreamBuffer` has
a boolean `made_from_readable_stream_` that determines which path is taken:

- When `false` (body came from network, blob, form data — i.e., a native
  `BytesConsumer`): all drain optimizations are available. The ReadableStream exists
  purely as a JavaScript-facing facade.

- When `true` (body is a user-provided ReadableStream): **all native drain optimizations
  are disabled**. `DrainAsBlobDataHandle()` returns `nullptr`. `DrainAsFormData()` returns
  `nullptr`. `DrainAsDataPipe()` is not available. The data must go through the full
  JavaScript ReadableStream read machinery via `ReadableStreamBytesConsumer`, which
  acquires a reader and calls `ReadableStreamDefaultReader::Read()` for each chunk.

The locking that occurs during these operations is **post-facto bookkeeping**:
`DrainAsBlobDataHandle()` calls `CloseAndLockAndDisturb()` *after* the native drain
succeeds. The `DCHECK(!IsStreamLocked())` assertions are precondition checks to ensure
the stream hasn't been given to user JavaScript, not optimization enablers. A simple
"consumed" boolean would suffice.

#### 10.2.3 What This Means for Domenic's Argument

The Chromium fetch analysis reveals an irony: Chromium's most significant stream
optimizations validate the *importance* of native I/O shortcuts, but they do not validate
the claim that the ReadableStream locking protocol *enables* them.

1. **The optimizations bypass ReadableStream entirely.** When both ends are native
   (e.g., network response → blob), data flows through `BytesConsumer` →
   `DrainAsBlobDataHandle()` or `DrainAsDataPipe()`. The ReadableStream, its controller,
   its reader, and its lock state are never consulted for data transfer. They exist only
   so that `response.body` returns a spec-compliant object to JavaScript.

2. **User-provided ReadableStreams get no benefit.** When a developer creates a
   ReadableStream and passes it as a fetch request body or constructs a Response from it,
   `made_from_readable_stream_` is `true` and all native optimizations are disabled.
   The data goes through the full JavaScript read loop regardless of locking state. The
   ReadableStream API machinery that Domenic argues enables optimization is precisely the
   code path where no optimization occurs.

3. **The `BytesConsumer` interface is the actual optimization enabler.** It is a simple
   C++ interface — two-phase read, three drain methods, state notifications, cancel. It
   has no concept of readers, controllers, locks, strategies, or promise management. It
   is, in essence, what a simpler streams primitive looks like at the native layer.

4. **A simpler JS-facing API could enable identical optimizations.** The drain
   optimizations depend on the runtime detecting that a stream is backed by a native
   resource, not on the JavaScript API shape. A runtime implementing New Streams could
   use the same `BytesConsumer` layer internally: if `pipeTo(fetchBody, socketWriter)`
   detects both sides are native-backed, it drains the pipe handle directly. The
   JavaScript-level API — whether it uses ReadableStream with locking or AsyncIterable
   without — is irrelevant to the native fast path.

To be clear: the argument here is not that exclusive ownership is unimportant, or that
locking provides no value. Exclusive ownership *is* critical for safe stream consumption,
and the New Streams design acknowledges this by proposing the Transfer Protocol as an
alternative ownership mechanism (see TRANSFER-INTEGRATION.md). The argument is narrower:
Domenic's specific criticism — that the *absence of Web Streams-style locking* prevents
important optimizations — is not supported by the empirical evidence. Chromium's actual
implementation demonstrates that the optimization decision is made based on provenance
(`made_from_readable_stream_`), not lock state. The question a runtime asks when deciding
whether to apply native I/O shortcuts is "is this backed by a native resource?" — not
"is this locked?" A runtime implementing New Streams with transfer-based ownership could
ask the same question and apply the same optimizations.

#### 10.2.4 Do Async Iterators Fundamentally Prevent System-Level Optimization?

Domenic's strongest version of the argument is not about `sendfile` specifically but about
the general principle: with a locked `ReadableStream`, the runtime *knows* no JavaScript
code can interfere, whereas with a bare async iterable, *"at any time JavaScript code
could call iterable.next()."* Does this make system-level optimization fundamentally
impossible?

No — for several reasons.

**Pipeline functions hold iterators privately.** When `pipeTo(source, writer)` is called,
the fast path executes `for await (const batch of source)`. This calls
`source[Symbol.asyncIterator]()` once at the start of the loop, obtaining an iterator
object that is held in the loop's internal scope. External code retains a reference to the
*iterable* (`source`), but not to the *iterator* the pipeline is using. Calling
`source[Symbol.asyncIterator]()` again would create a different iterator (for well-behaved
iterables) or return the same object (for generators) — but in either case, the pipeline's
`for await` loop is the only code actively calling `.next()` on its iterator. This is
the same effective exclusivity that a locked reader provides, achieved through JavaScript's
ordinary scoping rather than an explicit lock protocol.

**The runtime can detect native-backed sources at call time.** When `pipeTo(source,
writer)` is invoked, the runtime has both arguments. If `source` is a native file handle's
readable and `writer` is a native socket's writer, the runtime can detect this through
internal type checks — exactly as Chromium's `BodyStreamBuffer` checks
`made_from_readable_stream_`. The decision to use `sendfile` or `splice` does not require
inspecting lock state; it requires knowing that both ends are backed by kernel file
descriptors and that the pipeline has no JavaScript transforms in between. These conditions
are statically known at call time.

**The Transfer Protocol provides explicit proof of exclusive ownership.** When a source has
been transferred via `Object.transfer()`, the original reference is permanently detached.
The runtime has an even stronger guarantee than locking: not only can no other code read
from the stream, but there is no live reference that *could* read. This is the same
guarantee that `ArrayBuffer.prototype.transfer()` provides, and V8 already uses detached
state to optimize `ArrayBuffer` operations. A runtime could use the same signal: if the
source's underlying iterator has been transferred, skip the JavaScript iteration protocol
entirely and operate on the native resource directly.

**Engine-level analysis can determine iterator exclusivity without API-level locking.** V8
already performs escape analysis and inline caching for synchronous code. If a generator's
iterator object does not escape the function that created it, V8 can determine that no
external code has a reference to it — the same conclusion that locking provides, derived
from the code's actual structure rather than an API-level protocol. V8 already applies
this to synchronous `for...of` loops, eliding `{value, done}` object allocation when it
can prove the result object doesn't escape. Extending this to `for await...of` with async
generators is a natural optimization target, though I have not confirmed whether V8
currently does so.

**Locking's guarantee is weaker than it appears.** Web Streams locking prevents acquiring
a *second reader* on a locked stream, but it does not prevent all forms of interference.
If code retains a reference to the iterator passed to `ReadableStream.from()`, it can call
`.next()` on the underlying source while the ReadableStream thinks it has exclusive access.
The lock protects the stream wrapper, not the underlying data source. The Transfer
Protocol, by contrast, detaches the actual iterator object — protecting the data source
itself.

**In practice, both APIs delegate optimization to the same mechanism.** Whether the
JavaScript API uses `ReadableStream` with locking or `AsyncIterable` with transfer (or
even with neither), the system-level optimization follows the same pattern:

1. The runtime detects that source and sink are both native-backed
2. The runtime verifies that no JavaScript transforms are interposed
3. The runtime short-circuits to a native data transfer (Mojo pipe, `sendfile`, `splice`)
4. The JavaScript API objects are updated post-facto for spec/protocol compliance

This is exactly what Chromium does today. The JavaScript API shape — and specifically
whether it provides locking — is not a factor in steps 1–3. What matters is whether the
runtime can identify the optimization opportunity, and both API designs provide sufficient
information for that.

### 10.3 "The Compliance Burden Is a Feature"

Domenic defends comprehensive WPT testing as one of the great achievements of the 2010s,
arguing that edge-case interoperability serves developers at internet scale.

This is a fair point, and I do not dispute the value of interoperability
testing. But the complexity data illuminates *why* the test surface is large: 4 explicit
state machines, ~70 internal state slots, 14 classes with interconnected lifecycles, and
combinatorial interactions between reader states, controller states, stream states, and
promise states. The test matrix is large because the design's state space is large.

A simpler design with 2 state machines, ~35 internal slots, and no controller/reader
mediation would have a proportionally smaller test surface while being equally well-tested
per unit of functionality. Fewer states to test does not mean less testing rigor — it
means the design has less surface area to verify.

### 10.4 Domenic's Concessions

The most notable aspect of Domenic's post is the breadth of his agreement. The areas
where he concedes problems align directly with the largest complexity costs in my
analysis:

**BYOB** (~1,445 lines, 19.6% of polyfill): Domenic says *"I largely agree"* and *"in
retrospect, bring-your-own-buffer streams were designed with too much attention to theory
and not enough to real-world performance and usability."* My analysis found BYOB is universally the
most complex subsystem in every implementation examined: ~1,445 lines in the polyfill,
~800 in Node.js, ~1,760 lines of C++ in Chromium (§8.5 point 2).

**Backpressure**: Domenic acknowledges the `desiredSize` + `ready` promise model has real
problems and that *"giving developers more control is likely a good idea."* He is skeptical
of the specific default, however: *"His choice of 'strict' backpressure as the default
seems unlikely to be correct: I doubt that many server-side developers want code that works
fine over fast internet... but throws exceptions when the user's cell service goes down to
one bar."* The direction is agreed; the default is disputed.

**Transforms**: Domenic acknowledges the eager-vs-lazy problem
([whatwg/streams#1158](https://github.com/whatwg/streams/issues/1158)) and notably
describes the proposed fix as working in a *"complex way"* — implicitly acknowledging that
fixing transforms within the current architecture adds further complexity.

**The entire architecture**: This is the most significant area of agreement, though it is
hedged. Domenic writes *"To this day, I'm not sure which design is better"* regarding the
channel approach (`const { readable, writable } = new Channel()`) vs. the underlying
source/sink approach. He says *"I think I was too influenced by a desire to stay close to
Node.js streams"* and is *"cautiously optimistic about exploration along this alternate
evolutionary path."* However, he also cautions that the channel design may be *"too
simple"*: *"There are certainly some patterns, largely around state management and queuing,
which are much easier when the Streams Standard's APIs manage them for you. With a
channel-type API, individual stream creators need to implement those patterns themselves,
and they might do so in slightly different ways."* The channel approach is what New Streams
uses: `push()` returns `{ writer, readable }`. My analysis shows the controller layer
alone accounts for ~1,700 lines (§7.2). Domenic's concession is specifically about the
creation pattern (channel vs. underlying source/sink), not about the consumption model
(iterables vs. readers) — the additional ~500–700 lines of reader code (§7.1) relates to
the iterable approach, which Domenic explicitly contests (§10.9). I count only the
controller savings here.

Taken together, Domenic identifies problems — with varying degrees of certainty — in areas
that account for approximately **3,345 lines** of the polyfill's 5,668 code lines (~59%).
The BYOB concession is unambiguous; the architecture concession is exploratory; the
backpressure and transform concessions agree on the problem but not necessarily the
solution:

| Conceded problem area           | Approximate lines | % of polyfill |
| ------------------------------- | ----------------: | ------------: |
| BYOB                            | ~1,445            | 25.5%         |
| Architecture (channel creation) | ~1,700            | 30.0%         |
| Backpressure model              | ~100              | 1.8%          |
| Transform model                 | ~100              | 1.8%          |
| **Total**                       | **~3,345**        | **~59%**      |

### 10.5 "Error Handling Is the Biggest Gap"

Domenic writes: *"the biggest gap in James's post and library is any discussion of error
handling. This is scary!"* He highlights the complexity of distinguishing between no-fault
cancellation, error-like aborting, errors from underlying sources/sinks, and propagation
through pipe chains.

This is a fair critique of the *blog post's* presentation. However, the *implementation*
has thorough error handling, which I can verify:

**Bidirectional error propagation:**
- **Downstream** (producer → consumer): `writer.fail(error)` rejects all pending reads
  in `PushQueue`. In broadcast, `_abort()` propagates to all consumers.
- **Upstream** (consumer → producer): The async iterator's `return()` and `throw()`
  methods invoke `consumerReturn()` / `consumerThrow()`, which reject pending writes.
  In pull pipelines, an internal `AbortController` is created and its signal threaded
  to all transforms; the generator's `finally` block aborts upstream when the consumer
  stops or errors.
- **Lateral isolation**: In broadcast and share, one consumer's error removes only that
  consumer from the consumer set; other consumers are unaffected.

**The `fail()` vs. `end()` distinction on writers:**
- `end()` signals normal completion. Buffered data drains before consumers see `done`.
- `fail(reason)` signals terminal error. Pending reads are immediately rejected (though
  already-buffered data remains accessible).

This maps directly to Domenic's own distinction between no-fault cancellation and
error-like aborting.

**`pipeTo` options:** `preventClose` and `preventFail` provide the same control over
error/close propagation that Web Streams' `preventClose`, `preventAbort`, and
`preventCancel` do.

**AbortSignal integration:** Signals are checked at pipeline entry, threaded to every
transform via `TransformCallbackOptions.signal`, and cleaned up in `finally` blocks.

The mechanism is different �� generators + `AbortController` vs. manually constructed
4-directional promise chains — but the error scenarios covered are comparable. New
Streams' `pipeTo` catch block is 6 lines (`pull.ts:749-754`); Web Streams'
`ReadableStreamPipeTo` algorithm is 213 lines with 8 internal closures managing the
same directional propagation. Chromium needs a dedicated `PipeToEngine` C++ class
(~530 lines) because C++ cannot express the spec's closure-heavy pipe algorithm as a
single function.

Domenic's concern has merit in one respect: generator-based error propagation is
*implicit* in `try/catch/finally` rather than *explicit* in named operations. This
makes the behavior harder to audit by reading the library code. Whether "explicit and
verbose" (Web Streams, 213 lines) or "implicit and concise" (generators, 6 lines) is
better for error correctness is a genuine design tradeoff — but it is a tradeoff, not
a gap.

### 10.6 "Bytes Only Won't Meet Ecosystem Needs"

Domenic writes: *"I'm skeptical that this will meet the ecosystem's needs. It's just too
convenient to transform data into non-byte formats, such as text, or objects parsed from
JSON."* He acknowledges that *"if it does, it's surely a huge simplification,"* but raises
a specific concern about *"bifurcating the ecosystem into byte streams, which are handled
via James's library, and object streams, which are handled by various other utilities."*

The simplification acknowledgment is appreciated. But the skepticism misidentifies a
constraint that does not exist in the design. Other than
the `text()` and `bytes()` consumer functions (which perform UTF-8 encoding/decoding),
**nothing in the New Streams implementation performs byte-specific operations**. The
design uses `Uint8Array` as the *default* chunk type, but the architecture — push
channels, pull pipelines, transforms, broadcast, share, writers — operates on opaque
values. There are no byte-counting backpressure strategies, no byte-alignment
constraints, no typed-array-specific operations in the pipeline machinery.

The exact same design works for arbitrary types. A runtime or library could instantiate
the pattern for JSON objects, parsed records, or any other type without modifying the
core pipeline, transform, or backpressure machinery. The bytes-only framing is a
pragmatic default for the I/O use case (where bytes dominate), not a type-system
constraint baked into the architecture.

This is in contrast to Web Streams, where the generic type parameterization (`ReadableStream<R>`)
adds real implementation cost: pluggable size functions, queue-with-sizes tracking
`{value, size}` pairs, and the entire queuing strategy abstraction (~250 lines). New
Streams avoids this cost not by being less capable, but by not requiring a generic
sizing framework — backpressure counts operations, which works regardless of chunk type.

### 10.7 "Sync/Async Separation Is a Bad Idea"

Domenic argues that sync variants should be hidden fast-path optimizations inside the
implementation, not public API, citing the risk of *"unleashing Zalgo"* (mixing
synchronous and asynchronous behavior unpredictably).

The Zalgo concern applies when an API *sometimes* behaves synchronously and *sometimes*
asynchronously depending on internal state, making caller behavior unpredictable. The New
Streams sync variants avoid this entirely: they are **separate, explicitly named
functions** (`pullSync`, `pipeToSync`, `bytesSync`, `textSync`, etc.) that the developer
chooses deliberately. A call to `pullSync()` is always synchronous; a call to `pull()` is
always asynchronous. There is no ambiguity and no Zalgo risk.

The sync variants exist because synchronous iteration is meaningfully faster when the
data source is already in memory (e.g., transforming a pre-loaded buffer). Hiding this
behind an async API forces unnecessary promise overhead. The ~600 lines of sync variant
code in the implementation mirror their async counterparts closely, providing a complete
zero-promise pipeline path for use cases that can exploit it.

### 10.8 "Generators Have Their Own Just-As-Complex State Machine"

Domenic writes: *"James spends a lot of time complaining about the internal state machine
of streams, but seems to ignore that async generators (which he uses to create his async
iterables) have their own just-as-complex state machine."*

This conflates two different kinds of complexity. The async generator state machine is
implemented by the JavaScript engine (V8, SpiderMonkey, JSC) — it is **zero lines** in
the streams library. Web Streams' state machines are implemented in the library/runtime
code: 4 explicit state machines plus implicit pull-state machines, accounting for hundreds
of lines in every implementation (§4.2).

From an implementation complexity standpoint, leveraging the engine's generator machinery
is strictly a win: it is implemented once in the engine, tested by the engine's own test
suite, and optimized by the engine team. The streams library need not re-implement
suspension, resumption, cleanup, or error propagation — `yield`, `return`, `throw`, and
`finally` provide all of these. This is the same principle by which Web Streams uses the
engine's promise implementation rather than implementing its own — except New Streams
applies it more broadly.

The DX question (whether `for await...of` is better or worse than
`reader.read()` in a while loop) is separate from implementation complexity and is
more subjective.

### 10.9 "Streams as Iterables Is a DX Regression"

Domenic argues: *"I think objects-with-methods have conclusively won the API design wars,
at least in JavaScript, so I think James's library is a developer-experience regression
in this regard."*

This is a matter of API design philosophy, not implementation complexity, and this
document does not take a position on it. However, the complexity data is relevant to one
aspect: the objects-with-methods approach in Web Streams requires the reader acquisition
ceremony (`stream.getReader()` → `while (true) { const { value, done } = await reader.read() }`
→ `reader.releaseLock()`) which adds a reader class, lock management, and closed-promise
tracking — ~500 lines of implementation code (§7.1). The iterable approach
(`for await (const chunks of stream)`) delegates this to the language runtime's iterator
protocol, which is zero lines of library code.

Whether the developer-facing ergonomics favor one style or the other is a separate
question from whether the implementation complexity is justified.

### 10.10 Summary

| Domenic's Argument                    | Complexity Data Assessment                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Performance is implementation quality | All 3 examined production impls are larger than polyfill; promise management persists in all examined                            |
| Locking enables optimization          | Exclusive ownership matters (addressed via transfer); iterators don't prevent optimization — provenance, not lock state, is key |
| Compliance burden is a feature        | Valid point; but test surface scales with state space, and simpler designs have less to test                                    |
| BYOB was a mistake                    | Domenic agrees; my data shows ~1,445 lines (19.6%)                                                                              |
| Channel approach might be better      | Domenic agrees (hedged); my data shows channel creation eliminates ~1,700 lines of controllers                                  |
| Error handling is the biggest gap     | Gap is in blog post presentation, not implementation; bidirectional propagation, fail/end, lateral isolation all present        |
| Bytes only won't meet needs           | Misidentifies a constraint: the design is type-agnostic; bytes-only is the default, not a limitation                            |
| Sync/async separation is Zalgo risk   | No Zalgo: sync variants are separate, explicitly named functions; always sync, never ambiguous                                  |
| Generators are "just-as-complex"      | Generator state machines are engine-level (0 library lines); WS state machines are library-level (hundreds of lines)            |
| Iterables are a DX regression         | Design philosophy question; complexity data shows iterables eliminate ~500 lines of reader ceremony                             |
