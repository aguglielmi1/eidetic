import { spawn } from "child_process";
import path from "path";
import db from "@/lib/db";

export async function POST() {
  // Check if there are any dirty wiki pages
  const dirtyCount = db
    .prepare(`SELECT COUNT(*) as count FROM wiki_pages WHERE dirty = 1`)
    .get() as { count: number };

  if (dirtyCount.count === 0) {
    return Response.json({ ok: true, dirty_count: 0, message: "No dirty pages to rebuild" });
  }

  const dbPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "storage", "eidetic.db");
  const wikiPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "storage", "wiki");
  const scriptPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "ingestion", "wiki.py");
  const python = process.env.PYTHON_CMD ?? "python";
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";

  const child = spawn(
    python,
    [scriptPath, "dirty", dbPath, wikiPath, ollamaUrl],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();

  return Response.json({ ok: true, dirty_count: dirtyCount.count, message: "Rebuilding dirty pages" });
}

export async function GET() {
  const dirtyCount = db
    .prepare(`SELECT COUNT(*) as count FROM wiki_pages WHERE dirty = 1`)
    .get() as { count: number };

  const dirtyPages = db
    .prepare(`SELECT slug, page_type, title, updated_at FROM wiki_pages WHERE dirty = 1 ORDER BY updated_at DESC`)
    .all();

  const pendingJobs = db
    .prepare(`SELECT target_id, reason, status, created_at FROM job_queue WHERE job_type = 'rewiki' AND status IN ('pending', 'running') ORDER BY created_at DESC`)
    .all();

  return Response.json({
    dirty_count: dirtyCount.count,
    dirty_pages: dirtyPages,
    pending_jobs: pendingJobs,
  });
}
