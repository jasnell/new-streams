/**
 * Benchmark utilities with statistical analysis
 */

export interface BenchmarkResult {
  name: string;
  samples: number[];
  iterations: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  median: number;
  p95: number;
  bytesPerSec?: number;
  bytesPerSecStdDev?: number;
  totalBytes?: number;
}

export interface BenchmarkComparison {
  scenario: string;
  newStream: BenchmarkResult;
  webStream: BenchmarkResult;
  speedup: number;
  speedupConfidence: string; // e.g., "significant" or "within noise"
  label1?: string; // Column header for first result (default: "New Stream")
  label2?: string; // Column header for second result (default: "Web Stream")
}

export interface ThreeWayComparison {
  scenario: string;
  newStream: BenchmarkResult;
  webStream: BenchmarkResult;
  nodeStream: BenchmarkResult;
  newVsWeb: { speedup: number; confidence: string };
  newVsNode: { speedup: number; confidence: string };
}

export interface FourWayComparison {
  scenario: string;
  newStream: BenchmarkResult;
  fastWebStream: BenchmarkResult;
  webStream: BenchmarkResult;
  nodeStream: BenchmarkResult;
  newVsFastWeb: { speedup: number; confidence: string };
  newVsWeb: { speedup: number; confidence: string };
  newVsNode: { speedup: number; confidence: string };
}

/**
 * Calculate mean of an array
 */
function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Calculate standard deviation
 */
function stdDev(arr: number[], avg?: number): number {
  const m = avg ?? mean(arr);
  const squareDiffs = arr.map((value) => Math.pow(value - m, 2));
  return Math.sqrt(mean(squareDiffs));
}

/**
 * Calculate percentile
 */
function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Run a benchmark function multiple times and return statistics
 */
export async function benchmark(
  name: string,
  fn: () => Promise<number | void>,
  options: {
    warmupIterations?: number;
    iterations?: number;
    minSamples?: number;
    minTimeMs?: number;
    totalBytes?: number;
  } = {}
): Promise<BenchmarkResult> {
  const {
    warmupIterations = 5,
    iterations = 1, // ops per sample
    minSamples = 20, // minimum number of samples to collect
    minTimeMs = 2000, // minimum time to run (ms)
    totalBytes,
  } = options;

  // Warmup phase
  for (let i = 0; i < warmupIterations; i++) {
    await fn();
  }

  // Force GC if available
  if (global.gc) {
    global.gc();
  }

  // Collect samples
  const samples: number[] = [];
  const startTime = performance.now();

  while (samples.length < minSamples || performance.now() - startTime < minTimeMs) {
    const sampleStart = performance.now();

    for (let i = 0; i < iterations; i++) {
      await fn();
    }

    const sampleTime = performance.now() - sampleStart;
    samples.push(sampleTime / iterations); // time per operation

    // Safety limit
    if (samples.length >= 100) break;
  }

  // Calculate statistics
  const avgTime = mean(samples);
  const stdDevTime = stdDev(samples, avgTime);
  const minTime = Math.min(...samples);
  const maxTime = Math.max(...samples);
  const medianTime = percentile(samples, 50);
  const p95Time = percentile(samples, 95);

  // Calculate throughput if totalBytes provided
  let bytesPerSec: number | undefined;
  let bytesPerSecStdDev: number | undefined;
  if (totalBytes) {
    bytesPerSec = (totalBytes / avgTime) * 1000;
    bytesPerSecStdDev = (totalBytes / (avgTime - stdDevTime)) * 1000 - bytesPerSec;
  }

  return {
    name,
    samples,
    iterations: samples.length,
    mean: avgTime,
    stdDev: stdDevTime,
    min: minTime,
    max: maxTime,
    median: medianTime,
    p95: p95Time,
    bytesPerSec,
    bytesPerSecStdDev: bytesPerSecStdDev ? Math.abs(bytesPerSecStdDev) : undefined,
    totalBytes,
  };
}

/**
 * Format bytes per second as human readable
 */
export function formatBytesPerSec(bytesPerSec: number): string {
  if (bytesPerSec >= 1e9) {
    return `${(bytesPerSec / 1e9).toFixed(2)} GB/s`;
  } else if (bytesPerSec >= 1e6) {
    return `${(bytesPerSec / 1e6).toFixed(2)} MB/s`;
  } else if (bytesPerSec >= 1e3) {
    return `${(bytesPerSec / 1e3).toFixed(2)} KB/s`;
  }
  return `${bytesPerSec.toFixed(2)} B/s`;
}

/**
 * Format time in ms
 */
export function formatTime(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  } else if (ms >= 1) {
    return `${ms.toFixed(2)}ms`;
  } else {
    return `${(ms * 1000).toFixed(2)}µs`;
  }
}

