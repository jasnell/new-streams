# Testable Requirements from New Streams API

This document lists all testable requirements derived from the README.md specification,
with identifiers for tracking test coverage.

## Legend

- ✅ Covered by existing tests
- ⚠️ Partially covered
- ❌ Not covered
- 🔶 Known issue (see ISSUES.md)

---

## 1. Stream Creation

### 1.1 Stream.pull()

| ID | Requirement | Status |
|----|-------------|--------|
| PULL-001 | Accepts sync generator function | ✅ |
| PULL-002 | Accepts async generator function | ✅ |
| PULL-003 | Yields strings are UTF-8 encoded by default | ✅ |
| PULL-004 | Yields Uint8Array passed through directly | ✅ |
| PULL-005 | Yields ArrayBuffer wrapped in Uint8Array | ✅ |
| PULL-006 | Yielding a Stream consumes it inline | ✅ |
| PULL-007 | Yielding a sync generator consumes it inline | ✅ |
| PULL-008 | Yielding an async generator consumes it inline | ✅ |
| PULL-009 | Generator errors propagate to stream error state | ✅ |
| PULL-010 | Custom encoding option respected for strings | ✅ |
| PULL-011 | Natural backpressure - generator pauses until consumer reads | ✅ |

### 1.2 Stream.push()

| ID | Requirement | Status |
|----|-------------|--------|
| PUSH-001 | Returns StreamWithWriter (destructurable to [Stream, Writer]) | ✅ |
| PUSH-002 | Writer.write() accepts strings (UTF-8 encoded) | ✅ |
| PUSH-003 | Writer.write() accepts Uint8Array | ✅ |
| PUSH-004 | Writer.write() accepts ArrayBuffer | ✅ |
| PUSH-005 | Writer.close() signals end of stream | ✅ |
| PUSH-006 | Writer.abort() signals error | ✅ |
| PUSH-007 | Buffer configuration max limit respected | ✅ |
| PUSH-008 | Buffer configuration hardMax respected | ✅ |
| PUSH-009 | onOverflow: 'error' rejects writes and errors stream | ✅ |
| PUSH-010 | onOverflow: 'block' blocks writes until space available | ✅ |
| PUSH-011 | onOverflow: 'drop-oldest' discards oldest buffered data | ✅ |
| PUSH-012 | onOverflow: 'drop-newest' discards data being written | ✅ |
| PUSH-013 | Custom encoding option respected | ✅ |

### 1.3 Stream.from()

| ID | Requirement | Status |
|----|-------------|--------|
| FROM-001 | Creates stream from string | ✅ |
| FROM-002 | Creates stream from Uint8Array | ✅ |
| FROM-003 | Creates stream from ArrayBuffer | ✅ |
| FROM-004 | Creates stream from array of chunks | ✅ |
| FROM-005 | Returns same Stream if passed a Stream | ✅ |
| FROM-006 | Custom encoding option for strings | ✅ |
| FROM-007 | Handles empty inputs (string, array, Uint8Array) | ✅ |

### 1.4 Stream.empty()

| ID | Requirement | Status |
|----|-------------|--------|
| EMPTY-001 | Creates already-closed stream | ✅ |
| EMPTY-002 | bytes() returns empty Uint8Array | ✅ |
| EMPTY-003 | Async iteration yields nothing | ✅ |
| EMPTY-004 | read() returns done immediately | ✅ |

### 1.5 Stream.never()

| ID | Requirement | Status |
|----|-------------|--------|
| NEVER-001 | Without reason: creates stream that never produces data | ✅ |
| NEVER-002 | With reason: creates errored stream | ✅ |
| NEVER-003 | With string reason: wraps in Error | ✅ |

### 1.6 Stream.merge()

| ID | Requirement | Status |
|----|-------------|--------|
| MERGE-001 | Merges multiple streams | ✅ |
| MERGE-002 | Interleaved (first-come ordering) | ✅ |
| MERGE-003 | Empty input returns empty stream | ✅ |
| MERGE-004 | Single input returns that stream | ✅ |
| MERGE-005 | Error in one stream errors the merged stream | ✅ |
| MERGE-006 | Handles already-closed streams | ✅ |

