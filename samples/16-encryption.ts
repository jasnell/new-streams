/**
 * Encryption and Decryption with Streams
 *
 * This file demonstrates using Node.js crypto APIs with the new Stream API
 * for streaming encryption and decryption (AES-256-GCM, AES-256-CBC, ChaCha20-Poly1305).
 *
 * Key patterns demonstrated:
 * - Using stateful transform objects with pipeThrough()
 * - Using async generators in transforms to yield encrypted data
 * - Handling encryption metadata (IV, auth tags) alongside streams
 * - Using pipeTo() and Stream.pipeline() with encryption
 */

import { Stream } from '../src/stream.js';
import type { StreamTransformerObject } from '../src/types.js';
import * as crypto from 'node:crypto';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

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
  transform: StreamTransformerObject;
  getParams: () => EncryptionParams;
}

// ============================================================================
// AES-256-GCM Encryption Transform Objects for pipeThrough()
// ============================================================================

/**
 * Create an AES-256-GCM encryption transform for use with pipeThrough().
 *
 * Returns both the transform object and a function to get encryption params.
 * Note: getParams() returns the auth tag only after the transform is flushed.
 *
 * Usage:
 *   const { transform, getParams } = createAes256GcmEncryptTransform(key);
 *   const ciphertext = await stream.pipeThrough(transform).bytes();
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

  const transform: StreamTransformerObject = {
    async *transform(chunk: Uint8Array | null) {
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

        while (pending.length > 0) {
          yield pending.shift()!;
        }
        return;
      }

      // Encrypt chunk
      const writeComplete = new Promise<void>((resolve, reject) => {
        const ok = cipher.write(copyToBuffer(chunk), (err) => {
          if (err) reject(err);
        });
        if (ok) resolve();
        else cipher.once('drain', resolve);
      });

      await writeComplete;

      while (pending.length > 0) {
        yield pending.shift()!;
      }
    },

    abort(reason) {
      cipher.destroy(reason instanceof Error ? reason : new Error(String(reason)));
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
 * Create an AES-256-GCM decryption transform for use with pipeThrough().
 */
