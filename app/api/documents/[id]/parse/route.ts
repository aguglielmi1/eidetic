import { spawn } from "child_process";
import path from "path";
import db from "@/lib/db";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const doc = db
    .prepare(`SELECT id, file_path, status FROM documents WHERE id = ?`)
    .get(id) as { id: string; file_path: string; status: string } | undefined;

  if (!doc) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (doc.status === "processing") {
    return Response.json({ error: "Already processing" }, { status: 409 });
  }

  // Mark as processing
  db.prepare(
    `UPDATE documents SET status = 'processing', error_message = NULL, updated_at = ? WHERE id = ?`
  ).run(Date.now(), id);

  const dbPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "storage", "eidetic.db");
  const scriptPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "ingestion", "parse.py");
  const python = process.env.PYTHON_CMD ?? "python";

  // Spawn parser detached so it runs independently of the HTTP response
  const child = spawn(python, [scriptPath, id, doc.file_path, dbPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  return Response.json({ ok: true, status: "processing" });
}