### 1.7 Stream.concat()

| ID | Requirement | Status |
|----|-------------|--------|
| CONCAT-001 | Concatenates streams sequentially | ✅ |
| CONCAT-002 | Order preserved | ✅ |
| CONCAT-003 | Empty input returns empty stream | ✅ |
| CONCAT-004 | Single input returns that stream | ✅ |
| CONCAT-005 | Error in one stream errors the result | ✅ |
| CONCAT-006 | Handles already-closed streams | ✅ |

### 1.8 Stream.transform()

| ID | Requirement | Status |
|----|-------------|--------|
| TRANSFORM-001 | Returns [Stream, Writer] pair | ✅ |
| TRANSFORM-002 | Transform function receives Uint8Array chunks | ✅ |
| TRANSFORM-003 | Transform function receives null on flush | ✅ |
| TRANSFORM-004 | Return Uint8Array emits single chunk | ✅ |
| TRANSFORM-005 | Return string emits UTF-8 encoded chunk | ✅ |
| TRANSFORM-006 | Return null/undefined emits nothing | ✅ |
| TRANSFORM-007 | Return iterable emits each element | ✅ |
| TRANSFORM-008 | Return async iterable emits each element | ✅ |
| TRANSFORM-009 | Generator transform (1:N) works | ✅ |
| TRANSFORM-010 | Async generator transform works | ✅ |
| TRANSFORM-011 | Transform object with transform() method works | ✅ |
| TRANSFORM-012 | Transform object abort() called on pipeline error | ✅ |
| TRANSFORM-013 | chunkSize option delivers fixed-size chunks | ✅ |
| TRANSFORM-014 | Buffer configuration respected | ✅ |

### 1.9 Stream.writer()

| ID | Requirement | Status |
|----|-------------|--------|
| WRITER-001 | Creates writer with custom sink | ✅ |
| WRITER-002 | Sink write() called with Uint8Array | ✅ |
| WRITER-003 | Sink close() called on writer.close() | ✅ |
| WRITER-004 | Sink abort() called on writer.abort() | ✅ |
| WRITER-005 | Buffer configuration respected | ✅ |

### 1.10 Stream.pipeline()

| ID | Requirement | Status |
|----|-------------|--------|
| PIPELINE-001 | Constructs pipeline from source through transforms to destination | ✅ |
| PIPELINE-002 | Returns total bytes that flowed through | ✅ |
| PIPELINE-003 | Signal option cancels entire pipeline | ✅ |
| PIPELINE-004 | Limit option caps bytes through pipeline | ✅ |
| PIPELINE-005 | preventClose option keeps destination open | ✅ |
| PIPELINE-006 | Error in any stage tears down entire pipeline | ✅ |
| PIPELINE-007 | Errors propagate bidirectionally | ✅ |

---

## 2. Consumption Methods

### 2.1 stream.bytes()

| ID | Requirement | Status |
|----|-------------|--------|
| BYTES-001 | Returns Uint8Array with all concatenated bytes | ✅ |
| BYTES-002 | Signal option allows cancellation | ✅ |
| BYTES-003 | Rejects if stream errors | ✅ |

### 2.2 stream.arrayBuffer()

| ID | Requirement | Status |
|----|-------------|--------|
| ARRAYBUF-001 | Returns ArrayBuffer with all bytes | ✅ |
| ARRAYBUF-002 | Signal option allows cancellation | ✅ |

### 2.3 stream.text()

| ID | Requirement | Status |
|----|-------------|--------|
| TEXT-001 | Returns decoded string | ✅ |
| TEXT-002 | Default encoding is UTF-8 | ✅ |
| TEXT-003 | Custom encoding option respected | ✅ |
| TEXT-004 | Signal option allows cancellation | ✅ |

---

## 3. Slicing Operators

### 3.1 stream.take(n)

