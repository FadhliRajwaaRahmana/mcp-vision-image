/**
 * Orkestrator analisis gambar.
 *
 * SATU BACKEND, TAPI BANYAK MODEL
 * -------------------------------
 * Versi sebelumnya memakai rantai 9router → Gemini API. Gemini dibuang karena
 * free tier-nya cuma 20 request/hari per model — begitu kena HTTP 429, jalur
 * cadangan itu mati dan tidak menambah keandalan sama sekali. Sekarang semua
 * lewat 9router, dan keandalannya datang dari PEMILIHAN MODEL, bukan dari
 * backend kedua.
 *
 * KENAPA PEMILIHAN MODEL JADI MASALAH
 * -----------------------------------
 * 9router mengekspos ratusan model, tapi di satu mesin terukur hanya segelintir
 * yang benar-benar bisa memproses gambar: sisanya kredit providernya habis,
 * key-nya mati, atau balas HTTP 200 dengan content kosong. Lebih buruk lagi,
 * `capabilities.vision` di katalog TIDAK bisa dipercaya — ada model yang
 * mengklaim vision tapi jawabannya kosong.
 *
 * Karena itu daftar model yang bekerja ditemukan lewat PENGUJIAN NYATA di
 * mesin tempat MCP ini berjalan (lihat discover.js), lalu di-cache.
 *
 * URUTAN PEMILIHAN MODEL
 * ----------------------
 *   1. `model` eksplisit dari pemanggil   (paling diutamakan)
 *   2. env ROUTER9_MODEL                  (override manual)
 *   3. model terbaik dari hasil penemuan  (otomatis, terverifikasi)
 *   4. DEFAULT_MODEL                      (tebakan terakhir)
 *
 * Kalau model yang dipilih gagal, model berikutnya dari daftar temuan dicoba
 * sebelum menyerah.
 */

import { analyzeWithRouter9, getRouter9DefaultModel } from './backends/router9.js';
import { readCache, discoverVisionModels, classifyError } from './discover.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:20128';

function baseUrl() {
  return process.env.ROUTER9_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * Provider yang boleh dipindai, dari env `VISION_PROVIDERS` (mis. "ag,oc").
 *
 * Berguna karena sebagian instalasi hanya memakai beberapa provider —
 * memindai 27 provider padahal cuma 2 yang dipakai itu boros kuota & waktu.
 * Kosong/null = semua provider dipindai.
 *
 * @returns {string[]|null}
 */
export function getProviderFilter() {
  const raw = process.env.VISION_PROVIDERS;
  if (!raw || !raw.trim()) return null;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Daftar model yang boleh dicoba, berurutan dari yang paling diinginkan.
 * @returns {string[]}
 */
export function getModelChain(explicitModel) {
  const chain = [];
  const push = (m) => {
    if (m && !chain.includes(m)) chain.push(m);
  };

  push(explicitModel);
  push(process.env.ROUTER9_MODEL);

  const cache = readCache(baseUrl());
  if (cache?.working) {
    // Sudah diurutkan dari yang tercepat saat penemuan.
    for (const w of cache.working) push(w.model);
  }

  push(getRouter9DefaultModel());
  return chain;
}

/** Status backend + hasil penemuan terakhir, untuk tool get_usage_stats. */
export function getBackendInfo() {
  const bu = baseUrl();
  const cache = readCache(bu);
  return {
    name: 'router9',
    label: '9Router',
    ready: Boolean(process.env.ROUTER9_API_KEY),
    note: process.env.ROUTER9_API_KEY ? null : 'ROUTER9_API_KEY belum diset',
    baseUrl: bu,
    defaultModel: getRouter9DefaultModel(),
    discovery: cache
      ? {
          scannedAt: cache.scannedAt,
          working: (cache.working || []).length,
          catalogTotal: cache.catalogTotal,
          visionClaiming: cache.visionClaiming,
          providers: cache.providers,
          providerFilter: cache.providerFilter,
          providerHilang: cache.providerHilang,
          probed: cache.probed,
          notProbed: cache.notProbed,
          reachedTarget: cache.reachedTarget,
          top: (cache.working || []).slice(0, 5),
        }
      : null,
  };
}

/**
 * Analisis gambar lewat 9router, mencoba beberapa model sampai berhasil.
 *
 * @param {object} o
 * @param {string} o.base64Data
 * @param {string} o.mimeType
 * @param {string} o.prompt
 * @param {string} [o.model]     paksa model tertentu
 * @param {boolean} [o.autoDiscover=true] jalankan penemuan kalau cache kosong
 * @param {function} [o.onProgress]
 * @returns {Promise<{text:string, model:string, attempts:Array, discovery:object|null}>}
 */
export async function analyzeImage({
  base64Data,
  mimeType,
  prompt,
  model,
  autoDiscover = true,
  onProgress = null,
}) {
  const apiKey = process.env.ROUTER9_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ROUTER9_API_KEY belum diset. Isi dengan API key 9router (dashboard → Endpoint & Key).'
    );
  }

  const attempts = [];
  let discovery = null;
  const mulai = Date.now();

  // Coba model yang sudah diketahui dulu.
  const coba = async (chain) => {
    for (const m of chain) {
      const t0 = Date.now();
      try {
        const text = await analyzeWithRouter9({
          base64Data,
          mimeType,
          prompt,
          model: m,
          baseUrl: baseUrl(),
          apiKey,
        });
        attempts.push({ model: m, ok: true, ms: Date.now() - t0 });
        return text;
      } catch (err) {
        attempts.push({
          model: m,
          ok: false,
          ms: Date.now() - t0,
          kind: classifyError(err.message),
          error: String(err.message).slice(0, 250),
        });
      }
    }
    return null;
  };

  // Tahap 1: model eksplisit / env / cache / tebakan default.
  // Sengaja didahulukan supaya kasus umum selesai cepat — penemuan penuh bisa
  // memakan lebih dari satu menit, dan klien MCP punya timeout sendiri.
  const teks1 = await coba(getModelChain(model));
  if (teks1 !== null) {
    return { text: teks1, model: attempts[attempts.length - 1].model, attempts, discovery, totalMs: Date.now() - mulai };
  }

  // Tahap 2: semua kandidat cepat gagal → baru pindai mesin ini.
  // Di sinilah auto-discovery benar-benar berguna: mesin dengan provider
  // berbeda butuh daftar model yang berbeda.
  const bolehPindai = autoDiscover && !model && !process.env.ROUTER9_MODEL;
  if (bolehPindai) {
    try {
      discovery = await discoverVisionModels({
        baseUrl: baseUrl(),
        apiKey,
        providers: getProviderFilter(),
        onProgress,
      });
      const teks2 = await coba(discovery.working.map((w) => w.model));
      if (teks2 !== null) {
        return { text: teks2, model: attempts[attempts.length - 1].model, attempts, discovery, totalMs: Date.now() - mulai };
      }
    } catch (err) {
      attempts.push({
        model: '(penemuan)',
        ok: false,
        ms: 0,
        kind: 'penemuan gagal',
        error: String(err.message).slice(0, 200),
      });
    }
  }

  const ringkas = attempts.map((a) => `  - ${a.model}: ${a.error}`).join('\n');
  throw new Error(
    `Semua model vision gagal (${attempts.length} dicoba):\n${ringkas}\n\n` +
      `Jalankan tool \`discover_vision_models\` untuk memindai ulang model yang bekerja di mesin ini.`
  );
}
