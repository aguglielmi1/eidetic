#!/usr/bin/env python3
"""
Eidetic wiki generator.

Usage:
    python wiki.py <doc_id|all|dirty> <db_path> [wiki_path] [ollama_url]

Modes:
    <doc_id>  -- generate wiki for a single document
    all       -- regenerate wiki for all processed documents
    dirty     -- rebuild only wiki pages marked dirty (Phase 8 incremental rebuild)

Environment variables:
    OLLAMA_URL    Override Ollama base URL (default: http://localhost:11434)
    OLLAMA_MODEL  Ollama chat model        (default: gemma3)

Reads parsed document_fragments from SQLite, calls Gemma via Ollama to
generate markdown wiki pages, writes them to wiki_path, and records them in
the wiki_pages table.

Page types produced:
    vendor        — one page per unique vendor (aggregates all receipts)
    doc           — one page per PDF / DOCX document
    presentation  — one page per PPTX file
    data          — one page per XLSX spreadsheet
    thread        — one page per email thread (Phase 14)
    person        — one page per correspondent (Phase 14)
"""

import sys
import os
import json
import re
import sqlite3
import uuid
import traceback
import urllib.request
from pathlib import Path
from datetime import datetime


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def slugify(text: str) -> str:
    """Convert a string to a URL / filename safe slug."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_-]+", "-", text)
    text = text.strip("-")
    return text or "unknown"


def set_wiki_status(conn: sqlite3.Connection, doc_id: str, status: str,
                    error: str | None = None, page_slug: str | None = None):
    conn.execute(
        """UPDATE documents
           SET wiki_status = ?, wiki_error = ?, wiki_page_slug = ?, updated_at = ?
           WHERE id = ?""",
        (status, error, page_slug, int(datetime.now().timestamp() * 1000), doc_id),
    )
    conn.commit()


def call_ollama(messages: list[dict], ollama_url: str, model: str) -> str:
    """Call Ollama /api/chat (non-streaming) and return assistant content."""
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        f"{ollama_url}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.loads(resp.read())
    return data["message"]["content"]


def upsert_wiki_page(conn: sqlite3.Connection, slug: str, page_type: str,
                     title: str, content: str, file_path: str,
                     source_doc_ids: list[str]):
    """Insert or replace a wiki_pages row and write the markdown file."""
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    Path(file_path).write_text(content, encoding="utf-8")

    now = int(datetime.now().timestamp() * 1000)
    existing = conn.execute(
        "SELECT id FROM wiki_pages WHERE slug = ?", (slug,)
    ).fetchone()

    if existing:
        conn.execute(
            """UPDATE wiki_pages
               SET title = ?, content = ?, file_path = ?, source_doc_ids = ?,
                   dirty = 0, updated_at = ?
               WHERE slug = ?""",
            (title, content, file_path, json.dumps(source_doc_ids), now, slug),
        )
    else:
        conn.execute(
            """INSERT INTO wiki_pages
               (id, slug, page_type, title, content, file_path, source_doc_ids, dirty, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
            (str(uuid.uuid4()), slug, page_type, title, content,
             file_path, json.dumps(source_doc_ids), now, now),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Context assembly helpers
# ---------------------------------------------------------------------------

MAX_CONTEXT_CHARS = 6000  # keep well inside Gemma's context window


def truncate_context(parts: list[str], max_chars: int = MAX_CONTEXT_CHARS) -> str:
    result = []
    total = 0
    for part in parts:
        if total + len(part) > max_chars:
            remaining = max_chars - total
            if remaining > 100:
                result.append(part[:remaining] + "…")
            break
        result.append(part)
        total += len(part)
    return "\n\n".join(result)


# ---------------------------------------------------------------------------
# Page generators
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are a knowledge manager synthesizing document content into a structured wiki page. "
    "Write clear, factual Markdown. "
    "Never invent facts that are not present in the source material. "
    "If evidence is thin or ambiguous, say so explicitly. "
    "Always end with an ## Evidence section that lists every source file referenced."
)


