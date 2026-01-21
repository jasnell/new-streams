# Stream API Samples

This folder contains comprehensive examples demonstrating all features of the new Streams API.

## Running Examples

From the project root:

```bash
# Run a specific example
npx tsx samples/01-basic-creation.ts

# Run all examples
for f in samples/*.ts; do echo "=== $f ===" && npx tsx "$f"; done
```

## Example Files

### Core Concepts

| File | Description |
|------|-------------|
| `01-basic-creation.ts` | Creating streams with `from()`, `pull()`, `push()`, `empty()`, `never()` |
| `02-consumption-methods.ts` | Reading data with `bytes()`, `text()`, `read()`, async iteration |
| `03-slicing-operators.ts` | Using `take()`, `drop()`, and `limit()` for stream slicing |
| `04-branching.ts` | Branching with `tee()` and detached branches |

### Data Transformation

| File | Description |
|------|-------------|
| `05-transforms.ts` | Transform functions, generators, and `pipeThrough()` |
| `06-piping.ts` | `pipeTo()`, `Stream.pipeline()`, and `Stream.writer()` |

### Configuration & Control

| File | Description |
|------|-------------|
| `07-buffer-configuration.ts` | Buffer limits, overflow policies (`error`, `block`, `drop-oldest`, `drop-newest`) |
| `08-encoding.ts` | Text encodings: UTF-8, UTF-16LE, UTF-16BE, ISO-8859-1 |
| `09-cancellation.ts` | Cancellation with `cancel()` and `AbortSignal` |
| `10-resource-management.ts` | Automatic cleanup with `await using` |

### Advanced

| File | Description |
|------|-------------|
| `11-merging-concat.ts` | Combining streams with `merge()` and `concat()` |
| `12-real-world-patterns.ts` | Practical patterns: JSON Lines, CSV, SSE, progress tracking |
| `13-nodejs-interop.ts` | Adapting to/from Node.js streams, error propagation, lifecycle management |
| `14-web-streams-interop.ts` | Bidirectional interop with Web Streams API (ReadableStream, WritableStream, TransformStream) |
| `15-compression.ts` | Streaming compression/decompression with Node.js zlib (gzip, deflate, brotli) |
| `16-encryption.ts` | Streaming encryption/decryption with Node.js crypto (AES-256-GCM, CBC, ChaCha20-Poly1305) |

## Quick Reference

### Creating Streams

```typescript
// From data
Stream.from('string')
Stream.from(uint8Array)
Stream.from(['chunk1', 'chunk2'])

// Pull-based (on-demand)
Stream.pull(async function* () {
  yield 'chunk';
});

// Push-based (producer-driven)
const [stream, writer] = Stream.push();
await writer.write('data');
await writer.close();

// Empty/never
Stream.empty()      // Already closed
Stream.never()      // Never produces data
Stream.never(error) // Already errored
```

### Consuming Streams

```typescript
// Collect all data
const bytes = await stream.bytes();
const text = await stream.text();
const buffer = await stream.arrayBuffer();

// Low-level reading
const { value, done } = await stream.read();
const { value } = await stream.read({ atLeast: 10, max: 100 });

// Async iteration
for await (const chunk of stream) { ... }
```

### Slicing

```typescript
// take() - creates a branch
const first10 = stream.take(10);  // New stream with first 10 bytes
// Original stream continues at byte 10

// drop() - skips bytes (mutates)
stream.drop(5);  // Skip first 5 bytes

// limit() - caps stream (terminal)
stream.limit(100);  // Stream ends at 100 bytes
```

### Branching

```typescript
// Create branches
const branch = stream.tee();
// Both stream and branch see the same data

// Detached branch (late attachment)
const detached = stream.tee({ detached: true });
// ... later ...
detached.attach();
```

### Transforms

```typescript
// Function transform
const upper = stream.pipeThrough((chunk) => {
  if (chunk === null) return null;  // Flush signal
  return new TextDecoder().decode(chunk).toUpperCase();
});

// Generator transform (1:N)
const split = stream.pipeThrough(function* (chunk) {
  if (chunk === null) return;
  for (const byte of chunk) {
    yield new Uint8Array([byte]);
  }
});

// Create transform with writer
const [output, writer] = Stream.transform(transformFn);
```

### Piping

```typescript
// Pipe to writer
await stream.pipeTo(writer, { limit: 1000 });

// Full pipeline
await Stream.pipeline(
  source,
  transform1,
  transform2,
  destination
);
```

