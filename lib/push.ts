import webpush from "web-push";
import db from "@/lib/db";

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const prv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@eidetic.local";
  if (!pub || !prv) return false;
  webpush.setVapidDetails(subject, pub, prv);
  configured = true;
  return true;
}

interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Broadcast a payload to every registered device. Stale subscriptions
 * (410 / 404) are pruned from the DB automatically.
 */
export async function broadcastPush(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  if (!ensureConfigured()) return { sent: 0, pruned: 0 };
  const subs = db
    .prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions`)
    .all() as SubscriptionRow[];

  let sent = 0;
  let pruned = 0;

  const body = JSON.stringify(payload);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(sub.id);
        pruned++;
      }
      // Other errors (network, 5xx) are ignored — the next broadcast retries.
    }
  }

  return { sent, pruned };
}
