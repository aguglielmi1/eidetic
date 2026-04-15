import db from "@/lib/db";

export async function GET() {
  const rows = db
    .prepare(
      `SELECT id, original_name, file_type, status, file_size, fragment_count, error_message, created_at, updated_at
       FROM documents
       ORDER BY created_at DESC`
    )
    .all();
  return Response.json(rows);
}
