"use client";

import { useEffect, useState } from "react";
import PushToggle from "@/components/PushToggle";

interface NetworkInfo {
  addresses: { name: string; address: string; family: string }[];
  port: string;
  urls: string[];
}

export default function SettingsPage() {
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [funnelUrl, setFunnelUrl] = useState<string>("");

  useEffect(() => {
    fetch("/api/network-info")
      .then((r) => r.json())
      .then((data) => {
        setNetwork(data);
        if (data.funnelUrl) setFunnelUrl(data.funnelUrl);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-8 max-w-2xl mx-auto w-full">
      <h1 className="text-xl font-semibold text-zinc-100 mb-6">Settings</h1>

      <section className="space-y-4">
        {/* LLM Runtime */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-sm font-medium text-zinc-300 mb-3">LLM Runtime</h2>
          <div className="space-y-2 text-sm text-zinc-400">
            <div className="flex justify-between">
              <span>Ollama URL</span>
              <code className="text-zinc-300">http://localhost:11434</code>
            </div>
            <div className="flex justify-between">
              <span>Model</span>
              <code className="text-zinc-300">gemma3</code>
            </div>
          </div>
          <p className="mt-3 text-xs text-zinc-600">
            Override with OLLAMA_URL and OLLAMA_MODEL environment variables.
          </p>
        </div>

        {/* Storage */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-sm font-medium text-zinc-300 mb-3">Storage</h2>
          <div className="space-y-2 text-sm text-zinc-400">
            <div className="flex justify-between">
              <span>Raw files</span>
              <code className="text-zinc-300">storage/raw</code>
            </div>
            <div className="flex justify-between">
              <span>Database</span>
              <code className="text-zinc-300">storage/eidetic.db</code>
            </div>
            <div className="flex justify-between">
              <span>Wiki pages</span>
              <code className="text-zinc-300">storage/wiki</code>
            </div>
          </div>
        </div>

        {/* Network Access */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-sm font-medium text-zinc-300 mb-3">Network Access</h2>

          {!network ? (
            <p className="text-sm text-zinc-500">Loading network info...</p>
          ) : network.urls.length === 0 ? (
            <p className="text-sm text-zinc-500">No LAN addresses detected.</p>
          ) : (
            <>
              <p className="text-xs text-zinc-500 mb-3">
                Access eidetic from other devices on your local network:
              </p>
              <div className="space-y-2">
                {network.urls.map((url) => (
                  <div
                    key={url}
                    className="flex items-center justify-between rounded-lg bg-zinc-800 px-3 py-2"
                  >
                    <code className="text-sm text-blue-400">{url}</code>
                    <button
                      onClick={() => navigator.clipboard.writeText(url)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors ml-2 shrink-0"
                    >
                      Copy
                    </button>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-zinc-600">
                Open any URL above in your phone browser. On iOS, tap Share then
                &quot;Add to Home Screen&quot; for an app-like experience.
              </p>
            </>
          )}

          {network && network.addresses.filter((a) => a.family === "IPv4").length > 0 && (
            <div className="mt-3 pt-3 border-t border-zinc-800">
              <p className="text-xs text-zinc-500 mb-2">All network interfaces:</p>
              <div className="space-y-1">
                {network.addresses.map((a, i) => (
                  <div key={i} className="flex justify-between text-xs text-zinc-500">
                    <span>{a.name}</span>
                    <code className="text-zinc-400">
                      {a.address} ({a.family})
                    </code>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Secure Remote Access */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-sm font-medium text-zinc-300 mb-3">Secure Remote Access</h2>

          {funnelUrl ? (
            <>
              <div className="space-y-2 text-sm text-zinc-400 mb-3">
                <div className="flex items-center justify-between">
                  <span>Funnel URL</span>
                  <div className="flex items-center gap-2">
                    <code className="text-blue-400">{funnelUrl}</code>
                    <button
                      onClick={() => navigator.clipboard.writeText(funnelUrl)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      Copy
                    </button>
                  </div>
                </div>
                <div className="flex justify-between">
                  <span>Auth</span>
                  <span className="text-green-400">Protected by password</span>
                </div>
              </div>
              <p className="text-xs text-zinc-600">
                Access eidetic from anywhere via the Funnel URL above. No VPN client needed
                — just open the URL on your phone and sign in.
              </p>
              <p className="mt-2 text-xs text-zinc-600">
                Change your password from the Authentication section below.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-zinc-400 mb-3">
                Use{" "}
                <a
                  href="https://tailscale.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline"
                >
                  Tailscale Funnel
                </a>{" "}
                to access eidetic from anywhere over HTTPS:
              </p>
              <ol className="space-y-2 text-sm text-zinc-400 list-decimal list-inside">
                <li>Install Tailscale on this machine</li>
                <li>Enable HTTPS in admin console (DNS settings)</li>
                <li>
                  Run:{" "}
                  <code className="text-zinc-300">tailscale funnel --bg 3000</code>
                </li>
                <li>
                  Set <code className="text-zinc-300">TAILSCALE_FUNNEL_URL</code> in
                  .env.local to your Funnel URL
                </li>
              </ol>
              <p className="mt-3 text-xs text-zinc-600">
                Funnel creates a public HTTPS endpoint — no VPN app needed on the phone.
                Auth protects the app with a password.
              </p>
            </>
          )}
        </div>

        {/* Notifications */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-sm font-medium text-zinc-300 mb-3">Notifications</h2>
          <PushToggle />
          <p className="mt-3 text-xs text-zinc-600">
            The in-app banner always polls for upcoming meetings and new emails.
            Web Push adds OS-level alerts for watched correspondents and imminent
            meetings, even when eidetic isn&apos;t open.
          </p>
        </div>

        {/* Authentication */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-sm font-medium text-zinc-300 mb-3">Authentication</h2>
          <div className="space-y-2 text-sm text-zinc-400">
            <div className="flex justify-between">
              <span>Status</span>
              <span className="text-green-400">Active</span>
            </div>
            <div className="flex justify-between">
              <span>Method</span>
              <code className="text-zinc-300">Password (single user)</code>
            </div>
            <div className="flex justify-between">
              <span>Session duration</span>
              <code className="text-zinc-300">30 days</code>
            </div>
          </div>
          <p className="mt-3 text-xs text-zinc-600">
            All pages and API routes are protected. Password is stored securely
            in the database.
          </p>
        </div>
      </section>
    </div>
  );
}
