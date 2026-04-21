import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin file-tracing root to this project so Next.js doesn't pick up a stray
  // package-lock.json higher up the directory tree (e.g. in the user's home).
  outputFileTracingRoot: path.resolve(__dirname),

  // Allow dev server requests from LAN IPs (phones, tablets, other devices)
  allowedDevOrigins: ["*.local", "192.168.*.*", "10.*.*.*", "172.16.*.*", "100.*.*.*", "*.ts.net", "aguglielmi.tail671088.ts.net"],
};

export default nextConfig;
