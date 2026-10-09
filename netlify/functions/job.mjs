import { randomUUID } from "node:crypto";
import { authed, json, store } from "../lib/common.mjs";

// POST {input} -> {id}; GET ?id= -> {status,text,error}; DELETE ?id=
export default async (req) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const s = store();
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  if (req.method === "POST") {
    const { input } = await req.json();
    if (!input || !Array.isArray(input.messages)) return json({ error: "bad input" }, 400);
    const nid = randomUUID();
    await s.setJSON("jobs/" + nid, { status: "queued", input, createdAt: Date.now() });
    return json({ id: nid });
  }
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "bad id" }, 400);
  if (req.method === "GET") {
    const j = await s.get("jobs/" + id, { type: "json" });
    if (!j) return json({ status: "missing" });
    return json({ status: j.status, text: j.text, error: j.error });
  }
  if (req.method === "DELETE") { await s.delete("jobs/" + id); return json({ ok: true }); }
  return json({ error: "method" }, 405);
};

export const config = { path: "/api/job" };
