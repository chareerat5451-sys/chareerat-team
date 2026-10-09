import { authed, json, store } from "../lib/common.mjs";

// PUT ?op=upload&id=  (raw file body, header x-file-name)  -> stores the original file
// PUT ?op=text&id=    (text body)                           -> stores extracted text
// GET ?op=get&id=  -> original file;  GET ?op=text&id= -> text;  DELETE ?id=
export default async (req) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const s = store();
  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "";
  const id = url.searchParams.get("id") || "";
  if (!/^[a-z0-9]+$/i.test(id)) return json({ error: "bad id" }, 400);
  try {
    if (req.method === "PUT" && op === "upload") {
      let name = req.headers.get("x-file-name") || "file";
      try { name = decodeURIComponent(name); } catch { /* keep */ }
      const type = req.headers.get("content-type") || "application/octet-stream";
      await s.set("files/" + id, await req.arrayBuffer(), { metadata: { name, type } });
      return json({ ok: true });
    }
    if (req.method === "PUT" && op === "text") {
      await s.set("filetext/" + id, await req.text());
      return json({ ok: true });
    }
    if (req.method === "GET" && op === "get") {
      const r = await s.getWithMetadata("files/" + id, { type: "arrayBuffer" });
      if (!r) return json({ error: "not found" }, 404);
      const name = r.metadata?.name || "file";
      return new Response(r.data, {
        headers: {
          "content-type": r.metadata?.type || "application/octet-stream",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
          "cache-control": "no-store",
        },
      });
    }
    if (req.method === "GET" && op === "text") {
      const t = await s.get("filetext/" + id);
      if (t == null) return json({ error: "not found" }, 404);
      return new Response(t, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (req.method === "DELETE") {
      await s.delete("files/" + id);
      await s.delete("filetext/" + id);
      return json({ ok: true });
    }
    return json({ error: "unknown op" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config = { path: "/api/files" };
