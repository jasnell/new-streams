/**
 * Run All Benchmarks
 *
 * Executes all benchmark suites and produces a summary report.
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runBenchmark(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', file], {
      cwd: join(__dirname, '..'),
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Benchmark ${file} failed with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║           NEW STREAM API vs WEB STREAMS BENCHMARKS               ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log();

  const files = await readdir(__dirname);
  const benchmarkFiles = files
    .filter((f) => f.match(/^\d+-.*\.ts$/) && f !== 'run-all.ts')
    .sort();

  console.log(`Found ${benchmarkFiles.length} benchmark suites:\n`);
  for (const file of benchmarkFiles) {
    console.log(`  - ${file}`);
  }
  console.log();

  for (const file of benchmarkFiles) {
    console.log('\n' + '─'.repeat(70));
    console.log(`Running: ${file}`);
    console.log('─'.repeat(70) + '\n');

    try {
      await runBenchmark(join(__dirname, file));
    } catch (error) {
      console.error(`Error running ${file}:`, error);
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log('ALL BENCHMARKS COMPLETE');
  console.log('═'.repeat(70) + '\n');
}

main().catch(console.error);