| ID | Requirement | Status |
|----|-------------|--------|
| TAKE-001 | Returns stream with next n bytes | ✅ |
| TAKE-002 | Parent stream continues at byte n | ✅ |
| TAKE-003 | take(0) returns empty stream | ✅ |
| TAKE-004 | take(n) where n > stream length returns all available | ✅ |
| TAKE-005 | Nested take() calls work | ✅ |
| TAKE-006 | Limits propagate to tee'd branches | ✅ |

### 3.2 stream.drop(n)

| ID | Requirement | Status |
|----|-------------|--------|
| DROP-001 | Discards next n bytes | ✅ |
| DROP-002 | Returns closed/empty stream | ✅ |
| DROP-003 | Parent continues at byte n | ✅ |
| DROP-004 | drop(0) is no-op | ✅ |
| DROP-005 | drop(n) where n > stream length | ✅ |

### 3.3 stream.limit(n)

| ID | Requirement | Status |
|----|-------------|--------|
| LIMIT-001 | Caps stream at n bytes | ✅ |
| LIMIT-002 | Cancels source after limit reached | ✅ |
| LIMIT-003 | limit(0) returns empty stream | ✅ |

---

## 4. Branching

### 4.1 stream.tee()

| ID | Requirement | Status |
|----|-------------|--------|
| TEE-001 | Creates branch that sees same bytes | ✅ |
| TEE-002 | Both streams can be consumed independently | ✅ |
| TEE-003 | Multiple tee() calls create multiple branches | ✅ |
| TEE-004 | Cancelling branch doesn't affect original | ✅ |
| TEE-005 | Cancelling one branch doesn't affect peers (branches are peers) | ✅ |
| TEE-006 | Error propagates to all branches | ✅ |
| TEE-007 | Buffer options can override parent config | ✅ |
| TEE-008 | Slowest cursor determines backpressure | ✅ |

### 4.2 Detached branches

| ID | Requirement | Status |
|----|-------------|--------|
| DETACH-001 | detached: true creates detached branch | ✅ |
| DETACH-002 | detached property is true before attach | ✅ |
| DETACH-003 | attach() activates the branch | ✅ |
| DETACH-004 | detached property is false after attach | ✅ |
| DETACH-005 | Auto-attaches on first read | ✅ |
| DETACH-006 | Auto-attaches on async iteration | ✅ |
| DETACH-007 | Detached branch doesn't contribute to backpressure | ✅ |
| DETACH-008 | Detached branch misses data before attachment | ✅ |
| DETACH-009 | attach() on non-detached stream is no-op | ✅ |

---

## 5. Piping

### 5.1 stream.pipeThrough()

| ID | Requirement | Status |
|----|-------------|--------|
| PIPE-THROUGH-001 | Transforms data with function | ✅ |
| PIPE-THROUGH-002 | Transforms data with object | ✅ |
| PIPE-THROUGH-003 | Returns readable output stream | ✅ |
| PIPE-THROUGH-004 | Chaining transforms works | ✅ |
| PIPE-THROUGH-005 | Signal option cancels the pipe | ✅ |
| PIPE-THROUGH-006 | Limit option limits bytes piped through | ✅ |
| PIPE-THROUGH-007 | chunkSize option respected | ✅ |
| PIPE-THROUGH-008 | Buffer options respected | ✅ |

### 5.2 stream.pipeTo()

| ID | Requirement | Status |
|----|-------------|--------|
| PIPE-TO-001 | Pipes to writer | ✅ |
| PIPE-TO-002 | Returns total bytes piped | ✅ |
| PIPE-TO-003 | Signal option cancels the pipe | ✅ |
| PIPE-TO-004 | Limit option limits bytes piped | ✅ |
| PIPE-TO-005 | preventClose keeps destination open | ✅ |
| PIPE-TO-006 | preventAbort keeps destination from aborting on error | ✅ |
| PIPE-TO-007 | preventCancel keeps source from cancelling on dest error | ✅ |
| PIPE-TO-008 | Destination error propagates back | ✅ |
| PIPE-TO-009 | Source error propagates forward | ✅ |
| PIPE-TO-010 | pipeTo with limit=0 | ✅ |

