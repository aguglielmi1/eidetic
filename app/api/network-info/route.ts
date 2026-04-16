import { networkInterfaces } from "os";

export async function GET() {
  const nets = networkInterfaces();
  const addresses: { name: string; address: string; family: string }[] = [];

  for (const [name, interfaces] of Object.entries(nets)) {
    if (!interfaces) continue;
    for (const iface of interfaces) {
      // Skip internal (loopback) and link-local addresses
      if (iface.internal) continue;
      if (iface.family === "IPv6" && iface.address.startsWith("fe80")) continue;
      addresses.push({
        name: name,
        address: iface.address,
        family: iface.family === "IPv4" ? "IPv4" : "IPv6",
      });
    }
  }

  const port = process.env.PORT ?? "3000";

  return Response.json({
    addresses,
    port,
    urls: addresses
      .filter((a) => a.family === "IPv4")
      .map((a) => `http://${a.address}:${port}`),
  });
}
