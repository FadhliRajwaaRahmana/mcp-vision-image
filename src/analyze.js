/**
 * Orkestrator analisis gambar: coba beberapa backend berurutan sampai ada
 * yang berhasil.
 *
 * KENAPA BERANTAI, BUKAN SATU BACKEND:
 * Sebelumnya modul ini hanya memanggil Gemini API langsung. Begitu free tier
 * kena batas (HTTP 429, 20 request/hari), MCP ini MATI TOTAL — tidak ada
 * jalur lain. Sekarang jalur utamanya 9router (memakai kuota langganan
 * Antigravity/B.AI yang sudah ada), dan Gemini hanya cadangan.
 *
 * URUTAN DEFAULT: 9router → gemini
 * Bisa diubah lewat env VISION_BACKENDS, mis. "gemini" atau "router9,gemini".
 */

import { analyzeWithRouter9, getRouter9DefaultModel } from './backends/router9.js';
import { analyzeWithGemini, getGeminiDefaultModel } from './backends/gemini.js';

const BACKENDS = {
  router9: {
    name: '9router',
    label: '9Router',
    run: analyzeWithRouter9,
    defaultModel: getRouter9DefaultModel,
    // 9router = gateway lokal; kalau tidak dikonfigurasi, langsung lewati.
    ready: () => Boolean(process.env.ROUTER9_API_KEY),
    notReady: 'ROUTER9_API_KEY belum diset',
  },
  gemini: {
    name: 'gemini',
    label: 'Gemini API',
    run: analyzeWithGemini,
    defaultModel: getGeminiDefaultModel,
    ready: () => Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE'),
    notReady: 'GEMINI_API_KEY belum diset',
  },
};

const DEFAULT_ORDER = (process.env.VISION_BACKENDS || 'router9,gemini')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function getBackendInfo() {
  return DEFAULT_ORDER.map((n) => {
    const b = BACKENDS[n];
    if (!b) return { name: n, label: n, ready: false, error: 'backend tidak dikenal' };
    return {
      name: b.name,
      label: b.label,
      ready: b.ready(),
      model: b.ready() ? b.defaultModel() : null,
      note: b.ready() ? null : b.notReady,
    };
  });
}

/**
 * Analisis gambar dengan fallback berantai.
 *
 * @returns {{ text: string, backend: string, attempts: Array<{backend:string,ok:boolean,ms:number,error?:string}> }}
 * @throws {Error} kalau SEMUA backend gagal — pesannya menggabungkan semua sebab.
 */
export async function analyzeImage({ base64Data, mimeType, prompt, model }) {
  const attempts = [];

  for (const nama of DEFAULT_ORDER) {
    const b = BACKENDS[nama];
    if (!b) {
      attempts.push({ backend: nama, ok: false, ms: 0, error: 'backend tidak dikenal' });
      continue;
    }
    if (!b.ready()) {
      attempts.push({ backend: nama, ok: false, ms: 0, error: b.notReady });
      continue;
    }

    const mulai = Date.now();
    try {
      const text = await b.run({ base64Data, mimeType, prompt, model: model || b.defaultModel() });
      attempts.push({ backend: nama, ok: true, ms: Date.now() - mulai });
      return { text, backend: nama, attempts };
    } catch (err) {
      attempts.push({ backend: nama, ok: false, ms: Date.now() - mulai, error: String(err.message || err).slice(0, 300) });
      // Lanjut ke backend berikutnya.
    }
  }

  const ringkas = attempts
    .map((a) => `  - ${a.backend}: ${a.error}`)
    .join('\n');
  throw new Error(`Semua backend vision gagal:\n${ringkas}`);
}
