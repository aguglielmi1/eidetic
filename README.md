# Eidetic

A local AI knowledge system. Upload documents, parse them into structured fragments, index them in a vector database, generate a persistent markdown wiki, and query everything through a chat interface that routes questions to raw retrieval, synthesized memory, or both.

## Prerequisites

- **Node.js** 20+
- **Python** 3.10+
- **Ollama** installed and running ([ollama.com](https://ollama.com))
- **Tesseract OCR** installed and on PATH (for receipt image parsing)

## 1. Install Ollama models

```bash
ollama pull gemma3
ollama pull nomic-embed-text
```

Verify Ollama is running at `http://localhost:11434`.

## 2. Install Node dependencies

```bash
npm install
```

## 3. Install Python dependencies

```bash
pip install -r ingestion/requirements.txt
```

This installs `unstructured[pdf,docx]`, `python-pptx`, `openpyxl`, `pytesseract`, `Pillow`, and `chromadb`.

## 4. Start the app

Development:

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

The app runs at `http://localhost:3000` and binds to `0.0.0.0` so it's accessible from other devices on your LAN.

## Usage

| Page | Purpose |
|------|---------|
| `/chat` | Chat with your documents. Questions are routed to RAG, wiki, or both. |
| `/upload` | Upload PDF, DOCX, PPTX, XLSX, or receipt images (JPG/PNG). |
| `/library` | Manage files — parse, embed, generate wiki, inspect, ignore, delete. |
| `/library/[id]` | Inspect a document: fragments, chunks, metadata, errors, linked wiki pages. |
| `/wiki` | Browse synthesized wiki pages grouped by type. |
| `/wiki/[slug]` | Review a wiki page: rendered markdown, source evidence, quality notes, regenerate. |
| `/settings` | View LAN URLs, Ollama config, Tailscale setup guide. |

### Workflow

1. **Upload** files at `/upload`
2. **Parse** each file in the library (extracts text fragments)
3. **Embed** parsed files (indexes chunks in ChromaDB for semantic search)
4. **Generate Wiki** to synthesize knowledge pages from fragments
5. **Chat** — ask questions and get grounded answers with source citations

## Storage

All data lives in the `storage/` directory (created automatically):

```
storage/
  eidetic.db          # SQLite database
  raw/{docId}/        # uploaded files
  chroma/             # ChromaDB vector store
  wiki/{type}/{slug}.md  # generated markdown (Obsidian-compatible)
```

Open `storage/wiki/` as an Obsidian vault for browsing, backlinks, and graph view.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `gemma3` | Chat model name |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding model name |
| `PYTHON_CMD` | `python` | Python executable (use `python3` on some systems) |

## Mobile / remote access

The app is a PWA. On your phone, open the LAN URL shown in `/settings` and use "Add to Home Screen" for an app-like experience.

For access outside your local network, install [Tailscale](https://tailscale.com) on both devices and connect via the Tailscale IP at port 3000.

## Tech stack

- **App**: Next.js 16, React 19, Tailwind 4, TypeScript
- **Database**: SQLite via better-sqlite3
- **LLM**: Ollama + Gemma 3
- **Embeddings**: Ollama + nomic-embed-text
- **Vector store**: ChromaDB
- **Parsing**: unstructured, python-pptx, openpyxl, pytesseract
- **Wiki**: Plain markdown files
