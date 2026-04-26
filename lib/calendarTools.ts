import crypto from "crypto";
import { z } from "zod";
import db from "@/lib/db";
import {
  buildEventIcal,
  buildTaskIcal,
  davClient,
  getStalwartConfig,
  parseIcalObject,
  pickDefaultCalendar,
  syncCalendar,
  type EventRow,
} from "@/lib/calendar";

// ---------------------------------------------------------------------------
// Tool schemas (zod)
// ---------------------------------------------------------------------------

export const listEventsSchema = z.object({
  range: z
    .enum(["today", "tomorrow", "this_week", "next_week", "custom"])
    .default("this_week"),
  from: z.string().optional(),
  to: z.string().optional(),
});

// ISO-8601 datetime guard. Accepts both with and without milliseconds, with
// either Z or +HH:MM offsets. Use this for every user/LLM-supplied date so we
// never pipe `new Date("tomorrow")` into ical.js (which silently writes a
// `DUE:NaN-aNNaNTNN:aN` property that Stalwart accepts but no client can read).
const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), {
    message: "must be a valid ISO-8601 datetime",
  });

export const createEventSchema = z.object({
  summary: z.string().min(1),
  start: isoDateTime,
  end: isoDateTime,
  description: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  location: z.string().optional(),
});

export const moveEventSchema = z.object({
  uid: z.string().min(1),
  newStart: isoDateTime,
  newEnd: isoDateTime,
});

export const cancelEventSchema = z.object({
  uid: z.string().min(1),
});

export const createTaskSchema = z.object({
  summary: z.string().min(1),
  due: isoDateTime.optional(),
  description: z.string().optional(),
});

export const completeTaskSchema = z.object({
  uid: z.string().min(1),
});

export type ToolName =
  | "listEvents"
  | "createEvent"
  | "moveEvent"
  | "cancelEvent"
  | "createTask"
  | "completeTask";

export const READ_ONLY_TOOLS: ToolName[] = ["listEvents"];
export const WRITE_TOOLS: ToolName[] = [
  "createEvent",
  "moveEvent",
  "cancelEvent",
  "createTask",
  "completeTask",
];

const SCHEMA_FOR: Record<ToolName, z.ZodTypeAny> = {
  listEvents: listEventsSchema,
  createEvent: createEventSchema,
  moveEvent: moveEventSchema,
  cancelEvent: cancelEventSchema,
  createTask: createTaskSchema,
  completeTask: completeTaskSchema,
};

export function validateArgs(tool: ToolName, args: unknown) {
  const schema = SCHEMA_FOR[tool];
  if (!schema) throw new Error(`Unknown tool: ${tool}`);
  return schema.parse(args);
}

// ---------------------------------------------------------------------------
// Payload signing — prevents forged execute() calls
// ---------------------------------------------------------------------------

function signingKey(): string {
  const key = process.env.AUTH_SECRET;
  if (!key) throw new Error("AUTH_SECRET is required for calendar tool signing");
  return key;
}

export function signProposal(payload: object): string {
  const body = JSON.stringify(payload);
  return crypto.createHmac("sha256", signingKey()).update(body).digest("hex");
}