def generate_vendor_page(vendor: str, docs: list, conn: sqlite3.Connection,
                         ollama_url: str, model: str) -> str:
    """Build a vendor wiki page from all receipts for that vendor."""
    parts = []
    evidence_lines = []

    for doc in docs:
        frags = conn.execute(
            "SELECT * FROM document_fragments WHERE document_id = ? ORDER BY created_at ASC",
            (doc["id"],),
        ).fetchall()
        for f in frags:
            if f["text"]:
                parts.append(f"[{doc['original_name']}]\n{f['text']}")
        evidence_lines.append(f"- receipt: {doc['original_name']}")

    context = truncate_context(parts)
    evidence_block = "\n".join(evidence_lines)

    user_msg = (
        f"Generate a wiki page for the vendor **{vendor}**.\n\n"
        f"Source receipts:\n{context}\n\n"
        "The page must include these sections:\n"
        "# {Vendor Name}\n"
        "## Overview\n"
        "## Purchases\n"
        "## Totals\n"
        f"## Evidence\n{evidence_block}\n\n"
        "Write the complete wiki page now."
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": user_msg},
    ]
    return call_ollama(messages, ollama_url, model)


def generate_doc_page(doc, fragments: list, ollama_url: str, model: str) -> str:
    """Build a summary wiki page for a PDF or DOCX document."""
    parts = [f["text"] for f in fragments if f["text"]]
    context = truncate_context(parts)
    doc_name = doc["original_name"]

    user_msg = (
        f"Generate a wiki summary page for the document **{doc_name}**.\n\n"
        f"Content:\n{context}\n\n"
        "The page must include these sections:\n"
        "# {Document Title}\n"
        "## Overview\n"
        "## Key Points\n"
        "## Evidence\n"
        f"- doc: {doc_name}\n\n"
        "Write the complete wiki page now."
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": user_msg},
    ]
    return call_ollama(messages, ollama_url, model)


def generate_presentation_page(doc, fragments: list, ollama_url: str, model: str) -> str:
    """Build a summary wiki page for a PPTX presentation."""
    parts = []
    for f in fragments:
        if not f["text"]:
            continue
        label = ""
        if f["slide_number"] is not None:
            label = f"[Slide {f['slide_number']}"
            if f["slide_title"]:
                label += f": {f['slide_title']}"
            label += "] "
        parts.append(f"{label}{f['text']}")

    context = truncate_context(parts)
    doc_name = doc["original_name"]

    user_msg = (
        f"Generate a wiki summary page for the presentation **{doc_name}**.\n\n"
        f"Slide content:\n{context}\n\n"
        "The page must include these sections:\n"
        "# {Presentation Title}\n"
        "## Overview\n"
        "## Key Topics\n"
        "## Main Points\n"
        "## Evidence\n"
        f"- presentation: {doc_name}\n\n"
        "Write the complete wiki page now."
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": user_msg},
    ]
    return call_ollama(messages, ollama_url, model)


def generate_spreadsheet_page(doc, fragments: list, ollama_url: str, model: str) -> str:
    """Build a structured data summary wiki page for an XLSX spreadsheet."""
    # Group by sheet
    sheets: dict[str, list[str]] = {}
    for f in fragments:
        if not f["text"]:
            continue
        sheet = f["sheet_name"] or "Sheet1"
        sheets.setdefault(sheet, []).append(f["text"])

    sheet_summaries = []
    for sheet_name, rows in sheets.items():
        sample = rows[:20]
        sheet_summaries.append(f"Sheet: {sheet_name}\n" + "\n".join(sample))

    context = truncate_context(sheet_summaries)
    doc_name = doc["original_name"]
    sheet_list = ", ".join(sheets.keys())

    user_msg = (
        f"Generate a wiki data summary page for the spreadsheet **{doc_name}**.\n"
        f"Sheets: {sheet_list}\n\n"
        f"Sample data:\n{context}\n\n"
        "The page must include these sections:\n"
        "# {Spreadsheet Title}\n"
        "## Overview\n"
        "## Data Structure\n"
        "## Key Observations\n"
        "## Evidence\n"
        f"- spreadsheet: {doc_name}\n\n"
        "Write the complete wiki page now."
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": user_msg},
    ]
    return call_ollama(messages, ollama_url, model)


# ---------------------------------------------------------------------------
# Phase 14 — email thread + correspondent pages
# ---------------------------------------------------------------------------

