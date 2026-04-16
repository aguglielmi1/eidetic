import db from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);

  const page = db
    .prepare(`SELECT * FROM wiki_pages WHERE slug = ?`)
    .get(decoded) as {
      id: string;
      slug: string;
      page_type: string;
      title: string;
      content: string;
      file_path: string;
      source_doc_ids: string;
      dirty: number;
      created_at: number;
      updated_at: number;
    } | undefined;

  if (!page) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const sourceIds: string[] = JSON.parse(page.source_doc_ids ?? "[]");

  // Fetch source document details
  const sourceDocs = sourceIds.length > 0
    ? db.prepare(
        `SELECT id, original_name, file_type, status FROM documents WHERE id IN (${sourceIds.map(() => "?").join(",")})`
      ).all(...sourceIds) as { id: string; original_name: string; file_type: string; status: string }[]
    : [];

  return Response.json({
    ...page,
    source_doc_ids: sourceIds,
    sourceDocs,
  });
}
