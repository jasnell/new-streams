/**
 * Synchronous Pipeline Processing
 *
 * This file demonstrates Stream.pullSync() for synchronous, lazy stream processing.
 * pullSync() creates a sync generator that processes data on-demand without any async overhead.
 */

import { Stream, type SyncTransform } from '../src/index.js';
import { section, uppercaseTransform } from './util.js';

// Shared encoder/decoder instances for efficiency
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Helper to decode Uint8Array to string
const decode = (chunk: Uint8Array) => decoder.decode(chunk);

// Helper to collect all batches from a sync iterable
function collect(source: Iterable<Uint8Array[]>): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (const batch of source) {
    result.push(...batch);
  }
  return result;
}

// Helper to collect and concatenate as string
function collectText(source: Iterable<Uint8Array[]>): string {
  return collect(source).map(decode).join('');
}

function main() {
  // ============================================================================
  // Basic pullSync Usage
  // ============================================================================
  section('Basic pullSync Usage');

  // Simple pipeline with no transforms
  {
    const source = Stream.fromSync(['hello ', 'world']);
    const pipeline = Stream.pullSync(source);

    console.log('No transforms:', collectText(pipeline));
  }

  // Single transform - uppercase
  {
    const source = Stream.fromSync(['hello world']);
    const pipeline = Stream.pullSync(source, uppercaseTransform());

    console.log('Uppercase:', collectText(pipeline));
  }

  // Multiple transforms chained
  {
    const addExclamation: SyncTransform = (chunks) => {
      if (chunks === null) return null;
      return chunks.map((chunk) => encoder.encode(decode(chunk) + '!'));
    };

    const wrapBrackets: SyncTransform = (chunks) => {
      if (chunks === null) return null;
      return chunks.map((chunk) => encoder.encode(`[${decode(chunk)}]`));
    };

    const source = Stream.fromSync(['hello']);
    const pipeline = Stream.pullSync(source, uppercaseTransform(), addExclamation, wrapBrackets);

    console.log('Chained transforms:', collectText(pipeline));
  }

  // ============================================================================
  // Lazy Evaluation - Pull-Based Processing
  // ============================================================================
  section('Lazy Evaluation');

  // Demonstrate that processing only happens when pulled
  {
    let sourceYields = 0;
    let transformCalls = 0;

    function* trackedSource() {
      sourceYields++;
      yield 'a';
      sourceYields++;
      yield 'b';
      sourceYields++;
      yield 'c';
      sourceYields++;
      yield 'd';
      sourceYields++;
      yield 'e';
    }

    const trackingTransform: SyncTransform = (chunks) => {
      if (chunks !== null) transformCalls++;
      return chunks;
    };

    const pipeline = Stream.pullSync(Stream.fromSync(trackedSource()), trackingTransform);

    console.log('Before pulling:');
    console.log('  Source yields:', sourceYields);
    console.log('  Transform calls:', transformCalls);

    // Pull just 2 batches
    const iterator = pipeline[Symbol.iterator]();
    iterator.next();
    iterator.next();

    console.log('\nAfter pulling 2 batches:');
    console.log('  Source yields:', sourceYields);
    console.log('  Transform calls:', transformCalls);

    // Note: remaining chunks are never processed!
    console.log('  (Remaining batches never processed)');
  }

  // ============================================================================
  // Filtering - Transform Returns Empty Array
  // ============================================================================
  section('Filtering');

  // Filter out specific chunks
  {
    const filterDrop: SyncTransform = (chunks) => {
      if (chunks === null) return null;
      return chunks.filter((chunk) => decode(chunk) !== 'drop');
    };

    const source = Stream.fromSync(['keep', 'drop', 'keep', 'drop', 'keep']);
    const pipeline = Stream.pullSync(source, filterDrop);

    const chunks = collect(pipeline);
    console.log('Filtered chunks:', chunks.length);
    console.log('Content:', chunks.map(decode).join(', '));
  }

  // ============================================================================
  // 1:N Expansion - Arrays and Generators
  // ============================================================================
  section('1:N Expansion');

  // Transform returning array (expands to multiple chunks)
  {
    const splitChars: SyncTransform = (chunks) => {
      if (chunks === null) return null;
      const result: Uint8Array[] = [];
      for (const chunk of chunks) {
        for (const byte of chunk) {
          result.push(new Uint8Array([byte]));
        }
      }
      return result;
    };

    const source = Stream.fromSync(['abc']);
    const pipeline = Stream.pullSync(source, splitChars);

    const chunks = collect(pipeline);
    console.log('Split into', chunks.length, 'chunks:', chunks.map(decode).join(', '));
  }

  // Transform using generator (lazy expansion)
  {
    const wrapWithTags: SyncTransform = {

      transform: function* (source: Iterable<Uint8Array[] | null>) {
        for (const batch of source) {
          if (batch === null) continue;
          for (const chunk of batch) {
            yield encoder.encode('<start>');
            yield chunk;
            yield encoder.encode('<end>');
          }
        }
      },
    };

    const source = Stream.fromSync(['word']);
    const pipeline = Stream.pullSync(source, wrapWithTags);

    console.log('Generator expansion:', collectText(pipeline));
  }

  // ============================================================================
  // Stateful Transforms with Flush
  // ============================================================================
  section('Stateful Transforms with Flush');

  // Line buffer - emits complete lines, buffers partial
  {
    const lineBuffer: SyncTransform = {

      transform: function* (source: Iterable<Uint8Array[] | null>) {
        let buffer = '';

        for (const batch of source) {
          if (batch === null) {
            // Flush: emit remaining buffer
            if (buffer) {
              yield encoder.encode(`[partial: ${buffer}]`);
            }
            continue;
          }

          for (const chunk of batch) {
            buffer += decode(chunk);
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line

            for (const line of lines) {
              yield encoder.encode(`[line: ${line}]`);
            }
          }
        }
      },
    };

    const source = Stream.fromSync(['line1\nli', 'ne2\nline3']);
    const pipeline = Stream.pullSync(source, lineBuffer);

    console.log('Line buffer output:');
    for (const batch of pipeline) {
      for (const chunk of batch) {
        console.log(' ', decode(chunk));
      }
    }
  }

  // ============================================================================
  // Using tap for Observation
  // ============================================================================
  section('Using tapSync for Observation');

  {
    let byteCount = 0;

    const source = Stream.fromSync(['hello', ' ', 'world']);
    const pipeline = Stream.pullSync(
      source,
      Stream.tapSync((chunks) => {
        if (chunks !== null) {
          for (const chunk of chunks) {
            byteCount += chunk.length;
          }
        }
      }),
      uppercaseTransform()
    );

    const result = collectText(pipeline);
    console.log('Result:', result);
    console.log('Bytes observed:', byteCount);
  }

  // ============================================================================
  // Practical Examples
  // ============================================================================
  section('Practical Examples');

  // CSV Parser (sync)
  {
    console.log('\n--- CSV Parser ---');

    const csvData = `name,age,city
Alice,30,NYC
Bob,25,LA
Charlie,35,Chicago`;

    const parseLines: SyncTransform = {

      transform: function* (source: Iterable<Uint8Array[] | null>) {
        let isFirst = true;

        for (const batch of source) {
          if (batch === null) continue;

          for (const chunk of batch) {
            const lines = decode(chunk).split('\n');

            for (const line of lines) {
              if (isFirst) {
                isFirst = false;
                continue; // Skip header
              }
              if (line.trim()) {
                const [name, age, city] = line.split(',');
                yield encoder.encode(JSON.stringify({ name, age: parseInt(age), city }));
              }
            }
          }
        }
      },
    };

    const source = Stream.fromSync([csvData]);
    const pipeline = Stream.pullSync(source, parseLines);

    console.log('Parsed records:');
    for (const batch of pipeline) {
      for (const chunk of batch) {
        console.log(' ', decode(chunk));
      }
    }
  }

  // Text processing pipeline
  {
    console.log('\n--- Text Processing ---');

    const trim: SyncTransform = (chunks) => {
      if (chunks === null) return null;
      return chunks.map((chunk) => encoder.encode(decode(chunk).trim()));
    };

    const normalizeSpaces: SyncTransform = (chunks) => {
      if (chunks === null) return null;
      return chunks.map((chunk) => encoder.encode(decode(chunk).replace(/\s+/g, ' ')));
    };

    const titleCase: SyncTransform = (chunks) => {
      if (chunks === null) return null;
      return chunks.map((chunk) =>
        encoder.encode(decode(chunk).replace(/\b\w/g, (c) => c.toUpperCase()))
      );
    };

    const source = Stream.fromSync(['  Hello,   World!  ', '  foo BAR baz  ']);
    const pipeline = Stream.pullSync(source, trim, normalizeSpaces, titleCase);

    console.log('Processed text:');
    for (const batch of pipeline) {
      for (const chunk of batch) {
        console.log(' ', `"${decode(chunk)}"`);
      }
    }
  }

  // Chunked encoding simulation
  {
    console.log('\n--- Chunked Encoding ---');

    const chunkedEncode: SyncTransform = {

      transform: function* (source: Iterable<Uint8Array[] | null>) {
        for (const batch of source) {
          if (batch === null) {
            yield encoder.encode('0\r\n\r\n'); // End marker
            continue;
          }

          for (const chunk of batch) {
            const data = decode(chunk);
            yield encoder.encode(`${data.length.toString(16)}\r\n${data}\r\n`);
          }
        }
      },
    };

    const source = Stream.fromSync(['Hello', 'World', '!']);
    const pipeline = Stream.pullSync(source, chunkedEncode);

    console.log('Chunked output:');
    console.log(collectText(pipeline).replace(/\r\n/g, '\\r\\n\n'));
  }

  // ============================================================================
  // pipeToSync Example
  // ============================================================================
  section('pipeToSync Example');

  {
    // Simple sync writer that collects chunks
    const chunks: Uint8Array[] = [];
    let byteCount = 0;

    const syncWriter = {
      desiredSize: 100 as number | null,
      write(chunk: Uint8Array | string): void {
        const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        chunks.push(bytes);
        byteCount += bytes.byteLength;
      },
      writev(chs: (Uint8Array | string)[]): void {
        for (const c of chs) this.write(c);
      },
      end(): number {
        this.desiredSize = null;
        return byteCount;
      },
      fail(): void {
        this.desiredSize = null;
      },
    };

    const source = Stream.fromSync(['hello', ' ', 'world']);
    const written = Stream.pipeToSync(source, uppercaseTransform(), syncWriter);

    console.log('Bytes written:', written);
    console.log('Result:', chunks.map(decode).join(''));
  }

  console.log('\n--- Examples complete! ---\n');
}

main();
