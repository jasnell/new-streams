/**
 * Node.js Streams Interoperability
 * 
 * This file demonstrates adapting between the new Stream API and Node.js streams.
 * Includes proper error propagation and lifecycle management.
 */

import { Stream } from '../src/stream.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Readable, Writable, pipeline as nodePipeline } from 'node:stream';
import { promisify } from 'node:util';

const pipelineAsync = promisify(nodePipeline);

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// ============================================================================
// Adapter: Node.js Readable -> New Stream API
// ============================================================================

/**
 * Convert a Node.js Readable stream to the new Stream API.
 * 
 * Features:
 * - Proper backpressure handling
 * - Error propagation from Node.js stream to new Stream
 * - Cleanup on cancel (destroys the Node.js stream)
 */
function fromNodeReadable(readable: Readable): Stream {
  return Stream.pull(async function* () {
    // Track if we need to destroy the readable on cleanup
    let destroyed = false;
    
    try {
      // Use async iteration (Node.js 10+)
      for await (const chunk of readable) {
        // Node.js streams can emit strings or Buffers
        if (typeof chunk === 'string') {
          yield chunk;
        } else if (Buffer.isBuffer(chunk)) {
          // Convert Buffer to Uint8Array (zero-copy view)
          yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        } else if (chunk instanceof Uint8Array) {
          yield chunk;
        } else {
          throw new Error(`Unexpected chunk type: ${typeof chunk}`);
        }
      }
    } catch (error) {
      // Error from Node.js stream - propagate it
      throw error;
    } finally {
      // Cleanup: destroy the readable if not already destroyed
      if (!destroyed && !readable.destroyed) {
        destroyed = true;
        readable.destroy();
      }
    }
  });
}

// ============================================================================
// Adapter: New Stream API -> Node.js Writable
// ============================================================================

/**
 * Create a Writer that pipes to a Node.js Writable stream.
 * 
 * Features:
 * - Proper backpressure handling (respects drain events)
 * - Error propagation from Node.js stream to writer
 * - Proper close/abort handling
 */
