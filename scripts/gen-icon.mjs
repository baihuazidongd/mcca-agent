// Generate a 1024x1024 RGBA source PNG for `tauri icon`. Pure Node (zlib only),
// no image libraries. Replace with a real logo later if desired.

import zlib from "node:zlib";
import fs from "node:fs";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const W = 1024;
const H = 1024;

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// Green background with a white rounded-ish center mark.
const raw = Buffer.alloc((W * 4 + 1) * H);
const cx = W / 2;
const cy = H / 2;
for (let y = 0; y < H; y++) {
  const row = y * (W * 4 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const off = row + 1 + x * 4;
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r < 300) {
      raw[off] = 255; // white center circle
      raw[off + 1] = 255;
      raw[off + 2] = 255;
    } else {
      raw[off] = 14; // accent green
      raw[off + 1] = 169;
      raw[off + 2] = 104;
    }
    raw[off + 3] = 255;
  }
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = new URL("../desktop/icon-source.png", import.meta.url);
fs.writeFileSync(out, png);
console.log("wrote", out.pathname);
