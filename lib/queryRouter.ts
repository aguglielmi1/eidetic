import { spawnSync } from "child_process";
import path from "path";
import db from "@/lib/db";

export type QueryMode = "rag" | "wiki" | "hybrid" | "chat";
export type QueryCategory =
  | "lookup"
  | "summary"
  | "comparison"
  | "trend"
  | "citation_required"
  | "chat";

export interface RagChunk {
  chunk_id: string;
  text: string;
  score: number;
  document_id: string;
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

export interface WikiPageRef {
  slug: string;
  title: string;
  page_type: string;
}

interface WikiPageRow extends WikiPageRef {
  content: string;
}

export interface RouteResult {
  mode: QueryMode;
  category: QueryCategory;
  systemPrompt: string;
  chunks: RagChunk[];
  wikiPages: WikiPageRef[];
  hasContext: boolean;
}

// ---------------------------------------------------------------------------
// Query classification
// ---------------------------------------------------------------------------

function classifyQuery(query: string): { category: QueryCategory; mode: QueryMode } {
  const q = query.toLowerCase();

  if (/\b(source|proof|evidence|cite|citation|where did you find|reference|confirm|verify)\b/.test(q)) {
    return { category: "citation_required", mode: "rag" };
  }
  if (/\b(compare|comparison|versus|vs\.?|difference between|better than|worse than|which is)\b/.test(q)) {
    return { category: "comparison", mode: "hybrid" };
  }
  if (/\b(trend|over time|historically|history of|pattern|changed|increased|decreased|growth|decline)\b/.test(q)) {
    return { category: "trend", mode: "hybrid" };
  }
  if (/\b(summar|overview|describe|what is|what are|tell me about|explain|how does|who is|who are)\b/.test(q)) {
    return { category: "summary", mode: "wiki" };
  }
  if (/\b(when|how much|cost|price|date|how many|receipt|total|amount|invoice)\b/.test(q)) {
    return { category: "lookup", mode: "rag" };
  }

  return { category: "chat", mode: "chat" };
}

// ---------------------------------------------------------------------------
// RAG retrieval via retrieve.py
// ---------------------------------------------------------------------------

function retrieveRagChunks(query: string, n = 5): RagChunk[] {
  const cwd = process.cwd();
  const dbPath = path.join(cwd, "storage", "eidetic.db");
  const chromaPath = path.join(cwd, "storage", "chroma");
  const scriptPath = path.join(cwd, "ingestion", "retrieve.py");
  const python = process.env.PYTHON_CMD ?? "python";
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";

  const result = spawnSync(
    python,
    [scriptPath, query, dbPath, chromaPath, ollamaUrl, String(n)],
    { encoding: "utf8", timeout: 30_000, windowsHide: true }
  );

  if (result.error || result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout) as RagChunk[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Wiki search via SQLite LIKE
// ---------------------------------------------------------------------------

function searchWikiPages(query: string, limit = 3): WikiPageRow[] {
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  if (keywords.length === 0) {
    return db
      .prepare(
        `SELECT slug, title, page_type, content
         FROM wiki_pages ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit) as WikiPageRow[];
  }

  const pages: WikiPageRow[] = [];
  const seen = new Set<string>();

  for (const kw of keywords) {
    if (pages.length >= limit) break;
    const like = `%${kw}%`;
    const rows = db
      .prepare(
        `SELECT slug, title, page_type, content
         FROM wiki_pages
         WHERE lower(title) LIKE ? OR lower(content) LIKE ?
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(like, like, limit) as WikiPageRow[];

    for (const row of rows) {
      if (!seen.has(row.slug) && pages.length < limit) {
        seen.add(row.slug);
        pages.push(row);
      }
    }
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

const CHUNK_PREVIEW = 500;   // chars per RAG chunk in the system prompt
const WIKI_PREVIEW  = 1500;  // chars per wiki page in the system prompt

function buildSystemPrompt(
  mode: QueryMode,
  chunks: RagChunk[],
  wikiRows: WikiPageRow[]
): string {
  if (mode === "chat" || (chunks.length === 0 && wikiRows.length === 0)) return "";

  const parts: string[] = [];

  if (mode === "hybrid") {
    parts.push(
      "You are answering based on the user's documents and synthesized knowledge pages. " +
      "Raw sources are authoritative; wiki pages are synthesized memory. " +
      "Cite raw evidence when possible. Do not invent information not present in the context."
    );
  } else if (mode === "rag") {
    parts.push(
      "You are answering based on the user's documents. " +
      "Use the context below to answer accurately. Cite sources when possible. " +
      "Do not invent information not present in the context."
    );
  } else {
    parts.push(
      "You are answering based on synthesized knowledge pages derived from the user's documents. " +
      "Provide a comprehensive answer. Do not invent information not present in the context."
    );
  }

  if (wikiRows.length > 0) {
    parts.push("\n\nSYNTHESIZED KNOWLEDGE:");
    for (const page of wikiRows) {
      const preview =
        page.content.length > WIKI_PREVIEW
          ? page.content.slice(0, WIKI_PREVIEW) + "…"
          : page.content;
      parts.push(`---\n[${page.page_type.toUpperCase()}: ${page.title}]\n${preview}\n---`);
    }
  }

  if (chunks.length > 0) {
    parts.push("\n\nRELEVANT DOCUMENT EXCERPTS:");
    for (const chunk of chunks) {
      const labels = [
        chunk.original_name && `source: ${chunk.original_name}`,
        chunk.page_number   != null && `page ${chunk.page_number}`,
        chunk.slide_number  != null && `slide ${chunk.slide_number}`,
        chunk.sheet_name    && `sheet: ${chunk.sheet_name}`,
        chunk.row_number    != null && `row ${chunk.row_number}`,
        chunk.vendor        && `vendor: ${chunk.vendor}`,
      ]
        .filter(Boolean)
        .join(", ");
      const preview =
        chunk.text.length > CHUNK_PREVIEW
          ? chunk.text.slice(0, CHUNK_PREVIEW) + "…"
          : chunk.text;
      parts.push(`---\n[${labels}]\n${preview}\n---`);
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function routeQuery(query: string): RouteResult {
  const { category, mode } = classifyQuery(query);

  const hasEmbeds =
    (db.prepare(`SELECT COUNT(*) AS cnt FROM chunks`).get() as { cnt: number }).cnt > 0;
  const hasWiki =
    (db.prepare(`SELECT COUNT(*) AS cnt FROM wiki_pages`).get() as { cnt: number }).cnt > 0;

  let chunks: RagChunk[] = [];
  let wikiRows: WikiPageRow[] = [];

  if ((mode === "rag" || mode === "hybrid") && hasEmbeds) {
    chunks = retrieveRagChunks(query, 5);
  }

  if ((mode === "wiki" || mode === "hybrid") && hasWiki) {
    wikiRows = searchWikiPages(query, 3);
  }

  // Wiki mode fallback: if no wiki pages found, fall through to RAG
  if (mode === "wiki" && wikiRows.length === 0 && hasEmbeds) {
    chunks = retrieveRagChunks(query, 5);
  }

  const systemPrompt = buildSystemPrompt(mode, chunks, wikiRows);
  const hasContext = systemPrompt.length > 0;

  const wikiPages: WikiPageRef[] = wikiRows.map(({ slug, title, page_type }) => ({
    slug,
    title,
    page_type,
  }));

  return { mode, category, systemPrompt, chunks, wikiPages, hasContext };
}
