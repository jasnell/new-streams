"use strict";
/**
 * Stream Factories - from() and fromSync()
 *
 * Creates normalized byte stream iterables from various input types.
 * Handles recursive flattening of nested iterables and protocol conversions.
 */
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
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var __asyncDelegator = (this && this.__asyncDelegator) || function (o) {
    var i, p;
    return i = {}, verb("next"), verb("throw", function (e) { throw e; }), verb("return"), i[Symbol.iterator] = function () { return this; }, i;
    function verb(n, f) { i[n] = o[n] ? function (v) { return (p = !p) ? { value: __await(o[n](v)), done: false } : f ? f(v) : v; } : f; }
};
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
var __values = (this && this.__values) || function(o) {
    var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
    if (m) return m.call(o);
    if (o && typeof o.length === "number") return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
    throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fromSync = fromSync;
exports.from = from;
exports.normalizeSyncValue = normalizeSyncValue;
exports.normalizeSyncSource = normalizeSyncSource;
exports.normalizeAsyncValue = normalizeAsyncValue;
exports.normalizeAsyncSource = normalizeAsyncSource;
exports.isPrimitiveChunk = isPrimitiveChunk;
exports.isToStreamable = isToStreamable;
exports.isToAsyncStreamable = isToAsyncStreamable;
exports.isSyncIterable = isSyncIterable;
exports.isAsyncIterable = isAsyncIterable;
exports.primitiveToUint8Array = primitiveToUint8Array;
var types_js_1 = require("./types.js");
// Shared TextEncoder instance for string conversion
var encoder = new TextEncoder();
// Maximum number of chunks to yield per batch from from(Uint8Array[]).
// Bounds peak memory when arrays flow through transforms, which must
// allocate output for the entire batch at once.
var FROM_BATCH_SIZE = 128;
// =============================================================================
// Type Guards and Detection
// =============================================================================
/**
 * Check if value is a primitive chunk (string, ArrayBuffer, or ArrayBufferView).
 */
function isPrimitiveChunk(value) {
    if (typeof value === 'string')
        return true;
    if (value instanceof ArrayBuffer)
        return true;
    if (ArrayBuffer.isView(value))
        return true;
    return false;
}
/**
 * Check if value implements ToStreamable protocol.
 */
function isToStreamable(value) {
    return (value !== null &&
        typeof value === 'object' &&
        types_js_1.toStreamable in value &&
        typeof value[types_js_1.toStreamable] === 'function');
}
/**
 * Check if value implements ToAsyncStreamable protocol.
 */
function isToAsyncStreamable(value) {
    return (value !== null &&
        typeof value === 'object' &&
        types_js_1.toAsyncStreamable in value &&
        typeof value[types_js_1.toAsyncStreamable] === 'function');
}
/**
 * Check if value is a sync iterable (has Symbol.iterator).
 */
function isSyncIterable(value) {
    return (value !== null &&
        typeof value === 'object' &&
        Symbol.iterator in value &&
        typeof value[Symbol.iterator] === 'function');
}
/**
 * Check if value is an async iterable (has Symbol.asyncIterator).
 */
function isAsyncIterable(value) {
    return (value !== null &&
        typeof value === 'object' &&
        Symbol.asyncIterator in value &&
        typeof value[Symbol.asyncIterator] === 'function');
}
/**
 * Check if object has a custom toString() (not Object.prototype.toString).
 */
function hasCustomToString(obj) {
    var toString = obj.toString;
    return typeof toString === 'function' && toString !== Object.prototype.toString;
}
/**
 * Check if object has Symbol.toPrimitive.
 */
function hasToPrimitive(obj) {
    return (Symbol.toPrimitive in obj &&
        typeof obj[Symbol.toPrimitive] === 'function');
}
// =============================================================================
// Primitive Conversion
// =============================================================================
/**
 * Convert a primitive chunk to Uint8Array.
 * - string: UTF-8 encoded
 * - ArrayBuffer: wrapped as Uint8Array view (no copy)
 * - ArrayBufferView: converted to Uint8Array view of same memory
 */
function primitiveToUint8Array(chunk) {
    if (typeof chunk === 'string') {
        return encoder.encode(chunk);
    }
    if (chunk instanceof ArrayBuffer) {
        return new Uint8Array(chunk);
    }
    if (chunk instanceof Uint8Array) {
        return chunk;
    }
    // Other ArrayBufferView types (Int8Array, DataView, etc.)
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}
/**
 * Try to coerce an object to string using custom methods.
 * Returns null if object has no custom string coercion.
 */
function tryStringCoercion(obj) {
    // Check for Symbol.toPrimitive first
    if (hasToPrimitive(obj)) {
        var toPrimitive = obj[Symbol.toPrimitive];
        var result = toPrimitive.call(obj, 'string');
        if (typeof result === 'string') {
            return result;
        }
        // toPrimitive returned non-string, fall through to toString
    }
    // Check for custom toString
    if (hasCustomToString(obj)) {
        var result = obj.toString();
        return result;
    }
    return null;
}
// =============================================================================
// Sync Normalization (for fromSync and sync contexts)
// =============================================================================
/**
 * Normalize a sync streamable yield value to Uint8Array chunks.
 * Recursively flattens arrays, iterables, and protocol conversions.
 *
 * @yields Uint8Array chunks
 */
function normalizeSyncValue(value) {
    var result, _i, value_1, item, _a, value_2, item, str, val;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                if (!isPrimitiveChunk(value)) return [3 /*break*/, 2];
                return [4 /*yield*/, primitiveToUint8Array(value)];
            case 1:
                _c.sent();
                return [2 /*return*/];
            case 2:
                if (!isToStreamable(value)) return [3 /*break*/, 4];
                result = value[types_js_1.toStreamable]();
                return [5 /*yield**/, __values(normalizeSyncValue(result))];
            case 3:
                _c.sent();
                return [2 /*return*/];
            case 4:
                if (!Array.isArray(value)) return [3 /*break*/, 9];
                _i = 0, value_1 = value;
                _c.label = 5;
            case 5:
                if (!(_i < value_1.length)) return [3 /*break*/, 8];
                item = value_1[_i];
                return [5 /*yield**/, __values(normalizeSyncValue(item))];
            case 6:
                _c.sent();
                _c.label = 7;
            case 7:
                _i++;
                return [3 /*break*/, 5];
            case 8: return [2 /*return*/];
            case 9:
                if (!isSyncIterable(value)) return [3 /*break*/, 14];
                _a = 0, value_2 = value;
                _c.label = 10;
            case 10:
                if (!(_a < value_2.length)) return [3 /*break*/, 13];
                item = value_2[_a];
                return [5 /*yield**/, __values(normalizeSyncValue(item))];
            case 11:
                _c.sent();
                _c.label = 12;
            case 12:
                _a++;
                return [3 /*break*/, 10];
            case 13: return [2 /*return*/];
            case 14:
                if (!(typeof value === 'object' && value !== null)) return [3 /*break*/, 16];
                str = tryStringCoercion(value);
                if (!(str !== null)) return [3 /*break*/, 16];
                return [4 /*yield*/, encoder.encode(str)];
            case 15:
                _c.sent();
                return [2 /*return*/];
            case 16:
                val = value;
                throw new TypeError("Cannot convert value to streamable: ".concat(val === null ? 'null' : typeof val === 'object' ? ((_b = val.constructor) === null || _b === void 0 ? void 0 : _b.name) || 'Object' : typeof val));
        }
    });
}
/**
 * Check if value is already a Uint8Array[] batch (fast path check for sync).
 */
