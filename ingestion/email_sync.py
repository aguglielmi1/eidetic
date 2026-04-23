#!/usr/bin/env python3
"""
Eidetic email sync worker (Phase 14 - Step 48).

Usage:
    python email_sync.py <db_path> [raw_dir]

Environment:
    STALWART_JMAP_URL      Base JMAP endpoint (e.g. http://localhost:8080/jmap)
    STALWART_USERNAME      Stalwart mailbox username
    STALWART_PASSWORD      Stalwart mailbox password
    STALWART_ACCOUNT_ID    Optional account id override

Pulls new messages from Stalwart's JMAP endpoint using a state-based
sync cursor (stored in settings under email_sync_cursor). For each new
message it creates:

    * one `documents` row with file_type = 'email'
    * `document_fragments`:
        - email_headers  (From / To / Subject / Date / Thread-Id)
        - email_body     (plaintext body, paragraph-chunked)
    * one `documents` row per attachment, dropped into storage/raw/{docId}/
      and routed back through parse.py for PDFs / docx / etc.

Wiki pages for thread + person are marked dirty so the existing Phase 8
rebuild loop picks them up.
"""

import base64
import json
import os
import sqlite3
import subprocess
import sys
import traceback
import urllib.request
import urllib.error
import uuid
from datetime import datetime
from email.utils import parseaddr
from pathlib import Path


JMAP_CORE = "urn:ietf:params:jmap:core"
JMAP_MAIL = "urn:ietf:params:jmap:mail"


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def get_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(conn: sqlite3.Connection, key: str, value: str):
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# JMAP client (minimal — just the methods we need)
# ---------------------------------------------------------------------------

