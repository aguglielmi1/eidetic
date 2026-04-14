import { randomUUID } from "crypto";
import db from "@/lib/db";

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

  // Build message history for Ollama
  const history = db
    .prepare(
      `SELECT role, content FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`
    )
    .all(conversationId) as { role: string; content: string }[];

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
        messages: history,
        stream: true,
      }),
    });
  } catch {
    return Response.json({ error: "Ollama is not reachable" }, { status: 502 });
  }

  if (!ollamaRes.ok || !ollamaRes.body) {
    return Response.json({ error: "Ollama returned an error" }, { status: 502 });
  }

  // Persist assistant message once stream is done, while streaming to client
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
        // Persist complete assistant response
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, content, created_at)
           VALUES (?, ?, 'assistant', ?, ?)`
        ).run(assistantMsgId, conversationId, fullContent, assistantCreatedAt);

        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Message-Id": assistantMsgId,
      "X-Conversation-Id": conversationId,
    },
  });
}
