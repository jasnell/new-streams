"use strict";
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
exports.SyncMemoryWriter = exports.MemoryWriter = exports.kHeader = void 0;
exports.section = section;
exports.uppercaseTransform = uppercaseTransform;
exports.kHeader = "".concat('='.repeat(60));
// Helper to print section headers
function section(title) {
    console.log("\n".concat(exports.kHeader));
    console.log("  ".concat(title));
    console.log(exports.kHeader);
}
function uppercaseTransform() {
    var enc = new TextEncoder();
    var dec = new TextDecoder();
    return function uppercase(chunks) {
        var _i, chunks_1, chunk, text;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (chunks == null) {
                        // Flush any remaining decoder state
                        return [2 /*return*/, enc.encode(dec.decode())];
                    }
                    _i = 0, chunks_1 = chunks;
                    _a.label = 1;
                case 1:
                    if (!(_i < chunks_1.length)) return [3 /*break*/, 4];
                    chunk = chunks_1[_i];
                    text = dec.decode(chunk, { stream: true });
                    return [4 /*yield*/, enc.encode(text.toUpperCase())];
                case 2:
                    _a.sent();
                    _a.label = 3;
                case 3:
                    _i++;
                    return [3 /*break*/, 1];
                case 4: return [2 /*return*/];
            }
        });
    };
}
// Simple in-memory writer for testing
var MemoryWriter = /** @class */ (function () {
    function MemoryWriter() {
        this.chunks = [];
        this._closed = false;
        this._byteCount = 0;
        this.enc = new TextEncoder();
    }
    Object.defineProperty(MemoryWriter.prototype, "desiredSize", {
        get: function () {
            return this._closed ? null : 100;
        },
        enumerable: false,
        configurable: true
    });
    MemoryWriter.prototype.write = function (chunk, _options) {
        return __awaiter(this, void 0, void 0, function () {
            var bytes;
            return __generator(this, function (_a) {
                if (this._closed)
                    throw new Error('Writer is closed');
                bytes = typeof chunk === 'string' ? this.enc.encode(chunk) : chunk;
                this.chunks.push(bytes);
                this._byteCount += bytes.byteLength;
                return [2 /*return*/];
            });
        });
    };
    MemoryWriter.prototype.writev = function (chunks, _options) {
        return __awaiter(this, void 0, void 0, function () {
            var _i, chunks_2, chunk;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _i = 0, chunks_2 = chunks;
                        _a.label = 1;
                    case 1:
                        if (!(_i < chunks_2.length)) return [3 /*break*/, 4];
                        chunk = chunks_2[_i];
                        return [4 /*yield*/, this.write(chunk)];
                    case 2:
                        _a.sent();
                        _a.label = 3;
                    case 3:
                        _i++;
                        return [3 /*break*/, 1];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    MemoryWriter.prototype.writeSync = function (chunk) {
        if (this._closed)
            return false;
        var bytes = typeof chunk === 'string' ? this.enc.encode(chunk) : chunk;
        this.chunks.push(bytes);
        this._byteCount += bytes.byteLength;
        return true;
    };
    MemoryWriter.prototype.writevSync = function (chunks) {
        for (var _i = 0, chunks_3 = chunks; _i < chunks_3.length; _i++) {
            var chunk = chunks_3[_i];
            if (!this.writeSync(chunk))
                return false;
        }
        return true;
    };
    MemoryWriter.prototype.end = function (_options) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                this._closed = true;
                return [2 /*return*/, this._byteCount];
            });
        });
    };
    MemoryWriter.prototype.endSync = function () {
        this._closed = true;
        return this._byteCount;
    };
    MemoryWriter.prototype.fail = function (reason) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                this._closed = true;
                return [2 /*return*/];
            });
        });
    };
    MemoryWriter.prototype.failSync = function (reason) {
        this._closed = true;
        return true;
    };
    MemoryWriter.prototype.getText = function () {
        var dec = new TextDecoder();
        return this.chunks.map(function (c) { return dec.decode(c, { stream: true }); }).join('') + dec.decode();
    };
    return MemoryWriter;
}());
exports.MemoryWriter = MemoryWriter;
var SyncMemoryWriter = /** @class */ (function () {
    function SyncMemoryWriter() {
        this.chunks = [];
        this._closed = false;
        this._byteCount = 0;
        this.enc = new TextEncoder();
    }
    Object.defineProperty(SyncMemoryWriter.prototype, "desiredSize", {
        get: function () {
            return this._closed ? null : 100;
        },
        enumerable: false,
        configurable: true
    });
    SyncMemoryWriter.prototype.write = function (chunk) {
        if (this._closed)
            throw new Error('Writer is closed');
        var bytes = typeof chunk === 'string' ? this.enc.encode(chunk) : chunk;
        this.chunks.push(bytes);
        this._byteCount += bytes.byteLength;
        return true;
    };
    SyncMemoryWriter.prototype.writev = function (chunks) {
        for (var _i = 0, chunks_4 = chunks; _i < chunks_4.length; _i++) {
            var chunk = chunks_4[_i];
            this.write(chunk);
        }
        return true;
    };
    SyncMemoryWriter.prototype.end = function () {
        this._closed = true;
        return this._byteCount;
    };
    SyncMemoryWriter.prototype.fail = function (reason) {
        this._closed = true;
    };
    SyncMemoryWriter.prototype.getText = function () {
        var dec = new TextDecoder();
        return this.chunks.map(function (c) { return dec.decode(c, { stream: true }); }).join('') + dec.decode();
    };
    return SyncMemoryWriter;
}());
exports.SyncMemoryWriter = SyncMemoryWriter;
