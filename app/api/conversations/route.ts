import { randomUUID } from "crypto";
import db from "@/lib/db";

export async function GET() {
  const rows = db
    .prepare(
      `SELECT id, title, mode, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC`
    )
    .all();
  return Response.json(rows);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const id = randomUUID();
  const now = Date.now();
  const title = (body.title as string) || "New conversation";
  const mode = (body.mode as string) || "chat";

  db.prepare(
    `INSERT INTO conversations (id, title, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, title, mode, now, now);

  return Response.json({ id, title, mode, created_at: now, updated_at: now }, { status: 201 });
}
