/**
 * Smoke test end-to-end lewat MCP stdio.
 *
 * Membuat gambar uji sendiri (3 kotak merah/hijau/biru) supaya hasilnya bisa
 * dinilai objektif: jawaban yang benar HARUS menyebut 3 kotak + ketiga warna.
 *
 * Jalankan:
 *   ROUTER9_API_KEY=xxx node test/test-server.js
 *
 * Uji ini memanggil tool lewat protokol MCP sungguhan (stdio), jadi yang
 * diuji adalah perilaku yang benar-benar dilihat klien.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeTestPng } from '../src/testimage.js';

const hasil = [];
function cek(nama, lulus, detail = '') {
  hasil.push({ nama, lulus });
  console.log(`${lulus ? '✓' : '✗'} ${nama}${detail ? ` — ${detail}` : ''}`);
}

async function runTest() {
  const adaRouter9 = Boolean(process.env.ROUTER9_API_KEY);

  if (!adaRouter9) {
    console.error('ROUTER9_API_KEY belum diset.');
    console.error('Set ke API key 9router (dashboard → Endpoint & Key).');
    process.exit(1);
  }

  console.log('--- MCP Vision Server Smoke Test ---');
  console.log(`ROUTER9_API_KEY: ada`);
  console.log(`ROUTER9_BASE_URL: ${process.env.ROUTER9_BASE_URL || 'http://127.0.0.1:20128'}\n`);

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

  const client = new Client({ name: 'test-client', version: '3.0.0' }, { capabilities: {} });
  await client.connect(transport);
  cek('terhubung ke MCP server via stdio', true);

  const tools = await client.listTools();
  const namaTool = tools.tools.map((t) => t.name);
  cek('tool analyze_image terdaftar', namaTool.includes('analyze_image'), namaTool.join(', '));
  cek('tool discover_vision_models terdaftar', namaTool.includes('discover_vision_models'));
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
    // Model yang dipakai harus dilaporkan supaya jelas siapa yang bekerja.
    const m = teks.match(/model: ([^\s;,)]+)/);
    cek('melaporkan model yang dipakai', Boolean(m), m ? m[1] : 'tidak ditemukan di jawaban');
  }

  // --- discover_vision_models (pemindaian nyata) ---
  // Pemindaian sengaja menguji model satu per satu, jadi wajar makan puluhan
  // detik. Timeout klien MCP bawaan (60 detik) terlalu pendek di sini — tanpa
  // dinaikkan, kegagalan yang muncul adalah soal timeout klien, bukan soal
  // kode yang diuji.
  console.log('\n--- discover_vision_models ---');
  const disc = await client.callTool(
    {
      name: 'discover_vision_models',
      arguments: { target: 2, max_probe: 16, wave_size: 8 },
    },
    undefined,
    { timeout: 300000 }
  );
  const teksDisc = (disc.content || []).map((c) => c.text).filter(Boolean).join('\n');
  cek('discover_vision_models tidak error', !disc.isError, disc.isError ? teksDisc.slice(0, 200) : '');
  cek('melaporkan jumlah model yang diuji', /Benar-benar diuji/i.test(teksDisc));
  cek('melaporkan model yang bekerja', /Model yang bekerja/i.test(teksDisc));
  const adaYangBekerja = /`[^`]+\/[^`]+`/.test(teksDisc.split('Model yang bekerja')[1] || '');
  cek('menemukan minimal satu model vision', adaYangBekerja);

  // --- get_usage_stats ---
  console.log('\n--- get_usage_stats ---');
  const stats = await client.callTool({ name: 'get_usage_stats', arguments: {} });
  const teksStats = (stats.content || []).map((c) => c.text).filter(Boolean).join('\n');
  cek('get_usage_stats mengembalikan data', teksStats.includes('Statistik'));
  cek('get_usage_stats menyebut status backend', /siap|belum dikonfigurasi/.test(teksStats));

  await client.close();

  // --- FALLBACK antar-model (kegagalan NYATA) ---
  // Ini yang paling mudah diklaim tanpa bukti: "kalau model teratas gagal,
  // model berikutnya dipakai". Unit test tidak membuktikannya, karena yang
  // diuji cuma susunan array — bukan perilaku saat API benar-benar menolak.
  //
  // Caranya: sisipkan model yang PASTI mati di depan rantai, lalu jalankan
  // server baru dan lihat apakah jawaban tetap benar. Kegagalannya nyata
  // (9router balas error), bukan tiruan.
  await ujiFallbackNyata(imgPath);
}

/**
 * Buktikan fallback bekerja dengan memaksa model pertama gagal sungguhan.
 *
 * MEMILIH MODEL YANG GAGAL — jangan asal.
 * Percobaan pertama memakai id ngawur (`zz/tidak-ada-...`) dan GAGAL membukti
 * apa pun: 9router meneruskan model tak dikenal ke model lain, jadi id ngawur
 * justru berhasil menjawab. Kegagalan yang tidak deterministik tidak bisa
 * dipakai untuk menguji fallback.
 *
 * Yang dipakai sekarang: model dari provider yang kreditnya habis. Model ini
 * ADA di katalog (jadi tidak diteruskan ke mana-mana) tapi providernya
 * menolak — kegagalannya nyata dan konsisten.
 */
