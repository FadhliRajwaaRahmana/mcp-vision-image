# mcp-vision-image-fadhli

MCP server untuk analisis gambar lewat **[9router](https://github.com/decolua/9router)** — dengan **penemuan otomatis model vision yang benar-benar bekerja di mesin Anda**.

Tidak perlu daftar model hardcoded. Tidak perlu API key Google. Tidak ada quota free tier.

---

## Kenapa perlu penemuan otomatis?

9router mengekspos ratusan model, dan katalognya punya flag `capabilities.vision`. **Flag itu tidak bisa dipercaya.**

Diukur pada satu mesin (24 Sep 2026):

| | |
|---|---|
| Model di katalog | 824 |
| Mengklaim `vision: true` | 468 |
| **Benar-benar bisa memproses gambar** | **segelintir** |

Sampel 50 model yang mengklaim vision: hanya 4 yang menjawab benar. Sisanya gagal karena:

- `401/403` — API key provider mati
- `402` — kredit habis
- `5xx` — error upstream (dibungkus 9router jadi 503)
- **`200` dengan `content` kosong** — paling menyesatkan: HTTP sukses, tapi tidak ada jawaban
- timeout

**Yang penting:** penyebabnya hampir selalu **provider**, bukan model. Dan karena setiap instalasi 9router punya provider & akun yang berbeda, daftar model yang bekerja **tidak bisa di-hardcode** — harus ditemukan di mesin tempat server berjalan.

---

## Cara kerja

```
analyze_image
   │
   ├─ 1. Coba model eksplisit / env ROUTER9_MODEL / cache / default
   │     └─ berhasil? selesai. (kasus umum, cepat)
   │
   └─ 2. Semua gagal → pindai mesin ini
         ├─ sapu SATU model per provider (gelombang 1)
         ├─ provider hidup? perdalam di gelombang berikutnya
         ├─ uji pakai gambar 3 kotak, nilai jawabannya
         └─ simpan hasil → pakai model tercepat
```

**Mengapa menyapu provider dulu:** kegagalan itu soal provider. Menguji 5 model dari provider yang sama itu sia-sia — kalau providernya mati, kelimanya mati. Gelombang 1 mengambil satu model per provider, jadi berapa pun jumlah providernya, sekali jalan langsung ketahuan mana yang hidup.

**Model dinilai secara objektif.** Gambar uji berisi 3 kotak (merah, hijau, biru). Model yang benar-benar bisa melihat akan menyebut ketiga warna; model yang mengarang tidak akan cocok.

---

## Instalasi

```bash
npm install -g mcp-vision-image-fadhli
```

Butuh **9router berjalan** di mesin yang sama (default `http://127.0.0.1:20128`).

### Konfigurasi MCP

Tambahkan ke `~/.claude.json` (atau config MCP klien Anda):

```json
{
  "mcpServers": {
    "mcp-vision-image": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\ke\\mcp-vision-image\\src\\server.js"],
      "env": {
        "ROUTER9_API_KEY": "sk-xxxxxxxxxxxx"
      }
    }
  }
}
```

API key diambil dari dashboard 9router → **Endpoint & Key**.

> **Cuma satu key yang dibutuhkan.** Key 9router membuka seluruh pool model Anda — tidak perlu key Antigravity, B.AI, atau provider lain satu per satu.

### Variabel lingkungan

| Variabel | Default | Keterangan |
|---|---|---|
| `ROUTER9_API_KEY` | — | **Wajib.** API key 9router. |
| `VISION_PROVIDERS` | semua | Batasi pemindaian ke provider tertentu, dipisah koma (mis. `ag,oc`). |
| `ROUTER9_BASE_URL` | `http://127.0.0.1:20128` | Alamat 9router. |
| `ROUTER9_MODEL` | — | Paksa satu model, lewati pemilihan otomatis. |
| `ROUTER9_MAX_TOKENS` | `2000` | Batas token jawaban. |
| `ROUTER9_TIMEOUT_MS` | `120000` | Timeout per model. |

### Membatasi ke provider tertentu

Kalau Anda hanya memakai beberapa provider, batasi pemindaian supaya tidak
boros kuota dan waktu:

```json
"env": {
  "ROUTER9_API_KEY": "sk-xxxxxxxxxxxx",
  "VISION_PROVIDERS": "ag,oc"
}
```

`ag` = Antigravity, `oc` = OpenCode. Provider yang diminta tapi **tidak ada**
di katalog akan dilaporkan sebagai peringatan — tidak diabaikan diam-diam.

Efeknya terukur: memindai semua provider menemukan **4** model bekerja dari 30
diuji; dibatasi ke `ag` menemukan **9** dari 10 diuji — karena provider yang
sehat tidak lagi tenggelam di antara provider yang kreditnya habis.

---

## Tools

### `analyze_image`

Menganalisis gambar dari file lokal atau URL.

| Parameter | Keterangan |
|---|---|
| `image_path` | Path file lokal |
| `image_url` | URL gambar (diunduh otomatis) |
| `prompt` | Instruksi spesifik (opsional) |
| `model` | Paksa model tertentu (opsional) |

Jawabannya menyertakan model mana yang dipakai dan berapa lama.

### `discover_vision_models`

Memindai 9router untuk menemukan model yang benar-benar bisa memproses gambar di mesin ini. Hasilnya di-cache dan dipakai otomatis oleh `analyze_image`.

Jalankan ulang kalau daftar terasa basi (provider berganti, kredit berubah).

| Parameter | Default | Keterangan |
|---|---|---|
| `target` | 5 | Berhenti setelah sekian model bekerja |
| `max_probe` | 48 | Batas atas model diuji (pengaman kuota) |
| `include_non_vision` | false | Ikut uji yang tidak mengklaim vision — untuk memeriksa akurasi metadata |

**Batas selalu dilaporkan.** Kalau ada model yang tidak diuji karena kena batas, jumlahnya disebutkan — supaya hasilnya tidak terbaca "menyeluruh" padahal tidak.

### `get_usage_stats`

Statistik pemakaian per model, riwayat harian, status backend, dan ringkasan hasil pemindaian terakhir.

---

## Catatan teknis

### Kenapa endpoint Anthropic, bukan OpenAI?

Untuk input **gambar**, `/v1/chat/completions` di 9router mengembalikan **HTTP 200 dengan `content` kosong** — untuk semua model yang diuji. `/v1/messages` dengan model yang sama menjawab benar. Jadi ini soal jalur translasi gambar di 9router, bukan soal model.

| Endpoint | Hasil untuk input gambar |
|---|---|
| `/v1/chat/completions` | HTTP 200, `content` **kosong** |
| `/v1/messages` | jawaban benar |

### Blok thinking dibuang

Model thinking mengirim rantai penalaran di `thinking_delta` (sering dalam bahasa Mandarin). Parser hanya mengambil `text_delta`, dan `max_tokens` dijaga cukup tinggi supaya jatah tidak habis di thinking lalu menyisakan `content` kosong.

---

## Test

```bash
ROUTER9_API_KEY=xxx npm test
```

13 pemeriksaan, termasuk memanggil tool lewat protokol MCP sungguhan (stdio) dan memverifikasi jawaban terhadap gambar uji secara objektif.

Untuk memindai lebih luas di luar test:

```bash
node test/probe-vision.js --per-provider 2    # sampel stratifikasi
node test/probe-vision.js --all               # sapu bersih
node test/probe-vision.js --only ag/gemini-3.8-flash-high
node test/probe-vision.js --control           # uji akurasi metadata katalog
```

---

## Lisensi

MIT
