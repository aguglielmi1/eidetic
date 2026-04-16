"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";

interface SourceDoc {
  id: string;
  original_name: string;
  file_type: string;
  status: string;
}

interface WikiPageData {
  id: string;
  slug: string;
  page_type: "vendor" | "doc" | "presentation" | "data";
  title: string;
  content: string;
  file_path: string;
  source_doc_ids: string[];
  sourceDocs: SourceDoc[];
  dirty: number;
  created_at: number;
  updated_at: number;
}

const TYPE_META: Record<WikiPageData["page_type"], { label: string; icon: string; classes: string }> = {
  vendor:       { label: "Vendor",       icon: "store",  classes: "bg-orange-900/50 text-orange-300" },
  doc:          { label: "Document",     icon: "article", classes: "bg-blue-900/50 text-blue-300" },
  presentation: { label: "Presentation", icon: "slides", classes: "bg-purple-900/50 text-purple-300" },
  data:         { label: "Spreadsheet",  icon: "table",  classes: "bg-green-900/50 text-green-300" },
};

const FILE_ICON: Record<string, string> = {
  pdf: "PDF", docx: "DOC", pptx: "PPT", xlsx: "XLS", image: "IMG",
};

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function timeAgo(ms: number) {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Simple markdown renderer for wiki content */
function renderMarkdown(md: string): string {
  let html = md
    // Escape HTML
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    // Headers
    .replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold text-zinc-200 mt-5 mb-2">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-lg font-semibold text-zinc-100 mt-6 mb-2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold text-zinc-100 mt-6 mb-3">$1</h1>')
    // Bold and italic
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-zinc-100 font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Unordered list items
    .replace(/^- (.+)$/gm, '<li class="ml-4 text-zinc-300 before:content-[\'\\2022\'] before:text-zinc-600 before:mr-2">$1</li>')
    // Horizontal rule
    .replace(/^---$/gm, '<hr class="border-zinc-800 my-4" />')
    // Line breaks
    .replace(/\n\n/g, '<div class="h-3"></div>')
    .replace(/\n/g, "<br />");

  // Wrap consecutive <li> in <ul>
  html = html.replace(
    /(<li[^>]*>.*?<\/li>(?:<br \/>)?)+/g,
    (match) => `<ul class="space-y-1 my-2">${match.replace(/<br \/>/g, "")}</ul>`
  );

  return html;
}

export default function WikiSlugPage() {
  const router = useRouter();
  const params = useParams();
  const slug = decodeURIComponent(params.slug as string);

  const [page, setPage] = useState<WikiPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/wiki/${encodeURIComponent(slug)}`);
    if (r.status === 404) { setNotFound(true); setLoading(false); return; }
    if (r.ok) { setPage(await r.json()); setLoading(false); }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  // Poll while rebuilding
  useEffect(() => {
    if (!rebuilding) return;
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [rebuilding, load]);

  const rebuild = async () => {
    setRebuilding(true);
    await fetch(`/api/wiki/${encodeURIComponent(slug)}/rebuild`, { method: "POST" });
    // Poll will pick up changes; stop after wiki_status changes
    setTimeout(() => setRebuilding(false), 15000);
    load();
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-zinc-500 text-sm">Loading...</div>;
  }

  if (notFound || !page) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-4 p-8">
        <span className="text-5xl">?</span>
        <p className="text-sm">Wiki page not found.</p>
        <button onClick={() => router.push("/wiki")} className="text-xs text-blue-400 hover:text-blue-300">
          &larr; Back to Wiki
        </button>
      </div>
    );
  }

  const meta = TYPE_META[page.page_type] ?? TYPE_META.doc;
  const ageMs = Date.now() - page.updated_at;
  const isStale = ageMs > 7 * 24 * 60 * 60 * 1000; // >7 days old

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
      {/* Back link */}
      <button onClick={() => router.push("/wiki")} className="text-zinc-500 hover:text-zinc-300 text-sm self-start">
        &larr; Wiki
      </button>

      {/* Header */}
      <div className="flex items-start gap-3">
        <span className="text-3xl">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold text-zinc-100">{page.title}</h1>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.classes}`}>
              {meta.label}
            </span>
            {page.dirty === 1 && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-yellow-900/50 text-yellow-300">
                Outdated
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            Last updated {formatDate(page.updated_at)} ({timeAgo(page.updated_at)})
            {page.source_doc_ids.length > 0
              ? ` \u00b7 ${page.source_doc_ids.length} source${page.source_doc_ids.length !== 1 ? "s" : ""}`
              : ""}
          </p>
        </div>
      </div>

      {/* Quality notes */}
      {(page.dirty === 1 || isStale) && (
        <div className={`rounded-xl border px-4 py-3 text-xs space-y-1 ${
          page.dirty ? "bg-amber-900/20 border-amber-800/40" : "bg-zinc-900 border-zinc-800"
        }`}>
          <p className="font-medium text-zinc-300">Quality notes</p>
          {page.dirty === 1 && (
            <p className="text-amber-400">
              Source data has changed since this page was generated. Rebuild recommended.
            </p>
          )}
          {isStale && !page.dirty && (
            <p className="text-zinc-500">
              This page was last updated {timeAgo(page.updated_at)}. Consider regenerating for freshness.
            </p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={rebuild}
          disabled={rebuilding}
          className="text-xs px-3 py-1.5 rounded-lg bg-teal-900/40 hover:bg-teal-900/70 text-teal-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {rebuilding ? "Regenerating..." : "Regenerate"}
        </button>
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
        >
          {showRaw ? "Rendered view" : "Raw markdown"}
        </button>
      </div>

      {/* Content */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-5">
        {showRaw ? (
          <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">
            {page.content}
          </pre>
        ) : (
          <div
            className="text-sm text-zinc-300 leading-relaxed wiki-content"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(page.content) }}
          />
        )}
      </div>

      {/* Linked evidence — source documents */}
      {page.sourceDocs.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">Evidence / Source documents</h2>
          <ul className="flex flex-col gap-2">
            {page.sourceDocs.map((doc) => (
              <li key={doc.id}>
                <button
                  onClick={() => router.push(`/library/${doc.id}`)}
                  className="w-full text-left rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 hover:border-zinc-600 transition-colors flex items-center gap-3"
                >
                  <span className="text-xs font-bold text-zinc-500 bg-zinc-800 px-2 py-1 rounded shrink-0">
                    {FILE_ICON[doc.file_type] ?? "FILE"}
                  </span>
                  <span className="flex-1 text-sm text-zinc-200 truncate">{doc.original_name}</span>
                  <span className="text-xs text-zinc-600 shrink-0">{doc.file_type.toUpperCase()}</span>
                  <span className="text-zinc-600 text-sm">&rsaquo;</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* File path hint */}
      <p className="text-xs text-zinc-600">
        Obsidian: <span className="font-mono">{page.file_path}</span>
      </p>
    </div>
  );
}
