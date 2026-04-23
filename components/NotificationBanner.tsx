"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface UpcomingMeeting {
  uid: string;
  summary: string;
  start_at: number;
  end_at: number | null;
  location: string | null;
}

interface Summary {
  unreadEmails: number;
  upcomingMeetings: UpcomingMeeting[];
  watchedPersonMentions: number;
  ts: number;
}

function formatMinutes(startAt: number): string {
  const diff = Math.max(0, startAt - Date.now());
  const mins = Math.round(diff / 60_000);
  if (mins <= 0) return "now";
  if (mins === 1) return "1 min";
  return `${mins} min`;
}

export default function NotificationBanner() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    const fetchSummary = async () => {
      try {
        const res = await fetch("/api/notifications/summary", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Summary;
        if (!cancelled) setSummary(data);
      } catch {
        // banner is best-effort
      }
    };
    fetchSummary();
    const id = setInterval(fetchSummary, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!summary) return null;

  const meeting = summary.upcomingMeetings[0];
  const hasMeeting = meeting != null;
  const hasMentions = summary.watchedPersonMentions > 0;
  const hasUnread = summary.unreadEmails > 0;

  // Suppress the whole banner when every counter is zero,
  // or when the user dismissed within the last 5 minutes.
  if (!hasMeeting && !hasMentions && !hasUnread) return null;
  if (Date.now() - dismissedAt < 5 * 60_000) return null;

  return (
    <div className="safe-top border-b border-amber-800/40 bg-amber-950/60 text-amber-100 px-4 py-2 text-xs flex items-center gap-3 flex-wrap">
      {hasMeeting && (
        <Link
          href="/chat"
          className="flex items-center gap-1 hover:text-amber-50"
        >
          <span className="text-amber-300">⏰</span>
          <strong className="text-amber-50">{meeting.summary}</strong>
          <span className="text-amber-300">in {formatMinutes(meeting.start_at)}</span>
          {meeting.location && <span className="text-amber-400/70">@ {meeting.location}</span>}
        </Link>
      )}
      {hasMeeting && (hasMentions || hasUnread) && (
        <span className="text-amber-700">·</span>
      )}
      {hasMentions && (
        <Link href="/library" className="hover:text-amber-50">
          <span className="text-amber-300">👀</span>{" "}
          {summary.watchedPersonMentions} watched mention{summary.watchedPersonMentions === 1 ? "" : "s"}
        </Link>
      )}
      {hasMentions && hasUnread && <span className="text-amber-700">·</span>}
      {hasUnread && (
        <Link href="/library" className="hover:text-amber-50">
          <span className="text-amber-300">📧</span>{" "}
          {summary.unreadEmails} new email{summary.unreadEmails === 1 ? "" : "s"}
        </Link>
      )}
      <button
        onClick={() => setDismissedAt(Date.now())}
        className="ml-auto text-amber-400 hover:text-amber-100"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
