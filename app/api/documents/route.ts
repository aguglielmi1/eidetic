import db from "@/lib/db";

export async function GET() {
  const rows = db
    .prepare(
      `SELECT id, original_name, file_type, status, file_size, fragment_count, error_message,
              embed_status, embed_error, chunk_count, wiki_status, wiki_error, wiki_page_slug,
              content_hash, ignored, created_at, updated_at
       FROM documents
       ORDER BY created_at DESC`
    )
    .all();
  return Response.json(rows);
}
