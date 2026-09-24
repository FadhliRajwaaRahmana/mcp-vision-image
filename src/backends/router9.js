/**
 * Backend 9router — memakai endpoint Anthropic `/v1/messages`.
 *
 * KENAPA ANTHROPIC, BUKAN OPENAI:
 * Diukur 24 Sep 2026 pada 9router: untuk input GAMBAR, endpoint
 * `/v1/chat/completions` mengembalikan HTTP 200 dengan `content` KOSONG untuk
 * SEMUA model yang diuji — Antigravity maupun B.AI. Endpoint `/v1/messages`
 * pada model yang sama menjawab dengan benar. Jadi ini bukan soal model,
 * tapi soal jalur translasi gambar di 9router.
 *
 * Catatan: `DEFAULT_MODEL` di bawah hanyalah TEBAKAN TERAKHIR. Model yang
 * benar-benar dipakai dipilih oleh analyze.js dari hasil pemindaian nyata
 * (discover.js) — karena model yang bekerja berbeda-beda di tiap instalasi.
 *
 * Terukur (gambar 3 kotak merah/hijau/biru, jawaban harus menyebut ketiganya):
 *   ag/gemini-3.8-flash-high     OpenAI: kosong | Anthropic: "Ada 3 kotak, ..." OK
 *   ag/gemini-3.8-flash-medium   OpenAI: kosong | Anthropic: "Ada 3 kotak: ..." OK
 *   ag/gemini-3.7-flash-high     OpenAI: kosong | Anthropic: OK
 *   ag/gemini-3.6-flash-high     OpenAI: kosong | Anthropic: OK
 *   ag/claude-sonnet-4-6         OpenAI: kosong | Anthropic: OK
 *   ag/claude-opus-4-6-thinking  OpenAI: kosong | Anthropic: OK
 *   bai/mimo-v2.6-pro            OpenAI: kosong | Anthropic: OK
 *
 * Respons `/v1/messages` datang sebagai SSE. Kita merakit teks dari
 * `content_block_delta`, dan MENABAIKAN `thinking_delta` (model thinking
 * mengirim rantai penalaran di sana — sering dalam bahasa Mandarin, dan itu
 * bukan jawaban yang diinginkan pengguna).
 */

const DEFAULT_MODEL = process.env.ROUTER9_MODEL || 'ag/gemini-3.8-flash-medium';

export function getRouter9DefaultModel() {
  return DEFAULT_MODEL;
}

/**
 * Rakit teks jawaban dari stream SSE Anthropic.
 * Hanya `content_block_delta` dengan `text_delta` yang dihitung; blok
 * `thinking` sengaja dilewati.
 */
function parseAnthropicSse(raw) {
  let jawaban = '';
  let thinking = '';
  let stopReason = null;

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue; // potongan JSON belum lengkap — abaikan
    }

    if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      // `thinking_delta` = rantai penalaran, bukan jawaban.
      if (d.type === 'thinking_delta' && d.thinking) thinking += d.thinking;
      else if (d.text) jawaban += d.text;
    } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
      stopReason = ev.delta.stop_reason;
    }
  }

  return { jawaban: jawaban.trim(), thinking: thinking.trim(), stopReason };
}

export async function analyzeWithRouter9({
  base64Data,
  mimeType,
  prompt,
  model = DEFAULT_MODEL,
  baseUrl = process.env.ROUTER9_BASE_URL || 'http://127.0.0.1:20128',
  apiKey = process.env.ROUTER9_API_KEY,
  timeoutMs = Number(process.env.ROUTER9_TIMEOUT_MS || 120000),
}) {
  if (!apiKey) {
    throw new Error(
      'ROUTER9_API_KEY belum diset. Isi dengan API key 9router (lihat dashboard → API Keys).'
    );
  }

  const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/messages`;

  // Batas waktu eksplisit: model thinking bisa lama, tapi tidak boleh menggantung
  // selamanya — kalau lewat, biarkan backend berikutnya di rantai fallback.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: Number(process.env.ROUTER9_MAX_TOKENS || 2000),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mimeType, data: base64Data },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`9router timeout setelah ${timeoutMs}ms (model ${model}).`);
    }
    throw new Error(`9router tidak bisa dihubungi di ${url}: ${err.message}`);
  }
  clearTimeout(timer);

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`9router HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }

  const { jawaban, stopReason } = parseAnthropicSse(raw);

  if (!jawaban) {
    // Bedakan "diblokir" dari "benar-benar kosong" supaya pesan errornya berguna.
    const alasan = stopReason ? ` (stop_reason: ${stopReason})` : '';
    throw new Error(
      `9router mengembalikan jawaban kosong untuk model ${model}${alasan}. ` +
        `Coba model lain lewat env ROUTER9_MODEL.`
    );
  }

  return jawaban;
}