function isSyncUint8ArrayBatch(value) {
    if (!Array.isArray(value))
        return false;
    if (value.length === 0)
        return true;
    // Check first element - if it's a Uint8Array, assume the rest are too (common case)
    return value[0] instanceof Uint8Array;
}
/**
 * Normalize a sync streamable source, yielding batches of Uint8Array.
 *
 * @param source - The sync streamable source
 * @yields Uint8Array[] batches
 */
function normalizeSyncSource(source) {
    var _i, source_1, value, batch, _a, _b, chunk;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                _i = 0, source_1 = source;
                _c.label = 1;
            case 1:
                if (!(_i < source_1.length)) return [3 /*break*/, 9];
                value = source_1[_i];
                if (!isSyncUint8ArrayBatch(value)) return [3 /*break*/, 4];
                if (!(value.length > 0)) return [3 /*break*/, 3];
                return [4 /*yield*/, value];
            case 2:
                _c.sent();
                _c.label = 3;
            case 3: return [3 /*break*/, 8];
            case 4:
                if (!(value instanceof Uint8Array)) return [3 /*break*/, 6];
                return [4 /*yield*/, [value]];
            case 5:
                _c.sent();
                return [3 /*break*/, 8];
            case 6:
                batch = [];
                for (_a = 0, _b = normalizeSyncValue(value); _a < _b.length; _a++) {
                    chunk = _b[_a];
                    batch.push(chunk);
                }
                if (!(batch.length > 0)) return [3 /*break*/, 8];
                return [4 /*yield*/, batch];
            case 7:
                _c.sent();
                _c.label = 8;
            case 8:
                _i++;
                return [3 /*break*/, 1];
            case 9: return [2 /*return*/];
        }
    });
}
// =============================================================================
// Async Normalization (for from and async contexts)
// =============================================================================
/**
 * Normalize an async streamable yield value to Uint8Array chunks.
 * Recursively flattens arrays, iterables, async iterables, promises, and protocol conversions.
 *
 * @yields Uint8Array chunks
 */
