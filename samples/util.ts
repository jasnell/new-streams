import { type Writer, type SyncWriter, type WriteOptions } from '../src/index.js';

export const kHeader = `${ '='.repeat(60) }`;

// Helper to print section headers
export function section(title: string) {
  console.log(`\n${kHeader}`);
  console.log(`  ${title}`);
  console.log(kHeader);
}

export function uppercaseTransform() {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  return function* uppercase(chunks: Uint8Array[] | null) {
    if (chunks == null) {
      // Flush any remaining decoder state
      return enc.encode(dec.decode());
    }
    for (const chunk of chunks) {
      const text = dec.decode(chunk, { stream: true });
      yield enc.encode(text.toUpperCase());
    }
  };
}

// Simple in-memory writer for testing
export class MemoryWriter implements Writer {
  private chunks: Uint8Array[] = [];
  private _closed = false;
  private _byteCount = 0;
  private enc = new TextEncoder();

  get desiredSize(): number | null {
    return this._closed ? null : 100;
  }

  async write(chunk: Uint8Array | string, _options?: WriteOptions): Promise<void> {
    if (this._closed) throw new Error('Writer is closed');
    const bytes = typeof chunk === 'string' ? this.enc.encode(chunk) : chunk;
    this.chunks.push(bytes);
    this._byteCount += bytes.byteLength;
  }

  async writev(chunks: (Uint8Array | string)[], _options?: WriteOptions): Promise<void> {
    for (const chunk of chunks) {
      await this.write(chunk);
    }
  }

  writeSync(chunk: Uint8Array | string): boolean {
    if (this._closed) return false;
    const bytes = typeof chunk === 'string' ? this.enc.encode(chunk) : chunk;
    this.chunks.push(bytes);
    this._byteCount += bytes.byteLength;
    return true;
  }

  writevSync(chunks: (Uint8Array | string)[]): boolean {
    for (const chunk of chunks) {
      if (!this.writeSync(chunk)) return false;
    }
    return true;
  }

  async end(_options?: WriteOptions): Promise<number> {
    this._closed = true;
    return this._byteCount;
  }

  endSync(): number {
    this._closed = true;
    return this._byteCount;
  }

  async fail(reason?: Error): Promise<void> {
    this._closed = true;
  }

  failSync(reason?: Error): boolean {
    this._closed = true;
    return true;
  }

  getText(): string {
    const dec = new TextDecoder();
    return this.chunks.map((c) => dec.decode(c, { stream: true })).join('') + dec.decode();
  }
}

export class SyncMemoryWriter implements SyncWriter {
  private chunks: Uint8Array[] = [];
  private _closed = false;
  private _byteCount = 0;
  private enc = new TextEncoder();

  get desiredSize(): number | null {
    return this._closed ? null : 100;
  }

  write(chunk: Uint8Array | string): void {
    if (this._closed) throw new Error('Writer is closed');
    const bytes = typeof chunk === 'string' ? this.enc.encode(chunk) : chunk;
    this.chunks.push(bytes);
    this._byteCount += bytes.byteLength;
  }

  writev(chunks: (Uint8Array | string)[]): void {
    for (const chunk of chunks) {
      this.write(chunk);
    }
  }

  end(): number {
    this._closed = true;
    return this._byteCount;
  }

  fail(reason?: Error): void {
    this._closed = true;
  }

  getText(): string {
    const dec = new TextDecoder();
    return this.chunks.map((c) => dec.decode(c, { stream: true })).join('') + dec.decode();
  }
}
