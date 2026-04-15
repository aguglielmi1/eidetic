#!/usr/bin/env python3
"""
Eidetic retrieval script.

Usage:
    python retrieve.py <query> <db_path> [chroma_path] [ollama_url] [n_results]

Environment variables:
    OLLAMA_URL   Override Ollama base URL (default: http://localhost:11434)
    EMBED_MODEL  Ollama embedding model   (default: nomic-embed-text)

Embeds the query, queries Chroma for nearest chunks, joins with SQLite for
source metadata, and prints a JSON array of results to stdout.
"""

import sys
import os
import json
import sqlite3
import urllib.request
from pathlib import Path


def get_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def embed_text(text: str, ollama_url: str, model: str) -> list[float]:
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


def main():
    if len(sys.argv) < 3:
        sys.stdout.write(json.dumps({"error": "Usage: retrieve.py <query> <db_path> [chroma_path] [ollama_url] [n_results]"}))
        sys.exit(1)

    query = sys.argv[1]
    db_path = sys.argv[2]
    chroma_path = sys.argv[3] if len(sys.argv) > 3 else str(Path(db_path).parent / "chroma")
    ollama_url = sys.argv[4] if len(sys.argv) > 4 else os.environ.get("OLLAMA_URL", "http://localhost:11434")
    n_results = int(sys.argv[5]) if len(sys.argv) > 5 else 5
    embed_model = os.environ.get("EMBED_MODEL", "nomic-embed-text")

    try:
        import chromadb
    except ImportError:
        sys.stdout.write(json.dumps({"error": "chromadb not installed. Run: pip install chromadb"}))
        sys.exit(1)

    conn = get_db(db_path)
    chroma_client = chromadb.PersistentClient(path=chroma_path)

    try:
        collection = chroma_client.get_collection("eidetic_chunks")
    except Exception:
        # Collection doesn't exist yet — no documents embedded
        sys.stdout.write(json.dumps([]))
        sys.exit(0)

    collection_count = collection.count()
    if collection_count == 0:
        sys.stdout.write(json.dumps([]))
        sys.exit(0)

    query_embedding = embed_text(query, ollama_url, embed_model)

    actual_n = min(n_results, collection_count)
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=actual_n,
        include=["documents", "metadatas", "distances"],
    )

    output = []
    for chunk_id, text, meta, dist in zip(
        results["ids"][0],
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    ):
        doc_id = meta.get("document_id", "")
        doc_row = conn.execute(
            "SELECT original_name, file_type FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()

        output.append({
            "chunk_id": chunk_id,
            "text": text,
            "score": round(1.0 - float(dist), 4),  # cosine distance → similarity
            "document_id": doc_id,
            "original_name": doc_row["original_name"] if doc_row else None,
            "file_type": doc_row["file_type"] if doc_row else None,
            "fragment_type": meta.get("fragment_type"),
            "page_number": meta.get("page_number"),
            "slide_number": meta.get("slide_number"),
            "slide_title": meta.get("slide_title"),
            "sheet_name": meta.get("sheet_name"),
            "row_number": meta.get("row_number"),
            "vendor": meta.get("vendor"),
            "receipt_date": meta.get("receipt_date"),
            "total": meta.get("total"),
        })

    conn.close()
    sys.stdout.write(json.dumps(output))


if __name__ == "__main__":
    main()
