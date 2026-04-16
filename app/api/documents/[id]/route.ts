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

  return Response.json({ ...doc, fragments });
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
