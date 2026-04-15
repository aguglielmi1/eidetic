"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface WikiPage {
  id: string;
  slug: string;
  page_type: "vendor" | "doc" | "presentation" | "data";
  title: string;
  source_doc_ids: string[];
  created_at: number;
  updated_at: number;
}

const TYPE_META: Record<WikiPage["page_type"], { label: string; icon: string; classes: string }> = {
  vendor:       { label: "Vendor",       icon: "🏪", classes: "bg-orange-900/50 text-orange-300" },
  doc:          { label: "Document",     icon: "📄", classes: "bg-blue-900/50 text-blue-300" },
  presentation: { label: "Presentation", icon: "📊", classes: "bg-purple-900/50 text-purple-300" },
  data:         { label: "Spreadsheet",  icon: "📈", classes: "bg-green-900/50 text-green-300" },
};

function timeAgo(ms: number) {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function WikiIndexPage() {
  const router = useRouter();
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/wiki")
      .then((r) => r.json())
      .then((data) => {
        setPages(Array.isArray(data) ? data : []);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Loading…
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-4 p-8">
        <span className="text-5xl">📖</span>
        <h1 className="text-xl font-semibold text-zinc-300">Wiki</h1>
        <p className="text-sm text-center max-w-sm">
          No wiki pages yet. Parse your documents in the library, then use the{" "}
          <strong className="text-zinc-300">Generate Wiki</strong> button on each
          document to synthesize knowledge pages.
        </p>
        <button
          onClick={() => router.push("/library")}
          className="mt-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
        >
          Go to Library
        </button>
      </div>
    );
  }

  // Group by type
  const groups = (Object.keys(TYPE_META) as WikiPage["page_type"][])
    .map((type) => ({
      type,
      meta: TYPE_META[type],
      pages: pages.filter((p) => p.page_type === type),
    }))
    .filter((g) => g.pages.length > 0);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Wiki</h1>
        <p className="text-sm text-zinc-500 mt-0.5">
          {pages.length} page{pages.length !== 1 ? "s" : ""} · synthesized from your documents
        </p>
      </div>

      {groups.map(({ type, meta, pages: groupPages }) => (
        <section key={type}>
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            {meta.icon} {meta.label}s
          </h2>
          <ul className="flex flex-col gap-2">
            {groupPages.map((page) => (
              <li key={page.id}>
                <button
                  onClick={() => router.push(`/wiki/${encodeURIComponent(page.slug)}`)}
                  className="w-full text-left rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 hover:border-zinc-600 transition-colors flex items-center gap-3 group"
                >
                  <span className="text-xl shrink-0">{meta.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-100 truncate group-hover:text-white">
                      {page.title}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Updated {timeAgo(page.updated_at)}
                      {page.source_doc_ids.length > 1
                        ? ` · ${page.source_doc_ids.length} sources`
                        : ""}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${meta.classes}`}>
                    {meta.label}
                  </span>
                  <span className="text-zinc-600 group-hover:text-zinc-400 text-sm">›</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
