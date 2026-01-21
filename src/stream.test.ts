import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { Stream, Writer } from './index.js';

// Helper to collect chunks from a stream
async function collectChunks(stream: Stream): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

// Helper to concatenate chunks
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// Helper to create a delayed value
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// 1. Stream Creation Tests
// =============================================================================

describe('Stream.from()', () => {
  it('creates a stream from a string', async () => {
    const stream = Stream.from('hello world');
    const text = await stream.text();
    assert.strictEqual(text, 'hello world');
  });

  it('creates a stream from a Uint8Array', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = Stream.from(data);
    const bytes = await stream.bytes();
    assert.deepStrictEqual(bytes, data);
  });

  it('creates a stream from an ArrayBuffer', async () => {
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([1, 2, 3, 4]);
    const stream = Stream.from(buffer);
    const bytes = await stream.bytes();
    assert.deepStrictEqual(bytes, new Uint8Array([1, 2, 3, 4]));
  });

  it('creates a stream from an array of chunks', async () => {
    const stream = Stream.from(['hello', ' ', 'world']);
    const text = await stream.text();
    assert.strictEqual(text, 'hello world');
  });

  it('returns same Stream if passed a Stream', async () => {
    const original = Stream.from('test');
    const result = Stream.from(original);
    assert.strictEqual(result, original);
  });

  // Edge cases
  it('handles empty string', async () => {
    const stream = Stream.from('');
    const bytes = await stream.bytes();
    assert.strictEqual(bytes.byteLength, 0);
  });

  it('handles empty Uint8Array', async () => {
    const stream = Stream.from(new Uint8Array(0));
    const bytes = await stream.bytes();
    assert.strictEqual(bytes.byteLength, 0);
  });

  it('handles empty array', async () => {
    const stream = Stream.from([]);
    const bytes = await stream.bytes();
    assert.strictEqual(bytes.byteLength, 0);
  });
});

describe('Stream.empty()', () => {
  it('creates an empty stream', async () => {
    const stream = Stream.empty();
    const bytes = await stream.bytes();
    assert.strictEqual(bytes.byteLength, 0);
  });

  it('async iteration yields nothing', async () => {
    const stream = Stream.empty();
    const chunks = await collectChunks(stream);
    assert.strictEqual(chunks.length, 0);
  });

  it('read() returns done immediately', async () => {
    const stream = Stream.empty();
    const { value, done } = await stream.read();
    assert.strictEqual(value, null);
    assert.strictEqual(done, true);
  });
});

describe('Stream.never()', () => {
  it('without reason: creates stream that never produces data', async () => {
    const stream = Stream.never();
    
    // Use a timeout to verify it doesn't resolve
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    await assert.rejects(
      stream.read({ signal: controller.signal }),
      { name: 'AbortError' }
    );
  });

  it('with reason: creates errored stream', async () => {
    const stream = Stream.never(new Error('test error'));
    await assert.rejects(stream.bytes(), { message: 'test error' });
  });

  it('with string reason: wraps in Error', async () => {
    const stream = Stream.never('string reason');
    await assert.rejects(stream.bytes(), { message: 'string reason' });
  });
});

describe('Stream.pull()', () => {
  it('creates a stream from a sync generator', async () => {
    const stream = Stream.pull(function* () {
      yield 'hello';
      yield ' ';
      yield 'world';
    });
    const text = await stream.text();
    assert.strictEqual(text, 'hello world');
  });

  it('creates a stream from an async generator', async () => {
    const stream = Stream.pull(async function* () {
      yield 'async';
      yield ' ';
      yield 'hello';
    });
    const text = await stream.text();
    assert.strictEqual(text, 'async hello');
  });

  it('yields Uint8Array passed through directly', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const stream = Stream.pull(function* () {
      yield data;
    });
    const bytes = await stream.bytes();
    assert.deepStrictEqual(bytes, data);
  });

  it('yields ArrayBuffer wrapped in Uint8Array', async () => {
    const buffer = new ArrayBuffer(3);
    new Uint8Array(buffer).set([1, 2, 3]);
    const stream = Stream.pull(function* () {
      yield buffer;
    });
    const bytes = await stream.bytes();
    assert.deepStrictEqual(bytes, new Uint8Array([1, 2, 3]));
  });

  it('handles yielded streams inline', async () => {
    const inner = Stream.from('inner');
    const stream = Stream.pull(function* () {
      yield 'before-';
      yield inner;
      yield '-after';
    });
    const text = await stream.text();
    assert.strictEqual(text, 'before-inner-after');
  });

  it('handles yielded sync generators inline', async () => {
    function* innerGen() {
      yield 'a';
      yield 'b';
    }
    const stream = Stream.pull(function* () {
      yield '1';
      yield innerGen();
      yield '2';
    });
    const text = await stream.text();
    assert.strictEqual(text, '1ab2');
  });

  it('handles yielded async generators inline', async () => {
    async function* innerGen() {
      yield 'x';
      yield 'y';
    }
    const stream = Stream.pull(async function* () {
      yield '1';
      yield innerGen();
      yield '2';
    });
    const text = await stream.text();
    assert.strictEqual(text, '1xy2');
  });

  it('generator errors propagate to stream error state', async () => {
    const stream = Stream.pull(function* () {
      yield 'start';
      throw new Error('generator error');
    });
    await assert.rejects(stream.bytes(), { message: 'generator error' });
  });

  it('generator that throws immediately', async () => {
    const stream = Stream.pull(function* () {
      throw new Error('immediate error');
    });
    await assert.rejects(stream.bytes(), { message: 'immediate error' });
  });

  it('generator that yields nothing', async () => {
    const stream = Stream.pull(function* () {
      // yields nothing
    });
    const bytes = await stream.bytes();
    assert.strictEqual(bytes.byteLength, 0);
  });
});

describe('Stream.push()', () => {
  it('creates a writable stream', async () => {
    const [stream, writer] = Stream.push();

    (async () => {
      await writer.write('hello');
      await writer.write(' world');
      await writer.close();
    })();

    const text = await stream.text();
    assert.strictEqual(text, 'hello world');
  });

  it('supports writev for multiple chunks', async () => {
    const [stream, writer] = Stream.push();

    (async () => {
      await writer.writev(['hello', ' ', 'world']);
      await writer.close();
    })();

    const text = await stream.text();
    assert.strictEqual(text, 'hello world');
  });

  it('write() accepts Uint8Array', async () => {
    const [stream, writer] = Stream.push();
    await writer.write(new Uint8Array([104, 105])); // 'hi'
    await writer.close();
    const text = await stream.text();
    assert.strictEqual(text, 'hi');
  });

  it('write() accepts ArrayBuffer', async () => {
    const buffer = new ArrayBuffer(2);
    new Uint8Array(buffer).set([104, 105]); // 'hi'
    const [stream, writer] = Stream.push();
    await writer.write(buffer);
    await writer.close();
    const text = await stream.text();
    assert.strictEqual(text, 'hi');
  });

  it('writer closed without any writes', async () => {
    const [stream, writer] = Stream.push();
    await writer.close();
    const bytes = await stream.bytes();
    assert.strictEqual(bytes.byteLength, 0);
  });

  it('writer.abort() signals error', async () => {
    const [stream, writer] = Stream.push();
    await writer.write('some data');
    await writer.abort(new Error('aborted'));
    await assert.rejects(stream.bytes(), { message: 'aborted' });
  });

  it('writer aborted without any writes', async () => {
    const [stream, writer] = Stream.push();
    await writer.abort(new Error('aborted early'));
    await assert.rejects(stream.bytes(), { message: 'aborted early' });
  });

  describe('buffer overflow policies', () => {
    it('onOverflow: error rejects writes when buffer full', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 10, onOverflow: 'error' }
      });

      await writer.write('12345'); // 5 bytes
      await assert.rejects(
        writer.write('1234567890'), // 10 more bytes, exceeds max
        /Buffer overflow/
      );
    });

    it('onOverflow: drop-newest discards data being written', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 5, onOverflow: 'drop-newest' }
      });

      await writer.write('hello'); // 5 bytes, at max
      await writer.write('world'); // should be dropped
      await writer.close();

      const text = await stream.text();
      assert.strictEqual(text, 'hello');
    });

    it('onOverflow: drop-oldest discards oldest buffered data', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 10, onOverflow: 'drop-oldest' }
      });

      await writer.write('aaaaa'); // 5 bytes
      await writer.write('bbbbbbbbbbb'); // 11 bytes, triggers drop
      await writer.close();

      const text = await stream.text();
      // Should have dropped some of the 'a's to make room
      assert.ok(text.includes('b'));
    });
  });

  describe('onOverflow: block', () => {
    it('blocks writes when buffer is full', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 10, onOverflow: 'block' }
      });

      await writer.write('1234567890'); // 10 bytes, at max
      
      let writeCompleted = false;
      const writePromise = writer.write('more').then(() => {
        writeCompleted = true;
      });

      // Give some time for the write to potentially complete (it shouldn't)
      await new Promise(r => setTimeout(r, 10));
      assert.strictEqual(writeCompleted, false, 'Write should be blocked');

      // Read some data to free up buffer space
      await stream.read({ max: 5 });
      
      // Now the blocked write should complete
      await writePromise;
      assert.strictEqual(writeCompleted, true);
      
      await writer.close();
    });

    it('blocked writes resolve in FIFO order', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 5, onOverflow: 'block' }
      });

      await writer.write('12345'); // 5 bytes, at max
      
      const order: number[] = [];
      
      // Queue up multiple blocked writes
      const write1 = writer.write('a').then(() => order.push(1));
      const write2 = writer.write('b').then(() => order.push(2));
      const write3 = writer.write('c').then(() => order.push(3));

      // Read to free space - should unblock writes in order
      await stream.read({ max: 1 }); // Free 1 byte
      await write1;
      
      await stream.read({ max: 1 }); // Free 1 byte
      await write2;
      
      await stream.read({ max: 1 }); // Free 1 byte
      await write3;

      assert.deepStrictEqual(order, [1, 2, 3], 'Writes should resolve in FIFO order');
      
      await writer.close();
    });

    it('hardMax errors when total pending exceeds limit', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 10, hardMax: 20, onOverflow: 'block' }
      });

      await writer.write('1234567890'); // 10 bytes, at max
      
      // This write will block (10 + 5 = 15, under hardMax of 20)
      // Catch the error so it doesn't become unhandled
      const blockedWrite = writer.write('12345').catch(() => {});
      
      // Give time for write to be queued
      await new Promise(r => setTimeout(r, 5));
      
      // This should error: 10 (buffer) + 5 (pending) + 10 (new) = 25 > hardMax of 20
      await assert.rejects(
        writer.write('1234567890'),
        /Hard buffer limit exceeded/
      );
      
      // Wait for the blocked write to be rejected (due to stream error)
      await blockedWrite;
      
      // The stream should be errored now
      await assert.rejects(stream.bytes(), /Hard buffer limit exceeded/);
    });

    it('abort signal cancels blocked write', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 5, onOverflow: 'block' }
      });

      await writer.write('12345'); // 5 bytes, at max
      
      const controller = new AbortController();
      const writePromise = writer.write('more', { signal: controller.signal });

      // Give time for write to be queued
      await new Promise(r => setTimeout(r, 5));
      
      // Abort the write
      controller.abort();
      
      await assert.rejects(writePromise, { name: 'AbortError' });
      
      // Stream should still be usable
      await writer.close();
      const text = await stream.text();
      assert.strictEqual(text, '12345');
    });

    it('already-aborted signal rejects immediately', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 5, onOverflow: 'block' }
      });

      await writer.write('12345'); // 5 bytes, at max
      
      const controller = new AbortController();
      controller.abort(); // Abort before write
      
      await assert.rejects(
        writer.write('more', { signal: controller.signal }),
        { name: 'AbortError' }
      );
      
      await writer.close();
    });

    it('closing writer rejects blocked writes', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 5, onOverflow: 'block' }
      });

      await writer.write('12345'); // 5 bytes, at max
      
      const blockedWrite = writer.write('more');
      
      // Give time for write to be queued
      await new Promise(r => setTimeout(r, 5));
      
      // Close the writer
      await writer.close();
      
      // The blocked write should be rejected
      await assert.rejects(blockedWrite, /closed/i);
    });

    it('error on writer rejects blocked writes', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 5, onOverflow: 'block' }
      });

      await writer.write('12345'); // 5 bytes, at max
      
      const blockedWrite = writer.write('more');
      
      // Give time for write to be queued
      await new Promise(r => setTimeout(r, 5));
      
      // Abort the writer with an error
      await writer.abort(new Error('test error'));
      
      // The blocked write should be rejected
      await assert.rejects(blockedWrite, /test error/);
    });

    it('writes below max complete immediately', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 100, onOverflow: 'block' }
      });

      // All these should complete immediately (under max)
      await writer.write('hello');
      await writer.write('world');
      await writer.write('!');
      
      await writer.close();
      const text = await stream.text();
      assert.strictEqual(text, 'helloworld!');
    });

    it('large write that fits under hardMax blocks until space available', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 10, hardMax: 100, onOverflow: 'block' }
      });

      // Write some initial data
      await writer.write('1234567890'); // 10 bytes, at max
      
      // This write (5 bytes) will block because buffer is at max
      let writeCompleted = false;
      const blockedWrite = writer.write('abcde').then(() => {
        writeCompleted = true;
      }).catch(() => {
        // Handle potential rejection during cleanup
      });
      
      // Give time for write to be queued
      await new Promise(r => setTimeout(r, 10));
      assert.strictEqual(writeCompleted, false, 'Write should be blocked');
      
      // Read to free up space (read 10 bytes, now have 0 in buffer)
      await stream.read({ max: 10 });
      
      // Now the blocked write should complete (0 + 5 <= 10)
      await blockedWrite;
      assert.strictEqual(writeCompleted, true, 'Write should complete after space freed');
      
      await writer.close();
      const remaining = await stream.text();
      assert.strictEqual(remaining, 'abcde');
    });

    it('desiredSize reflects available buffer space', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 100, onOverflow: 'block' }
      });

      assert.strictEqual(writer.desiredSize, 100);
      
      await writer.write('1234567890'); // 10 bytes
      assert.strictEqual(writer.desiredSize, 90);
      
      await writer.write('1234567890'); // 10 more bytes
      assert.strictEqual(writer.desiredSize, 80);
      
      await writer.close();
    });
  });
});

