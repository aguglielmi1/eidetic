import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import db from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const doc = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
  if (!doc) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const fragments = db
    .prepare(`SELECT * FROM document_fragments WHERE document_id = ? ORDER BY created_at ASC`)
    .all(id);

  const chunks = db
    .prepare(`SELECT id, fragment_id, text, chroma_id, created_at FROM chunks WHERE document_id = ? ORDER BY created_at ASC`)
    .all(id);

  // Find wiki pages that reference this document
  const allWikiPages = db
    .prepare(`SELECT id, slug, page_type, title, source_doc_ids, dirty, updated_at FROM wiki_pages`)
    .all() as { id: string; slug: string; page_type: string; title: string; source_doc_ids: string; dirty: number; updated_at: number }[];

  const linkedWikiPages = allWikiPages
    .filter((p) => {
      const ids: string[] = JSON.parse(p.source_doc_ids ?? "[]");
      return ids.includes(id);
    })
    .map(({ source_doc_ids, ...rest }) => rest);

  return Response.json({ ...doc, fragments, chunks, wikiPages: linkedWikiPages });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  const doc = db.prepare(`SELECT id FROM documents WHERE id = ?`).get(id);
  if (!doc) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (typeof body.ignored === "number" || typeof body.ignored === "boolean") {
    const val = body.ignored ? 1 : 0;
    db.prepare(`UPDATE documents SET ignored = ?, updated_at = ? WHERE id = ?`).run(val, Date.now(), id);
  }

  const updated = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
  return Response.json(updated);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const doc = db.prepare(`SELECT file_path FROM documents WHERE id = ?`).get(id) as
    | { file_path: string }
    | undefined;

  if (!doc) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Phase 8 — mark wiki pages referencing this document as dirty before deletion
  const wikiPages = db.prepare(`SELECT id, slug, source_doc_ids FROM wiki_pages`).all() as {
    id: string; slug: string; source_doc_ids: string;
  }[];
  const now = Date.now();
  for (const page of wikiPages) {
    const sourceIds: string[] = JSON.parse(page.source_doc_ids ?? "[]");
    if (sourceIds.includes(id)) {
      db.prepare(`UPDATE wiki_pages SET dirty = 1, updated_at = ? WHERE id = ?`).run(now, page.id);
      // Enqueue rebuild job if not already pending
      const existing = db.prepare(
        `SELECT id FROM job_queue WHERE target_id = ? AND job_type = 'rewiki' AND status = 'pending'`
      ).get(page.slug);
      if (!existing) {
        db.prepare(
          `INSERT INTO job_queue (id, job_type, target_id, status, reason, created_at, updated_at)
           VALUES (?, 'rewiki', ?, 'pending', ?, ?, ?)`
        ).run(randomUUID(), page.slug, `source document ${id} deleted`, now, now);
      }
    }
  }

  // Remove file directory from storage/raw/{id}/
  const docDir = path.join(process.cwd(), "storage", "raw", id);
  if (fs.existsSync(docDir)) {
    fs.rmSync(docDir, { recursive: true, force: true });
  }

  // Cascade deletes fragments too (FK ON DELETE CASCADE)
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);

  return Response.json({ ok: true });
}
