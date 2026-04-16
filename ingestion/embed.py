#!/usr/bin/env python3
"""
Eidetic embedding worker.

Usage:
    python embed.py <doc_id> <db_path> [chroma_path] [ollama_url]

Environment variables:
    OLLAMA_URL   Override Ollama base URL (default: http://localhost:11434)
    EMBED_MODEL  Ollama embedding model   (default: nomic-embed-text)

Reads document_fragments from SQLite, generates embeddings via Ollama,
stores chunks in both Chroma and the SQLite chunks table.
"""

import sys
import os
import json
import sqlite3
import uuid
import traceback
import urllib.request
from pathlib import Path
from datetime import datetime


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def get_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def set_embed_status(conn: sqlite3.Connection, doc_id: str, status: str, error: str | None = None):
    conn.execute(
        "UPDATE documents SET embed_status = ?, embed_error = ?, updated_at = ? WHERE id = ?",
        (status, error, int(datetime.now().timestamp() * 1000), doc_id),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Ollama embedding
# ---------------------------------------------------------------------------

def embed_text(text: str, ollama_url: str, model: str) -> list[float]:
    """Call Ollama /api/embeddings and return the vector."""
    payload = json.dumps({"model": model, "prompt": text}).encode()
    req = urllib.request.Request(
        f"{ollama_url}/api/embeddings",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    return data["embedding"]


# ---------------------------------------------------------------------------
# Phase 8 — mark wiki pages dirty after re-embed
# ---------------------------------------------------------------------------

def mark_dirty_pages(conn: sqlite3.Connection, doc_id: str):
    """Find wiki pages whose source_doc_ids include this document and mark dirty."""
    now = int(datetime.now().timestamp() * 1000)
    pages = conn.execute(
        "SELECT id, slug, source_doc_ids FROM wiki_pages"
    ).fetchall()
    dirty_count = 0
    for page in pages:
        source_ids = json.loads(page["source_doc_ids"] or "[]")
        if doc_id in source_ids:
            conn.execute(
                "UPDATE wiki_pages SET dirty = 1, updated_at = ? WHERE id = ?",
                (now, page["id"]),
            )
            # Enqueue rebuild job if not already pending
            existing = conn.execute(
                "SELECT id FROM job_queue WHERE target_id = ? AND job_type = 'rewiki' AND status = 'pending'",
                (page["slug"],),
            ).fetchone()
            if not existing:
                conn.execute(
                    """INSERT INTO job_queue (id, job_type, target_id, status, reason, created_at, updated_at)
                       VALUES (?, 'rewiki', ?, 'pending', ?, ?, ?)""",
                    (str(uuid.uuid4()), page["slug"], f"document {doc_id} re-embedded", now, now),
                )
            dirty_count += 1
    if dirty_count:
        conn.commit()
        print(f"[embed] Marked {dirty_count} wiki page(s) as dirty")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <doc_id> <db_path> [chroma_path] [ollama_url]", file=sys.stderr)
        sys.exit(1)

    doc_id = sys.argv[1]
    db_path = sys.argv[2]
    chroma_path = sys.argv[3] if len(sys.argv) > 3 else str(Path(db_path).parent / "chroma")
    ollama_url = sys.argv[4] if len(sys.argv) > 4 else os.environ.get("OLLAMA_URL", "http://localhost:11434")
    embed_model = os.environ.get("EMBED_MODEL", "nomic-embed-text")

    try:
        import chromadb
    except ImportError:
        raise RuntimeError(
            "chromadb is not installed. Run: pip install chromadb"
        )

    conn = get_db(db_path)

    try:
        # Verify document exists and is parsed
        doc = conn.execute(
            "SELECT id, status FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()
        if doc is None:
            print(f"Document {doc_id} not found", file=sys.stderr)
            sys.exit(1)
        if doc["status"] != "processed":
            raise RuntimeError(
                f"Document must be in 'processed' status, got: {doc['status']}. Parse it first."
            )

        set_embed_status(conn, doc_id, "embedding")

        # Load fragments
        fragments = conn.execute(
            "SELECT * FROM document_fragments WHERE document_id = ?", (doc_id,)
        ).fetchall()

        if not fragments:
            raise RuntimeError("No fragments found — parse the document first")

        print(f"[embed] {len(fragments)} fragment(s) to embed for doc {doc_id}")
        print(f"[embed] Model: {embed_model}  Ollama: {ollama_url}")

        # Set up Chroma persistent client
        chroma_client = chromadb.PersistentClient(path=chroma_path)
        collection = chroma_client.get_or_create_collection(
            "eidetic_chunks",
            metadata={"hnsw:space": "cosine"},
        )

        # Delete old chunks for this document (re-embed case)
        try:
            existing = collection.get(where={"document_id": doc_id})
            if existing["ids"]:
                collection.delete(ids=existing["ids"])
                print(f"[embed] Removed {len(existing['ids'])} stale chunk(s)")
        except Exception:
            pass

        conn.execute("DELETE FROM chunks WHERE document_id = ?", (doc_id,))
        conn.commit()

        # Generate embeddings
        chroma_ids: list[str] = []
        chroma_docs: list[str] = []
        chroma_embeddings: list[list[float]] = []
        chroma_metas: list[dict] = []
        now = int(datetime.now().timestamp() * 1000)

        for frag in fragments:
            text: str = frag["text"] or ""
            if not text.strip():
                continue

            frag_id: str = frag["id"]
            print(f"[embed] Fragment {frag_id[:8]}… ({frag['fragment_type']})")

            embedding = embed_text(text, ollama_url, embed_model)
            chunk_id = str(uuid.uuid4())

            # Chroma metadata — only non-None scalar values
            meta: dict = {"document_id": doc_id, "fragment_id": frag_id, "fragment_type": frag["fragment_type"]}
            for col in ("page_number", "slide_number", "slide_title", "sheet_name",
                        "row_number", "vendor", "receipt_date", "total"):
                val = frag[col]
                if val is not None:
                    meta[col] = val

            chroma_ids.append(chunk_id)
            chroma_docs.append(text)
            chroma_embeddings.append(embedding)
            chroma_metas.append(meta)

            conn.execute(
                "INSERT INTO chunks (id, document_id, fragment_id, text, chroma_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (chunk_id, doc_id, frag_id, text, chunk_id, now),
            )

        if chroma_ids:
            collection.add(
                ids=chroma_ids,
                documents=chroma_docs,
                embeddings=chroma_embeddings,
                metadatas=chroma_metas,
            )

        chunk_count = len(chroma_ids)
        conn.execute(
            "UPDATE documents SET chunk_count = ?, embed_status = 'embedded', embed_error = NULL, updated_at = ? WHERE id = ?",
            (chunk_count, now, doc_id),
        )
        conn.commit()

        print(f"[embed] Done — {chunk_count} chunk(s) stored for doc {doc_id}")

        # Phase 8 — mark wiki pages referencing this document as dirty
        mark_dirty_pages(conn, doc_id)

    except Exception as exc:
        error_msg = str(exc)
        print(f"[embed] ERROR: {error_msg}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        set_embed_status(conn, doc_id, "embed_failed", error_msg[:2000])
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
