/**
 * Stream Consumption Methods
 * 
 * This file demonstrates the various ways to consume/read data from streams.
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // bytes() - Consume entire stream as Uint8Array
  // ============================================================================
  section('bytes() - Get all bytes');

  {
    const stream = Stream.from('Hello, bytes!');
    const bytes = await stream.bytes();
    console.log('Type:', bytes.constructor.name);
    console.log('Length:', bytes.length);
    console.log('First 5 bytes:', Array.from(bytes.slice(0, 5)));
  }

  // With signal for cancellation
  {
    const [stream, writer] = Stream.push();
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    // Start a slow write
    (async () => {
      await writer.write('chunk1');
      await new Promise(r => setTimeout(r, 100));
      await writer.write('chunk2');
      await writer.close();
    })();

    try {
      await stream.bytes({ signal: controller.signal });
    } catch (e) {
      console.log('bytes() cancelled:', (e as Error).name);
    }
  }

  // ============================================================================
  // arrayBuffer() - Consume entire stream as ArrayBuffer
  // ============================================================================
  section('arrayBuffer() - Get as ArrayBuffer');

  {
    const stream = Stream.from('Hello, ArrayBuffer!');
    const buffer = await stream.arrayBuffer();
    console.log('Type:', buffer.constructor.name);
    console.log('Byte length:', buffer.byteLength);
  }

  // ============================================================================
  // text() - Consume entire stream as decoded string
  // ============================================================================
  section('text() - Get as string');

  // Default UTF-8 decoding
  {
    const stream = Stream.from('Hello, text!');
    const text = await stream.text();
    console.log('Decoded text:', text);
  }

  // Explicit encoding
  {
    // Create UTF-16LE encoded data
    const utf16bytes = new Uint8Array([0x48, 0x00, 0x69, 0x00]); // "Hi" in UTF-16LE
    const stream = Stream.from(utf16bytes);
    const text = await stream.text('utf-16le');
    console.log('UTF-16LE decoded:', text);
  }

  // ============================================================================
  // read() - Low-level reading with options
  // ============================================================================
  section('read() - Low-level reading');

  // Basic read
  {
    const stream = Stream.from('Hello, World!');
    const result = await stream.read();
    console.log('Read result:');
    console.log('  value:', result.value ? new TextDecoder().decode(result.value) : null);
    console.log('  done:', result.done);
  }

  // Note: value can be non-null even when done=true (final chunk)
  {
    const stream = Stream.from('final');
    let result = await stream.read();
    console.log('\nFirst read - value:', !!result.value, 'done:', result.done);
    result = await stream.read();
    console.log('Second read - value:', !!result.value, 'done:', result.done);
  }

  // read() with max option - bounds allocation size
  {
    const stream = Stream.from('This is a longer string');
    const { value } = await stream.read({ max: 5 });
    console.log('\nWith max:5 got', value?.length, 'bytes:', 
      value ? new TextDecoder().decode(value) : '');
  }

  // read() with atLeast option - wait for minimum bytes
  {
    const [stream, writer] = Stream.push();
    
    // Write slowly
    (async () => {
      await writer.write('ab');
      await new Promise(r => setTimeout(r, 10));
      await writer.write('cde');
      await writer.close();
    })();

    // Wait for at least 4 bytes
    const { value } = await stream.read({ atLeast: 4 });
    console.log('With atLeast:4 got', value?.length, 'bytes:',
      value ? new TextDecoder().decode(value) : '');
  }

  // atLeast returns available if stream ends early
  {
    const stream = Stream.from('ab'); // Only 2 bytes
    const { value, done } = await stream.read({ atLeast: 10 });
    console.log('Stream ended early - got', value?.length, 'bytes, done:', done);
  }

  // read() with buffer option (BYOB - Bring Your Own Buffer)
  {
    const stream = Stream.from('BYOB test data here');
    const myBuffer = new Uint8Array(10);
    
    const { value, done } = await stream.read({ buffer: myBuffer });
    console.log('\nBYOB read:');
    console.log('  Read into provided buffer:', value?.length, 'bytes');
    console.log('  Content:', new TextDecoder().decode(value!));
    // Note: The original buffer is conceptually "detached" after use
  }

  // read() with signal for cancellation
  {
    const [stream] = Stream.push(); // Never-closing stream
    const controller = new AbortController();
    
    setTimeout(() => controller.abort(), 50);
    
    try {
      await stream.read({ signal: controller.signal });
    } catch (e) {
      console.log('\nread() cancelled:', (e as Error).name);
    }
  }

  // ============================================================================
  // Async iteration - for await...of
  // ============================================================================
  section('Async iteration - for await...of');

  // Basic iteration
  {
    const stream = Stream.from(['chunk1\n', 'chunk2\n', 'chunk3\n']);
    console.log('Iterating over chunks:');
    for await (const chunk of stream) {
      console.log('  Got:', new TextDecoder().decode(chunk).trim());
    }
  }

  // Breaking early allows further reads
  {
    const stream = Stream.from('Hello World');
    
    // Read first chunk via iteration
    for await (const chunk of stream) {
      console.log('\nFirst iteration got:', new TextDecoder().decode(chunk));
      break; // Exit early
    }
    
    // Can still read more
    const { value, done } = await stream.read();
    console.log('After break - more data:', !done);
  }

  // ============================================================================
  // stream.closed - Promise that resolves when stream closes
  // ============================================================================
  section('stream.closed - Completion promise');

  // Resolves with total bytes read
  {
    const stream = Stream.from('12345'); // 5 bytes
    
    // Consume the stream
    await stream.bytes();
    
    // closed resolves with byte count
    const totalBytes = await stream.closed;
    console.log('Total bytes read:', totalBytes);
  }

  // Rejects if stream errors
  {
    const stream = Stream.never(new Error('Stream error'));
    
    try {
      await stream.closed;
    } catch (e) {
      console.log('stream.closed rejected:', (e as Error).message);
    }
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
