/**
 * Test tanpa jaringan: urutan model & parser respons.
 *
 * Dua bug nyata yang dikunci di sini:
 *
 * 1. PARSER — model `oc/` menjawab JSON, Antigravity menjawab SSE. Parser yang
 *    hanya menangani SSE mengembalikan string kosong untuk `oc/`, sehingga
 *    jawaban yang sebenarnya ada dibuang lalu dilaporkan "jawaban kosong".
 *
 * 2. URUTAN MODEL — daftar kandidat cepat harus memuat provider `oc`, dan
 *    harus patuh pada VISION_PROVIDERS. Tanpa `oc` di daftar, pelapis gratis
 *    tidak pernah dicoba.
 *
 * Jalankan: node --test test/provider-chain.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAnthropicResponse } from "../src/backends/router9.js";
import { getProviderFilter, getModelChain } from "../src/analyze.js";

describe("parser respons /v1/messages", () => {
  test("JSON gaya OpenAI (dari oc/)", () => {
    const raw = '{"choices":[{"index":0,"message":{"role":"assistant","content":"MC-ANTHROPIC-OK"},"finish_reason":"stop"}]}';
    assert.equal(parseAnthropicResponse(raw).jawaban, "MC-ANTHROPIC-OK");
  });

  test("SSE gaya Anthropic (dari ag/)", () => {
    const raw = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ada 3 kotak"}}';
    assert.equal(parseAnthropicResponse(raw).jawaban, "Ada 3 kotak");
  });

  test("thinking_delta DITABIKAN di jalur SSE", () => {
    const raw =
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"用户需要..."}}\n' +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Jawaban final"}}';
    const r = parseAnthropicResponse(raw);
    assert.equal(r.jawaban, "Jawaban final");
    assert.match(r.thinking, /用户需要/);
  });

  test("JSON gaya Anthropic non-stream", () => {
    const raw = '{"content":[{"type":"text","text":"Halo dari Anthropic"}],"stop_reason":"end_turn"}';
    assert.equal(parseAnthropicResponse(raw).jawaban, "Halo dari Anthropic");
  });

  test("SSE gaya OpenAI (delta.content)", () => {
    const raw = 'data: {"choices":[{"delta":{"content":"potongan"}}]}\ndata: [DONE]';
    assert.equal(parseAnthropicResponse(raw).jawaban, "potongan");
  });

  test("masukan kosong tidak melempar", () => {
    assert.equal(parseAnthropicResponse("").jawaban, "");
    assert.equal(parseAnthropicResponse(null).jawaban, "");
  });

  test("stop_reason ikut terbaca", () => {
    const raw = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}';
    assert.equal(parseAnthropicResponse(raw).stopReason, "end_turn");
  });
});

describe("urutan model & filter provider", () => {
  test("default filter adalah ag,oc", () => {
    const simpan = process.env.VISION_PROVIDERS;
    delete process.env.VISION_PROVIDERS;
    assert.deepEqual(getProviderFilter(), ["ag", "oc"]);
    process.env.VISION_PROVIDERS = simpan;
  });

  test('"*" berarti semua provider (null)', () => {
    const simpan = process.env.VISION_PROVIDERS;
    process.env.VISION_PROVIDERS = "*";
    assert.equal(getProviderFilter(), null);
    process.env.VISION_PROVIDERS = simpan;
  });

  test("daftar kustom dibaca apa adanya", () => {
    const simpan = process.env.VISION_PROVIDERS;
    process.env.VISION_PROVIDERS = "ag";
    assert.deepEqual(getProviderFilter(), ["ag"]);
    process.env.VISION_PROVIDERS = simpan;
  });

  test("rantai model memuat kandidat oc (pelapis gratis)", () => {
    const simpan = process.env.VISION_PROVIDERS;
    delete process.env.VISION_PROVIDERS;
    const chain = getModelChain();
    assert.ok(
      chain.some((m) => m.startsWith("oc/")),
      "oc/* harus ada di rantai default — tanpanya pelapis gratis tidak pernah dicoba"
    );
    assert.ok(chain.some((m) => m.startsWith("ag/")), "ag/* harus ada di rantai default");
    process.env.VISION_PROVIDERS = simpan;
  });

  test("filter ag saja membuang kandidat oc", () => {
    const simpan = process.env.VISION_PROVIDERS;
    process.env.VISION_PROVIDERS = "ag";
    const chain = getModelChain();
    assert.ok(!chain.some((m) => m.startsWith("oc/")), "oc/* harus tersaring keluar");
    assert.ok(chain.some((m) => m.startsWith("ag/")));
    process.env.VISION_PROVIDERS = simpan;
  });

  test("model eksplisit selalu paling depan", () => {
    const chain = getModelChain("ag/gemini-3.8-flash-high");
    assert.equal(chain[0], "ag/gemini-3.8-flash-high");
  });
});
