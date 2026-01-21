/**
 * Merging and Concatenating Streams
 * 
 * This file demonstrates Stream.merge() and Stream.concat() for combining streams.
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // Stream.concat() - Sequential concatenation
  // ============================================================================
  section('Stream.concat() - Sequential concatenation');

  // Basic concatenation
  {
    const stream1 = Stream.from('Hello ');
    const stream2 = Stream.from('World');
    const stream3 = Stream.from('!');
    
    const combined = Stream.concat([stream1, stream2, stream3]);
    const text = await combined.text();
    
    console.log('Concatenated:', text);
  }

  // Order is preserved
  {
    const streams = [
      Stream.from('A'),
      Stream.from('B'),
      Stream.from('C'),
      Stream.from('D'),
      Stream.from('E'),
    ];
    
    const combined = Stream.concat(streams);
    console.log('Order preserved:', await combined.text());
  }

  // Empty input returns empty stream
  {
    const empty = Stream.concat([]);
    console.log('concat([]) is empty:', (await empty.bytes()).length === 0);
  }

  // Single input returns that stream
  {
    const single = Stream.from('single');
    const result = Stream.concat([single]);
    console.log('Single input:', result === single);
  }

  // Handles already-closed streams
  {
    const closed = Stream.empty();
    const stream2 = Stream.from(' after empty');
    
    const combined = Stream.concat([closed, stream2]);
    console.log('With closed stream:', await combined.text());
  }

  // Concatenating async streams
  {
    const slow1 = Stream.pull(async function* () {
      await new Promise(r => setTimeout(r, 20));
      yield 'slow1';
    });
    
    const slow2 = Stream.pull(async function* () {
      await new Promise(r => setTimeout(r, 20));
      yield ' slow2';
    });
    
    const combined = Stream.concat([slow1, slow2]);
    console.log('Async concatenated:', await combined.text());
    console.log('(streams consumed sequentially)');
  }

  // ============================================================================
  // Stream.merge() - Interleaved merging (first-come ordering)
  // ============================================================================
  section('Stream.merge() - Interleaved merging');

  // Basic merge - interleaves data from multiple streams
  {
    // Create streams that produce data at different times
    const fast = Stream.pull(async function* () {
      yield 'F1';
      await new Promise(r => setTimeout(r, 10));
      yield 'F2';
      await new Promise(r => setTimeout(r, 10));
      yield 'F3';
    });
    
    const slow = Stream.pull(async function* () {
      await new Promise(r => setTimeout(r, 15));
      yield 'S1';
      await new Promise(r => setTimeout(r, 15));
      yield 'S2';
    });
    
    const merged = Stream.merge([fast, slow]);
    
    const chunks: string[] = [];
    for await (const chunk of merged) {
      chunks.push(new TextDecoder().decode(chunk));
    }
    
    console.log('Merged order:', chunks.join(' '));
    console.log('(first-come ordering, not round-robin)');
  }

  // Empty input returns empty stream
  {
    const empty = Stream.merge([]);
    console.log('merge([]) is empty:', (await empty.bytes()).length === 0);
  }

  // Single input returns that stream
  {
    const single = Stream.from('single');
    const result = Stream.merge([single]);
    console.log('Single input:', result === single);
  }

  // Handles already-closed streams
  {
    const closed = Stream.empty();
    const active = Stream.from('active data');
    
    const merged = Stream.merge([closed, active]);
    console.log('With closed stream:', await merged.text());
  }

  // ============================================================================
  // Error handling in concat
  // ============================================================================
  section('Error handling in concat');

  // Error in one stream errors the concatenated stream
  {
    const good = Stream.from('good ');
    const bad = Stream.pull(function* () {
      yield 'before error';
      throw new Error('Stream error!');
    });
    const never = Stream.from(' never reached');
    
    const combined = Stream.concat([good, bad, never]);
    
    try {
      await combined.text();
    } catch (e) {
      console.log('concat() error propagated:', (e as Error).message);
    }
  }

  // ============================================================================
  // Error handling in merge
  // ============================================================================
  section('Error handling in merge');

  // Error in one stream errors the merged stream
  {
    const good = Stream.pull(async function* () {
      yield 'good';
      await new Promise(r => setTimeout(r, 50));
      yield 'more good';
    });
    
    const bad = Stream.pull(async function* () {
      await new Promise(r => setTimeout(r, 10));
      throw new Error('Merge error!');
    });
    
    const merged = Stream.merge([good, bad]);
    
    try {
      await merged.text();
    } catch (e) {
      console.log('merge() error propagated:', (e as Error).message);
    }
  }

  // ============================================================================
  // Practical examples
  // ============================================================================
  section('Practical examples');

  // Multi-part form data assembly
  {
    console.log('\n--- Multi-part assembly ---');
    
    const boundary = '----boundary----';
    const part1Data = 'field1=value1';
    const part2Data = 'field2=value2';
    
    const multipart = Stream.concat([
      Stream.from(`${boundary}\r\n`),
      Stream.from(`Content-Disposition: form-data; name="field1"\r\n\r\n`),
      Stream.from(part1Data),
      Stream.from(`\r\n${boundary}\r\n`),
      Stream.from(`Content-Disposition: form-data; name="field2"\r\n\r\n`),
      Stream.from(part2Data),
      Stream.from(`\r\n${boundary}--\r\n`),
    ]);
    
    const result = await multipart.text();
    console.log('Assembled multipart:');
    result.split('\r\n').forEach(line => console.log('  ' + line));
  }

  // HTTP chunked transfer encoding
  {
    console.log('\n--- Chunked transfer encoding ---');
    
    const chunks = ['Hello', ' ', 'World', '!'];
    
    // Build chunked body
    const chunkStreams = chunks.map(chunk => {
      const encoded = new TextEncoder().encode(chunk);
      return Stream.concat([
        Stream.from(`${encoded.length.toString(16)}\r\n`),
        Stream.from(encoded),
        Stream.from('\r\n'),
      ]);
    });
    
    // Add final chunk
    chunkStreams.push(Stream.from('0\r\n\r\n'));
    
    const chunkedBody = Stream.concat(chunkStreams);
    const result = await chunkedBody.text();
    
    console.log('Chunked encoding:');
    result.split('\r\n').forEach((line, i) => {
      if (line) console.log(`  ${i}: "${line}"`);
    });
  }

  // Multiplexing multiple sources
  {
    console.log('\n--- Multiplexing data sources ---');
    
    // Simulate multiple data sources
    const source1 = Stream.pull(async function* () {
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, Math.random() * 30));
        yield `[src1:${i}]`;
      }
    });
    
    const source2 = Stream.pull(async function* () {
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, Math.random() * 30));
        yield `[src2:${i}]`;
      }
    });
    
    const source3 = Stream.pull(async function* () {
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, Math.random() * 30));
        yield `[src3:${i}]`;
      }
    });
    
    const multiplexed = Stream.merge([source1, source2, source3]);
    
    const messages: string[] = [];
    for await (const chunk of multiplexed) {
      messages.push(new TextDecoder().decode(chunk));
    }
    
    console.log('Multiplexed order:', messages.join(' '));
    console.log('(interleaved based on arrival time)');
  }

  // Log aggregation
  {
    console.log('\n--- Log aggregation ---');
    
    const serverA = Stream.pull(async function* () {
      yield '[A] Starting...\n';
      await new Promise(r => setTimeout(r, 10));
      yield '[A] Processing...\n';
      await new Promise(r => setTimeout(r, 20));
      yield '[A] Done.\n';
    });
    
    const serverB = Stream.pull(async function* () {
      await new Promise(r => setTimeout(r, 5));
      yield '[B] Starting...\n';
      await new Promise(r => setTimeout(r, 15));
      yield '[B] Processing...\n';
      yield '[B] Done.\n';
    });
    
    const aggregated = Stream.merge([serverA, serverB]);
    
    console.log('Aggregated logs:');
    for await (const chunk of aggregated) {
      const line = new TextDecoder().decode(chunk).trim();
      console.log('  ' + line);
    }
  }

  // Building a response with headers and body
  {
    console.log('\n--- HTTP response assembly ---');
    
    const statusLine = Stream.from('HTTP/1.1 200 OK\r\n');
    const headers = Stream.from([
      'Content-Type: text/plain',
      'X-Custom: value',
      ''
    ].join('\r\n') + '\r\n');
    const body = Stream.from('Response body content');
    
    const response = Stream.concat([statusLine, headers, body]);
    
    console.log('Assembled response:');
    (await response.text()).split('\r\n').forEach(line => {
      console.log('  ' + (line || '(empty line)'));
    });
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
