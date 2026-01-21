/**
 * Explicit Resource Management
 * 
 * This file demonstrates using `await using` for automatic cleanup of streams and writers.
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // Symbol.asyncDispose on streams
  // ============================================================================
  section('Symbol.asyncDispose on streams');

  // Streams have Symbol.asyncDispose which calls cancel()
  {
    const stream = Stream.from('test');
    
    console.log('Has Symbol.asyncDispose:', typeof stream[Symbol.asyncDispose] === 'function');
    
    // Manually calling it
    await stream[Symbol.asyncDispose]();
    
    const { done } = await stream.read();
    console.log('After dispose, done:', done);
  }

  // ============================================================================
  // Symbol.asyncDispose on writers
  // ============================================================================
  section('Symbol.asyncDispose on writers');

  // Writers have Symbol.asyncDispose which calls close()
  {
    const [stream, writer] = Stream.push();
    
    console.log('Has Symbol.asyncDispose:', typeof writer[Symbol.asyncDispose] === 'function');
    
    await writer.write('data before dispose');
    await writer[Symbol.asyncDispose]();
    
    // Stream is now closed
    const text = await stream.text();
    console.log('After dispose:', text);
  }

  // ============================================================================
  // await using - Automatic stream cleanup
  // ============================================================================
  section('await using - Automatic stream cleanup');

  // Stream is automatically cancelled when leaving the block
  {
    let streamCancelled = false;
    
    const testStream = Stream.pull(async function* () {
      try {
        yield 'chunk1';
        yield 'chunk2';
        yield 'chunk3';
      } finally {
        streamCancelled = true;
        console.log('  Generator cleanup ran!');
      }
    });
    
    console.log('Entering block with await using...');
    {
      await using stream = testStream;
      
      // Read just one chunk
      const { value } = await stream.read();
      console.log('  Read:', new TextDecoder().decode(value!));
      
      // Exit block without consuming entire stream
      console.log('  Leaving block early...');
    }
    
    console.log('After block - stream cancelled:', streamCancelled);
  }

  // ============================================================================
  // await using - Automatic writer cleanup
  // ============================================================================
  section('await using - Automatic writer cleanup');

  // Writer is automatically closed when leaving the block
  {
    const [stream, testWriter] = Stream.push();
    
    console.log('Entering block with await using...');
    {
      await using writer = testWriter;
      
      await writer.write('data from ');
      await writer.write('using block');
      
      console.log('  Leaving block (writer will be closed)...');
    }
    
    // Stream should be closed and readable
    const text = await stream.text();
    console.log('After block - stream content:', text);
  }

  // ============================================================================
  // await using - Cleanup on error
  // ============================================================================
  section('await using - Cleanup on error');

  // Stream is still disposed even if an error occurs
  {
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
      throw new Error('Something went wrong!');
      
    } catch (e) {
      console.log('Caught error:', (e as Error).message);
    }
    
    console.log('Stream was still disposed:', disposed);
  }

  // Writer is still closed even if an error occurs
  {
    const [stream, testWriter] = Stream.push();
    let errorThrown = false;
    
    try {
      await using writer = testWriter;
      
      await writer.write('some data');
      errorThrown = true;
      throw new Error('Oops!');
      
    } catch (e) {
      console.log('\nCaught error:', (e as Error).message);
    }
    
    console.log('Error was thrown:', errorThrown);
    
    // Writer was closed, so stream should be readable
    const text = await stream.text();
    console.log('Stream content:', text);
  }

  // ============================================================================
  // await using - Multiple resources
  // ============================================================================
  section('await using - Multiple resources');

  {
    let stream1Disposed = false;
    let stream2Disposed = false;
    
    const makeStream = (name: string, setDisposed: () => void) => {
      return Stream.pull(async function* () {
        try {
          yield `${name} data`;
        } finally {
          setDisposed();
          console.log(`  ${name} disposed`);
        }
      });
    };
    
    console.log('Entering block with two streams...');
    {
      await using s1 = makeStream('Stream1', () => stream1Disposed = true);
      await using s2 = makeStream('Stream2', () => stream2Disposed = true);
      
      console.log('  Read from s1:', await s1.text());
      console.log('  Read from s2:', await s2.text());
      
      console.log('  Leaving block...');
    }
    
    console.log('Both disposed:', stream1Disposed && stream2Disposed);
    console.log('(Note: disposed in reverse order - LIFO)');
  }

  // ============================================================================
  // Practical examples
  // ============================================================================
  section('Practical examples');

  // File-like processing with guaranteed cleanup
  {
    console.log('\n--- File-like processing ---');
    
    // Simulate a file stream that needs cleanup
    const openFile = (name: string) => {
      console.log(`  Opening "${name}"...`);
      
      return Stream.pull(async function* () {
        try {
          yield 'line 1\n';
          yield 'line 2\n';
          yield 'line 3\n';
        } finally {
          console.log(`  Closing "${name}"...`);
        }
      });
    };
    
    // Process first two lines only
    {
      await using file = openFile('data.txt');
      
      let lineCount = 0;
      for await (const chunk of file) {
        const line = new TextDecoder().decode(chunk).trim();
        console.log(`  Processing: ${line}`);
        
        lineCount++;
        if (lineCount >= 2) {
          console.log('  Stopping early...');
          break;
        }
      }
    }
    // File is automatically "closed" here
  }

  // Request/response with timeout and cleanup
  {
    console.log('\n--- Request with timeout and cleanup ---');
    
    const makeRequest = () => {
      return Stream.pull(async function* () {
        try {
          // Simulate slow response
          for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 30));
            yield `chunk${i}`;
          }
        } finally {
          console.log('  Request cancelled/completed');
        }
      });
    };
    
    // With timeout
    {
      await using response = makeRequest();
      
      const controller = new AbortController();
      setTimeout(() => {
        console.log('  Timeout triggered!');
        controller.abort();
      }, 80);
      
      try {
        const data = await response.bytes({ signal: controller.signal });
        console.log('  Received:', new TextDecoder().decode(data));
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          console.log('  Request timed out');
        }
      }
    }
    // Response stream is cleaned up here
  }

  // Pipeline with cleanup
  {
    console.log('\n--- Pipeline with cleanup ---');
    
    const createSource = () => Stream.pull(async function* () {
      try {
        for (let i = 0; i < 5; i++) {
          yield `item${i}\n`;
        }
      } finally {
        console.log('  Source cleaned up');
      }
    });
    
    {
      await using source = createSource();
      
      // Process with transformation
      const processed = source.pipeThrough((chunk) => {
        if (chunk === null) return null;
        return new TextDecoder().decode(chunk).toUpperCase();
      });
      
      // Take only first 3 items worth
      const result = await processed.take(18).text(); // ~3 items
      console.log('  Processed:', result.trim());
    }
    // Source is cleaned up even though we didn't consume everything
  }

  // ============================================================================
  // Idempotent disposal
  // ============================================================================
  section('Idempotent disposal');

  {
    const stream = Stream.from('test');
    
    // Multiple dispose calls are safe
    await stream[Symbol.asyncDispose]();
    await stream[Symbol.asyncDispose]();
    await stream[Symbol.asyncDispose]();
    
    console.log('Multiple dispose calls: OK (no error)');
  }

  {
    const [, writer] = Stream.push();
    
    await writer[Symbol.asyncDispose]();
    await writer[Symbol.asyncDispose]();
    await writer[Symbol.asyncDispose]();
    
    console.log('Multiple writer dispose calls: OK (no error)');
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