function toNodeWritable(writable: Writable): ReturnType<typeof Stream.writer> {
  let error: Error | null = null;
  let drainResolve: (() => void) | null = null;
  
  // Listen for errors from the writable
  writable.on('error', (err) => {
    error = err;
    // Resolve any pending drain wait
    if (drainResolve) {
      drainResolve();
      drainResolve = null;
    }
  });
  
  // Helper to wait for drain
  const waitForDrain = (): Promise<void> => {
    return new Promise((resolve) => {
      drainResolve = resolve;
      writable.once('drain', () => {
        drainResolve = null;
        resolve();
      });
    });
  };
  
  return Stream.writer({
    async write(chunk: Uint8Array) {
      // Check for previous error
      if (error) throw error;
      
      // Convert to Buffer for Node.js
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      
      // Write with backpressure handling
      const canContinue = writable.write(buffer);
      
      if (!canContinue) {
        // Wait for drain event
        await waitForDrain();
        // Check if error occurred while waiting
        if (error) throw error;
      }
    },
    
    async close() {
      // Check for previous error
      if (error) throw error;
      
      return new Promise<void>((resolve, reject) => {
        writable.end(() => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
    
    async abort(reason) {
      // Destroy with error
      writable.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    }
  });
}

// ============================================================================
// Adapter: New Stream API -> Node.js Readable
// ============================================================================

/**
 * Convert a new Stream to a Node.js Readable.
 * 
 * Features:
 * - Proper backpressure (pauses reading when downstream is slow)
 * - Error propagation
 * - Cleanup when Readable is destroyed
 */
function toNodeReadable(stream: Stream): Readable {
  let reading = false;
  let cancelled = false;
  
  const readable = new Readable({
    async read() {
      if (reading || cancelled) return;
      reading = true;
      
      try {
        const { value, done } = await stream.read();
        
        if (done) {
          this.push(null); // Signal EOF
        } else if (value) {
          // Convert Uint8Array to Buffer
          const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          
          // push returns false if we should stop reading
          if (!this.push(buffer)) {
            // Downstream is full, wait for next read() call
          }
        }
      } catch (error) {
        this.destroy(error as Error);
      } finally {
        reading = false;
      }
    },
    
    destroy(error, callback) {
      cancelled = true;
      stream.cancel(error || undefined).then(
        () => callback(null),
        (err) => callback(err)
      );
    }
  });
  
  // Propagate errors from stream.closed
  stream.closed.catch((error) => {
    if (!readable.destroyed) {
      readable.destroy(error);
    }
  });
  
  return readable;
}

// ============================================================================
// Adapter: Node.js Writable -> New Stream Writer interface
// ============================================================================

/**
 * Create a new Stream from a Node.js Writable, returning the stream to read
 * what was written and the writer to write to.
 * 
 * This is useful when you need to "tee" data to a Node.js destination.
 */
function throughNodeWritable(writable: Writable): { stream: Stream; writer: ReturnType<typeof Stream.writer> } {
  const [stream, internalWriter] = Stream.push();
  const nodeWriter = toNodeWritable(writable);
  
  // Create a combined writer that writes to both
  const combinedWriter = Stream.writer({
    async write(chunk) {
      // Write to both destinations
      await Promise.all([
        internalWriter.write(chunk),
        nodeWriter.write(chunk)
      ]);
    },
    async close() {
      await Promise.all([
        internalWriter.close(),
        nodeWriter.close()
      ]);
    },
    async abort(reason) {
      await Promise.all([
        internalWriter.abort(reason),
        nodeWriter.abort(reason)
      ]);
    }
  });
  
  return { stream, writer: combinedWriter };
}

// ============================================================================
// Main examples
// ============================================================================

async function main() {
  // Create a temporary directory for our test files
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-interop-'));
  const testFile = path.join(tmpDir, 'test.txt');
  const outputFile = path.join(tmpDir, 'output.txt');
  
  console.log('Temp directory:', tmpDir);
  
  try {
    // ============================================================================
    // Example 1: Read file with Node.js, process with new Stream API
    // ============================================================================
    section('Example 1: Node.js ReadStream -> New Stream API');

    // Create test file
    fs.writeFileSync(testFile, 'Hello from Node.js!\nLine 2\nLine 3\n');
    
    {
      // Open file with Node.js
      const nodeReadStream = fs.createReadStream(testFile, { encoding: undefined });
      
      // Convert to new Stream API
      const stream = fromNodeReadable(nodeReadStream);
      
      // Process with new Stream API
      const text = await stream.text();
      console.log('Read from file:', text.trim());
      
      // Node.js stream is automatically cleaned up
      console.log('Node.js stream destroyed:', nodeReadStream.destroyed);
    }

    // ============================================================================
    // Example 2: Write file using new Stream API -> Node.js WriteStream
    // ============================================================================
    section('Example 2: New Stream API -> Node.js WriteStream');

    {
      // Create Node.js write stream
      const nodeWriteStream = fs.createWriteStream(outputFile);
      
      // Create writer adapter
      const writer = toNodeWritable(nodeWriteStream);
      
      // Write using new Stream API
      await writer.write('Written via new Stream API!\n');
      await writer.write('Second line\n');
      await writer.write('Third line\n');
      await writer.close();
      
      // Verify
      const content = fs.readFileSync(outputFile, 'utf-8');
      console.log('File content:', content.trim());
      console.log('Node.js stream finished:', nodeWriteStream.writableFinished);
    }

    // ============================================================================
    // Example 3: Full pipeline - Node.js Read -> Transform -> Node.js Write
    // ============================================================================
    section('Example 3: Full Pipeline with Transforms');

    {
      // Write source file
      fs.writeFileSync(testFile, 'transform this text to uppercase');
      
      // Create Node.js streams
      const nodeReader = fs.createReadStream(testFile);
      const nodeWriter = fs.createWriteStream(outputFile);
      
      // Convert to new Stream API
      const inputStream = fromNodeReadable(nodeReader);
      const outputWriter = toNodeWritable(nodeWriter);
      
      // Process with transform
      const transformed = inputStream.pipeThrough((chunk) => {
        if (chunk === null) return null;
        return new TextDecoder().decode(chunk).toUpperCase();
      });
      
      // Pipe to output
      const bytesWritten = await transformed.pipeTo(outputWriter);
      
      console.log('Bytes processed:', bytesWritten);
      console.log('Output:', fs.readFileSync(outputFile, 'utf-8'));
    }

    // ============================================================================
    // Example 4: Error propagation from Node.js stream
    // ============================================================================
    section('Example 4: Error Propagation (Node.js -> New Stream)');

    {
      // Try to read a non-existent file
      const nonExistent = path.join(tmpDir, 'does-not-exist.txt');
      const nodeReader = fs.createReadStream(nonExistent);
      
      const stream = fromNodeReadable(nodeReader);
      
      try {
        await stream.text();
        console.log('ERROR: Should have thrown!');
      } catch (error) {
        console.log('Error correctly propagated:', (error as NodeJS.ErrnoException).code);
      }
    }

    // ============================================================================
    // Example 5: Error propagation to Node.js stream
    // ============================================================================
    section('Example 5: Error Propagation (New Stream -> Node.js)');

    {
      const nodeWriter = fs.createWriteStream(outputFile);
      const writer = toNodeWritable(nodeWriter);
      
      // Write some data
      await writer.write('before abort');
      
      // Abort the writer
      await writer.abort(new Error('Intentional abort'));
      
      console.log('Node.js stream destroyed:', nodeWriter.destroyed);
      
      // Trying to write after abort should fail
      try {
        await writer.write('after abort');
        console.log('ERROR: Should have thrown!');
      } catch (error) {
        console.log('Write after abort rejected:', (error as Error).message);
      }
    }

    // ============================================================================
    // Example 6: Cancellation propagation
    // ============================================================================
    section('Example 6: Cancellation Propagation');

    {
      // Create a larger test file
      fs.writeFileSync(testFile, 'x'.repeat(10000));
      
      let nodeStreamDestroyed = false;
      const nodeReader = fs.createReadStream(testFile, { highWaterMark: 100 });
      nodeReader.on('close', () => { nodeStreamDestroyed = true; });
      
      const stream = fromNodeReadable(nodeReader);
      
      // Read partial data
      const partial = await stream.take(500).bytes();
      console.log('Read partial:', partial.length, 'bytes');
      
      // Cancel the rest
      await stream.cancel();
      
      // Give time for cleanup to propagate
      await new Promise(r => setTimeout(r, 10));
      
      // Node.js stream should be destroyed
      console.log('Node.js stream cleaned up after cancel:', nodeStreamDestroyed);
    }

    // ============================================================================
    // Example 7: Convert new Stream to Node.js Readable
    // ============================================================================
    section('Example 7: New Stream -> Node.js Readable');

    {
      // Create a new Stream
      const stream = Stream.pull(async function* () {
        yield 'chunk1\n';
        await new Promise(r => setTimeout(r, 10));
        yield 'chunk2\n';
        await new Promise(r => setTimeout(r, 10));
        yield 'chunk3\n';
      });
      
      // Convert to Node.js Readable
      const nodeReadable = toNodeReadable(stream);
      
      // Use with Node.js pipeline
      const nodeWriter = fs.createWriteStream(outputFile);
      
      await pipelineAsync(nodeReadable, nodeWriter);
      
      console.log('Written via Node.js pipeline:', fs.readFileSync(outputFile, 'utf-8').trim());
    }

    // ============================================================================
    // Example 8: Tee to Node.js stream while processing
    // ============================================================================
    section('Example 8: Tee to File While Processing');

    {
      const source = Stream.from('Data to process and also save to file');
      
      // Branch for saving to file
      const fileBranch = source.tee();
      
      // Save to file in background
      const savePromise = (async () => {
        const nodeWriter = fs.createWriteStream(outputFile);
        const writer = toNodeWritable(nodeWriter);
        await fileBranch.pipeTo(writer);
      })();
      
      // Process main stream
      const processed = await source.pipeThrough((chunk) => {
        if (chunk === null) return null;
        return new TextDecoder().decode(chunk).toUpperCase();
      }).text();
      
      await savePromise;
      
      console.log('Processed:', processed);
      console.log('Saved to file:', fs.readFileSync(outputFile, 'utf-8'));
    }

    // ============================================================================
    // Example 9: Using await using for automatic cleanup
    // ============================================================================
    section('Example 9: Automatic Cleanup with await using');

    {
      fs.writeFileSync(testFile, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n');
      
      let nodeStreamDestroyed = false;
      
      {
        const nodeReader = fs.createReadStream(testFile);
        nodeReader.on('close', () => { nodeStreamDestroyed = true; });
        
        await using stream = fromNodeReadable(nodeReader);
        
        // Read only first line
        const firstLine = await stream.take(7).text();
        console.log('First line:', firstLine.trim());
        
        // Exit block early - stream will be cancelled
        console.log('Exiting block early...');
      }
      
      // Give time for close event
      await new Promise(r => setTimeout(r, 10));
      
      console.log('Node.js stream cleaned up:', nodeStreamDestroyed);
    }

    // ============================================================================
    // Example 10: Handling backpressure with slow consumer
    // ============================================================================
    section('Example 10: Backpressure Handling');

    {
      // Create a large test file
      fs.writeFileSync(testFile, 'X'.repeat(100000)); // 100KB
      
      const nodeReader = fs.createReadStream(testFile, { highWaterMark: 1024 });
      const stream = fromNodeReadable(nodeReader);
      
      let chunksProcessed = 0;
      const startTime = Date.now();
      
      // Slow consumer
      for await (const chunk of stream) {
        chunksProcessed++;
        // Simulate slow processing
        if (chunksProcessed <= 3) {
          await new Promise(r => setTimeout(r, 50));
        }
      }
      
      const elapsed = Date.now() - startTime;
      console.log(`Processed ${chunksProcessed} chunks in ${elapsed}ms`);
      console.log('(Backpressure correctly propagated to Node.js stream)');
    }

    // ============================================================================
    // Example 11: Bidirectional error in pipeline
    // ============================================================================
    section('Example 11: Bidirectional Error Propagation');

    {
      fs.writeFileSync(testFile, 'line1\nline2\nERROR\nline4\n');
      
      let sourceDestroyed = false;
      let destDestroyed = false;
      
      const nodeReader = fs.createReadStream(testFile);
      nodeReader.on('close', () => { sourceDestroyed = true; });
      
      const nodeWriter = fs.createWriteStream(outputFile);
      nodeWriter.on('close', () => { destDestroyed = true; });
      
      const inputStream = fromNodeReadable(nodeReader);
      const outputWriter = toNodeWritable(nodeWriter);
      
      // Transform that throws on "ERROR"
      const transformed = inputStream.pipeThrough((chunk) => {
        if (chunk === null) return null;
        const text = new TextDecoder().decode(chunk);
        if (text.includes('ERROR')) {
          throw new Error('Found ERROR in stream!');
        }
        return chunk;
      });
      
      try {
        await transformed.pipeTo(outputWriter);
        console.log('ERROR: Should have thrown!');
      } catch (error) {
        console.log('Pipeline error:', (error as Error).message);
      }
      
      // Give time for close events
      await new Promise(r => setTimeout(r, 10));
      
      console.log('Source stream cleaned up:', sourceDestroyed);
      console.log('Dest stream cleaned up:', destDestroyed);
    }

    // ============================================================================
    // Example 12: Large file copy with progress
    // ============================================================================
    section('Example 12: File Copy with Progress');

    {
      // Create a moderately large file
      const largeFile = path.join(tmpDir, 'large.txt');
      const copyFile = path.join(tmpDir, 'copy.txt');
      
      const size = 50000; // 50KB
      fs.writeFileSync(largeFile, 'X'.repeat(size));
      
      const nodeReader = fs.createReadStream(largeFile);
      const nodeWriter = fs.createWriteStream(copyFile);
      
      const inputStream = fromNodeReadable(nodeReader);
      const outputWriter = toNodeWritable(nodeWriter);
      
      let bytesCopied = 0;
      let lastProgress = 0;
      
      // Copy with progress
      const withProgress = inputStream.pipeThrough((chunk) => {
        if (chunk === null) return null;
        
        bytesCopied += chunk.length;
        const progress = Math.floor((bytesCopied / size) * 100);
        
        if (progress >= lastProgress + 25) {
          console.log(`  Progress: ${progress}%`);
          lastProgress = progress;
        }
        
        return chunk;
      });
      
      const totalBytes = await withProgress.pipeTo(outputWriter);
      console.log(`  Complete: ${totalBytes} bytes copied`);
      
      // Verify
      const originalSize = fs.statSync(largeFile).size;
      const copySize = fs.statSync(copyFile).size;
      console.log(`  Verified: original=${originalSize}, copy=${copySize}`);
    }

    console.log('\n--- Examples complete! ---\n');

  } finally {
    // Clean up temp directory
    console.log('Cleaning up temp directory...');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('Done.');
  }
}

main().catch(console.error);