export function verifyProposal(payload: object, signature: string): boolean {
  const expected = signProposal(payload);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Range helpers
// ---------------------------------------------------------------------------

function dayBoundary(offsetDays: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() + offsetDays * 864e5;
}

export function resolveRange(args: z.infer<typeof listEventsSchema>): [number, number] {
  switch (args.range) {
    case "today":
      return [dayBoundary(0), dayBoundary(1) - 1];
    case "tomorrow":
      return [dayBoundary(1), dayBoundary(2) - 1];
    case "this_week":
      return [dayBoundary(0), dayBoundary(7)];
    case "next_week":
      return [dayBoundary(7), dayBoundary(14)];
    case "custom": {
      const from = args.from ? Date.parse(args.from) : dayBoundary(0);
      const to = args.to ? Date.parse(args.to) : dayBoundary(7);
      return [from, to];
    }
  }
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

export interface ToolResult {
  tool: ToolName;
  ok: boolean;
  message: string;
  events?: unknown[];
  event?: unknown;
  error?: string;
}

export async function executeTool(tool: ToolName, args: unknown): Promise<ToolResult> {
  const cfg = getStalwartConfig();
  if (!cfg) {
    return {
      tool,
      ok: false,
      message: "Stalwart calendar is not configured on this server.",
      error: "missing_config",
    };
  }

  try {
    const parsed = validateArgs(tool, args);
    switch (tool) {
      case "listEvents":
        return listEventsExecutor(parsed as z.infer<typeof listEventsSchema>);
      case "createEvent":
        return await createEventExecutor(parsed as z.infer<typeof createEventSchema>);
      case "moveEvent":
        return await moveEventExecutor(parsed as z.infer<typeof moveEventSchema>);
      case "cancelEvent":
        return await cancelEventExecutor(parsed as z.infer<typeof cancelEventSchema>);
      case "createTask":
        return await createTaskExecutor(parsed as z.infer<typeof createTaskSchema>);
      case "completeTask":
        return await completeTaskExecutor(parsed as z.infer<typeof completeTaskSchema>);
      default:
        return { tool, ok: false, message: `Unknown tool: ${tool}`, error: "unknown_tool" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { tool, ok: false, message: `Tool ${tool} failed: ${message}`, error: message };
  }
}

function listEventsExecutor(args: z.infer<typeof listEventsSchema>): ToolResult {
  const [fromMs, toMs] = resolveRange(args);
  const rows = db.prepare(
    `SELECT uid, summary, description, location,
            start_at, end_at, status, is_task
     FROM events
     WHERE is_task = 0
       AND start_at IS NOT NULL
       AND start_at BETWEEN ? AND ?
     ORDER BY start_at ASC`
  ).all(fromMs, toMs);

  return {
    tool: "listEvents",
    ok: true,
    message: `Found ${rows.length} event(s) in the selected range.`,
    events: rows,
  };
}

async function createEventExecutor(args: z.infer<typeof createEventSchema>): Promise<ToolResult> {
  const cal = await pickDefaultCalendar();
  const { uid, ics } = buildEventIcal(args);
  const cfg = getStalwartConfig()!;
  const client = await davClient(cfg);

  const url = joinUrl(cal.url, `${uid}.ics`);
  await client.createCalendarObject({
    calendar: cal,
    filename: `${uid}.ics`,
    iCalString: ics,
  });

  // Refresh local cache so subsequent reads see the new event.
  await syncCalendar();

  return {
    tool: "createEvent",
    ok: true,
    message: `Created event "${args.summary}" at ${args.start}.`,
    event: { uid, url, summary: args.summary, start: args.start, end: args.end },
  };
}

async function moveEventExecutor(args: z.infer<typeof moveEventSchema>): Promise<ToolResult> {
  const row = db.prepare(`SELECT * FROM events WHERE uid = ?`).get(args.uid) as
    | EventRow
    | undefined;
  if (!row) {
    return { tool: "moveEvent", ok: false, message: `No event found for uid ${args.uid}`, error: "not_found" };
  }

  const current = parseIcalObject(row.raw_ical)[0];
  if (!current) {
    return { tool: "moveEvent", ok: false, message: "Could not parse stored iCal", error: "parse_error" };
  }

  const { ics } = buildEventIcal({
    uid: args.uid,
    summary: current.summary ?? "",
    start: args.newStart,
    end: args.newEnd,
    description: current.description ?? undefined,
    location: current.location ?? undefined,
  });

  const cfg = getStalwartConfig()!;
  const client = await davClient(cfg);

  if (!row.url) {
    return { tool: "moveEvent", ok: false, message: "Event has no CalDAV url", error: "missing_url" };
  }

  await client.updateCalendarObject({
    calendarObject: {
      url: row.url,
      etag: row.etag ?? undefined,
      data: ics,
    },
  });

  await syncCalendar();
  return {
    tool: "moveEvent",
    ok: true,
    message: `Moved event "${current.summary ?? args.uid}" to ${args.newStart}.`,
    event: { uid: args.uid, start: args.newStart, end: args.newEnd },
  };
}

async function cancelEventExecutor(args: z.infer<typeof cancelEventSchema>): Promise<ToolResult> {
  const row = db.prepare(`SELECT * FROM events WHERE uid = ?`).get(args.uid) as
    | EventRow
    | undefined;
  if (!row || !row.url) {
    return { tool: "cancelEvent", ok: false, message: `No event found for uid ${args.uid}`, error: "not_found" };
  }

  const cfg = getStalwartConfig()!;
  const client = await davClient(cfg);
  await client.deleteCalendarObject({
    calendarObject: {
      url: row.url,
      etag: row.etag ?? undefined,
      data: row.raw_ical,
    },
  });

  db.prepare(`DELETE FROM events WHERE uid = ?`).run(args.uid);
  db.prepare(`DELETE FROM documents WHERE file_type = 'event' AND original_name = ?`).run(args.uid);

  return {
    tool: "cancelEvent",
    ok: true,
    message: `Cancelled event ${row.summary ?? args.uid}.`,
  };
}

async function createTaskExecutor(args: z.infer<typeof createTaskSchema>): Promise<ToolResult> {
  const cal = await pickDefaultCalendar();
  const { uid, ics } = buildTaskIcal(args);
  const cfg = getStalwartConfig()!;
  const client = await davClient(cfg);
  await client.createCalendarObject({
    calendar: cal,
    filename: `${uid}.ics`,
    iCalString: ics,
  });
  await syncCalendar();
  return {
    tool: "createTask",
    ok: true,
    message: `Created task "${args.summary}"${args.due ? ` due ${args.due}` : ""}.`,
    event: { uid, summary: args.summary, due: args.due ?? null },
  };
}

async function completeTaskExecutor(args: z.infer<typeof completeTaskSchema>): Promise<ToolResult> {
  const row = db.prepare(`SELECT * FROM events WHERE uid = ? AND is_task = 1`).get(args.uid) as
    | EventRow
    | undefined;
  if (!row || !row.url) {
    return { tool: "completeTask", ok: false, message: `No task found for uid ${args.uid}`, error: "not_found" };
  }

  const current = parseIcalObject(row.raw_ical)[0];
  const { ics } = buildTaskIcal({
    uid: args.uid,
    summary: current?.summary ?? row.summary ?? args.uid,
    due: current?.end_at ? new Date(current.end_at).toISOString() : undefined,
    description: current?.description ?? undefined,
  });
  const flagged = ics.replace(
    "STATUS:NEEDS-ACTION",
    `STATUS:COMPLETED\nCOMPLETED:${toIcalUtc(new Date())}`
  );

  const cfg = getStalwartConfig()!;
  const client = await davClient(cfg);
  await client.updateCalendarObject({
    calendarObject: {
      url: row.url,
      etag: row.etag ?? undefined,
      data: flagged,
    },
  });
  await syncCalendar();
  return {
    tool: "completeTask",
    ok: true,
    message: `Marked task ${row.summary ?? args.uid} complete.`,
  };
}

function joinUrl(base: string | undefined, filename: string): string {
  if (!base) return filename;
  return base.endsWith("/") ? base + filename : base + "/" + filename;
}

function toIcalUtc(d: Date): string {
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

// ---------------------------------------------------------------------------
// Tool prompt (structured output)
// ---------------------------------------------------------------------------

export function toolSystemPrompt(now: Date = new Date()): string {
  return [
    `Current date/time: ${now.toISOString()} (use this to resolve relative phrases like "in 10 minutes", "tomorrow", "next Tuesday").`,
    "You are a calendar assistant. The user's message is a calendar request.",
    "Decide which tool to call and reply ONLY with a JSON object matching:",
    "  {\"tool\":\"<toolName>\",\"args\":{…}}",
    "No prose, no markdown fences, no explanation.",
    "",
    "Available tools (JSON schemas):",
    "  listEvents:   {\"range\":\"today|tomorrow|this_week|next_week|custom\",\"from\"?:\"ISO-8601\",\"to\"?:\"ISO-8601\"}",
    "  createEvent:  {\"summary\":string,\"start\":\"ISO-8601\",\"end\":\"ISO-8601\",\"description\"?:string,\"location\"?:string,\"attendees\"?:string[]}",
    "  moveEvent:    {\"uid\":string,\"newStart\":\"ISO-8601\",\"newEnd\":\"ISO-8601\"}",
    "  cancelEvent:  {\"uid\":string}",
    "  createTask:   {\"summary\":string,\"due\"?:\"ISO-8601\",\"description\"?:string}",
    "  completeTask: {\"uid\":string}",
    "",
    "Use the user's local timezone for ISO-8601 values. Default event duration: 60 minutes.",
    "If the request isn't a calendar action, emit {\"tool\":\"none\",\"args\":{}}.",
  ].join("\n");
}

export function detectCalendarIntent(query: string): boolean {
  const q = query.toLowerCase();
  return /\b(schedul|book|cancel|reschedul|move (the|my|our) \w+|remind me|add (a )?task|mark (it |this )?done|add to (my )?calendar|calendar)\b/.test(
    q
  ) || /\b(meeting|event) (at|on|for) \b/.test(q);
}
