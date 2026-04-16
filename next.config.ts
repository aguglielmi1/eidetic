import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow dev server requests from LAN IPs (phones, tablets, other devices)
  allowedDevOrigins: ["*.local", "192.168.*.*", "10.*.*.*", "172.16.*.*", "100.*.*.*", "*.ts.net", "aguglielmi.tail671088.ts.net"],
};

export default nextConfig;