### Buffer Configuration

```typescript
const [stream, writer] = Stream.push({
  buffer: {
    max: 1000,        // Soft limit
    hardMax: 2000,    // Hard limit (block mode only)
    onOverflow: 'block' | 'error' | 'drop-oldest' | 'drop-newest'
  }
});
```

### Cancellation

```typescript
// Cancel stream
await stream.cancel();

// With AbortSignal
const controller = new AbortController();
await stream.bytes({ signal: controller.signal });
controller.abort();

// Timeout
await stream.bytes({ signal: AbortSignal.timeout(5000) });
```

### Resource Management

```typescript
// Automatic cleanup
{
  await using stream = Stream.pull(...);
  // Use stream...
} // stream.cancel() called automatically

{
  await using writer = ...;
  // Use writer...
} // writer.close() called automatically
```

### Combining Streams

```typescript
// Sequential
Stream.concat([stream1, stream2, stream3]);

// Interleaved (first-come)
Stream.merge([stream1, stream2, stream3]);
```

### Web Streams Interoperability

```typescript
// Web ReadableStream -> New Stream API
function fromWebReadable(readable: ReadableStream<Uint8Array>): Stream {
  return Stream.pull(async function* () {
    const reader = readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  });
}

// New Stream API -> Web ReadableStream
function toWebReadable(stream: Stream): ReadableStream<Uint8Array> {
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
    }
  });
}
```

### Compression with pipeThrough()

```typescript
// Create zlib transform objects for use with pipeThrough()
// Key insight: Use 'end' event (not 'finish') and flush() after writes

function createGzipTransform(): StreamTransformerObject {
  const gzip = zlib.createGzip();
  const pending: Uint8Array[] = [];

  gzip.on('data', (chunk) => pending.push(new Uint8Array(chunk)));

  return {
    transform(chunk): Promise<Uint8Array[]> {
      return new Promise((resolve, reject) => {
        if (chunk === null) {
          // 'end' fires AFTER final data emitted (unlike 'finish')
          gzip.once('end', () => resolve(pending.splice(0)));
          gzip.end();
          return;
        }
        gzip.write(chunk, () => {
          gzip.flush(() => resolve(pending.splice(0)));
        });
      });
    }
  };
}

// Usage
const compressed = await Stream.from('data')
  .pipeThrough(createGzipTransform())
  .bytes();
```

### Encryption with pipeThrough()

```typescript
// Create cipher transforms for streaming encryption
function createAesGcmEncryptTransform(key: Uint8Array) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const pending: Uint8Array[] = [];

  cipher.on('data', (chunk) => pending.push(new Uint8Array(chunk)));

  const transform: StreamTransformerObject = {
    async *transform(chunk) {
      if (chunk === null) {
        await new Promise(r => cipher.end(r));
        while (pending.length > 0) yield pending.shift()!;
        return;
      }
      await new Promise(r => cipher.write(chunk, r));
      while (pending.length > 0) yield pending.shift()!;
    }
  };

  return {
    transform,
    getParams: () => ({ iv, authTag: cipher.getAuthTag() })
  };
}

// Usage: Compress then encrypt
const { transform, getParams } = createAesGcmEncryptTransform(key);
const ciphertext = await Stream.from(plaintext)
  .pipeThrough(createGzipTransform())
  .pipeThrough(transform)
  .bytes();
```

### Node.js Interoperability

```typescript
// Node.js Readable -> New Stream API
function fromNodeReadable(readable: Readable): Stream {
  return Stream.pull(async function* () {
    try {
      for await (const chunk of readable) {
        yield chunk instanceof Buffer 
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : chunk;
      }
    } finally {
      if (!readable.destroyed) readable.destroy();
    }
  });
}

// New Stream API -> Node.js Writable
function toNodeWritable(writable: Writable): Writer {
  return Stream.writer({
    async write(chunk) {
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (!writable.write(buffer)) {
        await new Promise(r => writable.once('drain', r));
      }
    },
    async close() {
      await new Promise(r => writable.end(r));
    },
    async abort(reason) {
      writable.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    }
  });
}

// Usage
const nodeReader = fs.createReadStream('input.txt');
const nodeWriter = fs.createWriteStream('output.txt');

const stream = fromNodeReadable(nodeReader);
const writer = toNodeWritable(nodeWriter);

await stream.pipeTo(writer);
```