def primary_email_of(addr_text: str | None) -> str | None:
    """Extract the `user@domain` part from a `Name <user@domain>` string."""
    if not addr_text:
        return None
    from email.utils import parseaddr
    _, email = parseaddr(addr_text.split(",")[0])
    return email.lower() if email else None


def generate_thread_page(thread_id: str, doc_rows: list, conn: sqlite3.Connection,
                         ollama_url: str, model: str) -> tuple[str, str, list[str]]:
    """Return (title, markdown content, source_doc_ids) for an email thread."""
    parts = []
    evidence_lines = []
    subject = None
    source_ids: list[str] = []

    for doc in doc_rows:
        source_ids.append(doc["id"])
        frags = conn.execute(
            """SELECT text, fragment_type, email_from, email_subject, email_date
               FROM document_fragments
               WHERE document_id = ?
               ORDER BY CASE fragment_type WHEN 'email_headers' THEN 0 ELSE 1 END,
                        created_at ASC""",
            (doc["id"],),
        ).fetchall()
        for f in frags:
            if f["text"]:
                if subject is None and f["email_subject"]:
                    subject = f["email_subject"]
                parts.append(f"[{f['email_date'] or ''} / {f['email_from'] or ''}]\n{f['text']}")
        evidence_lines.append(f"- message: {doc['email_message_id'] or doc['original_name']}")

    subject = subject or "Email thread"
    context = truncate_context(parts)
    evidence_block = "\n".join(evidence_lines)

    user_msg = (
        f"Summarize the email thread titled **{subject}**.\n\n"
        f"Messages (oldest first):\n{context}\n\n"
        "The page must include these sections:\n"
        "# Thread: {subject}\n"
        "## Summary\n"
        "## Decisions\n"
        "## Action items\n"
        f"## Evidence\n{evidence_block}\n\n"
        "Write the complete wiki page now."
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]
    content = call_ollama(messages, ollama_url, model)
    return subject, content, source_ids


def generate_person_page(email_addr: str, conn: sqlite3.Connection,
                         ollama_url: str, model: str) -> tuple[str, str, list[str]]:
    """Aggregate every thread with the given correspondent into a person page."""
    # Find all email docs whose from or to contains this address.
    rows = conn.execute(
        """SELECT DISTINCT d.id, d.original_name, d.email_thread_id, d.email_message_id
           FROM documents d
           JOIN document_fragments f ON f.document_id = d.id
           WHERE d.file_type = 'email'
             AND f.fragment_type = 'email_headers'
             AND (LOWER(COALESCE(f.email_from, '')) LIKE ?
                  OR LOWER(COALESCE(f.email_to,   '')) LIKE ?)""",
        (f"%{email_addr.lower()}%", f"%{email_addr.lower()}%"),
    ).fetchall()

    source_ids = [r["id"] for r in rows]
    threads: dict[str, list[dict]] = {}
    for r in rows:
        tid = r["email_thread_id"] or r["email_message_id"] or r["id"]
        threads.setdefault(tid, []).append(dict(r))

    context_parts = []
    evidence_lines = []
    for tid, msgs in threads.items():
        subj_row = conn.execute(
            """SELECT email_subject, email_date FROM document_fragments
               WHERE document_id = ? AND fragment_type = 'email_headers' LIMIT 1""",
            (msgs[0]["id"],),
        ).fetchone()
        subj = (subj_row["email_subject"] if subj_row else None) or "(no subject)"
        date = (subj_row["email_date"] if subj_row else None) or "?"
        context_parts.append(f"Thread {tid} — {subj} — {date}")
        for m in msgs:
            bodies = conn.execute(
                "SELECT text FROM document_fragments WHERE document_id = ? AND fragment_type = 'email_body' ORDER BY created_at ASC",
                (m["id"],),
            ).fetchall()
            for b in bodies:
                if b["text"]:
                    context_parts.append(b["text"])
        evidence_lines.append(f"- thread: {subj} ({tid})")

    context = truncate_context(context_parts)
    evidence_block = "\n".join(evidence_lines) or f"- correspondent: {email_addr}"

    user_msg = (
        f"Build a wiki page for the correspondent **{email_addr}**.\n\n"
        f"Email excerpts:\n{context}\n\n"
        "The page must include these sections:\n"
        f"# Person: {email_addr}\n"
        "## Overview\n"
        "## Recurring topics\n"
        "## Open action items\n"
        f"## Evidence\n{evidence_block}\n\n"
        "Write the complete wiki page now."
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]
    content = call_ollama(messages, ollama_url, model)
    return email_addr, content, source_ids