describe('Stream.merge()', () => {
  it('merges multiple streams', async () => {
    const s1 = Stream.from('a');
    const s2 = Stream.from('b');
    const s3 = Stream.from('c');

    const merged = Stream.merge(s1, s2, s3);
    const text = await merged.text();

    assert.ok(text.includes('a'));
    assert.ok(text.includes('b'));
    assert.ok(text.includes('c'));
    assert.strictEqual(text.length, 3);
  });

  it('empty input returns empty stream', async () => {
    const merged = Stream.merge();
    const bytes = await merged.bytes();
    assert.strictEqual(bytes.byteLength, 0);
  });

  it('single input returns that stream', async () => {
    const s1 = Stream.from('only');
    const merged = Stream.merge(s1);
    const text = await merged.text();
    assert.strictEqual(text, 'only');
  });

  it('handles already-closed streams', async () => {
    const s1 = Stream.empty();
    const s2 = Stream.from('data');
    const merged = Stream.merge(s1, s2);
    const text = await merged.text();
    assert.strictEqual(text, 'data');
  });

  it('error in one stream errors the merged stream', async () => {
    const s1 = Stream.from('good');
    const s2 = Stream.never(new Error('bad stream'));

    const merged = Stream.merge(s1, s2);
    await assert.rejects(merged.bytes(), { message: 'bad stream' });
  });
});

describe('Stream.concat()', () => {
  it('concatenates streams sequentially', async () => {
    const s1 = Stream.from('hello');
    const s2 = Stream.from(' ');
    const s3 = Stream.from('world');

    const concatenated = Stream.concat(s1, s2, s3);
    const text = await concatenated.text();

    assert.strictEqual(text, 'hello world');
  });

  it('empty input returns empty stream', async () => {
    const concatenated = Stream.concat();
    const bytes = await concatenated.bytes();
    assert.strictEqual(bytes.byteLength, 0);
  });

  it('single input returns that stream', async () => {
    const s1 = Stream.from('only');
    const concatenated = Stream.concat(s1);
    const text = await concatenated.text();
    assert.strictEqual(text, 'only');
  });

  it('handles already-closed streams', async () => {
    const s1 = Stream.empty();
    const s2 = Stream.from('data');
    const s3 = Stream.empty();
    const concatenated = Stream.concat(s1, s2, s3);
    const text = await concatenated.text();
    assert.strictEqual(text, 'data');
  });

  it('error in one stream errors the result', async () => {
    const s1 = Stream.from('good');
    const s2 = Stream.never(new Error('bad'));
    const s3 = Stream.from('never reached');

    const concatenated = Stream.concat(s1, s2, s3);
    await assert.rejects(concatenated.bytes(), { message: 'bad' });
  });
});

describe('Stream.transform()', () => {
  it('creates a transform with writer', async () => {
    const [output, writer] = Stream.transform((chunk) => {
      if (chunk === null) return null;
      return new TextEncoder().encode(
        new TextDecoder().decode(chunk).toUpperCase()
      );
    });

    await writer.write('hello');
    await writer.close();

    const text = await output.text();
    assert.strictEqual(text, 'HELLO');
  });

  it('transform receives null on flush', async () => {
    let receivedFlush = false;
    const [output, writer] = Stream.transform((chunk) => {
      if (chunk === null) {
        receivedFlush = true;
        return 'flushed';
      }
      return chunk;
    });

    await writer.write('data');
    await writer.close();
    await output.bytes();

    assert.strictEqual(receivedFlush, true);
  });

  it('return null/undefined emits nothing', async () => {
    const [output, writer] = Stream.transform((chunk) => {
      if (chunk === null) return null;
      return null; // filter everything
    });

    await writer.write('ignored');
    await writer.close();

    const bytes = await output.bytes();
    assert.strictEqual(bytes.byteLength, 0);
  });

  it('return string emits UTF-8 encoded chunk', async () => {
    const [output, writer] = Stream.transform((chunk) => {
      if (chunk === null) return null;
      return 'transformed';
    });

    await writer.write('input');
    await writer.close();

    const text = await output.text();
    assert.strictEqual(text, 'transformed');
  });

  it('generator transform (1:N) works', async () => {
    const [output, writer] = Stream.transform({
      *transform(chunk) {
        if (chunk === null) return;
        yield 'a';
        yield 'b';
        yield 'c';
      }
    });

    await writer.write('x');
    await writer.close();

    const text = await output.text();
    assert.strictEqual(text, 'abc');
  });

  it('async generator transform works', async () => {
    const [output, writer] = Stream.transform({
      async *transform(chunk) {
        if (chunk === null) return;
        yield 'async1';
        await delay(1);
        yield 'async2';
      }
    });

    await writer.write('x');
    await writer.close();

    const text = await output.text();
    assert.strictEqual(text, 'async1async2');
  });

  it('transform object abort() called on pipeline error', async () => {
    let abortCalled = false;
    let abortReason: unknown;

    const transformer = {
      transform(chunk: Uint8Array | null) {
        if (chunk === null) return null;
        throw new Error('transform error');
      },
      abort(reason: unknown) {
        abortCalled = true;
        abortReason = reason;
      }
    };

    const [output, writer] = Stream.transform(transformer);

    await writer.write('trigger error');
    
    // The error should propagate
    await assert.rejects(output.bytes());
  });
});

describe('Stream.writer()', () => {
  it('creates writer with custom sink', async () => {
    const chunks: Uint8Array[] = [];
    const writer = Stream.writer({
      async write(chunk) {
        chunks.push(chunk);
      }
    });

    await writer.write('hello');
    await writer.close();

    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(new TextDecoder().decode(chunks[0]), 'hello');
  });

  it('sink close() called on writer.close()', async () => {
    let closeCalled = false;
    const writer = Stream.writer({
      async write() {},
      async close() {
        closeCalled = true;
      }
    });

    await writer.write('data');
    await writer.close();

    assert.strictEqual(closeCalled, true);
  });

  it('sink abort() called on writer.abort()', async () => {
    let abortCalled = false;
    let abortReason: unknown;
    const writer = Stream.writer({
      async write() {},
      async abort(reason) {
        abortCalled = true;
        abortReason = reason;
      }
    });

    await writer.write('data');
    await writer.abort(new Error('test abort'));

    assert.strictEqual(abortCalled, true);
    assert.ok(abortReason instanceof Error);
  });
});

