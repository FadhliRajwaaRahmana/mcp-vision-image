/**
 * Shim kompatibilitas.
 *
 * Isi asli file ini (pemanggilan Gemini langsung + pencatatan statistik) sudah
 * dipindahkan ke `backends/gemini.js` dan `usage.js` saat MCP ini diubah
 * menjadi multi-backend dengan fallback.
 *
 * File ini dipertahankan supaya impor lama (`./gemini.js`) tidak langsung
 * patah. Kode baru sebaiknya mengimpor dari `./analyze.js` (orkestrator) atau
 * `./backends/*.js` (backend tunggal).
 */

export { analyzeWithGemini as analyzeImageWithGemini, getGeminiDefaultModel as getDefaultModel } from './backends/gemini.js';
export { getUsageStats, recordUsage } from './usage.js';
