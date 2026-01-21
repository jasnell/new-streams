/**
 * Types for the new Streams API
 */

// Buffer source types that can be written to streams
export type BufferSource = ArrayBuffer | ArrayBufferView;

// Data that can be written (auto-converted to Uint8Array)
export type StreamWriteData = BufferSource | string;

// Overflow policies for buffer management
export type StreamOverflowPolicy = 'error' | 'block' | 'drop-oldest' | 'drop-newest';

// Buffer configuration options
export interface StreamBufferOptions {
  /** Soft limit: backpressure threshold */
  max?: number;
  /** Hard limit: for 'block' policy, error at this point */
  hardMax?: number;
  /** Policy when buffer exceeds max */
  onOverflow?: StreamOverflowPolicy;
}

// Options for Stream.pull()
export interface StreamPullOptions {
  /** Default encoding for strings yielded by the generator (default: "utf-8") */
  encoding?: string;
}

// Options for Stream.push()
export interface StreamPushOptions {
  /** Default encoding for strings written to the Writer (default: "utf-8") */
  encoding?: string;
  /** Buffer configuration */
  buffer?: StreamBufferOptions;
}

// Options for Stream.from()
export interface StreamFromOptions {
  /** Encoding for string sources (default: "utf-8") */
  encoding?: string;
}

// Options for Stream.transform()
export interface StreamTransformOptions {
  /** Default encoding for strings (default: "utf-8") */
  encoding?: string;
  /** Fixed chunk size for transform input (except final chunk) */
  chunkSize?: number;
  /** Buffer configuration for transform output */
  buffer?: StreamBufferOptions;
}

// Options for pipeThrough()
export interface StreamPipeOptions {
  signal?: AbortSignal;
  chunkSize?: number;
  buffer?: StreamBufferOptions;
  /** Maximum bytes to pipe through; parent stream continues after limit */
  limit?: number;
}

// Options for pipeTo()
export interface StreamPipeToOptions {
  signal?: AbortSignal;
  /** Maximum bytes to pipe; cancels source after limit reached */
  limit?: number;
  /** If true, destination is NOT closed when source ends normally */
  preventClose?: boolean;
  /** If true, destination is NOT aborted when source errors */
  preventAbort?: boolean;
  /** If true, source is NOT cancelled when destination errors */
  preventCancel?: boolean;
}

// Options for consumption methods
export interface StreamConsumeOptions {
  signal?: AbortSignal;
}

// Options for tee()
export interface StreamTeeOptions {
  buffer?: StreamBufferOptions;
  /** If true, the branch starts detached */
  detached?: boolean;
}

// Options for read()
export interface StreamReadOptions {
  /** BYOB: provide your own buffer */
  buffer?: Uint8Array;
  /** Maximum bytes to return (non-BYOB only) */
  max?: number;
  /** Wait for at least this many bytes before returning */
  atLeast?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

// Result from read()
export interface StreamReadResult {
  /** The bytes read; null only when done=true AND no final bytes available */
  value: Uint8Array | null;
  /** True when stream has ended */
  done: boolean;
}

// Options for writer operations
export interface WriterWriteOptions {
  signal?: AbortSignal;
}

// Sink interface for Stream.writer()
export interface WriterSink {
  write(chunk: Uint8Array): Promise<void>;
  close?(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

// Transform callback signature
export type StreamTransformCallback = (chunk: Uint8Array | null) => StreamTransformResult;

// Transform result can be various types
export type StreamTransformResult =
  | Uint8Array
  | string
  | null
  | undefined
  | Iterable<StreamWriteData>
  | AsyncIterable<StreamWriteData>
  | Promise<Uint8Array | string | null | undefined | Iterable<StreamWriteData>>
  | Generator<StreamWriteData, void, unknown>
  | AsyncGenerator<StreamWriteData, void, unknown>;

// Transformer object interface
export interface StreamTransformerObject {
  transform(chunk: Uint8Array | null): StreamTransformResult;
  abort?(reason?: unknown): void;
}

// Union type for transformers
export type StreamTransformer = StreamTransformCallback | StreamTransformerObject;

// Pull source yield type - can yield data or nested streams/generators
export type StreamPullYieldType = StreamWriteData | { [Symbol.iterator](): Iterator<unknown> } | { [Symbol.asyncIterator](): AsyncIterator<unknown> };

// Pull source - sync or async generator (loosely typed to allow nested yields)
export type StreamPullSource = () =>
  | Generator<unknown, void, unknown>
  | AsyncGenerator<unknown, void, unknown>;

// Options for pipeline
export interface StreamPipelineOptions {
  signal?: AbortSignal;
  limit?: number;
  preventClose?: boolean;
}

// Internal cursor for buffer management
export interface Cursor {
  id: number;
  position: number;
  limit?: number;
  isActive: boolean;
}