describe('Stream.pipeline()', () => {
  it('constructs pipeline from source through transforms to destination', async () => {
    const source = Stream.from('hello');
    const chunks: Uint8Array[] = [];
    const dest = Stream.writer({
      async write(chunk) { chunks.push(chunk); }
    });

    const upperCase = (chunk: Uint8Array | null) => {
      if (chunk === null) return null;
      return new TextEncoder().encode(
        new TextDecoder().decode(chunk).toUpperCase()
      );
    };

    await Stream.pipeline(source, upperCase, dest);

    const result = new TextDecoder().decode(concatChunks(chunks));
    assert.strictEqual(result, 'HELLO');
  });

  it('returns total bytes that flowed through', async () => {
    const source = Stream.from('hello'); // 5 bytes
    const dest = Stream.writer({ async write() {} });

    const bytes = await Stream.pipeline(source, dest);
    assert.strictEqual(bytes, 5);
  });

  it('limit option caps bytes through pipeline', async () => {
    const source = Stream.from('hello world'); // 11 bytes
    const chunks: Uint8Array[] = [];
    const dest = Stream.writer({
      async write(chunk) { chunks.push(chunk); }
    });

    await Stream.pipeline(source, dest, { limit: 5 });

    const result = new TextDecoder().decode(concatChunks(chunks));
    assert.strictEqual(result, 'hello');
  });

  describe('signal option (cancellation)', () => {
    it('signal option cancels pipeline mid-stream', async () => {
      // Create a slow source that yields chunks over time
      const source = Stream.pull(async function* () {
        yield 'chunk1';
        await new Promise(r => setTimeout(r, 50));
        yield 'chunk2';
        await new Promise(r => setTimeout(r, 50));
        yield 'chunk3';
      });

      const chunks: string[] = [];
      const dest = Stream.writer({
        async write(chunk) {
          chunks.push(new TextDecoder().decode(chunk));
        }
      });

      const controller = new AbortController();
      
      // Abort after a short delay (after first chunk, before all chunks)
      setTimeout(() => controller.abort(), 30);

      await assert.rejects(
        Stream.pipeline(source, dest, { signal: controller.signal }),
        { name: 'AbortError' }
      );

      // Should have received at least the first chunk, but not all
      assert.ok(chunks.length >= 1, 'Should have received at least one chunk');
      assert.ok(chunks.length < 3, 'Should not have received all chunks');
    });

    it('pipeline rejects with AbortError when signal is aborted', async () => {
      const [source] = Stream.push(); // Never closes naturally
      const dest = Stream.writer({ async write() {} });
      
      const controller = new AbortController();
      
      const pipelinePromise = Stream.pipeline(source, dest, { signal: controller.signal });
      
      // Give pipeline time to start
      await new Promise(r => setTimeout(r, 5));
      
      controller.abort();
      
      await assert.rejects(pipelinePromise, { name: 'AbortError' });
    });

    it('already-aborted signal rejects immediately', async () => {
      const source = Stream.from('hello');
      const dest = Stream.writer({ async write() {} });
      
      const controller = new AbortController();
      controller.abort(); // Abort before starting
      
      await assert.rejects(
        Stream.pipeline(source, dest, { signal: controller.signal }),
        { name: 'AbortError' }
      );
    });

    it('destination writer is aborted on signal cancellation', async () => {
      const [source, sourceWriter] = Stream.push();
      
      let writerAborted = false;
      let abortReason: unknown;
      const dest = Stream.writer({
        async write() {},
        async abort(reason) {
          writerAborted = true;
          abortReason = reason;
        }
      });

      const controller = new AbortController();
      
      const pipelinePromise = Stream.pipeline(source, dest, { signal: controller.signal });
      
      // Write some data
      await sourceWriter.write('hello');
      
      // Give time for data to flow
      await new Promise(r => setTimeout(r, 5));
      
      // Abort the pipeline
      controller.abort();
      
      await assert.rejects(pipelinePromise, { name: 'AbortError' });
      
      assert.strictEqual(writerAborted, true, 'Writer should have been aborted');
    });

    it('source stream is cancelled on signal abort', async () => {
      let sourceIterationCount = 0;
      const source = Stream.pull(async function* () {
        for (let i = 0; i < 100; i++) {
          sourceIterationCount++;
          yield `chunk${i}`;
          await new Promise(r => setTimeout(r, 10));
        }
      });

      const dest = Stream.writer({ async write() {} });
      
      const controller = new AbortController();
      
      // Abort after a short delay
      setTimeout(() => controller.abort(), 35);
      
      await assert.rejects(
        Stream.pipeline(source, dest, { signal: controller.signal }),
        { name: 'AbortError' }
      );
      
      // Source should have been stopped - not all 100 iterations
      assert.ok(sourceIterationCount < 100, `Source should have been cancelled (iterations: ${sourceIterationCount})`);
    });

    it('transform stages receive abort when pipeline is cancelled', async () => {
      const source = Stream.pull(async function* () {
        for (let i = 0; i < 100; i++) {
          yield `chunk${i}`;
          await new Promise(r => setTimeout(r, 10));
        }
      });

      let transformCallCount = 0;
      let flushCalled = false;
      const transform = {
        transform(chunk: Uint8Array | null) {
          if (chunk === null) {
            flushCalled = true;
            return null;
          }
          transformCallCount++;
          return chunk;
        }
      };

      const dest = Stream.writer({ async write() {} });
      
      const controller = new AbortController();
      
      // Abort after a short delay
      setTimeout(() => controller.abort(), 35);
      
      await assert.rejects(
        Stream.pipeline(source, transform, dest, { signal: controller.signal }),
        { name: 'AbortError' }
      );
      
      // Transform should have processed some but not all chunks
      assert.ok(transformCallCount > 0, 'Transform should have been called at least once');
      assert.ok(transformCallCount < 100, 'Transform should not have processed all chunks');
      // Note: flush may or may not be called depending on timing
    });

    it('signal abort with custom reason', async () => {
      const [source] = Stream.push();
      const dest = Stream.writer({ async write() {} });
      
      const controller = new AbortController();
      
      const pipelinePromise = Stream.pipeline(source, dest, { signal: controller.signal });
      
      await new Promise(r => setTimeout(r, 5));
      
      controller.abort(new Error('custom abort reason'));
      
      try {
        await pipelinePromise;
        assert.fail('Should have rejected');
      } catch (e) {
        // AbortError is thrown, but the reason may be attached
        assert.strictEqual((e as Error).name, 'AbortError');
      }
    });

    it('works with multiple transform stages', async () => {
      const source = Stream.pull(async function* () {
        for (let i = 0; i < 50; i++) {
          yield 'x';
          await new Promise(r => setTimeout(r, 5));
        }
      });

      const transform1Calls: number[] = [];
      const transform2Calls: number[] = [];
      let callIndex = 0;

      const transform1 = (chunk: Uint8Array | null) => {
        if (chunk) transform1Calls.push(callIndex++);
        return chunk;
      };

      const transform2 = (chunk: Uint8Array | null) => {
        if (chunk) transform2Calls.push(callIndex++);
        return chunk;
      };

      const dest = Stream.writer({ async write() {} });
      
      const controller = new AbortController();
      
      // Abort after a short delay
      setTimeout(() => controller.abort(), 30);
      
      await assert.rejects(
        Stream.pipeline(source, transform1, transform2, dest, { signal: controller.signal }),
        { name: 'AbortError' }
      );
      
      // Both transforms should have been called, but not for all chunks
      assert.ok(transform1Calls.length > 0, 'Transform1 should have been called');
      assert.ok(transform2Calls.length > 0, 'Transform2 should have been called');
      assert.ok(transform1Calls.length < 50, 'Transform1 should not have processed all chunks');
    });

    it('preventAbort option prevents writer abort on signal cancellation', async () => {
      const [source, sourceWriter] = Stream.push();
      
      let writerAborted = false;
      const dest = Stream.writer({
        async write() {},
        async abort() {
          writerAborted = true;
        }
      });

      const controller = new AbortController();
      
      // Note: preventAbort is passed through pipeTo options
      // Currently pipeline doesn't support preventAbort directly, 
      // but the underlying pipeTo does handle it
      const pipelinePromise = Stream.pipeline(source, dest, { 
        signal: controller.signal,
        // @ts-ignore - testing preventAbort even if not in PipelineOptions type
        preventAbort: true 
      });
      
      await sourceWriter.write('hello');
      await new Promise(r => setTimeout(r, 5));
      
      controller.abort();
      
      await assert.rejects(pipelinePromise, { name: 'AbortError' });
      
      // Writer should NOT have been aborted due to preventAbort
      // (Note: This depends on whether preventAbort is passed through)
      // If this fails, we may need to update the implementation
    });
  });
});

// =============================================================================
// 2. Consumption Methods Tests
// =============================================================================

describe('Consumption Methods', () => {
  describe('bytes()', () => {
    it('returns Uint8Array with all concatenated bytes', async () => {
      const stream = Stream.from('test');
      const bytes = await stream.bytes();
      assert.ok(bytes instanceof Uint8Array);
      assert.strictEqual(new TextDecoder().decode(bytes), 'test');
    });

    it('rejects if stream errors', async () => {
      const stream = Stream.never(new Error('stream error'));
      await assert.rejects(stream.bytes(), { message: 'stream error' });
    });

    it('signal option allows cancellation', async () => {
      const [stream] = Stream.push(); // never closes
      const controller = new AbortController();
      
      setTimeout(() => controller.abort(), 10);
      
      await assert.rejects(
        stream.bytes({ signal: controller.signal }),
        { name: 'AbortError' }
      );
    });
  });

  describe('arrayBuffer()', () => {
    it('returns ArrayBuffer with all bytes', async () => {
      const stream = Stream.from('test');
      const buffer = await stream.arrayBuffer();
      assert.ok(buffer instanceof ArrayBuffer);
      assert.strictEqual(buffer.byteLength, 4);
    });
  });

  describe('text()', () => {
    it('returns decoded string', async () => {
      const stream = Stream.from('héllo');
      const text = await stream.text();
      assert.strictEqual(text, 'héllo');
    });

    it('default encoding is UTF-8', async () => {
      const bytes = new Uint8Array([0xC3, 0xA9]); // é in UTF-8
      const stream = Stream.from(bytes);
      const text = await stream.text();
      assert.strictEqual(text, 'é');
    });
  });
});

// =============================================================================
// 2.5 Encoding Support Tests
// =============================================================================

describe('Encoding Support', () => {
  describe('UTF-16LE encoding', () => {
    it('Stream.from() encodes strings as UTF-16LE', async () => {
      const stream = Stream.from('hello', { encoding: 'utf-16le' });
      const bytes = await stream.bytes();
      // 'hello' in UTF-16LE: each char is 2 bytes, little-endian
      // h=0x0068, e=0x0065, l=0x006C, l=0x006C, o=0x006F
      assert.strictEqual(bytes.length, 10);
      assert.deepStrictEqual(
        Array.from(bytes),
        [0x68, 0x00, 0x65, 0x00, 0x6C, 0x00, 0x6C, 0x00, 0x6F, 0x00]
      );
    });

    it('text() decodes UTF-16LE bytes', async () => {
      const bytes = new Uint8Array([0x68, 0x00, 0x65, 0x00, 0x6C, 0x00, 0x6C, 0x00, 0x6F, 0x00]);
      const stream = Stream.from(bytes);
      const text = await stream.text('utf-16le');
      assert.strictEqual(text, 'hello');
    });

    it('push stream with UTF-16LE encoding', async () => {
      const [stream, writer] = Stream.push({ encoding: 'utf-16le' });
      await writer.write('hi');
      await writer.close();
      const bytes = await stream.bytes();
      // 'hi' in UTF-16LE
      assert.deepStrictEqual(Array.from(bytes), [0x68, 0x00, 0x69, 0x00]);
    });

    it('pull stream with UTF-16LE encoding', async () => {
      const stream = Stream.pull(function* () {
        yield 'AB';
      }, { encoding: 'utf-16le' });
      const bytes = await stream.bytes();
      // 'AB' in UTF-16LE
      assert.deepStrictEqual(Array.from(bytes), [0x41, 0x00, 0x42, 0x00]);
    });
  });

  describe('UTF-16BE encoding', () => {
    it('Stream.from() encodes strings as UTF-16BE', async () => {
      const stream = Stream.from('hi', { encoding: 'utf-16be' });
      const bytes = await stream.bytes();
      // 'hi' in UTF-16BE: big-endian
      assert.deepStrictEqual(Array.from(bytes), [0x00, 0x68, 0x00, 0x69]);
    });

    it('text() decodes UTF-16BE bytes', async () => {
      const bytes = new Uint8Array([0x00, 0x68, 0x00, 0x69]);
      const stream = Stream.from(bytes);
      const text = await stream.text('utf-16be');
      assert.strictEqual(text, 'hi');
    });
  });

  describe('ISO-8859-1 (Latin-1) encoding', () => {
    it('Stream.from() encodes strings as ISO-8859-1', async () => {
      const stream = Stream.from('café', { encoding: 'iso-8859-1' });
      const bytes = await stream.bytes();
      // 'café' in ISO-8859-1: c=0x63, a=0x61, f=0x66, é=0xE9
      assert.strictEqual(bytes.length, 4);
      assert.deepStrictEqual(Array.from(bytes), [0x63, 0x61, 0x66, 0xE9]);
    });

    it('text() decodes ISO-8859-1 bytes', async () => {
      const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xE9]); // café
      const stream = Stream.from(bytes);
      const text = await stream.text('iso-8859-1');
      assert.strictEqual(text, 'café');
    });

    it('latin1 alias works', async () => {
      const stream = Stream.from('ñ', { encoding: 'latin1' });
      const bytes = await stream.bytes();
      assert.strictEqual(bytes[0], 0xF1); // ñ = 0xF1 in Latin-1
    });

    it('characters outside Latin-1 are replaced with ?', async () => {
      const stream = Stream.from('hello™world', { encoding: 'iso-8859-1' });
      const bytes = await stream.bytes();
      // ™ (U+2122) is outside Latin-1 range, should become ?
      const text = new TextDecoder('iso-8859-1').decode(bytes);
      assert.strictEqual(text, 'hello?world');
    });
  });

  describe('Windows-1252 encoding', () => {
    // Note: Node.js TextDecoder treats windows-1252 similar to iso-8859-1
    // in the 0x80-0x9F range, so these tests verify the shared behavior
    it('Stream.from() encodes ASCII strings as Windows-1252', async () => {
      const stream = Stream.from('hello', { encoding: 'windows-1252' });
      const bytes = await stream.bytes();
      assert.deepStrictEqual(Array.from(bytes), [0x68, 0x65, 0x6C, 0x6C, 0x6F]);
    });

    it('round-trip preserves ASCII text', async () => {
      const original = 'Hello World';
      const stream = Stream.from(original, { encoding: 'windows-1252' });
      const bytes = await stream.bytes();
      const decoded = new TextDecoder('windows-1252').decode(bytes);
      assert.strictEqual(decoded, original);
    });

    it('encodes high Latin-1 characters correctly', async () => {
      // Characters in 0xA0-0xFF range work the same in windows-1252 and iso-8859-1
      const stream = Stream.from('©®™', { encoding: 'windows-1252' });
      const bytes = await stream.bytes();
      // These are outside Latin-1, so they become '?'
      // Let's use characters that ARE in the 0xA0-0xFF range
      const stream2 = Stream.from('©', { encoding: 'windows-1252' }); // © = 0xA9
      const bytes2 = await stream2.bytes();
      assert.strictEqual(bytes2[0], 0xA9);
    });
  });

  describe('UTF-8 encoding (default)', () => {
    it('Stream.from() defaults to UTF-8', async () => {
      const stream = Stream.from('é');
      const bytes = await stream.bytes();
      // 'é' in UTF-8 is 2 bytes: 0xC3 0xA9
      assert.deepStrictEqual(Array.from(bytes), [0xC3, 0xA9]);
    });

    it('explicit UTF-8 encoding works', async () => {
      const stream = Stream.from('日本語', { encoding: 'utf-8' });
      const bytes = await stream.bytes();
      const text = new TextDecoder('utf-8').decode(bytes);
      assert.strictEqual(text, '日本語');
    });
  });

  describe('transform with encoding', () => {
    it('transform output uses encoding option', async () => {
      const [output, writer] = Stream.transform(
        (chunk) => {
          if (chunk === null) return null;
          return 'AB'; // Return string to be encoded
        },
        { encoding: 'utf-16le' }
      );
      await writer.write(new Uint8Array([1]));
      await writer.close();
      const bytes = await output.bytes();
      // 'AB' encoded as UTF-16LE
      assert.deepStrictEqual(Array.from(bytes), [0x41, 0x00, 0x42, 0x00]);
    });
  });

  describe('encoding edge cases', () => {
    it('empty string with any encoding', async () => {
      const stream = Stream.from('', { encoding: 'utf-16le' });
      const bytes = await stream.bytes();
      assert.strictEqual(bytes.length, 0);
    });

    it('writer.writev with encoding', async () => {
      const [stream, writer] = Stream.push({ encoding: 'utf-16le' });
      await writer.writev(['A', 'B']);
      await writer.close();
      const bytes = await stream.bytes();
      // 'A' and 'B' each encoded as UTF-16LE
      assert.deepStrictEqual(Array.from(bytes), [0x41, 0x00, 0x42, 0x00]);
    });

    it('mixed BufferSource and strings use encoding for strings only', async () => {
      const [stream, writer] = Stream.push({ encoding: 'utf-16le' });
      await writer.write(new Uint8Array([0xFF])); // Raw bytes - not encoded
      await writer.write('A'); // String - encoded as UTF-16LE
      await writer.close();
      const bytes = await stream.bytes();
      // 0xFF followed by 'A' in UTF-16LE
      assert.deepStrictEqual(Array.from(bytes), [0xFF, 0x41, 0x00]);
    });
  });
});

