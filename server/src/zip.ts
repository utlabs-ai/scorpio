// A zip written as a stream (docs/api/export.md): store-only entries with data descriptors, so an entry's size and CRC
// are written after its bytes and nothing has to be read twice or held in memory. General-purpose flag 0x0808: bit 3
// (sizes and CRC follow the data) and bit 11 (names are UTF-8). No zip64: the export limits keep every size far under
// 4 GiB. The writer only knows bytes; what goes into the entries is export.ts's business.

import { crc32 } from "node:zlib";

/** A date and time as the zip stores them (MS-DOS, local to the exporter's time zone, 2-second resolution). */
export type DosTime = { date: number; time: number };

/**
 * The DOS date and time of a wall-clock moment: year (1980–2107), month 1–12, day, hour, minute, second.
 * A year before 1980 is clamped to it: the field cannot hold less.
 */
export function dosTime(y: number, mo: number, d: number, h: number, mi: number, s: number): DosTime {
  const year = Math.min(2107, Math.max(1980, y));
  return { date: ((year - 1980) << 9) | (mo << 5) | d, time: (h << 11) | (mi << 5) | (s >> 1) };
}

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const VERSION = 20; // 2.0: data descriptors
const FLAGS = 0x0808;
const encoder = new TextEncoder();

function u16(view: DataView, at: number, v: number) { view.setUint16(at, v, true); }
function u32(view: DataView, at: number, v: number) { view.setUint32(at, v >>> 0, true); }

/** The local header of an entry: sizes and CRC are zero here and come in its descriptor. */
export function localHeader(name: Uint8Array, at: DosTime): Uint8Array {
  const out = new Uint8Array(30 + name.length);
  const v = new DataView(out.buffer);
  u32(v, 0, SIG_LOCAL);
  u16(v, 4, VERSION);
  u16(v, 6, FLAGS);
  u16(v, 8, 0); // stored
  u16(v, 10, at.time);
  u16(v, 12, at.date);
  // 14: crc, 18: compressed size, 22: uncompressed size: all 0, in the descriptor
  u16(v, 26, name.length);
  u16(v, 28, 0);
  out.set(name, 30);
  return out;
}

/** The data descriptor after an entry's bytes: its CRC and (stored) size twice. */
export function descriptor(crc: number, size: number): Uint8Array {
  const out = new Uint8Array(16);
  const v = new DataView(out.buffer);
  u32(v, 0, SIG_DESCRIPTOR);
  u32(v, 4, crc);
  u32(v, 8, size);
  u32(v, 12, size);
  return out;
}

export type Written = { name: Uint8Array; at: DosTime; crc: number; size: number; offset: number };

export function centralHeader(e: Written): Uint8Array {
  const out = new Uint8Array(46 + e.name.length);
  const v = new DataView(out.buffer);
  u32(v, 0, SIG_CENTRAL);
  u16(v, 4, (3 << 8) | VERSION); // made by: Unix, 2.0
  u16(v, 6, VERSION);
  u16(v, 8, FLAGS);
  u16(v, 10, 0);
  u16(v, 12, e.at.time);
  u16(v, 14, e.at.date);
  u32(v, 16, e.crc);
  u32(v, 20, e.size);
  u32(v, 24, e.size);
  u16(v, 28, e.name.length);
  u16(v, 30, 0); // extra
  u16(v, 32, 0); // comment
  u16(v, 34, 0); // disk
  u16(v, 36, 0); // internal attributes
  u32(v, 38, 0o100644 << 16); // external: a regular file, rw-r--r--
  u32(v, 42, e.offset);
  out.set(e.name, 46);
  return out;
}

export function endRecord(entries: number, centralSize: number, centralOffset: number): Uint8Array {
  const out = new Uint8Array(22);
  const v = new DataView(out.buffer);
  u32(v, 0, SIG_END);
  u16(v, 4, 0);
  u16(v, 6, 0);
  u16(v, 8, entries);
  u16(v, 10, entries);
  u32(v, 12, centralSize);
  u32(v, 16, centralOffset);
  u16(v, 20, 0);
  return out;
}

export type Sink = (chunk: Uint8Array) => Promise<void>;

/**
 * Writes one zip to `sink`, entry by entry: `entry(name, parts)` streams the parts as one file, `end()` writes the
 * central directory. Entries cannot interleave: the next one starts when the one before has been written.
 */
export class ZipWriter {
  private offset = 0;
  private readonly written: Written[] = [];

  constructor(private readonly sink: Sink, private readonly at: DosTime) {}

  private async write(chunk: Uint8Array) {
    await this.sink(chunk);
    this.offset += chunk.length;
  }

  /** One entry, its bytes in `parts` as they come (a stream from R2, a page of rendered text). */
  async entry(name: string, parts: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<void> {
    const nameBytes = encoder.encode(name);
    const offset = this.offset;
    await this.write(localHeader(nameBytes, this.at));
    let crc = 0;
    let size = 0;
    for await (const part of parts) {
      if (!part.length) continue;
      crc = crc32(part, crc);
      size += part.length;
      await this.write(part);
    }
    await this.write(descriptor(crc, size));
    this.written.push({ name: nameBytes, at: this.at, crc, size, offset });
  }

  /** The central directory and the end record; nothing may be written after it. */
  async end(): Promise<void> {
    const start = this.offset;
    for (const e of this.written) await this.write(centralHeader(e));
    await this.write(endRecord(this.written.length, this.offset - start, start));
  }
}

/** The chunks of a ReadableStream (an R2 object's body), for `entry`. */
export async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Text as one chunk, for small entries and for the pieces of a rendered file. */
export const text = (s: string): Uint8Array => encoder.encode(s);
