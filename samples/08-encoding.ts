/**
 * Encoding Support
 * 
 * This file demonstrates the various text encodings supported by the streams API.
 */

import { Stream } from '../src/stream.js';

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  // ============================================================================
  // UTF-8 (default encoding)
  // ============================================================================
  section('UTF-8 - Default encoding');

  {
    // UTF-8 is the default for string encoding
    const stream = Stream.from('Hello, World! Привет! 你好!');
    const bytes = await stream.bytes();
    
    console.log('UTF-8 encoded bytes:', bytes.length);
    console.log('Sample bytes:', Array.from(bytes.slice(0, 10)));
    
    // Decode back to text
    const decoded = await Stream.from(bytes).text('utf-8');
    console.log('Decoded:', decoded);
  }

  // Explicit UTF-8 option
  {
    const stream = Stream.from('explicit utf-8', { encoding: 'utf-8' });
    console.log('\nExplicit UTF-8:', await stream.text());
  }

  // ============================================================================
  // UTF-16LE (Little Endian)
  // ============================================================================
  section('UTF-16LE - Little Endian');

  {
    // Encode as UTF-16LE
    const stream = Stream.from('Hi!', { encoding: 'utf-16le' });
    const bytes = await stream.bytes();
    
    console.log('UTF-16LE bytes:', Array.from(bytes));
    console.log('(Notice: 2 bytes per char, little-endian order)');
    
    // Decode back
    const decoded = await Stream.from(bytes).text('utf-16le');
    console.log('Decoded:', decoded);
  }

  // Unicode characters in UTF-16LE
  {
    const text = '日本語'; // Japanese
    const stream = Stream.from(text, { encoding: 'utf-16le' });
    const bytes = await stream.bytes();
    
    console.log('\nJapanese in UTF-16LE:', bytes.length, 'bytes');
    const decoded = await Stream.from(bytes).text('utf-16le');
    console.log('Decoded:', decoded);
  }

  // ============================================================================
  // UTF-16BE (Big Endian)
  // ============================================================================
  section('UTF-16BE - Big Endian');

  {
    // Encode as UTF-16BE
    const stream = Stream.from('Hi!', { encoding: 'utf-16be' });
    const bytes = await stream.bytes();
    
    console.log('UTF-16BE bytes:', Array.from(bytes));
    console.log('(Notice: 2 bytes per char, big-endian order)');
    
    // Compare with UTF-16LE
    const leBytes = await Stream.from('Hi!', { encoding: 'utf-16le' }).bytes();
    console.log('UTF-16LE bytes:', Array.from(leBytes));
    console.log('(Notice byte order is swapped)');
    
    // Decode
    const decoded = await Stream.from(bytes).text('utf-16be');
    console.log('Decoded:', decoded);
  }

  // ============================================================================
  // ISO-8859-1 (Latin-1)
  // ============================================================================
  section('ISO-8859-1 (Latin-1)');

  {
    // Latin-1 is a single-byte encoding for Western European languages
    const text = 'Café résumé naïve';
    const stream = Stream.from(text, { encoding: 'iso-8859-1' });
    const bytes = await stream.bytes();
    
    console.log('Text:', text);
    console.log('ISO-8859-1 bytes:', bytes.length, '(one byte per char)');
    
    // Decode
    const decoded = await Stream.from(bytes).text('iso-8859-1');
    console.log('Decoded:', decoded);
  }

  // latin1 alias works
  {
    const stream = Stream.from('latin1 alias', { encoding: 'latin1' });
    console.log('\nlatin1 alias:', await stream.text('latin1'));
  }

  // Characters outside Latin-1 range are replaced
  {
    const text = 'Hello 你好'; // Chinese chars not in Latin-1
    const stream = Stream.from(text, { encoding: 'iso-8859-1' });
    const bytes = await stream.bytes();
    
    const decoded = await Stream.from(bytes).text('iso-8859-1');
    console.log('\nNon-Latin-1 chars replaced:');
    console.log('  Original:', text);
    console.log('  After Latin-1 round-trip:', decoded);
    console.log('  (Chinese characters became "?")');
  }

  // ============================================================================
  // Windows-1252
  // ============================================================================
  section('Windows-1252');

  {
    // Windows-1252 extends Latin-1 with more characters
    const text = 'Windows "smart quotes" and €uro';
    const stream = Stream.from(text, { encoding: 'windows-1252' });
    const bytes = await stream.bytes();
    
    console.log('Text:', text);
    console.log('Windows-1252 bytes:', bytes.length);
  }

  // ============================================================================
  // Using encoding with push streams
  // ============================================================================
  section('Encoding with push streams');

  {
    const [stream, writer] = Stream.push({ encoding: 'utf-16le' });
    
    await writer.write('Push stream');
    await writer.write(' with encoding');
    await writer.close();
    
    // Note: Reading back requires knowing the encoding
    const text = await stream.text('utf-16le');
    console.log('Push stream with UTF-16LE:', text);
  }

  // ============================================================================
  // Using encoding with pull streams
  // ============================================================================
  section('Encoding with pull streams');

  {
    const stream = Stream.pull(function* () {
      yield 'Generated ';
      yield 'text ';
      yield 'content';
    }, { encoding: 'iso-8859-1' });
    
    const bytes = await stream.bytes();
    console.log('Pull stream bytes (Latin-1):', bytes.length);
    
    const text = await Stream.from(bytes).text('iso-8859-1');
    console.log('Decoded:', text);
  }

  // ============================================================================
  // Using encoding with transforms
  // ============================================================================
  section('Encoding with transforms');

  {
    // Transform output uses encoding option
    const [output, writer] = Stream.transform(
      (chunk) => {
        if (chunk === null) return null;
        const text = new TextDecoder().decode(chunk);
        return text.toUpperCase(); // Returns string, will be encoded
      },
      { encoding: 'utf-16le' } // Output encoded as UTF-16LE
    );
    
    await writer.write('transform encoding');
    await writer.close();
    
    const bytes = await output.bytes();
    console.log('Transform output bytes (UTF-16LE):', bytes.length);
    
    const text = await Stream.from(bytes).text('utf-16le');
    console.log('Decoded:', text);
  }

  // ============================================================================
  // Using encoding with writev
  // ============================================================================
  section('Encoding with writev');

  {
    const [stream, writer] = Stream.push({ encoding: 'iso-8859-1' });
    
    // writev respects the encoding for string chunks
    await writer.writev(['chunk1 ', 'chunk2 ', 'chunk3']);
    await writer.close();
    
    const text = await stream.text('iso-8859-1');
    console.log('writev with encoding:', text);
  }

  // ============================================================================
  // Mixed content (strings and binary)
  // ============================================================================
  section('Mixed content');

  {
    const [stream, writer] = Stream.push({ encoding: 'utf-16le' });
    
    // Strings are encoded, binary data passes through
    await writer.write('text'); // Encoded as UTF-16LE
    await writer.write(new Uint8Array([0, 1, 2, 3])); // Binary, not encoded
    await writer.write(' more text'); // Encoded as UTF-16LE
    await writer.close();
    
    const bytes = await stream.bytes();
    console.log('Mixed content bytes:', bytes.length);
    console.log('Sample bytes:', Array.from(bytes.slice(0, 12)));
    console.log('(Notice: text is 2 bytes/char, binary is raw)');
  }

  // ============================================================================
  // Practical encoding examples
  // ============================================================================
  section('Practical examples');

  // Reading/writing CSV with Latin-1 encoding (common in legacy systems)
  {
    console.log('\n--- Legacy CSV with Latin-1 ---');
    
    const csvContent = 'name,city\nJosé,São Paulo\nMüller,München';
    
    // "Write" as Latin-1 (simulating legacy system)
    const encoded = await Stream.from(csvContent, { encoding: 'iso-8859-1' }).bytes();
    console.log('Encoded CSV bytes:', encoded.length);
    
    // "Read" back with Latin-1
    const decoded = await Stream.from(encoded).text('iso-8859-1');
    console.log('Decoded CSV:');
    decoded.split('\n').forEach(line => console.log('  ' + line));
  }

  // Working with BOM-less UTF-16
  {
    console.log('\n--- UTF-16 without BOM ---');
    
    // Some systems output UTF-16 without a byte-order mark
    const utf16leData = await Stream.from('No BOM', { encoding: 'utf-16le' }).bytes();
    
    // If you know the endianness, decode correctly
    const correct = await Stream.from(utf16leData).text('utf-16le');
    console.log('Correct decoding (LE):', correct);
    
    // Wrong endianness gives garbage
    const wrong = await Stream.from(utf16leData).text('utf-16be');
    console.log('Wrong endianness (BE):', wrong, '(garbage)');
  }

  console.log('\n--- Examples complete! ---\n');
}

main().catch(console.error);