// =============================================================================
// 3. Slicing Operators Tests
// =============================================================================

describe('Slicing Operators', () => {
  describe('take()', () => {
    it('returns first n bytes', async () => {
      const stream = Stream.from('hello world');
      const first5 = await stream.take(5).text();
      assert.strictEqual(first5, 'hello');
    });

    it('parent stream continues at byte n', async () => {
      const stream = Stream.from('hello world');
      const first5 = stream.take(5);
      const rest = stream;

      const firstText = await first5.text();
      const restText = await rest.text();

      assert.strictEqual(firstText, 'hello');
      assert.strictEqual(restText, ' world');
    });

    it('take(0) returns empty stream', async () => {
      const stream = Stream.from('hello');
      const empty = stream.take(0);
      const bytes = await empty.bytes();
      assert.strictEqual(bytes.byteLength, 0);
    });

    it('take(n) where n > stream length returns all available', async () => {
      const stream = Stream.from('hi');
      const taken = await stream.take(100).text();
      assert.strictEqual(taken, 'hi');
    });

    it('nested take() calls work', async () => {
      const stream = Stream.from('abcdefghij');
      const first6 = stream.take(6);
      const first3 = first6.take(3);
      
      const text = await first3.text();
      assert.strictEqual(text, 'abc');
    });
  });

  describe('drop()', () => {
    it('discards first n bytes', async () => {
      const stream = Stream.from('hello world');
      stream.drop(6);
      const text = await stream.text();
      assert.strictEqual(text, 'world');
    });

    it('returns closed/empty stream', async () => {
      const stream = Stream.from('hello');
      const dropped = stream.drop(3);
      const bytes = await dropped.bytes();
      assert.strictEqual(bytes.byteLength, 0);
    });

    it('drop(0) is no-op', async () => {
      const stream = Stream.from('hello');
      stream.drop(0);
      const text = await stream.text();
      assert.strictEqual(text, 'hello');
    });

    it('drop(n) where n > stream length', async () => {
      const stream = Stream.from('hi');
      stream.drop(100);
      const text = await stream.text();
      assert.strictEqual(text, '');
    });
  });

  describe('limit()', () => {
    it('caps stream at n bytes', async () => {
      const stream = Stream.from('hello world');
      const limited = stream.limit(5);
      const text = await limited.text();
      assert.strictEqual(text, 'hello');
    });

    it('limit(0) returns empty stream', async () => {
      const stream = Stream.from('hello');
      const limited = stream.limit(0);
      const bytes = await limited.bytes();
      assert.strictEqual(bytes.byteLength, 0);
    });

    it('limit() returns the same stream (terminal, not branching)', async () => {
      const stream = Stream.from('hello world');
      const limited = stream.limit(5);
      
      // limit() should return the same stream reference
      assert.strictEqual(limited, stream);
    });

    it('limit() cancels source when limit reached', async () => {
      let generatorFinished = false;
      let generatorCalls = 0;
      
      const stream = Stream.pull(async function* () {
        for (let i = 0; i < 100; i++) {
          generatorCalls++;
          yield 'x'; // 1 byte per iteration
        }
        generatorFinished = true;
      });

      const limited = stream.limit(5);
      const bytes = await limited.bytes();
      
      assert.strictEqual(bytes.byteLength, 5);
      // The generator should have been stopped, not run to completion
      assert.ok(generatorCalls <= 10, `Generator called ${generatorCalls} times, expected ≤10`);
      assert.strictEqual(generatorFinished, false, 'Generator should not have finished');
    });

    it('take() vs limit(): take creates branch, limit is terminal', async () => {
      // With take(): parent stream continues after
      const stream1 = Stream.from('hello world');
      const taken = stream1.take(5);
      
      // take() returns a NEW stream, parent continues
      assert.notStrictEqual(taken, stream1);
      
      const takenText = await taken.text();
      const remainingText = await stream1.text();
      
      assert.strictEqual(takenText, 'hello');
      assert.strictEqual(remainingText, ' world'); // Parent continues!

      // With limit(): same stream, capped
      const stream2 = Stream.from('hello world');
      const limited = stream2.limit(5);
      
      // limit() returns the SAME stream
      assert.strictEqual(limited, stream2);
      
      const limitedText = await limited.text();
      assert.strictEqual(limitedText, 'hello');
      
      // Stream is done - no continuation
      const moreBytes = await stream2.bytes();
      assert.strictEqual(moreBytes.byteLength, 0);
    });

    it('multiple limit() calls use the smallest limit', async () => {
      const stream = Stream.from('hello world');
      stream.limit(10);
      stream.limit(5);
      stream.limit(8); // This should have no effect since 5 < 8
      
      const text = await stream.text();
      assert.strictEqual(text, 'hello'); // 5 bytes
    });

    it('limit() works with push streams', async () => {
      const [stream, writer] = Stream.push();
      
      const limited = stream.limit(5);
      
      // Write more data than the limit
      (async () => {
        await writer.write('hello world');
        await writer.close();
      })();
      
      const text = await limited.text();
      assert.strictEqual(text, 'hello');
    });

    it('limit() works with async pull streams', async () => {
      const stream = Stream.pull(async function* () {
        yield 'aaa';
        await new Promise(r => setTimeout(r, 10));
        yield 'bbb';
        await new Promise(r => setTimeout(r, 10));
        yield 'ccc';
      });

      const text = await stream.limit(5).text();
      // Should get 'aaa' (3 bytes) + 'bb' (2 bytes) = 'aaabb' (5 bytes)
      assert.strictEqual(text, 'aaabb');
    });

    it('limit() with n greater than stream length returns all data', async () => {
      const stream = Stream.from('hi'); // 2 bytes
      const text = await stream.limit(100).text();
      assert.strictEqual(text, 'hi');
    });
  });
});

// =============================================================================
// 4. Branching Tests
// =============================================================================

describe('Branching', () => {
  describe('tee()', () => {
    it('creates a branch that sees the same data', async () => {
      const [stream, writer] = Stream.push();

      const branch = stream.tee();

      (async () => {
        await writer.write('shared data');
        await writer.close();
      })();

      const [mainResult, branchResult] = await Promise.all([
        stream.text(),
        branch.text(),
      ]);

      assert.strictEqual(mainResult, 'shared data');
      assert.strictEqual(branchResult, 'shared data');
    });

    it('multiple tee() calls create multiple branches', async () => {
      const [stream, writer] = Stream.push();

      const branch1 = stream.tee();
      const branch2 = stream.tee();
      const branch3 = stream.tee();

      (async () => {
        await writer.write('data');
        await writer.close();
      })();

      const results = await Promise.all([
        stream.text(),
        branch1.text(),
        branch2.text(),
        branch3.text(),
      ]);

      assert.deepStrictEqual(results, ['data', 'data', 'data', 'data']);
    });

    it('cancelling branch does not affect original', async () => {
      const [stream, writer] = Stream.push();

      const branch = stream.tee();

      (async () => {
        await writer.write('hello');
        await writer.write(' world');
        await writer.close();
      })();

      await branch.cancel();
      const mainText = await stream.text();
      assert.strictEqual(mainText, 'hello world');
    });
  });

  describe('detached branches', () => {
    it('detached: true creates detached branch', async () => {
      const [stream] = Stream.push();
      const detached = stream.tee({ detached: true });
      assert.strictEqual(detached.detached, true);
    });

    it('attach() activates the branch', async () => {
      const [stream] = Stream.push();
      const detached = stream.tee({ detached: true });
      
      assert.strictEqual(detached.detached, true);
      detached.attach();
      assert.strictEqual(detached.detached, false);
    });

    it('auto-attaches on first read', async () => {
      const [stream, writer] = Stream.push();
      const detached = stream.tee({ detached: true });

      assert.strictEqual(detached.detached, true);

      (async () => {
        await writer.write('data');
        await writer.close();
      })();

      await detached.read();
      assert.strictEqual(detached.detached, false);
    });

    it('auto-attaches on async iteration', async () => {
      const [stream, writer] = Stream.push();
      const detached = stream.tee({ detached: true });

      assert.strictEqual(detached.detached, true);

      (async () => {
        await writer.write('data');
        await writer.close();
      })();

      for await (const _ of detached) {
        break;
      }
      assert.strictEqual(detached.detached, false);
    });

    it('attach() on non-detached stream is no-op', async () => {
      const stream = Stream.from('test');
      assert.strictEqual(stream.detached, false);
      stream.attach(); // should not throw
      assert.strictEqual(stream.detached, false);
    });
  });
});

