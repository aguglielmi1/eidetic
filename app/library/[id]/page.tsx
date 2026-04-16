"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";

interface Fragment {
  id: string;
  document_id: string;
  text: string;
  fragment_type: string;
  page_number: number | null;
  slide_number: number | null;
  slide_title: string | null;
  sheet_name: string | null;
  row_number: number | null;
  vendor: string | null;
  receipt_date: string | null;
  total: string | null;
  metadata_json: string | null;
  created_at: number;
}

interface Chunk {
  id: string;
  fragment_id: string;
  text: string;
  chroma_id: string;
  created_at: number;
}

interface WikiPageRef {
  id: string;
  slug: string;
  page_type: string;
  title: string;
  dirty: number;
  updated_at: number;
}

interface DocumentDetail {
  id: string;
  original_name: string;
  file_type: string;
  status: "queued" | "processing" | "processed" | "failed";
  file_path: string;
  file_size: number;
  fragment_count: number;
  chunk_count: number;
  error_message: string | null;
  embed_status: "embedding" | "embedded" | "embed_failed" | null;
  embed_error: string | null;
  wiki_status: "generating" | "generated" | "wiki_failed" | null;
  wiki_error: string | null;
  wiki_page_slug: string | null;
  content_hash: string | null;
  ignored: number;
  created_at: number;
  updated_at: number;
  fragments: Fragment[];
  chunks: Chunk[];
  wikiPages: WikiPageRef[];
}

const STATUS_BADGE: Record<string, { label: string; classes: string }> = {
  queued:     { label: "Queued",     classes: "bg-zinc-700 text-zinc-300" },
  processing: { label: "Parsing...",  classes: "bg-yellow-900/60 text-yellow-300 animate-pulse" },
  processed:  { label: "Parsed",     classes: "bg-green-900/60 text-green-300" },
  failed:     { label: "Failed",     classes: "bg-red-900/60 text-red-400" },
};

const EMBED_BADGE: Record<string, { label: string; classes: string }> = {
  embedding:    { label: "Embedding...", classes: "bg-blue-900/60 text-blue-300 animate-pulse" },
  embedded:     { label: "Embedded",     classes: "bg-indigo-900/60 text-indigo-300" },
  embed_failed: { label: "Embed failed", classes: "bg-red-900/60 text-red-400" },
};

const WIKI_BADGE: Record<string, { label: string; classes: string }> = {
  generating:  { label: "Generating...", classes: "bg-amber-900/60 text-amber-300 animate-pulse" },
  generated:   { label: "Wiki generated", classes: "bg-teal-900/60 text-teal-300" },
  wiki_failed: { label: "Wiki failed",   classes: "bg-red-900/60 text-red-400" },
};