def process_email_thread(thread_id: str, conn: sqlite3.Connection,
                         wiki_path: Path, ollama_url: str, model: str):
    doc_rows = conn.execute(
        """SELECT * FROM documents
           WHERE file_type = 'email' AND email_thread_id = ?
           ORDER BY created_at ASC""",
        (thread_id,),
    ).fetchall()
    if not doc_rows:
        print(f"[wiki] No email docs for thread {thread_id}")
        return

    title, content, source_ids = generate_thread_page(
        thread_id, list(doc_rows), conn, ollama_url, model
    )
    slug = f"thread-{slugify(thread_id)}"
    file_path = str(wiki_path / "thread" / f"{slugify(thread_id)}.md")
    upsert_wiki_page(conn, slug, "thread", title, content, file_path, source_ids)
    for d in doc_rows:
        set_wiki_status(conn, d["id"], "generated", page_slug=slug)


def process_person_page(email_addr: str, conn: sqlite3.Connection,
                        wiki_path: Path, ollama_url: str, model: str):
    title, content, source_ids = generate_person_page(email_addr, conn, ollama_url, model)
    if not source_ids:
        print(f"[wiki] No messages for {email_addr}")
        return
    slug = f"person-{slugify(email_addr)}"
    file_path = str(wiki_path / "person" / f"{slugify(email_addr)}.md")
    upsert_wiki_page(conn, slug, "person", title, content, file_path, source_ids)


# ---------------------------------------------------------------------------
# Document processor
# ---------------------------------------------------------------------------

