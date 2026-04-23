import db from "@/lib/db";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const n = Math.min(Number(url.searchParams.get("n") ?? "5"), 50);
  const now = Date.now();

  const rows = db.prepare(
    `SELECT id, uid, summary, description, location,
            start_at, end_at, status, is_task
     FROM events
     WHERE is_task = 0
       AND start_at IS NOT NULL
       AND start_at >= ?
     ORDER BY start_at ASC
     LIMIT ?`
  ).all(now, n);

  return Response.json(rows);
}
