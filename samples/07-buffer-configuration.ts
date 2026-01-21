/**
 * Buffer Configuration
 * 
 * This file demonstrates buffer options including max, hardMax, and overflow policies.
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // Buffer basics - max and desiredSize
  // ============================================================================
  section('Buffer basics - max and desiredSize');

  {
    const [stream, writer] = Stream.push({
      buffer: { max: 100 }
    });
    
    console.log('Initial desiredSize:', writer.desiredSize);
    
    await writer.write('1234567890'); // 10 bytes
    console.log('After 10 bytes, desiredSize:', writer.desiredSize);
    
    await writer.write('1234567890'); // 10 more bytes
    console.log('After 20 bytes, desiredSize:', writer.desiredSize);
    
    // Read some data to free buffer space
    await stream.take(15).bytes();
    console.log('After reading 15, desiredSize:', writer.desiredSize);
    
    await writer.close();
  }

  // desiredSize becomes null when closed
  {
    const [stream, writer] = Stream.push({ buffer: { max: 100 } });
    console.log('\nBefore close, desiredSize:', writer.desiredSize);
    await writer.close();
    console.log('After close, desiredSize:', writer.desiredSize);
  }

  // ============================================================================
  // onOverflow: 'error' - Reject writes when buffer is full
  // ============================================================================
  section("onOverflow: 'error' - Reject when full");

  {
    const [stream, writer] = Stream.push({
      buffer: {
        max: 10,
        onOverflow: 'error'
      }
    });
    
    await writer.write('12345'); // 5 bytes - OK
    console.log('First write (5 bytes): OK');
    
    await writer.write('12345'); // 5 more - at max
    console.log('Second write (5 bytes): OK, now at max');
    
    try {
      await writer.write('X'); // Over max - ERROR
    } catch (e) {
      console.log('Third write rejected:', (e as Error).message);
    }
    
    await writer.abort(); // Clean up
  }

  // ============================================================================
  // onOverflow: 'drop-newest' - Discard data being written
  // ============================================================================
  section("onOverflow: 'drop-newest' - Discard new data");

  {
    const [stream, writer] = Stream.push({
      buffer: {
        max: 10,
        onOverflow: 'drop-newest'
      }
    });
    
    await writer.write('AAAAAAAAAA'); // 10 bytes - fills buffer
    console.log('Buffer filled with 10 As');
    
    await writer.write('BBBBBBBBBB'); // This will be dropped!
    console.log("Wrote 10 Bs (but they're dropped)");
    
    await writer.close();
    
    const result = await stream.text();
    console.log('Final content:', result);
    console.log('(Notice: no Bs - they were dropped)');
  }

  // ============================================================================
  // onOverflow: 'drop-oldest' - Discard oldest buffered data
  // ============================================================================
  section("onOverflow: 'drop-oldest' - Discard old data");

  {
    const [stream, writer] = Stream.push({
      buffer: {
        max: 10,
        onOverflow: 'drop-oldest'
      }
    });
    
    await writer.write('AAAAAAAAAA'); // 10 bytes
    console.log('Buffer filled with 10 As');
    
    await writer.write('BBBBB'); // 5 bytes - drops 5 oldest
    console.log('Wrote 5 Bs (oldest 5 As dropped)');
    
    await writer.close();
    
    const result = await stream.text();
    console.log('Final content:', result);
    console.log('(Notice: 5 As remain, followed by 5 Bs)');
  }

  // ============================================================================
  // onOverflow: 'block' - Block writes until space available
  // ============================================================================
  section("onOverflow: 'block' - Block until space");

  {
    const [stream, writer] = Stream.push({
      buffer: {
        max: 10,
        hardMax: 20, // Total pending can't exceed this
        onOverflow: 'block'
      }
    });
    
    console.log('Buffer max: 10, hardMax: 20');
    
    // Fill buffer
    await writer.write('AAAAAAAAAA'); // 10 bytes - immediate
    console.log('Wrote 10 As (buffer full)');
    
    // This will block until consumer reads
    const writePromise = writer.write('BBBBB');
    console.log('Started writing 5 Bs (will block)...');
    
    // Read in background to unblock
    setTimeout(async () => {
      console.log('Consumer reading...');
      await stream.take(5).bytes(); // Free up 5 bytes
    }, 50);
    
    await writePromise;
    console.log('Write completed after consumer read');
    
    await writer.close();
  }

  // Block with signal cancellation
  {
    console.log('\n--- Block with signal cancellation ---');
    
    const [stream, writer] = Stream.push({
      buffer: { max: 5, onOverflow: 'block' }
    });
    
    await writer.write('AAAAA'); // Fill buffer
    
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    try {
      await writer.write('BBBBB', { signal: controller.signal });
    } catch (e) {
      console.log('Blocked write cancelled:', (e as Error).name);
    }
    
    await writer.abort();
  }

  // hardMax enforcement in block mode
  {
    console.log('\n--- hardMax enforcement ---');
    
    const [stream, writer] = Stream.push({
      buffer: {
        max: 5,
        hardMax: 10,
        onOverflow: 'block'
      }
    });
    
    await writer.write('AAAAA'); // 5 bytes in buffer
    
    // This would make total pending = 5 (buffer) + 6 (new) = 11 > hardMax
    try {
      // Use a quick timeout to avoid hanging
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      await writer.write('BBBBBB', { signal: controller.signal }); // 6 bytes
    } catch (e) {
      console.log('Write rejected (would exceed hardMax):', (e as Error).name);
    }
    
    await writer.abort();
  }

  // Blocked writes resolve in FIFO order
  {
    console.log('\n--- FIFO order for blocked writes ---');
    
    const [stream, writer] = Stream.push({
      buffer: { max: 2, onOverflow: 'block' }
    });
    
    await writer.write('AA'); // Fill buffer
    
    const order: number[] = [];
    
    // Queue up blocked writes
    const p1 = writer.write('1').then(() => order.push(1));
    const p2 = writer.write('2').then(() => order.push(2));
    const p3 = writer.write('3').then(() => order.push(3));
    
    // Read to unblock
    setTimeout(async () => {
      for (let i = 0; i < 5; i++) {
        await stream.read({ max: 1 });
        await new Promise(r => setTimeout(r, 10));
      }
    }, 10);
    
    await Promise.all([p1, p2, p3]);
    await writer.close();
    
    console.log('Completion order:', order);
    console.log('(Should be 1, 2, 3 - FIFO)');
  }

  // ============================================================================
  // Buffer configuration in transforms
  // ============================================================================
  section('Buffer configuration in transforms');

  {
    const [output, writer] = Stream.transform(
      (chunk) => chunk,
      {
        buffer: {
          max: 20,
          onOverflow: 'drop-newest'
        }
      }
    );
    
    // Rapidly write lots of data
    for (let i = 0; i < 10; i++) {
      await writer.write('XXXX'); // 4 bytes each
    }
    await writer.close();
    
    const result = await output.bytes();
    console.log('Wrote 40 bytes with max:20, got:', result.length, 'bytes');
  }

  // ============================================================================
  // Practical examples
  // ============================================================================
  section('Practical examples');

  // Rate limiting with block policy
  {
    console.log('\n--- Rate limiting producer ---');
    
    const [stream, writer] = Stream.push({
      buffer: {
        max: 100,    // Normal buffer
        hardMax: 200, // Max pending
        onOverflow: 'block'
      }
    });
    
    // Fast producer
    const producerDone = (async () => {
      for (let i = 0; i < 5; i++) {
        await writer.write(`message${i} `);
        console.log(`  Produced message${i}`);
      }
      await writer.close();
    })();
    
    // Slow consumer
    await new Promise(r => setTimeout(r, 10));
    
    for await (const chunk of stream) {
      console.log('  Consumed:', new TextDecoder().decode(chunk).trim());
      await new Promise(r => setTimeout(r, 20)); // Slow processing
    }
    
    await producerDone;
  }

  // Lossy streaming with drop-oldest (like video frames)
  {
    console.log('\n--- Lossy streaming (like video) ---');
    
    const [stream, writer] = Stream.push({
      buffer: {
        max: 30, // Keep only ~3 frames
        onOverflow: 'drop-oldest'
      }
    });
    
    // Fast producer (frames)
    (async () => {
      for (let i = 1; i <= 10; i++) {
        await writer.write(`frame${i.toString().padStart(2, '0')}`); // 7 bytes each
        await new Promise(r => setTimeout(r, 5));
      }
      await writer.close();
    })();
    
    // Slow consumer
    await new Promise(r => setTimeout(r, 60)); // Miss some frames
    
    const result = await stream.text();
    console.log('  Received (most recent frames):', result);
    console.log('  (Earlier frames were dropped)');
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
