// Minimal ZIP writer for the account export: STORED (uncompressed) entries
// only — the archive is mostly photos, which are already compressed — so
// every size is known before anything is written and the archive can be
// produced in independent, resumable steps:
//   plan:   each entry's offset = sum of the previous entries' local sizes
//   step:   local header + file bytes, for entries in order
//   finish: central directory + end record, from the recorded CRCs
// Classic ZIP limits apply (no ZIP64): < 65,535 entries, < 4 GiB in total.

export const ZIP_MAX_ENTRIES = 65_535;
export const ZIP_MAX_BYTES = 0xffff_ffff;

const encoder = new TextEncoder();
const UTF8_FLAG = 0x0800; // file names are UTF-8

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed timestamp: the archive's file dates aren't meaningful (the data
// carries its own dates), and a fixed value keeps rebuilt archives identical.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

export const nameBytes = (name: string) => encoder.encode(name);
export const localEntrySize = (name: string, size: number) => 30 + nameBytes(name).length + size;
const centralEntrySize = (name: string) => 46 + nameBytes(name).length;

// Total archive size for the given entries, in order.
export function archiveSize(entries: { name: string; size: number }[]): number {
  let total = 22; // end of central directory
  for (const e of entries) total += localEntrySize(e.name, e.size) + centralEntrySize(e.name);
  return total;
}

export function localEntry(name: string, data: Uint8Array, crc: number): Uint8Array {
  const n = nameBytes(name);
  const out = new Uint8Array(30 + n.length + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true); // version needed
  v.setUint16(6, UTF8_FLAG, true);
  v.setUint16(8, 0, true); // stored
  v.setUint16(10, DOS_TIME, true);
  v.setUint16(12, DOS_DATE, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, data.length, true);
  v.setUint32(22, data.length, true);
  v.setUint16(26, n.length, true);
  v.setUint16(28, 0, true);
  out.set(n, 30);
  out.set(data, 30 + n.length);
  return out;
}

export function centralDirectory(
  entries: { name: string; size: number; crc: number; offset: number }[],
  centralOffset: number,
): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  for (const e of entries) {
    const n = nameBytes(e.name);
    const rec = new Uint8Array(46 + n.length);
    const v = new DataView(rec.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 0x031e, true); // made by: Unix, spec 3.0
    v.setUint16(6, 20, true);
    v.setUint16(8, UTF8_FLAG, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, DOS_TIME, true);
    v.setUint16(14, DOS_DATE, true);
    v.setUint32(16, e.crc, true);
    v.setUint32(20, e.size, true);
    v.setUint32(24, e.size, true);
    v.setUint16(28, n.length, true);
    v.setUint32(38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
    v.setUint32(42, e.offset, true);
    rec.set(n, 46);
    parts.push(rec);
    length += rec.length;
  }
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, length, true);
  v.setUint32(16, centralOffset, true);
  parts.push(end);
  return concat(parts);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
