import { randomUUID } from "crypto";
import db from "@/lib/db";
import { routeQuery } from "@/lib/queryRouter";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "gemma3";

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/conversations/[id]/messages">
) {
  const { id: conversationId } = await ctx.params;

  const conversation = db
    .prepare(`SELECT * FROM conversations WHERE id = ?`)
    .get(conversationId);
  if (!conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  const body = await request.json();
  const userContent: string = body.content ?? "";
  if (!userContent.trim()) {
    return Response.json({ error: "Content is required" }, { status: 400 });
  }

  // Persist user message
  const userMsgId = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, 'user', ?, ?)`
  ).run(userMsgId, conversationId, userContent, now);

  // Classify query and retrieve context (RAG / wiki / hybrid)
  const routeResult = routeQuery(userContent);

  // Build message history for Ollama
  const history = db
    .prepare(
      `SELECT role, content FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`
    )
    .all(conversationId) as { role: string; content: string }[];

  // Prepend a system message when we have retrieved context
  const ollamaMessages = routeResult.hasContext
    ? [{ role: "system", content: routeResult.systemPrompt }, ...history]
    : history;

  // Update conversation's updated_at
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(Date.now(), conversationId);

  // Auto-title from first user message
  const conv = conversation as { title: string };
  if (conv.title === "New conversation") {
    const newTitle = userContent.slice(0, 60);
    db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(newTitle, conversationId);
  }

  // Stream from Ollama
  let ollamaRes: Response;
  try {
    ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: ollamaMessages,
        stream: true,
      }),
    });
  } catch {
    return Response.json({ error: "Ollama is not reachable" }, { status: 502 });
  }

  if (!ollamaRes.ok || !ollamaRes.body) {
    return Response.json({ error: "Ollama returned an error" }, { status: 502 });
  }

  // Sources to persist alongside the assistant message
  const sourcesJson = JSON.stringify({
    mode: routeResult.mode,
    category: routeResult.category,
    chunks: routeResult.chunks.map((c) => ({
      chunk_id: c.chunk_id,
      score: c.score,
      original_name: c.original_name,
      file_type: c.file_type,
      fragment_type: c.fragment_type,
      page_number: c.page_number,
      slide_number: c.slide_number,
      slide_title: c.slide_title,
      sheet_name: c.sheet_name,
      row_number: c.row_number,
      vendor: c.vendor,
      receipt_date: c.receipt_date,
      total: c.total,
    })),
    wikiPages: routeResult.wikiPages,
  });

  const assistantMsgId = randomUUID();
  const assistantCreatedAt = Date.now();
  let fullContent = "";

  const stream = new ReadableStream({
    async start(controller) {
      const reader = ollamaRes.body!.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
            if (!line.trim()) continue;
            try {
              const json = JSON.parse(line);
              const token: string = json?.message?.content ?? "";
              if (token) {
                fullContent += token;
                controller.enqueue(new TextEncoder().encode(token));
              }
            } catch {
              // skip malformed lines
            }
          }
        }
      } finally {
        reader.releaseLock();
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, content, sources_json, created_at)
           VALUES (?, ?, 'assistant', ?, ?, ?)`
        ).run(assistantMsgId, conversationId, fullContent, sourcesJson, assistantCreatedAt);

        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Message-Id": assistantMsgId,
      "X-Conversation-Id": conversationId,
      "X-Route-Mode": routeResult.mode,
    },
  });
}
