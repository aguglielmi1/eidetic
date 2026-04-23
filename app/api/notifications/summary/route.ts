import db from "@/lib/db";

/**
 * GET /api/notifications/summary
 *
 * Lightweight summary used by the in-app banner (polled every 60s).
 * Returns counts the UI needs to decide whether to show a nudge —
 *   - unreadEmails: emails ingested in the last 24 hours (we don't track
 *     read-state yet, so "recent" is the proxy)
 *   - upcomingMeetings: non-task events whose start_at is within the next
 *     10 minutes
 *   - watchedPersonMentions: count of messages from the last 24 hours that
 *     came from correspondents whose wiki page has watch=1
 */
export async function GET() {
  const now = Date.now();
  const dayAgo = now - 24 * 3600_000;
  const tenMin = now + 10 * 60_000;

  const unreadEmails = (db.prepare(
    `SELECT COUNT(*) AS cnt
       FROM documents
      WHERE file_type = 'email'
        AND created_at >= ?`
  ).get(dayAgo) as { cnt: number }).cnt;

  const upcomingMeetings = db.prepare(
    `SELECT uid, summary, start_at, end_at, location
       FROM events
      WHERE is_task = 0
        AND start_at IS NOT NULL
        AND start_at BETWEEN ? AND ?
      ORDER BY start_at ASC
      LIMIT 5`
  ).all(now, tenMin) as {
    uid: string;
    summary: string;
    start_at: number;
    end_at: number | null;
    location: string | null;
  }[];

  // Match email_from of recent email_headers fragments against watched
  // person-wiki pages (title holds the canonical email address).
  const watchedPersonMentions = (db.prepare(
    `SELECT COUNT(*) AS cnt
       FROM document_fragments f
       JOIN wiki_pages w
         ON w.page_type = 'person'
        AND w.watch = 1
        AND lower(f.email_from) LIKE '%' || lower(w.title) || '%'
      WHERE f.fragment_type = 'email_headers'
        AND f.created_at >= ?`
  ).get(dayAgo) as { cnt: number }).cnt;

  return Response.json({
    unreadEmails,
    upcomingMeetings,
    watchedPersonMentions,
    ts: now,
  });
}