def process_document(doc_id: str, conn: sqlite3.Connection,
                     wiki_path: Path, ollama_url: str, model: str):
    doc = conn.execute(
        "SELECT * FROM documents WHERE id = ?", (doc_id,)
    ).fetchone()

    if doc is None:
        print(f"[wiki] Document {doc_id} not found", file=sys.stderr)
        return

    if doc["status"] != "processed":
        print(
            f"[wiki] Skipping {doc['original_name']} — status: {doc['status']} (must be 'processed')",
            file=sys.stderr,
        )
        return

    print(f"[wiki] Processing {doc['original_name']} ({doc['file_type']})")
    set_wiki_status(conn, doc_id, "generating")

    try:
        file_type = doc["file_type"]

        if file_type == "image":
            # Receipt → aggregate by vendor
            vendor_raw = conn.execute(
                """SELECT vendor FROM document_fragments
                   WHERE document_id = ? AND vendor IS NOT NULL
                   LIMIT 1""",
                (doc_id,),
            ).fetchone()
            vendor = vendor_raw["vendor"] if vendor_raw else "Unknown Vendor"

            # Gather all documents from same vendor
            vendor_doc_ids_rows = conn.execute(
                """SELECT DISTINCT d.id, d.original_name, d.file_type
                   FROM documents d
                   JOIN document_fragments f ON f.document_id = d.id
                   WHERE f.vendor = ? AND d.status = 'processed'""",
                (vendor,),
            ).fetchall()
            vendor_docs = list(vendor_doc_ids_rows)

            slug = f"vendor-{slugify(vendor)}"
            file_path = str(wiki_path / "vendor" / f"{slugify(vendor)}.md")
            content = generate_vendor_page(vendor, vendor_docs, conn, ollama_url, model)
            source_ids = [d["id"] for d in vendor_docs]
            upsert_wiki_page(conn, slug, "vendor", vendor, content, file_path, source_ids)

            # Update wiki_status for all contributing docs
            for d in vendor_docs:
                set_wiki_status(conn, d["id"], "generated", page_slug=slug)

        elif file_type in ("pdf", "docx"):
            fragments = conn.execute(
                "SELECT * FROM document_fragments WHERE document_id = ? ORDER BY created_at ASC",
                (doc_id,),
            ).fetchall()
            name_stem = Path(doc["original_name"]).stem
            slug = f"doc-{slugify(name_stem)}"
            file_path = str(wiki_path / "doc" / f"{slugify(name_stem)}.md")
            content = generate_doc_page(doc, fragments, ollama_url, model)
            upsert_wiki_page(conn, slug, "doc", doc["original_name"], content, file_path, [doc_id])
            set_wiki_status(conn, doc_id, "generated", page_slug=slug)

        elif file_type == "pptx":
            fragments = conn.execute(
                "SELECT * FROM document_fragments WHERE document_id = ? ORDER BY slide_number ASC, created_at ASC",
                (doc_id,),
            ).fetchall()
            name_stem = Path(doc["original_name"]).stem
            slug = f"presentation-{slugify(name_stem)}"
            file_path = str(wiki_path / "presentation" / f"{slugify(name_stem)}.md")
            content = generate_presentation_page(doc, fragments, ollama_url, model)
            upsert_wiki_page(conn, slug, "presentation", doc["original_name"], content, file_path, [doc_id])
            set_wiki_status(conn, doc_id, "generated", page_slug=slug)

        elif file_type == "xlsx":
            fragments = conn.execute(
                "SELECT * FROM document_fragments WHERE document_id = ? ORDER BY sheet_name ASC, row_number ASC",
                (doc_id,),
            ).fetchall()
            name_stem = Path(doc["original_name"]).stem
            slug = f"data-{slugify(name_stem)}"
            file_path = str(wiki_path / "data" / f"{slugify(name_stem)}.md")
            content = generate_spreadsheet_page(doc, fragments, ollama_url, model)
            upsert_wiki_page(conn, slug, "data", doc["original_name"], content, file_path, [doc_id])
            set_wiki_status(conn, doc_id, "generated", page_slug=slug)

        elif file_type == "email":
            thread_id = doc["email_thread_id"] or doc["email_message_id"] or doc_id
            process_email_thread(thread_id, conn, wiki_path, ollama_url, model)

            # Also rebuild the sender person page
            header = conn.execute(
                "SELECT email_from FROM document_fragments WHERE document_id = ? AND fragment_type = 'email_headers' LIMIT 1",
                (doc_id,),
            ).fetchone()
            sender = primary_email_of(header["email_from"] if header else None)
            if sender:
                process_person_page(sender, conn, wiki_path, ollama_url, model)

        else:
            print(f"[wiki] Unknown file type: {file_type}", file=sys.stderr)
            set_wiki_status(conn, doc_id, "wiki_failed", f"Unsupported file type: {file_type}")

    except Exception as exc:
        error_msg = str(exc)
        print(f"[wiki] ERROR for doc {doc_id}: {error_msg}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        set_wiki_status(conn, doc_id, "wiki_failed", error_msg[:2000])


# ---------------------------------------------------------------------------
# Phase 8 — incremental rebuild of dirty wiki pages
# ---------------------------------------------------------------------------

def rebuild_dirty_pages(conn: sqlite3.Connection, wiki_path: Path,
                        ollama_url: str, model: str):
    """Find all dirty wiki pages and rebuild them from their source documents."""
    dirty_pages = conn.execute(
        "SELECT id, slug, page_type, source_doc_ids FROM wiki_pages WHERE dirty = 1"
    ).fetchall()

    if not dirty_pages:
        print("[wiki] No dirty pages to rebuild")
        return

    print(f"[wiki] Rebuilding {len(dirty_pages)} dirty page(s)")
    now = int(datetime.now().timestamp() * 1000)

    for page in dirty_pages:
        slug = page["slug"]
        page_type = page["page_type"]
        source_ids = json.loads(page["source_doc_ids"] or "[]")

        # Mark any pending job_queue entries as running
        conn.execute(
            "UPDATE job_queue SET status = 'running', updated_at = ? WHERE target_id = ? AND job_type = 'rewiki' AND status = 'pending'",
            (now, slug),
        )
        conn.commit()

        try:
            # Gather source documents that still exist
            valid_doc_ids = []
            for doc_id in source_ids:
                doc = conn.execute(
                    "SELECT id, status FROM documents WHERE id = ? AND status = 'processed'",
                    (doc_id,),
                ).fetchone()
                if doc:
                    valid_doc_ids.append(doc_id)

            if not valid_doc_ids:
                # All source docs are gone — remove the wiki page
                print(f"[wiki] Removing orphaned page: {slug}")
                file_path_row = conn.execute(
                    "SELECT file_path FROM wiki_pages WHERE slug = ?", (slug,)
                ).fetchone()
                if file_path_row and Path(file_path_row["file_path"]).exists():
                    Path(file_path_row["file_path"]).unlink()
                conn.execute("DELETE FROM wiki_pages WHERE slug = ?", (slug,))
                conn.execute(
                    "UPDATE job_queue SET status = 'completed', updated_at = ? WHERE target_id = ? AND job_type = 'rewiki' AND status = 'running'",
                    (now, slug),
                )
                conn.commit()
                continue

            # Rebuild by re-processing the first source document
            # (for vendor pages, process_document aggregates all docs with the same vendor)
            print(f"[wiki] Rebuilding: {slug} (type={page_type}, sources={len(valid_doc_ids)})")

            if page_type == "thread":
                # Derive thread id from any of the source email docs
                thread_doc = conn.execute(
                    "SELECT email_thread_id, email_message_id FROM documents WHERE id = ?",
                    (valid_doc_ids[0],),
                ).fetchone()
                thread_id = None
                if thread_doc:
                    thread_id = thread_doc["email_thread_id"] or thread_doc["email_message_id"]
                if thread_id:
                    process_email_thread(thread_id, conn, wiki_path, ollama_url, model)
                else:
                    process_document(valid_doc_ids[0], conn, wiki_path, ollama_url, model)
            elif page_type == "person":
                # slug = person-<slugified-email>; use the stored title as the canonical address
                title_row = conn.execute(
                    "SELECT title FROM wiki_pages WHERE slug = ?", (slug,)
                ).fetchone()
                if title_row and title_row["title"]:
                    process_person_page(title_row["title"], conn, wiki_path, ollama_url, model)
            else:
                process_document(valid_doc_ids[0], conn, wiki_path, ollama_url, model)

            # Mark jobs as completed
            conn.execute(
                "UPDATE job_queue SET status = 'completed', updated_at = ? WHERE target_id = ? AND job_type = 'rewiki' AND status = 'running'",
                (int(datetime.now().timestamp() * 1000), slug),
            )
            conn.commit()

        except Exception as exc:
            error_msg = str(exc)
            print(f"[wiki] ERROR rebuilding {slug}: {error_msg}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            conn.execute(
                "UPDATE job_queue SET status = 'failed', error = ?, updated_at = ? WHERE target_id = ? AND job_type = 'rewiki' AND status = 'running'",
                (error_msg[:2000], int(datetime.now().timestamp() * 1000), slug),
            )
            conn.commit()

    print("[wiki] Dirty rebuild complete")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 3:
        print(
            f"Usage: {sys.argv[0]} <doc_id|all|dirty> <db_path> [wiki_path] [ollama_url]",
            file=sys.stderr,
        )
        sys.exit(1)

    doc_id_or_all = sys.argv[1]
    db_path = sys.argv[2]
    wiki_path = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(db_path).parent / "wiki"
    ollama_url = sys.argv[4] if len(sys.argv) > 4 else os.environ.get("OLLAMA_URL", "http://localhost:11434")
    model = os.environ.get("OLLAMA_MODEL", "gemma3")

    wiki_path.mkdir(parents=True, exist_ok=True)

    conn = get_db(db_path)

    try:
        if doc_id_or_all == "dirty":
            rebuild_dirty_pages(conn, wiki_path, ollama_url, model)
        elif doc_id_or_all == "all":
            docs = conn.execute(
                "SELECT id FROM documents WHERE status = 'processed'"
            ).fetchall()
            doc_ids = [d["id"] for d in docs]
            print(f"[wiki] Processing {len(doc_ids)} document(s)")
            for doc_id in doc_ids:
                process_document(doc_id, conn, wiki_path, ollama_url, model)
        else:
            process_document(doc_id_or_all, conn, wiki_path, ollama_url, model)

        print("[wiki] Done")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
