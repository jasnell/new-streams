/**
 * Slicing Operators
 * 
 * This file demonstrates take(), drop(), and limit() for slicing streams.
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // take(n) - Returns first n bytes as a NEW branch
  // ============================================================================
  section('take(n) - Take first n bytes (creates branch)');

  // Basic take
  {
    const stream = Stream.from('Hello, World!');
    const first5 = stream.take(5);
    
    const takenText = await first5.text();
    console.log('First 5 bytes:', takenText);
    
    // Original stream continues at byte 5
    const restText = await stream.text();
    console.log('Rest of stream:', restText);
  }

  // take(0) returns empty stream
  {
    const stream = Stream.from('Hello');
    const empty = stream.take(0);
    const text = await empty.text();
    console.log('take(0) result:', `"${text}"`, '(empty)');
  }

  // take(n) where n > stream length returns all available
  {
    const stream = Stream.from('Hi'); // 2 bytes
    const taken = stream.take(100);   // Ask for 100
    const text = await taken.text();
    console.log('take(100) on 2-byte stream:', text);
  }

  // Nested take() calls
  {
    const stream = Stream.from('ABCDEFGHIJ'); // 10 bytes
    const first8 = stream.take(8);  // ABCDEFGH
    const first3 = first8.take(3);  // ABC
    
    console.log('Nested take - first3:', await first3.text());
    console.log('Nested take - rest of first8:', await first8.text());
    console.log('Nested take - rest of original:', await stream.text());
  }

  // ============================================================================
  // drop(n) - Discard first n bytes
  // ============================================================================
  section('drop(n) - Skip first n bytes');

  // Basic drop
  {
    const stream = Stream.from('Hello, World!');
    const afterDrop = stream.drop(7); // Skip "Hello, "
    const text = await afterDrop.text();
    console.log('After drop(7):', text);
  }

  // drop(0) is a no-op
  {
    const stream = Stream.from('Hello');
    const same = stream.drop(0);
    console.log('drop(0) returns same stream:', stream === same);
  }

  // drop(n) where n >= stream length
  {
    const stream = Stream.from('Hi'); // 2 bytes
    const dropped = stream.drop(100); // Drop more than available
    const text = await dropped.text();
    console.log('drop(100) on 2-byte stream:', `"${text}"`, '(empty)');
  }

  // drop() returns the same stream (mutates position)
  {
    const stream = Stream.from('ABCDE');
    const after = stream.drop(2);
    console.log('drop() returns same stream:', stream === after);
    const text = await stream.text();
    console.log('Original stream after drop:', text);
  }

  // ============================================================================
  // limit(n) - Cap stream at n bytes (TERMINAL, not branching)
  // ============================================================================
  section('limit(n) - Cap stream at n bytes (terminal)');

  // Basic limit
  {
    const stream = Stream.from('Hello, World!');
    const limited = stream.limit(5);
    
    // limit() returns the SAME stream, not a branch
    console.log('limit() returns same stream:', stream === limited);
    
    const text = await limited.text();
    console.log('Limited to 5 bytes:', text);
  }

  // limit(0) returns empty stream
  {
    const stream = Stream.from('Hello');
    stream.limit(0);
    const text = await stream.text();
    console.log('limit(0) result:', `"${text}"`, '(empty)');
  }

  // limit() cancels source when limit is reached
  {
    let sourceCancelled = false;
    
    const stream = Stream.pull(async function* () {
      try {
        yield 'chunk1';
        yield 'chunk2';
        yield 'chunk3';
      } finally {
        sourceCancelled = true;
      }
    });
    
    stream.limit(6); // "chunk1" is 6 bytes
    await stream.bytes();
    
    console.log('Source cancelled after limit:', sourceCancelled);
  }

  // Multiple limit() calls - smallest limit wins
  {
    const stream = Stream.from('ABCDEFGHIJ');
    stream.limit(8);
    stream.limit(5); // Smaller, so this one wins
    stream.limit(10); // Larger, ignored
    
    const text = await stream.text();
    console.log('Multiple limits (8, 5, 10) - smallest wins:', text);
  }

  // ============================================================================
  // take() vs limit() - Key differences
  // ============================================================================
  section('take() vs limit() - Key differences');

  console.log(`
  take(n):
    - Creates a NEW branch stream
    - Original stream continues at byte n
    - Does NOT cancel the source
    - Use when you want to split a stream

  limit(n):
    - Returns the SAME stream (terminal operation)
    - Caps the stream at n bytes
    - CANCELS the source when limit is reached
    - Use when you want to cap total consumption
  `);

  // Example demonstrating the difference
  {
    // With take() - original continues
    const stream1 = Stream.from('ABCDEFGHIJ');
    const first3 = stream1.take(3);
    console.log('take(3):', await first3.text());
    console.log('Original after take:', await stream1.text());

    // With limit() - stream is capped
    const stream2 = Stream.from('ABCDEFGHIJ');
    stream2.limit(3);
    console.log('\nlimit(3):', await stream2.text());
    // No "rest" - the stream is capped
  }

  // ============================================================================
  // Combining slicing operators
  // ============================================================================
  section('Combining slicing operators');

  // Extract a range: bytes 5-10 of a stream
  {
    const stream = Stream.from('0123456789ABCDEF');
    const range = stream.drop(5).take(5);
    const text = await range.text();
    console.log('Bytes 5-10:', text);
  }

  // Process stream in windows
  {
    const stream = Stream.from('AABBCCDDEE');
    const chunks: string[] = [];
    
    while (true) {
      const window = stream.take(2);
      const text = await window.text();
      if (text.length === 0) break;
      chunks.push(text);
    }
    
    console.log('2-byte windows:', chunks);
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
