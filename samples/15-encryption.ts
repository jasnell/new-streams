/**
 * Encryption and Decryption with Streams
 *
 * This file demonstrates using Node.js crypto APIs with the new Stream API
 * for streaming encryption and decryption (AES-256-GCM, AES-256-CBC, ChaCha20-Poly1305).
 *
 * Key patterns demonstrated:
 * - Using stateful transform objects with Stream.pull()
 * - Using async generators in transforms to yield encrypted data
 * - Handling encryption metadata (IV, auth tags) alongside streams
 * - Using Stream.pipeTo() and Stream.push() with encryption
 */

import { Stream, type TransformObject } from '../src/index.js';
import * as crypto from 'node:crypto';
import { section } from './util.js';
const enc = new TextEncoder();

// ============================================================================
// Helper: Copy chunk to owned buffer (handles detached ArrayBuffers)
// ============================================================================

function copyToBuffer(chunk: Uint8Array): Buffer {
  return Buffer.from(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
}

// ============================================================================
// Types
// ============================================================================

interface EncryptionParams {
  iv: Uint8Array;
  authTag?: Uint8Array;
}

interface EncryptTransformWithParams {
  transform: TransformObject;
  getParams: () => EncryptionParams;
}

// ============================================================================
// AES-256-GCM Encryption Transform Objects for Stream.pull()
// ============================================================================

/**
 * Create an AES-256-GCM encryption transform for use with Stream.pull().
 *
 * Returns both the transform object and a function to get encryption params.
 * Note: getParams() returns the auth tag only after the transform is flushed.
 *
 * Usage:
 *   const { transform, getParams } = createAes256GcmEncryptTransform(key);
 *   const ciphertext = await Stream.bytes(Stream.pull(source, transform));
 *   const { iv, authTag } = getParams();
 */
function createAes256GcmEncryptTransform(
  key: Uint8Array,
  aad?: Uint8Array
): EncryptTransformWithParams {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);

  const pending: Uint8Array[] = [];
  let error: Error | null = null;
  let authTag: Uint8Array | null = null;

  cipher.on('data', (chunk: Buffer) => {
    pending.push(new Uint8Array(chunk));
  });

  cipher.on('error', (err) => {
    error = err;
  });

  async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
    if (error) throw error;

    if (chunk === null) {
      // Flush: end cipher and get auth tag
      await new Promise<void>((resolve, reject) => {
        cipher.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      authTag = new Uint8Array(cipher.getAuthTag());
      return pending.splice(0);
    }

    // Encrypt chunk
    await new Promise<void>((resolve, reject) => {
      const ok = cipher.write(copyToBuffer(chunk), (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else cipher.once('drain', resolve);
    });

    return pending.splice(0);
  }

  const transform: TransformObject = {

    async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
      const onAbort = () => {
        cipher.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const batches of source) {
          if (batches === null) {
            const output = await processChunk(null);
            for (const chunk of output) {
              yield chunk;
            }
            continue;
          }
          for (const chunk of batches) {
            const output = await processChunk(chunk);
            for (const out of output) {
              yield out;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        cipher.destroy();
      }
    },
  };

  return {
    transform,
    getParams: () => ({
      iv: new Uint8Array(iv),
      authTag: authTag || undefined,
    }),
  };
}

/**
 * Create an AES-256-GCM decryption transform for use with Stream.pull().
 */
function createAes256GcmDecryptTransform(
  key: Uint8Array,
  params: EncryptionParams,
  aad?: Uint8Array
): TransformObject {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, params.iv);
  if (params.authTag) decipher.setAuthTag(params.authTag);
  if (aad) decipher.setAAD(aad);

  const pending: Uint8Array[] = [];
  let error: Error | null = null;

  decipher.on('data', (chunk: Buffer) => {
    pending.push(new Uint8Array(chunk));
  });

  decipher.on('error', (err) => {
    error = err;
  });

  async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
    if (error) throw error;

    if (chunk === null) {
      // Flush: verify auth tag
      await new Promise<void>((resolve, reject) => {
        decipher.end();
        decipher.once('error', reject);
        decipher.once('end', resolve);
      });

      if (error) throw error;
      return pending.splice(0);
    }

    await new Promise<void>((resolve, reject) => {
      const ok = decipher.write(copyToBuffer(chunk), (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else decipher.once('drain', resolve);
    });

    return pending.splice(0);
  }

  return {

    async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
      const onAbort = () => {
        decipher.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const batches of source) {
          if (batches === null) {
            const output = await processChunk(null);
            for (const chunk of output) {
              yield chunk;
            }
            continue;
          }
          for (const chunk of batches) {
            const output = await processChunk(chunk);
            for (const out of output) {
              yield out;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        decipher.destroy();
      }
    },
  };
}

// ============================================================================
// AES-256-CBC Transform Objects (for comparison)
// ============================================================================

function createAes256CbcEncryptTransform(key: Uint8Array): EncryptTransformWithParams {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

  const pending: Uint8Array[] = [];
  let error: Error | null = null;

  cipher.on('data', (chunk: Buffer) => {
    pending.push(new Uint8Array(chunk));
  });

  cipher.on('error', (err) => {
    error = err;
  });

  async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
    if (error) throw error;

    if (chunk === null) {
      await new Promise<void>((resolve, reject) => {
        cipher.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return pending.splice(0);
    }

    await new Promise<void>((resolve, reject) => {
      const ok = cipher.write(copyToBuffer(chunk), (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else cipher.once('drain', resolve);
    });

    return pending.splice(0);
  }

  const transform: TransformObject = {

    async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
      const onAbort = () => {
        cipher.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const batches of source) {
          if (batches === null) {
            const output = await processChunk(null);
            for (const chunk of output) {
              yield chunk;
            }
            continue;
          }
          for (const chunk of batches) {
            const output = await processChunk(chunk);
            for (const out of output) {
              yield out;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        cipher.destroy();
      }
    },
  };

  return {
    transform,
    getParams: () => ({ iv: new Uint8Array(iv) }),
  };
}

function createAes256CbcDecryptTransform(
  key: Uint8Array,
  params: EncryptionParams
): TransformObject {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, params.iv);

  const pending: Uint8Array[] = [];
  let error: Error | null = null;

  decipher.on('data', (chunk: Buffer) => {
    pending.push(new Uint8Array(chunk));
  });

  decipher.on('error', (err) => {
    error = err;
  });

  async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
    if (error) throw error;

    if (chunk === null) {
      await new Promise<void>((resolve, reject) => {
        decipher.end();
        decipher.once('error', reject);
        decipher.once('end', resolve);
      });

      if (error) throw error;
      return pending.splice(0);
    }

    await new Promise<void>((resolve, reject) => {
      const ok = decipher.write(copyToBuffer(chunk), (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else decipher.once('drain', resolve);
    });

    return pending.splice(0);
  }

  return {

    async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
      const onAbort = () => {
        decipher.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const batches of source) {
          if (batches === null) {
            const output = await processChunk(null);
            for (const chunk of output) {
              yield chunk;
            }
            continue;
          }
          for (const chunk of batches) {
            const output = await processChunk(chunk);
            for (const out of output) {
              yield out;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        decipher.destroy();
      }
    },
  };
}

// ============================================================================
// ChaCha20-Poly1305 Transform Objects
// ============================================================================

function createChaCha20Poly1305EncryptTransform(
  key: Uint8Array,
  aad?: Uint8Array
): EncryptTransformWithParams {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
  if (aad) (cipher as crypto.CipherGCM).setAAD(aad);

  const pending: Uint8Array[] = [];
  let error: Error | null = null;
  let authTag: Uint8Array | null = null;

  cipher.on('data', (chunk: Buffer) => {
    pending.push(new Uint8Array(chunk));
  });

  cipher.on('error', (err) => {
    error = err;
  });

  async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
    if (error) throw error;

    if (chunk === null) {
      await new Promise<void>((resolve, reject) => {
        cipher.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      authTag = new Uint8Array(cipher.getAuthTag());
      return pending.splice(0);
    }

    await new Promise<void>((resolve, reject) => {
      const ok = cipher.write(copyToBuffer(chunk), (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else cipher.once('drain', resolve);
    });

    return pending.splice(0);
  }

  const transform: TransformObject = {

    async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
      const onAbort = () => {
        cipher.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const batches of source) {
          if (batches === null) {
            const output = await processChunk(null);
            for (const chunk of output) {
              yield chunk;
            }
            continue;
          }
          for (const chunk of batches) {
            const output = await processChunk(chunk);
            for (const out of output) {
              yield out;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        cipher.destroy();
      }
    },
  };

  return {
    transform,
    getParams: () => ({
      iv: new Uint8Array(iv),
      authTag: authTag || undefined,
    }),
  };
}

function createChaCha20Poly1305DecryptTransform(
  key: Uint8Array,
  params: EncryptionParams,
  aad?: Uint8Array
): TransformObject {
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, params.iv, { authTagLength: 16 });
  if (params.authTag) decipher.setAuthTag(params.authTag);
  if (aad) (decipher as crypto.DecipherGCM).setAAD(aad);

  const pending: Uint8Array[] = [];
  let error: Error | null = null;

  decipher.on('data', (chunk: Buffer) => {
    pending.push(new Uint8Array(chunk));
  });

  decipher.on('error', (err) => {
    error = err;
  });

  async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
    if (error) throw error;

    if (chunk === null) {
      await new Promise<void>((resolve, reject) => {
        decipher.end();
        decipher.once('error', reject);
        decipher.once('end', resolve);
      });

      if (error) throw error;
      return pending.splice(0);
    }

    await new Promise<void>((resolve, reject) => {
      const ok = decipher.write(copyToBuffer(chunk), (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else decipher.once('drain', resolve);
    });

    return pending.splice(0);
  }

  return {

    async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
      const onAbort = () => {
        decipher.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const batches of source) {
          if (batches === null) {
            const output = await processChunk(null);
            for (const chunk of output) {
              yield chunk;
            }
            continue;
          }
          for (const chunk of batches) {
            const output = await processChunk(chunk);
            for (const out of output) {
              yield out;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        decipher.destroy();
      }
    },
  };
}

// ============================================================================
// Key Derivation
// ============================================================================

function deriveKey(password: string, salt: Uint8Array, iterations = 100000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(new Uint8Array(key));
    });
  });
}

// ============================================================================
// Helper: Hex encoding
// ============================================================================

function toHex(data: Uint8Array): string {
  return Buffer.from(data).toString('hex');
}

// ============================================================================
// Main Examples
// ============================================================================

async function main() {
  // ============================================================================
  // Example 1: Basic Stream.pull() with encryption
  // ============================================================================
  section('Example 1: Stream.pull() with AES-256-GCM');

  {
    const key = crypto.randomBytes(32);
    const plaintext = 'Hello, this is secret data encrypted with Stream.pull()!';

    // Create encrypt transform
    const { transform: encryptTransform, getParams } = createAes256GcmEncryptTransform(key);

    // Encrypt using Stream.pull with transform
    const ciphertext = await Stream.bytes(
      Stream.pull(Stream.from(plaintext), encryptTransform)
    );

    const params = getParams();
    console.log('Plaintext:', plaintext.length, 'bytes');
    console.log('Ciphertext:', ciphertext.length, 'bytes');
    console.log('IV:', toHex(params.iv));
    console.log('Auth tag:', toHex(params.authTag!));

    // Decrypt using Stream.pull with transform
    const decrypted = await Stream.text(
      Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(key, params))
    );

    console.log('Decrypted:', decrypted);
    console.log('Round-trip successful:', decrypted === plaintext);
  }

  // ============================================================================
  // Example 2: Chained compression + encryption
  // ============================================================================
  section('Example 2: Chained Compression + Encryption');

  {
    const key = crypto.randomBytes(32);
    const zlib = await import('node:zlib');

    // Import compression transform
    function createGzipTransform(): TransformObject {
      const gzip = zlib.createGzip();
      const pending: Uint8Array[] = [];
      let error: Error | null = null;

      gzip.on('data', (chunk: Buffer) => pending.push(new Uint8Array(chunk)));
      gzip.on('error', (err) => { error = err; });

      async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
        if (error) throw error;
        if (chunk === null) {
          await new Promise<void>((resolve, reject) => {
            gzip.once('end', resolve);
            gzip.once('error', reject);
            gzip.end();
          });
          return pending.splice(0);
        }
        await new Promise<void>((resolve, reject) => {
          gzip.write(copyToBuffer(chunk), (err) => {
            if (err) { reject(err); return; }
            gzip.flush(() => resolve());
          });
        });
        return pending.splice(0);
      }

      return {

        async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
          const onAbort = () => {
            gzip.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            for await (const batches of source) {
              if (batches === null) {
                const output = await processChunk(null);
                for (const chunk of output) yield chunk;
                continue;
              }
              for (const chunk of batches) {
                const output = await processChunk(chunk);
                for (const out of output) yield out;
              }
            }
          } finally {
            signal.removeEventListener('abort', onAbort);
            gzip.destroy();
          }
        },
      };
    }

    function createGunzipTransform(): TransformObject {
      const gunzip = zlib.createGunzip();
      const pending: Uint8Array[] = [];
      let error: Error | null = null;

      gunzip.on('data', (chunk: Buffer) => pending.push(new Uint8Array(chunk)));
      gunzip.on('error', (err) => { error = err; });

      async function processChunk(chunk: Uint8Array | null): Promise<Uint8Array[]> {
        if (error) throw error;
        if (chunk === null) {
          await new Promise<void>((resolve, reject) => {
            gunzip.once('end', resolve);
            gunzip.once('error', reject);
            gunzip.end();
          });
          return pending.splice(0);
        }
        await new Promise<void>((resolve, reject) => {
          gunzip.write(copyToBuffer(chunk), (err) => {
            if (err) { reject(err); return; }
            gunzip.flush(() => resolve());
          });
        });
        return pending.splice(0);
      }

      return {

        async *transform(source: AsyncIterable<Uint8Array[] | null>, { signal }: { signal: AbortSignal }) {
          const onAbort = () => {
            gunzip.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            for await (const batches of source) {
              if (batches === null) {
                const output = await processChunk(null);
                for (const chunk of output) yield chunk;
                continue;
              }
              for (const chunk of batches) {
                const output = await processChunk(chunk);
                for (const out of output) yield out;
              }
            }
          } finally {
            signal.removeEventListener('abort', onAbort);
            gunzip.destroy();
          }
        },
      };
    }

    const plaintext = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({ id: i, data: 'x'.repeat(100) }))
    );

    console.log('Original size:', plaintext.length, 'bytes');

    // Compress first, then encrypt
    const compressed = await Stream.bytes(
      Stream.pull(Stream.from(plaintext), createGzipTransform())
    );
    console.log('Compressed size:', compressed.length, 'bytes');

    const { transform: encryptTransform, getParams } = createAes256GcmEncryptTransform(key);
    const processed = await Stream.bytes(
      Stream.pull(Stream.from(compressed), encryptTransform)
    );

    const params = getParams();
    console.log('Compressed + Encrypted:', processed.length, 'bytes');

    // Decrypt first, then decompress
    const decrypted = await Stream.bytes(
      Stream.pull(Stream.from(processed), createAes256GcmDecryptTransform(key, params))
    );

    const recovered = await Stream.text(
      Stream.pull(Stream.from(decrypted), createGunzipTransform())
    );

    console.log('Recovered size:', recovered.length, 'bytes');
    console.log('Round-trip successful:', recovered === plaintext);
  }

  // ============================================================================
  // Example 3: Stream.push() with encryption
  // ============================================================================
  section('Example 3: Stream.push() with Encryption');

  {
    const key = crypto.randomBytes(32);
    const { transform: encryptTransform, getParams } = createAes256GcmEncryptTransform(key);

    // Create push stream and apply encryption via pull
    const { writer, readable } = Stream.push();
    const encryptedOutput = Stream.pull(readable, encryptTransform);

    // Write data to the push stream
    const writePromise = (async () => {
      await writer.write('Secret message part 1\n');
      await writer.write('Secret message part 2\n');
      await writer.write('Secret message part 3\n');
      await writer.end();
    })();

    // Read encrypted output
    const ciphertext = await Stream.bytes(encryptedOutput);
    await writePromise;

    const params = getParams();
    console.log('Encrypted via Stream.push():', ciphertext.length, 'bytes');

    // Decrypt
    const decrypted = await Stream.text(
      Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(key, params))
    );

    console.log('Decrypted:\n' + decrypted.trim());
  }

  // ============================================================================
  // Example 4: Generator source with encryption
  // ============================================================================
  section('Example 4: Generator Source with Encryption');

  {
    const key = crypto.randomBytes(32);

    // Create encrypt transform
    const { transform: encryptTransform, getParams } = createAes256GcmEncryptTransform(key);

    // Generator source
    async function* generateRecords() {
      for (let i = 0; i < 5; i++) {
        yield `Sensitive record ${i}: SSN=XXX-XX-${1000 + i}\n`;
      }
    }

    // Encrypt the generated data
    const ciphertext = await Stream.bytes(
      Stream.pull(Stream.from(generateRecords()), encryptTransform)
    );

    const params = getParams();
    console.log('Encrypted via generator:', ciphertext.length, 'bytes');

    // Verify by decrypting
    const decrypted = await Stream.text(
      Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(key, params))
    );

    console.log('Decrypted records:\n' + decrypted);
  }

  // ============================================================================
  // Example 5: Comparing algorithms with Stream.pull()
  // ============================================================================
  section('Example 5: Comparing Encryption Algorithms');

  {
    const key = crypto.randomBytes(32);
    const plaintext = 'Test data for algorithm comparison '.repeat(1000);

    console.log('Plaintext size:', plaintext.length, 'bytes\n');

    // AES-256-GCM
    {
      const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key);
      const startEnc = performance.now();
      const ciphertext = await Stream.bytes(Stream.pull(Stream.from(plaintext), encrypt));
      const encTime = performance.now() - startEnc;

      const params = getParams();
      const startDec = performance.now();
      const decrypted = await Stream.text(
        Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(key, params))
      );
      const decTime = performance.now() - startDec;

      console.log('AES-256-GCM:');
      console.log(`  Ciphertext: ${ciphertext.length} bytes`);
      console.log(`  Encrypt: ${encTime.toFixed(2)}ms, Decrypt: ${decTime.toFixed(2)}ms`);
      console.log(`  Valid: ${decrypted === plaintext}`);
    }

    // AES-256-CBC
    {
      const { transform: encrypt, getParams } = createAes256CbcEncryptTransform(key);
      const startEnc = performance.now();
      const ciphertext = await Stream.bytes(Stream.pull(Stream.from(plaintext), encrypt));
      const encTime = performance.now() - startEnc;

      const params = getParams();
      const startDec = performance.now();
      const decrypted = await Stream.text(
        Stream.pull(Stream.from(ciphertext), createAes256CbcDecryptTransform(key, params))
      );
      const decTime = performance.now() - startDec;

      console.log('AES-256-CBC:');
      console.log(`  Ciphertext: ${ciphertext.length} bytes`);
      console.log(`  Encrypt: ${encTime.toFixed(2)}ms, Decrypt: ${decTime.toFixed(2)}ms`);
      console.log(`  Valid: ${decrypted === plaintext}`);
      console.log('  (Note: CBC does NOT provide authentication!)');
    }

    // ChaCha20-Poly1305
    {
      const { transform: encrypt, getParams } = createChaCha20Poly1305EncryptTransform(key);
      const startEnc = performance.now();
      const ciphertext = await Stream.bytes(Stream.pull(Stream.from(plaintext), encrypt));
      const encTime = performance.now() - startEnc;

      const params = getParams();
      const startDec = performance.now();
      const decrypted = await Stream.text(
        Stream.pull(Stream.from(ciphertext), createChaCha20Poly1305DecryptTransform(key, params))
      );
      const decTime = performance.now() - startDec;

      console.log('ChaCha20-Poly1305:');
      console.log(`  Ciphertext: ${ciphertext.length} bytes`);
      console.log(`  Encrypt: ${encTime.toFixed(2)}ms, Decrypt: ${decTime.toFixed(2)}ms`);
      console.log(`  Valid: ${decrypted === plaintext}`);
    }
  }

  // ============================================================================
  // Example 6: AAD with Stream.pull()
  // ============================================================================
  section('Example 6: Additional Authenticated Data (AAD)');

  {
    const key = crypto.randomBytes(32);
    const aad = enc.encode(JSON.stringify({
      messageId: 'msg-123',
      sender: 'alice@example.com',
    }));

    const plaintext = 'Message content protected with AAD';

    // Encrypt with AAD
    const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key, aad);
    const ciphertext = await Stream.bytes(Stream.pull(Stream.from(plaintext), encrypt));
    const params = getParams();

    console.log('Encrypted with AAD:', ciphertext.length, 'bytes');

    // Decrypt with correct AAD
    const decrypted = await Stream.text(
      Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(key, params, aad))
    );

    console.log('Decrypted:', decrypted);

    // Try with wrong AAD
    const wrongAad = enc.encode('{"messageId": "wrong"}');
    try {
      await Stream.text(
        Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(key, params, wrongAad))
      );
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Wrong AAD rejected:', (error as Error).message);
    }
  }

  // ============================================================================
  // Example 7: Error Handling with Transform Signal
  // ============================================================================
  section('Example 7: Error Handling');

  {
    const key = crypto.randomBytes(32);

    // Encrypt some data
    const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key);
    const ciphertext = await Stream.bytes(Stream.pull(Stream.from('Secret message'), encrypt));
    const params = getParams();

    // Tamper with ciphertext
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;

    try {
      await Stream.text(
        Stream.pull(Stream.from(tampered), createAes256GcmDecryptTransform(key, params))
      );
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Tampering detected:', (error as Error).message);
    }

    // Wrong key
    const wrongKey = crypto.randomBytes(32);
    try {
      await Stream.text(
        Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(wrongKey, params))
      );
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Wrong key detected:', (error as Error).message);
    }
  }

  // ============================================================================
  // Example 8: Stream.share() with encrypted branch
  // ============================================================================
  section('Example 8: Stream.share() with Encrypted Branch');

  {
    const key = crypto.randomBytes(32);
    const source = Stream.from('Data to be both logged plaintext and stored encrypted');

    // Create a shared source
    const shared = Stream.share(source);

    // Create encrypt transform
    const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key);

    // Create two consumers - raw and encrypted
    const rawConsumer = shared.pull();
    // Apply encryption transform directly on pull (transforms applied lazily when consumer pulls)
    const encryptedConsumer = shared.pull(encrypt);

    // Process both in parallel
    const [plainResult, encryptedResult] = await Promise.all([
      Stream.text(rawConsumer),
      Stream.bytes(encryptedConsumer),
    ]);

    const params = getParams();
    console.log('Plain branch:', plainResult.length, 'bytes');
    console.log('Encrypted branch:', encryptedResult.length, 'bytes');

    // Verify encrypted branch
    const decrypted = await Stream.text(
      Stream.pull(Stream.from(encryptedResult), createAes256GcmDecryptTransform(key, params))
    );

    console.log('Encrypted branch decrypts to original:', decrypted === plainResult);
  }

  // ============================================================================
  // Example 9: Stream.pipeTo() with encryption
  // ============================================================================
  section('Example 9: Stream.pipeTo() with Encryption');

  {
    const key = crypto.randomBytes(32);
    const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key);

    // Create push stream for output
    const { writer, readable } = Stream.push();

    // Create encryption pipeline reading from the push stream's readable
    const encryptedOutput = Stream.pull(readable, encrypt);

    // Use pipeTo to send data to the push stream's writer
    const source = Stream.from('Data sent via pipeTo() through encryption transform');
    const writePromise = Stream.pipeTo(source, writer);

    // Collect encrypted output
    const ciphertext = await Stream.bytes(encryptedOutput);
    await writePromise;

    const params = getParams();
    console.log('Encrypted via pipeTo():', ciphertext.length, 'bytes');

    // Verify
    const decrypted = await Stream.text(
      Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(key, params))
    );

    console.log('Decrypted:', decrypted);
  }

  // ============================================================================
  // Example 10: Password-based encryption with Stream.pull()
  // ============================================================================
  section('Example 10: Password-based Encryption');

  {
    const password = 'user-secret-password';
    const salt = crypto.randomBytes(16);
    const key = await deriveKey(password, salt);

    const plaintext = 'Sensitive user data protected by password';

    // Encrypt with derived key
    const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key);
    const ciphertext = await Stream.bytes(Stream.pull(Stream.from(plaintext), encrypt));
    const params = getParams();

    console.log('Salt:', toHex(salt));
    console.log('IV:', toHex(params.iv));
    console.log('Ciphertext:', ciphertext.length, 'bytes');

    // Decrypt with same password
    const derivedKey = await deriveKey(password, salt);
    const decrypted = await Stream.text(
      Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(derivedKey, params))
    );

    console.log('Decrypted:', decrypted);

    // Wrong password fails
    const wrongKey = await deriveKey('wrong-password', salt);
    try {
      await Stream.text(
        Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(wrongKey, params))
      );
      console.log('ERROR: Should have thrown!');
    } catch {
      console.log('Wrong password rejected');
    }
  }

  // ============================================================================
  // Example 11: Message envelope with Stream.pull()
  // ============================================================================
  section('Example 11: Complete Message Envelope');

  {
    // Envelope format: [salt:16][iv:12][ciphertext:n][authTag:16]

    async function encryptMessage(password: string, plaintext: string): Promise<Uint8Array> {
      const salt = crypto.randomBytes(16);
      const key = await deriveKey(password, salt);

      const { transform, getParams } = createAes256GcmEncryptTransform(key);
      const ciphertext = await Stream.bytes(Stream.pull(Stream.from(plaintext), transform));
      const params = getParams();

      // Build envelope
      const envelope = new Uint8Array(16 + 12 + ciphertext.length + 16);
      envelope.set(salt, 0);
      envelope.set(params.iv, 16);
      envelope.set(ciphertext, 28);
      envelope.set(params.authTag!, 28 + ciphertext.length);

      return envelope;
    }

    async function decryptMessage(password: string, envelope: Uint8Array): Promise<string> {
      const salt = envelope.slice(0, 16);
      const iv = envelope.slice(16, 28);
      const ciphertext = envelope.slice(28, envelope.length - 16);
      const authTag = envelope.slice(envelope.length - 16);

      const key = await deriveKey(password, salt);

      return Stream.text(
        Stream.pull(Stream.from(ciphertext), createAes256GcmDecryptTransform(key, { iv, authTag }))
      );
    }

    const password = 'my-secret';
    const message = 'Complete encrypted message using Stream.pull()!';

    const envelope = await encryptMessage(password, message);
    console.log('Envelope size:', envelope.length, 'bytes');

    const decrypted = await decryptMessage(password, envelope);
    console.log('Decrypted:', decrypted);
    console.log('Success:', decrypted === message);
  }

  console.log('\n--- Encryption Examples Complete! ---\n');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
