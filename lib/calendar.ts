import { randomUUID } from "crypto";
import ICAL from "ical.js";
import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from "tsdav";
import db from "@/lib/db";

export interface EventRow {
  id: string;
  uid: string;
  calendar_id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_at: number | null;
  end_at: number | null;
  rrule: string | null;
  status: string | null;
  completed: number;
  is_task: number;
  etag: string | null;
  url: string | null;
  raw_ical: string;
  created_at: number;
  updated_at: number;
}

export interface StalwartConfig {
  caldavUrl: string;
  username: string;
  password: string;
}

export function getStalwartConfig(): StalwartConfig | null {
  const caldavUrl = process.env.STALWART_CALDAV_URL;
  const username = process.env.STALWART_USERNAME;
  const password = process.env.STALWART_PASSWORD;
  if (!caldavUrl || !username || !password) return null;
  return { caldavUrl, username, password };
}

export async function davClient(cfg: StalwartConfig) {
  return createDAVClient({
    serverUrl: cfg.caldavUrl,
    credentials: {
      username: cfg.username,
      password: cfg.password,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
}

export interface ParsedEvent {
  uid: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_at: number | null;
  end_at: number | null;
  rrule: string | null;
  status: string | null;
  completed: boolean;
  isTask: boolean;
}

export function parseIcalObject(raw: string): ParsedEvent[] {
  const jcal = ICAL.parse(raw);
  const root = new ICAL.Component(jcal as unknown as unknown[]);

  const results: ParsedEvent[] = [];

  for (const vevent of root.getAllSubcomponents("vevent")) {
    const event = new ICAL.Event(vevent);
    results.push({
      uid: event.uid,
      summary: event.summary ?? null,
      description: event.description ?? null,
      location: event.location ?? null,
      start_at: event.startDate ? event.startDate.toUnixTime() * 1000 : null,
      end_at: event.endDate ? event.endDate.toUnixTime() * 1000 : null,
      rrule: vevent.getFirstPropertyValue("rrule")?.toString() ?? null,
      status: (vevent.getFirstPropertyValue("status") as string | null) ?? null,
      completed: false,
      isTask: false,
    });
  }

  for (const vtodo of root.getAllSubcomponents("vtodo")) {
    const uid = vtodo.getFirstPropertyValue("uid") as string | null;
    if (!uid) continue;
    const summary = (vtodo.getFirstPropertyValue("summary") as string | null) ?? null;
    const description = (vtodo.getFirstPropertyValue("description") as string | null) ?? null;
    const due = vtodo.getFirstPropertyValue("due");
    const dtstart = vtodo.getFirstPropertyValue("dtstart");
    const status = (vtodo.getFirstPropertyValue("status") as string | null) ?? null;
    const startAt = dtstart && typeof (dtstart as ICAL.Time).toUnixTime === "function"
      ? (dtstart as ICAL.Time).toUnixTime() * 1000
      : null;
    const endAt = due && typeof (due as ICAL.Time).toUnixTime === "function"
      ? (due as ICAL.Time).toUnixTime() * 1000
      : null;

    results.push({
      uid,
      summary,
      description,
      location: null,
      start_at: startAt,
      end_at: endAt,
      rrule: null,
      status,
      completed: status === "COMPLETED",
      isTask: true,
    });
  }

  return results;
}

function upsertEvent(
  calendarId: string,
  obj: DAVCalendarObject,
  parsed: ParsedEvent
) {
  const now = Date.now();
  const existing = db
    .prepare(`SELECT id FROM events WHERE uid = ?`)
    .get(parsed.uid) as { id: string } | undefined;

  const eventId = existing?.id ?? randomUUID();
  const raw = obj.data ?? "";
  const url = obj.url ?? null;
  const etag = obj.etag ?? null;

  if (existing) {
    db.prepare(
      `UPDATE events
       SET calendar_id = ?, summary = ?, description = ?, location = ?,
           start_at = ?, end_at = ?, rrule = ?, status = ?, completed = ?,
           is_task = ?, etag = ?, url = ?, raw_ical = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      calendarId,
      parsed.summary,
      parsed.description,
      parsed.location,
      parsed.start_at,
      parsed.end_at,
      parsed.rrule,
      parsed.status,
      parsed.completed ? 1 : 0,
      parsed.isTask ? 1 : 0,
      etag,
      url,
      raw,
      now,
      eventId
    );
  } else {
    db.prepare(
      `INSERT INTO events
         (id, uid, calendar_id, summary, description, location,
          start_at, end_at, rrule, status, completed, is_task,
          etag, url, raw_ical, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId,
      parsed.uid,
      calendarId,
      parsed.summary,
      parsed.description,
      parsed.location,
      parsed.start_at,
      parsed.end_at,
      parsed.rrule,
      parsed.status,
      parsed.completed ? 1 : 0,
      parsed.isTask ? 1 : 0,
      etag,
      url,
      raw,
      now,
      now
    );
  }

  return eventId;
}

function writeEventFragment(eventId: string, parsed: ParsedEvent, raw: string) {
  const fragmentType = parsed.isTask ? "task" : "event";
  const text =
    [
      parsed.summary && `Title: ${parsed.summary}`,
      parsed.start_at && `Start: ${new Date(parsed.start_at).toISOString()}`,
      parsed.end_at && `End:   ${new Date(parsed.end_at).toISOString()}`,
      parsed.location && `Location: ${parsed.location}`,
      parsed.description && `Description:\n${parsed.description}`,
    ]
      .filter(Boolean)
      .join("\n") || raw;

  // Event fragments belong to a synthetic per-event pseudo-document so they
  // join the existing documents/fragments plumbing. We upsert one document
  // per UID, file_type = 'event'.
  const docRow = db
    .prepare(
      `SELECT id FROM documents WHERE file_type = 'event' AND original_name = ?`
    )
    .get(parsed.uid) as { id: string } | undefined;

  const now = Date.now();
  let docId = docRow?.id;
  if (!docId) {
    docId = randomUUID();
    db.prepare(
      `INSERT INTO documents
         (id, original_name, file_type, status, file_path, file_size, created_at, updated_at, fragment_count)
       VALUES (?, ?, 'event', 'processed', '', 0, ?, ?, 0)`
    ).run(docId, parsed.uid, now, now);
  }

  // Replace fragments for this event so re-sync doesn't accumulate duplicates.
  db.prepare(`DELETE FROM document_fragments WHERE document_id = ?`).run(docId);

  db.prepare(
    `INSERT INTO document_fragments
       (id, document_id, text, fragment_type,
        event_uid, event_start_at, event_end_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    docId,
    text,
    fragmentType,
    parsed.uid,
    parsed.start_at,
    parsed.end_at,
    now
  );

  db.prepare(
    `UPDATE documents SET updated_at = ?, fragment_count = 1 WHERE id = ?`
  ).run(now, docId);

  return docId;
}

function calendarKey(cal: DAVCalendar): string {
  return cal.url ?? cal.displayName ?? cal.ctag ?? "calendar";
}

/**
 * Pull every VEVENT/VTODO within a rolling window from every calendar
 * on the account, upsert into the events table, and write per-event fragments
 * so they are first-class RAG citations.
 */
export async function syncCalendar(opts?: {
  pastDays?: number;
  futureDays?: number;
}): Promise<{ calendars: number; events: number }> {
  const cfg = getStalwartConfig();
  if (!cfg) {
    throw new Error(
      "Stalwart is not configured (missing STALWART_CALDAV_URL / USERNAME / PASSWORD)"
    );
  }

  const client = await davClient(cfg);
  const calendars = await client.fetchCalendars();
  const pastDays = opts?.pastDays ?? 30;
  const futureDays = opts?.futureDays ?? 180;
  const start = new Date(Date.now() - pastDays * 864e5).toISOString();
  const end = new Date(Date.now() + futureDays * 864e5).toISOString();

  let eventCount = 0;
  for (const cal of calendars) {
    const objects = await client.fetchCalendarObjects({
      calendar: cal,
      timeRange: { start, end },
      expand: false,
    });

    const key = calendarKey(cal);
    for (const obj of objects) {
      const raw = obj.data;
      if (typeof raw !== "string" || !raw) continue;
      try {
        for (const parsed of parseIcalObject(raw)) {
          const eventId = upsertEvent(key, obj, parsed);
          writeEventFragment(eventId, parsed, raw);
          eventCount += 1;
        }
      } catch (exc) {
        console.error("[calendar] parse failure", obj.url, exc);
      }
    }
  }

  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('calendar_sync_last_run', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(Date.now()));

  return { calendars: calendars.length, events: eventCount };
}

// ---------------------------------------------------------------------------
// Event builder used by calendarTools.ts write paths
// ---------------------------------------------------------------------------

export interface BuildEventInput {
  uid?: string;
  summary: string;
  start: string; // ISO string
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
}

export function buildEventIcal(input: BuildEventInput): { uid: string; ics: string } {
  const uid = input.uid ?? `${randomUUID()}@eidetic.local`;

  const vcalendar = new ICAL.Component(["vcalendar", [], []]);
  vcalendar.addPropertyWithValue("prodid", "-//Eidetic//Calendar Tool//EN");
  vcalendar.addPropertyWithValue("version", "2.0");

  const vevent = new ICAL.Component("vevent");
  vevent.addPropertyWithValue("uid", uid);
  vevent.addPropertyWithValue("summary", input.summary);
  vevent.addPropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true)
  );
  vevent.addPropertyWithValue(
    "dtstart",
    ICAL.Time.fromJSDate(new Date(input.start), true)
  );
  vevent.addPropertyWithValue(
    "dtend",
    ICAL.Time.fromJSDate(new Date(input.end), true)
  );
  if (input.description) vevent.addPropertyWithValue("description", input.description);
  if (input.location) vevent.addPropertyWithValue("location", input.location);
  for (const a of input.attendees ?? []) {
    const prop = new ICAL.Property("attendee");
    prop.setValue(`mailto:${a}`);
    vevent.addProperty(prop);
  }

  vcalendar.addSubcomponent(vevent);
  return { uid, ics: vcalendar.toString() };
}

export interface BuildTaskInput {
  uid?: string;
  summary: string;
  due?: string;
  description?: string;
}

export function buildTaskIcal(input: BuildTaskInput): { uid: string; ics: string } {
  const uid = input.uid ?? `${randomUUID()}@eidetic.local`;

  const vcalendar = new ICAL.Component(["vcalendar", [], []]);
  vcalendar.addPropertyWithValue("prodid", "-//Eidetic//Calendar Tool//EN");
  vcalendar.addPropertyWithValue("version", "2.0");

  const vtodo = new ICAL.Component("vtodo");
  vtodo.addPropertyWithValue("uid", uid);
  vtodo.addPropertyWithValue("summary", input.summary);
  vtodo.addPropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true)
  );
  if (input.due) {
    vtodo.addPropertyWithValue("due", ICAL.Time.fromJSDate(new Date(input.due), true));
  }
  if (input.description) vtodo.addPropertyWithValue("description", input.description);
  vtodo.addPropertyWithValue("status", "NEEDS-ACTION");

  vcalendar.addSubcomponent(vtodo);
  return { uid, ics: vcalendar.toString() };
}

// Find the target calendar for write operations.
// Uses the first non-task-list calendar by default.
export async function pickDefaultCalendar(): Promise<DAVCalendar> {
  const cfg = getStalwartConfig();
  if (!cfg) throw new Error("Stalwart not configured");
  const client = await davClient(cfg);
  const calendars = await client.fetchCalendars();
  if (calendars.length === 0) {
    throw new Error("No CalDAV calendars available on the account");
  }
  const preferred =
    calendars.find((c) => Array.isArray(c.components) && c.components.includes("VEVENT"))
    ?? calendars[0];
  return preferred;
}
