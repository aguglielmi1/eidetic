import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import db from "@/lib/db";

const secretKey = process.env.AUTH_SECRET;
if (!secretKey) throw new Error("AUTH_SECRET environment variable is required");
const encodedKey = new TextEncoder().encode(secretKey);

const COOKIE_NAME = "eidetic-session";
const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days

// --------------- password helpers ---------------

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const hashBuffer = Buffer.from(hash, "hex");
  const derived = scryptSync(password, salt, 64);
  return timingSafeEqual(hashBuffer, derived);
}

export function isPasswordSet(): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'password_hash'")
    .get() as { value: string } | undefined;
  return !!row;
}

export function setPassword(password: string): void {
  const hash = hashPassword(password);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('password_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(hash);
}

// --------------- JWT session ---------------

async function encrypt(payload: { userId: string; expiresAt: Date }) {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(payload.expiresAt)
    .sign(encodedKey);
}

async function decrypt(session: string) {
  try {
    const { payload } = await jwtVerify(session, encodedKey, {
      algorithms: ["HS256"],
    });
    return payload as unknown as { userId: string; expiresAt: string };
  } catch {
    return null;
  }
}

export async function createSession() {
  const expiresAt = new Date(Date.now() + SESSION_DURATION);
  const session = await encrypt({ userId: "admin", expiresAt });
  const cookieStore = await cookies();

  const isSecure =
    process.env.NODE_ENV === "production" ||
    !!process.env.TAILSCALE_FUNNEL_URL;

  cookieStore.set(COOKIE_NAME, session, {
    httpOnly: true,
    secure: isSecure,
    expires: expiresAt,
    sameSite: "lax",
    path: "/",
  });
}

export async function deleteSession() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function verifySession() {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME)?.value;
  if (!cookie) return null;

  const session = await decrypt(cookie);
  if (!session) return null;

  if (new Date(session.expiresAt) < new Date()) {
    return null;
  }

  return { userId: session.userId };
}

export async function login(password: string): Promise<{ error?: string }> {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'password_hash'")
    .get() as { value: string } | undefined;

  if (!row) {
    return { error: "No password configured — visit /login to set one" };
  }

  if (!verifyPassword(password, row.value)) {
    return { error: "Wrong password" };
  }

  await createSession();
  return {};
}

export async function logout() {
  await deleteSession();
  redirect("/login");
}
