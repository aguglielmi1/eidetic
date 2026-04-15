import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import db from "@/lib/db";

const ALLOWED_EXTENSIONS: Record<string, string> = {
  pdf: "pdf",
  doc: "docx",
  docx: "docx",
  ppt: "pptx",
  pptx: "pptx",
  xls: "xlsx",
  xlsx: "xlsx",
  png: "image",
  jpg: "image",
  jpeg: "image",
};

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid multipart request" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file || typeof file === "string") {
    return Response.json({ error: "No file provided" }, { status: 400 });
  }

  const originalName = file.name;
  const ext = originalName.split(".").pop()?.toLowerCase() ?? "";
  const fileType = ALLOWED_EXTENSIONS[ext];
  if (!fileType) {
    return Response.json(
      { error: `Unsupported file type: .${ext}. Allowed: pdf, doc, docx, ppt, pptx, xls, xlsx, png, jpg, jpeg` },
      { status: 422 }
    );
  }

  const docId = randomUUID();
  const docDir = path.join(process.cwd(), "storage", "raw", docId);
  fs.mkdirSync(docDir, { recursive: true });

  const filePath = path.join(docDir, originalName);
  const bytes = await file.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(bytes));

  const now = Date.now();
  db.prepare(
    `INSERT INTO documents (id, original_name, file_type, status, file_path, file_size, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`
  ).run(docId, originalName, fileType, filePath, file.size, now, now);

  const doc = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(docId);
  return Response.json(doc, { status: 201 });
}
