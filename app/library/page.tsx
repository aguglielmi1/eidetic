"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Document {
  id: string;
  original_name: string;
  file_type: string;
  status: "queued" | "processing" | "processed" | "failed";
  embed_status: "embedding" | "embedded" | "embed_failed" | null;
  wiki_status: "generating" | "generated" | "wiki_failed" | null;
  wiki_error: string | null;
  wiki_page_slug: string | null;
  file_size: number;
  fragment_count: number;
  chunk_count: number;
  error_message: string | null;
  embed_error: string | null;
  created_at: number;
  updated_at: number;
}

const STATUS_BADGE: Record<Document["status"], { label: string; classes: string }> = {
  queued:     { label: "Queued",     classes: "bg-zinc-700 text-zinc-300" },
  processing: { label: "Parsing…",   classes: "bg-yellow-900/60 text-yellow-300 animate-pulse" },
  processed:  { label: "Parsed",     classes: "bg-green-900/60 text-green-300" },
  failed:     { label: "Failed",     classes: "bg-red-900/60 text-red-400" },
};

const EMBED_BADGE: Record<NonNullable<Document["embed_status"]>, { label: string; classes: string }> = {
  embedding:   { label: "Embedding…", classes: "bg-blue-900/60 text-blue-300 animate-pulse" },
  embedded:    { label: "Embedded",   classes: "bg-indigo-900/60 text-indigo-300" },
  embed_failed:{ label: "Embed failed", classes: "bg-red-900/60 text-red-400" },
};

const WIKI_BADGE: Record<NonNullable<Document["wiki_status"]>, { label: string; classes: string }> = {
  generating:  { label: "Wiki…",      classes: "bg-amber-900/60 text-amber-300 animate-pulse" },
  generated:   { label: "Wiki",       classes: "bg-teal-900/60 text-teal-300" },
  wiki_failed: { label: "Wiki failed", classes: "bg-red-900/60 text-red-400" },
};

