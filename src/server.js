#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { processImageSource } from './image.js';
import { analyzeImage, getBackendInfo, getProviderFilter } from './analyze.js';
import { discoverVisionModels, readCache } from './discover.js';
import { getUsageStats, recordUsage } from './usage.js';

// Versi dibaca dari package.json, bukan ditulis ulang di sini. Versi yang
// di-hardcode pernah tertinggal saat rilis (paket 3.1.0 tapi banner bilang
// 3.0.0) — sumber kebenaran harus satu saja.
const VERSI = (() => {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(p, 'utf-8')).version;
  } catch {
    return 'unknown';
  }
})();

const server = new McpServer({
  name: 'mcp-vision-image',
  version: VERSI,
});

function teks(s) {
  return { content: [{ type: 'text', text: s }] };
}
function galat(s) {
  return { content: [{ type: 'text', text: s }], isError: true };
}

// ---------- analyze_image ----------
server.tool(
  'analyze_image',
  'Menganalisis gambar (file lokal atau URL) lewat 9router. Model vision yang dipakai dipilih otomatis dari hasil pemindaian nyata di mesin ini — kalau belum pernah dipindai, pemindaian dijalankan lebih dulu.',
  {
    image_path: z.string().optional().describe('Path file gambar lokal (mis. "C:\\\\foto.png" atau "./foto.jpg")'),
    image_url: z.string().optional().describe('URL gambar online; server akan mengunduhnya.'),
    prompt: z
      .string()
      .optional()
      .describe('Instruksi spesifik seputar gambar. Default: deskripsi detail dalam Bahasa Indonesia.'),
    model: z
      .string()
      .optional()
      .describe('Paksa model tertentu (mis. "ag/gemini-3.8-flash-high"). Kosongkan agar dipilih otomatis.'),
  },
  async ({ image_path, image_url, prompt, model }) => {
    const source = image_path || image_url;
    if (!source) return galat('Error: berikan `image_path` (file lokal) atau `image_url` (URL online).');

    try {
      const { mimeType, base64Data } = await processImageSource(source);

      const hasil = await analyzeImage({
        base64Data,
        mimeType,
        prompt: prompt || 'Deskripsikan gambar ini secara detail dalam Bahasa Indonesia.',
        model,
      });

      recordUsage(hasil.model, { success: true });

      const gagal = hasil.attempts.filter((a) => !a.ok);
      const catatan = gagal.length
        ? `\n\n_(model: ${hasil.model}; dilewati → ${gagal.map((a) => `${a.model}: ${a.kind || a.error}`).join(' | ')})_`
        : `\n\n_(model: ${hasil.model}, ${hasil.totalMs}ms)_`;

      // Kalau pemindaian baru saja dijalankan, laporkan apa yang ditemukan.
      let infoPindai = '';
      if (hasil.discovery) {
        const d = hasil.discovery;
        infoPindai =
          `\n\n_(pemindaian otomatis: ${d.probed} model diuji, ${d.working.length} bekerja` +
          `${d.reachedTarget ? '' : `; target ${d.target} tidak tercapai`}` +
          `${d.notProbed ? `; ${d.notProbed} model tidak diuji (batas)` : ''})_`;
      }

      return teks(hasil.text + catatan + infoPindai);
    } catch (err) {
      recordUsage('semua', { success: false, errorMsg: String(err.message).slice(0, 300) });
      return galat(`Gagal menganalisis gambar: ${err.message}`);
    }
  }
);

