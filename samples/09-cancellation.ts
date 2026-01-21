/**
 * Cancellation and AbortSignal
 * 
 * This file demonstrates stream cancellation and AbortSignal integration.
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // stream.cancel() - Cancel a stream
  // ============================================================================
  section('stream.cancel() - Cancelling streams');

  // Basic cancellation
  {
    let generatorCompleted = false;
    
    const stream = Stream.pull(async function* () {
      try {
        for (let i = 0; i < 100; i++) {
          yield `chunk${i}`;
          await new Promise(r => setTimeout(r, 10));
        }
        generatorCompleted = true;
      } finally {
        console.log('Generator cleanup ran');
      }
    });
    
    // Read a bit
    await stream.take(10).bytes();
    
    // Cancel the rest
    const bytesRead = await stream.cancel();
    
    console.log('Bytes read before cancel:', bytesRead);
    console.log('Generator completed:', generatorCompleted);
  }

  // Subsequent reads after cancel return done=true
  {
    const stream = Stream.from('hello');
    await stream.cancel();
    
    const { value, done } = await stream.read();
    console.log('\nAfter cancel - done:', done, 'value:', value);
  }

  // cancel() is idempotent
  {
    const stream = Stream.from('test');
    await stream.cancel();
    await stream.cancel();
    await stream.cancel();
    console.log('Multiple cancel() calls: OK (idempotent)');
  }

  // cancel() with reason
  {
    const stream = Stream.from('test');
    await stream.cancel(new Error('User cancelled'));
    console.log('Cancel with reason: OK');
  }

  // ============================================================================
  // closed promise after cancel
  // ============================================================================
  section('stream.closed after cancel');

  {
    const stream = Stream.from('12345678'); // 8 bytes
    
    // Read some
    await stream.take(3).bytes();
    
    // Cancel
    await stream.cancel();
    
    // closed resolves with bytes read
    const totalBytes = await stream.closed;
    console.log('Bytes read before cancel:', totalBytes);
  }

  // ============================================================================
  // AbortSignal with read operations
  // ============================================================================
  section('AbortSignal with read operations');

  // read() with signal
  {
    const [stream] = Stream.push(); // Never-closing stream
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    console.log('Starting read with 50ms timeout...');
    const start = Date.now();
    
    try {
      await stream.read({ signal: controller.signal });
    } catch (e) {
      console.log(`read() aborted after ${Date.now() - start}ms:`, (e as Error).name);
    }
  }

  // bytes() with signal
  {
    const [stream] = Stream.push();
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    try {
      await stream.bytes({ signal: controller.signal });
    } catch (e) {
      console.log('bytes() aborted:', (e as Error).name);
    }
  }

  // text() with signal
  {
    const [stream] = Stream.push();
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    try {
      await stream.text('utf-8', { signal: controller.signal });
    } catch (e) {
      console.log('text() aborted:', (e as Error).name);
    }
  }

  // arrayBuffer() with signal
  {
    const [stream] = Stream.push();
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    try {
      await stream.arrayBuffer({ signal: controller.signal });
    } catch (e) {
      console.log('arrayBuffer() aborted:', (e as Error).name);
    }
  }

  // ============================================================================
  // AbortSignal with write operations
  // ============================================================================
  section('AbortSignal with write operations');

  // write() with signal (useful when buffer is blocking)
  {
    const [stream, writer] = Stream.push({
      buffer: { max: 5, onOverflow: 'block' }
    });
    
    await writer.write('AAAAA'); // Fill buffer
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    try {
      await writer.write('BBBBB', { signal: controller.signal });
    } catch (e) {
      console.log('Blocked write() aborted:', (e as Error).name);
    }
    
    await writer.abort();
  }

  // Already-aborted signal rejects immediately
  {
    const [stream, writer] = Stream.push();
    
    const controller = new AbortController();
    controller.abort(); // Abort before calling
    
    try {
      await writer.write('data', { signal: controller.signal });
    } catch (e) {
      console.log('Pre-aborted signal rejected:', (e as Error).name);
    }
    
    await writer.close();
  }

  // writev() with signal
  {
    const [stream, writer] = Stream.push({
      buffer: { max: 5, onOverflow: 'block' }
    });
    
    await writer.write('AAAAA'); // Fill buffer
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    try {
      await writer.writev(['B', 'C', 'D'], { signal: controller.signal });
    } catch (e) {
      console.log('writev() aborted:', (e as Error).name);
    }
    
    await writer.abort();
  }

  // flush() with signal
  {
    const [stream, writer] = Stream.push();
    
    const controller = new AbortController();
    controller.abort();
    
    try {
      await writer.flush({ signal: controller.signal });
    } catch (e) {
      console.log('flush() aborted:', (e as Error).name);
    }
    
    await writer.close();
  }

  // ============================================================================
  // AbortSignal with piping operations
  // ============================================================================
  section('AbortSignal with piping');

  // pipeTo() with signal
  {
    console.log('\n--- pipeTo() cancellation ---');
    
    const stream = Stream.pull(async function* () {
      for (let i = 0; i < 10; i++) {
        yield `chunk${i}`;
        await new Promise(r => setTimeout(r, 20));
      }
    });
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    const writer = Stream.writer({ async write() {} });
    
    try {
      await stream.pipeTo(writer, { signal: controller.signal });
    } catch (e) {
      console.log('pipeTo() aborted:', (e as Error).name);
    }
  }

  // pipeThrough() with signal
  {
    console.log('\n--- pipeThrough() cancellation ---');
    
    const stream = Stream.pull(async function* () {
      for (let i = 0; i < 10; i++) {
        yield `chunk${i}`;
        await new Promise(r => setTimeout(r, 20));
      }
    });
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    const transformed = stream.pipeThrough(
      (chunk) => chunk,
      { signal: controller.signal }
    );
    
    try {
      await transformed.bytes();
    } catch (e) {
      console.log('pipeThrough() aborted:', (e as Error).name);
    }
  }

  // Pipeline with signal
  {
    console.log('\n--- Pipeline cancellation ---');
    
    const source = Stream.pull(async function* () {
      for (let i = 0; i < 10; i++) {
        yield `chunk${i}`;
        await new Promise(r => setTimeout(r, 20));
      }
    });
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    const dest = Stream.writer({ async write() {} });
    
    try {
      await Stream.pipeline(
        source,
        (chunk) => chunk,
        dest,
        { signal: controller.signal }
      );
    } catch (e) {
      console.log('Pipeline aborted:', (e as Error).name);
    }
  }

  // ============================================================================
  // Timeout pattern
  // ============================================================================
  section('Timeout pattern');

  // Using AbortSignal.timeout()
  {
    const [stream] = Stream.push(); // Never closes
    
    try {
      // Node.js 16+ and modern browsers support AbortSignal.timeout()
      const signal = AbortSignal.timeout(100);
      await stream.bytes({ signal });
    } catch (e) {
      console.log('Timed out after 100ms:', (e as Error).name);
    }
  }

  // Manual timeout with AbortController
  {
    const [stream] = Stream.push();
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 100);
    
    try {
      await stream.bytes({ signal: controller.signal });
    } catch (e) {
      console.log('Manual timeout:', (e as Error).name);
    } finally {
      clearTimeout(timeoutId); // Clean up if completed early
    }
  }

  // ============================================================================
  // Error propagation with cancellation
  // ============================================================================
  section('Error propagation');

  // Consumer error propagates back to source (cancels it)
  {
    console.log('\n--- Consumer error cancels source ---');
    
    let sourceCancelled = false;
    
    const stream = Stream.pull(async function* () {
      try {
        for (let i = 0; i < 10; i++) {
          yield `chunk${i}`;
        }
      } finally {
        sourceCancelled = true;
      }
    });
    
    let count = 0;
    try {
      for await (const chunk of stream) {
        count++;
        if (count === 3) {
          throw new Error('Consumer error!');
        }
      }
    } catch (e) {
      console.log('Consumer threw:', (e as Error).message);
    }
    
    console.log('Source cancelled:', sourceCancelled);
  }

  // Source error cancels pipeline
  {
    console.log('\n--- Source error tears down pipeline ---');
    
    let destAborted = false;
    
    const source = Stream.pull(async function* () {
      yield 'chunk1';
      throw new Error('Source error!');
    });
    
    const dest = Stream.writer({
      async write() {},
      async abort(reason) {
        destAborted = true;
        console.log('Dest aborted:', (reason as Error)?.message);
      }
    });
    
    try {
      await source.pipeTo(dest);
    } catch (e) {
      console.log('Pipeline error:', (e as Error).message);
    }
    
    console.log('Dest was aborted:', destAborted);
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
