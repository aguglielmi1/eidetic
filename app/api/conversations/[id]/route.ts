import db from "@/lib/db";

export async function GET(_req: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  const { id } = await ctx.params;

  const conversation = db
    .prepare(`SELECT * FROM conversations WHERE id = ?`)
    .get(id);

  if (!conversation) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const messages = db
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(id);

  return Response.json({ ...conversation, messages });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));

  const existing = db.prepare(`SELECT id FROM conversations WHERE id = ?`).get(id);
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (body.title) {
    db.prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`).run(
      body.title,
      Date.now(),
      id
    );
  }

  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  const { id } = await ctx.params;
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  return Response.json({ ok: true });
}