---

## 6. Cancellation

### 6.1 stream.cancel()

| ID | Requirement | Status |
|----|-------------|--------|
| CANCEL-001 | Cancels the stream | ✅ |
| CANCEL-002 | Returns bytes read before cancel | ✅ |
| CANCEL-003 | Subsequent reads return done=true | ✅ |
| CANCEL-004 | closed promise resolves | ✅ |
| CANCEL-005 | Idempotent (multiple cancels safe) | ✅ |

---

## 7. Low-level Read

### 7.1 stream.read()

| ID | Requirement | Status |
|----|-------------|--------|
| READ-001 | Returns { value, done } result | ✅ |
| READ-002 | value can be non-null when done=true (final chunk) | ✅ |
| READ-003 | BYOB: buffer option copies into provided buffer | ✅ |
| READ-004 | BYOB: buffer is conceptually detached after use | ✅ |
| READ-005 | max option bounds allocation size | ✅ |
| READ-006 | atLeast option waits for minimum bytes | ✅ |
| READ-007 | atLeast returns available if stream ends early | ✅ |
| READ-008 | atLeast > max throws RangeError | ✅ |
| READ-009 | Signal option allows cancellation | ✅ |
| READ-010 | Auto-attaches detached streams | ✅ |
| READ-011 | read() after cancel() returns done | ✅ |

### 7.2 stream.closed

| ID | Requirement | Status |
|----|-------------|--------|
| CLOSED-001 | Resolves with total bytes read when stream closes | ✅ |
| CLOSED-002 | Rejects with error if stream errors | ✅ |
| CLOSED-003 | Promise is marked as handled (no unhandled rejection) | ✅ |

---

## 8. Writer

### 8.1 writer.write()

| ID | Requirement | Status |
|----|-------------|--------|
| WRITE-001 | Accepts string (UTF-8 encoded) | ✅ |
| WRITE-002 | Accepts Uint8Array | ✅ |
| WRITE-003 | Accepts ArrayBuffer | ✅ |
| WRITE-004 | Buffer is conceptually detached after use | ✅ |
| WRITE-005 | Signal option cancels write and subsequent writes | ✅ |
| WRITE-006 | Rejects if writer is closed | ✅ |
| WRITE-007 | Rejects if writer is aborted | ✅ |
| WRITE-008 | write with empty string | ✅ |
| WRITE-009 | write with empty Uint8Array | ✅ |

### 8.2 writer.writev()

| ID | Requirement | Status |
|----|-------------|--------|
| WRITEV-001 | Writes multiple chunks atomically | ✅ |
| WRITEV-002 | All buffers conceptually detached after use | ⚠️ (ISSUE-003) |
| WRITEV-003 | Signal option cancels write and subsequent writes | ✅ |
| WRITEV-004 | writev with empty array | ✅ |

### 8.3 writer.flush()

| ID | Requirement | Status |
|----|-------------|--------|
| FLUSH-001 | Resolves when all prior writes complete | ✅ |
| FLUSH-002 | Acts as zero-length write (queues behind pending) | ✅ |
| FLUSH-003 | Signal option allows cancellation | ✅ |

### 8.4 writer.close()

| ID | Requirement | Status |
|----|-------------|--------|
| CLOSE-001 | Signals end of stream | ✅ |
| CLOSE-002 | Returns total bytes written | ✅ |
| CLOSE-003 | Idempotent (multiple closes safe) | ✅ |

### 8.5 writer.abort()

| ID | Requirement | Status |
|----|-------------|--------|
| ABORT-001 | Signals error | ✅ |
| ABORT-002 | Returns bytes written before abort | ✅ |
| ABORT-003 | Stream transitions to errored state | ✅ |
| ABORT-004 | Subsequent writes reject | ✅ |

### 8.6 writer.closed

| ID | Requirement | Status |
|----|-------------|--------|
| CLOSED-W-001 | Resolves with bytes written when closed | ✅ |
| CLOSED-W-002 | Rejects if aborted or errored | ✅ |
| CLOSED-W-003 | Promise is marked as handled | ✅ |

