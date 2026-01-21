/**
 * New Streams API - A redesigned streams API for the web platform
 * 
 * This is a bytes-only stream API that provides:
 * - Simpler semantics than Web Streams
 * - Async iteration as the primary interface
 * - Unified buffer/cursor model for efficient branching
 * - Built-in combinators (take, drop, limit, tee, merge, concat)
 * - Natural backpressure handling
 */

export { Stream, StreamWithWriter } from './stream.js';
export { Writer } from './writer.js';
export { UnifiedBuffer } from './buffer.js';

// Re-export types
export type {
  // Buffer and write types
  BufferSource,
  StreamWriteData,
  StreamOverflowPolicy,
  StreamBufferOptions,
  
  // Options types
  StreamPullOptions,
  StreamPushOptions,
  StreamFromOptions,
  StreamTransformOptions,
  StreamPipeOptions,
  StreamPipeToOptions,
  StreamConsumeOptions,
  StreamTeeOptions,
  StreamReadOptions,
  StreamPipelineOptions,
  WriterWriteOptions,
  
  // Result types
  StreamReadResult,
  
  // Transformer types
  StreamTransformCallback,
  StreamTransformResult,
  StreamTransformerObject,
  StreamTransformer,
  StreamPullSource,
  
  // Sink types
  WriterSink,
  
  // Internal types
  Cursor,
} from './types.js';
