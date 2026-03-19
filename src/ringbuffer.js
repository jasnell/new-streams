"use strict";
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
exports.RingBuffer = void 0;
/**
 * RingBuffer - O(1) FIFO queue with indexed access.
 *
 * Replaces plain JS arrays that are used as queues with shift()/push().
 * Array.shift() is O(n) because it copies all remaining elements;
 * RingBuffer.shift() is O(1) — it just advances a head pointer.
 *
 * Also provides O(1) trimFront(count) to replace Array.splice(0, count).
 */
var RingBuffer = /** @class */ (function () {
    function RingBuffer(initialCapacity) {
        if (initialCapacity === void 0) { initialCapacity = 16; }
        this._head = 0;
        this._size = 0;
        this._capacity = initialCapacity;
        this._backing = new Array(initialCapacity);
    }
    Object.defineProperty(RingBuffer.prototype, "length", {
        get: function () {
            return this._size;
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Append an item to the tail. O(1) amortized.
     */
    RingBuffer.prototype.push = function (item) {
        if (this._size === this._capacity) {
            this._grow();
        }
        this._backing[(this._head + this._size) % this._capacity] = item;
        this._size++;
    };
    /**
     * Prepend an item to the head. O(1) amortized.
     */
    RingBuffer.prototype.unshift = function (item) {
        if (this._size === this._capacity) {
            this._grow();
        }
        this._head = (this._head - 1 + this._capacity) % this._capacity;
        this._backing[this._head] = item;
        this._size++;
    };
    /**
     * Remove and return the item at the head. O(1).
     */
    RingBuffer.prototype.shift = function () {
        if (this._size === 0)
            return undefined;
        var item = this._backing[this._head];
        this._backing[this._head] = undefined; // Help GC
        this._head = (this._head + 1) % this._capacity;
        this._size--;
        return item;
    };
    /**
     * Read item at a logical index (0 = head). O(1).
     */
    RingBuffer.prototype.get = function (index) {
        return this._backing[(this._head + index) % this._capacity];
    };
    /**
     * Remove `count` items from the head without returning them. O(count) for GC cleanup.
     */
    RingBuffer.prototype.trimFront = function (count) {
        if (count <= 0)
            return;
        if (count >= this._size) {
            this.clear();
            return;
        }
        for (var i = 0; i < count; i++) {
            this._backing[(this._head + i) % this._capacity] = undefined;
        }
        this._head = (this._head + count) % this._capacity;
        this._size -= count;
    };
    /**
     * Find the logical index of `item` (reference equality). O(n).
     * Returns -1 if not found.
     */
    RingBuffer.prototype.indexOf = function (item) {
        for (var i = 0; i < this._size; i++) {
            if (this._backing[(this._head + i) % this._capacity] === item) {
                return i;
            }
        }
        return -1;
    };
    /**
     * Remove the item at logical `index`, shifting later elements. O(n) worst case.
     * Used only on rare abort-signal cancellation path.
     */
    RingBuffer.prototype.removeAt = function (index) {
        if (index < 0 || index >= this._size)
            return;
        for (var i = index; i < this._size - 1; i++) {
            var from = (this._head + i + 1) % this._capacity;
            var to = (this._head + i) % this._capacity;
            this._backing[to] = this._backing[from];
        }
        var last = (this._head + this._size - 1) % this._capacity;
        this._backing[last] = undefined;
        this._size--;
    };
    /**
     * Remove all items. O(n) for GC cleanup.
     */
    RingBuffer.prototype.clear = function () {
        for (var i = 0; i < this._size; i++) {
            this._backing[(this._head + i) % this._capacity] = undefined;
        }
        this._head = 0;
        this._size = 0;
    };
    /**
     * Iterate over all items head-to-tail.
     */
    RingBuffer.prototype[Symbol.iterator] = function () {
        var i;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    i = 0;
                    _a.label = 1;
                case 1:
                    if (!(i < this._size)) return [3 /*break*/, 4];
                    return [4 /*yield*/, this._backing[(this._head + i) % this._capacity]];
                case 2:
                    _a.sent();
                    _a.label = 3;
                case 3:
                    i++;
                    return [3 /*break*/, 1];
                case 4: return [2 /*return*/];
            }
        });
    };
    /**
     * Double the backing capacity, linearizing the circular layout.
     */
    RingBuffer.prototype._grow = function () {
        var newCapacity = this._capacity * 2;
        var newBacking = new Array(newCapacity);
        for (var i = 0; i < this._size; i++) {
            newBacking[i] = this._backing[(this._head + i) % this._capacity];
        }
        this._backing = newBacking;
        this._head = 0;
        this._capacity = newCapacity;
    };
    return RingBuffer;
}());
exports.RingBuffer = RingBuffer;
