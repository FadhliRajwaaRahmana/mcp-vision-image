/**
 * Module untuk memanggil Gemini API generateContent (Multimodal / Vision)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_MODEL = 'gemini-3.7-flash';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE = path.join(__dirname, '..', 'stats', 'usage.json');

/**
 * Menyimpan statistik pemakaian API Gemini ke file lokal.
 * Struktur: { byModel: { [model]: { count, lastUsedAt, errors } }, byDay: { [YYYY-MM-DD]: count } }
 */
function recordUsage(model, { success = true, errorMsg = null } = {}) {
  try {
    const dir = path.dirname(STATS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let stats = { byModel: {}, byDay: {} };
    if (fs.existsSync(STATS_FILE)) {
      try {
        stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
      } catch {
        stats = { byModel: {}, byDay: {} };
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    stats.byDay[today] = (stats.byDay[today] || 0) + 1;

    if (!stats.byModel[model]) {
      stats.byModel[model] = { count: 0, lastUsedAt: null, errors: 0 };
    }
    stats.byModel[model].count += 1;
    stats.byModel[model].lastUsedAt = new Date().toISOString();
    if (!success) stats.byModel[model].errors += 1;
    if (errorMsg) stats.byModel[model].lastError = errorMsg.slice(0, 300);

    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (err) {
    // Jangan pernah crash request utama hanya karena gagal menyimpan statistik
    console.error('[MCP Vision Stats] Gagal menulis statistik:', err.message);
  }
}

export function getUsageStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) {
      return {
        totalCalls: 0,
        today: 0,
        todayLimit: 1500,
        remainingToday: 1500,
        byModel: {},
        byDay: {},
      };
    }
    const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = stats.byDay?.[today] || 0;
    const LIMIT = 1500;
    return {
      totalCalls: Object.values(stats.byModel || {}).reduce((a, m) => a + (m.count || 0), 0),
      today: todayCount,
      todayLimit: LIMIT,
      remainingToday: Math.max(0, LIMIT - todayCount),
      byModel: stats.byModel || {},
      byDay: stats.byDay || {},
    };
  } catch (err) {
    return {
      error: `Gagal membaca statistik: ${err.message}`,
      totalCalls: 0,
      today: 0,
      todayLimit: 1500,
      remainingToday: 1500,
      byModel: {},
      byDay: {},
    };
  }
}

export async function analyzeImageWithGemini({
  base64Data,
  mimeType,
  prompt = 'Deskripsikan gambar ini secara detail dalam Bahasa Indonesia.',
  model = DEFAULT_MODEL,
  apiKey = process.env.GEMINI_API_KEY,
}) {
  let activeKey = apiKey;

  if (!activeKey || activeKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error('GEMINI_API_KEY belum diset. Set env GEMINI_API_KEY (atau kirim apiKey via tool call) sebelum memanggil analyze_image.');
  }

  const selectedModel = model || DEFAULT_MODEL;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${encodeURIComponent(activeKey)}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-goog-api-key': activeKey,
  };

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: prompt,
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data,
            },
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data.error?.message || JSON.stringify(data);
      const errorCode = data.error?.code || response.status;
      recordUsage(selectedModel, { success: false, errorMsg });
      throw new Error(`Gemini API Error (${errorCode}): ${errorMsg}`);
    }

    const candidate = data.candidates?.[0];
    if (!candidate) {
      recordUsage(selectedModel, { success: false, errorMsg: 'Tidak ada candidates' });
      throw new Error('Gemini API mengembalikan respons kosong (tidak ada candidates).');
    }

    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
      if (candidate.finishReason === 'SAFETY') {
        recordUsage(selectedModel, { success: false, errorMsg: 'Safety Filter' });
        throw new Error('Gambar atau prompt diblokir oleh Gemini Safety Filter.');
      }
    }

    const parts = candidate.content?.parts || [];
    const textOutput = parts
      .map((p) => p.text)
      .filter(Boolean)
      .join('\n');

    if (!textOutput) {
      recordUsage(selectedModel, { success: false, errorMsg: 'Output kosong' });
      throw new Error('Tidak ada output teks dari Gemini API.');
    }

    recordUsage(selectedModel, { success: true });
    return textOutput;
  } catch (err) {
    // Pastikan error jaringan juga tercatat
    if (err && !err.message?.startsWith('Gemini API Error')) {
      recordUsage(selectedModel, { success: false, errorMsg: err.message });
    }
    throw err;
  }
}