/**
 * Format number with commas
 */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/**
 * Determine if speedup is statistically significant
 * Uses coefficient of variation to assess noise level
 */
function assessSignificance(
  result1: BenchmarkResult,
  result2: BenchmarkResult,
  speedup: number
): string {
  const cv1 = result1.stdDev / result1.mean;
  const cv2 = result2.stdDev / result2.mean;
  const combinedCV = Math.sqrt(cv1 * cv1 + cv2 * cv2);

  // If the speedup is within 2x the combined coefficient of variation,
  // it's likely within noise
  const threshold = 1 + 2 * combinedCV;

  if (speedup > threshold || speedup < 1 / threshold) {
    return 'significant';
  }
  return 'within noise';
}

/**
 * Print detailed benchmark result
 */
export function printResult(result: BenchmarkResult): void {
  console.log(`  ${result.name}:`);
  console.log(`    Samples: ${result.iterations}`);
  console.log(`    Mean: ${formatTime(result.mean)} (±${formatTime(result.stdDev)})`);
  console.log(`    Min: ${formatTime(result.min)}, Max: ${formatTime(result.max)}`);
  console.log(`    Median: ${formatTime(result.median)}, P95: ${formatTime(result.p95)}`);
  if (result.bytesPerSec) {
    console.log(`    Throughput: ${formatBytesPerSec(result.bytesPerSec)}`);
  }
}

/**
 * Print benchmark comparison table
 */
/**
 * Print a single comparison table with the given column headers and rows.
 */
function printComparisonTable(
  label1: string,
  label2: string,
  rows: BenchmarkComparison[]
): void {
  const headers = ['Scenario', label1, label2, 'Difference', 'Significance'];
  const colWidths = [32, 22, 22, 18, 14];

  // Print header
  console.log(headers.map((h, i) => h.padEnd(colWidths[i])).join(' | '));
  console.log(colWidths.map((w) => '-'.repeat(w)).join('-+-'));

  // Print rows
  for (const c of rows) {
    const str1 = c.newStream.bytesPerSec
      ? formatBytesPerSec(c.newStream.bytesPerSec)
      : `${formatTime(c.newStream.mean)}`;

    const str2 = c.webStream.bytesPerSec
      ? formatBytesPerSec(c.webStream.bytesPerSec)
      : `${formatTime(c.webStream.mean)}`;

    const speedupStr =
      c.speedup >= 1
        ? `${c.speedup.toFixed(2)}x faster`
        : `${(1 / c.speedup).toFixed(2)}x slower`;

    const row = [
      c.scenario.substring(0, colWidths[0] - 1),
      str1,
      str2,
      speedupStr,
      c.speedupConfidence,
    ];

    console.log(row.map((v, i) => v.padEnd(colWidths[i])).join(' | '));
  }
}

