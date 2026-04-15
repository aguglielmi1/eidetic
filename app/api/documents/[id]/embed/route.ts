import { spawn } from "child_process";
import path from "path";
import db from "@/lib/db";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const doc = db
    .prepare(`SELECT id, status, embed_status FROM documents WHERE id = ?`)
    .get(id) as { id: string; status: string; embed_status: string | null } | undefined;

  if (!doc) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (doc.status !== "processed") {
    return Response.json(
      { error: "Document must be parsed before embedding" },
      { status: 409 }
    );
  }

  if (doc.embed_status === "embedding") {
    return Response.json({ error: "Already embedding" }, { status: 409 });
  }

  // Mark as embedding
  db.prepare(
    `UPDATE documents SET embed_status = 'embedding', embed_error = NULL, updated_at = ? WHERE id = ?`
  ).run(Date.now(), id);

  const dbPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "storage", "eidetic.db");
  const chromaPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "storage", "chroma");
  const scriptPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "ingestion", "embed.py");
  const python = process.env.PYTHON_CMD ?? "python";
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";

  const child = spawn(
    python,
    [scriptPath, id, dbPath, chromaPath, ollamaUrl],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();

  return Response.json({ ok: true, embed_status: "embedding" });
}
