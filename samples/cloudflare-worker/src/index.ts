/**
 * Cloudflare Worker: Web Streams vs New Streams API Comparison
 *
 * This worker demonstrates two approaches to stream processing:
 * 1. /web-streams - Using standard Web Streams API
 * 2. /new-streams - Using the new streams API
 *
 * Both paths:
 * - Generate 10 MB of random lorem ipsum style text
 * - Batch output into 16KB chunks via a transform
 * - Branch the stream:
 *   - One branch returns to the response
 *   - Second branch generates SHA-256 hashes for each chunk (logged to console)
 */

import { Stream, type TransformObject } from '../../../src/index.js';

// Cloudflare Workers ExecutionContext interface
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// =============================================================================
// Constants
// =============================================================================

const TARGET_SIZE = 10 * 1024 * 1024; // 10 MB
const BATCH_SIZE = 16 * 1024; // 16 KB chunks

// Lorem ipsum words for generating random text
const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
  'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
  'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint',
  'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia',
  'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum', 'perspiciatis', 'unde',
  'omnis', 'iste', 'natus', 'error', 'voluptatem', 'accusantium', 'doloremque',
  'laudantium', 'totam', 'rem', 'aperiam', 'eaque', 'ipsa', 'quae', 'ab', 'illo',
  'inventore', 'veritatis', 'quasi', 'architecto', 'beatae', 'vitae', 'dicta',
  'explicabo', 'nemo', 'ipsam', 'quia', 'voluptas', 'aspernatur', 'aut', 'odit',
  'fugit', 'consequuntur', 'magni', 'dolores', 'eos', 'ratione', 'sequi',
  'nesciunt', 'neque', 'porro', 'quisquam', 'nihil', 'molestiae', 'recusandae',
];

const encoder = new TextEncoder();

// =============================================================================
// Shared Utilities
// =============================================================================

/**
 * Simple seeded random number generator for reproducible text.
 * Using a simple Linear Congruential Generator.
 */
function createRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/**
 * Convert bytes to hex string
 */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// =============================================================================
// Web Streams Implementation
// =============================================================================

/**
 * Generate lorem ipsum text using Web Streams ReadableStream.
 */
function createLoremStreamWebStreams(targetBytes: number, seed: number): ReadableStream<Uint8Array> {
  const random = createRandom(seed);
  let bytesGenerated = 0;

  return new ReadableStream({
    pull(controller) {
      if (bytesGenerated >= targetBytes) {
        controller.close();
        return;
      }

      // Generate a paragraph
      const sentenceCount = Math.floor(random() * 5) + 3;
      const sentences: string[] = [];

      for (let s = 0; s < sentenceCount; s++) {
        const wordCount = Math.floor(random() * 10) + 5;
        const words: string[] = [];

        for (let w = 0; w < wordCount; w++) {
          const wordIndex = Math.floor(random() * LOREM_WORDS.length);
          let word = LOREM_WORDS[wordIndex];
          if (w === 0) {
            word = word.charAt(0).toUpperCase() + word.slice(1);
          }
          words.push(word);
        }

        sentences.push(words.join(' ') + '.');
      }

      const paragraph = sentences.join(' ') + '\n\n';
      const encoded = encoder.encode(paragraph);
      bytesGenerated += encoded.byteLength;
      controller.enqueue(encoded);
    },
  });
}

/**
 * Transform that batches input into 16KB chunks (Web Streams).
 */
function createBatchTransformWebStreams(): TransformStream<Uint8Array, Uint8Array> {
  let buffer = new Uint8Array(0);

  return new TransformStream({
    transform(chunk, controller) {
      // Append to buffer
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;

      // Emit 16KB chunks
      while (buffer.length >= BATCH_SIZE) {
        controller.enqueue(buffer.slice(0, BATCH_SIZE));
        buffer = buffer.slice(BATCH_SIZE);
      }
    },
    flush(controller) {
      // Emit remaining data
      if (buffer.length > 0) {
        controller.enqueue(buffer);
      }
    },
  });
}

/**
 * Process a stream branch to generate hashes (Web Streams).
 */
async function hashBranchWebStreams(
  stream: ReadableStream<Uint8Array>,
  label: string
): Promise<void> {
  const reader = stream.getReader();
  let chunkIndex = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(value) as unknown as ArrayBuffer);
      console.log(`[${label}] Chunk ${chunkIndex++}: ${value.byteLength} bytes, SHA-256: ${toHex(hash)}`);
    }
    console.log(`[${label}] Completed: ${chunkIndex} chunks hashed`);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Handle request using Web Streams API.
 */
