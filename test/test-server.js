/**
 * Smoke test end-to-end lewat MCP stdio.
 *
 * Membuat gambar uji sendiri (3 kotak merah/hijau/biru) supaya hasilnya bisa
 * dinilai objektif: jawaban yang benar HARUS menyebut 3 kotak + ketiga warna.
 *
 * Jalankan:
 *   ROUTER9_API_KEY=xxx node test/test-server.js
 *   # atau, kalau hanya ingin menguji jalur Gemini:
 *   GEMINI_API_KEY=xxx VISION_BACKENDS=gemini node test/test-server.js
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// ---- Pembuat PNG minimal (tanpa dependensi) ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makeTestPng(w = 480, h = 240) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      let r = 255, g = 255, b = 255;
      if (x < 150 && y > 40 && y < 200) { r = 220; g = 40; b = 40; }        // merah
      else if (x > 165 && x < 315 && y > 40 && y < 200) { r = 40; g = 190; b = 80; }  // hijau
      else if (x > 330 && y > 40 && y < 200) { r = 40; g = 80; b = 220; }   // biru
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hasil = [];
function cek(nama, lulus, detail = '') {
  hasil.push({ nama, lulus });
  console.log(`${lulus ? '✓' : '✗'} ${nama}${detail ? ` — ${detail}` : ''}`);
}

async function runTest() {
  const adaRouter9 = Boolean(process.env.ROUTER9_API_KEY);
  const adaGemini = Boolean(process.env.GEMINI_API_KEY);

  if (!adaRouter9 && !adaGemini) {
    console.error('Tidak ada backend yang dikonfigurasi.');
    console.error('Set ROUTER9_API_KEY (disarankan) atau GEMINI_API_KEY.');
    process.exit(1);
  }

  console.log('--- MCP Vision Server Smoke Test ---');
  console.log(`backend: ${process.env.VISION_BACKENDS || 'router9,gemini'}`);
  console.log(`ROUTER9_API_KEY: ${adaRouter9 ? 'ada' : 'tidak ada'} | GEMINI_API_KEY: ${adaGemini ? 'ada' : 'tidak ada'}\n`);

  // Siapkan gambar uji
  const tmpDir = path.resolve('test');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const imgPath = path.join(tmpDir, 'generated-test.png');
  writeFileSync(imgPath, makeTestPng());
  console.log(`gambar uji: ${imgPath}\n`);

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['./src/server.js'],
    env: { ...process.env },
  });

  const client = new Client({ name: 'test-client', version: '2.0.0' }, { capabilities: {} });
  await client.connect(transport);
  cek('terhubung ke MCP server via stdio', true);

  const tools = await client.listTools();
  const namaTool = tools.tools.map((t) => t.name);
  cek('tool analyze_image terdaftar', namaTool.includes('analyze_image'), namaTool.join(', '));
  cek('tool get_usage_stats terdaftar', namaTool.includes('get_usage_stats'));

  // --- Uji utama: analisis gambar ---
  console.log('\n--- analyze_image (gambar 3 kotak) ---');
  let respons;
  try {
    respons = await client.callTool({
      name: 'analyze_image',
      arguments: {
        image_path: imgPath,
        prompt: 'Ada berapa kotak di gambar ini dan apa warnanya? Jawab satu baris singkat.',
      },
    });
  } catch (err) {
    cek('analyze_image berhasil dipanggil', false, err.message);
    await client.close();
    return ringkas();
  }

  const teks = (respons.content || []).map((c) => c.text).filter(Boolean).join('\n');
  cek('analyze_image tidak error', !respons.isError, respons.isError ? teks.slice(0, 200) : '');
  console.log(`\njawaban:\n${teks}\n`);

  if (!respons.isError) {
    // Jawaban benar = menyebut 3 kotak + ketiga warna (bahasa apa pun)
    const benar =
      /3|tiga|three|三个/i.test(teks) &&
      /merah|red|红/i.test(teks) &&
      /hijau|green|绿/i.test(teks) &&
      /biru|blue|蓝/i.test(teks);
    cek('jawaban menyebut 3 kotak + merah/hijau/biru', benar, benar ? '' : 'jawaban tidak lengkap');
  }

  // --- get_usage_stats ---
  console.log('\n--- get_usage_stats ---');
  const stats = await client.callTool({ name: 'get_usage_stats', arguments: {} });
  const teksStats = (stats.content || []).map((c) => c.text).filter(Boolean).join('\n');
  cek('get_usage_stats mengembalikan data', teksStats.includes('Statistik'));
  cek('get_usage_stats menyebut status backend', /siap|belum dikonfigurasi/.test(teksStats));

  await client.close();
  ringkas();
}

function ringkas() {
  const lulus = hasil.filter((h) => h.lulus).length;
  console.log(`\n--- ${lulus}/${hasil.length} pemeriksaan lulus ---`);
  process.exit(lulus === hasil.length ? 0 : 1);
}

runTest().catch((err) => {
  console.error('Test gagal:', err);
  process.exit(1);
});
