#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { processImageSource } from './image.js';
import { analyzeImage, getBackendInfo } from './analyze.js';
import { getUsageStats, recordUsage } from './usage.js';

const server = new McpServer({
  name: 'mcp-vision-image',
  version: '2.0.0',
});

// Pendaftaran Tool: analyze_image
server.tool(
  'analyze_image',
  'Menganalisis dan mendeskripsikan gambar (file path lokal atau URL) memakai rantai backend vision (9router → Gemini).',
  {
    image_path: z
      .string()
      .optional()
      .describe(
        'Path file gambar lokal di sistem (misal: "C:\\path\\to\\image.png" atau "./foto.jpg")'
      ),
    image_url: z
      .string()
      .optional()
      .describe(
        'URL gambar online yang di-copy dari browser atau clipboard (misal: "https://example.com/foto.jpg" atau URL berakhiran .png/.jpg/.webp/.gif). Server akan mengunduh gambar dari URL tersebut.'
      ),
    prompt: z
      .string()
      .optional()
      .describe(
        'Pertanyaan atau instruksi spesifik seputar gambar (misal: "Bacakan teks di gambar ini", "Apakah ada kucing?"). Default: deskripsi lengkap.'
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Paksa model tertentu (mis. "ag/gemini-3.8-flash-medium" untuk 9router, atau "gemini-3.6-flash" untuk Gemini langsung). Kosongkan agar tiap backend memakai default-nya.'
      ),
  },
  async ({ image_path, image_url, prompt, model }) => {
    try {
      const source = image_path || image_url;
      if (!source) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: Anda harus memberikan parameter `image_path` (file lokal) atau `image_url` (URL online).',
            },
          ],
          isError: true,
        };
      }

      const { mimeType, base64Data } = await processImageSource(source);

      const hasil = await analyzeImage({
        base64Data,
        mimeType,
        prompt: prompt || 'Deskripsikan gambar ini secara detail dalam Bahasa Indonesia.',
        model,
      });

      // Catat pemakaian per backend — berguna untuk melihat mana yang kepakai.
      recordUsage(hasil.backend, model || 'default', { success: true });

      const catatan = hasil.attempts
        .filter((a) => !a.ok)
        .map((a) => `${a.backend}: ${a.error}`)
        .join(' | ');

      return {
        content: [
          {
            type: 'text',
            text: catatan ? `${hasil.text}\n\n_(backend: ${hasil.backend}; dilewati → ${catatan})_` : hasil.text,
          },
        ],
      };
    } catch (err) {
      recordUsage('semua', model || 'default', { success: false, errorMsg: String(err.message).slice(0, 300) });
      return {
        content: [
          {
            type: 'text',
            text: `Gagal menganalisis gambar: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Pendaftaran Tool: get_usage_stats (monitoring pemakaian)
server.tool(
  'get_usage_stats',
  'Menampilkan statistik pemakaian analisis gambar: jumlah panggilan per backend, per model, riwayat harian, dan status backend mana saja yang siap dipakai.',
  {},
  async () => {
    const stats = getUsageStats();
    const backends = getBackendInfo();

    const lines = [
      `📊 **Statistik Pemakaian MCP Vision**`,
      ``,
      `**Backend (urutan fallback):**`,
    ];
    for (const b of backends) {
      const tanda = b.ready ? '✅ siap' : '⚠️  belum dikonfigurasi';
      lines.push(`- ${b.label}: ${tanda}${b.model ? ` — model default \`${b.model}\`` : ''}${b.note ? ` (${b.note})` : ''}`);
    }

    lines.push(
      ``,
      `- **Panggilan hari ini**: ${stats.today} request`,
      `- **Total panggilan (semua waktu)**: ${stats.totalCalls} request`,
      ``,
      `**Per Backend/Model:**`
    );

    const entries = Object.entries(stats.byModel || {});
    if (entries.length === 0) {
      lines.push(`- (belum ada pemakaian)`);
    } else {
      for (const [key, m] of entries) {
        lines.push(
          `- ${key}: ${m.count} panggilan (${m.errors} error), terakhir: ${m.lastUsedAt ? new Date(m.lastUsedAt).toLocaleString('id-ID') : '-'}`
        );
      }
    }

    lines.push(``, `**Riwayat Harian (7 hari terakhir):**`);
    const days = Object.entries(stats.byDay || {})
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7);
    if (days.length === 0) {
      lines.push(`- (belum ada data)`);
    } else {
      for (const [day, count] of days) {
        lines.push(`- ${day}: ${count} request`);
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Vision Image Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting MCP Vision Image Server:', err);
  process.exit(1);
});
