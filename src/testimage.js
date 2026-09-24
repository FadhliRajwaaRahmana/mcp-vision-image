/**
 * Pembuat gambar uji minimal (PNG 3 kotak: merah, hijau, biru) tanpa dependensi.
 *
 * KENAPA GAMBAR INI
 * -----------------
 * Untuk menguji apakah sebuah model benar-benar bisa melihat, kita butuh
 * gambar yang jawabannya bisa dinilai OBJEKTIF: kalau model menjawab "3 kotak,
 * merah/hijau/biru" berarti jalur gambarnya benar-benar bekerja. Kalau model
 * hanya mengarang, warnanya tidak akan cocok.
 *
 * Ukuran sengaja kecil (240x120) supaya murah dipakai berulang kali saat
 * memindai banyak model.
 */

import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * Hasilkan PNG berisi 3 kotak berjajar: merah, hijau, biru.
 * @returns {Buffer}
 */
export function makeTestPng(w = 240, h = 120) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter byte per baris
    for (let x = 0; x < w; x++) {
      let r = 255,
        g = 255,
        b = 255;
      if (x < w * 0.31 && y > h * 0.17 && y < h * 0.83) {
        r = 220; g = 40; b = 40; // merah
      } else if (x > w * 0.35 && x < w * 0.65 && y > h * 0.17 && y < h * 0.83) {
        r = 40; g = 190; b = 80; // hijau
      } else if (x > w * 0.69 && y > h * 0.17 && y < h * 0.83) {
        r = 40; g = 80; b = 220; // biru
      }
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Gambar uji dalam bentuk base64 + mime, siap kirim ke API. */
export function testImageBase64() {
  return { mimeType: 'image/png', base64Data: makeTestPng().toString('base64') };
}

/**
 * Nilai jawaban model terhadap gambar uji.
 * @returns {{colors: number[], found: number, perfect: boolean}}
 */
export function scoreAnswer(text) {
  const t = String(text || '').toLowerCase();
  const groups = [
    ['merah', 'red', '红'],
    ['hijau', 'green', '绿', '綠'],
    ['biru', 'blue', '蓝', '藍'],
  ];
  const colors = groups.map((g) => (g.some((w) => t.includes(w)) ? 1 : 0));
  const found = colors.reduce((a, b) => a + b, 0);
  return { colors, found, perfect: found >= 3 };
}
