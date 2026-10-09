import { authed, json } from "../lib/common.mjs";

// GET /api/fetch?url=...  -> fetches a web page, document, Google Drive/Docs/Sheets/Slides file, or YouTube captions
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX = 5.5 * 1024 * 1024;

function blocked(u) {
  if (!/^https?:$/.test(u.protocol)) return true;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.startsWith("[") || h === "0.0.0.0") return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function rewrite(u) {
  const s = u.href;
  let m;
  if ((m = s.match(/docs\.google\.com\/document\/d\/([\w-]+)/))) return { url: `https://docs.google.com/document/d/${m[1]}/export?format=docx`, kind: "gdrive", name: "google-doc.docx" };
  if ((m = s.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/))) return { url: `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=xlsx`, kind: "gdrive", name: "google-sheet.xlsx" };
  if ((m = s.match(/docs\.google\.com\/presentation\/d\/([\w-]+)/))) return { url: `https://docs.google.com/presentation/d/${m[1]}/export/pptx`, kind: "gdrive", name: "google-slides.pptx" };
  if (/drive\.google\.com\/drive\/(u\/\d+\/)?folders\//.test(s)) return { error: "ลิงก์โฟลเดอร์ Google Drive เปิดโดยตรงไม่ได้ ให้ดาวน์โหลดโฟลเดอร์เป็น .zip แล้วลากมาวาง หรือส่งลิงก์ของแต่ละไฟล์" };
  if ((m = s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]+)/))) return { url: `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`, kind: "gdrive", name: "" };
  return { url: s, kind: "", name: "" };
}

const get = (url, signal) => fetch(url, { redirect: "follow", signal, headers: { "user-agent": UA, "accept-language": "th,en;q=0.8" } });

function youtubeId(u) {
  const h = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
  if (h === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (h === "youtube.com") return u.searchParams.get("v") || (u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]+)/) || [])[1] || null;
  return null;
}

async function youtube(id, signal) {
  const res = await get(`https://www.youtube.com/watch?v=${id}&hl=th`, signal);
  const html = await res.text();
  const title = ((html.match(/<title>([^<]*)<\/title>/) || [])[1] || "YouTube").replace(/ - YouTube$/, "");
  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (!m) throw new Error("วิดีโอนี้ไม่มีคำบรรยาย หรือ YouTube ไม่อนุญาตให้ดึงคำบรรยาย");
  let tracks;
  try { tracks = JSON.parse(m[1]); } catch { throw new Error("อ่านรายการคำบรรยายไม่ได้"); }
  const pick = tracks.find((t) => t.languageCode === "th") || tracks.find((t) => (t.languageCode || "").startsWith("en")) || tracks[0];
  const xml = await (await get(pick.baseUrl.replace(/\\u0026/g, "&"), signal)).text();
  const dec = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (x, n) => String.fromCharCode(+n));
  const lines = [...xml.matchAll(/<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)].map(([, st, t]) => {
    const s = Math.floor(+st);
    return `[${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}] ${dec(dec(t)).replace(/<[^>]+>/g, "")}`;
  });
  if (!lines.length) throw new Error("ดึงคำบรรยายไม่ได้");
  const lang = (pick.name && (pick.name.simpleText || pick.name.runs?.[0]?.text)) || pick.languageCode;
  return { title, text: `ชื่อวิดีโอ: ${title}\nภาษาคำบรรยาย: ${lang}${pick.kind === "asr" ? " (สร้างอัตโนมัติ)" : ""}\n\n` + lines.join("\n") };
}

export default async (req) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  let u;
  try { u = new URL(new URL(req.url).searchParams.get("url") || ""); } catch { return json({ error: "ลิงก์ไม่ถูกต้อง" }, 400); }
  if (blocked(u)) return json({ error: "ลิงก์นี้เปิดไม่ได้" }, 400);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const yt = youtubeId(u);
    if (yt) {
      const r = await youtube(yt, ctl.signal);
      return new Response(r.text, { headers: { "content-type": "text/plain; charset=utf-8", "x-src-kind": "youtube", "x-src-title": encodeURIComponent(r.title), "x-src-url": u.href, "cache-control": "no-store" } });
    }
    const rw = rewrite(u);
    if (rw.error) return json({ error: rw.error }, 400);
    const res = await get(rw.url, ctl.signal);
    if (!res.ok) {
      const msg = res.status === 401 || res.status === 403 ? "ไม่มีสิทธิ์เข้าถึงลิงก์นี้ (ถ้าเป็น Google Drive ให้ตั้งการแชร์เป็น \"ทุกคนที่มีลิงก์\")" : `เว็บไซต์ตอบกลับ ${res.status}`;
      return json({ error: msg }, 400);
    }
    if (blocked(new URL(res.url))) return json({ error: "ลิงก์นี้เปิดไม่ได้" }, 400);
    const ct = res.headers.get("content-type") || "application/octet-stream";
    if (rw.kind === "gdrive" && ct.includes("text/html")) return json({ error: "เปิดไฟล์ Google Drive ไม่ได้ ตรวจว่าตั้งการแชร์เป็น \"ทุกคนที่มีลิงก์ดูได้\"" }, 400);
    const len = +res.headers.get("content-length") || 0;
    if (len > MAX) return json({ error: "ไฟล์ใหญ่เกิน 5.5 MB ให้ดาวน์โหลดแล้วเปิดเป็นไฟล์แทน" }, 413);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX) return json({ error: "ไฟล์ใหญ่เกิน 5.5 MB ให้ดาวน์โหลดแล้วเปิดเป็นไฟล์แทน" }, 413);
    let name = rw.name;
    const cd = res.headers.get("content-disposition") || "";
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
    return new Response(buf, {
      headers: {
        "content-type": "application/octet-stream",
        "x-src-type": ct,
        "x-src-name": encodeURIComponent(name || ""),
        "x-src-url": res.url,
        "x-src-kind": rw.kind,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return json({ error: e?.name === "AbortError" ? "ลิงก์ใช้เวลานานเกินไป" : String(e?.message || e) }, 400);
  } finally {
    clearTimeout(timer);
  }
};

export const config = { path: "/api/fetch" };