function createAes256GcmDecryptTransform(
  key: Uint8Array,
  params: EncryptionParams,
  aad?: Uint8Array
): StreamTransformerObject {
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

  return {
    async *transform(chunk: Uint8Array | null) {
      if (error) throw error;

      if (chunk === null) {
        // Flush: verify auth tag
        await new Promise<void>((resolve, reject) => {
          decipher.end();
          decipher.once('error', reject);
          decipher.once('end', resolve);
        });

        if (error) throw error;

        while (pending.length > 0) {
          yield pending.shift()!;
        }
        return;
      }

      const writeComplete = new Promise<void>((resolve, reject) => {
        const ok = decipher.write(copyToBuffer(chunk), (err) => {
          if (err) reject(err);
        });
        if (ok) resolve();
        else decipher.once('drain', resolve);
      });

      await writeComplete;

      while (pending.length > 0) {
        yield pending.shift()!;
      }
    },

    abort(reason) {
      decipher.destroy(reason instanceof Error ? reason : new Error(String(reason)));
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

  const transform: StreamTransformerObject = {
    async *transform(chunk: Uint8Array | null) {
      if (error) throw error;

      if (chunk === null) {
        await new Promise<void>((resolve, reject) => {
          cipher.end((err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });

        while (pending.length > 0) {
          yield pending.shift()!;
        }
        return;
      }

      const writeComplete = new Promise<void>((resolve, reject) => {
        const ok = cipher.write(copyToBuffer(chunk), (err) => {
          if (err) reject(err);
        });
        if (ok) resolve();
        else cipher.once('drain', resolve);
      });

      await writeComplete;

      while (pending.length > 0) {
        yield pending.shift()!;
      }
    },

    abort(reason) {
      cipher.destroy(reason instanceof Error ? reason : new Error(String(reason)));
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
): StreamTransformerObject {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, params.iv);

  const pending: Uint8Array[] = [];
  let error: Error | null = null;

  decipher.on('data', (chunk: Buffer) => {
    pending.push(new Uint8Array(chunk));
  });

  decipher.on('error', (err) => {
    error = err;
  });

  return {
    async *transform(chunk: Uint8Array | null) {
      if (error) throw error;

      if (chunk === null) {
        await new Promise<void>((resolve, reject) => {
          decipher.end();
          decipher.once('error', reject);
          decipher.once('end', resolve);
        });

        if (error) throw error;

        while (pending.length > 0) {
          yield pending.shift()!;
        }
        return;
      }

      const writeComplete = new Promise<void>((resolve, reject) => {
        const ok = decipher.write(copyToBuffer(chunk), (err) => {
          if (err) reject(err);
        });
        if (ok) resolve();
        else decipher.once('drain', resolve);
      });

      await writeComplete;

      while (pending.length > 0) {
        yield pending.shift()!;
      }
    },

    abort(reason) {
      decipher.destroy(reason instanceof Error ? reason : new Error(String(reason)));
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

  const transform: StreamTransformerObject = {
    async *transform(chunk: Uint8Array | null) {
      if (error) throw error;

      if (chunk === null) {
        await new Promise<void>((resolve, reject) => {
          cipher.end((err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });

        authTag = new Uint8Array(cipher.getAuthTag());

        while (pending.length > 0) {
          yield pending.shift()!;
        }
        return;
      }

      const writeComplete = new Promise<void>((resolve, reject) => {
        const ok = cipher.write(copyToBuffer(chunk), (err) => {
          if (err) reject(err);
        });
        if (ok) resolve();
        else cipher.once('drain', resolve);
      });

      await writeComplete;

      while (pending.length > 0) {
        yield pending.shift()!;
      }
    },

    abort(reason) {
      cipher.destroy(reason instanceof Error ? reason : new Error(String(reason)));
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
): StreamTransformerObject {
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, params.iv, { authTagLength: 16 });
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

  return {
    async *transform(chunk: Uint8Array | null) {
      if (error) throw error;

      if (chunk === null) {
        await new Promise<void>((resolve, reject) => {
          decipher.end();
          decipher.once('error', reject);
          decipher.once('end', resolve);
        });

        if (error) throw error;

        while (pending.length > 0) {
          yield pending.shift()!;
        }
        return;
      }

      const writeComplete = new Promise<void>((resolve, reject) => {
        const ok = decipher.write(copyToBuffer(chunk), (err) => {
          if (err) reject(err);
        });
        if (ok) resolve();
        else decipher.once('drain', resolve);
      });

      await writeComplete;

      while (pending.length > 0) {
        yield pending.shift()!;
      }
    },

    abort(reason) {
      decipher.destroy(reason instanceof Error ? reason : new Error(String(reason)));
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
  // Example 1: Basic pipeThrough() with encryption
  // ============================================================================
  section('Example 1: pipeThrough() with AES-256-GCM');

  {
    const key = crypto.randomBytes(32);
    const plaintext = 'Hello, this is secret data encrypted with pipeThrough()!';

    // Create encrypt transform
    const { transform: encryptTransform, getParams } = createAes256GcmEncryptTransform(key);

    // Encrypt using pipeThrough
    const ciphertext = await Stream.from(plaintext)
      .pipeThrough(encryptTransform)
      .bytes();

    const params = getParams();
    console.log('Plaintext:', plaintext.length, 'bytes');
    console.log('Ciphertext:', ciphertext.length, 'bytes');
    console.log('IV:', toHex(params.iv));
    console.log('Auth tag:', toHex(params.authTag!));

    // Decrypt using pipeThrough
    const decrypted = await Stream.from(ciphertext)
      .pipeThrough(createAes256GcmDecryptTransform(key, params))
      .text();

    console.log('Decrypted:', decrypted);
    console.log('Round-trip successful:', decrypted === plaintext);
  }

  // ============================================================================
  // Example 2: Chained pipeThrough() with compression + encryption
  // ============================================================================
  section('Example 2: Chained Compression + Encryption');

  {
    const key = crypto.randomBytes(32);
    const zlib = await import('node:zlib');

    // Import compression transform from earlier pattern
    // Uses 'end' event (not 'finish') because 'end' fires AFTER final data is emitted
    function createGzipTransform(): StreamTransformerObject {
      const gzip = zlib.createGzip();
      const pending: Uint8Array[] = [];
      let error: Error | null = null;

      gzip.on('data', (chunk: Buffer) => pending.push(new Uint8Array(chunk)));
      gzip.on('error', (err) => { error = err; });

      return {
        async *transform(chunk: Uint8Array | null) {
          if (error) throw error;
          if (chunk === null) {
            // Wait for 'end' event (fires after all data emitted)
            await new Promise<void>((resolve, reject) => {
              gzip.once('end', resolve);
              gzip.once('error', reject);
              gzip.end();
            });
            while (pending.length > 0) yield pending.shift()!;
            return;
          }
          // Write then flush to force output
          await new Promise<void>((resolve, reject) => {
            gzip.write(copyToBuffer(chunk), (err) => {
              if (err) { reject(err); return; }
              gzip.flush(() => resolve());
            });
          });
          while (pending.length > 0) yield pending.shift()!;
        },
        abort(reason) {
          gzip.destroy(reason instanceof Error ? reason : new Error(String(reason)));
        },
      };
    }

    function createGunzipTransform(): StreamTransformerObject {
      const gunzip = zlib.createGunzip();
      const pending: Uint8Array[] = [];
      let error: Error | null = null;

      gunzip.on('data', (chunk: Buffer) => pending.push(new Uint8Array(chunk)));
      gunzip.on('error', (err) => { error = err; });

      return {
        async *transform(chunk: Uint8Array | null) {
          if (error) throw error;
          if (chunk === null) {
            // Wait for 'end' event (fires after all data emitted)
            await new Promise<void>((resolve, reject) => {
              gunzip.once('end', resolve);
              gunzip.once('error', reject);
              gunzip.end();
            });
            while (pending.length > 0) yield pending.shift()!;
            return;
          }
          // Write then flush to force output
          await new Promise<void>((resolve, reject) => {
            gunzip.write(copyToBuffer(chunk), (err) => {
              if (err) { reject(err); return; }
              gunzip.flush(() => resolve());
            });
          });
          while (pending.length > 0) yield pending.shift()!;
        },
        abort(reason) {
          gunzip.destroy(reason instanceof Error ? reason : new Error(String(reason)));
        },
      };
    }

    const plaintext = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({ id: i, data: 'x'.repeat(100) }))
    );

    console.log('Original size:', plaintext.length, 'bytes');

    // Chain: compress -> encrypt
    const { transform: encryptTransform, getParams } = createAes256GcmEncryptTransform(key);

    const processed = await Stream.from(plaintext)
      .pipeThrough(createGzipTransform())   // Compress first
      .pipeThrough(encryptTransform)         // Then encrypt
      .bytes();

    const params = getParams();
    console.log('Compressed + Encrypted:', processed.length, 'bytes');

    // Chain: decrypt -> decompress
    const recovered = await Stream.from(processed)
      .pipeThrough(createAes256GcmDecryptTransform(key, params))
      .pipeThrough(createGunzipTransform())
      .text();

    console.log('Recovered size:', recovered.length, 'bytes');
    console.log('Round-trip successful:', recovered === plaintext);
  }

  // ============================================================================
  // Example 3: Stream.transform() with encryption
  // ============================================================================
  section('Example 3: Stream.transform() with Encryption');

  {
    const key = crypto.randomBytes(32);
    const { transform: encryptTransform, getParams } = createAes256GcmEncryptTransform(key);

    // Create transform pair
    const { stream: encryptedOutput, writer: inputWriter } = Stream.transform(encryptTransform);

    // Write data to the transform
    const writePromise = (async () => {
      await inputWriter.write('Secret message part 1\n');
      await inputWriter.write('Secret message part 2\n');
      await inputWriter.write('Secret message part 3\n');
      await inputWriter.close();
    })();

    // Read encrypted output
    const ciphertext = await encryptedOutput.bytes();
    await writePromise;

    const params = getParams();
    console.log('Encrypted via Stream.transform():', ciphertext.length, 'bytes');

    // Decrypt
    const decrypted = await Stream.from(ciphertext)
      .pipeThrough(createAes256GcmDecryptTransform(key, params))
      .text();

    console.log('Decrypted:\n' + decrypted.trim());
  }

  // ============================================================================
  // Example 4: Stream.pipeline() with encryption
  // ============================================================================
  section('Example 4: Stream.pipeline() with Encryption');

  {
    const key = crypto.randomBytes(32);

    // Source generates sensitive data
    const source = Stream.pull(async function* () {
      for (let i = 0; i < 5; i++) {
        yield `Sensitive record ${i}: SSN=XXX-XX-${1000 + i}\n`;
      }
    });

    // Collector destination
    const chunks: Uint8Array[] = [];
    const collector = Stream.writer({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });

    // Create encrypt transform
    const { transform: encryptTransform, getParams } = createAes256GcmEncryptTransform(key);

    // Run pipeline
    await Stream.pipeline(source, encryptTransform, collector);

    const params = getParams();
    const ciphertext = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      ciphertext.set(chunk, offset);
      offset += chunk.length;
    }

    console.log('Encrypted via pipeline:', ciphertext.length, 'bytes');

    // Verify by decrypting
    const decrypted = await Stream.from(ciphertext)
      .pipeThrough(createAes256GcmDecryptTransform(key, params))
      .text();

    console.log('Decrypted records:\n' + decrypted);
  }

  // ============================================================================
  // Example 5: Comparing algorithms with pipeThrough()
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
      const ciphertext = await Stream.from(plaintext).pipeThrough(encrypt).bytes();
      const encTime = performance.now() - startEnc;

      const params = getParams();
      const startDec = performance.now();
      const decrypted = await Stream.from(ciphertext)
        .pipeThrough(createAes256GcmDecryptTransform(key, params))
        .text();
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
      const ciphertext = await Stream.from(plaintext).pipeThrough(encrypt).bytes();
      const encTime = performance.now() - startEnc;

      const params = getParams();
      const startDec = performance.now();
      const decrypted = await Stream.from(ciphertext)
        .pipeThrough(createAes256CbcDecryptTransform(key, params))
        .text();
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
      const ciphertext = await Stream.from(plaintext).pipeThrough(encrypt).bytes();
      const encTime = performance.now() - startEnc;

      const params = getParams();
      const startDec = performance.now();
      const decrypted = await Stream.from(ciphertext)
        .pipeThrough(createChaCha20Poly1305DecryptTransform(key, params))
        .text();
      const decTime = performance.now() - startDec;

      console.log('ChaCha20-Poly1305:');
      console.log(`  Ciphertext: ${ciphertext.length} bytes`);
      console.log(`  Encrypt: ${encTime.toFixed(2)}ms, Decrypt: ${decTime.toFixed(2)}ms`);
      console.log(`  Valid: ${decrypted === plaintext}`);
    }
  }

  // ============================================================================
  // Example 6: AAD with pipeThrough()
  // ============================================================================
  section('Example 6: Additional Authenticated Data (AAD)');

  {
    const key = crypto.randomBytes(32);
    const aad = new TextEncoder().encode(JSON.stringify({
      messageId: 'msg-123',
      sender: 'alice@example.com',
    }));

    const plaintext = 'Message content protected with AAD';

    // Encrypt with AAD
    const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key, aad);
    const ciphertext = await Stream.from(plaintext).pipeThrough(encrypt).bytes();
    const params = getParams();

    console.log('Encrypted with AAD:', ciphertext.length, 'bytes');

    // Decrypt with correct AAD
    const decrypted = await Stream.from(ciphertext)
      .pipeThrough(createAes256GcmDecryptTransform(key, params, aad))
      .text();

    console.log('Decrypted:', decrypted);

    // Try with wrong AAD
    const wrongAad = new TextEncoder().encode('{"messageId": "wrong"}');
    try {
      await Stream.from(ciphertext)
        .pipeThrough(createAes256GcmDecryptTransform(key, params, wrongAad))
        .text();
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Wrong AAD rejected:', (error as Error).message);
    }
  }

  // ============================================================================
  // Example 7: Error handling with transform abort()
  // ============================================================================
  section('Example 7: Error Handling');

  {
    const key = crypto.randomBytes(32);

    // Encrypt some data
    const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key);
    const ciphertext = await Stream.from('Secret message').pipeThrough(encrypt).bytes();
    const params = getParams();

    // Tamper with ciphertext
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;

    try {
      await Stream.from(tampered)
        .pipeThrough(createAes256GcmDecryptTransform(key, params))
        .text();
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Tampering detected:', (error as Error).message);
    }

    // Wrong key
    const wrongKey = crypto.randomBytes(32);
    try {
      await Stream.from(ciphertext)
        .pipeThrough(createAes256GcmDecryptTransform(wrongKey, params))
        .text();
      console.log('ERROR: Should have thrown!');
    } catch (error) {
      console.log('Wrong key detected:', (error as Error).message);
    }
  }

  // ============================================================================
  // Example 8: tee() with encryption branch
  // ============================================================================
  section('Example 8: tee() with Encrypted Branch');

  {
    const key = crypto.randomBytes(32);
    const source = Stream.from('Data to be both logged plaintext and stored encrypted');

    // Create a branch for encryption
    const encryptedBranch = source.tee();

    // Create encrypt transform
    const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key);

    // Process both in parallel
    const [plainResult, encryptedResult] = await Promise.all([
      source.text(),
      encryptedBranch.pipeThrough(encrypt).bytes(),
    ]);

    const params = getParams();
    console.log('Plain branch:', plainResult.length, 'bytes');
    console.log('Encrypted branch:', encryptedResult.length, 'bytes');

    // Verify encrypted branch
    const decrypted = await Stream.from(encryptedResult)
      .pipeThrough(createAes256GcmDecryptTransform(key, params))
      .text();

    console.log('Encrypted branch decrypts to original:', decrypted === plainResult);
  }

  // ============================================================================
  // Example 9: pipeTo() with encryption
  // ============================================================================
  section('Example 9: pipeTo() with Encryption');

  {
    const key = crypto.randomBytes(32);
    const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key);

    // Create transform pair
    const { stream: encryptedOutput, writer: encryptInput } = Stream.transform(encrypt);

    // Use pipeTo to send data
    const source = Stream.from('Data sent via pipeTo() through encryption transform');
    const pipePromise = source.pipeTo(encryptInput);

    // Collect encrypted output
    const ciphertext = await encryptedOutput.bytes();
    await pipePromise;

    const params = getParams();
    console.log('Encrypted via pipeTo():', ciphertext.length, 'bytes');

    // Verify
    const decrypted = await Stream.from(ciphertext)
      .pipeThrough(createAes256GcmDecryptTransform(key, params))
      .text();

    console.log('Decrypted:', decrypted);
  }

  // ============================================================================
  // Example 10: Password-based encryption with pipeThrough()
  // ============================================================================
  section('Example 10: Password-based Encryption');

  {
    const password = 'user-secret-password';
    const salt = crypto.randomBytes(16);
    const key = await deriveKey(password, salt);

    const plaintext = 'Sensitive user data protected by password';

    // Encrypt with derived key
    const { transform: encrypt, getParams } = createAes256GcmEncryptTransform(key);
    const ciphertext = await Stream.from(plaintext).pipeThrough(encrypt).bytes();
    const params = getParams();

    console.log('Salt:', toHex(salt));
    console.log('IV:', toHex(params.iv));
    console.log('Ciphertext:', ciphertext.length, 'bytes');

    // Decrypt with same password
    const derivedKey = await deriveKey(password, salt);
    const decrypted = await Stream.from(ciphertext)
      .pipeThrough(createAes256GcmDecryptTransform(derivedKey, params))
      .text();

    console.log('Decrypted:', decrypted);

    // Wrong password fails
    const wrongKey = await deriveKey('wrong-password', salt);
    try {
      await Stream.from(ciphertext)
        .pipeThrough(createAes256GcmDecryptTransform(wrongKey, params))
        .text();
      console.log('ERROR: Should have thrown!');
    } catch {
      console.log('Wrong password rejected');
    }
  }

  // ============================================================================
  // Example 11: Message envelope with pipeThrough()
  // ============================================================================
  section('Example 11: Complete Message Envelope');

  {
    // Envelope format: [salt:16][iv:12][ciphertext:n][authTag:16]

    async function encryptMessage(password: string, plaintext: string): Promise<Uint8Array> {
      const salt = crypto.randomBytes(16);
      const key = await deriveKey(password, salt);

      const { transform, getParams } = createAes256GcmEncryptTransform(key);
      const ciphertext = await Stream.from(plaintext).pipeThrough(transform).bytes();
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

      return Stream.from(ciphertext)
        .pipeThrough(createAes256GcmDecryptTransform(key, { iv, authTag }))
        .text();
    }

    const password = 'my-secret';
    const message = 'Complete encrypted message using pipeThrough()!';

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