function normalizeAsyncValue(value) {
    return __asyncGenerator(this, arguments, function normalizeAsyncValue_1() {
        var resolved, result, _a, result, _i, value_3, item, _b, value_4, value_4_1, item, e_1_1, _c, value_5, item, str, val;
        var _d, e_1, _e, _f;
        var _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    if (!(value instanceof Promise)) return [3 /*break*/, 5];
                    return [4 /*yield*/, __await(value)];
                case 1:
                    resolved = _h.sent();
                    return [5 /*yield**/, __values(__asyncDelegator(__asyncValues(normalizeAsyncValue(resolved))))];
                case 2: return [4 /*yield*/, __await.apply(void 0, [_h.sent()])];
                case 3:
                    _h.sent();
                    return [4 /*yield*/, __await(void 0)];
                case 4: return [2 /*return*/, _h.sent()];
                case 5:
                    if (!isPrimitiveChunk(value)) return [3 /*break*/, 9];
                    return [4 /*yield*/, __await(primitiveToUint8Array(value))];
                case 6: return [4 /*yield*/, _h.sent()];
                case 7:
                    _h.sent();
                    return [4 /*yield*/, __await(void 0)];
                case 8: return [2 /*return*/, _h.sent()];
                case 9:
                    if (!isToAsyncStreamable(value)) return [3 /*break*/, 18];
                    result = value[types_js_1.toAsyncStreamable]();
                    if (!(result instanceof Promise)) return [3 /*break*/, 13];
                    _a = normalizeAsyncValue;
                    return [4 /*yield*/, __await(result)];
                case 10: return [5 /*yield**/, __values(__asyncDelegator.apply(void 0, [__asyncValues.apply(void 0, [_a.apply(void 0, [_h.sent()])])]))];
                case 11: return [4 /*yield*/, __await.apply(void 0, [_h.sent()])];
                case 12:
                    _h.sent();
                    return [3 /*break*/, 16];
                case 13: return [5 /*yield**/, __values(__asyncDelegator(__asyncValues(normalizeAsyncValue(result))))];
                case 14: return [4 /*yield*/, __await.apply(void 0, [_h.sent()])];
                case 15:
                    _h.sent();
                    _h.label = 16;
                case 16: return [4 /*yield*/, __await(void 0)];
                case 17: return [2 /*return*/, _h.sent()];
                case 18:
                    if (!isToStreamable(value)) return [3 /*break*/, 22];
                    result = value[types_js_1.toStreamable]();
                    return [5 /*yield**/, __values(__asyncDelegator(__asyncValues(normalizeAsyncValue(result))))];
                case 19: return [4 /*yield*/, __await.apply(void 0, [_h.sent()])];
                case 20:
                    _h.sent();
                    return [4 /*yield*/, __await(void 0)];
                case 21: return [2 /*return*/, _h.sent()];
                case 22:
                    if (!Array.isArray(value)) return [3 /*break*/, 29];
                    _i = 0, value_3 = value;
                    _h.label = 23;
                case 23:
                    if (!(_i < value_3.length)) return [3 /*break*/, 27];
                    item = value_3[_i];
                    return [5 /*yield**/, __values(__asyncDelegator(__asyncValues(normalizeAsyncValue(item))))];
                case 24: return [4 /*yield*/, __await.apply(void 0, [_h.sent()])];
                case 25:
                    _h.sent();
                    _h.label = 26;
                case 26:
                    _i++;
                    return [3 /*break*/, 23];
                case 27: return [4 /*yield*/, __await(void 0)];
                case 28: return [2 /*return*/, _h.sent()];
                case 29:
                    if (!isAsyncIterable(value)) return [3 /*break*/, 45];
                    _h.label = 30;
                case 30:
                    _h.trys.push([30, 37, 38, 43]);
                    _b = true, value_4 = __asyncValues(value);
                    _h.label = 31;
                case 31: return [4 /*yield*/, __await(value_4.next())];
                case 32:
                    if (!(value_4_1 = _h.sent(), _d = value_4_1.done, !_d)) return [3 /*break*/, 36];
                    _f = value_4_1.value;
                    _b = false;
                    item = _f;
                    return [5 /*yield**/, __values(__asyncDelegator(__asyncValues(normalizeAsyncValue(item))))];
                case 33: return [4 /*yield*/, __await.apply(void 0, [_h.sent()])];
                case 34:
                    _h.sent();
                    _h.label = 35;
                case 35:
                    _b = true;
                    return [3 /*break*/, 31];
                case 36: return [3 /*break*/, 43];
                case 37:
                    e_1_1 = _h.sent();
                    e_1 = { error: e_1_1 };
                    return [3 /*break*/, 43];
                case 38:
                    _h.trys.push([38, , 41, 42]);
                    if (!(!_b && !_d && (_e = value_4.return))) return [3 /*break*/, 40];
                    return [4 /*yield*/, __await(_e.call(value_4))];
                case 39:
                    _h.sent();
                    _h.label = 40;
                case 40: return [3 /*break*/, 42];
                case 41:
                    if (e_1) throw e_1.error;
                    return [7 /*endfinally*/];
                case 42: return [7 /*endfinally*/];
                case 43: return [4 /*yield*/, __await(void 0)];
                case 44: return [2 /*return*/, _h.sent()];
                case 45:
                    if (!isSyncIterable(value)) return [3 /*break*/, 52];
                    _c = 0, value_5 = value;
                    _h.label = 46;
                case 46:
                    if (!(_c < value_5.length)) return [3 /*break*/, 50];
                    item = value_5[_c];
                    return [5 /*yield**/, __values(__asyncDelegator(__asyncValues(normalizeAsyncValue(item))))];
                case 47: return [4 /*yield*/, __await.apply(void 0, [_h.sent()])];
                case 48:
                    _h.sent();
                    _h.label = 49;
                case 49:
                    _c++;
                    return [3 /*break*/, 46];
                case 50: return [4 /*yield*/, __await(void 0)];
                case 51: return [2 /*return*/, _h.sent()];
                case 52:
                    if (!(typeof value === 'object' && value !== null)) return [3 /*break*/, 56];
                    str = tryStringCoercion(value);
                    if (!(str !== null)) return [3 /*break*/, 56];
                    return [4 /*yield*/, __await(encoder.encode(str))];
                case 53: return [4 /*yield*/, _h.sent()];
                case 54:
                    _h.sent();
                    return [4 /*yield*/, __await(void 0)];
                case 55: return [2 /*return*/, _h.sent()];
                case 56:
                    val = value;
                    throw new TypeError("Cannot convert value to streamable: ".concat(val === null ? 'null' : typeof val === 'object' ? ((_g = val.constructor) === null || _g === void 0 ? void 0 : _g.name) || 'Object' : typeof val));
            }
        });
    });
}
/**
 * Check if value is already a Uint8Array[] batch (fast path check).
 */
