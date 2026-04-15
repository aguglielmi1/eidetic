import db from "@/lib/db";

export async function GET() {
  const pages = db
    .prepare(
      `SELECT id, slug, page_type, title, source_doc_ids, created_at, updated_at
       FROM wiki_pages
       ORDER BY updated_at DESC`
    )
    .all() as {
      id: string;
      slug: string;
      page_type: string;
      title: string;
      source_doc_ids: string;
      created_at: number;
      updated_at: number;
    }[];

  return Response.json(
    pages.map((p) => ({
      ...p,
      source_doc_ids: JSON.parse(p.source_doc_ids ?? "[]"),
    }))
  );
}