export function printComparison(comparisons: BenchmarkComparison[]): void {
  // Group comparisons by their label pair
  const groups = new Map<string, BenchmarkComparison[]>();
  for (const c of comparisons) {
    const key = `${c.label1 ?? 'New Stream'}\0${c.label2 ?? 'Web Stream'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  for (const [key, rows] of groups) {
    const [label1, label2] = key.split('\0');

    console.log('\n' + '='.repeat(110));
    console.log(`BENCHMARK RESULTS: ${label1} vs ${label2} (higher throughput = better)`);
    console.log('='.repeat(110));

    printComparisonTable(label1, label2, rows);

    console.log('='.repeat(110));

    // Print summary statistics for this group
    const validComparisons = rows.filter((c) => c.speedupConfidence === 'significant');
    const fasterCount = validComparisons.filter((c) => c.speedup >= 1).length;
    const slowerCount = validComparisons.filter((c) => c.speedup < 1).length;
    const withinNoiseCount = rows.length - validComparisons.length;

    console.log(`\nSummary: ${fasterCount} ${label1} faster, ${slowerCount} slower, ${withinNoiseCount} within noise`);
    console.log(`Samples per benchmark: ${rows[0]?.newStream.iterations || 'N/A'}`);
  }
}

/**
 * Create a comparison object.
 * Optional labels override the default "New Stream" / "Web Stream" column headers.
 */
export function createComparison(
  scenario: string,
  newStream: BenchmarkResult,
  webStream: BenchmarkResult,
  labels?: { label1: string; label2: string }
): BenchmarkComparison {
  const speedup = newStream.bytesPerSec && webStream.bytesPerSec
    ? newStream.bytesPerSec / webStream.bytesPerSec
    : webStream.mean / newStream.mean; // Lower time = faster

  return {
    scenario,
    newStream,
    webStream,
    speedup,
    speedupConfidence: assessSignificance(newStream, webStream, speedup),
    label1: labels?.label1,
    label2: labels?.label2,
  };
}

/**
 * Create a three-way comparison object
 */
export function createThreeWayComparison(
  scenario: string,
  newStream: BenchmarkResult,
  webStream: BenchmarkResult,
  nodeStream: BenchmarkResult
): ThreeWayComparison {
  const newVsWebSpeedup = newStream.bytesPerSec && webStream.bytesPerSec
    ? newStream.bytesPerSec / webStream.bytesPerSec
    : webStream.mean / newStream.mean;

  const newVsNodeSpeedup = newStream.bytesPerSec && nodeStream.bytesPerSec
    ? newStream.bytesPerSec / nodeStream.bytesPerSec
    : nodeStream.mean / newStream.mean;

  return {
    scenario,
    newStream,
    webStream,
    nodeStream,
    newVsWeb: {
      speedup: newVsWebSpeedup,
      confidence: assessSignificance(newStream, webStream, newVsWebSpeedup),
    },
    newVsNode: {
      speedup: newVsNodeSpeedup,
      confidence: assessSignificance(newStream, nodeStream, newVsNodeSpeedup),
    },
  };
}

/**
 * Create a four-way comparison object
 */
export function createFourWayComparison(
  scenario: string,
  newStream: BenchmarkResult,
  fastWebStream: BenchmarkResult,
  webStream: BenchmarkResult,
  nodeStream: BenchmarkResult
): FourWayComparison {
  const computeSpeedup = (a: BenchmarkResult, b: BenchmarkResult) =>
    a.bytesPerSec && b.bytesPerSec
      ? a.bytesPerSec / b.bytesPerSec
      : b.mean / a.mean;

  const newVsFastWebSpeedup = computeSpeedup(newStream, fastWebStream);
  const newVsWebSpeedup = computeSpeedup(newStream, webStream);
  const newVsNodeSpeedup = computeSpeedup(newStream, nodeStream);

  return {
    scenario,
    newStream,
    fastWebStream,
    webStream,
    nodeStream,
    newVsFastWeb: {
      speedup: newVsFastWebSpeedup,
      confidence: assessSignificance(newStream, fastWebStream, newVsFastWebSpeedup),
    },
    newVsWeb: {
      speedup: newVsWebSpeedup,
      confidence: assessSignificance(newStream, webStream, newVsWebSpeedup),
    },
    newVsNode: {
      speedup: newVsNodeSpeedup,
      confidence: assessSignificance(newStream, nodeStream, newVsNodeSpeedup),
    },
  };
}

/**
 * Print four-way benchmark comparison table
 */
export function printFourWayComparison(comparisons: FourWayComparison[]): void {
  console.log('\n' + '='.repeat(160));
  console.log('BENCHMARK RESULTS (higher throughput = better)');
  console.log('='.repeat(160));

  const headers = ['Scenario', 'New Stream', 'Fast WS', 'Web Stream', 'Node Stream', 'New/FastWS', 'New/Web', 'New/Node'];
  const colWidths = [30, 15, 15, 15, 15, 16, 16, 16];

  // Print header
  console.log(headers.map((h, i) => h.padEnd(colWidths[i])).join(' | '));
  console.log(colWidths.map((w) => '-'.repeat(w)).join('-+-'));

  const formatSpeedup = (speedup: number, confidence: string) => {
    const speedupStr = speedup >= 1
      ? `${speedup.toFixed(2)}x faster`
      : `${(1 / speedup).toFixed(2)}x slower`;
    return confidence === 'within noise' ? '~same' : speedupStr;
  };

  // Print rows
  for (const c of comparisons) {
    const fmt = (r: BenchmarkResult) =>
      r.bytesPerSec ? formatBytesPerSec(r.bytesPerSec) : formatTime(r.mean);

    const row = [
      c.scenario.substring(0, colWidths[0] - 1),
      fmt(c.newStream),
      fmt(c.fastWebStream),
      fmt(c.webStream),
      fmt(c.nodeStream),
      formatSpeedup(c.newVsFastWeb.speedup, c.newVsFastWeb.confidence),
      formatSpeedup(c.newVsWeb.speedup, c.newVsWeb.confidence),
      formatSpeedup(c.newVsNode.speedup, c.newVsNode.confidence),
    ];

    console.log(row.map((v, i) => v.padEnd(colWidths[i])).join(' | '));
  }

  console.log('='.repeat(160));

  // Print summary statistics
  const count = (field: 'newVsFastWeb' | 'newVsWeb' | 'newVsNode', predicate: (c: FourWayComparison) => boolean) =>
    comparisons.filter((c) => c[field].confidence === 'significant' && predicate(c)).length;

  const fasterFW = count('newVsFastWeb', (c) => c.newVsFastWeb.speedup >= 1);
  const slowerFW = count('newVsFastWeb', (c) => c.newVsFastWeb.speedup < 1);
  const fasterWeb = count('newVsWeb', (c) => c.newVsWeb.speedup >= 1);
  const slowerWeb = count('newVsWeb', (c) => c.newVsWeb.speedup < 1);
  const fasterNode = count('newVsNode', (c) => c.newVsNode.speedup >= 1);
  const slowerNode = count('newVsNode', (c) => c.newVsNode.speedup < 1);

  console.log(`\nNew Stream vs Fast WS:   ${fasterFW} faster, ${slowerFW} slower, ${comparisons.length - fasterFW - slowerFW} within noise`);
  console.log(`New Stream vs Web Stream: ${fasterWeb} faster, ${slowerWeb} slower, ${comparisons.length - fasterWeb - slowerWeb} within noise`);
  console.log(`New Stream vs Node Stream: ${fasterNode} faster, ${slowerNode} slower, ${comparisons.length - fasterNode - slowerNode} within noise`);
  console.log(`Samples per benchmark: ${comparisons[0]?.newStream.iterations || 'N/A'}`);
}

/**
 * Print three-way benchmark comparison table
 */
export function printThreeWayComparison(comparisons: ThreeWayComparison[]): void {
  console.log('\n' + '='.repeat(130));
  console.log('BENCHMARK RESULTS (higher throughput = better)');
  console.log('='.repeat(130));

  const headers = ['Scenario', 'New Stream', 'Web Stream', 'Node Stream', 'New vs Web', 'New vs Node'];
  const colWidths = [32, 18, 18, 18, 20, 20];

  // Print header
  console.log(headers.map((h, i) => h.padEnd(colWidths[i])).join(' | '));
  console.log(colWidths.map((w) => '-'.repeat(w)).join('-+-'));

  // Print rows
  for (const c of comparisons) {
    const newStreamStr = c.newStream.bytesPerSec
      ? formatBytesPerSec(c.newStream.bytesPerSec)
      : `${formatTime(c.newStream.mean)}`;

    const webStreamStr = c.webStream.bytesPerSec
      ? formatBytesPerSec(c.webStream.bytesPerSec)
      : `${formatTime(c.webStream.mean)}`;

    const nodeStreamStr = c.nodeStream.bytesPerSec
      ? formatBytesPerSec(c.nodeStream.bytesPerSec)
      : `${formatTime(c.nodeStream.mean)}`;

    const formatSpeedup = (speedup: number, confidence: string) => {
      const speedupStr = speedup >= 1
        ? `${speedup.toFixed(2)}x faster`
        : `${(1 / speedup).toFixed(2)}x slower`;
      return confidence === 'within noise' ? '~same' : speedupStr;
    };

    const row = [
      c.scenario.substring(0, colWidths[0] - 1),
      newStreamStr,
      webStreamStr,
      nodeStreamStr,
      formatSpeedup(c.newVsWeb.speedup, c.newVsWeb.confidence),
      formatSpeedup(c.newVsNode.speedup, c.newVsNode.confidence),
    ];

    console.log(row.map((v, i) => v.padEnd(colWidths[i])).join(' | '));
  }

  console.log('='.repeat(130));

  // Print summary statistics
  const fasterThanWeb = comparisons.filter((c) => c.newVsWeb.confidence === 'significant' && c.newVsWeb.speedup >= 1).length;
  const slowerThanWeb = comparisons.filter((c) => c.newVsWeb.confidence === 'significant' && c.newVsWeb.speedup < 1).length;
  const fasterThanNode = comparisons.filter((c) => c.newVsNode.confidence === 'significant' && c.newVsNode.speedup >= 1).length;
  const slowerThanNode = comparisons.filter((c) => c.newVsNode.confidence === 'significant' && c.newVsNode.speedup < 1).length;

  console.log(`\nNew Stream vs Web Stream: ${fasterThanWeb} faster, ${slowerThanWeb} slower, ${comparisons.length - fasterThanWeb - slowerThanWeb} within noise`);
  console.log(`New Stream vs Node Stream: ${fasterThanNode} faster, ${slowerThanNode} slower, ${comparisons.length - fasterThanNode - slowerThanNode} within noise`);
  console.log(`Samples per benchmark: ${comparisons[0]?.newStream.iterations || 'N/A'}`);
}

/**
 * Generate random data of specified size
 */
export function generateData(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    data[i] = Math.floor(Math.random() * 256);
  }
  return data;
}

/**
 * Generate chunks of specified sizes
 */
export function generateChunks(chunkSize: number, count: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push(generateData(chunkSize));
  }
  return chunks;
}
