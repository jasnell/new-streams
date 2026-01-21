/**
 * Stream Piping
 * 
 * This file demonstrates pipeTo(), Stream.pipeline(), and Stream.writer().
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // Stream.writer() - Create a writer with custom sink
  // ============================================================================
  section('Stream.writer() - Custom sinks');

  // Basic custom sink
  {
    const chunks: string[] = [];
    
    const writer = Stream.writer({
      async write(chunk) {
        chunks.push(new TextDecoder().decode(chunk));
      }
    });
    
    await writer.write('chunk1 ');
    await writer.write('chunk2');
    await writer.close();
    
    console.log('Sink received:', chunks);
  }

  // Sink with close() callback
  {
    let closeCalled = false;
    
    const writer = Stream.writer({
      async write(chunk) {
        console.log('Writing:', new TextDecoder().decode(chunk));
      },
      async close() {
        closeCalled = true;
        console.log('Sink closed');
      }
    });
    
    await writer.write('data');
    await writer.close();
    console.log('close() called:', closeCalled);
  }

  // Sink with abort() callback
  {
    let abortReason: unknown;
    
    const writer = Stream.writer({
      async write(chunk) {},
      async abort(reason) {
        abortReason = reason;
      }
    });
    
    await writer.write('some data');
    await writer.abort(new Error('Cancelled'));
    
    console.log('\nabort() reason:', (abortReason as Error)?.message);
  }

  // ============================================================================
  // pipeTo() - Pipe stream to a writer
  // ============================================================================
  section('pipeTo() - Piping to writers');

  // Basic pipeTo
  {
    const collected: Uint8Array[] = [];
    
    const stream = Stream.from('pipe this data');
    const writer = Stream.writer({
      async write(chunk) {
        collected.push(chunk);
      }
    });
    
    const bytesPiped = await stream.pipeTo(writer);
    
    console.log('Bytes piped:', bytesPiped);
    console.log('Chunks received:', collected.length);
  }

  // pipeTo with limit option
  {
    const stream = Stream.from('hello world'); // 11 bytes
    let received = '';
    
    const writer = Stream.writer({
      async write(chunk) {
        received += new TextDecoder().decode(chunk);
      }
    });
    
    const bytesPiped = await stream.pipeTo(writer, { limit: 5 });
    
    console.log('\nWith limit:5');
    console.log('  Bytes piped:', bytesPiped);
    console.log('  Received:', received);
  }

  // pipeTo with preventClose option
  {
    let writerClosed = false;
    
    const stream = Stream.from('data');
    const writer = Stream.writer({
      async write(chunk) {},
      async close() { writerClosed = true; }
    });
    
    await stream.pipeTo(writer, { preventClose: true });
    
    console.log('\nWith preventClose:true');
    console.log('  Writer closed:', writerClosed);
    
    // Can still write more
    await writer.write(' more data');
    await writer.close();
    console.log('  After manual close:', writerClosed);
  }

  // pipeTo with signal option (cancellation)
  {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    const stream = Stream.pull(async function* () {
      yield 'chunk1';
      await new Promise(r => setTimeout(r, 100));
      yield 'chunk2';
    });
    
    const writer = Stream.writer({
      async write(chunk) {}
    });
    
    try {
      await stream.pipeTo(writer, { signal: controller.signal });
    } catch (e) {
      console.log('\npipeTo cancelled:', (e as Error).name);
    }
  }

  // pipeTo error propagation
  {
    console.log('\n--- Error propagation ---');
    
    // Source error propagates to destination
    const errorStream = Stream.pull(async function* () {
      yield 'before error';
      throw new Error('Source error!');
    });
    
    let destAborted = false;
    const writer1 = Stream.writer({
      async write(chunk) {},
      async abort(reason) { 
        destAborted = true;
        console.log('  Dest aborted with:', (reason as Error)?.message);
      }
    });
    
    try {
      await errorStream.pipeTo(writer1);
    } catch (e) {
      console.log('  pipeTo rejected:', (e as Error).message);
    }
    
    // Destination error propagates back
    const stream2 = Stream.from('test data');
    const writer2 = Stream.writer({
      async write(chunk) {
        throw new Error('Dest error!');
      }
    });
    
    try {
      await stream2.pipeTo(writer2);
    } catch (e) {
      console.log('  Dest error propagated:', (e as Error).message);
    }
  }

  // preventAbort and preventCancel options
  {
    console.log('\n--- preventAbort / preventCancel ---');
    
    // preventAbort: don't abort dest on source error
    let destAborted = false;
    const errStream = Stream.pull(async function* () {
      yield 'data';
      throw new Error('source err');
    });
    const writer = Stream.writer({
      async write(chunk) {},
      async abort() { destAborted = true; }
    });
    
    try {
      await errStream.pipeTo(writer, { preventAbort: true });
    } catch (e) {}
    
    console.log('  With preventAbort, dest aborted:', destAborted);
  }

  // ============================================================================
  // Stream.pipeline() - Build complete pipelines
  // ============================================================================
  section('Stream.pipeline() - Complete pipelines');

  // Basic pipeline: source -> transforms -> destination
  {
    const collected: string[] = [];
    
    const source = Stream.from('hello world');
    const dest = Stream.writer({
      async write(chunk) {
        collected.push(new TextDecoder().decode(chunk));
      }
    });
    
    const bytes = await Stream.pipeline(
      source,
      // Transform: uppercase
      (chunk) => chunk === null ? null : new TextDecoder().decode(chunk).toUpperCase(),
      // Transform: add brackets
      (chunk) => chunk === null ? null : `[${new TextDecoder().decode(chunk)}]`,
      // Destination
      dest
    );
    
    console.log('Pipeline result:', collected.join(''));
    console.log('Total bytes:', bytes);
  }

  // Pipeline with multiple transforms
  {
    const source = Stream.from('transform chain');
    const transforms = [
      (c: Uint8Array | null) => c === null ? null : new TextDecoder().decode(c).toUpperCase(),
      (c: Uint8Array | null) => c === null ? null : new TextDecoder().decode(c).split('').reverse().join(''),
      (c: Uint8Array | null) => c === null ? null : `<<${new TextDecoder().decode(c)}>>`,
    ];
    
    let result = '';
    const dest = Stream.writer({
      async write(chunk) { result += new TextDecoder().decode(chunk); }
    });
    
    await Stream.pipeline(source, ...transforms, dest);
    console.log('\nMulti-transform pipeline:', result);
  }

  // Pipeline with signal option
  {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    
    const source = Stream.pull(async function* () {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 20));
        yield `chunk${i}`;
      }
    });
    
    const dest = Stream.writer({ async write() {} });
    
    try {
      await Stream.pipeline(
        source,
        (c) => c,
        dest,
        { signal: controller.signal }
      );
    } catch (e) {
      console.log('\nPipeline cancelled:', (e as Error).name);
    }
  }

  // Pipeline with limit option
  {
    const source = Stream.from('limit this long string'); // 22 bytes
    
    let received = '';
    const dest = Stream.writer({
      async write(chunk) { received += new TextDecoder().decode(chunk); }
    });
    
    const bytes = await Stream.pipeline(
      source,
      dest,
      { limit: 10 }
    );
    
    console.log('\nPipeline with limit:10');
    console.log('  Received:', received);
    console.log('  Bytes:', bytes);
  }

  // ============================================================================
  // Practical pipeline examples
  // ============================================================================
  section('Practical examples');

  // File processing simulation
  {
    console.log('\n--- File processing pipeline ---');
    
    // Simulate reading a file
    const fileContents = `name,age,city
Alice,30,NYC
Bob,25,LA
Charlie,35,Chicago`;
    
    const lines: string[] = [];
    let buffer = '';
    
    // CSV line parser transform
    const lineParser = function* (chunk: Uint8Array | null) {
      if (chunk === null) {
        if (buffer.trim()) yield buffer + '\n';
        return;
      }
      buffer += new TextDecoder().decode(chunk);
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        yield line + '\n';
      }
    };
    
    // Skip header transform
    let headerSkipped = false;
    const skipHeader = (chunk: Uint8Array | null) => {
      if (chunk === null) return null;
      if (!headerSkipped) {
        headerSkipped = true;
        return null;
      }
      return chunk;
    };
    
    // Collect results
    const dest = Stream.writer({
      async write(chunk) {
        const line = new TextDecoder().decode(chunk).trim();
        if (line) lines.push(line);
      }
    });
    
    await Stream.pipeline(
      Stream.from(fileContents),
      lineParser,
      skipHeader,
      dest
    );
    
    console.log('  Parsed CSV lines (without header):');
    lines.forEach(l => console.log('    ' + l));
  }

  // Streaming JSON array
  {
    console.log('\n--- Streaming JSON objects ---');
    
    const objects = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Charlie' }
    ];
    
    // Source: emit JSON objects as strings
    const source = Stream.pull(function* () {
      for (const obj of objects) {
        yield JSON.stringify(obj) + '\n';
      }
    });
    
    // Transform: parse and modify
    const transform = (chunk: Uint8Array | null) => {
      if (chunk === null) return null;
      const text = new TextDecoder().decode(chunk).trim();
      if (!text) return null;
      const obj = JSON.parse(text);
      obj.processed = true;
      return JSON.stringify(obj) + '\n';
    };
    
    // Destination: collect
    const results: string[] = [];
    const dest = Stream.writer({
      async write(chunk) {
        results.push(new TextDecoder().decode(chunk).trim());
      }
    });
    
    await Stream.pipeline(source, transform, dest);
    
    console.log('  Processed objects:');
    results.forEach(r => console.log('    ' + r));
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
