"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";

interface Conversation {
  id: string;
  title: string;
  mode: string;
  updated_at: number;
}

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

const NAV = [
  { href: "/chat", label: "Chat", icon: "💬" },
  { href: "/upload", label: "Upload", icon: "⬆️" },
  { href: "/library", label: "Library", icon: "📁" },
  { href: "/wiki", label: "Wiki", icon: "📖" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
];

export default function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);

  const loadConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    if (res.ok) setConversations(await res.json());
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations, pathname]);

  const newChat = async () => {
    const res = await fetch("/api/conversations", { method: "POST" });
    if (res.ok) {
      const conv = await res.json();
      router.push(`/chat/${conv.id}`);
      onClose();
    }
  };

  const deleteConversation = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (pathname === `/chat/${id}`) router.push("/chat");
  };

  return (
    <>
      {/* Backdrop (mobile) */}
      {open && (
        <div
          className="fixed inset-0 z-20 bg-black/40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`
          fixed top-0 left-0 z-30 h-full w-64 flex flex-col bg-zinc-900 text-zinc-100
          transform transition-transform duration-200
          ${open ? "translate-x-0" : "-translate-x-full"}
          lg:translate-x-0 lg:static lg:z-auto
        `}
      >
        {/* Logo */}
        <div className="safe-top flex items-center gap-2 px-4 py-4 border-b border-zinc-700">
          <span className="text-lg font-semibold tracking-tight">eidetic</span>
        </div>

        {/* New Chat */}
        <div className="px-3 pt-3">
          <button
            onClick={newChat}
            className="w-full flex items-center gap-2 rounded-md bg-zinc-700 hover:bg-zinc-600 px-3 py-2 text-sm font-medium transition-colors"
          >
            <span>+</span> New chat
          </button>
        </div>

        {/* Primary nav */}
        <nav className="px-3 pt-4 space-y-1">
          {NAV.map(({ href, label, icon }) => {
            const active = pathname === href || (href !== "/chat" && pathname.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
                }`}
              >
                <span>{icon}</span>
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto px-3 pt-4 pb-4">
          {conversations.length > 0 && (
            <>
              <p className="px-3 mb-1 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Recent
              </p>
              <ul className="space-y-0.5">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/chat/${c.id}`}
                      onClick={onClose}
                      className={`group flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors ${
                        pathname === `/chat/${c.id}`
                          ? "bg-zinc-700 text-white"
                          : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      }`}
                    >
                      <span className="truncate">{c.title}</span>
                      <button
                        onClick={(e) => deleteConversation(e, c.id)}
                        className="ml-1 hidden group-hover:block text-zinc-500 hover:text-red-400"
                        title="Delete"
                      >
                        ×
                      </button>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
