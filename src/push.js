"use strict";
/**
 * Push Stream Implementation
 *
 * Creates a bonded pair of writer and async iterable for push-based streaming
 * with built-in backpressure.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.push = push;
var types_js_1 = require("./types.js");
var utils_js_1 = require("./utils.js");
var pull_js_1 = require("./pull.js");
var ringbuffer_js_1 = require("./ringbuffer.js");
// Cached resolved promise to avoid allocating a new one on every sync fast-path.
var kResolvedPromise = Promise.resolve();
/**
 * Internal queue with chunk-based backpressure.
 *
 * This implements the core buffering logic shared between writer and readable.
 * - Chunk-oriented backpressure: counts write/writev calls, not bytes
 * - Configurable highWaterMark (default: 4)
 * - Four backpressure policies: strict, block, drop-oldest, drop-newest
 *
 * The queue has two parts:
 * - slots: buffer of data ready for consumer (limited by highWaterMark)
 * - pendingWrites: writes waiting to enter slots when buffer is full
 *
 * Backpressure policies control pendingWrites behavior:
 * - strict: pendingWrites limited to highWaterMark (catches ignored backpressure)
 * - block: pendingWrites unbounded (waits indefinitely)
 * - drop-oldest: drops oldest slot to make room (pendingWrites unused)
 * - drop-newest: discards new write (pendingWrites unused)
 */
