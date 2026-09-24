#!/usr/bin/env node
/**
 * Probe empiris: model mana di 9router yang BENAR-BENAR bisa memproses gambar
 * lewat endpoint /v1/messages.
 *
 * KENAPA SKRIP INI ADA
 * --------------------
 * `/v1/models` menyediakan `capabilities.vision`, tetapi klaim katalog tidak
 * sama dengan kenyataan: model bisa mengaku vision tapi mengembalikan jawaban
 * kosong, atau gagal karena provider tidak punya kredit. Skrip ini menguji
 * jalur PRODUKSI yang sebenarnya (analyzeWithRouter9) sehingga hasilnya
 * mencerminkan perilaku MCP, bukan teori.
 *
 * PEMAKAIAN
 * ---------
 *   node test/probe-vision.js --per-provider 2   # sampel stratifikasi (cepat)
 *   node test/probe-vision.js --all              # sapu bersih semua model
 *   node test/probe-vision.js --only ag/gemini-3.8-flash-medium
 *   node test/probe-vision.js --control          # ikut uji model non-vision
 *
 * HASIL
 * -----
 * test/probe-results.json — data mentah; ringkasan ke stdout.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { processImageSource } from '../src/image.js';
import { analyzeWithRouter9 } from '../src/backends/router9.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- argumen ----------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const BASE_URL = val('--base-url', process.env.ROUTER9_BASE_URL || 'http://127.0.0.1:20128');
const CONCURRENCY = Number(val('--concurrency', 5));
const TIMEOUT_MS = Number(val('--timeout', 90000));
const PER_PROVIDER = Number(val('--per-provider', 0));
const LIMIT = Number(val('--limit', 0));
const ONLY = val('--only', null);
const ALL = has('--all');
const INCLUDE_CONTROL = has('--control');
// Provider yang dikecualikan. Dipakai untuk menghindari provider yang
// berisiko kena ban atau sedang rusak. WAJIB dilaporkan ke stdout kalau
// aktif — pengecualian senyap membuat hasil terlihat "menyeluruh" padahal
// tidak.
const EXCLUDE = new Set(
  val('--exclude-providers', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

// ---------- kredensial ----------
function loadKey() {
  if (process.env.ROUTER9_API_KEY) return process.env.ROUTER9_API_KEY;
  const p = path.join(os.homedir(), '.claude.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const k = cfg.mcpServers?.['mcp-vision-image']?.env?.ROUTER9_API_KEY;
  if (!k) throw new Error('ROUTER9_API_KEY tidak ada di env maupun ~/.claude.json');
  return k;
}

// ---------- penilaian jawaban ----------
const COLORS = [
  ['merah', 'red'],
  ['hijau', 'green'],
  ['biru', 'blue'],
];
function checkColors(text) {
  const t = String(text).toLowerCase();
  return COLORS.map(([id, en]) => (t.includes(id) || t.includes(en) ? 1 : 0));
}

// ---------- pool konkurensi ----------
async function pool(items, worker, n) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

(async () => {
  const apiKey = loadKey();

  // 1. Ambil katalog model dari 9router
  const res = await fetch(`${BASE_URL}/v1/models`, { headers: { 'x-api-key': apiKey } });
  if (!res.ok) throw new Error(`Gagal ambil /v1/models: HTTP ${res.status}`);
  const catalog = (await res.json()).data || [];
  console.log(`Katalog 9router: ${catalog.length} model`);

  // 2. Pilih model yang akan diuji
  let targets;
  if (ONLY) {
    targets = ONLY.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => catalog.find((m) => m.id === id) || { id, owned_by: '?', capabilities: null });
  } else {
    const vision = catalog.filter((m) => m.capabilities?.vision === true && m.owned_by !== 'combo');
    const nonVision = catalog.filter((m) => m.capabilities?.vision !== true && m.owned_by !== 'combo');

    if (PER_PROVIDER > 0) {
      const byProv = {};
      for (const m of vision) (byProv[m.owned_by] ||= []).push(m);
      targets = Object.values(byProv).flatMap((list) => list.slice(0, PER_PROVIDER));
    } else {
      targets = vision; // default: semua yang klaim vision
    }

    if (INCLUDE_CONTROL) {
      const byProv = {};
      for (const m of nonVision) (byProv[m.owned_by] ||= []).push(m);
      const ctrl = Object.values(byProv).flatMap((l) => l.slice(0, 1));
      targets = targets.concat(ctrl);
      console.log(`+ ${ctrl.length} model KONTROL (klaim tanpa vision) — untuk uji akurasi metadata`);
    }
  }
  if (!ALL && LIMIT > 0) targets = targets.slice(0, LIMIT);

  // Terapkan pengecualian provider — dan LAPORKAN berapa yang dibuang.
  if (EXCLUDE.size) {
    const before = targets.length;
    const dropped = targets.filter((m) => EXCLUDE.has(m.owned_by));
    targets = targets.filter((m) => !EXCLUDE.has(m.owned_by));
    console.log(
      `Dikecualikan: ${EXCLUDE.size} provider → ${before - targets.length} model dibuang` +
        (dropped.length ? ` (${[...new Set(dropped.map((m) => m.owned_by))].join(', ')})` : '')
    );
  }

  console.log(`Menguji ${targets.length} model | konkurensi ${CONCURRENCY} | timeout ${TIMEOUT_MS}ms\n`);

  // 3. Siapkan gambar uji
  const { mimeType, base64Data } = await processImageSource(path.join(__dirname, 'generated-test.png'));

  // 4. Uji setiap model lewat jalur produksi
  let done = 0;
  const results = await pool(
    targets,
    async (m) => {
      const t0 = Date.now();
      const rec = {
        model: m.id,
        provider: m.owned_by,
        claimedVision: m.capabilities?.vision === true,
        ok: false,
        ms: 0,
        answer: null,
        error: null,
        colors: null,
        colorsFound: 0,
      };
      try {
        const answer = await analyzeWithRouter9({
          base64Data,
          mimeType,
          prompt: 'Ada berapa kotak di gambar ini dan apa saja warnanya? Jawab singkat.',
          model: m.id,
          baseUrl: BASE_URL,
          apiKey,
          timeoutMs: TIMEOUT_MS,
        });
        rec.answer = answer.slice(0, 400);
        rec.colors = checkColors(answer);
        rec.colorsFound = rec.colors.reduce((a, b) => a + b, 0);
        rec.ok = true;
      } catch (e) {
        rec.error = String(e.message || e).slice(0, 250);
      }
      rec.ms = Date.now() - t0;
      done++;
      const mark = rec.ok ? (rec.colorsFound >= 3 ? 'OK ' : '~~ ') : 'X  ';
      if (done % 10 === 0 || !rec.ok) {
        process.stdout.write(`  [${String(done).padStart(3)}/${targets.length}] ${mark} ${m.id}\n`);
      }
      return rec;
    },
    CONCURRENCY
  );

  // 5. Simpan hasil mentah
  const outPath = path.join(__dirname, 'probe-results.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify({ baseUrl: BASE_URL, testedAt: new Date().toISOString(), results }, null, 2)
  );

  // 6. Ringkasan
  const ok = results.filter((r) => r.ok);
  const perfect = ok.filter((r) => r.colorsFound >= 3);
  const empty = ok.filter((r) => r.colorsFound === 0);
  const failed = results.filter((r) => !r.ok);

  console.log('\n' + '='.repeat(64));
  console.log(`BERHASIL         : ${ok.length}/${results.length}`);
  console.log(`  jawab lengkap  : ${perfect.length}   (menyebut 3 warna)`);
  console.log(`  jawab parsial  : ${ok.length - perfect.length - empty.length}`);
  console.log(`  jawab kosong   : ${empty.length}   (HTTP 200 tapi tak menyebut warna)`);
  console.log(`GAGAL            : ${failed.length}`);

  const ctrl = results.filter((r) => !r.claimedVision);
  if (ctrl.length) {
    const ctrlOk = ctrl.filter((r) => r.colorsFound >= 3);
    console.log(
      `\nAKURASI METADATA (kontrol): ${ctrlOk.length}/${ctrl.length} model yang mengaku TANPA vision justru berhasil`
    );
  }

  console.log('\n--- kegagalan dikelompokkan ---');
  const errKind = {};
  for (const r of failed) {
    const e = r.error || '';
    let k = 'lain-lain';
    if (/HTTP 40[13]/.test(e)) k = 'HTTP 401/403 — auth / kredit habis';
    else if (/HTTP 404/.test(e)) k = 'HTTP 404 — model tidak ada';
    else if (/HTTP 429/.test(e)) k = 'HTTP 429 — rate limit';
    else if (/HTTP 5\d\d/.test(e)) k = 'HTTP 5xx — error provider';
    else if (/timeout/i.test(e)) k = 'timeout';
    else if (/kosong/i.test(e)) k = 'jawaban kosong (200)';
    errKind[k] = (errKind[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(errKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }

  console.log(`\nHasil mentah: ${outPath}`);

  // 7. Provider paling andal
  const byProv = {};
  for (const r of perfect) (byProv[r.provider] ||= []).push(r);
  console.log('\n--- provider dengan model vision paling andal (jawab lengkap) ---');
  for (const [p, list] of Object.entries(byProv)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15)) {
    const avg = Math.round(list.reduce((a, x) => a + x.ms, 0) / list.length);
    console.log(`  ${p.padEnd(14)} ${String(list.length).padStart(3)} model   rata-rata ${avg}ms`);
  }
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
