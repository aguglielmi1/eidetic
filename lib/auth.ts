import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const secretKey = process.env.AUTH_SECRET;
if (!secretKey) throw new Error("AUTH_SECRET environment variable is required");
const encodedKey = new TextEncoder().encode(secretKey);

const COOKIE_NAME = "eidetic-session";
const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days

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
  const expected = process.env.EIDETIC_PASSWORD;
  if (!expected) {
    return { error: "EIDETIC_PASSWORD not configured" };
  }

  if (password !== expected) {
    return { error: "Wrong password" };
  }

  await createSession();
  return {};
}

export async function logout() {
  await deleteSession();
  redirect("/login");
}
