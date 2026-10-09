import { authed, json, store, passwordSet, apiKeySet, aiProvider } from "../lib/common.mjs";

export default async (req) => {
  // public health check for the login screen: says only whether settings exist, never their values
  if (new URL(req.url).searchParams.get("op") === "status") return json({ ok: true, passwordSet: passwordSet(), apiKeySet: apiKeySet(), provider: aiProvider() || null });
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const s = store();
  const url = new URL(req.url);
  const op = url.searchParams.get("op");
  try {
    if (op === "ping") return json({ ok: true });
    if (op === "getState") return json((await s.get("state", { type: "json" })) || null);
    if (op === "putState" && req.method === "PUT") { await s.setJSON("state", await req.json()); return json({ ok: true }); }
    if (op === "listReviews") {
      const { blobs } = await s.list({ prefix: "reviews/" });
      const items = [];
      for (let i = 0; i < blobs.length; i += 50) {
        const part = await Promise.all(blobs.slice(i, i + 50).map((b) => s.get(b.key, { type: "json" })));
        items.push(...part.filter(Boolean));
      }
      return json(items);
    }
    if (op === "putReview" && req.method === "PUT") {
      const r = await req.json();
      if (!r || !r.id || !/^[a-z0-9]+$/i.test(r.id)) return json({ error: "bad id" }, 400);
      await s.setJSON("reviews/" + r.id, r);
      return json({ ok: true });
    }
    if (op === "deleteReview" && req.method === "DELETE") {
      const id = url.searchParams.get("id") || "";
      if (!/^[a-z0-9]+$/i.test(id)) return json({ error: "bad id" }, 400);
      await s.delete("reviews/" + id);
      return json({ ok: true });
    }
    if (op === "listLib") {
      const { blobs } = await s.list({ prefix: "library/" });
      const items = [];
      for (let i = 0; i < blobs.length; i += 50) {
        const part = await Promise.all(blobs.slice(i, i + 50).map((b) => s.get(b.key, { type: "json" })));
        items.push(...part.filter(Boolean));
      }
      return json(items);
    }
    if (op === "putLibMany" && req.method === "PUT") {
      const arr = await req.json();
      if (!Array.isArray(arr) || arr.length > 200) return json({ error: "bad body" }, 400);
      for (const it of arr) if (!it || !/^[a-z0-9]+$/i.test(it.id || "")) return json({ error: "bad id" }, 400);
      await Promise.all(arr.map((it) => s.setJSON("library/" + it.id, it)));
      return json({ ok: true, n: arr.length });
    }
    if (op === "deleteLibMany" && req.method === "PUT") {
      const ids = await req.json();
      if (!Array.isArray(ids)) return json({ error: "bad body" }, 400);
      await Promise.all(ids.filter((id) => /^[a-z0-9]+$/i.test(id)).map((id) => s.delete("library/" + id)));
      return json({ ok: true });
    }
    if (op === "wipe" && req.method === "DELETE") {
      for (const prefix of ["reviews/", "library/"]) {
        const { blobs } = await s.list({ prefix });
        for (let i = 0; i < blobs.length; i += 50) await Promise.all(blobs.slice(i, i + 50).map((b) => s.delete(b.key)));
      }
      await s.setJSON("state", { projects: [] });
      return json({ ok: true });
    }
    return json({ error: "unknown op" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config = { path: "/api/data" };
