import db from "@/lib/db";

interface ThreadRow {
  email_thread_id: string | null;
  subject: string | null;
  last_date: string | null;
  last_from: string | null;
  message_count: number;
  document_ids: string;
}

export async function GET() {
  // Group email fragments by thread id, pick the most recent fragment for the label.
  const rows = db.prepare(
    `WITH latest AS (
       SELECT f.email_thread_id,
              f.email_subject AS subject,
              f.email_date    AS last_date,
              f.email_from    AS last_from,
              ROW_NUMBER() OVER (
                PARTITION BY f.email_thread_id
                ORDER BY COALESCE(f.email_date, '') DESC, f.created_at DESC
              ) AS rn
       FROM document_fragments f
       WHERE f.email_thread_id IS NOT NULL
         AND f.fragment_type = 'email_headers'
     )
     SELECT l.email_thread_id,
            l.subject,
            l.last_date,
            l.last_from,
            COUNT(DISTINCT d.id) AS message_count,
            GROUP_CONCAT(DISTINCT d.id) AS document_ids
     FROM latest l
     JOIN documents d ON d.email_thread_id = l.email_thread_id
     WHERE l.rn = 1
     GROUP BY l.email_thread_id
     ORDER BY COALESCE(l.last_date, '') DESC
     LIMIT 200`
  ).all() as ThreadRow[];

  return Response.json(
    rows.map((r) => ({
      thread_id: r.email_thread_id,
      subject: r.subject,
      last_date: r.last_date,
      last_from: r.last_from,
      message_count: r.message_count,
      document_ids: (r.document_ids ?? "").split(",").filter(Boolean),
    }))
  );
}