async function handleWebStreams(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const seed = parseInt(url.searchParams.get('seed') || '42', 10);

  console.log('[web-streams] Starting stream processing...');

  // Create the source stream
  const source = createLoremStreamWebStreams(TARGET_SIZE, seed);

  // Apply batching transform
  const batched = source.pipeThrough(createBatchTransformWebStreams());

  // Tee the stream for branching
  const [responseBranch, hashBranch] = batched.tee();

  // Start hash processing in background (don't await - runs concurrently)
  hashBranchWebStreams(hashBranch, 'web-streams').catch((err) => {
    console.error('[web-streams] Hash branch error:', err);
  });

  // Return the response branch
  return new Response(responseBranch, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Stream-Type': 'web-streams',
    },
  });
}

// =============================================================================
// New Streams API Implementation
// =============================================================================

/**
 * Generate lorem ipsum text using the new streams API.
 */
async function* createLoremStreamNewAPI(
  targetBytes: number,
  seed: number
): AsyncGenerator<string> {
  const random = createRandom(seed);
  let bytesGenerated = 0;

  while (bytesGenerated < targetBytes) {
    // Generate a paragraph
    const sentenceCount = Math.floor(random() * 5) + 3;
    const sentences: string[] = [];

    for (let s = 0; s < sentenceCount; s++) {
      const wordCount = Math.floor(random() * 10) + 5;
      const words: string[] = [];

      for (let w = 0; w < wordCount; w++) {
        const wordIndex = Math.floor(random() * LOREM_WORDS.length);
        let word = LOREM_WORDS[wordIndex];
        if (w === 0) {
          word = word.charAt(0).toUpperCase() + word.slice(1);
        }
        words.push(word);
      }

      sentences.push(words.join(' ') + '.');
    }

    const paragraph = sentences.join(' ') + '\n\n';
    bytesGenerated += encoder.encode(paragraph).byteLength;
    yield paragraph;
  }
}

/**
 * Transform that batches input into 16KB chunks (New Streams API).
 */
function createBatchTransformNewAPI(): TransformObject {
  return {
    transform: async function* (source, _options) {
      let buffer = new Uint8Array(0);

      for await (const chunks of source) {
        if (chunks === null) {
          // Flush - emit remaining data
          if (buffer.length > 0) {
            yield buffer;
          }
          continue;
        }

        for (const chunk of chunks) {
          // Append to buffer
          const newBuffer = new Uint8Array(buffer.length + chunk.length);
          newBuffer.set(buffer);
          newBuffer.set(chunk, buffer.length);
          buffer = newBuffer;

          // Emit 16KB chunks
          while (buffer.length >= BATCH_SIZE) {
            yield buffer.slice(0, BATCH_SIZE);
            buffer = buffer.slice(BATCH_SIZE);
          }
        }
      }
    },
  };
}

/**
 * Convert new streams iterable to Web ReadableStream for Response.
 *
 * Optimizations:
 * - Pull-based: only fetches next batch when consumer is ready
 * - Batch enqueue: enqueues all chunks in a batch without intermediate awaits
 * - Proper cleanup: calls iterator.return() on cancel for resource cleanup
 */
function toReadableStream(source: AsyncIterable<Uint8Array[]>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let cancelled = false;

  return new ReadableStream(
    {
      async pull(controller) {
        if (cancelled) return;

        try {
          const { value: batch, done } = await iterator.next();

          if (done) {
            controller.close();
            return;
          }

          // Enqueue all chunks in the batch efficiently
          // The batch is already optimally sized (16KB chunks from our transform)
          for (let i = 0; i < batch.length; i++) {
            controller.enqueue(batch[i]);
          }
        } catch (error) {
          controller.error(error);
        }
      },

      async cancel(reason) {
        cancelled = true;
        // Clean up the iterator - this propagates cancellation upstream
        if (iterator.return) {
          try {
            await iterator.return(undefined);
          } catch {
            // Ignore cleanup errors
          }
        }
      },
    },
    // Use byte-length queuing strategy for better backpressure with binary data
    // High water mark of 64KB allows some buffering for smooth streaming
    { highWaterMark: 65536, size: (chunk) => chunk.byteLength }
  );
}

/**
 * Create a hash-logging tap transform.
 *
 * Stream.tap() is perfect for observation without branching:
 * - No separate consumer branch needed
 * - No broadcast overhead
 * - Chunks pass through unchanged
 * - Side effects (hashing, logging) happen inline
 */
