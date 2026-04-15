"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";

interface WikiPageData {
  id: string;
  slug: string;
  page_type: "vendor" | "doc" | "presentation" | "data";
  title: string;
  content: string;
  file_path: string;
  source_doc_ids: string[];
  dirty: number;
  created_at: number;
  updated_at: number;
}

const TYPE_META: Record<WikiPageData["page_type"], { label: string; icon: string; classes: string }> = {
  vendor:       { label: "Vendor",       icon: "🏪", classes: "bg-orange-900/50 text-orange-300" },
  doc:          { label: "Document",     icon: "📄", classes: "bg-blue-900/50 text-blue-300" },
  presentation: { label: "Presentation", icon: "📊", classes: "bg-purple-900/50 text-purple-300" },
  data:         { label: "Spreadsheet",  icon: "📈", classes: "bg-green-900/50 text-green-300" },
};

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function WikiSlugPage() {
  const router = useRouter();
  const params = useParams();
  const slug = decodeURIComponent(params.slug as string);

  const [page, setPage] = useState<WikiPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/wiki/${encodeURIComponent(slug)}`)
      .then((r) => {
        if (r.status === 404) { setNotFound(true); setLoading(false); return null; }
        return r.json();
      })
      .then((data) => {
        if (data) { setPage(data); setLoading(false); }
      });
  }, [slug]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Loading…
      </div>
    );
  }

  if (notFound || !page) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-4 p-8">
        <span className="text-5xl">❓</span>
        <p className="text-sm">Wiki page not found.</p>
        <button
          onClick={() => router.push("/wiki")}
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          ← Back to Wiki
        </button>
      </div>
    );
  }

  const meta = TYPE_META[page.page_type] ?? TYPE_META.doc;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <button
          onClick={() => router.push("/wiki")}
          className="text-zinc-500 hover:text-zinc-300 text-sm mt-0.5 shrink-0"
        >
          ← Wiki
        </button>
      </div>

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
            Last updated {formatDate(page.updated_at)}
            {page.source_doc_ids.length > 1
              ? ` · ${page.source_doc_ids.length} source documents`
              : ""}
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-5">
        <pre className="text-sm text-zinc-200 whitespace-pre-wrap font-mono leading-relaxed">
          {page.content}
        </pre>
      </div>

      {/* File path hint for Obsidian */}
      <p className="text-xs text-zinc-600">
        File: <span className="font-mono">{page.file_path}</span>
      </p>
    </div>
  );
}
