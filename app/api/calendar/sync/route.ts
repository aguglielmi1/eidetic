import { getStalwartConfig, syncCalendar } from "@/lib/calendar";

export async function POST() {
  if (!getStalwartConfig()) {
    return Response.json(
      { error: "Stalwart not configured" },
      { status: 503 }
    );
  }

  try {
    const result = await syncCalendar();
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
