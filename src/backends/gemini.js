/**
 * Backend Gemini API langsung (Google AI Studio).
 *
 * Dipertahankan sebagai backend cadangan: kalau kuota free tier tersedia, ini
 * jalur paling langsung. Tapi sejak free tier dibatasi 20 request/hari per
 * model (terukur 24 Sep 2026: HTTP 429 `generate_content_free_tier_requests`),
 * backend ini TIDAK bisa diandalkan sebagai satu-satunya jalur.
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

export function getGeminiDefaultModel() {
  return DEFAULT_MODEL;
}

export async function analyzeWithGemini({
  base64Data,
  mimeType,
  prompt,
  model = DEFAULT_MODEL,
  apiKey = process.env.GEMINI_API_KEY,
  timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 60000),
}) {
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error('GEMINI_API_KEY belum diset.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Data } },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Gemini timeout setelah ${timeoutMs}ms.`);
    throw new Error(`Gemini tidak bisa dihubungi: ${err.message}`);
  }
  clearTimeout(timer);

  const data = await response.json();

  if (!response.ok) {
    const msg = data.error?.message || JSON.stringify(data);
    const code = data.error?.code || response.status;
    // 429 diberi label jelas supaya orkestrator tahu ini soal kuota, bukan bug.
    if (response.status === 429) {
      throw new Error(`Gemini kuota habis (429): ${msg.slice(0, 200)}`);
    }
    throw new Error(`Gemini API Error (${code}): ${msg.slice(0, 200)}`);
  }

  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('Gemini mengembalikan respons kosong (tidak ada candidates).');

  if (candidate.finishReason === 'SAFETY') {
    throw new Error('Gambar atau prompt diblokir oleh Gemini Safety Filter.');
  }

  const text = (candidate.content?.parts || [])
    .map((p) => p.text)
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!text) throw new Error('Tidak ada output teks dari Gemini API.');
  return text;
}
