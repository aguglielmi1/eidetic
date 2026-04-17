import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_DIR = path.join(process.cwd(), "storage");
const DB_PATH = path.join(DB_DIR, "eidetic.db");

for (const sub of ["", "raw", "processed", "failed", "wiki", "chroma"]) {
  const dir = path.join(DB_DIR, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL DEFAULT 'New conversation',
    mode      TEXT NOT NULL DEFAULT 'chat',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content         TEXT NOT NULL,
    sources_json    TEXT,
    created_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS documents (
    id             TEXT PRIMARY KEY,
    original_name  TEXT NOT NULL,
    file_type      TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'queued',
    file_path      TEXT NOT NULL,
    file_size      INTEGER NOT NULL,
    fragment_count INTEGER NOT NULL DEFAULT 0,
    error_message  TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS document_fragments (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    text         TEXT NOT NULL,
    fragment_type TEXT NOT NULL,
    page_number  INTEGER,
    slide_number INTEGER,
    slide_title  TEXT,
    sheet_name   TEXT,
    row_number   INTEGER,
    vendor       TEXT,
    receipt_date TEXT,
    total        TEXT,
    metadata_json TEXT,
    created_at   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_fragments_document
    ON document_fragments(document_id);

  CREATE TABLE IF NOT EXISTS chunks (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    fragment_id TEXT NOT NULL REFERENCES document_fragments(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    chroma_id   TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_document
    ON chunks(document_id);

  CREATE TABLE IF NOT EXISTS wiki_pages (
    id           TEXT PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    page_type    TEXT NOT NULL,
    title        TEXT NOT NULL,
    content      TEXT NOT NULL,
    file_path    TEXT NOT NULL,
    source_doc_ids TEXT NOT NULL DEFAULT '[]',
    dirty        INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_wiki_pages_type
    ON wiki_pages(page_type);
`);

// Safe column additions — ignored if column already exists
for (const stmt of [
  "ALTER TABLE documents ADD COLUMN embed_status TEXT",
  "ALTER TABLE documents ADD COLUMN embed_error TEXT",
  "ALTER TABLE documents ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE documents ADD COLUMN wiki_status TEXT",
  "ALTER TABLE documents ADD COLUMN wiki_error TEXT",
  "ALTER TABLE documents ADD COLUMN wiki_page_slug TEXT",
  "ALTER TABLE documents ADD COLUMN content_hash TEXT",
  "ALTER TABLE documents ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0",
]) {
  try { db.exec(stmt); } catch { /* already exists */ }
}

// Phase 8 — job queue for tracking pending reprocessing work
db.exec(`
  CREATE TABLE IF NOT EXISTS job_queue (
    id         TEXT PRIMARY KEY,
    job_type   TEXT NOT NULL,
    target_id  TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    reason     TEXT,
    error      TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_job_queue_status
    ON job_queue(status, job_type);

  CREATE INDEX IF NOT EXISTS idx_job_queue_target
    ON job_queue(target_id);
`);

// App settings (password hash, preferences, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export default db;
