/**
 * Basic Stream Creation Examples
 * 
 * This file demonstrates the various ways to create streams using the new Streams API.
 */

import { Stream } from '../src/stream.js';

// Helper to print section headers
function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // Stream.from() - Create streams from existing data
  // ============================================================================
  section('Stream.from() - Creating streams from data');

  // From a string (UTF-8 encoded by default)
  {
    const stream = Stream.from('Hello, World!');
    const text = await stream.text();
    console.log('From string:', text);
  }

  // From a Uint8Array
  {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const stream = Stream.from(bytes);
    const text = await stream.text();
    console.log('From Uint8Array:', text);
  }

  // From an ArrayBuffer
  {
    const buffer = new TextEncoder().encode('From ArrayBuffer').buffer;
    const stream = Stream.from(buffer);
    const text = await stream.text();
    console.log('From ArrayBuffer:', text);
  }

  // From an array of chunks
  {
    const stream = Stream.from(['chunk1', ' ', 'chunk2', ' ', 'chunk3']);
    const text = await stream.text();
    console.log('From array of chunks:', text);
  }

  // Passing a Stream to Stream.from() returns the same stream
  {
    const original = Stream.from('test');
    const same = Stream.from(original);
    console.log('Same stream returned:', original === same);
  }

  // ============================================================================
  // Stream.empty() - Create an already-closed empty stream
  // ============================================================================
  section('Stream.empty() - Empty streams');

  {
    const empty = Stream.empty();
    const bytes = await empty.bytes();
    console.log('Empty stream bytes length:', bytes.length);

    // Iteration yields nothing
    const empty2 = Stream.empty();
    let count = 0;
    for await (const _ of empty2) {
      count++;
    }
    console.log('Empty stream iteration count:', count);
  }

  // ============================================================================
  // Stream.never() - Create streams that never produce data or are errored
  // ============================================================================
  section('Stream.never() - Never-producing and errored streams');

  // Without reason: creates a stream that never produces data
  {
    const never = Stream.never();
    console.log('Stream.never() created (would hang if consumed)');
    // Don't consume - it would hang forever!
    await never.cancel(); // Clean up
  }

  // With reason: creates an already-errored stream
  {
    const errored = Stream.never(new Error('Something went wrong'));
    try {
      await errored.bytes();
    } catch (e) {
      console.log('Errored stream threw:', (e as Error).message);
    }
  }

  // With string reason: automatically wrapped in Error
  {
    const errored = Stream.never('Custom error message');
    try {
      await errored.bytes();
    } catch (e) {
      console.log('String reason wrapped:', (e as Error).message);
    }
  }

  // ============================================================================
  // Stream.pull() - Create streams from generators (pull-based)
  // ============================================================================
  section('Stream.pull() - Generator-based streams');

  // Synchronous generator
  {
    const stream = Stream.pull(function* () {
      yield 'line 1\n';
      yield 'line 2\n';
      yield 'line 3\n';
    });
    const text = await stream.text();
    console.log('Sync generator output:', text.trim());
  }

  // Async generator - great for I/O operations
  {
    const stream = Stream.pull(async function* () {
      for (let i = 1; i <= 3; i++) {
        // Simulate async operation
        await new Promise(resolve => setTimeout(resolve, 10));
        yield `async chunk ${i}\n`;
      }
    });
    const text = await stream.text();
    console.log('Async generator output:', text.trim());
  }

  // Yielding different types
  {
    const stream = Stream.pull(function* () {
      yield 'string chunk';           // Strings are UTF-8 encoded
      yield new Uint8Array([32]);     // Uint8Array passed through
      yield new ArrayBuffer(0);       // ArrayBuffer wrapped in Uint8Array
    });
    const text = await stream.text();
    console.log('Mixed types:', text);
  }

  // Yielding nested streams and generators (consumed inline)
  {
    const innerStream = Stream.from(' inner stream ');
    
    const stream = Stream.pull(function* () {
      yield 'start';
      yield innerStream;  // Stream consumed inline
      yield (function* () {  // Generator consumed inline
        yield 'nested';
        yield ' generator';
      })();
      yield ' end';
    });
    const text = await stream.text();
    console.log('Nested streams/generators:', text);
  }

  // Natural backpressure - generator pauses until consumer reads
  {
    let generatorProgress = 0;
    
    const stream = Stream.pull(async function* () {
      for (let i = 0; i < 5; i++) {
        generatorProgress = i;
        yield `chunk${i}`;
      }
    });

    // Read just one chunk
    const { value } = await stream.read();
    console.log('Read one chunk, generator at:', generatorProgress);
    await stream.cancel(); // Clean up
  }

  // ============================================================================
  // Stream.push() - Create streams with a writer (push-based)
  // ============================================================================
  section('Stream.push() - Push-based streams');

  // Basic push stream
  {
    const [stream, writer] = Stream.push();
    
    // Write data asynchronously
    (async () => {
      await writer.write('Hello ');
      await writer.write('from ');
      await writer.write('push!');
      await writer.close();
    })();

    const text = await stream.text();
    console.log('Push stream output:', text);
  }

  // Destructuring as array or object
  {
    // Array destructuring
    const [stream1, writer1] = Stream.push();
    await writer1.close();
    
    // Object destructuring
    const { stream: stream2, writer: writer2 } = Stream.push();
    await writer2.close();
    
    console.log('Both destructuring styles work');
  }

  // Push stream with buffer configuration
  {
    const [stream, writer] = Stream.push({
      buffer: {
        max: 100,      // Soft limit
        hardMax: 200,  // Hard limit (errors if exceeded)
      }
    });
    
    console.log('Initial desiredSize:', writer.desiredSize);
    await writer.write('12345'); // 5 bytes
    console.log('After write desiredSize:', writer.desiredSize);
    await writer.close();
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