function isUint8ArrayBatch(value) {
    if (!Array.isArray(value))
        return false;
    if (value.length === 0)
        return true;
    // Check first element - if it's a Uint8Array, assume the rest are too (common case)
    return value[0] instanceof Uint8Array;
}
/**
 * Normalize an async streamable source, yielding batches of Uint8Array.
 *
 * @param source - The async streamable source (can be sync or async iterable)
 * @yields Uint8Array[] batches
 */
function normalizeAsyncSource(source) {
    return __asyncGenerator(this, arguments, function normalizeAsyncSource_1() {
        var _a, source_2, source_2_1, value, batch, _b, _c, _d, chunk, e_2_1, e_3_1, batch, _i, source_3, value, asyncBatch, _e, _f, _g, chunk, e_4_1;
        var _h, e_3, _j, _k, _l, e_2, _m, _o, _p, e_4, _q, _r;
        return __generator(this, function (_s) {
            switch (_s.label) {
                case 0:
                    if (!isAsyncIterable(source)) return [3 /*break*/, 35];
                    _s.label = 1;
                case 1:
                    _s.trys.push([1, 27, 28, 33]);
                    _a = true, source_2 = __asyncValues(source);
                    _s.label = 2;
                case 2: return [4 /*yield*/, __await(source_2.next())];
                case 3:
                    if (!(source_2_1 = _s.sent(), _h = source_2_1.done, !_h)) return [3 /*break*/, 26];
                    _k = source_2_1.value;
                    _a = false;
                    value = _k;
                    if (!isUint8ArrayBatch(value)) return [3 /*break*/, 7];
                    if (!(value.length > 0)) return [3 /*break*/, 6];
                    return [4 /*yield*/, __await(value)];
                case 4: return [4 /*yield*/, _s.sent()];
                case 5:
                    _s.sent();
                    _s.label = 6;
                case 6: return [3 /*break*/, 25];
                case 7:
                    if (!(value instanceof Uint8Array)) return [3 /*break*/, 10];
                    return [4 /*yield*/, __await([value])];
                case 8: return [4 /*yield*/, _s.sent()];
                case 9:
                    _s.sent();
                    return [3 /*break*/, 25];
                case 10:
                    batch = [];
                    _s.label = 11;
                case 11:
                    _s.trys.push([11, 16, 17, 22]);
                    _b = true, _c = (e_2 = void 0, __asyncValues(normalizeAsyncValue(value)));
                    _s.label = 12;
                case 12: return [4 /*yield*/, __await(_c.next())];
                case 13:
                    if (!(_d = _s.sent(), _l = _d.done, !_l)) return [3 /*break*/, 15];
                    _o = _d.value;
                    _b = false;
                    chunk = _o;
                    batch.push(chunk);
                    _s.label = 14;
                case 14:
                    _b = true;
                    return [3 /*break*/, 12];
                case 15: return [3 /*break*/, 22];
                case 16:
                    e_2_1 = _s.sent();
                    e_2 = { error: e_2_1 };
                    return [3 /*break*/, 22];
                case 17:
                    _s.trys.push([17, , 20, 21]);
                    if (!(!_b && !_l && (_m = _c.return))) return [3 /*break*/, 19];
                    return [4 /*yield*/, __await(_m.call(_c))];
                case 18:
                    _s.sent();
                    _s.label = 19;
                case 19: return [3 /*break*/, 21];
                case 20:
                    if (e_2) throw e_2.error;
                    return [7 /*endfinally*/];
                case 21: return [7 /*endfinally*/];
                case 22:
                    if (!(batch.length > 0)) return [3 /*break*/, 25];
                    return [4 /*yield*/, __await(batch)];
                case 23: return [4 /*yield*/, _s.sent()];
                case 24:
                    _s.sent();
                    _s.label = 25;
                case 25:
                    _a = true;
                    return [3 /*break*/, 2];
                case 26: return [3 /*break*/, 33];
                case 27:
                    e_3_1 = _s.sent();
                    e_3 = { error: e_3_1 };
                    return [3 /*break*/, 33];
                case 28:
                    _s.trys.push([28, , 31, 32]);
                    if (!(!_a && !_h && (_j = source_2.return))) return [3 /*break*/, 30];
                    return [4 /*yield*/, __await(_j.call(source_2))];
                case 29:
                    _s.sent();
                    _s.label = 30;
                case 30: return [3 /*break*/, 32];
                case 31:
                    if (e_3) throw e_3.error;
                    return [7 /*endfinally*/];
                case 32: return [7 /*endfinally*/];
                case 33: return [4 /*yield*/, __await(void 0)];
                case 34: return [2 /*return*/, _s.sent()];
                case 35:
                    if (!isSyncIterable(source)) return [3 /*break*/, 67];
                    batch = [];
                    _i = 0, source_3 = source;
                    _s.label = 36;
                case 36:
                    if (!(_i < source_3.length)) return [3 /*break*/, 62];
                    value = source_3[_i];
                    if (!isUint8ArrayBatch(value)) return [3 /*break*/, 43];
                    if (!(batch.length > 0)) return [3 /*break*/, 39];
                    return [4 /*yield*/, __await(batch.slice())];
                case 37: return [4 /*yield*/, _s.sent()];
                case 38:
                    _s.sent();
                    batch.length = 0;
                    _s.label = 39;
                case 39:
                    if (!(value.length > 0)) return [3 /*break*/, 42];
                    return [4 /*yield*/, __await(value)];
                case 40: return [4 /*yield*/, _s.sent()];
                case 41:
                    _s.sent();
                    _s.label = 42;
                case 42: return [3 /*break*/, 61];
                case 43:
                    // Fast path 2: value is a single Uint8Array (very common)
                    if (value instanceof Uint8Array) {
                        batch.push(value);
                        return [3 /*break*/, 61];
                    }
                    if (!(batch.length > 0)) return [3 /*break*/, 46];
                    return [4 /*yield*/, __await(batch.slice())];
                case 44: return [4 /*yield*/, _s.sent()];
                case 45:
                    _s.sent();
                    batch.length = 0;
                    _s.label = 46;
                case 46:
                    asyncBatch = [];
                    _s.label = 47;
                case 47:
                    _s.trys.push([47, 52, 53, 58]);
                    _e = true, _f = (e_4 = void 0, __asyncValues(normalizeAsyncValue(value)));
                    _s.label = 48;
                case 48: return [4 /*yield*/, __await(_f.next())];
                case 49:
                    if (!(_g = _s.sent(), _p = _g.done, !_p)) return [3 /*break*/, 51];
                    _r = _g.value;
                    _e = false;
                    chunk = _r;
                    asyncBatch.push(chunk);
                    _s.label = 50;
                case 50:
                    _e = true;
                    return [3 /*break*/, 48];
                case 51: return [3 /*break*/, 58];
                case 52:
                    e_4_1 = _s.sent();
                    e_4 = { error: e_4_1 };
                    return [3 /*break*/, 58];
                case 53:
                    _s.trys.push([53, , 56, 57]);
                    if (!(!_e && !_p && (_q = _f.return))) return [3 /*break*/, 55];
                    return [4 /*yield*/, __await(_q.call(_f))];
                case 54:
                    _s.sent();
                    _s.label = 55;
                case 55: return [3 /*break*/, 57];
                case 56:
                    if (e_4) throw e_4.error;
                    return [7 /*endfinally*/];
                case 57: return [7 /*endfinally*/];
                case 58:
                    if (!(asyncBatch.length > 0)) return [3 /*break*/, 61];
                    return [4 /*yield*/, __await(asyncBatch)];
                case 59: return [4 /*yield*/, _s.sent()];
                case 60:
                    _s.sent();
                    _s.label = 61;
                case 61:
                    _i++;
                    return [3 /*break*/, 36];
                case 62:
                    if (!(batch.length > 0)) return [3 /*break*/, 65];
                    return [4 /*yield*/, __await(batch)];
                case 63: return [4 /*yield*/, _s.sent()];
                case 64:
                    _s.sent();
                    _s.label = 65;
                case 65: return [4 /*yield*/, __await(void 0)];
                case 66: return [2 /*return*/, _s.sent()];
                case 67: throw new TypeError('Source must be iterable');
            }
        });
    });
}
// =============================================================================
// Public API: from() and fromSync()
// =============================================================================
/**
 * Create a SyncByteStreamReadable from a ByteInput or SyncStreamable.
 *
 * - ByteInput (string, ArrayBuffer, ArrayBufferView): emits as single chunk
 * - SyncStreamable: wraps and normalizes chunks, flattening nested structures
 *
 * @param input - Raw byte input or sync iterable source
 * @returns A sync iterable yielding Uint8Array[] batches
 */
