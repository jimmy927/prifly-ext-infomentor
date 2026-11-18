/** BankID's animated QR as a PNG file a session can show: QR text in, PNG bytes out. */

import { deflateSync } from "node:zlib";
import { encode } from "uqr";

const SCALE = 10;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit greyscale PNG of the QR code for `text`, with a quiet zone, black on white. */
export function qrPng(text: string): Uint8Array {
  const { data, size } = encode(text, { ecc: "L", border: 4 });
  const width = size * SCALE;
  const raw = new Uint8Array((width + 1) * width);
  for (let y = 0; y < width; y += 1) {
    const row = data[Math.floor(y / SCALE)] ?? [];
    const base = y * (width + 1);
    // Filter byte 0 (none), then one grey byte per pixel.
    for (let x = 0; x < width; x += 1) raw[base + 1 + x] = row[Math.floor(x / SCALE)] ? 0 : 255;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, width);
  header.set([8, 0, 0, 0, 0], 8); // 8 bit, greyscale, deflate, adaptive filter, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}