var PushQueue = /** @class */ (function () {
    function PushQueue(options) {
        if (options === void 0) { options = {}; }
        var _this = this;
        var _a, _b;
        /** Buffered chunks (each slot is from one write/writev call) */
        this.slots = new ringbuffer_js_1.RingBuffer();
        /** Pending writes waiting for buffer space (strict policy only) */
        this.pendingWrites = new ringbuffer_js_1.RingBuffer();
        /** Pending reads waiting for data */
        this.pendingReads = new ringbuffer_js_1.RingBuffer();
        /** Pending drains waiting for backpressure to clear */
        this.pendingDrains = [];
        /** Writer state */
        this.writerState = 'open';
        /** Consumer state */
        this.consumerState = 'active';
        /** Error that closed the stream */
        this.error = null;
        /** Total bytes written */
        this.bytesWritten = 0;
        this.highWaterMark = Math.max(1, (_a = options.highWaterMark) !== null && _a !== void 0 ? _a : 4);
        this.backpressure = (_b = options.backpressure) !== null && _b !== void 0 ? _b : 'strict';
        this.signal = options.signal;
        if (this.signal) {
            if (this.signal.aborted) {
                this.fail(this.signal.reason instanceof Error
                    ? this.signal.reason
                    : new DOMException('Aborted', 'AbortError'));
            }
            else {
                this.abortHandler = function () {
                    _this.fail(_this.signal.reason instanceof Error
                        ? _this.signal.reason
                        : new DOMException('Aborted', 'AbortError'));
                };
                this.signal.addEventListener('abort', this.abortHandler, { once: true });
            }
        }
    }
    Object.defineProperty(PushQueue.prototype, "isOpen", {
        // ===========================================================================
        // Writer Methods
        // ===========================================================================
        get: function () {
            return this.writerState === 'open';
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(PushQueue.prototype, "desiredSize", {
        /**
         * Get slots available before hitting highWaterMark.
         * Returns null if writer is closed/errored or consumer has terminated.
         */
        get: function () {
            if (this.writerState !== 'open' || this.consumerState !== 'active') {
                return null;
            }
            return Math.max(0, this.highWaterMark - this.slots.length);
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Check if a sync write would be accepted (without actually writing).
     * Returns true if writeSync would accept a write, false otherwise.
     */
    PushQueue.prototype.canWriteSync = function () {
        if (this.writerState !== 'open') {
            return false;
        }
        if (this.consumerState !== 'active') {
            return false;
        }
        // For strict and block policies, check if there's space
        // For drop-oldest and drop-newest, writes are always accepted
        if ((this.backpressure === 'strict' || this.backpressure === 'block') && this.slots.length >= this.highWaterMark) {
            return false;
        }
        return true;
    };
    /**
     * Write chunks synchronously if possible.
     * Returns true if write completed, false if buffer is full.
     *
     * Note: Caller should check canWriteSync() first if they want to avoid
     * unnecessary work before calling this method.
     */
    PushQueue.prototype.writeSync = function (chunks) {
        // Check if write is possible
        if (this.writerState !== 'open') {
            return false;
        }
        if (this.consumerState !== 'active') {
            return false;
        }
        // Handle based on backpressure policy when buffer is full
        if (this.slots.length >= this.highWaterMark) {
            switch (this.backpressure) {
                case 'strict':
                    return false; // Can't write synchronously
                case 'block':
                    // Enqueue the data but return false as backpressure signal.
                    // The data IS accepted; false tells the caller to slow down.
                    this.slots.push(chunks);
                    for (var _i = 0, chunks_1 = chunks; _i < chunks_1.length; _i++) {
                        var chunk = chunks_1[_i];
                        this.bytesWritten += chunk.byteLength;
                    }
                    this.resolvePendingReads();
                    return false;
                case 'drop-oldest':
                    // Drop oldest slot to make room
                    if (this.slots.length > 0) {
                        this.slots.shift();
                    }
                    break;
                case 'drop-newest':
                    // Discard this write, but return true (write "succeeded")
                    // Track bytes for accounting
                    for (var _a = 0, chunks_2 = chunks; _a < chunks_2.length; _a++) {
                        var chunk = chunks_2[_a];
                        this.bytesWritten += chunk.byteLength;
                    }
                    return true;
            }
        }
        // Add to buffer
        this.slots.push(chunks);
        for (var _b = 0, chunks_3 = chunks; _b < chunks_3.length; _b++) {
            var chunk = chunks_3[_b];
            this.bytesWritten += chunk.byteLength;
        }
        // Resolve any pending reads
        this.resolvePendingReads();
        return true;
    };
    /**
     * Write chunks asynchronously.
     * - 'strict': Queues if buffer full but rejects if too many pending writes (>= highWaterMark)
     * - 'block': Waits for buffer space (unbounded pending writes)
     * - 'drop-*': Always succeeds (handled by writeSync)
     *
     * If signal is provided, a write blocked on backpressure will reject immediately
     * when the signal fires. The cancelled write is removed from pendingWrites so it
     * does not occupy a slot. The queue itself is NOT put into an error state — this
     * is per-operation cancellation, not terminal failure.
     */
    PushQueue.prototype.writeAsync = function (chunks, signal) {
        return __awaiter(this, void 0, void 0, function () {
            var _a;
            return __generator(this, function (_b) {
                // Check for pre-aborted signal
                if (signal === null || signal === void 0 ? void 0 : signal.aborted) {
                    throw (_a = signal.reason) !== null && _a !== void 0 ? _a : new DOMException('Aborted', 'AbortError');
                }
                // Check if write is possible
                if (this.writerState !== 'open') {
                    throw new TypeError('Writer is closed');
                }
                if (this.consumerState !== 'active') {
                    throw this.consumerState === 'thrown' && this.error
                        ? this.error
                        : new TypeError('Stream closed by consumer');
                }
                // Try sync first
                if (this.writeSync(chunks)) {
                    return [2 /*return*/];
                }
                // Buffer is full - handle based on policy
                switch (this.backpressure) {
                    case 'strict':
                        // In strict mode, highWaterMark limits pendingWrites (the "hose")
                        // If too many writes are already pending, caller is ignoring backpressure
                        if (this.pendingWrites.length >= this.highWaterMark) {
                            throw new RangeError('Backpressure violation: too many pending writes. ' +
                                'Await each write() call to respect backpressure.');
                        }
                        // Otherwise, queue this write and wait for space
                        return [2 /*return*/, this.createPendingWrite(chunks, signal)];
                    case 'block':
                        // Wait for space (unbounded pending writes)
                        return [2 /*return*/, this.createPendingWrite(chunks, signal)];
                    default:
                        // This shouldn't happen - writeSync handles drop-* policies
                        throw new Error('Unexpected: writeSync should have handled non-strict policy');
                }
                return [2 /*return*/];
            });
        });
    };
    /**
     * Create a pending write promise, optionally racing against a signal.
     * If the signal fires, the entry is removed from pendingWrites and the
     * promise rejects. Signal listeners are cleaned up on normal resolution.
     */
    PushQueue.prototype.createPendingWrite = function (chunks, signal) {
        var _this = this;
        return new Promise(function (resolve, reject) {
            var entry = { chunks: chunks, resolve: resolve, reject: reject };
            _this.pendingWrites.push(entry);
            if (!signal)
                return;
            var onAbort = function () {
                var _a;
                // Remove from queue so it doesn't occupy a slot
                var idx = _this.pendingWrites.indexOf(entry);
                if (idx !== -1)
                    _this.pendingWrites.removeAt(idx);
                reject((_a = signal.reason) !== null && _a !== void 0 ? _a : new DOMException('Aborted', 'AbortError'));
            };
            // Wrap resolve/reject to clean up signal listener
            var origResolve = entry.resolve;
            var origReject = entry.reject;
            entry.resolve = function () {
                signal.removeEventListener('abort', onAbort);
                origResolve();
            };
            entry.reject = function (reason) {
                signal.removeEventListener('abort', onAbort);
                origReject(reason);
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    };
    /**
     * Signal end of stream. Returns total bytes written.
     */
    PushQueue.prototype.end = function () {
        if (this.writerState !== 'open') {
            throw new TypeError('Writer is already closed or errored');
        }
        this.writerState = 'closed';
        this.cleanup();
        this.resolvePendingReads();
        this.rejectPendingWrites(new Error('Writer closed'));
        // Resolve pending drains with false - writer closed, no more writes accepted
        this.resolvePendingDrains(false);
        return this.bytesWritten;
    };
    /**
     * Put queue into terminal error state.
     */
    PushQueue.prototype.fail = function (reason) {
        if (this.writerState === 'errored' || this.writerState === 'closed') {
            return;
        }
        this.writerState = 'errored';
        this.error = reason !== null && reason !== void 0 ? reason : new Error('Failed');
        this.cleanup();
        this.rejectPendingReads(this.error);
        this.rejectPendingWrites(this.error);
        // Reject pending drains with the error
        this.rejectPendingDrains(this.error);
    };
    Object.defineProperty(PushQueue.prototype, "totalBytesWritten", {
        /**
         * Get total bytes written.
         */
        get: function () {
            return this.bytesWritten;
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Wait for backpressure to clear (desiredSize > 0).
     * Returns a Promise that:
     * - Resolves with `true` when buffer has space
     * - Resolves with `false` if writer closes while waiting
     * - Rejects if writer fails while waiting
     */
    PushQueue.prototype.waitForDrain = function () {
        var _this = this;
        return new Promise(function (resolve, reject) {
            _this.pendingDrains.push({ resolve: resolve, reject: reject });
        });
    };
    // ===========================================================================
    // Consumer Methods
    // ===========================================================================
    /**
     * Read next batch of chunks.
     */
    PushQueue.prototype.read = function () {
        return __awaiter(this, void 0, void 0, function () {
            var result;
            var _this = this;
            return __generator(this, function (_a) {
                // If there's data in the buffer, return it immediately
                if (this.slots.length > 0) {
                    result = this.drain();
                    this.resolvePendingWrites();
                    return [2 /*return*/, { value: result, done: false }];
                }
                // If writer is done and buffer is empty, we're done
                if (this.writerState === 'closed') {
                    return [2 /*return*/, { value: undefined, done: true }];
                }
                // If errored, throw
                if (this.writerState === 'errored' && this.error) {
                    throw this.error;
                }
                // Wait for data
                return [2 /*return*/, new Promise(function (resolve, reject) {
                        _this.pendingReads.push({ resolve: resolve, reject: reject });
                    })];
            });
        });
    };
    /**
     * Consumer returned early (break from iteration).
     */
    PushQueue.prototype.consumerReturn = function () {
        if (this.consumerState !== 'active') {
            return;
        }
        this.consumerState = 'returned';
        this.cleanup();
        this.rejectPendingWrites(new Error('Stream closed by consumer'));
        // Resolve pending drains with false — no more data will be consumed
        this.resolvePendingDrains(false);
    };
    /**
     * Consumer threw an error.
     */
    PushQueue.prototype.consumerThrow = function (error) {
        if (this.consumerState !== 'active') {
            return;
        }
        this.consumerState = 'thrown';
        this.error = error;
        this.cleanup();
        this.rejectPendingWrites(error);
        // Reject pending drains — the consumer errored
        this.rejectPendingDrains(error);
    };
    // ===========================================================================
    // Private Methods
    // ===========================================================================
    /**
     * Drain all buffered chunks into a single flat array.
     */
    PushQueue.prototype.drain = function () {
        var result = [];
        while (this.slots.length > 0) {
            result.push.apply(result, this.slots.shift());
        }
        return result;
    };
    /**
     * Resolve pending reads if data is available.
     */
    PushQueue.prototype.resolvePendingReads = function () {
        // Resolve with available data or completion
        while (this.pendingReads.length > 0) {
            if (this.slots.length > 0) {
                var pending = this.pendingReads.shift();
                var result = this.drain();
                this.resolvePendingWrites();
                pending.resolve({ value: result, done: false });
            }
            else if (this.writerState === 'closed') {
                var pending = this.pendingReads.shift();
                pending.resolve({ value: undefined, done: true });
            }
            else if (this.writerState === 'errored' && this.error) {
                var pending = this.pendingReads.shift();
                pending.reject(this.error);
            }
            else {
                // No data and not done - stop resolving
                break;
            }
        }
    };
    /**
     * Resolve pending writes if buffer has space.
     * Also resolves pending drains when buffer has space.
     */
    PushQueue.prototype.resolvePendingWrites = function () {
        while (this.pendingWrites.length > 0 && this.slots.length < this.highWaterMark) {
            var pending = this.pendingWrites.shift();
            this.slots.push(pending.chunks);
            for (var _i = 0, _a = pending.chunks; _i < _a.length; _i++) {
                var chunk = _a[_i];
                this.bytesWritten += chunk.byteLength;
            }
            pending.resolve();
        }
        // Resolve pending drains if buffer has space
        if (this.slots.length < this.highWaterMark) {
            this.resolvePendingDrains(true);
        }
    };
    /**
     * Resolve all pending drains with a value.
     */
    PushQueue.prototype.resolvePendingDrains = function (canWrite) {
        var drains = this.pendingDrains;
        this.pendingDrains = [];
        for (var _i = 0, drains_1 = drains; _i < drains_1.length; _i++) {
            var pending = drains_1[_i];
            pending.resolve(canWrite);
        }
    };
    /**
     * Reject all pending drains with an error.
     */
    PushQueue.prototype.rejectPendingDrains = function (error) {
        var drains = this.pendingDrains;
        this.pendingDrains = [];
        for (var _i = 0, drains_2 = drains; _i < drains_2.length; _i++) {
            var pending = drains_2[_i];
            pending.reject(error);
        }
    };
    /**
     * Reject all pending reads with an error.
     */
    PushQueue.prototype.rejectPendingReads = function (error) {
        while (this.pendingReads.length > 0) {
            this.pendingReads.shift().reject(error);
        }
    };
    /**
     * Reject all pending writes with an error.
     */
    PushQueue.prototype.rejectPendingWrites = function (error) {
        while (this.pendingWrites.length > 0) {
            this.pendingWrites.shift().reject(error);
        }
    };
    /**
     * Clean up resources.
     */
    PushQueue.prototype.cleanup = function () {
        if (this.signal && this.abortHandler) {
            this.signal.removeEventListener('abort', this.abortHandler);
            this.abortHandler = undefined;
        }
    };
    return PushQueue;
}());
// =============================================================================
// PushWriter Implementation
// =============================================================================
/**
 * Writer implementation for push streams.
 * Implements Drainable protocol for event source integration.
 */
var PushWriter = /** @class */ (function () {
    function PushWriter(queue) {
        this.queue = queue;
    }
    /**
     * Drainable protocol implementation.
     *
     * @returns null if desiredSize is null (writer closed/errored)
     * @returns Promise<true> immediately if desiredSize > 0
     * @returns Promise<true> when backpressure clears
     * @returns Promise<false> if writer closes while waiting
     * @throws if writer fails while waiting
     */
    PushWriter.prototype[types_js_1.drainableProtocol] = function () {
        var desired = this.desiredSize;
        // If desiredSize is null, drain is not applicable
        if (desired === null) {
            return null;
        }
        // If there's already space, resolve immediately with true
        if (desired > 0) {
            return Promise.resolve(true);
        }
        // Buffer is full, wait for drain
        return this.queue.waitForDrain();
    };
    Object.defineProperty(PushWriter.prototype, "desiredSize", {
        get: function () {
            return this.queue.desiredSize;
        },
        enumerable: false,
        configurable: true
    });
    PushWriter.prototype.write = function (chunk, options) {
        if (!(options === null || options === void 0 ? void 0 : options.signal) && this.queue.canWriteSync()) {
            var bytes_1 = (0, utils_js_1.toUint8Array)(chunk);
            this.queue.writeSync([bytes_1]);
            return kResolvedPromise;
        }
        var bytes = (0, utils_js_1.toUint8Array)(chunk);
        return this.queue.writeAsync([bytes], options === null || options === void 0 ? void 0 : options.signal);
    };
    PushWriter.prototype.writev = function (chunks, options) {
        if (!(options === null || options === void 0 ? void 0 : options.signal) && this.queue.canWriteSync()) {
            var bytes_2 = (0, utils_js_1.allUint8Array)(chunks) ? chunks.slice() : chunks.map(function (c) { return (0, utils_js_1.toUint8Array)(c); });
            this.queue.writeSync(bytes_2);
            return kResolvedPromise;
        }
        var bytes = (0, utils_js_1.allUint8Array)(chunks) ? chunks.slice() : chunks.map(function (c) { return (0, utils_js_1.toUint8Array)(c); });
        return this.queue.writeAsync(bytes, options === null || options === void 0 ? void 0 : options.signal);
    };
    PushWriter.prototype.writeSync = function (chunk) {
        // Check if write would be accepted before converting
        if (!this.queue.canWriteSync()) {
            return false;
        }
        var bytes = (0, utils_js_1.toUint8Array)(chunk);
        return this.queue.writeSync([bytes]);
    };
    PushWriter.prototype.writevSync = function (chunks) {
        // Check if write would be accepted before converting
        if (!this.queue.canWriteSync()) {
            return false;
        }
        var bytes = (0, utils_js_1.allUint8Array)(chunks) ? chunks.slice() : chunks.map(function (c) { return (0, utils_js_1.toUint8Array)(c); });
        return this.queue.writeSync(bytes);
    };
    PushWriter.prototype.end = function (_options) {
        // end() on PushQueue throws TypeError if already closed/errored.
        try {
            return Promise.resolve(this.queue.end());
        }
        catch (e) {
            return Promise.reject(e);
        }
    };
    PushWriter.prototype.endSync = function () {
        if (!this.queue.isOpen)
            return -1;
        // Also return -1 if the buffer is full (can't end synchronously)
        if (this.queue.desiredSize === 0)
            return -1;
        return this.queue.end();
    };
    PushWriter.prototype.fail = function (reason) {
        this.queue.fail(reason);
        return kResolvedPromise;
    };
    PushWriter.prototype.failSync = function (reason) {
        var wasOpen = this.queue.isOpen;
        this.queue.fail(reason);
        return wasOpen;
    };
    PushWriter.prototype[Symbol.asyncDispose] = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, this.fail()];
            });
        });
    };
    PushWriter.prototype[Symbol.dispose] = function () {
        this.failSync();
    };
    return PushWriter;
}());
// =============================================================================
// Readable Implementation
// =============================================================================
/**
 * Create the readable async iterable from a queue.
 */
function createReadable(queue) {
    var _a;
    return _a = {},
        _a[Symbol.asyncIterator] = function () {
            return {
                next: function () {
                    return __awaiter(this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            return [2 /*return*/, queue.read()];
                        });
                    });
                },
                return: function () {
                    return __awaiter(this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            queue.consumerReturn();
                            return [2 /*return*/, { value: undefined, done: true }];
                        });
                    });
                },
                throw: function (error) {
                    return __awaiter(this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            queue.consumerThrow(error);
                            return [2 /*return*/, { value: undefined, done: true }];
                        });
                    });
                },
            };
        },
        _a;
}
// =============================================================================
// Stream.push() Factory
// =============================================================================
/**
 * Detect if the last argument is options (object without 'transform' property).
 */
