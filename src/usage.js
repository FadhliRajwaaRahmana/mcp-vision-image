/**
 * Pencatatan pemakaian analisis gambar ke file lokal.
 *
 * Struktur: { byModel: { "<model>": { count, lastUsedAt, errors } },
 *             byDay: { "YYYY-MM-DD": count } }
 *
 * Kunci memakai id model lengkap (mis. "ag/gemini-3.8-flash-high") karena
 * sejak v3.0.0 backend-nya cuma satu — yang menarik justru model mana yang
 * dipakai.
 *
 * Ditulis dengan pola fail-safe: kegagalan menulis statistik TIDAK boleh
 * menggagalkan permintaan analisis gambar yang sebenarnya.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE = path.join(__dirname, '..', 'stats', 'usage.json');

export function recordUsage(model, { success = true, errorMsg = null } = {}) {
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
    if (!stats.byModel) stats.byModel = {};
    if (!stats.byDay) stats.byDay = {};

    const today = new Date().toISOString().slice(0, 10);
    stats.byDay[today] = (stats.byDay[today] || 0) + 1;

    const key = model;
    if (!stats.byModel[key]) {
      stats.byModel[key] = { count: 0, lastUsedAt: null, errors: 0 };
    }
    stats.byModel[key].count += 1;
    stats.byModel[key].lastUsedAt = new Date().toISOString();
    if (!success) stats.byModel[key].errors += 1;
    if (errorMsg) stats.byModel[key].lastError = String(errorMsg).slice(0, 300);

    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error('[MCP Vision Stats] Gagal menulis statistik:', err.message);
  }
}

export function getUsageStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) {
      return { totalCalls: 0, today: 0, byModel: {}, byDay: {} };
    }
    const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    const today = new Date().toISOString().slice(0, 10);
    return {
      totalCalls: Object.values(stats.byModel || {}).reduce((a, m) => a + (m.count || 0), 0),
      today: stats.byDay?.[today] || 0,
      byModel: stats.byModel || {},
      byDay: stats.byDay || {},
    };
  } catch (err) {
    return {
      error: `Gagal membaca statistik: ${err.message}`,
      totalCalls: 0,
      today: 0,
      byModel: {},
      byDay: {},
    };
  }
}
