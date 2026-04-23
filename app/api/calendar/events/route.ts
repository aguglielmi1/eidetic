import db from "@/lib/db";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "200"), 1000);

  const fromMs = from ? Date.parse(from) : Date.now() - 30 * 864e5;
  const toMs = to ? Date.parse(to) : Date.now() + 180 * 864e5;

  const rows = db.prepare(
    `SELECT id, uid, calendar_id, summary, description, location,
            start_at, end_at, rrule, status, completed, is_task,
            url, created_at, updated_at
     FROM events
     WHERE (start_at IS NULL OR start_at BETWEEN ? AND ?)
        OR (end_at   IS NOT NULL AND end_at   BETWEEN ? AND ?)
     ORDER BY COALESCE(start_at, end_at, created_at) ASC
     LIMIT ?`
  ).all(fromMs, toMs, fromMs, toMs, limit);

  return Response.json(rows);
}
