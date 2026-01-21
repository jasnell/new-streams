/**
 * Real-World Patterns
 * 
 * This file demonstrates practical, real-world usage patterns for the streams API.
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // Pattern: Streaming JSON Lines (NDJSON)
  // ============================================================================
  section('Pattern: Streaming JSON Lines');

  {
    // Simulate receiving JSON Lines data
    const jsonlData = `{"event":"start","ts":1}
{"event":"data","value":42}
{"event":"data","value":99}
{"event":"end","ts":2}`;

    // JSON Lines parser transform
    let buffer = '';
    const jsonlParser = function* (chunk: Uint8Array | null): Generator<string> {
      if (chunk === null) {
        // Flush remaining buffer
        if (buffer.trim()) {
          yield JSON.stringify(JSON.parse(buffer));
        }
        return;
      }
      
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          const obj = JSON.parse(line);
          // Process the object
          obj.processed = true;
          yield JSON.stringify(obj) + '\n';
        }
      }
    };

    const processed = Stream.from(jsonlData).pipeThrough(jsonlParser);
    
    console.log('Processed JSON Lines:');
    for await (const chunk of processed) {
      const text = new TextDecoder().decode(chunk).trim();
      if (text) console.log('  ' + text);
    }
  }

  // ============================================================================
  // Pattern: CSV Processing Pipeline
  // ============================================================================
  section('Pattern: CSV Processing');

  {
    const csvData = `name,age,city
Alice,30,NYC
Bob,25,LA
Charlie,35,Chicago`;

    // Line splitter
    let lineBuffer = '';
    const lineSplitter = function* (chunk: Uint8Array | null): Generator<string> {
      if (chunk === null) {
        if (lineBuffer) yield lineBuffer + '\n';
        return;
      }
      lineBuffer += new TextDecoder().decode(chunk);
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        yield line + '\n';
      }
    };

    // CSV parser (simple, no quoted fields)
    let headers: string[] = [];
    const csvParser = (chunk: Uint8Array | null) => {
      if (chunk === null) return null;
      
      const line = new TextDecoder().decode(chunk).trim();
      if (!line) return null;
      
      const values = line.split(',');
      
      if (headers.length === 0) {
        headers = values;
        return null; // Skip header row
      }
      
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => obj[h] = values[i]);
      return JSON.stringify(obj) + '\n';
    };

    const records = Stream.from(csvData)
      .pipeThrough(lineSplitter)
      .pipeThrough(csvParser);

    console.log('Parsed CSV records:');
    for await (const chunk of records) {
      const text = new TextDecoder().decode(chunk).trim();
      if (text) console.log('  ' + text);
    }
  }

  // ============================================================================
  // Pattern: Rate-Limited API Client
  // ============================================================================
  section('Pattern: Rate-Limited Producer');

  {
    // Simulate API that produces data faster than we want to process
    const fastProducer = Stream.pull(async function* () {
      for (let i = 0; i < 10; i++) {
        yield `item${i}`;
      }
    });

    // Use buffer backpressure to rate-limit
    const [rateLimited, writer] = Stream.push({
      buffer: {
        max: 20,          // Small buffer
        onOverflow: 'block' // Block producer when full
      }
    });

    // Pipe producer to rate-limited buffer
    const pipePromise = fastProducer.pipeTo(writer);

    // Slow consumer
    console.log('Processing with rate limiting:');
    let count = 0;
    for await (const chunk of rateLimited) {
      const text = new TextDecoder().decode(chunk);
      console.log(`  Processed: ${text}`);
      await new Promise(r => setTimeout(r, 20)); // Slow processing
      if (++count >= 5) {
        await rateLimited.cancel();
        break;
      }
    }

    try { await pipePromise; } catch (e) { /* cancelled */ }
    console.log('  (Stopped after 5 items)');
  }

  // ============================================================================
  // Pattern: Tee for Logging and Processing
  // ============================================================================
  section('Pattern: Tee for Logging');

  {
    const stream = Stream.from('important data to process and log');

    // Branch for logging
    const logBranch = stream.tee();
    
    // Log in background
    const logPromise = (async () => {
      const data = await logBranch.text();
      console.log(`  [AUDIT] Data received: "${data.substring(0, 20)}..."`);
    })();

    // Main processing
    const result = await stream.pipeThrough((chunk) => {
      if (chunk === null) return null;
      return new TextDecoder().decode(chunk).toUpperCase();
    }).text();
    
    console.log(`  [MAIN] Processed: "${result.substring(0, 20)}..."`);
    
    await logPromise;
  }

  // ============================================================================
  // Pattern: Progress Tracking
  // ============================================================================
  section('Pattern: Progress Tracking');

  {
    // Simulate a large stream
    const largeStream = Stream.pull(async function* () {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 30));
        yield `chunk${i.toString().padStart(2, '0')} `; // 9 bytes each
      }
    });

    let bytesRead = 0;
    const totalExpected = 90;

    // Progress tracking transform
    const withProgress = largeStream.pipeThrough((chunk) => {
      if (chunk === null) {
        console.log('  Progress: 100% complete');
        return null;
      }
      bytesRead += chunk.length;
      const percent = Math.round((bytesRead / totalExpected) * 100);
      console.log(`  Progress: ${percent}% (${bytesRead}/${totalExpected} bytes)`);
      return chunk;
    });

    await withProgress.bytes();
  }

  // ============================================================================
  // Pattern: Chunked Upload Simulation
  // ============================================================================
  section('Pattern: Chunked Upload');

  {
    const data = 'This is a larger piece of data that we want to upload in chunks for reliability.';
    
    // Create chunks of ~20 bytes
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += 20) {
      chunks.push(data.substring(i, i + 20));
    }

    console.log(`  Uploading ${data.length} bytes in ${chunks.length} chunks...`);

    // Simulate upload with retries
    let uploadedChunks = 0;
    
    for (const chunk of chunks) {
      const chunkStream = Stream.from(chunk);
      
      // Simulate upload (with potential retry)
      let retries = 0;
      while (retries < 3) {
        try {
          // Simulate network call
          const bytes = await chunkStream.bytes();
          await new Promise(r => setTimeout(r, 20));
          
          // Random failure for demo
          if (Math.random() < 0.3 && retries === 0) {
            throw new Error('Network error');
          }
          
          uploadedChunks++;
          console.log(`  Chunk ${uploadedChunks}/${chunks.length} uploaded (${bytes.length} bytes)`);
          break;
        } catch (e) {
          retries++;
          console.log(`  Chunk ${uploadedChunks + 1} failed, retry ${retries}...`);
        }
      }
    }
    
    console.log(`  Upload complete: ${uploadedChunks} chunks`);
  }

  // ============================================================================
  // Pattern: Server-Sent Events (SSE) Parser
  // ============================================================================
  section('Pattern: SSE Parser');

  {
    // Simulate SSE stream
    const sseData = `event: message
data: {"type":"greeting","text":"Hello"}

event: update
data: {"count":1}

event: update
data: {"count":2}

event: done
data: {"status":"complete"}

`;

    let buffer = '';
    let currentEvent: { event?: string; data?: string } = {};

    const sseParser = function* (chunk: Uint8Array | null): Generator<string> {
      if (chunk !== null) {
        buffer += new TextDecoder().decode(chunk);
      }

      const lines = buffer.split('\n');
      buffer = chunk === null ? '' : (lines.pop() || '');

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent.event = line.substring(7);
        } else if (line.startsWith('data: ')) {
          currentEvent.data = line.substring(6);
        } else if (line === '' && currentEvent.data) {
          // End of event
          yield JSON.stringify({
            event: currentEvent.event || 'message',
            data: JSON.parse(currentEvent.data)
          }) + '\n';
          currentEvent = {};
        }
      }
    };

    console.log('Parsed SSE events:');
    const events = Stream.from(sseData).pipeThrough(sseParser);
    
    for await (const chunk of events) {
      const text = new TextDecoder().decode(chunk).trim();
      if (text) {
        const parsed = JSON.parse(text);
        console.log(`  [${parsed.event}] ${JSON.stringify(parsed.data)}`);
      }
    }
  }

  // ============================================================================
  // Pattern: Streaming Hash Computation
  // ============================================================================
  section('Pattern: Streaming Hash');

  {
    // Simple checksum (real app would use crypto)
    let checksum = 0;
    
    const stream = Stream.from('Data to compute a running checksum on');
    
    // Branch for hash computation
    const hashBranch = stream.tee();
    
    // Compute hash in background
    const hashPromise = (async () => {
      for await (const chunk of hashBranch) {
        for (const byte of chunk) {
          checksum = (checksum + byte) % 256;
        }
      }
      return checksum;
    })();

    // Main processing
    const result = await stream.text();
    const hash = await hashPromise;
    
    console.log(`  Data: "${result}"`);
    console.log(`  Checksum: ${hash}`);
  }

  // ============================================================================
  // Pattern: Conditional Pipeline
  // ============================================================================
  section('Pattern: Conditional Processing');

  {
    // Stream with header indicating content type
    const stream = Stream.from('COMPRESS:This data should be "compressed"');
    
    // Read header first
    const header = await stream.take(8).text();
    console.log(`  Header: "${header}"`);
    
    // Conditional processing based on header
    let result: string;
    if (header === 'COMPRESS') {
      // Skip the colon
      stream.drop(1);
      
      // Apply "compression" (just uppercase for demo)
      result = await stream.pipeThrough((chunk) => {
        if (chunk === null) return null;
        return new TextDecoder().decode(chunk).toUpperCase();
      }).text();
      console.log(`  Applied compression transform`);
    } else {
      result = await stream.text();
      console.log(`  No transform applied`);
    }
    
    console.log(`  Result: "${result}"`);
  }

  // ============================================================================
  // Pattern: Graceful Shutdown
  // ============================================================================
  section('Pattern: Graceful Shutdown');

  {
    const controller = new AbortController();
    
    // Simulate long-running stream processing
    const processor = async () => {
      await using stream = Stream.pull(async function* () {
        try {
          let i = 0;
          while (true) {
            await new Promise(r => setTimeout(r, 30));
            yield `tick${i++}`;
          }
        } finally {
          console.log('  Stream cleanup completed');
        }
      });

      try {
        for await (const chunk of stream) {
          if (controller.signal.aborted) {
            console.log('  Received shutdown signal, stopping...');
            break;
          }
          console.log(`  Processing: ${new TextDecoder().decode(chunk)}`);
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') throw e;
      }
    };

    // Start processing
    const processorPromise = processor();
    
    // Simulate shutdown after some time
    setTimeout(() => {
      console.log('  Initiating shutdown...');
      controller.abort();
    }, 100);
    
    await processorPromise;
    console.log('  Shutdown complete');
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
