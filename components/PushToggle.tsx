"use client";

import { useEffect, useState } from "react";

interface PushInfo {
  publicKey: string | null;
  configured: boolean;
  count: number;
}

type PushState =
  | "unsupported"
  | "unconfigured"
  | "loading"
  | "denied"
  | "subscribed"
  | "unsubscribed"
  | "error";

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

export default function PushToggle() {
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [state, setState] = useState<PushState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const boot = async () => {
      if (typeof window === "undefined") return;
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setState("unsupported");
        return;
      }
      try {
        const res = await fetch("/api/push");
        const data = (await res.json()) as PushInfo;
        setInfo(data);
        if (!data.configured) {
          setState("unconfigured");
          return;
        }
        const permission = Notification.permission;
        if (permission === "denied") {
          setState("denied");
          return;
        }
        const reg = await navigator.serviceWorker.getRegistration("/sw.js");
        const existing = reg ? await reg.pushManager.getSubscription() : null;
        setState(existing ? "subscribed" : "unsubscribed");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    };
    boot();
  }, []);

  const subscribe = async () => {
    if (!info?.publicKey) return;
    setState("loading");
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(info.publicKey),
      });
      const payload = {
        ...subscription.toJSON(),
        userAgent: navigator.userAgent,
      };
      const res = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setState("subscribed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  };

  const unsubscribe = async () => {
    setState("loading");
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const existing = reg ? await reg.pushManager.getSubscription() : null;
      if (existing) {
        const endpoint = existing.endpoint;
        await existing.unsubscribe();
        await fetch(`/api/push?endpoint=${encodeURIComponent(endpoint)}`, {
          method: "DELETE",
        });
      }
      setState("unsubscribed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  };

  if (state === "unsupported") {
    return (
      <p className="text-sm text-zinc-500">
        Push notifications aren&apos;t supported in this browser.
      </p>
    );
  }
  if (state === "unconfigured") {
    return (
      <p className="text-sm text-zinc-500">
        Set <code className="text-zinc-300">VAPID_PUBLIC_KEY</code> and{" "}
        <code className="text-zinc-300">VAPID_PRIVATE_KEY</code> in your environment
        to enable Web Push.
      </p>
    );
  }
  if (state === "denied") {
    return (
      <p className="text-sm text-zinc-500">
        Notification permission is blocked. Re-enable it in your browser settings
        to subscribe.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-400">Status</span>
        <span
          className={
            state === "subscribed"
              ? "text-emerald-400"
              : state === "error"
              ? "text-red-400"
              : "text-zinc-300"
          }
        >
          {state === "subscribed" ? "Subscribed" : state === "error" ? "Error" : "Off"}
        </span>
      </div>
      {state === "error" && error && (
        <p className="text-xs text-red-400 break-all">{error}</p>
      )}
      {state === "subscribed" ? (
        <button
          onClick={unsubscribe}
          className="rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-100"
        >
          Unsubscribe this device
        </button>
      ) : (
        <button
          onClick={subscribe}
          disabled={state === "loading"}
          className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-white"
        >
          {state === "loading" ? "…" : "Enable notifications"}
        </button>
      )}
      {info && (
        <p className="text-xs text-zinc-600">
          {info.count} device{info.count === 1 ? "" : "s"} subscribed across all users.
        </p>
      )}
    </div>
  );
}
