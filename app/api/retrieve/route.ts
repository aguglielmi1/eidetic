import { spawnSync } from "child_process";
import path from "path";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const query: string = typeof body.query === "string" ? body.query.trim() : "";
  const n: number = typeof body.n === "number" ? Math.min(Math.max(body.n, 1), 20) : 5;

  if (!query) {
    return Response.json({ error: "query is required" }, { status: 400 });
  }

  const cwd = /*turbopackIgnore: true*/ process.cwd();
  const dbPath = path.join(cwd, "storage", "eidetic.db");
  const chromaPath = path.join(cwd, "storage", "chroma");
  const scriptPath = path.join(cwd, "ingestion", "retrieve.py");
  const python = process.env.PYTHON_CMD ?? "python";
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";

  const result = spawnSync(
    python,
    [scriptPath, query, dbPath, chromaPath, ollamaUrl, String(n)],
    { encoding: "utf8", timeout: 30_000, windowsHide: true }
  );

  if (result.error) {
    return Response.json({ error: "Retrieval failed: " + result.error.message }, { status: 500 });
  }

  if (result.status !== 0) {
    return Response.json(
      { error: "Retrieval script failed", stderr: result.stderr?.slice(0, 500) },
      { status: 500 }
    );
  }

  try {
    const chunks = JSON.parse(result.stdout);
    return Response.json(chunks);
  } catch {
    return Response.json({ error: "Invalid output from retrieval script" }, { status: 500 });
  }
}
