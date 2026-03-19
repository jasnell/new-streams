"use strict";
/**
 * New Streams API - Type Definitions
 *
 * This file defines all types for the new streams API based on iterables
 * with explicit backpressure handling.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.drainableProtocol = exports.shareSyncProtocol = exports.shareProtocol = exports.broadcastProtocol = exports.toAsyncStreamable = exports.toStreamable = void 0;
// =============================================================================
// §1 Protocol Symbols
// These symbols allow objects to participate in streaming.
// Using Symbol.for() allows third-party code to implement protocols without
// importing these symbols directly - they can use Symbol.for('Stream.xyz').
// =============================================================================
/**
 * Symbol for sync value-to-streamable conversion protocol.
 * Objects implementing this can be written to streams or yielded from generators.
 * Works in both sync and async contexts.
 *
 * Third-party code can implement this as: `[Symbol.for('Stream.toStreamable')]() { ... }`
 */
exports.toStreamable = Symbol.for('Stream.toStreamable');
/**
 * Symbol for async value-to-streamable conversion protocol.
 * Objects implementing this can be written to async streams.
 * Works in async contexts only.
 *
 * Third-party code can implement this as: `[Symbol.for('Stream.toAsyncStreamable')]() { ... }`
 */
exports.toAsyncStreamable = Symbol.for('Stream.toAsyncStreamable');
/**
 * Symbol for Broadcastable protocol - object can provide a Broadcast.
 *
 * Third-party code can implement this as: `[Symbol.for('Stream.broadcastProtocol')]() { ... }`
 */
exports.broadcastProtocol = Symbol.for('Stream.broadcastProtocol');
/**
 * Symbol for Shareable protocol - object can provide a Share.
 *
 * Third-party code can implement this as: `[Symbol.for('Stream.shareProtocol')]() { ... }`
 */
exports.shareProtocol = Symbol.for('Stream.shareProtocol');
/**
 * Symbol for SyncShareable protocol - object can provide a SyncShare.
 *
 * Third-party code can implement this as: `[Symbol.for('Stream.shareSyncProtocol')]() { ... }`
 */
exports.shareSyncProtocol = Symbol.for('Stream.shareSyncProtocol');
/**
 * Symbol for Drainable protocol - object can signal when backpressure clears.
 * Used to bridge event-driven sources that need drain notification.
 *
 * Third-party code can implement this as: `[Symbol.for('Stream.drainableProtocol')]() { ... }`
 */
exports.drainableProtocol = Symbol.for('Stream.drainableProtocol');
