# Stream API Benchmarks

Performance comparison between the new Stream API and the Web Streams API.

## Running Benchmarks

```bash
# Run all benchmarks
npx tsx benchmarks/run-all.ts

# Run a specific benchmark
npx tsx benchmarks/01-throughput.ts
npx tsx benchmarks/02-push-streams.ts
npx tsx benchmarks/03-transforms.ts
npx tsx benchmarks/04-pipelines.ts
npx tsx benchmarks/05-tee-branching.ts
npx tsx benchmarks/06-consumption.ts
npx tsx benchmarks/07-slicing.ts

# Run with garbage collection exposed (more accurate memory measurements)
node --expose-gc --import tsx benchmarks/01-throughput.ts
```

## Benchmark Suites

### 01-throughput.ts
**Raw Throughput** - Measures basic data flow speed through streams.

| Scenario | Description |
|----------|-------------|
| Large chunks (1MB) | Fewer, larger transfers |
| Medium chunks (64KB) | Balanced chunk size |
| Small chunks (1KB) | Many small transfers |
| Tiny chunks (100B) | Maximum overhead scenario |

### 02-push-streams.ts
**Push Stream Performance** - Tests producer/consumer patterns.

| Scenario | Description |
|----------|-------------|
| Sequential push | Writer finishes before reader starts |
| Concurrent push | Interleaved write/read |
| Many small writes | High-frequency small data |
| Batch writes (writev) | Multiple chunks per write call |

### 03-transforms.ts
**Transform Performance** - Data transformation speed.

| Scenario | Description |
|----------|-------------|
| Identity transform | Pass-through (baseline) |
| XOR transform | Byte manipulation |
| Expanding transform | 1:N output (doubling) |
| Chained transforms | Multiple transform stages |
| Async transform | Transforms with async work |

### 04-pipelines.ts
**Pipeline Performance** - Full source → transform → destination flows.

| Scenario | Description |
|----------|-------------|
| Simple pipeline | Direct source to destination |
| Pipeline + transform | Single transform stage |
| Multi-stage pipeline | 3 transform stages |
| Pipeline with limit | Early termination |
| High-frequency | Many small chunks |

### 05-tee-branching.ts
**Tee/Branching Performance** - Stream duplication efficiency.

| Scenario | Description |
|----------|-------------|
| Single tee | 2 concurrent readers |
| Multiple tees | 4 concurrent readers |
| Tee + transforms | Different processing per branch |
| Small chunks tee | High overhead branching |
| Asymmetric tee | Fast + slow consumer |

### 06-consumption.ts
**Consumption Methods** - Different ways to read stream data.

| Scenario | Description |
|----------|-------------|
| bytes() | Collect all data |
| text() | Decode to string |
| Async iteration | for await...of |
| read() loop | Low-level reading |
| Batched reads | read({ atLeast }) |
| Single large read | One big chunk |

### 07-slicing.ts
**Slicing Operations** - take(), drop(), limit() performance.

| Scenario | Description |
|----------|-------------|
| take() | Read first N bytes |
| drop() | Skip first N bytes |
| limit() | Cap stream size |
| drop() + take() | Combined operations |
| Multiple take() | Sequential branching |
| Precise byte take | Non-aligned slicing |

## Interpreting Results

- **Speedup > 1**: New Stream API is faster
- **Speedup < 1**: Web Streams API is faster
- **Throughput (MB/s or GB/s)**: Higher is better
- **ops/s**: Operations per second (higher is better)

## Notes

1. **Fair comparison**: Where the Web Streams API doesn't have equivalent functionality (e.g., `bytes()`, `take()`, `atLeast`), we implement the equivalent manually.

2. **Node.js environment**: These benchmarks run in Node.js. Browser performance may differ.

3. **Warmup**: Each benchmark runs warmup iterations before measuring to allow JIT optimization.

4. **Memory**: Memory measurements are approximate and require `--expose-gc` for accuracy.

## Example Output

```
====================================================================================================
BENCHMARK RESULTS
====================================================================================================
Scenario                            | New Stream                | Web Stream                | Speedup     
------------------------------------+---------------------------+---------------------------+-------------
Large chunks (1MB x 100)            | 2.45 GB/s                 | 1.89 GB/s                 | 1.30x faster
Medium chunks (64KB x 1600)         | 1.82 GB/s                 | 1.45 GB/s                 | 1.26x faster
Small chunks (1KB x 10000)          | 892.34 MB/s               | 567.21 MB/s               | 1.57x faster
Tiny chunks (100B x 10000)          | 234.56 MB/s               | 123.45 MB/s               | 1.90x faster
====================================================================================================
```
