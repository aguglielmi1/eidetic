import { randomUUID } from "crypto";
import db from "@/lib/db";

interface SubscribeBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
  userAgent?: string;
}

/**
 * POST /api/push — register a browser Web Push subscription for this device.
 * Body shape matches what PushSubscription.toJSON() produces client-side.
 */
export async function POST(request: Request) {
  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return Response.json(
      { error: "endpoint, keys.p256dh and keys.auth are required" },
      { status: 400 }
    );
  }

  // Upsert by endpoint — same browser re-subscribing should refresh keys
  const existing = db
    .prepare(`SELECT id FROM push_subscriptions WHERE endpoint = ?`)
    .get(endpoint) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE push_subscriptions
          SET p256dh = ?, auth = ?, user_agent = ?
        WHERE id = ?`
    ).run(p256dh, auth, body.userAgent ?? null, existing.id);
    return Response.json({ ok: true, id: existing.id, updated: true });
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, endpoint, p256dh, auth, body.userAgent ?? null, Date.now());

  return Response.json({ ok: true, id, updated: false });
}

/**
 * DELETE /api/push?endpoint=… — unsubscribe this device.
 */
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const endpoint = url.searchParams.get("endpoint");
  if (!endpoint) {
    return Response.json({ error: "endpoint query param required" }, { status: 400 });
  }
  const info = db
    .prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`)
    .run(endpoint);
  return Response.json({ ok: true, removed: info.changes });
}

/**
 * GET /api/push — returns the VAPID public key the browser needs to
 * subscribe, plus whether any subscriptions exist. The private key never
 * leaves the server.
 */
export async function GET() {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? null;
  const configured = Boolean(publicKey && process.env.VAPID_PRIVATE_KEY);
  const count = (db.prepare(`SELECT COUNT(*) AS cnt FROM push_subscriptions`).get() as {
    cnt: number;
  }).cnt;
  return Response.json({ publicKey, configured, count });
}
