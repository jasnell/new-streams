"use strict";
/**
 * Duplex channel implementation for bidirectional streaming.
 *
 * Creates a pair of connected channels where data written to one
 * channel's writer appears in the other channel's readable.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.duplex = duplex;
var push_js_1 = require("./push.js");
/**
 * Create a pair of connected duplex channels for bidirectional communication.
 *
 * Similar to Unix socketpair() - creates two endpoints where data written
 * to one endpoint's writer appears in the other endpoint's readable.
 *
 * @param options - Optional configuration for both channels
 * @returns A tuple of two connected DuplexChannel instances
 *
 * @example
 * ```typescript
 * const [client, server] = Stream.duplex();
 *
 * // Server echoes back what it receives
 * (async () => {
 *   await using srv = server;
 *   for await (const chunks of srv.readable) {
 *     await srv.writer.writev(chunks);
 *   }
 * })();
 *
 * // Client sends and receives
 * {
 *   await using conn = client;
 *   await conn.writer.write('Hello');
 *   for await (const chunks of conn.readable) {
 *     console.log(new TextDecoder().decode(chunks[0])); // "Hello"
 *     break;
 *   }
 * }
 * ```
 */
function duplex(options) {
    var _a, _b;
    var _c, _d, _e, _f;
    var _g = options !== null && options !== void 0 ? options : {}, highWaterMark = _g.highWaterMark, backpressure = _g.backpressure, signal = _g.signal, a = _g.a, b = _g.b;
    // Channel A writes to B's readable (A→B direction)
    var _h = (0, push_js_1.push)({
        highWaterMark: (_c = a === null || a === void 0 ? void 0 : a.highWaterMark) !== null && _c !== void 0 ? _c : highWaterMark,
        backpressure: (_d = a === null || a === void 0 ? void 0 : a.backpressure) !== null && _d !== void 0 ? _d : backpressure,
        signal: signal,
    }), aWriter = _h.writer, bReadable = _h.readable;
    // Channel B writes to A's readable (B→A direction)
    var _j = (0, push_js_1.push)({
        highWaterMark: (_e = b === null || b === void 0 ? void 0 : b.highWaterMark) !== null && _e !== void 0 ? _e : highWaterMark,
        backpressure: (_f = b === null || b === void 0 ? void 0 : b.backpressure) !== null && _f !== void 0 ? _f : backpressure,
        signal: signal,
    }), bWriter = _j.writer, aReadable = _j.readable;
    // Track closed state for idempotency
    var aWriterRef = aWriter;
    var bWriterRef = bWriter;
    var channelA = (_a = {
            get writer() {
                return aWriter;
            },
            readable: aReadable,
            close: function () {
                return __awaiter(this, void 0, void 0, function () {
                    var writer;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0:
                                if (aWriterRef === null)
                                    return [2 /*return*/];
                                writer = aWriterRef;
                                aWriterRef = null;
                                if (!(writer.endSync() < 0)) return [3 /*break*/, 2];
                                return [4 /*yield*/, writer.end()];
                            case 1:
                                _a.sent();
                                _a.label = 2;
                            case 2: return [2 /*return*/];
                        }
                    });
                });
            }
        },
        _a[Symbol.asyncDispose] = function () {
            return this.close();
        },
        _a);
    var channelB = (_b = {
            get writer() {
                return bWriter;
            },
            readable: bReadable,
            close: function () {
                return __awaiter(this, void 0, void 0, function () {
                    var writer;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0:
                                if (bWriterRef === null)
                                    return [2 /*return*/];
                                writer = bWriterRef;
                                bWriterRef = null;
                                if (!(writer.endSync() < 0)) return [3 /*break*/, 2];
                                return [4 /*yield*/, writer.end()];
                            case 1:
                                _a.sent();
                                _a.label = 2;
                            case 2: return [2 /*return*/];
                        }
                    });
                });
            }
        },
        _b[Symbol.asyncDispose] = function () {
            return this.close();
        },
        _b);
    return [channelA, channelB];
}
