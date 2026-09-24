# mcp-vision-image-fadhli

MCP server untuk analisis gambar (image vision) dengan **fallback berantai** — berjalan via stdio.

Tidak lagi bergantung pada satu penyedia. Kalau backend pertama kena batas kuota
atau error, otomatis pindah ke berikutnya.

## Kenapa berubah (v2.0.0)

Versi 1.x hanya memanggil **Gemini API langsung**. Free tier-nya sekarang
dibatasi **20 request/hari per model** (terukur 24 Sep 2026: HTTP 429
`generate_content_free_tier_requests`). Begitu batas itu kena, MCP ini
**mati total** — tidak ada jalur lain.

Versi 2.x memakai **9router** sebagai jalur utama. 9router adalah gateway lokal
yang memakai kuota **langganan** (Antigravity / B.AI) yang sudah Anda miliki,
bukan quota Google AI Studio.

## Urutan backend

Default: **9router → Gemini**

Atur lewat env `VISION_BACKENDS`, mis. `gemini` atau `gemini,router9`.

## Fitur

- `analyze_image` — analisis gambar dari **path lokal** atau **URL online** (PNG/JPG/WebP/GIF/BMP/SVG)
- `get_usage_stats` — statistik pemakaian per backend, riwayat harian, dan **status backend mana yang siap**

## Instalasi

```bash
npm install -g mcp-vision-image-fadhli
```

### Setup di Claude Code

```bash
claude mcp add mcp-vision-image -s user -t stdio \
  -e ROUTER9_API_KEY=sk-xxx \
  -- npx -y mcp-vision-image-fadhli
```

`ROUTER9_API_KEY` adalah API key 9router Anda (dashboard → API Keys).

### Setup di Pi

Tambahkan ke `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "mcp-vision-image": {
      "command": "node",
      "args": ["C:\\path\\ke\\mcp-vision-image\\src\\server.js"],
      "env": { "ROUTER9_API_KEY": "sk-xxx" }
    }
  }
}
```

## Environment variables

| Variable | Default | Keterangan |
|---|---|---|
| `ROUTER9_API_KEY` | — | **Wajib** untuk backend 9router. API key dari dashboard 9router. |
| `ROUTER9_BASE_URL` | `http://127.0.0.1:20128` | Alamat 9router. |
| `ROUTER9_MODEL` | `ag/gemini-3.8-flash-medium` | Model default di 9router. |
| `ROUTER9_TIMEOUT_MS` | `120000` | Batas waktu per panggilan 9router. |
| `ROUTER9_MAX_TOKENS` | `2000` | Batas token keluaran (model thinking butuh ruang). |
| `GEMINI_API_KEY` | — | Opsional, untuk backend cadangan Gemini. |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Model default Gemini langsung. |
| `VISION_BACKENDS` | `router9,gemini` | Urutan backend yang dicoba. |

## Catatan teknis: kenapa endpoint Anthropic

9router **hanya mengembalikan konten lewat `/v1/messages` (Anthropic)** untuk
input gambar. Lewat `/v1/chat/completions` (OpenAI), HTTP-nya 200 tapi
`content`-nya **kosong** — untuk semua model yang diuji.

Terukur pada gambar uji (3 kotak merah/hijau/biru):

| Model | OpenAI | Anthropic |
|---|---|---|
| `ag/gemini-3.8-flash-high` | kosong | ✅ "Ada 3 kotak, berwarna merah, hijau, dan biru." |
| `ag/gemini-3.8-flash-medium` | kosong | ✅ "Ada 3 kotak: merah, hijau, dan biru." |
| `ag/gemini-3.7-flash-high` | kosong | ✅ "Ada 3 kotak dengan warna merah, hijau, dan biru." |
| `ag/claude-sonnet-4-6` | kosong | ✅ "Terdapat 3 kotak dengan warna merah, hijau, dan biru." |
| `ag/claude-opus-4-6-thinking` | kosong | ✅ "Ada 3 kotak: merah, hijau, dan biru." |
| `bai/mimo-v2.6-pro` | kosong | ✅ "Ada 3 kotak berwarna merah, hijau, dan biru." |

Model thinking mengirim rantai penalaran di blok `thinking_delta` (sering
dalam bahasa Mandarin). Server ini **menabikan** blok itu dan hanya mengambil
`text_delta` — jawaban yang keluar selalu yang final.

## Test

```bash
ROUTER9_API_KEY=sk-xxx node test/test-server.js
```

Test membuat gambar uji sendiri (3 kotak berwarna) dan memverifikasi jawabannya
menyebut 3 kotak + merah/hijau/biru — jadi kelulusannya objektif, bukan sekadar
"tidak error".

## Lisensi

MIT
