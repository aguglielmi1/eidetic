import { randomUUID } from "crypto";
import ICAL from "ical.js";
import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from "tsdav";
import { xml2js, type Element as XmlElement } from "xml-js";
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

// ical.js eagerly hydrates date properties when you read them, and a
// malformed value (e.g. `DUE:NaN-aNNaNTNN:aN` from older builds before the
// `requireValidDate` guard, or anything an external client wrote) throws from
// inside `getFirstPropertyValue`. Don't let one bad property poison the whole
// component — return null and keep going.
function safeMs(comp: ICAL.Component, prop: string): number | null {
  try {
    const v = comp.getFirstPropertyValue(prop);
    if (v && typeof (v as ICAL.Time).toUnixTime === "function") {
      return (v as ICAL.Time).toUnixTime() * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

function safeString(comp: ICAL.Component, prop: string): string | null {
  try {
    const v = comp.getFirstPropertyValue(prop);
    return typeof v === "string" ? v : v == null ? null : String(v);
  } catch {
    return null;
  }
}

export function parseIcalObject(raw: string): ParsedEvent[] {
  const jcal = ICAL.parse(raw);
  const root = new ICAL.Component(jcal as unknown as unknown[]);

  const results: ParsedEvent[] = [];

  for (const vevent of root.getAllSubcomponents("vevent")) {
    const uid = safeString(vevent, "uid");
    if (!uid) continue;
    results.push({
      uid,
      summary: safeString(vevent, "summary"),
      description: safeString(vevent, "description"),
      location: safeString(vevent, "location"),
      start_at: safeMs(vevent, "dtstart"),
      end_at: safeMs(vevent, "dtend"),
      rrule: safeString(vevent, "rrule"),
      status: safeString(vevent, "status"),
      completed: false,
      isTask: false,
    });
  }

  for (const vtodo of root.getAllSubcomponents("vtodo")) {
    const uid = safeString(vtodo, "uid");
    if (!uid) continue;
    const status = safeString(vtodo, "status");
    results.push({
      uid,
      summary: safeString(vtodo, "summary"),
      description: safeString(vtodo, "description"),
      location: null,
      start_at: safeMs(vtodo, "dtstart"),
      end_at: safeMs(vtodo, "due"),
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
  const start = toIcalUtcStamp(Date.now() - pastDays * 864e5);
  const end = toIcalUtcStamp(Date.now() + futureDays * 864e5);

  let eventCount = 0;
  for (const cal of calendars) {
    if (!cal.url) continue;
    const components = Array.isArray(cal.components) ? cal.components : [];
    const want: { comp: "VEVENT" | "VTODO"; range?: { start: string; end: string } }[] = [];
    if (components.length === 0 || components.includes("VEVENT")) {
      want.push({ comp: "VEVENT", range: { start, end } });
    }
    if (components.length === 0 || components.includes("VTODO")) {
      want.push({ comp: "VTODO" });
    }

    const key = calendarKey(cal);
    for (const q of want) {
      let objects: DAVCalendarObject[];
      try {
        objects = await reportCalendarObjects(cfg, cal.url, q.comp, q.range);
      } catch (exc) {
        // Real network/parse failure (not a Stalwart "no matches" 404, which
        // reportCalendarObjects already swallows). Skip this comp-filter and
        // keep going so one broken query doesn't poison the whole sync.
        console.error(
          `[calendar] REPORT ${q.comp} failed`,
          cal.url,
          exc
        );
        continue;
      }
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
  }

  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('calendar_sync_last_run', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(Date.now()));

  return { calendars: calendars.length, events: eventCount };
}

// ---------------------------------------------------------------------------
// REPORT calendar-query helper
//
// We bypass tsdav's fetchCalendarObjects for two reasons:
//   1. Stalwart returns a non-RFC-4791 "no matches" response — a 207 multistatus
//      containing a single <response> with status 404 + "No resources found" on
//      the collection URL. tsdav treats any >=400 status inside the multistatus
//      as a hard error and throws. We need to recognise that pattern as empty.
//   2. tsdav's timeRange path only filters VEVENT, so VTODOs are never synced.
//      We want to query both component types per calendar.
// ---------------------------------------------------------------------------

function buildCalendarQueryBody(
  comp: "VEVENT" | "VTODO",
  range?: { start: string; end: string }
): string {
  const innerFilter = range
    ? `<C:comp-filter name="${comp}"><C:time-range start="${range.start}" end="${range.end}"/></C:comp-filter>`
    : `<C:comp-filter name="${comp}"/>`;
  return [
    `<?xml version="1.0" encoding="utf-8" ?>`,
    `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">`,
    `  <D:prop><D:getetag/><C:calendar-data/></D:prop>`,
    `  <C:filter><C:comp-filter name="VCALENDAR">${innerFilter}</C:comp-filter></C:filter>`,
    `</C:calendar-query>`,
  ].join("\n");
}

function findChild(el: XmlElement, name: string): XmlElement | undefined {
  if (!el.elements) return undefined;
  const lower = name.toLowerCase();
  return el.elements.find((c) => {
    const n = c.name?.toLowerCase() ?? "";
    return n === lower || n.endsWith(`:${lower}`);
  });
}

function findChildren(el: XmlElement, name: string): XmlElement[] {
  if (!el.elements) return [];
  const lower = name.toLowerCase();
  return el.elements.filter((c) => {
    const n = c.name?.toLowerCase() ?? "";
    return n === lower || n.endsWith(`:${lower}`);
  });
}

function elementText(el: XmlElement | undefined): string {
  if (!el?.elements) return "";
  return el.elements
    .map((c) => {
      if (c.type === "text") return typeof c.text === "string" ? c.text : "";
      if (c.type === "cdata") return typeof c.cdata === "string" ? c.cdata : "";
      return "";
    })
    .join("");
}

async function reportCalendarObjects(
  cfg: StalwartConfig,
  collectionUrl: string,
  comp: "VEVENT" | "VTODO",
  range?: { start: string; end: string }
): Promise<DAVCalendarObject[]> {
  const body = buildCalendarQueryBody(comp, range);
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  const res = await fetch(collectionUrl, {
    method: "REPORT",
    headers: {
      Authorization: `Basic ${auth}`,
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body,
  });

  if (res.status !== 207) {
    throw new Error(`REPORT returned HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const parsed = xml2js(text, { compact: false }) as { elements?: XmlElement[] };
  const multistatus = parsed.elements?.find((e) => {
    const n = e.name?.toLowerCase() ?? "";
    return n === "multistatus" || n.endsWith(":multistatus");
  });
  if (!multistatus) return [];

  const responses = findChildren(multistatus, "response");
  const collectionPath = new URL(collectionUrl).pathname;
  const results: DAVCalendarObject[] = [];

  for (const r of responses) {
    const hrefEl = findChild(r, "href");
    const href = elementText(hrefEl).trim();
    // Stalwart's "no matches" reply: a single <response> on the collection URL
    // itself with a 404 status. Skip it rather than treating it as an error.
    if (href === collectionPath || href === collectionUrl) continue;

    // Each <response> can contain multiple <propstat> blocks, only one of which
    // (the 200) carries calendar-data. Iterate them and pick that one.
    for (const propstat of findChildren(r, "propstat")) {
      const statusText = elementText(findChild(propstat, "status"));
      if (!/\b200\b/.test(statusText)) continue;
      const prop = findChild(propstat, "prop");
      if (!prop) continue;
      const etag = elementText(findChild(prop, "getetag")).replace(/^"|"$/g, "");
      const data = elementText(findChild(prop, "calendar-data"));
      if (!data) continue;
      const fullUrl = new URL(href, collectionUrl).href;
      results.push({ url: fullUrl, etag, data } as DAVCalendarObject);
    }
  }

  return results;
}

function toIcalUtcStamp(ms: number): string {
  // CalDAV time-range expects "20260101T000000Z" — date-time, no separators.
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function requireValidDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date for ${field}: ${JSON.stringify(value)}`);
  }
  return d;
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
  // Minutes before start for the VALARM trigger. Default 15. Pass 0 for "at
  // start time", or null/false to suppress the alarm entirely.
  alarmMinutesBefore?: number | null;
}

// Append a DISPLAY VALARM with a duration trigger. Negative offsetMinutes means
// "before start/due"; 0 means "exactly at"; positive would be "after".
function appendDisplayAlarm(
  parent: ICAL.Component,
  description: string,
  offsetMinutes: number
) {
  const valarm = new ICAL.Component("valarm");
  valarm.addPropertyWithValue("action", "DISPLAY");
  valarm.addPropertyWithValue("description", description || "Reminder");

  const trigger = new ICAL.Property("trigger");
  // ICAL.Duration.fromString understands "-PT15M", "PT0S", etc.
  const sign = offsetMinutes < 0 ? "-" : "";
  const magnitude = Math.abs(offsetMinutes);
  const dur = magnitude === 0 ? "PT0S" : `${sign}PT${magnitude}M`;
  trigger.setValue(ICAL.Duration.fromString(dur));
  valarm.addProperty(trigger);

  parent.addSubcomponent(valarm);
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
    ICAL.Time.fromJSDate(requireValidDate(input.start, "start"), true)
  );
  vevent.addPropertyWithValue(
    "dtend",
    ICAL.Time.fromJSDate(requireValidDate(input.end, "end"), true)
  );
  if (input.description) vevent.addPropertyWithValue("description", input.description);
  if (input.location) vevent.addPropertyWithValue("location", input.location);
  for (const a of input.attendees ?? []) {
    const prop = new ICAL.Property("attendee");
    prop.setValue(`mailto:${a}`);
    vevent.addProperty(prop);
  }

  // VALARM lives inside the VEVENT. iOS Calendar fires a local notification
  // when the trigger time hits — no APNs/server push needed for this path.
  const alarmMinutes = input.alarmMinutesBefore ?? 15;
  if (alarmMinutes !== null && alarmMinutes !== undefined) {
    appendDisplayAlarm(vevent, input.summary, -Math.abs(alarmMinutes));
  }

  vcalendar.addSubcomponent(vevent);
  return { uid, ics: vcalendar.toString() };
}

export interface BuildTaskInput {
  uid?: string;
  summary: string;
  due?: string;
  description?: string;
  // Minutes before due for the VALARM trigger. Default 0 (fire at due time).
  // null/false suppresses the alarm. Ignored when no `due` is set, since iOS
  // can't render a triggerless reminder alarm meaningfully.
  alarmMinutesBefore?: number | null;
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
    vtodo.addPropertyWithValue(
      "due",
      ICAL.Time.fromJSDate(requireValidDate(input.due, "due"), true)
    );
  }
  if (input.description) vtodo.addPropertyWithValue("description", input.description);
  vtodo.addPropertyWithValue("status", "NEEDS-ACTION");

  // For tasks, iOS Reminders only fires the VALARM when the VTODO has a DUE.
  // Skip the alarm for "someday" tasks rather than emitting a triggerless one.
  const alarmMinutes = input.alarmMinutesBefore ?? 0;
  if (input.due && alarmMinutes !== null && alarmMinutes !== undefined) {
    appendDisplayAlarm(vtodo, input.summary, -Math.abs(alarmMinutes));
  }

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