function fromSync(input) {
    var _a, _b, _c, _d;
    // Null/undefined guard
    if (input == null) {
        throw new TypeError('Input must not be null or undefined');
    }
    // Check for primitives first (ByteInput)
    if (isPrimitiveChunk(input)) {
        var chunk_1 = primitiveToUint8Array(input);
        return _a = {},
            _a[Symbol.iterator] = function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, [chunk_1]];
                        case 1:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            },
            _a;
    }
    // Fast path: Uint8Array[] - yield as a single batch
    if (Array.isArray(input)) {
        if (input.length === 0) {
            return _b = {},
                _b[Symbol.iterator] = function () {
                    return __generator(this, function (_a) {
                        return [2 /*return*/];
                    });
                },
                _b;
        }
        // Check if it's an array of Uint8Array (common case)
        if (input[0] instanceof Uint8Array) {
            var allUint8 = input.every(function (item) { return item instanceof Uint8Array; });
            if (allUint8) {
                var batch_1 = input;
                return _c = {},
                    _c[Symbol.iterator] = function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0: return [4 /*yield*/, batch_1];
                                case 1:
                                    _a.sent();
                                    return [2 /*return*/];
                            }
                        });
                    },
                    _c;
            }
        }
    }
    // Check toStreamable protocol (takes precedence over iteration protocols)
    if (isToStreamable(input)) {
        var result = input[types_js_1.toStreamable]();
        return fromSync(result);
    }
    // Must be a SyncStreamable
    if (!isSyncIterable(input)) {
        throw new TypeError('Input must be a ByteInput or SyncStreamable');
    }
    return _d = {},
        _d[Symbol.iterator] = function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [5 /*yield**/, __values(normalizeSyncSource(input))];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        },
        _d;
}
/**
 * Create a ByteStreamReadable from a ByteInput or Streamable.
 *
 * - ByteInput (string, ArrayBuffer, ArrayBufferView): emits as single chunk
 * - SyncStreamable: wraps as async, normalizes chunks
 * - AsyncStreamable: wraps and normalizes chunks
 *
 * @param input - Raw byte input or iterable source
 * @returns An async iterable yielding Uint8Array[] batches
 */
