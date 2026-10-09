import { authed, store, callClaude } from "../lib/common.mjs";

// Background function (runs up to 15 minutes). Body: {id}
export default async (req) => {
  if (!authed(req)) return;
  const { id } = await req.json().catch(() => ({}));
  if (!/^[0-9a-f-]{36}$/.test(id || "")) return;
  const s = store();
  const key = "jobs/" + id;
  const job = await s.get(key, { type: "json" });
  if (!job || job.status !== "queued") return;
  await s.setJSON(key, { ...job, status: "running", startedAt: Date.now() });
  try {
    const text = await callClaude(job.input);
    await s.setJSON(key, { status: "done", text, finishedAt: Date.now() });
  } catch (e) {
    await s.setJSON(key, { status: "error", error: String(e?.message || e), finishedAt: Date.now() });
  }
};
