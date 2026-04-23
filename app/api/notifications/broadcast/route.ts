import { broadcastPush } from "@/lib/push";

interface BroadcastBody {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
}

/**
 * POST /api/notifications/broadcast
 *
 * Sends a Web Push to every registered device. Invoked by the email sync
 * job (after an email from a watched sender lands) and by the 10-minute
 * meeting reminder cron. Body fields mirror ServiceWorkerRegistration
 * showNotification() options so the worker can forward them directly.
 */
export async function POST(request: Request) {
  let body: BroadcastBody;
  try {
    body = (await request.json()) as BroadcastBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const title = body.title?.trim();
  if (!title) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }

  const { sent, pruned } = await broadcastPush({
    title,
    body: body.body,
    url: body.url,
    tag: body.tag,
  });

  return Response.json({ ok: true, sent, pruned });
}
