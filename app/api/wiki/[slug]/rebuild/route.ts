import { spawn } from "child_process";
import path from "path";
import db from "@/lib/db";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);

  const page = db
    .prepare(`SELECT id, slug, source_doc_ids FROM wiki_pages WHERE slug = ?`)
    .get(decoded) as { id: string; slug: string; source_doc_ids: string } | undefined;

  if (!page) {
    return Response.json({ error: "Wiki page not found" }, { status: 404 });
  }

  const sourceIds: string[] = JSON.parse(page.source_doc_ids ?? "[]");
  if (sourceIds.length === 0) {
    return Response.json({ error: "No source documents linked" }, { status: 409 });
  }

  // Find the first valid source document to regenerate from
  const firstDoc = db
    .prepare(`SELECT id, status FROM documents WHERE id = ? AND status = 'processed'`)
    .get(sourceIds[0]) as { id: string; status: string } | undefined;

  if (!firstDoc) {
    return Response.json({ error: "No valid source document found" }, { status: 409 });
  }

  // Mark wiki status on the source document as generating
  db.prepare(
    `UPDATE documents SET wiki_status = 'generating', wiki_error = NULL, updated_at = ? WHERE id = ?`
  ).run(Date.now(), firstDoc.id);

  const dbPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "storage", "eidetic.db");
  const wikiPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "storage", "wiki");
  const scriptPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "ingestion", "wiki.py");
  const python = process.env.PYTHON_CMD ?? "python";
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";

  const child = spawn(
    python,
    [scriptPath, firstDoc.id, dbPath, wikiPath, ollamaUrl],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();

  return Response.json({ ok: true, rebuilding_from: firstDoc.id });
}
