import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const env = (k) => (globalThis.Netlify?.env?.get(k)) ?? process.env[k];

// trims spaces, collapses repeated spaces and normalizes Thai/Unicode so "Chareerat  SPB " matches "Chareerat SPB"
export const normPw = (s) => String(s || "").normalize("NFC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().replace(/\s+/g, " ");
export const passwordSet = () => !!normPw(env("APP_PASSWORD"));
const keyOf = (k) => String(env(k) || "").trim();
// which AI service to use: AI_PROVIDER=anthropic|openrouter forces one, otherwise whichever key exists (Anthropic first)
export function aiProvider() {
  const forced = keyOf("AI_PROVIDER").toLowerCase();
  if (forced === "openrouter" && keyOf("OPENROUTER_API_KEY")) return "openrouter";
  if (forced === "anthropic" && keyOf("ANTHROPIC_API_KEY")) return "anthropic";
  if (keyOf("ANTHROPIC_API_KEY")) return "anthropic";
  if (keyOf("OPENROUTER_API_KEY")) return "openrouter";
  return "";
}
export const apiKeySet = () => !!aiProvider();

export function authed(req) {
  const want = normPw(env("APP_PASSWORD"));
  let got = req.headers.get("x-app-password") || "";
  try { got = decodeURIComponent(got); } catch { /* keep raw */ }
  got = normPw(got);
  if (!want) return false;
  const a = createHash("sha256").update(want).digest();
  const b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b);
}

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export const store = () => getStore({ name: "research-team", consistency: "strong" });

const MODELS = {
  quick: () => env("CLAUDE_MODEL_QUICK") || "claude-haiku-4-5-20251001",
  default: () => env("CLAUDE_MODEL_DEFAULT") || "claude-sonnet-5-5",
  complex: () => env("CLAUDE_MODEL_COMPLEX") || "claude-opus-5-5",
};

const OR_MODELS = {
  quick: () => env("OPENROUTER_MODEL_QUICK") || "anthropic/claude-haiku-5.5",
  default: () => env("OPENROUTER_MODEL_DEFAULT") || "anthropic/claude-sonnet-5.5",
  complex: () => env("OPENROUTER_MODEL_COMPLEX") || "anthropic/claude-opus-5.5",
};

const JSON_NOTE = "\n\nตอบเป็น JSON อย่างเดียว ไม่มีข้อความอื่นก่อนหรือหลัง JSON";

// OpenRouter: same Claude models, billed through OpenRouter credits (OpenAI-style API)
async function callOpenRouter(input) {
  const key = keyOf("OPENROUTER_API_KEY");
  const model = (OR_MODELS[input.tier] || OR_MODELS.default)();
  const part = (b) => {
    if (b && b.type === "image" && b.source && b.source.data) return { type: "image_url", image_url: { url: `data:${b.source.media_type || "image/jpeg"};base64,${b.source.data}` } };
    return { type: "text", text: String((b && b.text) || "") };
  };
  const messages = (input.messages || []).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: Array.isArray(m.content) ? m.content.map(part) : String(m.content),
  }));
  if (input.json && messages.length) {
    const last = messages[messages.length - 1];
    if (Array.isArray(last.content)) last.content = [...last.content, { type: "text", text: JSON_NOTE }];
    else last.content += JSON_NOTE;
  }
  const body = { model, max_tokens: Math.min(Number(input.maxTokens) || 12000, 16000), messages };
  if (input.webSearch && env("WEB_SEARCH") !== "off") body.plugins = [{ id: "web", max_results: Number(env("WEB_SEARCH_MAX_USES")) || 8 }];
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key, "x-title": "Research Team" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* not json */ }
  if (!res.ok || (data && data.error)) {
    const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || raw.slice(0, 400);
    if (res.status === 402) throw new Error("เครดิต OpenRouter ไม่พอ เติมเครดิตที่ openrouter.ai/settings/credits");
    if (res.status === 401) throw new Error("OPENROUTER_API_KEY ไม่ถูกต้อง ตรวจคีย์ใน Netlify");
    throw new Error(`OpenRouter ${res.status}: ${String(msg).slice(0, 400)}`);
  }
  const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const text = Array.isArray(c) ? c.map((x) => x.text || "").join("") : String(c || "");
  if (!text) throw new Error("OpenRouter ไม่ส่งข้อความกลับ ลองใหม่อีกครั้ง");
  return text;
}

// input: { messages:[{role,content}], tier, webSearch, json, maxTokens }
export async function callClaude(input) {
  const provider = aiProvider();
  if (provider === "openrouter") return callOpenRouter(input);
  const key = env("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ยังไม่ได้ตั้งค่าคีย์ AI ใน Netlify (ANTHROPIC_API_KEY หรือ OPENROUTER_API_KEY)");
  const model = (MODELS[input.tier] || MODELS.default)();
  // content may be a string or an array of blocks (text / base64 images for reading scanned files)
  const messages = (input.messages || []).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: Array.isArray(m.content) ? m.content : String(m.content),
  }));
  if (input.json && messages.length) {
    const last = messages[messages.length - 1];
    const note = "\n\nตอบเป็น JSON อย่างเดียว ไม่มีข้อความอื่นก่อนหรือหลัง JSON";
    if (Array.isArray(last.content)) last.content = [...last.content, { type: "text", text: note }];
    else last.content += note;
  }
  const body = { model, max_tokens: Math.min(Number(input.maxTokens) || 12000, 16000), messages };
  if (input.webSearch && env("WEB_SEARCH") !== "off") {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: Number(env("WEB_SEARCH_MAX_USES")) || 8 }];
  }
  const texts = [];
  for (let turn = 0; turn < 5; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Claude API ${res.status}: ${t.slice(0, 400)}`);
    }
    const data = await res.json();
    const blocks = data.content || [];
    texts.push(blocks.filter((b) => b.type === "text").map((b) => b.text).join(""));
    if (data.stop_reason === "pause_turn") {
      body.messages = [...body.messages, { role: "assistant", content: blocks }];
      continue;
    }
    break;
  }
  // JSON calls: the final text run holds the answer; plain calls keep everything
  return input.json ? texts.filter(Boolean).pop() || "" : texts.join("");
}