async function ujiFallbackNyata(imgPath) {
  console.log('\n--- fallback antar-model (kegagalan nyata) ---');

  const cachePath = path.resolve('stats', 'vision-models.json');
  if (!existsSync(cachePath)) {
    cek('fallback: cache discovery tersedia', false, 'jalankan discover dulu');
    return ringkas();
  }
  const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
  if (!cache.working?.length) {
    cek('fallback: ada model cadangan di cache', false, 'cache kosong');
    return ringkas();
  }

  // Model yang sudah terbukti mati di mesin ini (provider kehabisan kredit).
  // Bisa ditimpa lewat env kalau daftar berubah.
  const MODEL_MATI = process.env.TEST_DEAD_MODEL || 'fadli/openai/gpt-5.6-luna';

  // Pastikan model ini memang gagal — kalau ternyata hidup, uji ini tidak
  // membuktikan apa-apa dan harus dilaporkan jujur, bukan dianggap lulus.
  const praCek = await fetch(
    `${process.env.ROUTER9_BASE_URL || 'http://127.0.0.1:20128'}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ROUTER9_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_MATI,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }
  ).catch(() => null);
  const benarBenarMati = praCek && !praCek.ok;
  cek(
    `fallback: model uji memang gagal (${MODEL_MATI})`,
    Boolean(benarBenarMati),
    benarBenarMati ? `HTTP ${praCek.status}` : 'model ini ternyata HIDUP — uji fallback tidak valid'
  );
  if (!benarBenarMati) {
    return ringkas();
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['./src/server.js'],
    env: { ...process.env, ROUTER9_MODEL: MODEL_MATI },
  });
  const client = new Client({ name: 'test-fallback', version: '3.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const r = await client.callTool(
    {
      name: 'analyze_image',
      arguments: {
        image_path: imgPath,
        prompt: 'Ada berapa kotak di gambar ini dan apa warnanya? Jawab satu baris singkat.',
      },
    },
    undefined,
    { timeout: 240000 }
  );
  const teks = (r.content || []).map((c) => c.text).filter(Boolean).join('\n');
  await client.close();

  const benar =
    /3|tiga|three|三个/i.test(teks) &&
    /merah|red|红/i.test(teks) &&
    /hijau|green|绿/i.test(teks) &&
    /biru|blue|蓝/i.test(teks);

  cek('fallback: analisis tetap berhasil walau model pertama mati', benar, benar ? '' : teks.slice(0, 250));

  // Model pertama harus TERCATAT gagal, dan model yang dipakai bukan model mati.
  const gagalTercatat = teks.includes(MODEL_MATI);
  cek('fallback: kegagalan model pertama dilaporkan', gagalTercatat);

  const dipakai = (teks.match(/model: ([^\s;,)]+)/) || [])[1];
  cek(
    'fallback: jawaban datang dari model lain',
    Boolean(dipakai) && dipakai !== MODEL_MATI,
    dipakai ? `dipakai: ${dipakai}` : 'model tidak terdeteksi'
  );

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
