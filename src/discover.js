/**
 * Penemuan model vision yang BENAR-BENAR bekerja di 9router.
 *
 * KENAPA MODUL INI ADA
 * --------------------
 * `/v1/models` menyediakan `capabilities.vision`, tapi itu KLAIM KATALOG,
 * bukan jaminan. Diukur 24 Sep 2026 pada satu mesin: dari 468 model yang
 * mengklaim vision, sampel 50 model hanya 4 yang benar-benar menjawab gambar
 * dengan benar. Sisanya gagal karena kredit provider habis (401/402/403),
 * error upstream (5xx), timeout, atau — paling menyesatkan — HTTP 200 dengan
 * `content` KOSONG.
 *
 * Karena setiap instalasi 9router punya provider & akun yang berbeda, daftar
 * model yang bekerja TIDAK BISA di-hardcode. Modul ini memindainya saat
 * runtime di mesin tempat MCP berjalan, lalu menyimpannya ke cache.
 *
 * STRATEGI: SAPU PROVIDER DULU, BARU PERDALAM
 * ------------------------------------------
 * Kegagalan di sini hampir selalu soal PROVIDER (kredit habis, key mati),
 * bukan soal model. Jadi memindai 5 model dari provider yang sama itu
 * pemborosan: kalau providernya mati, kelimanya mati.
 *
 * Gelombang 1 karena itu mengambil SATU model per provider (round-robin),
 * sehingga sekali jalan langsung ketahuan provider mana yang hidup — berapa
 * pun jumlah providernya. Gelombang berikutnya baru memperdalam provider
 * yang terbukti hidup, dengan skor dari cache dipakai untuk mendahulukan
 * provider yang sebelumnya berhasil.
 *
 * BERHENTI begitu cukup model bekerja, jadi mesin sehat selesai cepat.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeWithRouter9 } from './backends/router9.js';
import { testImageBase64, scoreAnswer } from './testimage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '..', 'stats', 'vision-models.json');

const PROBE_PROMPT =
  'Ada berapa kotak di gambar ini dan apa saja warnanya? Jawab satu baris singkat.';

// Plafon jumlah provider yang disapu dalam satu pemindaian. Provider yang
// tidak mengklaim vision tetap dihitung terpisah; ini murni pengaman supaya
// satu pemindaian tidak pernah berubah menjadi ratusan permintaan.
const HARD_PROVIDER_CEILING = 120;

// ---------- katalog ----------

/** Ambil daftar model dari 9router. */
export async function listModels({ baseUrl, apiKey, timeoutMs = 20000 }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'x-api-key': apiKey }, signal: ac.signal });
    if (!res.ok) throw new Error(`GET /v1/models → HTTP ${res.status}`);
    const json = await res.json();
    return json.data || [];
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`GET /v1/models timeout setelah ${timeoutMs}ms`);
    throw new Error(`Tidak bisa membaca katalog model di ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- klasifikasi error ----------

/**
 * 9router membungkus error upstream jadi HTTP 503 dengan kode asli di dalam
 * pesannya, mis: `[<connId>/<model>] [402]: HTTP 402 (reset after 2m)`.
 * Kita bongkar supaya sebabnya berguna, bukan sekadar "503".
 */
export function classifyError(msg) {
  const s = String(msg || '');
  if (/timeout/i.test(s)) return 'timeout';
  if (/jawaban kosong|content.*kosong/i.test(s)) return 'kosong (200)';

  const m = s.match(/\[(\d{3})\]/);
  const code = m ? Number(m[1]) : null;
  if (code === 401 || code === 403) return 'auth/kredit (401/403)';
  if (code === 402) return 'kredit habis (402)';
  if (code === 404) return 'model tidak ada (404)';
  if (code === 429) return 'rate limit (429)';
  if (code && code >= 500) return 'upstream 5xx';

  const h = s.match(/HTTP (\d{3})/);
  if (h) {
    const c = Number(h[1]);
    if (c === 401 || c === 403) return 'auth/kredit (401/403)';
    if (c === 429) return 'rate limit (429)';
    if (c >= 500) return 'upstream 5xx';
  }
  return 'lain-lain';
}

// ---------- penyusunan kandidat ----------

/**
 * Susun kandidat secara round-robin antar-provider supaya gelombang awal
 * mencakup banyak provider, bukan menumpuk di satu provider saja.
 * Provider yang pernah berhasil (dari cache) didahulukan.
 */
export function interleaveByProvider(models, providerScore = {}) {
  const byProv = new Map();
  for (const m of models) {
    const p = m.owned_by || '?';
    if (!byProv.has(p)) byProv.set(p, []);
    byProv.get(p).push(m);
  }
  const score = (p) => {
    const s = providerScore[p];
    return s ? s.ok - s.fail : 0;
  };
  const providers = [...byProv.keys()].sort((a, b) => score(b) - score(a));

  const out = [];
  let depth = 0;
  for (;;) {
    let added = false;
    for (const p of providers) {
      const list = byProv.get(p);
      if (depth < list.length) {
        out.push(list[depth]);
        added = true;
      }
    }
    if (!added) break;
    depth++;
  }
  return out;
}

// ---------- cache ----------

export function readCache(baseUrl) {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    // Cache terikat ke baseUrl — 9router berbeda = daftar model berbeda.
    if (c.baseUrl !== baseUrl) return null;
    return c;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[discover] gagal menulis cache:', err.message);
  }
}

// ---------- pool konkurensi ----------

async function pool(items, worker, n) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------- penemuan ----------

/**
 * Pindai 9router untuk menemukan model yang benar-benar bisa memproses gambar.
 *
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.apiKey
 * @param {number} [o.target=5]      berhenti setelah sekian model bekerja
 * @param {number} [o.waveSize=8]    model per gelombang
 * @param {number} [o.maxProbe=48]   batas atas model yang dipindai (anti-boros)
 * @param {boolean} [o.includeNonVision=false] ikut uji yang tidak mengklaim vision
 * @param {string[]} [o.providers]   batasi ke provider ini saja (mis. ['ag','oc'])
 * @param {function} [o.onProgress]  dipanggil tiap gelombang selesai
 * @returns {Promise<object>} hasil + ringkasan
 */
export async function discoverVisionModels({
  baseUrl,
  apiKey,
  target = 5,
  waveSize = 8,
  maxProbe = 48,
  timeoutMs = 45000,
  concurrency = 6,
  includeNonVision = false,
  providers = null,
  onProgress = null,
} = {}) {
  const cache = readCache(baseUrl);
  const providerScore = cache?.providerScore || {};

  const catalog = await listModels({ baseUrl, apiKey });

  // Batasi ke provider tertentu kalau diminta. Ini berguna karena sebagian
  // instalasi hanya memakai beberapa provider saja — memindai 27 provider
  // padahal cuma 2 yang dipakai itu boros kuota dan waktu.
  const hanya = providers && providers.length ? new Set(providers) : null;
  const dalamCakupan = (m) => !hanya || hanya.has(m.owned_by);

  // Provider yang diminta tapi tidak ada di katalog — dilaporkan supaya tidak
  // diam-diam diabaikan (mis. typo nama provider, atau provider sudah dihapus).
  const providerHilang = hanya
    ? [...hanya].filter((p) => !catalog.some((m) => m.owned_by === p))
    : [];
  const visionClaiming = catalog.filter(
    (m) => m.capabilities?.vision === true && m.owned_by !== 'combo' && dalamCakupan(m)
  );
  const others = catalog.filter(
    (m) => m.capabilities?.vision !== true && m.owned_by !== 'combo' && dalamCakupan(m)
  );

  const candidates = includeNonVision ? [...visionClaiming, ...others] : visionClaiming;
  const ordered = interleaveByProvider(candidates, providerScore);

  // Setiap provider WAJIB dapat satu kesempatan sebelum anggaran dipakai untuk
  // memperdalam provider tertentu. Tanpa jaminan ini, anggaran kecil (mis. 16)
  // bisa habis di separuh provider pertama dan melewatkan provider yang justru
  // bekerja — persis kegagalan yang pernah terjadi: 32 provider, 16 probe,
  // dan `ag`/`cl` yang sehat tidak pernah tersentuh.
  const jumlahProvider = new Set(candidates.map((m) => m.owned_by)).size;
  const anggaran = Math.max(maxProbe, Math.min(jumlahProvider, HARD_PROVIDER_CEILING));

  const willProbe = ordered.slice(0, anggaran);
  const skipped = ordered.length - willProbe.length;

  const { mimeType, base64Data } = testImageBase64();
  const working = [];
  const failures = [];
  const probedModels = new Set();

  const totalWaves = Math.ceil(willProbe.length / waveSize);

  for (let w = 0; w < totalWaves; w++) {
    if (working.length >= target) break;

    const wave = willProbe.slice(w * waveSize, (w + 1) * waveSize);
    const results = await pool(
      wave,
      async (m) => {
        probedModels.add(m.id);
        const t0 = Date.now();
        try {
          const answer = await analyzeWithRouter9({
            base64Data,
            mimeType,
            prompt: PROBE_PROMPT,
            model: m.id,
            baseUrl,
            apiKey,
            timeoutMs,
          });
          const sc = scoreAnswer(answer);
          return {
            model: m.id,
            provider: m.owned_by,
            ok: sc.perfect,
            ms: Date.now() - t0,
            kind: sc.perfect ? 'ok' : 'jawaban tidak cocok',
            answer: String(answer).slice(0, 200),
          };
        } catch (err) {
          return {
            model: m.id,
            provider: m.owned_by,
            ok: false,
            ms: Date.now() - t0,
            kind: classifyError(err.message),
            error: String(err.message).slice(0, 250),
          };
        }
      },
      concurrency
    );

    for (const r of results) {
      if (r.ok) working.push(r);
      else failures.push(r);
    }

    if (onProgress) {
      onProgress({
        wave: w + 1,
        totalWaves,
        probed: probedModels.size,
        working: working.length,
        target,
        lastResults: results,
      });
    }
  }

  // Skor provider — dipakai untuk mengurutkan pemindaian berikutnya.
  const providerScoreNext = { ...providerScore };
  for (const r of [...working, ...failures]) {
    const p = r.provider || '?';
    if (!providerScoreNext[p]) providerScoreNext[p] = { ok: 0, fail: 0 };
    if (r.ok) providerScoreNext[p].ok++;
    else providerScoreNext[p].fail++;
  }

  const summary = {
    baseUrl,
    scannedAt: new Date().toISOString(),
    catalogTotal: catalog.length,
    visionClaiming: visionClaiming.length,
    providers: jumlahProvider,
    providerFilter: hanya ? [...hanya] : null,
    providerHilang,
    probed: probedModels.size,
    // Dilaporkan terbuka — batas yang tidak dilaporkan membuat hasil
    // terlihat "menyeluruh" padahal tidak.
    probeBudget: anggaran,
    notProbed: skipped,
    target,
    reachedTarget: working.length >= target,
    working: working.sort((a, b) => a.ms - b.ms),
    providerScore: providerScoreNext,
  };

  // Ringkas kegagalan per sebab SEBELUM menulis cache — kalau tidak,
  // ringkasan ini hilang dari file cache dan hanya muncul di stdout.
  const byKind = {};
  for (const f of failures) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  summary.failureKinds = byKind;

  writeCache(summary);
  return summary;
}

/**
 * Model terbaik dari cache (paling cepat yang terverifikasi).
 * @returns {string|null}
 */
export function getBestModel(baseUrl) {
  const c = readCache(baseUrl);
  if (!c || !c.working || !c.working.length) return null;
  return c.working[0].model;
}
