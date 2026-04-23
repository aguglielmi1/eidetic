/**
 * Calendar sync CLI — runs the same syncCalendar() used by the API route.
 *
 * Usage (from repo root):
 *     node --loader tsx ingestion/calendar_sync.ts
 *
 * Reads STALWART_* env vars from the process environment. Safe to run on a
 * schedule; the sync is idempotent (UID-keyed upserts against the events
 * table, raw ICS stored verbatim for re-parsing).
 */

import { syncCalendar, getStalwartConfig } from "../lib/calendar";

async function main() {
  if (!getStalwartConfig()) {
    console.error("[calendar] STALWART_CALDAV_URL / USERNAME / PASSWORD not set — skipping");
    process.exit(2);
  }
  const result = await syncCalendar();
  console.log(`[calendar] synced ${result.events} event(s) across ${result.calendars} calendar(s)`);
}

main().catch((err) => {
  console.error("[calendar] sync failed:", err);
  process.exit(1);
});