const TYPE_ICON: Record<string, string> = {
  pdf: "PDF", docx: "DOCX", pptx: "PPTX", xlsx: "XLSX", image: "IMG",
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fragmentLabel(f: Fragment): string {
  const parts: string[] = [f.fragment_type];
  if (f.page_number != null) parts.push(`p.${f.page_number}`);
  if (f.slide_number != null) parts.push(`slide ${f.slide_number}`);
  if (f.slide_title) parts.push(f.slide_title);
  if (f.sheet_name) parts.push(`sheet: ${f.sheet_name}`);
  if (f.row_number != null) parts.push(`row ${f.row_number}`);
  if (f.vendor) parts.push(`vendor: ${f.vendor}`);
  if (f.receipt_date) parts.push(f.receipt_date);
  if (f.total) parts.push(`$${f.total}`);
  return parts.join(" · ");
}

export default function DocumentDetailPage() {
  const router = useRouter();
  const params = useParams();
  const docId = params.id as string;

  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [expandedFragments, setExpandedFragments] = useState<Set<string>>(new Set());
  const [expandedChunks, setExpandedChunks] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/documents/${docId}`);
    if (res.status === 404) { setNotFound(true); setLoading(false); return; }
    if (res.ok) {
      setDoc(await res.json());
      setLoading(false);
    }
  }, [docId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while processing
  useEffect(() => {
    if (!doc) return;
    const needsPoll =
      doc.status === "processing" || doc.status === "queued" ||
      doc.embed_status === "embedding" || doc.wiki_status === "generating";
    if (!needsPoll) return;
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [doc, load]);

  const action = async (label: string, url: string, method = "POST") => {
    setBusy(label);
    await fetch(url, { method });
    await load();
    setBusy(null);
  };

  const toggleIgnored = async () => {
    if (!doc) return;
    setBusy("ignore");
    await fetch(`/api/documents/${docId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignored: doc.ignored ? 0 : 1 }),
    });
    await load();
    setBusy(null);
  };

  const deleteDoc = async () => {
    if (!doc || !confirm(`Delete "${doc.original_name}"? This cannot be undone.`)) return;
    await fetch(`/api/documents/${docId}`, { method: "DELETE" });
    router.push("/library");
  };

  const toggleFragment = (id: string) => {
    setExpandedFragments((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-zinc-500 text-sm">Loading...</div>;
  }

  if (notFound || !doc) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-4 p-8">
        <span className="text-5xl">?</span>
        <p className="text-sm">Document not found.</p>
        <button onClick={() => router.push("/library")} className="text-xs text-blue-400 hover:text-blue-300">
          Back to Library
        </button>
      </div>
    );
  }

  const badge = STATUS_BADGE[doc.status] ?? STATUS_BADGE.queued;
  const embedBadge = doc.embed_status ? EMBED_BADGE[doc.embed_status] : null;
  const wikiBadge = doc.wiki_status ? WIKI_BADGE[doc.wiki_status] : null;
  const isParsed = doc.status === "processed";

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 flex flex-col gap-6">
      {/* Back link */}
      <button onClick={() => router.push("/library")} className="text-zinc-500 hover:text-zinc-300 text-sm self-start">
        &larr; Library
      </button>

      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-400 shrink-0">
          {TYPE_ICON[doc.file_type] ?? "FILE"}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-zinc-100 break-words">{doc.original_name}</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.classes}`}>{badge.label}</span>
            {embedBadge && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${embedBadge.classes}`}>{embedBadge.label}</span>
            )}
            {wikiBadge && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${wikiBadge.classes}`}>{wikiBadge.label}</span>
            )}
            {doc.ignored === 1 && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-zinc-700 text-zinc-400">Ignored</span>
            )}
          </div>
        </div>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <MetaCard label="File size" value={formatBytes(doc.file_size)} />
        <MetaCard label="Type" value={doc.file_type.toUpperCase()} />
        <MetaCard label="Uploaded" value={formatDate(doc.created_at)} />
        <MetaCard label="Fragments" value={String(doc.fragment_count)} />
        <MetaCard label="Chunks indexed" value={String(doc.chunk_count)} />
        <MetaCard label="Updated" value={formatDate(doc.updated_at)} />
        {doc.content_hash && (
          <MetaCard label="Content hash" value={doc.content_hash.slice(0, 16) + "..."} title={doc.content_hash} />
        )}
      </div>

      {/* Errors */}
      {doc.error_message && (
        <div className="rounded-xl bg-red-900/20 border border-red-800/40 px-4 py-3">
          <p className="text-xs font-medium text-red-400 mb-1">Parse error</p>
          <p className="text-xs text-red-300 whitespace-pre-wrap">{doc.error_message}</p>
        </div>
      )}
      {doc.embed_error && (
        <div className="rounded-xl bg-red-900/20 border border-red-800/40 px-4 py-3">
          <p className="text-xs font-medium text-red-400 mb-1">Embed error</p>
          <p className="text-xs text-red-300 whitespace-pre-wrap">{doc.embed_error}</p>
        </div>
      )}
      {doc.wiki_error && (
        <div className="rounded-xl bg-red-900/20 border border-red-800/40 px-4 py-3">
          <p className="text-xs font-medium text-red-400 mb-1">Wiki error</p>
          <p className="text-xs text-red-300 whitespace-pre-wrap">{doc.wiki_error}</p>
        </div>
      )}

      {/* Manual controls */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
        <h2 className="text-sm font-semibold text-zinc-300 mb-3">Actions</h2>
        <div className="flex flex-wrap gap-2">
          <ActionBtn
            label={doc.status === "failed" ? "Retry parse" : isParsed ? "Re-parse" : "Parse"}
            busy={busy === "parse"}
            disabled={doc.status === "processing"}
            onClick={() => action("parse", `/api/documents/${docId}/parse`)}
            classes="bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
          />
          {isParsed && (
            <ActionBtn
              label={doc.embed_status === "embedded" ? "Re-embed" : doc.embed_status === "embed_failed" ? "Retry embed" : "Embed"}
              busy={busy === "embed"}
              disabled={doc.embed_status === "embedding"}
              onClick={() => action("embed", `/api/documents/${docId}/embed`)}
              classes="bg-indigo-900/50 hover:bg-indigo-900/80 text-indigo-300"
            />
          )}
          {isParsed && (
            <ActionBtn
              label={doc.wiki_status === "generated" ? "Regenerate wiki" : doc.wiki_status === "wiki_failed" ? "Retry wiki" : "Generate wiki"}
              busy={busy === "wiki"}
              disabled={doc.wiki_status === "generating"}
              onClick={() => action("wiki", `/api/documents/${docId}/wiki`)}
              classes="bg-teal-900/40 hover:bg-teal-900/70 text-teal-300"
            />
          )}
          <ActionBtn
            label={doc.ignored ? "Unignore" : "Mark ignored"}
            busy={busy === "ignore"}
            onClick={toggleIgnored}
            classes={doc.ignored ? "bg-amber-900/40 hover:bg-amber-900/70 text-amber-300" : "bg-zinc-800 hover:bg-zinc-700 text-zinc-400"}
          />
          <button
            onClick={deleteDoc}
            className="text-xs px-3 py-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-900/20 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Linked wiki pages */}
      {doc.wikiPages.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">Linked wiki pages</h2>
          <ul className="flex flex-col gap-2">
            {doc.wikiPages.map((wp) => (
              <li key={wp.id}>
                <button
                  onClick={() => router.push(`/wiki/${encodeURIComponent(wp.slug)}`)}
                  className="w-full text-left rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 hover:border-zinc-600 transition-colors flex items-center gap-3"
                >
                  <span className="text-sm">
                    {wp.page_type === "vendor" ? "store" : wp.page_type === "presentation" ? "slides" : wp.page_type === "data" ? "table" : "article"}
                  </span>
                  <span className="flex-1 text-sm text-zinc-200 truncate">{wp.title}</span>
                  {wp.dirty === 1 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/50 text-amber-300 shrink-0">Outdated</span>
                  )}
                  <span className="text-zinc-600 text-sm">&rsaquo;</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Parsed fragments */}
      {doc.fragments.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">
            Parsed fragments ({doc.fragments.length})
          </h2>
          <ul className="flex flex-col gap-1">
            {doc.fragments.map((f) => {
              const isOpen = expandedFragments.has(f.id);
              return (
                <li key={f.id} className="rounded-lg bg-zinc-900 border border-zinc-800 overflow-hidden">
                  <button
                    onClick={() => toggleFragment(f.id)}
                    className="w-full text-left px-4 py-2.5 flex items-center gap-2 hover:bg-zinc-800/50 transition-colors"
                  >
                    <span className="text-xs text-zinc-600 shrink-0">{isOpen ? "v" : ">"}</span>
                    <span className="text-xs text-zinc-300 flex-1 truncate">{fragmentLabel(f)}</span>
                    <span className="text-[10px] text-zinc-600 shrink-0">{f.text.length} chars</span>
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-3 border-t border-zinc-800">
                      <pre className="text-xs text-zinc-400 whitespace-pre-wrap mt-2 max-h-60 overflow-y-auto leading-relaxed">
                        {f.text}
                      </pre>
                      {f.metadata_json && (
                        <details className="mt-2">
                          <summary className="text-[10px] text-zinc-600 cursor-pointer">Metadata</summary>
                          <pre className="text-[10px] text-zinc-500 whitespace-pre-wrap mt-1">
                            {JSON.stringify(JSON.parse(f.metadata_json), null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Chunks */}
      {doc.chunks.length > 0 && (
        <section>
          <button
            onClick={() => setExpandedChunks(!expandedChunks)}
            className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2 hover:text-zinc-100 transition-colors"
          >
            <span className="text-xs text-zinc-600">{expandedChunks ? "v" : ">"}</span>
            Indexed chunks ({doc.chunks.length})
          </button>
          {expandedChunks && (
            <ul className="flex flex-col gap-1">
              {doc.chunks.map((c) => (
                <li key={c.id} className="rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2.5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] text-zinc-600 font-mono">{c.chroma_id.slice(0, 12)}...</span>
                    <span className="text-[10px] text-zinc-600">{c.text.length} chars</span>
                  </div>
                  <p className="text-xs text-zinc-400 line-clamp-2">{c.text}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* File path */}
      <p className="text-xs text-zinc-600">
        Storage: <span className="font-mono">{doc.file_path}</span>
      </p>
    </div>
  );
}

function MetaCard({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className="text-sm text-zinc-200 mt-0.5 truncate" title={title}>{value}</p>
    </div>
  );
}

function ActionBtn({
  label, busy, disabled, onClick, classes,
}: {
  label: string; busy: boolean; disabled?: boolean; onClick: () => void; classes: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={`text-xs px-3 py-1.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${classes}`}
    >
      {busy ? label.replace(/^[A-Z]/, (c) => c) + "..." : label}
    </button>
  );
}
