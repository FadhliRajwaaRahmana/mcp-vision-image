import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { processImageSource } from './image.js';
import { analyzeImageWithGemini, getUsageStats, getDefaultModel } from './gemini.js';

const server = new McpServer({
  name: 'mcp-vision-image',
  version: '1.0.0',
});

// Pendaftaran Tool: analyze_image
server.tool(
  'analyze_image',  'Menganalisis dan mendeskripsikan gambar (file path lokal atau URL) menggunakan Gemini Vision AI.',
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
      .describe('Model Gemini yang digunakan. Default: otomatis model Flash terbaru (gemini-flash-latest). Bisa di-override via env GEMINI_MODEL.'),
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

      const analysisResult = await analyzeImageWithGemini({
        base64Data,
        mimeType,
        prompt: prompt || 'Deskripsikan gambar ini secara detail dalam Bahasa Indonesia.',
        model: model || getDefaultModel(),
      });

      return {
        content: [
          {
            type: 'text',
            text: analysisResult,
          },
        ],
      };
    } catch (err) {
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

// Pendaftaran Tool: get_usage_stats (monitoring pemakaian API Gemini)
server.tool(
  'get_usage_stats',
  'Menampilkan statistik pemakaian API Gemini Vision (jumlah panggilan hari ini, total, sisa limit harian, per model, dan riwayat harian).',
  {},
  async () => {
    const stats = getUsageStats();
    const lines = [
      `📊 **Statistik Pemakaian MCP Vision (Gemini API)**`,
      ``,
      `- **Panggilan hari ini**: ${stats.today} / ${stats.todayLimit} request`,
      `- **Sisa hari ini**: ${stats.remainingToday} request`,
      `- **Total panggilan (semua waktu)**: ${stats.totalCalls} request`,
      ``,
      `**Per Model:**`,
    ];
    const models = Object.entries(stats.byModel || {});
    if (models.length === 0) {
      lines.push(`- (belum ada pemakaian)`);
    } else {
      for (const [model, m] of models) {
        lines.push(
          `- ${model}: ${m.count} panggilan (${m.errors} error), terakhir: ${m.lastUsedAt ? new Date(m.lastUsedAt).toLocaleString('id-ID') : '-'}`
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
