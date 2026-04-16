import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "eidetic-session";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow login page, auth API routes, static assets, PWA files
  if (
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/manifest.json" ||
    pathname === "/icon.svg" ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // Check for valid session cookie
  const sessionCookie = request.cookies.get(COOKIE_NAME)?.value;

  if (!sessionCookie) {
    return redirectToLogin(request, pathname);
  }

  const secretKey = process.env.AUTH_SECRET;
  if (!secretKey) {
    return redirectToLogin(request, pathname);
  }

  try {
    const encodedKey = new TextEncoder().encode(secretKey);
    await jwtVerify(sessionCookie, encodedKey, { algorithms: ["HS256"] });
    return NextResponse.next();
  } catch {
    return redirectToLogin(request, pathname);
  }
}

function redirectToLogin(request: NextRequest, pathname: string) {
  // For API routes, return 401 instead of redirect
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|manifest\\.json|icon\\.svg|favicon\\.ico).*)",
  ],
};
