import { spawn } from "child_process";
import path from "path";
import db from "@/lib/db";

export async function POST() {
  if (!process.env.STALWART_JMAP_URL) {
    return Response.json(
      { error: "Stalwart is not configured. Set STALWART_JMAP_URL in .env.local." },
      { status: 503 }
    );
  }

  const dbPath = path.join(process.cwd(), "storage", "eidetic.db");
  const rawDir = path.join(process.cwd(), "storage", "raw");
  const script = path.join(process.cwd(), "ingestion", "email_sync.py");
  const python = process.env.PYTHON_CMD ?? "python";

  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('email_sync_running', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run("1");

  const child = spawn(python, [script, dbPath, rawDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
    },
  });
  child.unref();

  return Response.json({ ok: true, status: "syncing" });
}

export async function GET() {
  const cursor = db.prepare(`SELECT value FROM settings WHERE key = 'email_sync_cursor'`).get() as
    | { value: string }
    | undefined;
  const last = db.prepare(`SELECT value FROM settings WHERE key = 'email_sync_last_run'`).get() as
    | { value: string }
    | undefined;
  const running = db.prepare(`SELECT value FROM settings WHERE key = 'email_sync_running'`).get() as
    | { value: string }
    | undefined;
  return Response.json({
    cursor: cursor?.value ?? null,
    last_run: last ? Number(last.value) : null,
    running: running?.value === "1",
    configured: !!process.env.STALWART_JMAP_URL,
  });
}
