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

  // Remove file directory from storage/raw/{id}/
  const docDir = path.join(process.cwd(), "storage", "raw", id);
  if (fs.existsSync(docDir)) {
    fs.rmSync(docDir, { recursive: true, force: true });
  }

  // Cascade deletes fragments too (FK ON DELETE CASCADE)
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);

  return Response.json({ ok: true });
}