function from(input) {
    var _a, _b, _c, _d, _e;
    // Null/undefined guard
    if (input == null) {
        throw new TypeError('Input must not be null or undefined');
    }
    // Check for primitives first (ByteInput)
    if (isPrimitiveChunk(input)) {
        var chunk_2 = primitiveToUint8Array(input);
        return _a = {},
            _a[Symbol.asyncIterator] = function () {
                return __asyncGenerator(this, arguments, function _a() {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0: return [4 /*yield*/, __await([chunk_2])];
                            case 1: return [4 /*yield*/, _b.sent()];
                            case 2:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            },
            _a;
    }
    // Fast path: Uint8Array[] - yield in bounded sub-batches.
    // Yielding the entire array as one batch forces downstream transforms
    // to process all data at once, causing peak memory proportional to total
    // data volume. Sub-batching keeps peak memory bounded while preserving
    // the throughput benefit of batched processing.
    if (Array.isArray(input)) {
        if (input.length === 0) {
            return _b = {},
                _b[Symbol.asyncIterator] = function () {
                    return __asyncGenerator(this, arguments, function _a() {
                        return __generator(this, function (_b) {
                            return [2 /*return*/];
                        });
                    });
                },
                _b;
        }
        // Check if it's an array of Uint8Array (common case)
        if (input[0] instanceof Uint8Array) {
            // Verify all elements are Uint8Array for type safety
            var allUint8 = input.every(function (item) { return item instanceof Uint8Array; });
            if (allUint8) {
                var batch_2 = input;
                return _c = {},
                    _c[Symbol.asyncIterator] = function () {
                        return __asyncGenerator(this, arguments, function _a() {
                            var i;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0:
                                        if (!(batch_2.length <= FROM_BATCH_SIZE)) return [3 /*break*/, 3];
                                        return [4 /*yield*/, __await(batch_2)];
                                    case 1: return [4 /*yield*/, _b.sent()];
                                    case 2:
                                        _b.sent();
                                        return [3 /*break*/, 8];
                                    case 3:
                                        i = 0;
                                        _b.label = 4;
                                    case 4:
                                        if (!(i < batch_2.length)) return [3 /*break*/, 8];
                                        return [4 /*yield*/, __await(batch_2.slice(i, i + FROM_BATCH_SIZE))];
                                    case 5: return [4 /*yield*/, _b.sent()];
                                    case 6:
                                        _b.sent();
                                        _b.label = 7;
                                    case 7:
                                        i += FROM_BATCH_SIZE;
                                        return [3 /*break*/, 4];
                                    case 8: return [2 /*return*/];
                                }
                            });
                        });
                    },
                    _c;
            }
        }
    }
    // Check toAsyncStreamable protocol (takes precedence)
    if (isToAsyncStreamable(input)) {
        return _d = {},
            _d[Symbol.asyncIterator] = function () {
                return __asyncGenerator(this, arguments, function _a() {
                    var result;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0: return [4 /*yield*/, __await(input[types_js_1.toAsyncStreamable]())];
                            case 1:
                                result = _b.sent();
                                return [5 /*yield**/, __values(__asyncDelegator(__asyncValues(normalizeAsyncSource(from(result)))))];
                            case 2: return [4 /*yield*/, __await.apply(void 0, [_b.sent()])];
                            case 3:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            },
            _d;
    }
    // Check toStreamable protocol
    if (isToStreamable(input)) {
        var result = input[types_js_1.toStreamable]();
        return from(result);
    }
    // Must be a Streamable (sync or async iterable)
    if (!isSyncIterable(input) && !isAsyncIterable(input)) {
        throw new TypeError('Input must be a ByteInput or Streamable');
    }
    return _e = {},
        _e[Symbol.asyncIterator] = function () {
            return __asyncGenerator(this, arguments, function _a() {
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0: return [5 /*yield**/, __values(__asyncDelegator(__asyncValues(normalizeAsyncSource(input))))];
                        case 1: return [4 /*yield*/, __await.apply(void 0, [_b.sent()])];
                        case 2:
                            _b.sent();
                            return [2 /*return*/];
                    }
                });
            });
        },
        _e;
}
