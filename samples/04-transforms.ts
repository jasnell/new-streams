/**
 * Stream Transforms
 *
 * This file demonstrates how to create and use transforms with Stream.pull().
 */

import { Stream, type Transform, type TransformObject } from '../src/index.js';
import { section, uppercaseTransform } from './util.js';

// Shared encoder/decoder instances for efficiency
const enc = new TextEncoder();
const dec = new TextDecoder();

async function main() {
  // ============================================================================
  // Stateless transforms - simple function transforms
  // ============================================================================
  section('Stateless transforms');

  // Basic transform - uppercase text
  {
    const output = Stream.pull(
      Stream.from(['hello ', 'world']),
      uppercaseTransform()
    );

    const result = await Stream.text(output);
    console.log('Uppercase transform:', result);
  }

  // Transform function receives null on flush
  {
    let flushCalled = false;

    const withFlush: Transform = (chunks) => {
      if (chunks === null) {
        flushCalled = true;
        return [enc.encode('FLUSHED')];
      }
      return chunks;
    };

    const output = Stream.pull(Stream.from('data'), withFlush);
    const result = await Stream.text(output);

    console.log('Flush called:', flushCalled);
    console.log('Result with flush:', result);
  }

  // Return null/empty to filter chunks
  {
    const filter: Transform = (chunks) => {
      if (chunks === null) return null;
      return chunks.filter(chunk => {
        const text = dec.decode(chunk);
        return !text.includes('skip');
      });
    };

    const output = Stream.pull(
      Stream.from(['keep1 ', 'skip this ', 'keep2']),
      filter
    );

    console.log('Filtered result:', await Stream.text(output));
  }

  // ============================================================================
  // Generator transforms - 1:N mapping
  // ============================================================================
  section('Generator transforms - 1:N mapping');

  // Sync generator - split into lines
  {
    const splitLines: Transform = function* (chunks) {
      if (chunks === null) return;
      for (const chunk of chunks) {
        const text = dec.decode(chunk);
        for (const line of text.split('\n')) {
          if (line) {
            yield enc.encode(line + '\n');
          }
        }
      }
    };

    const output = Stream.pull(
      Stream.from('line1\nline2\nline3'),
      splitLines
    );

    console.log('Split into lines:');
    for await (const batch of output) {
      for (const chunk of batch) {
        console.log('  Line:', dec.decode(chunk).trim());
      }
    }
  }

  // Expand each byte to multiple chunks
  {
    const expand: Transform = function* (chunks) {
      if (chunks === null) return;
      for (const chunk of chunks) {
        for (const byte of chunk) {
          yield enc.encode(`[${byte}]`);
        }
      }
    };

    const output = Stream.pull(
      Stream.from('AB'),  // Bytes 65, 66
      expand
    );

    console.log('\nExpanded bytes:', await Stream.text(output));
  }

  // ============================================================================
  // Stateful transforms - maintain state across chunks
  // ============================================================================
  section('Stateful transforms');

  // Line buffer - accumulates incomplete lines
  {
    const lineBuffer: TransformObject = {

      transform: async function* (source) {
        let buffer = '';

        for await (const chunks of source) {
          if (chunks === null) {
            // Flush - emit remaining buffer
            if (buffer) {
              yield enc.encode(buffer);
            }
            continue;
          }

          for (const chunk of chunks) {
            buffer += dec.decode(chunk);
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';  // Keep incomplete line

            for (const line of lines) {
              yield enc.encode(line + '\n');
            }
          }
        }
      }
    };

    const output = Stream.pull(
      Stream.from(['hel', 'lo\nwor', 'ld']),
      lineBuffer
    );

    console.log('Buffered lines:');
    for await (const batch of output) {
      for (const chunk of batch) {
        console.log('  Chunk:', JSON.stringify(dec.decode(chunk)));
      }
    }
  }

  // Counter transform - tracks bytes processed
  {
    let totalBytes = 0;

    const counter: TransformObject = {
      transform: async function* (source) {
        for await (const chunks of source) {
          if (chunks === null) {
            yield enc.encode(`\n[Total: ${totalBytes} bytes]`);
            continue;
          }

          for (const chunk of chunks) {
            totalBytes += chunk.byteLength;
            yield chunk;
          }
        }
      }
    };

    const output = Stream.pull(
      Stream.from(['Hello', ' ', 'World']),
      counter
    );

    console.log('\nWith byte count:', await Stream.text(output));
  }

  // ============================================================================
  // Chaining transforms
  // ============================================================================
  section('Chaining transforms');

  {
    const addPrefix: Transform = (chunks) => {
      if (chunks === null) return null;
      return chunks.map(chunk => {
        return enc.encode(`[${dec.decode(chunk)}]`);
      });
    };

    // Chain: addPrefix -> uppercase
    const output = Stream.pull(
      Stream.from(['hello', ' ', 'world']),
      addPrefix,
      uppercaseTransform()
    );

    console.log('Chained transforms:', await Stream.text(output));
  }

  // ============================================================================
  // Transform with signal-based cancellation
  // ============================================================================
  section('Transform with signal-based cancellation');

  {
    let signalAborted = false;

    const withSignal: TransformObject = {
      async *transform(source, { signal }) {
        const onAbort = () => {
          signalAborted = true;
          console.log('Transform signal aborted:', (signal.reason as Error)?.message || 'no reason');
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          for await (const chunks of source) {
            if (chunks) yield chunks;
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      },
    };

    const controller = new AbortController();
    const output = Stream.pull(
      Stream.from(['chunk1', 'chunk2', 'chunk3']),
      withSignal,
      { signal: controller.signal }
    );

    // Start consuming then abort
    const iter = output[Symbol.asyncIterator]();
    await iter.next();
    controller.abort(new Error('User cancelled'));

    // Try to read more (should handle abort gracefully)
    try {
      await iter.next();
    } catch (e) {
      console.log('Iteration aborted');
    }

    console.log('Signal aborted:', signalAborted);
  }

  // ============================================================================
  // Sync transforms with pullSync
  // ============================================================================
  section('Sync transforms');

  {
    const output = Stream.pullSync(
      Stream.fromSync(['hello', ' ', 'world']),
      uppercaseTransform()
    );

    const result = Stream.textSync(output);
    console.log('Sync transform result:', result);
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