const TYPE_ICON: Record<string, string> = {
  pdf:   "📄",
  docx:  "📝",
  pptx:  "📊",
  xlsx:  "📈",
  image: "🖼️",
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(ms: number) {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function LibraryPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState<Set<string>>(new Set());
  const [embedding, setEmbedding] = useState<Set<string>>(new Set());
  const [wikifying, setWikifying] = useState<Set<string>>(new Set());
  const [dirtyCount, setDirtyCount] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);

  const load = useCallback(async () => {
    const [docsRes, dirtyRes] = await Promise.all([
      fetch("/api/documents"),
      fetch("/api/wiki/rebuild-dirty"),
    ]);
    if (docsRes.ok) setDocs(await docsRes.json());
    if (dirtyRes.ok) {
      const data = await dirtyRes.json();
      setDirtyCount(data.dirty_count);
      if (data.dirty_count === 0) setRebuilding(false);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // Poll while any doc is processing, embedding, or dirty rebuild is running
    const interval = setInterval(() => {
      if (
        rebuilding ||
        docs.some((d) =>
          d.status === "processing" || d.status === "queued" ||
          d.embed_status === "embedding" || d.wiki_status === "generating"
        )
      ) {
        load();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [load, docs, rebuilding]);

  const parse = async (doc: Document) => {
    setParsing((s) => new Set(s).add(doc.id));
    await fetch(`/api/documents/${doc.id}/parse`, { method: "POST" });
    setParsing((s) => { const n = new Set(s); n.delete(doc.id); return n; });
    // optimistically mark as processing
    setDocs((prev) =>
      prev.map((d) => (d.id === doc.id ? { ...d, status: "processing" } : d))
    );
    load();
  };

  const embed = async (doc: Document) => {
    setEmbedding((s) => new Set(s).add(doc.id));
    await fetch(`/api/documents/${doc.id}/embed`, { method: "POST" });
    setEmbedding((s) => { const n = new Set(s); n.delete(doc.id); return n; });
    setDocs((prev) =>
      prev.map((d) => (d.id === doc.id ? { ...d, embed_status: "embedding" } : d))
    );
    load();
  };

  const generateWiki = async (doc: Document) => {
    setWikifying((s) => new Set(s).add(doc.id));
    await fetch(`/api/documents/${doc.id}/wiki`, { method: "POST" });
    setWikifying((s) => { const n = new Set(s); n.delete(doc.id); return n; });
    setDocs((prev) =>
      prev.map((d) => (d.id === doc.id ? { ...d, wiki_status: "generating" } : d))
    );
    load();
  };

  const rebuildDirty = async () => {
    setRebuilding(true);
    await fetch("/api/wiki/rebuild-dirty", { method: "POST" });
    load();
  };

  const remove = async (doc: Document) => {
    if (!confirm(`Delete "${doc.original_name}"?`)) return;
    await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
    setDocs((prev) => prev.filter((d) => d.id !== doc.id));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Loading…
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-4 p-8">
        <span className="text-5xl">📁</span>
        <h1 className="text-xl font-semibold text-zinc-300">No files yet</h1>
        <p className="text-sm text-center max-w-sm">
          Upload files to get started. Supported types: PDF, DOCX, PPTX, XLSX, and receipt images.
        </p>
        <button
          onClick={() => router.push("/upload")}
          className="mt-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
        >
          Upload files
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">File library</h1>
          <p className="text-sm text-zinc-500 mt-0.5">{docs.length} file{docs.length !== 1 ? "s" : ""}</p>
        </div>
        <button
          onClick={() => router.push("/upload")}
          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
        >
          + Upload
        </button>
      </div>

      {dirtyCount > 0 && (
        <div className="flex items-center gap-3 rounded-xl bg-amber-900/20 border border-amber-800/40 px-4 py-3">
          <span className="text-amber-400 text-sm font-medium">
            {dirtyCount} wiki page{dirtyCount !== 1 ? "s" : ""} out of date
          </span>
          <button
            onClick={rebuildDirty}
            disabled={rebuilding}
            className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-amber-700/50 hover:bg-amber-700/80 text-amber-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {rebuilding ? "Rebuilding…" : "Rebuild Dirty Pages"}
          </button>
        </div>
      )}

      <ul className="flex flex-col gap-3">
        {docs.map((doc) => {
          const badge = STATUS_BADGE[doc.status] ?? STATUS_BADGE.queued;
          const embedBadge = doc.embed_status ? EMBED_BADGE[doc.embed_status] : null;
          const wikiBadge = doc.wiki_status ? WIKI_BADGE[doc.wiki_status] : null;
          const isParsing = parsing.has(doc.id) || doc.status === "processing";
          const isEmbedding = embedding.has(doc.id) || doc.embed_status === "embedding";
          const isWikifying = wikifying.has(doc.id) || doc.wiki_status === "generating";
          return (
            <li
              key={doc.id}
              className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 flex flex-col gap-2"
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl shrink-0 mt-0.5">
                  {TYPE_ICON[doc.file_type] ?? "📄"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-100 truncate">
                    {doc.original_name}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {formatBytes(doc.file_size)} · {doc.file_type.toUpperCase()} · {timeAgo(doc.created_at)}
                  </p>
                </div>
                <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.classes}`}>
                    {badge.label}
                  </span>
                  {embedBadge && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${embedBadge.classes}`}>
                      {embedBadge.label}
                    </span>
                  )}
                  {wikiBadge && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${wikiBadge.classes}`}>
                      {wikiBadge.label}
                    </span>
                  )}
                </div>
              </div>

              {doc.status === "processed" && (
                <p className="text-xs text-zinc-500 pl-9">
                  {doc.fragment_count} fragment{doc.fragment_count !== 1 ? "s" : ""}
                  {doc.embed_status === "embedded"
                    ? ` · ${doc.chunk_count} chunk${doc.chunk_count !== 1 ? "s" : ""} indexed`
                    : ""}
                </p>
              )}

              {doc.status === "failed" && doc.error_message && (
                <p className="text-xs text-red-400 pl-9 truncate" title={doc.error_message}>
                  {doc.error_message}
                </p>
              )}

              {doc.embed_status === "embed_failed" && doc.embed_error && (
                <p className="text-xs text-red-400 pl-9 truncate" title={doc.embed_error}>
                  Embed error: {doc.embed_error}
                </p>
              )}

              {doc.wiki_status === "wiki_failed" && doc.wiki_error && (
                <p className="text-xs text-red-400 pl-9 truncate" title={doc.wiki_error}>
                  Wiki error: {doc.wiki_error}
                </p>
              )}

              <div className="flex flex-wrap gap-2 pl-9">
                {(doc.status === "queued" || doc.status === "failed") && (
                  <button
                    onClick={() => parse(doc)}
                    disabled={isParsing}
                    className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {isParsing ? "Parsing…" : doc.status === "failed" ? "Retry parse" : "Parse"}
                  </button>
                )}
                {doc.status === "processed" && (
                  <button
                    onClick={() => parse(doc)}
                    disabled={isParsing}
                    className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {isParsing ? "Parsing…" : "Re-parse"}
                  </button>
                )}
                {doc.status === "processed" && (
                  <button
                    onClick={() => embed(doc)}
                    disabled={isEmbedding}
                    className="text-xs px-3 py-1.5 rounded-lg bg-indigo-900/50 hover:bg-indigo-900/80 text-indigo-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {isEmbedding
                      ? "Embedding…"
                      : doc.embed_status === "embedded"
                      ? "Re-embed"
                      : doc.embed_status === "embed_failed"
                      ? "Retry embed"
                      : "Embed"}
                  </button>
                )}
                {doc.status === "processed" && (
                  <button
                    onClick={() => generateWiki(doc)}
                    disabled={isWikifying}
                    className="text-xs px-3 py-1.5 rounded-lg bg-teal-900/40 hover:bg-teal-900/70 text-teal-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {isWikifying
                      ? "Generating…"
                      : doc.wiki_status === "generated"
                      ? "Regenerate Wiki"
                      : doc.wiki_status === "wiki_failed"
                      ? "Retry Wiki"
                      : "Generate Wiki"}
                  </button>
                )}
                <button
                  onClick={() => remove(doc)}
                  className="text-xs px-3 py-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                >
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