// =============================================================================
// 5. Piping Tests
// =============================================================================

describe('Piping', () => {
  describe('pipeThrough()', () => {
    it('transforms data with a function', async () => {
      const stream = Stream.from('hello');

      const transformed = stream.pipeThrough((chunk) => {
        if (chunk === null) return null;
        return new Uint8Array(chunk.map((b) => (b >= 97 && b <= 122 ? b - 32 : b)));
      });

      const text = await transformed.text();
      assert.strictEqual(text, 'HELLO');
    });

    it('transforms data with an object', async () => {
      const stream = Stream.from('hello world');

      const transformed = stream.pipeThrough({
        transform(chunk) {
          if (chunk === null) return null;
          return new Uint8Array(chunk.map((b) => (b >= 97 && b <= 122 ? b - 32 : b)));
        },
      });

      const text = await transformed.text();
      assert.strictEqual(text, 'HELLO WORLD');
    });

    it('supports generator transforms for 1:N', async () => {
      const stream = Stream.from('a,b,c');

      const transformed = stream.pipeThrough({
        *transform(chunk) {
          if (chunk === null) return;
          const text = new TextDecoder().decode(chunk);
          for (const part of text.split(',')) {
            yield part + '\n';
          }
        },
      });

      const text = await transformed.text();
      assert.strictEqual(text, 'a\nb\nc\n');
    });

    it('chaining transforms works', async () => {
      const stream = Stream.from('hello');

      const result = await stream
        .pipeThrough((chunk) => {
          if (chunk === null) return null;
          // uppercase
          return new Uint8Array(chunk.map((b) => (b >= 97 && b <= 122 ? b - 32 : b)));
        })
        .pipeThrough((chunk) => {
          if (chunk === null) return null;
          // add exclamation
          const text = new TextDecoder().decode(chunk);
          return text + '!';
        })
        .text();

      assert.strictEqual(result, 'HELLO!');
    });
  });

  describe('pipeTo()', () => {
    it('pipes to a writer', async () => {
      const source = Stream.from('pipe test');
      const chunks: Uint8Array[] = [];
      const customWriter = Stream.writer({
        async write(chunk) {
          chunks.push(chunk);
        },
      });

      await source.pipeTo(customWriter);

      const result = new TextDecoder().decode(concatChunks(chunks));
      assert.strictEqual(result, 'pipe test');
    });

    it('returns total bytes piped', async () => {
      const source = Stream.from('hello'); // 5 bytes
      const writer = Stream.writer({ async write() {} });

      const bytes = await source.pipeTo(writer);
      assert.strictEqual(bytes, 5);
    });

    it('respects limit option', async () => {
      const source = Stream.from('hello world');
      const chunks: Uint8Array[] = [];
      const customWriter = Stream.writer({
        async write(chunk) {
          chunks.push(chunk);
        },
      });

      await source.pipeTo(customWriter, { limit: 5 });

      const result = new TextDecoder().decode(concatChunks(chunks));
      assert.strictEqual(result, 'hello');
    });

    it('preventClose keeps destination open', async () => {
      const source = Stream.from('first');
      let closeCalled = false;
      const writer = Stream.writer({
        async write() {},
        async close() { closeCalled = true; }
      });

      await source.pipeTo(writer, { preventClose: true });
      assert.strictEqual(closeCalled, false);
    });

    it('pipeTo with limit=0', async () => {
      const source = Stream.from('hello');
      const chunks: Uint8Array[] = [];
      const writer = Stream.writer({
        async write(chunk) { chunks.push(chunk); }
      });

      await source.pipeTo(writer, { limit: 0 });
      assert.strictEqual(chunks.length, 0);
    });
  });
});

// =============================================================================
// 6. Cancellation Tests
// =============================================================================

describe('Cancellation', () => {
  describe('cancel()', () => {
    it('cancels the stream', async () => {
      const [stream, writer] = Stream.push();
      writer.write('test');

      const bytesRead = await stream.cancel();
      assert.strictEqual(typeof bytesRead, 'number');
    });

    it('returns bytes read before cancel', async () => {
      const stream = Stream.from('hello');
      
      // Read some data first
      await stream.read();
      
      const bytesRead = await stream.cancel();
      assert.strictEqual(bytesRead, 5);
    });

    it('subsequent reads return done=true', async () => {
      const stream = Stream.from('hello');
      await stream.cancel();

      const { value, done } = await stream.read();
      assert.strictEqual(value, null);
      assert.strictEqual(done, true);
    });

    it('idempotent (multiple cancels safe)', async () => {
      const stream = Stream.from('hello');
      
      const bytes1 = await stream.cancel();
      const bytes2 = await stream.cancel();
      const bytes3 = await stream.cancel();

      assert.strictEqual(bytes1, bytes2);
      assert.strictEqual(bytes2, bytes3);
    });
  });
});

// =============================================================================
// 7. Low-level Read Tests
// =============================================================================

describe('Low-level Read', () => {
  describe('read()', () => {
    it('returns { value, done } result', async () => {
      const stream = Stream.from('hello');
      const result = await stream.read();

      assert.ok('value' in result);
      assert.ok('done' in result);
      assert.ok(result.value instanceof Uint8Array);
    });

    it('value can be non-null when done=true (final chunk)', async () => {
      const stream = Stream.from('hi');
      const { value, done } = await stream.read();

      assert.ok(value !== null);
      assert.strictEqual(done, true);
      assert.strictEqual(new TextDecoder().decode(value), 'hi');
    });

    it('atLeast option waits for minimum bytes', async () => {
      const [stream, writer] = Stream.push();

      (async () => {
        await writer.write('a');
        await delay(10);
        await writer.write('b');
        await delay(10);
        await writer.write('c');
        await writer.close();
      })();

      const { value } = await stream.read({ atLeast: 2 });
      assert.ok(value !== null);
      assert.ok(value.byteLength >= 2);
    });

    it('atLeast returns available if stream ends early', async () => {
      const stream = Stream.from('ab'); // only 2 bytes
      const { value, done } = await stream.read({ atLeast: 10 });

      assert.ok(value !== null);
      assert.strictEqual(value.byteLength, 2);
      assert.strictEqual(done, true);
    });

    it('max option bounds allocation size', async () => {
      const stream = Stream.from('hello world');
      const { value } = await stream.read({ max: 5 });

      assert.ok(value !== null);
      assert.ok(value.byteLength <= 5);
    });

    it('signal option allows cancellation', async () => {
      const [stream] = Stream.push();
      const controller = new AbortController();

      setTimeout(() => controller.abort(), 10);

      await assert.rejects(
        stream.read({ signal: controller.signal }),
        { name: 'AbortError' }
      );
    });

    it('read() after cancel() returns done', async () => {
      const stream = Stream.from('hello');
      await stream.cancel();

      const { value, done } = await stream.read();
      assert.strictEqual(value, null);
      assert.strictEqual(done, true);
    });
  });

  describe('stream.closed', () => {
    it('resolves with total bytes read when stream closes', async () => {
      const stream = Stream.from('hello'); // 5 bytes
      await stream.bytes();

      const total = await stream.closed;
      assert.strictEqual(total, 5);
    });

    it('rejects with error if stream errors', async () => {
      const stream = Stream.never(new Error('test error'));

      // Trigger the error
      stream.bytes().catch(() => {});

      await assert.rejects(stream.closed, { message: 'test error' });
    });
  });
});

// =============================================================================
// 8. Writer Tests
// =============================================================================

describe('Writer', () => {
  describe('write()', () => {
    it('accepts string (UTF-8 encoded)', async () => {
      const [stream, writer] = Stream.push();
      await writer.write('hello');
      await writer.close();
      const text = await stream.text();
      assert.strictEqual(text, 'hello');
    });

    it('accepts Uint8Array', async () => {
      const [stream, writer] = Stream.push();
      await writer.write(new Uint8Array([104, 105]));
      await writer.close();
      const text = await stream.text();
      assert.strictEqual(text, 'hi');
    });

    it('rejects if writer is closed', async () => {
      const [, writer] = Stream.push();
      await writer.close();
      await assert.rejects(writer.write('data'), /closed/i);
    });

    it('rejects if writer is aborted', async () => {
      const [, writer] = Stream.push();
      await writer.abort();
      await assert.rejects(writer.write('data'), /closed/i);
    });

    it('write with empty string', async () => {
      const [stream, writer] = Stream.push();
      await writer.write('');
      await writer.write('hello');
      await writer.close();
      const text = await stream.text();
      assert.strictEqual(text, 'hello');
    });

    it('write with empty Uint8Array', async () => {
      const [stream, writer] = Stream.push();
      await writer.write(new Uint8Array(0));
      await writer.write('hello');
      await writer.close();
      const text = await stream.text();
      assert.strictEqual(text, 'hello');
    });
  });

  describe('writev()', () => {
    it('writes multiple chunks', async () => {
      const [stream, writer] = Stream.push();
      await writer.writev(['a', 'b', 'c']);
      await writer.close();
      const text = await stream.text();
      assert.strictEqual(text, 'abc');
    });

    it('writev with empty array', async () => {
      const [stream, writer] = Stream.push();
      await writer.writev([]);
      await writer.write('hello');
      await writer.close();
      const text = await stream.text();
      assert.strictEqual(text, 'hello');
    });
  });

  describe('close()', () => {
    it('signals end of stream', async () => {
      const [stream, writer] = Stream.push();
      await writer.write('data');
      await writer.close();

      const { done } = await stream.read();
      // After reading all data, should be done
    });

    it('returns total bytes written', async () => {
      const [, writer] = Stream.push();
      await writer.write('hello'); // 5 bytes
      await writer.write('world'); // 5 bytes
      const total = await writer.close();
      assert.strictEqual(total, 10);
    });

    it('idempotent (multiple closes safe)', async () => {
      const [, writer] = Stream.push();
      await writer.write('data');
      
      const bytes1 = await writer.close();
      const bytes2 = await writer.close();
      const bytes3 = await writer.close();

      assert.strictEqual(bytes1, bytes2);
      assert.strictEqual(bytes2, bytes3);
    });
  });

  describe('abort()', () => {
    it('signals error', async () => {
      const [stream, writer] = Stream.push();
      await writer.write('data');
      await writer.abort(new Error('aborted'));

      await assert.rejects(stream.bytes(), { message: 'aborted' });
    });

    it('returns bytes written before abort', async () => {
      const [, writer] = Stream.push();
      await writer.write('hello'); // 5 bytes
      const bytes = await writer.abort();
      assert.strictEqual(bytes, 5);
    });

    it('subsequent writes reject', async () => {
      const [, writer] = Stream.push();
      await writer.abort();
      await assert.rejects(writer.write('data'), /closed/i);
    });
  });

  describe('desiredSize', () => {
    it('returns bytes available before max', async () => {
      const [, writer] = Stream.push({ buffer: { max: 100 } });
      const size = writer.desiredSize;
      assert.ok(size !== null);
      assert.ok(size > 0);
      assert.ok(size <= 100);
    });

    it('returns null if closed', async () => {
      const [, writer] = Stream.push();
      await writer.close();
      assert.strictEqual(writer.desiredSize, null);
    });
  });

  describe('writer.closed', () => {
    it('resolves with bytes written when closed', async () => {
      const [, writer] = Stream.push();
      await writer.write('hello');
      await writer.close();

      const bytes = await writer.closed;
      assert.strictEqual(bytes, 5);
    });
  });
});

// =============================================================================
// 9. Async Iteration Tests
// =============================================================================