class JmapClient:
    def __init__(self, base_url: str, username: str, password: str):
        self.base_url = base_url.rstrip("/")
        basic = base64.b64encode(f"{username}:{password}".encode()).decode()
        self.auth_header = f"Basic {basic}"
        self._session: dict | None = None

    def _http_json(self, url: str, payload: dict | None = None) -> dict:
        method = "POST" if payload is not None else "GET"
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": self.auth_header,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())

    def session(self) -> dict:
        if self._session is None:
            # Stalwart exposes the session resource at /.well-known/jmap
            # but some builds respond at /jmap/session too. Try both.
            candidates = []
            if "/jmap" in self.base_url:
                candidates.append(self.base_url.replace("/jmap", "/.well-known/jmap"))
            candidates.append(self.base_url + "/session")
            candidates.append(self.base_url)
            last_err: Exception | None = None
            for url in candidates:
                try:
                    self._session = self._http_json(url)
                    return self._session
                except urllib.error.URLError as exc:
                    last_err = exc
                    continue
            raise RuntimeError(f"Could not fetch JMAP session: {last_err}")
        return self._session

    def account_id(self) -> str:
        override = os.environ.get("STALWART_ACCOUNT_ID")
        if override:
            return override
        session = self.session()
        accounts = session.get("primaryAccounts", {})
        return accounts.get(JMAP_MAIL) or next(iter(session.get("accounts", {}).keys()))

    def api_url(self) -> str:
        session = self.session()
        return session.get("apiUrl") or (self.base_url + "/api")

    def download_url_template(self) -> str:
        session = self.session()
        return session.get("downloadUrl") or (self.base_url + "/download/{accountId}/{blobId}/{name}")

    def call(self, invocations: list) -> dict:
        payload = {
            "using": [JMAP_CORE, JMAP_MAIL],
            "methodCalls": invocations,
        }
        return self._http_json(self.api_url(), payload)

    def download_blob(self, account_id: str, blob_id: str, name: str) -> bytes:
        url = (
            self.download_url_template()
            .replace("{accountId}", account_id)
            .replace("{blobId}", blob_id)
            .replace("{name}", urllib.request.quote(name))
            .replace("{type}", "application/octet-stream")
        )
        req = urllib.request.Request(
            url,
            headers={"Authorization": self.auth_header},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()


# ---------------------------------------------------------------------------
# Message processing
# ---------------------------------------------------------------------------

ATTACHMENT_EXT_MAP = {
    "application/pdf": ("pdf", "pdf"),
    "application/msword": ("doc", "docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ("docx", "docx"),
    "application/vnd.ms-powerpoint": ("ppt", "pptx"),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ("pptx", "pptx"),
    "application/vnd.ms-excel": ("xls", "xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ("xlsx", "xlsx"),
    "image/png": ("png", "image"),
    "image/jpeg": ("jpg", "image"),
}


def chunk_body(text: str, max_chars: int = 1200) -> list[str]:
    """Split a plaintext body into paragraph chunks."""
    paragraphs = [p.strip() for p in text.replace("\r\n", "\n").split("\n\n") if p.strip()]
    chunks: list[str] = []
    buf = ""
    for para in paragraphs:
        if len(buf) + len(para) + 2 > max_chars and buf:
            chunks.append(buf.strip())
            buf = ""
        buf += para + "\n\n"
    if buf.strip():
        chunks.append(buf.strip())
    return chunks or ([text.strip()] if text.strip() else [])


def addr_list(values: list | None) -> str:
    if not values:
        return ""
    parts = []
    for v in values:
        if isinstance(v, dict):
            name = v.get("name") or ""
            email = v.get("email") or ""
            parts.append(f"{name} <{email}>".strip() if name else email)
        else:
            parts.append(str(v))
    return ", ".join(parts)


def primary_email(values: list | None) -> str | None:
    if not values:
        return None
    v = values[0]
    if isinstance(v, dict):
        return v.get("email")
    _, email = parseaddr(str(v))
    return email or None


def insert_fragment(conn: sqlite3.Connection, doc_id: str, text: str,
                    fragment_type: str, **extra) -> None:
    now = int(datetime.now().timestamp() * 1000)
    conn.execute(
        """INSERT INTO document_fragments
           (id, document_id, text, fragment_type,
            email_message_id, email_thread_id, email_from, email_to,
            email_subject, email_date, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            str(uuid.uuid4()),
            doc_id,
            text,
            fragment_type,
            extra.get("email_message_id"),
            extra.get("email_thread_id"),
            extra.get("email_from"),
            extra.get("email_to"),
            extra.get("email_subject"),
            extra.get("email_date"),
            extra.get("metadata_json"),
            now,
        ),
    )


def mark_email_wiki_dirty(conn: sqlite3.Connection, thread_id: str | None,
                          sender_email: str | None):
    """Thread + person pages dirty per Phase 8 rules."""
    now = int(datetime.now().timestamp() * 1000)
    slugs: list[str] = []
    if thread_id:
        slugs.append(f"thread-{slugify(thread_id)}")
    if sender_email:
        slugs.append(f"person-{slugify(sender_email)}")
    for slug in slugs:
        row = conn.execute(
            "SELECT id FROM wiki_pages WHERE slug = ?", (slug,)
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE wiki_pages SET dirty = 1, updated_at = ? WHERE id = ?",
                (now, row["id"]),
            )
        existing_job = conn.execute(
            "SELECT id FROM job_queue WHERE target_id = ? AND job_type = 'rewiki' AND status = 'pending'",
            (slug,),
        ).fetchone()
        if not existing_job:
            conn.execute(
                """INSERT INTO job_queue (id, job_type, target_id, status, reason, created_at, updated_at)
                   VALUES (?, 'rewiki', ?, 'pending', ?, ?, ?)""",
                (str(uuid.uuid4()), slug, "new email delivered", now, now),
            )
    conn.commit()


def slugify(text: str) -> str:
    import re
    text = (text or "").lower().strip()
    text = re.sub(r"[^\w\s@.-]", "", text)
    text = re.sub(r"[\s_-]+", "-", text)
    return text.strip("-") or "unknown"


def process_message(
    conn: sqlite3.Connection,
    jmap: JmapClient,
    account_id: str,
    email: dict,
    raw_dir: Path,
) -> str | None:
    """Create document + fragments for one JMAP Email object."""
    message_id = email.get("messageId") or [email.get("id")]
    msg_id = message_id[0] if isinstance(message_id, list) else message_id
    thread_id = email.get("threadId") or msg_id

    existing = conn.execute(
        "SELECT id FROM documents WHERE file_type = 'email' AND email_message_id = ?",
        (msg_id,),
    ).fetchone()
    if existing:
        return None  # already ingested

    doc_id = str(uuid.uuid4())
    subject = email.get("subject") or "(no subject)"
    from_list = email.get("from") or []
    to_list = email.get("to") or []
    from_str = addr_list(from_list)
    to_str = addr_list(to_list)
    sender_email = primary_email(from_list)
    received_at = email.get("receivedAt") or email.get("sentAt") or ""

    doc_dir = raw_dir / doc_id
    doc_dir.mkdir(parents=True, exist_ok=True)
    meta_path = doc_dir / "email.json"
    meta_path.write_text(json.dumps(email, indent=2, default=str), encoding="utf-8")

    now = int(datetime.now().timestamp() * 1000)
    conn.execute(
        """INSERT INTO documents
           (id, original_name, file_type, status, file_path, file_size,
            email_message_id, email_thread_id, created_at, updated_at)
           VALUES (?, ?, 'email', 'processed', ?, ?, ?, ?, ?, ?)""",
        (
            doc_id,
            subject[:200],
            str(meta_path),
            meta_path.stat().st_size,
            msg_id,
            thread_id,
            now,
            now,
        ),
    )
    conn.commit()

    # Fragment: headers
    headers_text = (
        f"Subject: {subject}\n"
        f"From: {from_str}\n"
        f"To: {to_str}\n"
        f"Date: {received_at}\n"
        f"Thread-Id: {thread_id}"
    )
    insert_fragment(
        conn,
        doc_id,
        headers_text,
        "email_headers",
        email_message_id=msg_id,
        email_thread_id=thread_id,
        email_from=from_str,
        email_to=to_str,
        email_subject=subject,
        email_date=received_at,
    )

    # Body: prefer text, fall back to stripped html
    text_bodies = email.get("textBody") or []
    html_bodies = email.get("htmlBody") or []
    body_values = email.get("bodyValues") or {}

    body_text = ""
    for ref in text_bodies:
        val = body_values.get(ref.get("partId") or "")
        if val and val.get("value"):
            body_text += val["value"] + "\n\n"
    if not body_text.strip():
        for ref in html_bodies:
            val = body_values.get(ref.get("partId") or "")
            if val and val.get("value"):
                body_text += html_to_text(val["value"]) + "\n\n"

    fragment_count = 1  # headers
    for idx, chunk in enumerate(chunk_body(body_text)):
        insert_fragment(
            conn,
            doc_id,
            chunk,
            "email_body",
            email_message_id=msg_id,
            email_thread_id=thread_id,
            email_from=from_str,
            email_to=to_str,
            email_subject=subject,
            email_date=received_at,
            metadata_json=json.dumps({"chunk_index": idx}),
        )
        fragment_count += 1

    # Attachments — each becomes its own `documents` row routed through parse.py
    for att in email.get("attachments") or []:
        try:
            ingest_attachment(conn, jmap, account_id, doc_id, att, raw_dir)
        except Exception as exc:
            print(f"[email] attachment failure: {exc}", file=sys.stderr)

    conn.execute(
        "UPDATE documents SET fragment_count = ?, updated_at = ? WHERE id = ?",
        (fragment_count, int(datetime.now().timestamp() * 1000), doc_id),
    )
    conn.commit()

    mark_email_wiki_dirty(conn, thread_id, sender_email)
    return doc_id


def html_to_text(html: str) -> str:
    """Crude HTML stripping — enough for body_ indexing."""
    import re
    out = re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I)
    out = re.sub(r"<style.*?</style>", " ", out, flags=re.S | re.I)
    out = re.sub(r"<br\s*/?>", "\n", out, flags=re.I)
    out = re.sub(r"</p>", "\n\n", out, flags=re.I)
    out = re.sub(r"<[^>]+>", " ", out)
    out = re.sub(r"&nbsp;", " ", out)
    out = re.sub(r"&amp;", "&", out)
    out = re.sub(r"&lt;", "<", out)
    out = re.sub(r"&gt;", ">", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def ingest_attachment(
    conn: sqlite3.Connection,
    jmap: JmapClient,
    account_id: str,
    parent_doc_id: str,
    att: dict,
    raw_dir: Path,
):
    blob_id = att.get("blobId")
    name = att.get("name") or f"attachment-{blob_id}"
    mime = att.get("type") or ""
    if not blob_id:
        return

    ext, file_type = ATTACHMENT_EXT_MAP.get(mime, (None, None))
    if ext is None:
        # Infer from extension
        lower = name.lower()
        for candidate_mime, (candidate_ext, candidate_type) in ATTACHMENT_EXT_MAP.items():
            if lower.endswith("." + candidate_ext):
                ext = candidate_ext
                file_type = candidate_type
                break
    if ext is None:
        print(f"[email] skipping unsupported attachment: {name} ({mime})")
        return

    data = jmap.download_blob(account_id, blob_id, name)
    doc_id = str(uuid.uuid4())
    doc_dir = raw_dir / doc_id
    doc_dir.mkdir(parents=True, exist_ok=True)
    target = doc_dir / name
    target.write_bytes(data)

    now = int(datetime.now().timestamp() * 1000)
    conn.execute(
        """INSERT INTO documents
           (id, original_name, file_type, status, file_path, file_size,
            created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)""",
        (
            doc_id,
            name,
            file_type,
            str(target),
            target.stat().st_size,
            now,
            now,
        ),
    )
    conn.commit()
    print(f"[email] queued attachment doc {doc_id}: {name} ({file_type})")


# ---------------------------------------------------------------------------
# Sync entry point
# ---------------------------------------------------------------------------

def sync_mailbox(conn: sqlite3.Connection, jmap: JmapClient,
                 raw_dir: Path, db_path: str) -> int:
    account_id = jmap.account_id()

    cursor = get_setting(conn, "email_sync_cursor")
    responses: dict[str, dict] = {}

    if cursor:
        # Incremental sync — ask for everything since `cursor`
        result = jmap.call([
            [
                "Email/changes",
                {"accountId": account_id, "sinceState": cursor, "maxChanges": 200},
                "c",
            ],
            [
                "Email/get",
                {
                    "accountId": account_id,
                    "#ids": {"resultOf": "c", "name": "Email/changes", "path": "/created"},
                    "properties": [
                        "id", "messageId", "threadId", "subject", "from", "to",
                        "receivedAt", "sentAt", "textBody", "htmlBody",
                        "bodyValues", "attachments",
                    ],
                    "fetchTextBodyValues": True,
                    "fetchHTMLBodyValues": True,
                },
                "g",
            ],
        ])
        for entry in result.get("methodResponses", []):
            method, payload, tag = entry
            responses[tag] = payload
        created = responses.get("g", {}).get("list") or []
        new_state = responses.get("c", {}).get("newState") or cursor
    else:
        # First-run — pull recent messages (last 200 from INBOX).
        result = jmap.call([
            [
                "Email/query",
                {
                    "accountId": account_id,
                    "sort": [{"property": "receivedAt", "isAscending": False}],
                    "limit": 200,
                },
                "q",
            ],
            [
                "Email/get",
                {
                    "accountId": account_id,
                    "#ids": {"resultOf": "q", "name": "Email/query", "path": "/ids"},
                    "properties": [
                        "id", "messageId", "threadId", "subject", "from", "to",
                        "receivedAt", "sentAt", "textBody", "htmlBody",
                        "bodyValues", "attachments",
                    ],
                    "fetchTextBodyValues": True,
                    "fetchHTMLBodyValues": True,
                },
                "g",
            ],
        ])
        for entry in result.get("methodResponses", []):
            method, payload, tag = entry
            responses[tag] = payload
        created = responses.get("g", {}).get("list") or []
        new_state = responses.get("g", {}).get("state") or cursor

    processed = 0
    new_doc_ids: list[str] = []
    for email in created:
        try:
            doc_id = process_message(conn, jmap, account_id, email, raw_dir)
            if doc_id:
                processed += 1
                new_doc_ids.append(doc_id)
        except Exception as exc:
            print(f"[email] failed to process {email.get('id')}: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    if new_state:
        set_setting(conn, "email_sync_cursor", new_state)
    set_setting(conn, "email_sync_last_run", str(int(datetime.now().timestamp() * 1000)))

    trigger_followup(conn, new_doc_ids, raw_dir.parent, db_path)

    return processed


def trigger_followup(conn: sqlite3.Connection, email_doc_ids: list[str],
                     storage_dir: Path, db_path: str):
    """Run embed.py for each new email doc and parse.py for any queued attachments.

    Runs inline (blocking) — sync itself is already a background task. Failures
    are logged but don't kill the sync.
    """
    if not email_doc_ids:
        return

    ingestion_dir = Path(__file__).resolve().parent
    chroma_path = str(storage_dir / "chroma")
    python = sys.executable
    ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")

    # Embed email docs directly (they are already 'processed')
    for doc_id in email_doc_ids:
        try:
            subprocess.run(
                [python, str(ingestion_dir / "embed.py"), doc_id, db_path, chroma_path, ollama_url],
                check=False,
                timeout=600,
            )
        except Exception as exc:
            print(f"[email] embed trigger failed for {doc_id}: {exc}", file=sys.stderr)

    # Parse + embed any attachments still in 'queued' status
    attachments = conn.execute(
        "SELECT id, file_path FROM documents WHERE status = 'queued' AND file_type != 'email'"
    ).fetchall()
    for att in attachments:
        att_id = att["id"]
        try:
            subprocess.run(
                [python, str(ingestion_dir / "parse.py"), att_id, att["file_path"], db_path],
                check=False,
                timeout=600,
            )
            subprocess.run(
                [python, str(ingestion_dir / "embed.py"), att_id, db_path, chroma_path, ollama_url],
                check=False,
                timeout=600,
            )
        except Exception as exc:
            print(f"[email] attachment parse/embed failed for {att_id}: {exc}", file=sys.stderr)


def main():
    if len(sys.argv) < 2:
        print("Usage: email_sync.py <db_path> [raw_dir]", file=sys.stderr)
        sys.exit(1)

    db_path = sys.argv[1]
    raw_dir = Path(sys.argv[2] if len(sys.argv) > 2 else Path(db_path).parent / "raw")
    raw_dir.mkdir(parents=True, exist_ok=True)

    base_url = os.environ.get("STALWART_JMAP_URL")
    username = os.environ.get("STALWART_USERNAME")
    password = os.environ.get("STALWART_PASSWORD")
    if not (base_url and username and password):
        print("[email] STALWART_JMAP_URL / STALWART_USERNAME / STALWART_PASSWORD not set — skipping", file=sys.stderr)
        sys.exit(2)

    conn = get_db(db_path)
    jmap = JmapClient(base_url, username, password)

    try:
        count = sync_mailbox(conn, jmap, raw_dir, db_path)
        print(f"[email] sync complete — {count} new message(s)")
    except Exception as exc:
        print(f"[email] sync failed: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        raise
    finally:
        set_setting(conn, "email_sync_running", "0")
        conn.close()


if __name__ == "__main__":
    main()