function isOptions(arg) {
    return (typeof arg === 'object' &&
        arg !== null &&
        !('transform' in arg));
}
/**
 * Parse variadic arguments: [...transforms, options?]
 */
function parseArgs(args) {
    if (args.length === 0) {
        return { transforms: [], options: {} };
    }
    var last = args[args.length - 1];
    if (isOptions(last)) {
        return {
            transforms: args.slice(0, -1),
            options: last,
        };
    }
    return {
        transforms: args,
        options: {},
    };
}
/**
 * Create a push stream with optional transforms.
 *
 * @param args - Variadic: transforms, then options (optional)
 * @returns WriterIterablePair with writer and readable
 *
 * @example
 * // Default: strict backpressure (1 pending write at a time)
 * const { writer, readable } = push();
 *
 * @example
 * // With options
 * const { writer, readable } = push({ highWaterMark: 10 });
 *
 * @example
 * // With transforms (applied lazily when consumer pulls)
 * const { writer, readable } = push(compress, encrypt, { highWaterMark: 5 });
 */
function push() {
    var args = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
    }
    var _a = parseArgs(args), transforms = _a.transforms, options = _a.options;
    var queue = new PushQueue(options);
    var writer = new PushWriter(queue);
    var rawReadable = createReadable(queue);
    // Apply transforms lazily if provided
    // Transforms are applied when the consumer pulls from the readable
    var readable;
    if (transforms.length > 0) {
        if (options.signal) {
            readable = pull_js_1.pull.apply(void 0, __spreadArray(__spreadArray([rawReadable], transforms, false), [{ signal: options.signal }], false));
        }
        else {
            readable = pull_js_1.pull.apply(void 0, __spreadArray([rawReadable], transforms, false));
        }
    }
    else {
        readable = rawReadable;
    }
    return { writer: writer, readable: readable };
}
