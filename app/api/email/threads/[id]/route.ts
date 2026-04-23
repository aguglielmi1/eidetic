import db from "@/lib/db";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/email/threads/[id]">
) {
  const { id } = await ctx.params;

  const documents = db.prepare(
    `SELECT id, original_name, email_message_id, email_thread_id,
            status, created_at, updated_at
     FROM documents
     WHERE file_type = 'email' AND email_thread_id = ?
     ORDER BY created_at ASC`
  ).all(id) as {
    id: string;
    original_name: string;
    email_message_id: string | null;
    email_thread_id: string | null;
    status: string;
    created_at: number;
    updated_at: number;
  }[];

  if (documents.length === 0) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }

  const messages = documents.map((doc) => {
    const headers = db.prepare(
      `SELECT text, email_from, email_to, email_subject, email_date
       FROM document_fragments
       WHERE document_id = ? AND fragment_type = 'email_headers'
       LIMIT 1`
    ).get(doc.id) as {
      text: string;
      email_from: string | null;
      email_to: string | null;
      email_subject: string | null;
      email_date: string | null;
    } | undefined;

    const bodies = db.prepare(
      `SELECT text FROM document_fragments
       WHERE document_id = ? AND fragment_type = 'email_body'
       ORDER BY created_at ASC`
    ).all(doc.id) as { text: string }[];

    return {
      document_id: doc.id,
      message_id: doc.email_message_id,
      subject: headers?.email_subject ?? doc.original_name,
      from: headers?.email_from ?? null,
      to: headers?.email_to ?? null,
      date: headers?.email_date ?? null,
      body: bodies.map((b) => b.text).join("\n\n"),
    };
  });

  return Response.json({
    thread_id: id,
    subject: messages[0]?.subject ?? null,
    messages,
  });
}