function createHashTap(): ReturnType<typeof Stream.tap> {
  let chunkIndex = 0;
  let totalBytes = 0;

  return Stream.tap(async (chunks, _options) => {
    if (chunks === null) {
      // Flush signal - log final stats
      console.log(
        `[new-streams] Completed: ${chunkIndex} chunks hashed, ${totalBytes} bytes total`
      );
      return;
    }

    // Process entire batch - leverage batch-oriented design
    // Hash computations run in parallel within each batch
    const hashPromises = chunks.map(async (chunk) => {
      const hash = await crypto.subtle.digest(
        'SHA-256',
        new Uint8Array(chunk) as unknown as ArrayBuffer
      );
      return { size: chunk.byteLength, hash };
    });

    // Wait for all hashes in batch to complete
    const results = await Promise.all(hashPromises);

    // Log results
    for (const { size, hash } of results) {
      console.log(
        `[new-streams] Chunk ${chunkIndex++}: ${size} bytes, SHA-256: ${toHex(hash)}`
      );
      totalBytes += size;
    }
  });
}

/**
 * Handle request using the new streams API.
 *
 * Optimizations over Web Streams approach:
 * 1. Generator-based source - no manual ReadableStream controller management
 * 2. Stateful transform object - cleaner batching logic
 * 3. Stream.tap - observe chunks without creating separate branch (no broadcast needed!)
 * 4. Single pipeline - source -> batch -> tap(hash) -> response
 * 5. Batch-oriented design - process Uint8Array[] batches, not individual chunks
 * 6. Parallel hash computation within each batch
 */
async function handleNewStreams(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const seed = parseInt(url.searchParams.get('seed') || '42', 10);

  console.log('[new-streams] Starting stream processing...');

  // Build a single pipeline: source -> batch -> tap(hash) -> response
  // No broadcast needed! Stream.tap observes without branching.
  const pipeline = Stream.pull(
    // 1. Generate lorem ipsum text
    Stream.from(createLoremStreamNewAPI(TARGET_SIZE, seed)),
    // 2. Batch into 16KB chunks
    createBatchTransformNewAPI(),
    // 3. Tap to compute and log hashes (pass-through, no branching)
    createHashTap()
  );

  // Convert to Web ReadableStream for Response
  // The pipeline is lazy - data flows on-demand as the response is consumed
  const responseStream = toReadableStream(pipeline);

  return new Response(responseStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Stream-Type': 'new-streams',
    },
  });
}

// =============================================================================
// Worker Entry Point
// =============================================================================

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route based on path
    switch (path) {
      case '/web-streams':
        return handleWebStreams(request);

      case '/new-streams':
        return handleNewStreams(request);

      case '/':
        return new Response(
          `Stream Comparison Worker

Available endpoints:
  GET /web-streams - Process using Web Streams API
  GET /new-streams - Process using new streams API (optimized)

Both endpoints:
  - Generate 10 MB of random lorem ipsum text
  - Batch into 16 KB chunks
  - Hash each chunk and log to console
  - Return data to response

Query parameters:
  ?seed=<number> - Random seed for reproducible output (default: 42)

Example:
  curl -o /dev/null http://localhost:8787/web-streams
  curl -o /dev/null http://localhost:8787/new-streams?seed=123

Key Difference - Branching vs Tapping:

  Web Streams (/web-streams):
    source -> batch -> tee() -> [response, hashBranch]
    - Requires tee() to duplicate the stream
    - Two separate consumers with their own buffers
    - More memory, more coordination overhead

  New Streams API (/new-streams):
    source -> batch -> tap(hash) -> response
    - Single pipeline with inline observation
    - Stream.tap() observes without branching
    - No duplication, no extra buffers
    - Simpler, more efficient

Performance Optimizations in /new-streams:

  1. Stream.tap() for observation
     - No broadcast/tee overhead
     - Chunks pass through unchanged
     - Hash computation is just a side effect

  2. Generator-based source
     - Clean async generator vs manual ReadableStream controller
     - Natural backpressure via for-await-of

  3. Batch-oriented processing
     - Processes Uint8Array[] batches, not individual chunks
     - Reduces per-item overhead and iteration costs

  4. Parallel hash computation
     - Hashes all chunks in a batch concurrently via Promise.all()
     - Better utilization of async I/O

  5. Lazy pipeline
     - Data flows on-demand as response is consumed
     - No eager buffering or coordination
`,
          {
            headers: { 'Content-Type': 'text/plain' },
          }
        );

      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};
