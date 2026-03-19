"use strict";
/**
 * Share - Pull-model multi-consumer streaming
 *
 * Shares a single source among multiple consumers with explicit buffering.
 * Complements broadcast (push model) with a pull model.
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
exports.SyncShare = exports.Share = void 0;
exports.share = share;
exports.shareSync = shareSync;
var types_js_1 = require("./types.js");
var from_js_1 = require("./from.js");
var pull_js_1 = require("./pull.js");
var utils_js_1 = require("./utils.js");
var ringbuffer_js_1 = require("./ringbuffer.js");
// =============================================================================
// Async Share Implementation
// =============================================================================
var ShareImpl = /** @class */ (function () {
    function ShareImpl(source, options) {
        this.source = source;
        this.options = options;
        this.buffer = new ringbuffer_js_1.RingBuffer();
        this.bufferStart = 0;
        this.consumers = new Set();
        this.sourceIterator = null;
        this.sourceExhausted = false;
        this.sourceError = null;
        this.cancelled = false;
        this.pulling = false;
        this.pullWaiters = [];
        // Initialize source iterator lazily
    }
    Object.defineProperty(ShareImpl.prototype, "consumerCount", {
        get: function () {
            return this.consumers.size;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(ShareImpl.prototype, "bufferSize", {
        get: function () {
            return this.buffer.length;
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Create a new consumer that pulls from the shared source.
     * Optionally apply transforms to the consumer's data.
     */
    ShareImpl.prototype.pull = function () {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        var _a = (0, utils_js_1.parsePullArgs)(args), transforms = _a.transforms, options = _a.options;
        // Create raw consumer
        var rawConsumer = this.createRawConsumer();
        // If transforms provided, wrap with pull() pipeline
        if (transforms.length > 0) {
            if (options) {
                return pull_js_1.pull.apply(void 0, __spreadArray(__spreadArray([rawConsumer], transforms, false), [options], false));
            }
            return pull_js_1.pull.apply(void 0, __spreadArray([rawConsumer], transforms, false));
        }
        return rawConsumer;
    };
    /**
     * Create a raw consumer iterable (internal helper).
     */
    ShareImpl.prototype.createRawConsumer = function () {
        var _a;
        var state = {
            cursor: this.bufferStart, // Start from beginning of available buffer
            resolve: null,
            reject: null,
            detached: false,
        };
        this.consumers.add(state);
        var self = this;
        return _a = {},
            _a[Symbol.asyncIterator] = function () {
                return {
                    next: function () {
                        return __awaiter(this, void 0, void 0, function () {
                            var bufferIndex, chunk, canPull, newBufferIndex, chunk;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        // Check for error first (even if detached, propagate the error)
                                        if (self.sourceError) {
                                            state.detached = true;
                                            self.consumers.delete(state);
                                            throw self.sourceError;
                                        }
                                        if (state.detached) {
                                            return [2 /*return*/, { done: true, value: undefined }];
                                        }
                                        if (self.cancelled) {
                                            state.detached = true;
                                            self.consumers.delete(state);
                                            return [2 /*return*/, { done: true, value: undefined }];
                                        }
                                        bufferIndex = state.cursor - self.bufferStart;
                                        if (bufferIndex < self.buffer.length) {
                                            chunk = self.buffer.get(bufferIndex);
                                            state.cursor++;
                                            self.tryTrimBuffer();
                                            return [2 /*return*/, { done: false, value: chunk }];
                                        }
                                        // Check if source is exhausted
                                        if (self.sourceExhausted) {
                                            state.detached = true;
                                            self.consumers.delete(state);
                                            return [2 /*return*/, { done: true, value: undefined }];
                                        }
                                        return [4 /*yield*/, self.waitForBufferSpace(state)];
                                    case 1:
                                        canPull = _a.sent();
                                        if (!canPull) {
                                            // Cancelled while waiting
                                            state.detached = true;
                                            self.consumers.delete(state);
                                            if (self.sourceError)
                                                throw self.sourceError;
                                            return [2 /*return*/, { done: true, value: undefined }];
                                        }
                                        // Pull from source
                                        return [4 /*yield*/, self.pullFromSource()];
                                    case 2:
                                        // Pull from source
                                        _a.sent();
                                        // Check again
                                        if (self.sourceError) {
                                            state.detached = true;
                                            self.consumers.delete(state);
                                            throw self.sourceError;
                                        }
                                        newBufferIndex = state.cursor - self.bufferStart;
                                        if (newBufferIndex < self.buffer.length) {
                                            chunk = self.buffer.get(newBufferIndex);
                                            state.cursor++;
                                            self.tryTrimBuffer();
                                            return [2 /*return*/, { done: false, value: chunk }];
                                        }
                                        if (self.sourceExhausted) {
                                            state.detached = true;
                                            self.consumers.delete(state);
                                            return [2 /*return*/, { done: true, value: undefined }];
                                        }
                                        // Shouldn't get here
                                        return [2 /*return*/, { done: true, value: undefined }];
                                }
                            });
                        });
                    },
                    return: function () {
                        return __awaiter(this, void 0, void 0, function () {
                            return __generator(this, function (_a) {
                                state.detached = true;
                                state.resolve = null;
                                state.reject = null;
                                self.consumers.delete(state);
                                self.tryTrimBuffer();
                                return [2 /*return*/, { done: true, value: undefined }];
                            });
                        });
                    },
                    throw: function (_error) {
                        return __awaiter(this, void 0, void 0, function () {
                            return __generator(this, function (_a) {
                                state.detached = true;
                                state.resolve = null;
                                state.reject = null;
                                self.consumers.delete(state);
                                self.tryTrimBuffer();
                                return [2 /*return*/, { done: true, value: undefined }];
                            });
                        });
                    },
                };
            },
            _a;
    };
    /**
     * Cancel all consumers and close source.
     */
    ShareImpl.prototype.cancel = function (reason) {
        var _a, _b;
        if (this.cancelled)
            return;
        this.cancelled = true;
        if (reason) {
            this.sourceError = reason;
        }
        // Close source iterator if open
        if ((_a = this.sourceIterator) === null || _a === void 0 ? void 0 : _a.return) {
            this.sourceIterator.return().catch(function () { });
        }
        // Notify all waiting consumers
        for (var _i = 0, _c = this.consumers; _i < _c.length; _i++) {
            var consumer = _c[_i];
            if (consumer.resolve) {
                if (reason) {
                    (_b = consumer.reject) === null || _b === void 0 ? void 0 : _b.call(consumer, reason);
                }
                else {
                    consumer.resolve({ done: true, value: undefined });
                }
                consumer.resolve = null;
                consumer.reject = null;
            }
            consumer.detached = true;
        }
        this.consumers.clear();
        // Wake up any pull waiters
        for (var _d = 0, _e = this.pullWaiters; _d < _e.length; _d++) {
            var waiter = _e[_d];
            waiter();
        }
        this.pullWaiters = [];
    };
    ShareImpl.prototype[Symbol.dispose] = function () {
        this.cancel();
    };
    // ==========================================================================
    // Internal Methods
    // ==========================================================================
    /**
     * Wait for buffer space based on backpressure policy.
     * Returns false if cancelled while waiting, or throws if strict policy.
     */
    ShareImpl.prototype.waitForBufferSpace = function (_state) {
        return __awaiter(this, void 0, void 0, function () {
            var _a, _i, _b, consumer;
            var _this = this;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!(this.buffer.length >= this.options.highWaterMark)) return [3 /*break*/, 7];
                        if (this.cancelled || this.sourceError || this.sourceExhausted) {
                            return [2 /*return*/, !this.cancelled];
                        }
                        _a = this.options.backpressure;
                        switch (_a) {
                            case 'strict': return [3 /*break*/, 1];
                            case 'block': return [3 /*break*/, 2];
                            case 'drop-oldest': return [3 /*break*/, 4];
                            case 'drop-newest': return [3 /*break*/, 5];
                        }
                        return [3 /*break*/, 6];
                    case 1: 
                    // Reject - buffer limit exceeded
                    throw new RangeError("Share buffer limit of ".concat(this.options.highWaterMark, " exceeded"));
                    case 2: 
                    // Wait for slow consumers to catch up
                    return [4 /*yield*/, new Promise(function (resolve) {
                            _this.pullWaiters.push(resolve);
                        })];
                    case 3:
                        // Wait for slow consumers to catch up
                        _c.sent();
                        return [3 /*break*/, 6];
                    case 4:
                        // Drop oldest and advance cursors
                        this.buffer.shift();
                        this.bufferStart++;
                        for (_i = 0, _b = this.consumers; _i < _b.length; _i++) {
                            consumer = _b[_i];
                            if (consumer.cursor < this.bufferStart) {
                                consumer.cursor = this.bufferStart;
                            }
                        }
                        return [2 /*return*/, true];
                    case 5: 
                    // Don't pull, just return what we have
                    return [2 /*return*/, true];
                    case 6: return [3 /*break*/, 0];
                    case 7: return [2 /*return*/, true];
                }
            });
        });
    };
    /**
     * Pull next chunk from source into buffer.
     * Returns a promise that resolves when the pull completes (or immediately if already pulling).
     */
    ShareImpl.prototype.pullFromSource = function () {
        var _this = this;
        if (this.sourceExhausted || this.cancelled) {
            return Promise.resolve();
        }
        // If already pulling, wait for that pull to complete
        if (this.pulling) {
            return new Promise(function (resolve) {
                _this.pullWaiters.push(resolve);
            });
        }
        this.pulling = true;
        return (function () { return __awaiter(_this, void 0, void 0, function () {
            var syncIterator_1, result, error_1, _i, _a, waiter;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, 3, 4]);
                        // Initialize iterator if needed
                        if (!this.sourceIterator) {
                            if ((0, from_js_1.isAsyncIterable)(this.source)) {
                                this.sourceIterator = this.source[Symbol.asyncIterator]();
                            }
                            else if ((0, from_js_1.isSyncIterable)(this.source)) {
                                syncIterator_1 = this.source[Symbol.iterator]();
                                this.sourceIterator = {
                                    next: function () {
                                        return __awaiter(this, void 0, void 0, function () {
                                            return __generator(this, function (_a) {
                                                return [2 /*return*/, syncIterator_1.next()];
                                            });
                                        });
                                    },
                                    return: function () {
                                        return __awaiter(this, void 0, void 0, function () {
                                            var _a, _b;
                                            return __generator(this, function (_c) {
                                                return [2 /*return*/, (_b = (_a = syncIterator_1.return) === null || _a === void 0 ? void 0 : _a.call(syncIterator_1)) !== null && _b !== void 0 ? _b : { done: true, value: undefined }];
                                            });
                                        });
                                    },
                                };
                            }
                            else {
                                throw new TypeError('Source must be iterable');
                            }
                        }
                        return [4 /*yield*/, this.sourceIterator.next()];
                    case 1:
                        result = _b.sent();
                        if (result.done) {
                            this.sourceExhausted = true;
                        }
                        else {
                            this.buffer.push(result.value);
                        }
                        return [3 /*break*/, 4];
                    case 2:
                        error_1 = _b.sent();
                        this.sourceError = error_1 instanceof Error ? error_1 : new Error(String(error_1));
                        this.sourceExhausted = true;
                        return [3 /*break*/, 4];
                    case 3:
                        this.pulling = false;
                        // Wake up waiters so they can check the buffer
                        for (_i = 0, _a = this.pullWaiters; _i < _a.length; _i++) {
                            waiter = _a[_i];
                            waiter();
                        }
                        this.pullWaiters = [];
                        return [7 /*endfinally*/];
                    case 4: return [2 /*return*/];
                }
            });
        }); })();
    };
    /**
     * Get the slowest consumer's cursor position.
     */
    ShareImpl.prototype.getMinCursor = function () {
        var min = Infinity;
        for (var _i = 0, _a = this.consumers; _i < _a.length; _i++) {
            var consumer = _a[_i];
            if (consumer.cursor < min) {
                min = consumer.cursor;
            }
        }
        return min === Infinity ? this.bufferStart + this.buffer.length : min;
    };
    /**
     * Trim buffer from front if all consumers have advanced.
     */
    ShareImpl.prototype.tryTrimBuffer = function () {
        var minCursor = this.getMinCursor();
        var trimCount = minCursor - this.bufferStart;
        if (trimCount > 0) {
            this.buffer.trimFront(trimCount);
            this.bufferStart = minCursor;
            // Wake up any waiting pullers
            for (var _i = 0, _a = this.pullWaiters; _i < _a.length; _i++) {
                var waiter = _a[_i];
                waiter();
            }
            this.pullWaiters = [];
        }
    };
    return ShareImpl;
}());
// =============================================================================
// Sync Share Implementation
// =============================================================================
var SyncShareImpl = /** @class */ (function () {
    function SyncShareImpl(source, options) {
        this.source = source;
        this.options = options;
        this.buffer = new ringbuffer_js_1.RingBuffer();
        this.bufferStart = 0;
        this.consumers = new Set();
        this.sourceIterator = null;
        this.sourceExhausted = false;
        this.sourceError = null;
        this.cancelled = false;
    }
    Object.defineProperty(SyncShareImpl.prototype, "consumerCount", {
        get: function () {
            return this.consumers.size;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(SyncShareImpl.prototype, "bufferSize", {
        get: function () {
            return this.buffer.length;
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Create a new consumer that pulls from the shared source.
     * Optionally apply transforms to the consumer's data.
     */
    SyncShareImpl.prototype.pull = function () {
        var transforms = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            transforms[_i] = arguments[_i];
        }
        // Create raw consumer
        var rawConsumer = this.createRawConsumer();
        // If transforms provided, wrap with pullSync() pipeline
        if (transforms.length > 0) {
            return pull_js_1.pullSync.apply(void 0, __spreadArray([rawConsumer], transforms, false));
        }
        return rawConsumer;
    };
    /**
     * Create a raw consumer iterable (internal helper).
     */
    SyncShareImpl.prototype.createRawConsumer = function () {
        var _a;
        var state = {
            cursor: this.bufferStart,
            detached: false,
        };
        this.consumers.add(state);
        var self = this;
        return _a = {},
            _a[Symbol.iterator] = function () {
                return {
                    next: function () {
                        if (state.detached) {
                            return { done: true, value: undefined };
                        }
                        if (self.sourceError) {
                            state.detached = true;
                            self.consumers.delete(state);
                            throw self.sourceError;
                        }
                        if (self.cancelled) {
                            state.detached = true;
                            self.consumers.delete(state);
                            return { done: true, value: undefined };
                        }
                        // Check if data is available in buffer
                        var bufferIndex = state.cursor - self.bufferStart;
                        if (bufferIndex < self.buffer.length) {
                            var chunk = self.buffer.get(bufferIndex);
                            state.cursor++;
                            self.tryTrimBuffer();
                            return { done: false, value: chunk };
                        }
                        // Check if source is exhausted
                        if (self.sourceExhausted) {
                            state.detached = true;
                            self.consumers.delete(state);
                            return { done: true, value: undefined };
                        }
                        // Need to pull from source - check buffer limit
                        if (self.buffer.length >= self.options.highWaterMark) {
                            switch (self.options.backpressure) {
                                case 'strict':
                                    throw new RangeError("Share buffer limit of ".concat(self.options.highWaterMark, " exceeded"));
                                case 'block':
                                    // In sync context, we can't block - throw an error
                                    throw new RangeError("Share buffer limit of ".concat(self.options.highWaterMark, " exceeded (blocking not available in sync context)"));
                                case 'drop-oldest':
                                    self.buffer.shift();
                                    self.bufferStart++;
                                    for (var _i = 0, _a = self.consumers; _i < _a.length; _i++) {
                                        var consumer = _a[_i];
                                        if (consumer.cursor < self.bufferStart) {
                                            consumer.cursor = self.bufferStart;
                                        }
                                    }
                                    break;
                                case 'drop-newest':
                                    // Return done - can't pull more
                                    state.detached = true;
                                    self.consumers.delete(state);
                                    return { done: true, value: undefined };
                            }
                        }
                        // Pull from source
                        self.pullFromSource();
                        // Check again
                        if (self.sourceError) {
                            state.detached = true;
                            self.consumers.delete(state);
                            throw self.sourceError;
                        }
                        var newBufferIndex = state.cursor - self.bufferStart;
                        if (newBufferIndex < self.buffer.length) {
                            var chunk = self.buffer.get(newBufferIndex);
                            state.cursor++;
                            self.tryTrimBuffer();
                            return { done: false, value: chunk };
                        }
                        if (self.sourceExhausted) {
                            state.detached = true;
                            self.consumers.delete(state);
                            return { done: true, value: undefined };
                        }
                        return { done: true, value: undefined };
                    },
                    return: function () {
                        state.detached = true;
                        self.consumers.delete(state);
                        self.tryTrimBuffer();
                        return { done: true, value: undefined };
                    },
                    throw: function (_error) {
                        state.detached = true;
                        self.consumers.delete(state);
                        self.tryTrimBuffer();
                        return { done: true, value: undefined };
                    },
                };
            },
            _a;
    };
    /**
     * Cancel all consumers and close source.
     */
    SyncShareImpl.prototype.cancel = function (reason) {
        var _a;
        if (this.cancelled)
            return;
        this.cancelled = true;
        if (reason) {
            this.sourceError = reason;
        }
        // Close source iterator if open
        if ((_a = this.sourceIterator) === null || _a === void 0 ? void 0 : _a.return) {
            this.sourceIterator.return();
        }
        for (var _i = 0, _b = this.consumers; _i < _b.length; _i++) {
            var consumer = _b[_i];
            consumer.detached = true;
        }
        this.consumers.clear();
    };
    SyncShareImpl.prototype[Symbol.dispose] = function () {
        this.cancel();
    };
    // ==========================================================================
    // Internal Methods
    // ==========================================================================
    /**
     * Pull next chunk from source into buffer.
     */
    SyncShareImpl.prototype.pullFromSource = function () {
        if (this.sourceExhausted || this.cancelled)
            return;
        try {
            // Initialize iterator if needed
            if (!this.sourceIterator) {
                this.sourceIterator = this.source[Symbol.iterator]();
            }
            var result = this.sourceIterator.next();
            if (result.done) {
                this.sourceExhausted = true;
            }
            else {
                this.buffer.push(result.value);
            }
        }
        catch (error) {
            this.sourceError = error instanceof Error ? error : new Error(String(error));
            this.sourceExhausted = true;
        }
    };
    /**
     * Get the slowest consumer's cursor position.
     */
    SyncShareImpl.prototype.getMinCursor = function () {
        var min = Infinity;
        for (var _i = 0, _a = this.consumers; _i < _a.length; _i++) {
            var consumer = _a[_i];
            if (consumer.cursor < min) {
                min = consumer.cursor;
            }
        }
        return min === Infinity ? this.bufferStart + this.buffer.length : min;
    };
    /**
     * Trim buffer from front if all consumers have advanced.
     */
    SyncShareImpl.prototype.tryTrimBuffer = function () {
        var minCursor = this.getMinCursor();
        var trimCount = minCursor - this.bufferStart;
        if (trimCount > 0) {
            this.buffer.trimFront(trimCount);
            this.bufferStart = minCursor;
        }
    };
    return SyncShareImpl;
}());
// =============================================================================
// Public API
// =============================================================================
/**
 * Create a shared source for pull-model multi-consumer streaming.
 *
 * @param source - The source to share
 * @param options - Buffer limit and backpressure policy
 * @returns Share instance
 */
function share(source, options) {
    var _a, _b;
    var opts = {
        highWaterMark: Math.max(1, (_a = options === null || options === void 0 ? void 0 : options.highWaterMark) !== null && _a !== void 0 ? _a : 16),
        backpressure: (_b = options === null || options === void 0 ? void 0 : options.backpressure) !== null && _b !== void 0 ? _b : 'strict',
        signal: options === null || options === void 0 ? void 0 : options.signal,
    };
    var shareImpl = new ShareImpl(source, opts);
    // Handle abort signal - cancel without error (clean shutdown)
    if (opts.signal) {
        if (opts.signal.aborted) {
            shareImpl.cancel();
        }
        else {
            opts.signal.addEventListener('abort', function () {
                shareImpl.cancel();
            }, { once: true });
        }
    }
    return shareImpl;
}
/**
 * Create a sync shared source for pull-model multi-consumer streaming.
 *
 * @param source - The sync source to share
 * @param options - Buffer limit and backpressure policy
 * @returns SyncShare instance
 */
function shareSync(source, options) {
    var _a, _b;
    var opts = {
        highWaterMark: Math.max(1, (_a = options === null || options === void 0 ? void 0 : options.highWaterMark) !== null && _a !== void 0 ? _a : 16),
        backpressure: (_b = options === null || options === void 0 ? void 0 : options.backpressure) !== null && _b !== void 0 ? _b : 'strict',
    };
    return new SyncShareImpl(source, opts);
}
/**
 * Check if value implements Shareable protocol.
 */
function isShareable(value) {
    return (value !== null &&
        typeof value === 'object' &&
        types_js_1.shareProtocol in value &&
        typeof value[types_js_1.shareProtocol] === 'function');
}
/**
 * Check if value implements SyncShareable protocol.
 */
function isSyncShareable(value) {
    return (value !== null &&
        typeof value === 'object' &&
        types_js_1.shareSyncProtocol in value &&
        typeof value[types_js_1.shareSyncProtocol] === 'function');
}
/**
 * Namespace for Share.from() static method.
 */
exports.Share = {
    /**
     * Get or create a Share from a Shareable or Streamable.
     */
    from: function (input, options) {
        if (isShareable(input)) {
            return input[types_js_1.shareProtocol](options);
        }
        if ((0, from_js_1.isAsyncIterable)(input) || (0, from_js_1.isSyncIterable)(input)) {
            return share(input, options);
        }
        throw new TypeError('Input must be Shareable or Streamable');
    },
};
/**
 * Namespace for SyncShare.fromSync() static method.
 */
exports.SyncShare = {
    /**
     * Get or create a SyncShare from a SyncShareable or SyncStreamable.
     */
    fromSync: function (input, options) {
        if (isSyncShareable(input)) {
            return input[types_js_1.shareSyncProtocol](options);
        }
        if ((0, from_js_1.isSyncIterable)(input)) {
            return shareSync(input, options);
        }
        throw new TypeError('Input must be SyncShareable or SyncStreamable');
    },
};