// ---------- discover_vision_models ----------
server.tool(
  'discover_vision_models',
  'Memindai 9router untuk menemukan model yang BENAR-BENAR bisa memproses gambar di mesin ini, dengan menguji tiap model memakai gambar uji berisi 3 kotak berwarna. Hasilnya di-cache dan dipakai otomatis oleh analyze_image. Jalankan ulang kalau daftar model terasa basi (provider berganti, kredit berubah).',
  {
    target: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Berapa model yang bekerja ingin ditemukan sebelum berhenti. Default 5.'),
    max_probe: z
      .number()
      .int()
      .min(1)
      .max(400)
      .optional()
      .describe('Batas atas jumlah model yang diuji — pengaman kuota. Default 48.'),
    wave_size: z.number().int().min(1).max(50).optional().describe('Model per gelombang. Default 8.'),
    include_non_vision: z
      .boolean()
      .optional()
      .describe('Ikut uji model yang TIDAK mengklaim vision — untuk memeriksa akurasi metadata katalog. Default false.'),
    providers: z
      .string()
      .optional()
      .describe(
        'Batasi ke provider tertentu, dipisah koma (mis. "ag,oc"). Kosongkan untuk memakai VISION_PROVIDERS, atau semua provider kalau env itu juga kosong.'
      ),
    timeout_ms: z.number().int().min(5000).max(300000).optional().describe('Timeout per model. Default 45000.'),
  },
  async ({ target, max_probe, wave_size, include_non_vision, providers, timeout_ms }) => {
    const apiKey = process.env.ROUTER9_API_KEY;
    if (!apiKey) return galat('ROUTER9_API_KEY belum diset.');

    const bu = process.env.ROUTER9_BASE_URL || 'http://127.0.0.1:20128';
    const filter =
      providers && providers.trim()
        ? providers.split(',').map((s) => s.trim()).filter(Boolean)
        : getProviderFilter();
    try {
      const r = await discoverVisionModels({
        baseUrl: bu,
        apiKey,
        target: target ?? 5,
        maxProbe: max_probe ?? 48,
        waveSize: wave_size ?? 8,
        includeNonVision: include_non_vision ?? false,
        providers: filter,
        timeoutMs: timeout_ms ?? 45000,
      });

      const baris = [
        `🔍 **Pemindaian model vision 9router**`,
        ``,
        `- Katalog 9router: **${r.catalogTotal}** model`,
        `- Mengklaim vision: **${r.visionClaiming}**`,
        r.providerFilter ? `- Dibatasi ke provider: **${r.providerFilter.join(', ')}**` : `- Cakupan: semua provider (${r.providers})`,
        `- Benar-benar diuji: **${r.probed}**`,
        `- **Bekerja: ${r.working.length}**${r.reachedTarget ? ` (target ${r.target} tercapai)` : ` — target ${r.target} TIDAK tercapai`}`,
      ];
      if (r.providerHilang?.length) {
        baris.push(
          `- ⚠️ Provider yang diminta TIDAK ADA di katalog: **${r.providerHilang.join(', ')}**`
        );
      }
      if (r.notProbed) {
        baris.push(`- ⚠️ **${r.notProbed} model tidak diuji** (kena batas \`max_probe\`)`);
      }

      baris.push(``, `**Model yang bekerja** (tercepat dulu):`);
      if (!r.working.length) {
        baris.push(`- (tidak ada)`);
      } else {
        for (const w of r.working) baris.push(`- \`${w.model}\` — ${w.ms}ms (${w.provider})`);
      }

      const fk = r.failureKinds || {};
      if (Object.keys(fk).length) {
        baris.push(``, `**Sebab kegagalan model lain:**`);
        for (const [k, v] of Object.entries(fk).sort((a, b) => b[1] - a[1])) {
          baris.push(`- ${v}× ${k}`);
        }
      }

      baris.push(``, `_Hasil di-cache — \`analyze_image\` akan memakai model teratas secara otomatis._`);
      return teks(baris.join('\n'));
    } catch (err) {
      return galat(`Pemindaian gagal: ${err.message}`);
    }
  }
);

// ---------- get_usage_stats ----------
server.tool(
  'get_usage_stats',
  'Statistik pemakaian analisis gambar: jumlah per model, riwayat harian, status backend, dan ringkasan hasil pemindaian model vision.',
  {},
  async () => {
    const stats = getUsageStats();
    const b = getBackendInfo();

    const baris = [`📊 **Statistik MCP Vision**`, ``, `**Backend:**`];
    baris.push(
      `- ${b.label}: ${b.ready ? '✅ siap' : '⚠️ belum dikonfigurasi'}` +
        `${b.note ? ` (${b.note})` : ''} — \`${b.baseUrl}\``
    );
    baris.push(`- Model default: \`${b.defaultModel}\``);

    const filterAktif = getProviderFilter();
    if (filterAktif) {
      baris.push(`- Filter provider: \`${filterAktif.join(', ')}\` (dari VISION_PROVIDERS)`);
    }

    if (b.discovery) {
      const d = b.discovery;
      baris.push(
        ``,
        `**Pemindaian model vision terakhir:**`,
        `- Waktu: ${new Date(d.scannedAt).toLocaleString('id-ID')}`,
        `- Bekerja: **${d.working}** dari ${d.probed} diuji (katalog ${d.catalogTotal}, klaim vision ${d.visionClaiming})`,
        `- Cakupan: ${d.providerFilter ? `provider ${d.providerFilter.join(', ')}` : `semua provider (${d.providers})`}`,
        `- Target tercapai: ${d.reachedTarget ? 'ya' : 'TIDAK'}` +
          (d.notProbed ? ` | ${d.notProbed} tidak diuji` : '')
      );
      if (d.providerHilang?.length) {
        baris.push(`- ⚠️ Provider tidak ada di katalog: **${d.providerHilang.join(', ')}**`);
      }
      if (d.top?.length) {
        baris.push(`- Teratas: ${d.top.map((t) => `\`${t.model}\` (${t.ms}ms)`).join(', ')}`);
      }
    } else {
      baris.push(``, `**Pemindaian model vision:** belum pernah dijalankan.`);
      baris.push(`_Panggil \`discover_vision_models\` supaya \`analyze_image\` bisa memilih model otomatis._`);
    }

    baris.push(
      ``,
      `- **Panggilan hari ini**: ${stats.today}`,
      `- **Total panggilan**: ${stats.totalCalls}`,
      ``,
      `**Per model:**`
    );

    const entries = Object.entries(stats.byModel || {});
    if (!entries.length) {
      baris.push(`- (belum ada pemakaian)`);
    } else {
      for (const [key, m] of entries) {
        baris.push(
          `- \`${key}\`: ${m.count}× (${m.errors} error)` +
            `${m.lastUsedAt ? `, terakhir ${new Date(m.lastUsedAt).toLocaleString('id-ID')}` : ''}`
        );
      }
    }

    baris.push(``, `**Riwayat harian:**`);
    const days = Object.entries(stats.byDay || {})
      .sort((a, c) => c[0].localeCompare(a[0]))
      .slice(0, 7);
    if (!days.length) baris.push(`- (belum ada data)`);
    else for (const [day, count] of days) baris.push(`- ${day}: ${count}`);

    return teks(baris.join('\n'));
  }
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`MCP Vision Image Server v${VERSI} running on stdio`);
}

main().catch((err) => {
  console.error('Fatal error starting MCP Vision Image Server:', err);
  process.exit(1);
});