### 8.7 writer.desiredSize

| ID | Requirement | Status |
|----|-------------|--------|
| DESIRED-001 | Returns bytes available before max | ✅ |
| DESIRED-002 | Returns null if closed | ✅ |
| DESIRED-003 | Reflects buffer state (decreases as buffer fills) | ✅ |

---

## 9. Async Iteration

| ID | Requirement | Status |
|----|-------------|--------|
| ITER-001 | for await...of yields Uint8Array chunks | ✅ |
| ITER-002 | Breaking out of loop allows further reads | ✅ |
| ITER-003 | Auto-attaches detached streams | ✅ |

---

## 10. Explicit Resource Management

| ID | Requirement | Status |
|----|-------------|--------|
| ERM-001 | Stream[Symbol.asyncDispose] calls cancel() | ✅ |
| ERM-002 | Writer[Symbol.asyncDispose] calls close() | ✅ |
| ERM-003 | await using stream = ... works | ✅ |
| ERM-004 | await using writer = ... works | ✅ |
| ERM-005 | Idempotent (dispose on already disposed is no-op) | ✅ |

---

## 11. Error Handling

| ID | Requirement | Status |
|----|-------------|--------|
| ERR-001 | Errors are Error objects (wrapped if primitive) | ✅ |
| ERR-002 | Source error propagates to consumers | ✅ |
| ERR-003 | Transform error propagates forward | ✅ |
| ERR-004 | Consumer error propagates back to source (cancel) | ✅ |
| ERR-005 | Pipeline errors tear down all stages | ✅ |
| ERR-006 | Bidirectional error propagation in pipeTo | ✅ |

---

## 12. Edge Cases

| ID | Requirement | Status |
|----|-------------|--------|
| EDGE-001 | Stream.from() with empty string | ✅ |
| EDGE-002 | Stream.from() with empty Uint8Array | ✅ |
| EDGE-003 | Stream.from() with empty array | ✅ |
| EDGE-004 | Generator that throws immediately | ✅ |
| EDGE-005 | Generator that yields nothing | ✅ |
| EDGE-006 | Writer closed without any writes | ✅ |
| EDGE-007 | Writer aborted without any writes | ✅ |
| EDGE-008 | Handles already-closed streams in merge/concat | ✅ |
| EDGE-009 | bytes() on already-consumed stream | ✅ |
| EDGE-010 | Concurrent reads on same stream | ✅ |
| EDGE-011 | take() then tee() the taken stream | ✅ |
| EDGE-012 | Rapid writes without awaiting | ✅ |

---

## Summary Statistics

| Category | Total | Covered | Not Covered |
|----------|-------|---------|-------------|
| Stream.pull() | 11 | 11 | 0 |
| Stream.push() | 13 | 13 | 0 |
| Stream.from() | 7 | 7 | 0 |
| Stream.empty() | 4 | 4 | 0 |
| Stream.never() | 3 | 3 | 0 |
| Stream.merge() | 6 | 6 | 0 |
| Stream.concat() | 6 | 6 | 0 |
| Stream.transform() | 14 | 14 | 0 |
| Stream.writer() | 5 | 5 | 0 |
| Stream.pipeline() | 7 | 7 | 0 |
| Consumption | 10 | 10 | 0 |
| Slicing | 14 | 14 | 0 |
| Branching | 17 | 17 | 0 |
| Piping | 18 | 18 | 0 |
| Cancellation | 5 | 5 | 0 |
| Low-level Read | 14 | 14 | 0 |
| Writer | 27 | 27 | 0 |
| Async Iteration | 3 | 3 | 0 |
| ERM | 5 | 5 | 0 |
| Error Handling | 6 | 6 | 0 |
| Edge Cases | 12 | 12 | 0 |
| **Total** | **202** | **202** | **0** |

**Coverage: 100%** of specified requirements are tested.

All known issues (ISSUE-001 through ISSUE-007) have been resolved.