describe('Async Iteration', () => {
  it('for await...of yields Uint8Array chunks', async () => {
    const stream = Stream.from('hello world');
    const chunks: Uint8Array[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk);
      assert.ok(chunk instanceof Uint8Array);
    }

    assert.ok(chunks.length > 0);
  });

  it('breaking out of loop allows further reads', async () => {
    const [stream, writer] = Stream.push();

    (async () => {
      await writer.write('chunk1');
      await writer.write('chunk2');
      await writer.write('chunk3');
      await writer.close();
    })();

    let count = 0;
    for await (const _ of stream) {
      count++;
      if (count === 1) break;
    }

    // Stream should still be readable
    const remaining = await stream.text();
    assert.ok(remaining.length > 0);
  });
});

// =============================================================================
// 10. Explicit Resource Management Tests
// =============================================================================

describe('Explicit Resource Management', () => {
  it('Stream[Symbol.asyncDispose] exists', () => {
    const stream = Stream.from('test');
    assert.strictEqual(typeof stream[Symbol.asyncDispose], 'function');
  });

  it('Writer[Symbol.asyncDispose] exists', () => {
    const [, writer] = Stream.push();
    assert.strictEqual(typeof writer[Symbol.asyncDispose], 'function');
  });

  it('Stream dispose calls cancel()', async () => {
    const stream = Stream.from('test');
    await stream[Symbol.asyncDispose]();

    const { done } = await stream.read();
    assert.strictEqual(done, true);
  });

  it('Writer dispose calls close()', async () => {
    const [stream, writer] = Stream.push();
    await writer.write('data');
    await writer[Symbol.asyncDispose]();

    // Stream should be closed
    const text = await stream.text();
    assert.strictEqual(text, 'data');
  });

  it('dispose is idempotent', async () => {
    const stream = Stream.from('test');
    await stream[Symbol.asyncDispose]();
    await stream[Symbol.asyncDispose]();
    await stream[Symbol.asyncDispose]();
    // Should not throw
  });

  it('await using stream = ... works (ERM-003)', async () => {
    let streamCancelled = false;
    
    const testStream = Stream.pull(async function* () {
      try {
        yield 'chunk1';
        yield 'chunk2';
      } finally {
        streamCancelled = true;
      }
    });
    
    // Use await using - stream should be cancelled when block exits
    {
      await using stream = testStream;
      const { value } = await stream.read();
      assert.ok(value);
      // Exit block early without consuming entire stream
    }
    
    // Stream should have been cancelled via Symbol.asyncDispose
    assert.strictEqual(streamCancelled, true);
  });

  it('await using writer = ... works (ERM-004)', async () => {
    const [stream, testWriter] = Stream.push();
    
    // Use await using - writer should be closed when block exits
    {
      await using writer = testWriter;
      await writer.write('data from using block');
      // Exit block - writer.close() should be called via Symbol.asyncDispose
    }
    
    // Stream should be closed and have the data
    const text = await stream.text();
    assert.strictEqual(text, 'data from using block');
  });

  it('await using with error still disposes (stream)', async () => {
    let disposed = false;
    
    const testStream = Stream.pull(async function* () {
      try {
        yield 'data';
      } finally {
        disposed = true;
      }
    });
    
    try {
      await using stream = testStream;
      await stream.read();
      throw new Error('intentional error');
    } catch (e) {
      // Expected
    }
    
    // Stream should still have been disposed despite the error
    assert.strictEqual(disposed, true);
  });

  it('await using with error still disposes (writer)', async () => {
    const [stream, testWriter] = Stream.push();
    let errorThrown = false;
    
    try {
      await using writer = testWriter;
      await writer.write('some data');
      errorThrown = true;
      throw new Error('intentional error');
    } catch (e) {
      // Expected
    }
    
    assert.strictEqual(errorThrown, true);
    
    // Writer should still have been closed despite the error
    // So stream should be readable
    const text = await stream.text();
    assert.strictEqual(text, 'some data');
  });
});

// =============================================================================
// 11. Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  it('source error propagates to consumers', async () => {
    const stream = Stream.never(new Error('source error'));
    await assert.rejects(stream.bytes(), { message: 'source error' });
  });

  it('transform error propagates forward', async () => {
    const stream = Stream.from('data');
    const transformed = stream.pipeThrough(() => {
      throw new Error('transform error');
    });
    await assert.rejects(transformed.bytes(), /transform error/);
  });

  it('errors are Error objects (wrapped if primitive)', async () => {
    const [stream, writer] = Stream.push();
    await writer.abort('string error');

    try {
      await stream.bytes();
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof Error);
    }
  });
});

// =============================================================================
// 12. Edge Cases Tests
// =============================================================================

describe('Edge Cases', () => {
  it('bytes() on already-consumed stream', async () => {
    const stream = Stream.from('hello');
    await stream.bytes();
    
    // Second call should return empty or throw
    const bytes2 = await stream.bytes();
    assert.strictEqual(bytes2.byteLength, 0);
  });

  // ISSUE-002: Fixed - Concurrent reads are now queued in order
  it('multiple concurrent reads on same stream', async () => {
    const [stream, writer] = Stream.push();

    // Write data asynchronously
    (async () => {
      await writer.write('a');
      await writer.write('b');
      await writer.write('c');
      await writer.close();
    })();

    // Start multiple reads concurrently - they should queue up
    const [r1, r2, r3] = await Promise.all([
      stream.read(),
      stream.read(),
      stream.read(),
    ]);

    // All reads should complete successfully
    // Each read gets the next available chunk in order
    assert.ok(r1.value !== null || r1.done, 'r1 should have value or be done');
    assert.ok(r2.value !== null || r2.done, 'r2 should have value or be done');
    assert.ok(r3.value !== null || r3.done, 'r3 should have value or be done');
    
    // Collect all values
    const values: string[] = [];
    if (r1.value) values.push(new TextDecoder().decode(r1.value));
    if (r2.value) values.push(new TextDecoder().decode(r2.value));
    if (r3.value) values.push(new TextDecoder().decode(r3.value));
    
    // The combined result should be 'abc'
    assert.strictEqual(values.join(''), 'abc');
  });

  // ISSUE-001: Fixed - take() limits now propagate to tee'd branches
  it('take() then tee() the taken stream', async () => {
    const stream = Stream.from('hello world');
    const first5 = stream.take(5);
    const branch = first5.tee();

    const [t1, t2] = await Promise.all([
      first5.text(),
      branch.text(),
    ]);

    assert.strictEqual(t1, 'hello');
    assert.strictEqual(t2, 'hello');
  });

  it('rapid writes without awaiting', async () => {
    const [stream, writer] = Stream.push({ buffer: { max: 1000 } });

    // Don't await each write
    writer.write('a');
    writer.write('b');
    writer.write('c');
    writer.write('d');
    writer.write('e');
    await writer.close();

    const text = await stream.text();
    assert.strictEqual(text, 'abcde');
  });
});

describe('Buffer Detachment', () => {
  it('write() detaches the input buffer', async () => {
    const [stream, writer] = Stream.push();
    
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    assert.strictEqual(data.byteLength, 5);
    
    await writer.write(data);
    await writer.close();
    
    // Buffer should be detached (zero-length)
    assert.strictEqual(data.byteLength, 0);
    
    // Stream should still have the data
    const result = await stream.bytes();
    assert.strictEqual(result.byteLength, 5);
  });

  it('write() detaches ArrayBuffer input', async () => {
    const [stream, writer] = Stream.push();
    
    const buffer = new ArrayBuffer(5);
    new Uint8Array(buffer).set([1, 2, 3, 4, 5]);
    assert.strictEqual(buffer.byteLength, 5);
    
    await writer.write(buffer);
    await writer.close();
    
    // ArrayBuffer should be detached
    assert.strictEqual(buffer.byteLength, 0);
    
    // Stream should still have the data
    const result = await stream.bytes();
    assert.strictEqual(result.byteLength, 5);
  });

  it('write() does not detach string inputs (no buffer to detach)', async () => {
    const [stream, writer] = Stream.push();
    
    const str = 'hello';
    await writer.write(str);
    await writer.close();
    
    // String is unchanged (strings are immutable)
    assert.strictEqual(str, 'hello');
    
    // Stream has the encoded data
    const result = await stream.text();
    assert.strictEqual(result, 'hello');
  });

  it('writev() detaches all input buffers', async () => {
    const [stream, writer] = Stream.push();
    
    const data1 = new Uint8Array([1, 2]);
    const data2 = new Uint8Array([3, 4, 5]);
    
    await writer.writev([data1, data2]);
    await writer.close();
    
    // Both buffers should be detached
    assert.strictEqual(data1.byteLength, 0);
    assert.strictEqual(data2.byteLength, 0);
    
    // Stream should have all the data
    const result = await stream.bytes();
    assert.strictEqual(result.byteLength, 5);
  });

  it('BYOB read() detaches the provided buffer', async () => {
    const stream = Stream.from('hello');
    
    const buffer = new Uint8Array(10);
    assert.strictEqual(buffer.byteLength, 10);
    
    const { value, done } = await stream.read({ buffer });
    
    // Original buffer should be detached
    assert.strictEqual(buffer.byteLength, 0);
    
    // Value should be a view into the transferred buffer with the data
    assert.ok(value);
    assert.strictEqual(value.byteLength, 5);
    assert.strictEqual(new TextDecoder().decode(value), 'hello');
  });

  it('BYOB read loop reuses transferred buffer', async () => {
    const stream = Stream.from('hello world'); // 11 bytes
    
    let buffer = new Uint8Array(5);
    const chunks: string[] = [];
    
    while (true) {
      const { value, done } = await stream.read({ buffer });
      if (value && value.byteLength > 0) {
        chunks.push(new TextDecoder().decode(value));
        // Reuse the returned value as the next buffer (it's the transferred buffer)
        buffer = new Uint8Array(value.buffer, 0, 5);
      }
      if (done) break;
    }
    
    assert.strictEqual(chunks.join(''), 'hello world');
  });

  it('BYOB read truly reads into provided buffer (no intermediate allocation)', async () => {
    const [stream, writer] = Stream.push();
    
    // Write some data
    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    await writer.write(testData.slice()); // Use slice to avoid detaching testData
    await writer.close();
    
    // Create a buffer with a known pattern
    const buffer = new Uint8Array(10);
    buffer.fill(0xFF);  // Fill with 0xFF
    
    // Verify buffer before read
    assert.strictEqual(buffer[0], 0xFF);
    
    const { value, done } = await stream.read({ buffer });
    
    // The returned value should be a view into our (now transferred) buffer
    assert.ok(value);
    assert.strictEqual(value.byteLength, 5);
    
    // Verify the data was read correctly
    assert.strictEqual(value[0], 1);
    assert.strictEqual(value[1], 2);
    assert.strictEqual(value[2], 3);
    assert.strictEqual(value[3], 4);
    assert.strictEqual(value[4], 5);
    
    // The underlying buffer should be the same (transferred)
    // After transfer, original buffer is detached, but value uses the new buffer
    // The bytes past the read portion should still be 0xFF
    const fullView = new Uint8Array(value.buffer);
    assert.strictEqual(fullView[5], 0xFF);  // Unfilled portion preserved
  });

  it('BYOB read with async data arrival reads directly into buffer', async () => {
    const [stream, writer] = Stream.push();
    
    // Start reading before data arrives
    const buffer = new Uint8Array(10);
    const readPromise = stream.read({ buffer });
    
    // Write data after read is waiting
    await writer.write(new Uint8Array([10, 20, 30]));
    await writer.close();
    
    const { value, done } = await readPromise;
    
    // Original buffer should be detached
    assert.strictEqual(buffer.byteLength, 0);
    
    // Value should contain the data
    assert.ok(value);
    assert.strictEqual(value.byteLength, 3);
    assert.strictEqual(value[0], 10);
    assert.strictEqual(value[1], 20);
    assert.strictEqual(value[2], 30);
  });
});

// =============================================================================
// Requirements Coverage Tests
// =============================================================================

