// Returns the iPhone CalDAV setup info for the settings page panel.
// This route is protected by the global proxy.ts auth check, so the
// password is only ever served to a logged-in session.

export async function GET() {
  const username = process.env.STALWART_USERNAME ?? null;
  const password = process.env.STALWART_PASSWORD ?? null;
  const funnelUrl = process.env.TAILSCALE_FUNNEL_URL ?? null;

  let funnelHostname: string | null = null;
  if (funnelUrl) {
    try {
      funnelHostname = new URL(funnelUrl).hostname;
    } catch {
      funnelHostname = null;
    }
  }

  return Response.json({
    configured: Boolean(username && password),
    funnelHostname,
    username,
    password,
    // Apple's "Add CalDAV Account" form takes a hostname (no scheme, no path).
    // The /dav path is appended by Stalwart's well-known redirect, so iOS
    // discovers it automatically once the account is added.
    davPath: "/dav",
  });
}
