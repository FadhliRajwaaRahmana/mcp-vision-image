# mcp-vision-image-fadhli

MCP server untuk analisis gambar (image vision) menggunakan **Gemini API** — berjalan via stdio.

## Fitur

- `analyze_image` — analisis gambar dari **path lokal** atau **URL online** (PNG/JPG/WebP/GIF/BMP/SVG)
- `get_usage_stats` — statistik pemakaian API (harian, per model, sisa limit)

## Instalasi & Penggunaan

Jalankan langsung via npx (tanpa install):

```bash
GEMINI_API_KEY=xxx npx -y mcp-vision-image-fadhli
```

### Setup di Claude Code

```bash
claude mcp add mcp-vision-image -s user -t stdio -e GEMINI_API_KEY=xxx -- npx -y mcp-vision-image-fadhli
```

Atau otomatis via [claudecode-setup](https://github.com/FadhliRajwaa/claudecode-setup) — wizard akan mendaftarkan server ini beserta MCP lain.

> **Catatan**: `GEMINI_API_KEY` wajib di-set (env atau parameter `apiKey`). Dapatkan key gratis di https://aistudio.google.com/apikey

## Penggunaan di Claude Code

Setelah terdaftar, minta bantuan dengan menyebut file/URL gambar:

```
analisis gambar ini: C:\path\ke\foto.png
```

## Development

```bash
npm install
GEMINI_API_KEY=xxx npm test   # smoke test
npm start                     # jalankan sebagai stdio server
```

## Lisensi

MIT