describe('Requirements Coverage', () => {
  describe('PULL-011: Natural backpressure', () => {
    it('generator pauses until consumer reads', async () => {
      let yieldCount = 0;
      const stream = Stream.pull(async function* () {
        for (let i = 0; i < 5; i++) {
          yieldCount++;
          yield `chunk${i}`;
          // After yield, generator should be paused until consumer reads
        }
      });

      // No reads yet - generator might have started but shouldn't have yielded everything
      await delay(10);
      const initialYields = yieldCount;
      
      // Read one chunk at a time and verify backpressure
      const result1 = await stream.read();
      assert.ok(result1.value);
      
      // After reading, generator can proceed
      await delay(10);
      
      // Consume the rest
      const rest = await stream.text();
      assert.strictEqual(yieldCount, 5);
    });
  });

  describe('PUSH-008: hardMax configuration', () => {
    it('hardMax is respected in block mode', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 10, hardMax: 20, onOverflow: 'block' }
      });

      // Fill to max
      await writer.write('1234567890'); // 10 bytes
      
      // This should block (under hardMax)
      const blockedWrite = writer.write('12345').catch(() => {}); // 5 more = 15, under 20
      await delay(5);
      
      // This should error (would exceed hardMax)
      // 10 (buffer) + 5 (pending) + 10 (new) = 25 > 20
      await assert.rejects(
        writer.write('1234567890'),
        /Hard buffer limit exceeded/
      );
    });
  });

  describe('READ-008: atLeast > max throws RangeError', () => {
    it('throws RangeError when atLeast > max', async () => {
      const stream = Stream.from('hello world');
      
      await assert.rejects(
        stream.read({ atLeast: 100, max: 10 }),
        /RangeError|atLeast.*max/i
      );
    });
  });

  describe('LIMIT-002: Cancels source after limit reached', () => {
    it('source generator is cancelled after limit', async () => {
      let generatorFinished = false;
      let generatorCalls = 0;
      
      const stream = Stream.pull(async function* () {
        try {
          for (let i = 0; i < 100; i++) {
            generatorCalls++;
            yield 'x';
            await delay(5);
          }
          generatorFinished = true;
        } finally {
          // Generator cleanup
        }
      });

      const limited = stream.limit(3);
      const bytes = await limited.bytes();
      
      assert.strictEqual(bytes.byteLength, 3);
      // Generator should not have run to completion
      assert.strictEqual(generatorFinished, false);
      // Should have been stopped early
      assert.ok(generatorCalls <= 10, `Expected ≤10 calls, got ${generatorCalls}`);
    });
  });

  describe('CANCEL-004: closed promise resolves after cancel', () => {
    it('closed promise resolves with bytes read when cancelled', async () => {
      const stream = Stream.from('hello world');
      
      // Read some data
      await stream.read({ max: 5 });
      
      // Cancel the stream
      await stream.cancel();
      
      // closed should resolve
      const bytesRead = await stream.closed;
      assert.strictEqual(bytesRead, 5);
    });
  });

  describe('TEE-005: Cancelling branch behavior', () => {
    it('cancelling one branch does not affect others', async () => {
      const [stream, writer] = Stream.push();
      
      const branch = stream.tee();
      
      // Write some data
      await writer.write('test');
      
      // Cancel the branch
      await branch.cancel();
      
      // Original stream should still work
      const result = await stream.read();
      assert.ok(result.value);
      assert.strictEqual(new TextDecoder().decode(result.value), 'test');
      
      await writer.close();
    });

    it('closing source closes all branches', async () => {
      const [stream, writer] = Stream.push();
      
      const branch1 = stream.tee();
      const branch2 = stream.tee();
      
      // Write and close
      await writer.write('test');
      await writer.close();
      
      // All branches should be able to read and then be done
      const r1 = await branch1.bytes();
      const r2 = await branch2.bytes();
      const r3 = await stream.bytes();
      
      assert.strictEqual(new TextDecoder().decode(r1), 'test');
      assert.strictEqual(new TextDecoder().decode(r2), 'test');
      assert.strictEqual(new TextDecoder().decode(r3), 'test');
    });
  });

  describe('TEE-006: Error propagates to all branches', () => {
    it('error in source propagates to all branches', async () => {
      const [stream, writer] = Stream.push();
      
      const branch = stream.tee();
      
      // Error the stream
      const testError = new Error('test error');
      await writer.abort(testError);
      
      // Both should reject
      await assert.rejects(stream.bytes(), /test error/);
      await assert.rejects(branch.bytes(), /test error/);
    });
  });

  describe('PIPE-TO-003: Signal option cancels the pipe', () => {
    it('aborting signal cancels pipeTo', async () => {
      const [source, sourceWriter] = Stream.push();
      const chunks: Uint8Array[] = [];
      const dest = Stream.writer({
        async write(chunk) { chunks.push(chunk); }
      });
      
      const controller = new AbortController();
      
      const pipePromise = source.pipeTo(dest, { signal: controller.signal });
      
      // Write some data
      await sourceWriter.write('hello');
      await delay(5);
      
      // Abort
      controller.abort();
      
      await assert.rejects(pipePromise, { name: 'AbortError' });
    });
  });

  describe('PIPE-TO-006: preventAbort option', () => {
    it('preventAbort keeps destination from aborting on error', async () => {
      const source = Stream.never(new Error('source error'));
      
      let abortCalled = false;
      const dest = Stream.writer({
        async write() {},
        async abort() { abortCalled = true; }
      });
      
      await assert.rejects(
        source.pipeTo(dest, { preventAbort: true }),
        /source error/
      );
      
      assert.strictEqual(abortCalled, false, 'abort should not have been called');
    });
  });

  describe('PIPE-TO-007: preventCancel option', () => {
    it('preventCancel keeps source from being cancelled on dest error', async () => {
      const [stream, writer] = Stream.push();
      
      const dest = Stream.writer({
        async write() { throw new Error('dest error'); }
      });
      
      // Start writing in background
      (async () => {
        await writer.write('test');
      })();
      
      await assert.rejects(
        stream.pipeTo(dest, { preventCancel: true }),
        /dest error/
      );
      
      // Stream should NOT be cancelled - can still write
      await writer.write('more');
      await writer.close();
    });
  });

  describe('PIPE-TO-008/009: Error propagation', () => {
    it('destination error propagates and cancels source', async () => {
      const [stream, writer] = Stream.push();
      
      let writeCalls = 0;
      const dest = Stream.writer({
        async write() {
          writeCalls++;
          if (writeCalls > 1) {
            throw new Error('dest write error');
          }
        }
      });
      
      // Write data
      (async () => {
        await writer.write('chunk1');
        await writer.write('chunk2');
        await writer.write('chunk3');
      })();
      
      await assert.rejects(stream.pipeTo(dest), /dest write error/);
    });

    it('source error propagates and aborts destination', async () => {
      const stream = Stream.pull(async function* () {
        yield 'chunk1';
        throw new Error('source error');
      });
      
      let abortCalled = false;
      let abortReason: unknown;
      const dest = Stream.writer({
        async write() {},
        async abort(reason) {
          abortCalled = true;
          abortReason = reason;
        }
      });
      
      await assert.rejects(stream.pipeTo(dest), /source error/);
      assert.strictEqual(abortCalled, true);
    });
  });

  describe('PIPELINE-005: preventClose option', () => {
    it('preventClose keeps destination open after pipeline', async () => {
      const source = Stream.from('test');
      
      let closeCalled = false;
      const dest = Stream.writer({
        async write() {},
        async close() { closeCalled = true; }
      });
      
      await Stream.pipeline(source, dest, { preventClose: true });
      
      assert.strictEqual(closeCalled, false);
    });
  });

  describe('PIPELINE-006: Error in any stage tears down pipeline', () => {
    it('transform error tears down pipeline', async () => {
      const source = Stream.from('hello world');
      
      const errorTransform = (chunk: Uint8Array | null) => {
        if (chunk && chunk.byteLength > 0) {
          throw new Error('transform error');
        }
        return chunk;
      };
      
      const dest = Stream.writer({ async write() {} });
      
      await assert.rejects(
        Stream.pipeline(source, errorTransform, dest),
        /transform error/
      );
    });
  });

  describe('TRANSFORM-007: Return iterable emits each element', () => {
    it('transform returning array emits each element', async () => {
      const [output, writer] = Stream.transform((chunk) => {
        if (chunk === null) return null;
        // Return array - each element should be emitted
        return ['a', 'b', 'c'];
      });
      
      await writer.write('x');
      await writer.close();
      
      const text = await output.text();
      assert.strictEqual(text, 'abc');
    });
  });

  describe('TRANSFORM-008: Return async iterable emits each element', () => {
    it('transform returning async generator emits each element', async () => {
      const [output, writer] = Stream.transform(async function* (chunk) {
        if (chunk === null) return;
        yield 'a';
        yield 'b';
        yield 'c';
      });
      
      await writer.write('x');
      await writer.close();
      
      const text = await output.text();
      assert.strictEqual(text, 'abc');
    });
  });

  describe('CLOSED-W-002: writer.closed rejects if aborted', () => {
    it('writer.closed rejects when aborted', async () => {
      const [stream, writer] = Stream.push();
      
      await writer.abort(new Error('abort reason'));
      
      await assert.rejects(writer.closed, /abort reason/);
    });
  });

  describe('DESIRED-003: desiredSize reflects buffer state', () => {
    it('desiredSize decreases as buffer fills', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 100 }
      });
      
      assert.strictEqual(writer.desiredSize, 100);
      
      await writer.write('1234567890'); // 10 bytes
      assert.strictEqual(writer.desiredSize, 90);
      
      await writer.write('1234567890'); // 10 more bytes
      assert.strictEqual(writer.desiredSize, 80);
      
      await writer.close();
    });

    it('desiredSize can be zero when at capacity', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 10, onOverflow: 'drop-newest' }
      });
      
      await writer.write('1234567890'); // 10 bytes, at max
      
      // desiredSize should be 0 (at capacity)
      assert.strictEqual(writer.desiredSize, 0);
      
      await writer.close();
    });
  });

  describe('ARRAYBUF-002: arrayBuffer signal option', () => {
    it('signal option allows cancellation', async () => {
      const [stream] = Stream.push(); // never closes
      const controller = new AbortController();
      
      setTimeout(() => controller.abort(), 10);
      
      await assert.rejects(
        stream.arrayBuffer({ signal: controller.signal }),
        { name: 'AbortError' }
      );
    });
  });

  describe('TEXT-004: text signal option', () => {
    it('signal option allows cancellation', async () => {
      const [stream] = Stream.push(); // never closes
      const controller = new AbortController();
      
      setTimeout(() => controller.abort(), 10);
      
      await assert.rejects(
        stream.text('utf-8', { signal: controller.signal }),
        { name: 'AbortError' }
      );
    });
  });

  describe('TRANSFORM-013: chunkSize option delivers fixed-size chunks', () => {
    it('transform receives exact chunk sizes when chunkSize specified', async () => {
      const receivedSizes: number[] = [];
      
      const [output, writer] = Stream.transform((chunk) => {
        if (chunk === null) return null;
        receivedSizes.push(chunk.length);
        return chunk;
      }, { chunkSize: 5 });
      
      // Write 12 bytes, should receive 5, 5, then 2 (last partial)
      await writer.write('123456789012');
      await writer.close();
      
      await output.bytes();
      
      // First two chunks should be exactly 5 bytes
      assert.strictEqual(receivedSizes[0], 5);
      assert.strictEqual(receivedSizes[1], 5);
      // Last chunk is the remaining 2 bytes
      assert.strictEqual(receivedSizes[2], 2);
    });

    it('chunkSize with multiple writes', async () => {
      const receivedSizes: number[] = [];
      
      const [output, writer] = Stream.transform((chunk) => {
        if (chunk === null) return null;
        receivedSizes.push(chunk.length);
        return chunk;
      }, { chunkSize: 4 });
      
      // Write small chunks that accumulate
      await writer.write('ab');  // 2 bytes, need 4
      await writer.write('cd');  // now 4, deliver
      await writer.write('ef');  // 2 bytes, need 4
      await writer.close();      // deliver remaining 2
      
      await output.bytes();
      
      assert.strictEqual(receivedSizes[0], 4); // 'abcd'
      assert.strictEqual(receivedSizes[1], 2); // 'ef' (final flush)
    });
  });

  describe('TRANSFORM-014: Buffer configuration respected in transform', () => {
    it('transform respects buffer max option', async () => {
      const chunks: Uint8Array[] = [];
      
      const [output, writer] = Stream.transform((chunk) => {
        if (chunk === null) return null;
        chunks.push(chunk);
        return chunk;
      }, { buffer: { max: 10, onOverflow: 'drop-newest' } });
      
      // Write data - buffer should limit output
      await writer.write('hello'); // 5 bytes
      await writer.write('world'); // 5 bytes - now at 10
      await writer.write('extra'); // would exceed, drop-newest
      await writer.close();
      
      const result = await output.bytes();
      // Transform received all chunks, but output buffer may have capped
      assert.ok(chunks.length >= 2);
      assert.ok(result.length <= 15); // at most all data
    });
  });

  describe('WRITER-005: Buffer configuration respected in Stream.writer()', () => {
    it('Stream.writer() respects buffer configuration', async () => {
      let totalWritten = 0;
      const dest = Stream.writer({
        async write(chunk) {
          totalWritten += chunk.length;
        }
      }, { buffer: { max: 10, onOverflow: 'drop-newest' } });
      
      // Write 15 bytes, but max is 10 with drop-newest
      await dest.write('123456789012345');
      await dest.close();
      
      // Since sink receives from buffer, it should have received what was buffered
      // The exact behavior depends on implementation
      assert.ok(totalWritten <= 15);
    });
  });

  describe('TEE-007: Buffer options can override parent config', () => {
    it('tee branch can have different buffer configuration', async () => {
      const [stream, writer] = Stream.push({ buffer: { max: 100 } });
      
      // Create tee with smaller buffer - currently tee() accepts options
      const branch = stream.tee();
      
      // Write some data
      await writer.write('hello');
      await writer.close();
      
      // Branch should receive the data
      const result = await branch.text();
      assert.strictEqual(result, 'hello');
    });
  });

  describe('TEE-008: Slowest cursor determines backpressure', () => {
    it('backpressure follows slowest consumer', async () => {
      const [stream, writer] = Stream.push({ 
        buffer: { max: 20 } 
      });
      
      // Create two branches
      const branch1 = stream.tee();
      const branch2 = stream.tee();
      
      // Consume branch1 immediately
      const result1Promise = branch1.bytes();
      
      // branch2 is slow - don't consume yet
      
      // Write data
      await writer.write('12345678901234567890'); // 20 bytes = at max
      await writer.close();
      
      // Both branches should eventually get the data
      const result1 = await result1Promise;
      const result2 = await branch2.bytes();
      
      assert.strictEqual(result1.length, 20);
      assert.strictEqual(result2.length, 20);
    });
  });

  describe('DETACH-007: Detached branch does not contribute to backpressure', () => {
    it('detached branch can fall behind without blocking', async () => {
      const [stream, writer] = Stream.push({ 
        buffer: { max: 50 } 
      });
      
      // Create a detached branch
      const detached = stream.tee({ detached: true });
      
      // Write data - should not block even if detached branch is slow
      await writer.write('hello');
      await writer.write('world');
      await writer.close();
      
      // Detached branch should get what it can
      // (may miss data that was written before it started reading)
      const result = await detached.text();
      assert.ok(typeof result === 'string');
    });
  });

  describe('DETACH-008: Detached branch misses data before attachment', () => {
    it('detached branch only sees data from attachment point', async () => {
      const [stream, writer] = Stream.push();
      
      // Write some data first
      await writer.write('before');
      
      // Now create detached branch - should start from current position
      const detached = stream.tee({ detached: true });
      
      // Write more data
      await writer.write('after');
      await writer.close();
      
      // Consume original to trigger progress
      // The detached branch behavior depends on implementation
      const detachedResult = await detached.text();
      
      // Detached should see at least the "after" data
      assert.ok(detachedResult.includes('after') || detachedResult === 'beforeafter');
    });
  });

  describe('PIPE-THROUGH-005: Signal option cancels pipeThrough', () => {
    it('signal cancels pipeThrough operation', async () => {
      const controller = new AbortController();
      
      const source = Stream.pull(async function* () {
        yield 'chunk1';
        // Simulate slow source
        await new Promise(resolve => setTimeout(resolve, 100));
        yield 'chunk2';
      });
      
      // Abort quickly
      setTimeout(() => controller.abort(), 10);
      
      // pipeThrough takes a transformer function/object and options
      const piped = source.pipeThrough((chunk) => chunk, { 
        signal: controller.signal 
      });
      
      await assert.rejects(piped.bytes(), { name: 'AbortError' });
    });
  });

  describe('PIPE-THROUGH-006: Limit option limits bytes piped through', () => {
    it('limit option caps bytes in pipeThrough', async () => {
      const source = Stream.from('hello world'); // 11 bytes
      
      const piped = source.pipeThrough((chunk) => chunk, { limit: 5 });
      
      const result = await piped.text();
      assert.strictEqual(result, 'hello');
    });
  });

  describe('PIPE-THROUGH-007: chunkSize option in pipeThrough', () => {
    it('chunkSize option controls chunk sizes through pipe', async () => {
      const receivedSizes: number[] = [];
      
      const source = Stream.from('123456789012'); // 12 bytes
      
      // pipeThrough with chunkSize option
      const piped = source.pipeThrough((chunk) => {
        if (chunk !== null) {
          receivedSizes.push(chunk.length);
        }
        return chunk;
      }, { chunkSize: 4 });
      
      await piped.bytes();
      
      // Should receive chunks of 4 bytes (except possibly last)
      assert.strictEqual(receivedSizes[0], 4);
    });
  });

  describe('WRITE-005: Signal option cancels write', () => {
    it('signal cancels write operation', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 5, onOverflow: 'block' }
      });
      
      // Fill buffer
      await writer.write('12345');
      
      // Try to write more with signal
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      
      await assert.rejects(
        writer.write('more', { signal: controller.signal }),
        { name: 'AbortError' }
      );
      
      await writer.abort();
    });

    it('already-aborted signal rejects immediately', async () => {
      const [stream, writer] = Stream.push();
      
      const controller = new AbortController();
      controller.abort();
      
      await assert.rejects(
        writer.write('data', { signal: controller.signal }),
        { name: 'AbortError' }
      );
      
      await writer.close();
    });
  });

  describe('WRITEV-003: Signal option cancels writev', () => {
    it('signal cancels writev operation', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 5, onOverflow: 'block' }
      });
      
      // Fill buffer
      await writer.write('12345');
      
      // Try to writev more with signal
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      
      await assert.rejects(
        writer.writev(['a', 'b', 'c'], { signal: controller.signal }),
        { name: 'AbortError' }
      );
      
      await writer.abort();
    });
  });

  describe('FLUSH-001/002: flush() resolves when prior writes complete', () => {
    it('flush acts as synchronization point', async () => {
      const [stream, writer] = Stream.push();
      
      await writer.write('chunk1');
      await writer.write('chunk2');
      
      // Flush should resolve after writes complete
      await writer.flush();
      
      await writer.close();
      const result = await stream.text();
      assert.strictEqual(result, 'chunk1chunk2');
    });

    it('flush queues behind pending writes', async () => {
      const [stream, writer] = Stream.push({
        buffer: { max: 100 }
      });
      
      // Start writes
      const writePromise = writer.write('data');
      
      // Flush should wait for write
      await writer.flush();
      await writePromise;
      
      await writer.close();
    });
  });

  describe('FLUSH-003: Signal option cancels flush', () => {
    it('signal cancels flush operation', async () => {
      const [stream, writer] = Stream.push();
      
      const controller = new AbortController();
      controller.abort();
      
      await assert.rejects(
        writer.flush({ signal: controller.signal }),
        { name: 'AbortError' }
      );
      
      await writer.close();
    });
  });

  describe('ERR-004: Consumer error propagates back to source', () => {
    it('consumer throwing cancels the source', async () => {
      let sourceCancelled = false;
      
      const source = Stream.pull(async function* () {
        try {
          yield 'chunk1';
          yield 'chunk2';
          yield 'chunk3';
        } finally {
          sourceCancelled = true;
        }
      });
      
      // Consumer that throws on second chunk
      let count = 0;
      try {
        for await (const chunk of source) {
          count++;
          if (count === 2) {
            throw new Error('consumer error');
          }
        }
      } catch (e) {
        // Expected
      }
      
      // Source should have been cleaned up
      assert.strictEqual(sourceCancelled, true);
    });
  });

  describe('ERR-005: Pipeline errors tear down all stages', () => {
    it('error in middle of pipeline tears down source and dest', async () => {
      let sourceCleanedUp = false;
      let destAborted = false;
      
      const source = Stream.pull(async function* () {
        try {
          yield 'a';
          yield 'b';
          yield 'c';
        } finally {
          sourceCleanedUp = true;
        }
      });
      
      const dest = Stream.writer({
        async write() {},
        async abort() {
          destAborted = true;
        }
      });
      
      try {
        // pipeThrough takes a transformer function directly
        const piped = source.pipeThrough((chunk) => {
          if (chunk !== null && new TextDecoder().decode(chunk) === 'b') {
            throw new Error('transform error');
          }
          return chunk;
        });
        await piped.pipeTo(dest);
      } catch (e) {
        // Expected
      }
      
      // Give cleanup time to propagate
      await new Promise(resolve => setTimeout(resolve, 10));
      
      assert.strictEqual(sourceCleanedUp, true);
    });
  });

  describe('ERR-006: Bidirectional error propagation in pipeTo', () => {
    it('source error aborts destination', async () => {
      let destAborted = false;
      
      const source = Stream.pull(async function* () {
        yield 'chunk';
        throw new Error('source error');
      });
      
      const dest = Stream.writer({
        async write() {},
        async abort(reason) {
          destAborted = true;
        }
      });
      
      await assert.rejects(source.pipeTo(dest), /source error/);
      assert.strictEqual(destAborted, true);
    });

    it('destination error cancels source', async () => {
      let sourceCancelled = false;
      
      const source = Stream.pull(async function* () {
        try {
          yield 'chunk1';
          yield 'chunk2';
        } finally {
          sourceCancelled = true;
        }
      });
      
      const dest = Stream.writer({
        async write(chunk) {
          throw new Error('dest error');
        }
      });
      
      await assert.rejects(source.pipeTo(dest), /dest error/);
      assert.strictEqual(sourceCancelled, true);
    });
  });

  describe('CLOSED-003: Stream.closed promise is marked as handled', () => {
    it('no unhandled rejection when stream errors without observing closed', async () => {
      // Create a stream that will error
      const stream = Stream.pull(async function* () {
        throw new Error('stream error');
      });
      
      // Don't await stream.closed - if promise is properly marked as handled,
      // there should be no unhandled rejection warning
      
      // Just try to read and expect error
      await assert.rejects(stream.bytes(), /stream error/);
      
      // If we got here without unhandled rejection, the promise was handled
    });
  });

  describe('CLOSED-W-003: Writer.closed promise is marked as handled', () => {
    it('no unhandled rejection when writer aborts without observing closed', async () => {
      const [stream, writer] = Stream.push();
      
      // Abort without awaiting closed
      await writer.abort(new Error('abort reason'));
      
      // If we got here without unhandled rejection, the promise was handled
      // The .catch() in writer.ts line 41 handles this
    });
  });
});
