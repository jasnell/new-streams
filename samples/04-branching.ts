/**
 * Stream Branching
 * 
 * This file demonstrates tee() for creating branches and detached branches.
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // tee() - Create a branch that sees the same data
  // ============================================================================
  section('tee() - Basic branching');

  // Create a branch
  {
    const [stream, writer] = Stream.push();
    
    // Create a branch - both will see the same data
    const branch = stream.tee();
    
    // Write data
    (async () => {
      await writer.write('shared data');
      await writer.close();
    })();
    
    // Both streams see the same content
    const [mainResult, branchResult] = await Promise.all([
      stream.text(),
      branch.text()
    ]);
    
    console.log('Main stream:', mainResult);
    console.log('Branch:', branchResult);
  }

  // Multiple branches
  {
    const [stream, writer] = Stream.push();
    
    const branch1 = stream.tee();
    const branch2 = stream.tee();
    const branch3 = stream.tee();
    
    (async () => {
      await writer.write('multi-branch');
      await writer.close();
    })();
    
    const results = await Promise.all([
      stream.text(),
      branch1.text(),
      branch2.text(),
      branch3.text()
    ]);
    
    console.log('\nMultiple branches all see same data:');
    results.forEach((r, i) => console.log(`  ${i === 0 ? 'Main' : `Branch ${i}`}: ${r}`));
  }

  // ============================================================================
  // Branch independence - cancelling one doesn't affect others
  // ============================================================================
  section('Branch independence');

  {
    const [stream, writer] = Stream.push();
    
    const branch1 = stream.tee();
    const branch2 = stream.tee();
    
    // Cancel branch1
    await branch1.cancel();
    
    // Write data
    (async () => {
      await writer.write('still works');
      await writer.close();
    })();
    
    // branch2 and main stream still work
    const [mainResult, branch2Result] = await Promise.all([
      stream.text(),
      branch2.text()
    ]);
    
    console.log('Main stream after branch1 cancelled:', mainResult);
    console.log('Branch2 after branch1 cancelled:', branch2Result);
    
    // Cancelled branch returns empty
    const branch1Result = await branch1.text();
    console.log('Cancelled branch1:', `"${branch1Result}"`, '(empty)');
  }

  // ============================================================================
  // Error propagation to branches
  // ============================================================================
  section('Error propagation');

  {
    const stream = Stream.pull(async function* () {
      yield 'before error';
      throw new Error('Source error!');
    });
    
    const branch = stream.tee();
    
    // Both streams will see the error
    const results = await Promise.allSettled([
      stream.text(),
      branch.text()
    ]);
    
    console.log('Main stream:', results[0].status === 'rejected' 
      ? `rejected: ${(results[0] as PromiseRejectedResult).reason.message}`
      : `fulfilled: ${(results[0] as PromiseFulfilledResult<string>).value}`);
    console.log('Branch:', results[1].status === 'rejected'
      ? `rejected: ${(results[1] as PromiseRejectedResult).reason.message}`
      : `fulfilled: ${(results[1] as PromiseFulfilledResult<string>).value}`);
  }

  // ============================================================================
  // Detached branches - late attachment
  // ============================================================================
  section('Detached branches');

  // Create a detached branch
  {
    const [stream, writer] = Stream.push();
    
    // Create detached branch - won't receive data until attached
    const detached = stream.tee({ detached: true });
    
    console.log('Branch detached property:', detached.detached);
    
    // Write some data before attaching
    await writer.write('before ');
    
    // Attach the branch
    detached.attach();
    console.log('After attach(), detached:', detached.detached);
    
    // Write more data
    await writer.write('after');
    await writer.close();
    
    // Detached branch may miss data written before attachment
    const result = await detached.text();
    console.log('Detached branch result:', result);
    
    // Main stream sees all data
    // (already consumed by writer.close() propagation)
  }

  // Auto-attach on first read
  {
    const [stream, writer] = Stream.push();
    
    const detached = stream.tee({ detached: true });
    console.log('\nBefore auto-attach, detached:', detached.detached);
    
    (async () => {
      await writer.write('auto-attached');
      await writer.close();
    })();
    
    // Reading auto-attaches
    const text = await detached.text();
    console.log('After read, detached:', detached.detached);
    console.log('Auto-attached result:', text);
  }

  // Auto-attach on iteration
  {
    const stream = Stream.from('iteration');
    const detached = stream.tee({ detached: true });
    
    // Iteration auto-attaches
    for await (const chunk of detached) {
      console.log('\nIteration auto-attached, got:', new TextDecoder().decode(chunk));
      break;
    }
    console.log('After iteration, detached:', detached.detached);
  }

  // ============================================================================
  // Practical use cases
  // ============================================================================
  section('Practical use cases');

  // Use case: Logging while processing
  {
    console.log('\n--- Logging while processing ---');
    const stream = Stream.from('process this data');
    
    // Create a branch for logging
    const logBranch = stream.tee();
    
    // Log in background
    (async () => {
      const bytes = await logBranch.bytes();
      console.log(`  [LOG] Processed ${bytes.length} bytes`);
    })();
    
    // Main processing
    const result = await stream.text();
    console.log('  [MAIN] Result:', result);
    
    // Wait for logging to complete
    await new Promise(r => setTimeout(r, 10));
  }

  // Use case: Computing hash while streaming
  {
    console.log('\n--- Hash while streaming ---');
    const stream = Stream.from('data to hash and process');
    
    // Branch for hashing
    const hashBranch = stream.tee();
    
    // Compute "hash" (simplified - just length for demo)
    const hashPromise = (async () => {
      const bytes = await hashBranch.bytes();
      return bytes.length; // Real app would compute actual hash
    })();
    
    // Process main stream
    const text = await stream.text();
    console.log('  Processed:', text);
    
    const hash = await hashPromise;
    console.log('  Hash (length):', hash);
  }

  // Use case: Conditional branching
  {
    console.log('\n--- Conditional branching ---');
    const stream = Stream.from('HEADER:payload data');
    
    // Read header first
    const header = await stream.take(7).text();
    console.log('  Header:', header);
    
    if (header === 'HEADER:') {
      // Branch for processing
      const processBranch = stream.tee();
      const archiveBranch = stream.tee();
      
      // Different processing paths
      const [processed, archived] = await Promise.all([
        processBranch.text().then(t => t.toUpperCase()),
        archiveBranch.text()
      ]);
      
      console.log('  Processed:', processed);
      console.log('  Archived:', archived);
    }
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
