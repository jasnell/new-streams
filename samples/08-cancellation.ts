/**
 * Cancellation and AbortSignal
 *
 * This file demonstrates stream cancellation using AbortSignal with the new streams API.
 *
 * Key changes from the old API:
 * - No stream.cancel() method - use AbortSignal or break from iteration
 * - AbortSignal is passed via options to consumers and pipeline functions
 * - Breaking from for-await iteration naturally signals the source to clean up
 */

import { Stream, type Writer, type Transform } from '../src/index.js';
import { section, uppercaseTransform, MemoryWriter } from './util.js';

async function main() {
  // ============================================================================
  // Breaking from iteration - the simplest form of cancellation
  // ============================================================================
  section('Breaking from iteration');

  {
    let generatorCleanedUp = false;

    async function* slowSource() {
      try {
        for (let i = 0; i < 100; i++) {
          yield `chunk${i}`;
          await new Promise((r) => setTimeout(r, 10));
        }
        console.log('Generator completed (should not see this)');
      } finally {
        generatorCleanedUp = true;
        console.log('Generator finally block ran');
      }
    }

    const readable = Stream.from(slowSource());

    let chunksRead = 0;
    for await (const batches of readable) {
      for (const chunk of batches) {
        chunksRead++;
        if (chunksRead >= 3) {
          break; // This triggers cleanup
        }
      }
      if (chunksRead >= 3) break;
    }

    // Small delay to let cleanup run
    await new Promise((r) => setTimeout(r, 50));

    console.log('Chunks read:', chunksRead);
    console.log('Generator cleaned up:', generatorCleanedUp);
  }

  // ============================================================================
  // AbortSignal with Stream.bytes()
  // ============================================================================
  section('AbortSignal with Stream.bytes()');

  {
    // Create a slow source that would take a long time
    async function* slowSource() {
      for (let i = 0; i < 100; i++) {
        yield `chunk${i}`;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    const controller = new AbortController();

    // Abort after 100ms
    setTimeout(() => controller.abort(), 100);

    console.log('Starting bytes() with 100ms timeout...');
    const start = Date.now();

    try {
      await Stream.bytes(Stream.from(slowSource()), { signal: controller.signal });
      console.log('ERROR: Should have aborted!');
    } catch (e) {
      console.log(`Aborted after ${Date.now() - start}ms:`, (e as Error).name);
    }
  }

  // Already-aborted signal rejects immediately
  {
    const controller = new AbortController();
    controller.abort(); // Abort before calling

    try {
      await Stream.bytes(Stream.from('hello'), { signal: controller.signal });
      console.log('ERROR: Should have rejected!');
    } catch (e) {
      console.log('Pre-aborted signal rejected immediately:', (e as Error).name);
    }
  }

  // ============================================================================
  // AbortSignal with Stream.text()
  // ============================================================================
  section('AbortSignal with Stream.text()');

  {
    async function* slowSource() {
      for (let i = 0; i < 100; i++) {
        yield `line${i}\n`;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    try {
      await Stream.text(Stream.from(slowSource()), { signal: controller.signal });
      console.log('ERROR: Should have aborted!');
    } catch (e) {
      console.log('text() aborted:', (e as Error).name);
    }
  }

  // ============================================================================
  // AbortSignal with Stream.pipeTo()
  // ============================================================================
  section('AbortSignal with Stream.pipeTo()');

  {
    async function* slowSource() {
      for (let i = 0; i < 10; i++) {
        yield `chunk${i}`;
        await new Promise((r) => setTimeout(r, 30));
      }
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const writer = new MemoryWriter();

    try {
      await Stream.pipeTo(Stream.from(slowSource()), writer, { signal: controller.signal });
      console.log('ERROR: Should have aborted!');
    } catch (e) {
      console.log('pipeTo() aborted:', (e as Error).name);
      console.log('Partial data written:', writer.getText());
      console.log('Writer was failed (desiredSize null):', writer.desiredSize === null);
    }
  }

  // ============================================================================
  // AbortSignal with Stream.pull() pipeline
  // ============================================================================
  section('AbortSignal with Stream.pull()');

  {
    async function* slowSource() {
      for (let i = 0; i < 10; i++) {
        yield `chunk${i}`;
        await new Promise((r) => setTimeout(r, 30));
      }
    }

    const pipeline = Stream.pull(
      Stream.from(slowSource()),
      uppercaseTransform(),
      { signal: AbortSignal.timeout(100)});

    try {
      await Stream.bytes(pipeline);
      console.log('ERROR: Should have aborted!');
    } catch (e) {
      console.log('Pipeline aborted:', (e as Error).name);
    }
  }

  // ============================================================================
  // AbortSignal.timeout() pattern
  // ============================================================================
  section('AbortSignal.timeout() pattern');

  {
    // Modern way: use AbortSignal.timeout()
    async function* slowSource() {
      for (let i = 0; i < 100; i++) {
        yield `chunk${i}`;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    try {
      const signal = AbortSignal.timeout(100);
      await Stream.bytes(Stream.from(slowSource()), { signal });
      console.log('ERROR: Should have timed out!');
    } catch (e) {
      console.log('Timed out via AbortSignal.timeout():', (e as Error).name);
    }
  }

  // ============================================================================
  // Manual timeout with cleanup
  // ============================================================================
  section('Manual timeout with cleanup');

  {
    async function* slowSource() {
      for (let i = 0; i < 100; i++) {
        yield `chunk${i}`;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 100);

    try {
      await Stream.bytes(Stream.from(slowSource()), { signal: controller.signal });
    } catch (e) {
      console.log('Manual timeout caught:', (e as Error).name);
    } finally {
      clearTimeout(timeoutId); // Important: clean up if completed early
      console.log('Timeout cleared');
    }
  }

  // ============================================================================
  // AbortSignal with push streams
  // ============================================================================
  section('AbortSignal with push streams');

  {
    const controller = new AbortController();
    const { writer, readable } = Stream.push({ signal: controller.signal });

    // Start consuming in background
    const bytesPromise = Stream.bytes(readable).catch((e) => {
      console.log('Consumer saw abort:', (e as Error).name);
      return new Uint8Array(0);
    });

    // Write some data
    await writer.write('chunk1');
    await writer.write('chunk2');

    // Abort the stream
    controller.abort();

    // Wait for consumer
    await bytesPromise;
    console.log('Push stream aborted successfully');
  }

  // ============================================================================
  // Consumer error propagates to source cleanup
  // ============================================================================
  section('Consumer errors trigger source cleanup');

  {
    let sourceCleanedUp = false;

    async function* source() {
      try {
        for (let i = 0; i < 10; i++) {
          yield `chunk${i}`;
        }
      } finally {
        sourceCleanedUp = true;
      }
    }

    const readable = Stream.from(source());

    let count = 0;
    try {
      for await (const batches of readable) {
        for (const _ of batches) {
          count++;
          if (count === 3) {
            throw new Error('Consumer error!');
          }
        }
      }
    } catch (e) {
      console.log('Consumer threw:', (e as Error).message);
    }

    // Small delay for cleanup
    await new Promise((r) => setTimeout(r, 10));

    console.log('Source cleaned up:', sourceCleanedUp);
  }

  // ============================================================================
  // Error in source aborts destination
  // ============================================================================
  section('Source error aborts destination');

  {
    async function* errorSource() {
      yield 'chunk1';
      yield 'chunk2';
      throw new Error('Source error!');
    }

    const writer = new MemoryWriter();

    try {
      await Stream.pipeTo(Stream.from(errorSource()), writer);
      console.log('ERROR: Should have thrown!');
    } catch (e) {
      console.log('Pipeline error:', (e as Error).message);
      console.log('Writer failed (desiredSize null):', writer.desiredSize === null);
      console.log('Error:', (e as Error).message);
    }
  }

  // ============================================================================
  // Combining multiple abort signals
  // ============================================================================
  section('Combining abort signals');

  {
    // AbortSignal.any() combines multiple signals (Node 20+, modern browsers)
    const userCancel = new AbortController();
    const timeout = AbortSignal.timeout(200);

    // Combine: abort on user cancel OR timeout
    const combined = AbortSignal.any([userCancel.signal, timeout]);

    async function* slowSource() {
      for (let i = 0; i < 100; i++) {
        yield `chunk${i}`;
        await new Promise((r) => setTimeout(r, 30));
      }
    }

    // Simulate user cancel after 100ms
    setTimeout(() => userCancel.abort(), 100);

    try {
      await Stream.bytes(Stream.from(slowSource()), { signal: combined });
      console.log('ERROR: Should have aborted!');
    } catch (e) {
      console.log('Combined signal aborted:', (e as Error).name);
    }
  }

  // ============================================================================
  // Abort signal with Stream.merge()
  // ============================================================================
  section('AbortSignal with Stream.merge()');

  {
    async function* source1() {
      for (let i = 0; i < 10; i++) {
        yield `source1-chunk${i}`;
        await new Promise((r) => setTimeout(r, 30));
      }
    }

    async function* source2() {
      for (let i = 0; i < 10; i++) {
        yield `source2-chunk${i}`;
        await new Promise((r) => setTimeout(r, 40));
      }
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const merged = Stream.merge(Stream.from(source1()), Stream.from(source2()), {
      signal: controller.signal,
    });

    let count = 0;
    try {
      for await (const batches of merged) {
        count += batches.length;
      }
      console.log('ERROR: Should have aborted!');
    } catch (e) {
      console.log('Merge aborted after', count, 'chunks:', (e as Error).name);
    }
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
