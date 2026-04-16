"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  sources_json: string | null;
  created_at: number;
}

interface SourceChunk {
  chunk_id: string;
  score: number;
  original_name: string | null;
  file_type: string | null;
  fragment_type: string;
  page_number: number | null;
  slide_number: number | null;
  slide_title: string | null;
  sheet_name: string | null;
  row_number: number | null;
  vendor: string | null;
  receipt_date: string | null;
  total: string | null;
}

interface WikiPageRef {
  slug: string;
  title: string;
  page_type: string;
}

interface SourcesData {
  mode: "rag" | "wiki" | "hybrid" | "chat";
  category: string;
  chunks: SourceChunk[];
  wikiPages: WikiPageRef[];
}

interface ChatViewProps {
  conversationId: string;
  initialMessages: Message[];
  initialTitle: string;
}

function parseSources(sourcesJson: string | null | undefined): SourcesData | null {
  if (!sourcesJson) return null;
  try {
    return JSON.parse(sourcesJson) as SourcesData;
  } catch {
    return null;
  }
}

function modeLabel(mode: string): string {
  switch (mode) {
    case "rag":    return "RAG";
    case "wiki":   return "Wiki";
    case "hybrid": return "Hybrid";
    default:       return "";
  }
}

function modeBadgeClass(mode: string): string {
  switch (mode) {
    case "rag":    return "bg-blue-900 text-blue-300 border border-blue-700";
    case "wiki":   return "bg-purple-900 text-purple-300 border border-purple-700";
    case "hybrid": return "bg-teal-900 text-teal-300 border border-teal-700";
    default:       return "";
  }
}

function chunkLabel(chunk: SourceChunk): string {
  const parts: string[] = [];
  if (chunk.original_name) parts.push(chunk.original_name);
  if (chunk.page_number   != null) parts.push(`p.${chunk.page_number}`);
  if (chunk.slide_number  != null) parts.push(`slide ${chunk.slide_number}`);
  if (chunk.sheet_name)           parts.push(`sheet: ${chunk.sheet_name}`);
  if (chunk.row_number    != null) parts.push(`row ${chunk.row_number}`);
  if (chunk.vendor)               parts.push(`vendor: ${chunk.vendor}`);
  return parts.join(" · ") || chunk.fragment_type;
}

function SourcesPanel({ sources }: { sources: SourcesData }) {
  if (sources.mode === "chat") return null;
  const hasChunks = sources.chunks.length > 0;
  const hasWiki = sources.wikiPages.length > 0;
  if (!hasChunks && !hasWiki) return null;

  return (
    <div className="mt-2 pt-2 border-t border-zinc-700 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${modeBadgeClass(sources.mode)}`}>
          {modeLabel(sources.mode)}
        </span>
        <span className="text-[10px] text-zinc-500">Sources used</span>
      </div>

      {hasChunks && (
        <ul className="space-y-0.5">
          {sources.chunks.map((c) => (
            <li key={c.chunk_id} className="text-[10px] text-zinc-400 truncate">
              📄 {chunkLabel(c)}
              {c.score != null && (
                <span className="ml-1 text-zinc-600">({Math.round(c.score * 100)}%)</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasWiki && (
        <ul className="space-y-0.5">
          {sources.wikiPages.map((p) => (
            <li key={p.slug} className="text-[10px] text-zinc-400 truncate">
              📖 {p.title}
              <span className="ml-1 text-zinc-600">({p.page_type})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ChatView({
  conversationId,
  initialMessages,
  initialTitle,
}: ChatViewProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const content = input.trim();
    if (!content || streaming) return;
    setInput("");

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      sources_json: null,
      created_at: Date.now(),
    };
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      sources_json: null,
      created_at: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: `Error: ${err.error}` }
              : m
          )
        );
        return;
      }

      // Capture headers before consuming the body
      const serverMsgId = res.headers.get("X-Message-Id");

      if (title === "New conversation") {
        const newTitle = content.slice(0, 60);
        setTitle(newTitle);
        router.refresh();
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, content: accumulated } : m
          )
        );
      }

      // After stream ends, fetch sources from DB
      if (serverMsgId) {
        try {
          const convRes = await fetch(`/api/conversations/${conversationId}`);
          if (convRes.ok) {
            const convData = await convRes.json() as { messages: Message[] };
            const saved = convData.messages.find((m) => m.id === serverMsgId);
            if (saved?.sources_json) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, id: serverMsgId, sources_json: saved.sources_json }
                    : m
                )
              );
            }
          }
        } catch {
          // Non-critical — sources display is best-effort
        }
      }
    } finally {
      setStreaming(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-2">
            <span className="text-4xl">💬</span>
            <p className="text-sm">Ask anything about your documents</p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap break-words ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-100"
              }`}
            >
              {msg.content || (
                <span className="inline-block w-2 h-4 bg-zinc-400 animate-pulse rounded" />
              )}
              {msg.role === "assistant" && (() => {
                const sources = parseSources(msg.sources_json);
                return sources ? <SourcesPanel sources={sources} /> : null;
              })()}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="safe-bottom border-t border-zinc-800 px-4 py-3">
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message eidetic… (Enter to send, Shift+Enter for newline)"
            rows={1}
            className="flex-1 resize-none rounded-xl bg-zinc-800 border border-zinc-700 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
            style={{ maxHeight: "200px", overflowY: "auto" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
            }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || streaming}
            className="shrink-0 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-3 text-sm font-medium text-white transition-colors"
          >
            {streaming ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
