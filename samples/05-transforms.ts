/**
 * Stream Transforms
 * 
 * This file demonstrates Stream.transform() and pipeThrough() for transforming data.
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // Stream.transform() - Create a transform with input writer
  // ============================================================================
  section('Stream.transform() - Creating transforms');

  // Basic transform - uppercase text
  {
    const [output, writer] = Stream.transform((chunk) => {
      if (chunk === null) return null; // Flush signal
      const text = new TextDecoder().decode(chunk);
      return text.toUpperCase();
    });
    
    await writer.write('hello ');
    await writer.write('world');
    await writer.close();
    
    const result = await output.text();
    console.log('Uppercase transform:', result);
  }

  // Transform function receives null on flush
  {
    let flushCalled = false;
    
    const [output, writer] = Stream.transform((chunk) => {
      if (chunk === null) {
        flushCalled = true;
        return 'FLUSHED';
      }
      return chunk;
    });
    
    await writer.write('data');
    await writer.close();
    
    const result = await output.text();
    console.log('Flush called:', flushCalled);
    console.log('Result with flush:', result);
  }

  // Return null/undefined emits nothing
  {
    const [output, writer] = Stream.transform((chunk) => {
      if (chunk === null) return null;
      const text = new TextDecoder().decode(chunk);
      // Filter out chunks containing 'skip'
      if (text.includes('skip')) return null;
      return chunk;
    });
    
    await writer.write('keep1 ');
    await writer.write('skip this ');
    await writer.write('keep2');
    await writer.close();
    
    console.log('Filtered result:', await output.text());
  }

  // ============================================================================
  // Transform with generators (1:N mapping)
  // ============================================================================
  section('Generator transforms - 1:N mapping');

  // Sync generator - split into lines
  {
    const [output, writer] = Stream.transform(function* (chunk) {
      if (chunk === null) return;
      const text = new TextDecoder().decode(chunk);
      for (const char of text) {
        yield char + '\n';
      }
    });
    
    await writer.write('ABC');
    await writer.close();
    
    const result = await output.text();
    console.log('Split into lines:');
    console.log(result);
  }

  // Async generator - add delay between outputs
  {
    const [output, writer] = Stream.transform(async function* (chunk) {
      if (chunk === null) return;
      const text = new TextDecoder().decode(chunk);
      for (const word of text.split(' ')) {
        await new Promise(r => setTimeout(r, 10));
        yield word + ' ';
      }
    });
    
    await writer.write('async generator transform');
    await writer.close();
    
    console.log('Async generator result:', await output.text());
  }

  // ============================================================================
  // Transform with object interface
  // ============================================================================
  section('Transform objects');

  // Object with transform() method
  {
    const [output, writer] = Stream.transform({
      transform(chunk) {
        if (chunk === null) return null;
        const text = new TextDecoder().decode(chunk);
        return `[${text}]`;
      }
    });
    
    await writer.write('wrapped');
    await writer.close();
    
    console.log('Object transform:', await output.text());
  }

  // Object with abort() for cleanup
  {
    let abortCalled = false;
    let abortReason: unknown;
    
    const [output, writer] = Stream.transform({
      transform(chunk) {
        if (chunk === null) return null;
        throw new Error('Transform error');
      },
      abort(reason) {
        abortCalled = true;
        abortReason = reason;
      }
    });
    
    try {
      await writer.write('trigger error');
    } catch (e) {
      // Expected
    }
    
    // Wait for abort propagation
    await new Promise(r => setTimeout(r, 10));
    
    console.log('Abort called:', abortCalled);
    console.log('Abort reason:', (abortReason as Error)?.message || 'none');
  }

  // ============================================================================
  // pipeThrough() - Transform a stream
  // ============================================================================
  section('pipeThrough() - Transforming streams');

  // Basic pipeThrough with function
  {
    const stream = Stream.from('hello world');
    
    const transformed = stream.pipeThrough((chunk) => {
      if (chunk === null) return null;
      return new TextDecoder().decode(chunk).toUpperCase();
    });
    
    console.log('pipeThrough result:', await transformed.text());
  }

  // pipeThrough with object
  {
    const stream = Stream.from('wrap me');
    
    const transformed = stream.pipeThrough({
      transform(chunk) {
        if (chunk === null) return '>';
        return '<' + new TextDecoder().decode(chunk);
      }
    });
    
    console.log('pipeThrough with object:', await transformed.text());
  }

  // Chaining transforms
  {
    const result = await Stream.from('chain')
      .pipeThrough((chunk) => chunk === null ? null : 
        new TextDecoder().decode(chunk).toUpperCase())
      .pipeThrough((chunk) => chunk === null ? null :
        `[${new TextDecoder().decode(chunk)}]`)
      .pipeThrough((chunk) => chunk === null ? null :
        new TextDecoder().decode(chunk).repeat(2))
      .text();
    
    console.log('Chained transforms:', result);
  }

  // pipeThrough with signal option
  {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    
    const stream = Stream.pull(async function* () {
      yield 'chunk1';
      await new Promise(r => setTimeout(r, 100));
      yield 'chunk2';
    });
    
    const transformed = stream.pipeThrough(
      (chunk) => chunk,
      { signal: controller.signal }
    );
    
    try {
      await transformed.bytes();
    } catch (e) {
      console.log('\npipeThrough cancelled:', (e as Error).name);
    }
  }

  // pipeThrough with limit option
  {
    const stream = Stream.from('hello world'); // 11 bytes
    
    const transformed = stream.pipeThrough(
      (chunk) => chunk,
      { limit: 5 }
    );
    
    console.log('pipeThrough with limit:', await transformed.text());
  }

  // pipeThrough with chunkSize option
  {
    const receivedSizes: number[] = [];
    
    const stream = Stream.from('123456789012'); // 12 bytes
    
    const transformed = stream.pipeThrough(
      (chunk) => {
        if (chunk !== null) {
          receivedSizes.push(chunk.length);
        }
        return chunk;
      },
      { chunkSize: 4 }
    );
    
    await transformed.bytes();
    console.log('With chunkSize:4, received sizes:', receivedSizes);
  }

  // ============================================================================
  // Transform with chunkSize option
  // ============================================================================
  section('chunkSize option - fixed-size input chunks');

  {
    const receivedSizes: number[] = [];
    
    const [output, writer] = Stream.transform((chunk) => {
      if (chunk === null) return null;
      receivedSizes.push(chunk.length);
      return chunk;
    }, { chunkSize: 5 });
    
    // Write 12 bytes
    await writer.write('123456789012');
    await writer.close();
    
    await output.bytes();
    
    console.log('chunkSize:5 on 12 bytes, received:', receivedSizes);
    console.log('  (First two are 5, last is remainder 2)');
  }

  // ============================================================================
  // Practical transform examples
  // ============================================================================
  section('Practical examples');

  // Line splitter
  {
    console.log('\n--- Line splitter ---');
    let buffer = '';
    
    const [output, writer] = Stream.transform(function* (chunk) {
      if (chunk === null) {
        if (buffer) yield buffer + '\n';
        return;
      }
      
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        yield line + '\n';
      }
    });
    
    await writer.write('line1\nline2\nline');
    await writer.write('3\nline4');
    await writer.close();
    
    console.log('Lines:');
    for await (const chunk of output) {
      console.log('  ' + new TextDecoder().decode(chunk).trim());
    }
  }

  // JSON Lines parser
  {
    console.log('\n--- JSON Lines parser ---');
    let buffer = '';
    
    const [output, writer] = Stream.transform(function* (chunk) {
      if (chunk === null) {
        if (buffer.trim()) {
          // Parse and re-stringify to validate JSON
          yield JSON.stringify(JSON.parse(buffer)) + '\n';
        }
        return;
      }
      
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          yield JSON.stringify(JSON.parse(line)) + '\n';
        }
      }
    });
    
    await writer.write('{"a":1}\n{"b":2}\n');
    await writer.write('{"c":3}');
    await writer.close();
    
    console.log('Parsed JSON lines:', await output.text());
  }

  // Compression simulation (run-length encoding)
  {
    console.log('\n--- Simple RLE encoding ---');
    const [output, writer] = Stream.transform((chunk) => {
      if (chunk === null) return null;
      
      const text = new TextDecoder().decode(chunk);
      let result = '';
      let count = 1;
      let prev = text[0];
      
      for (let i = 1; i <= text.length; i++) {
        if (text[i] === prev) {
          count++;
        } else {
          result += count > 1 ? `${count}${prev}` : prev;
          count = 1;
          prev = text[i];
        }
      }
      
      return result;
    });
    
    await writer.write('AAABBBCCCCCD');
    await writer.close();
    
    console.log('RLE encoded:', await output.text());
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
