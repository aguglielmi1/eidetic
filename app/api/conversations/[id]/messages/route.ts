import { randomUUID } from "crypto";
import db from "@/lib/db";
import { routeQuery } from "@/lib/queryRouter";
import {
  READ_ONLY_TOOLS,
  TOOL_SYSTEM_PROMPT,
  WRITE_TOOLS,
  executeTool,
  signProposal,
  validateArgs,
  type ToolName,
} from "@/lib/calendarTools";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "gemma3";

interface ToolCall {
  tool: ToolName | "none";
  args: Record<string, unknown>;
}

async function askModelForTool(userContent: string): Promise<ToolCall | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: TOOL_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        stream: false,
        format: "json",
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { message?: { content?: string } };
    const raw = data?.message?.content ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as ToolCall;
    if (!parsed || typeof parsed.tool !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function streamReply(
  assistantMsgId: string,
  conversationId: string,
  sourcesJson: string,
  text: string
): Promise<Response> {
  const assistantCreatedAt = Date.now();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, sources_json, created_at)
     VALUES (?, ?, 'assistant', ?, ?, ?)`
  ).run(assistantMsgId, conversationId, text, sourcesJson, assistantCreatedAt);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Message-Id": assistantMsgId,
      "X-Conversation-Id": conversationId,
      "X-Route-Mode": "calendar",
    },
  });
}

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

  // Classify query and retrieve context (RAG / wiki / hybrid / calendar)
  const routeResult = routeQuery(userContent);

  // Update conversation's updated_at + auto-title
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(Date.now(), conversationId);
  const conv = conversation as { title: string };
  if (conv.title === "New conversation") {
    const newTitle = userContent.slice(0, 60);
    db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(newTitle, conversationId);
  }

  // ---------------------------------------------------------------------------
  // Calendar-action branch: dispatch to tool loop instead of a plain completion
  // ---------------------------------------------------------------------------
  if (routeResult.mode === "calendar") {
    const assistantMsgId = randomUUID();
    const proposal = await askModelForTool(userContent);

    if (!proposal || proposal.tool === "none") {
      const text = "I wasn't sure how to turn that into a calendar action. Try phrasing it as \"schedule …\", \"cancel …\", or \"what's on my calendar today?\".";
      const sourcesJson = JSON.stringify({
        mode: "calendar",
        category: "calendar_action",
        chunks: [],
        wikiPages: [],
      });
      return streamReply(assistantMsgId, conversationId, sourcesJson, text);
    }

    const toolName = proposal.tool as ToolName;

    // Read-only tools: execute immediately and have Gemma summarise the result.
    if ((READ_ONLY_TOOLS as string[]).includes(toolName)) {
      const result = await executeTool(toolName, proposal.args);
      const resultJson = JSON.stringify(result, null, 2);

      const systemPrompt =
        "You are a calendar assistant. The user asked a calendar question and a tool has already been executed. " +
        "Summarise the tool result for the user in plain English. Keep it short and useful. " +
        "If there are events, list them with times. Do not invent information that is not in the result.\n\n" +
        "TOOL RESULT (JSON):\n" +
        resultJson;

      let ollamaRes: Response;
      try {
        ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent },
            ],
            stream: true,
          }),
        });
      } catch {
        return Response.json({ error: "Ollama is not reachable" }, { status: 502 });
      }
      if (!ollamaRes.ok || !ollamaRes.body) {
        return Response.json({ error: "Ollama returned an error" }, { status: 502 });
      }

      const sourcesJson = JSON.stringify({
        mode: "calendar",
        category: "calendar_action",
        chunks: [],
        wikiPages: [],
        toolCall: { tool: toolName, args: proposal.args, result },
      });

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
          "X-Route-Mode": "calendar",
        },
      });
    }

    // Write tools: validate args, sign a proposal, and stream a preview —
    // the confirm step lives in /api/calendar/tools/execute.
    if ((WRITE_TOOLS as string[]).includes(toolName)) {
      let validated: unknown;
      try {
        validated = validateArgs(toolName, proposal.args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const text = `I couldn't build a valid calendar action from that: ${message}`;
        const sourcesJson = JSON.stringify({
          mode: "calendar",
          category: "calendar_action",
          chunks: [],
          wikiPages: [],
        });
        return streamReply(assistantMsgId, conversationId, sourcesJson, text);
      }

      const proposalId = randomUUID();
      const issuedAt = Date.now();
      const payload = { id: proposalId, tool: toolName, args: validated, issuedAt };
      const signature = signProposal(payload);

      const summary = describeProposal(toolName, validated as Record<string, unknown>);
      const text = `${summary}\n\nConfirm below to apply this change to your calendar.`;

      const sourcesJson = JSON.stringify({
        mode: "calendar",
        category: "calendar_action",
        chunks: [],
        wikiPages: [],
        pendingAction: {
          id: proposalId,
          tool: toolName,
          args: validated,
          issuedAt,
          signature,
        },
      });

      return streamReply(assistantMsgId, conversationId, sourcesJson, text);
    }

    // Unknown tool
    const text = `I couldn't match that to a known calendar tool (got "${toolName}").`;
    const sourcesJson = JSON.stringify({
      mode: "calendar",
      category: "calendar_action",
      chunks: [],
      wikiPages: [],
    });
    return streamReply(assistantMsgId, conversationId, sourcesJson, text);
  }

  // ---------------------------------------------------------------------------
  // Normal RAG / wiki / hybrid / chat path
  // ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

function describeProposal(tool: ToolName, args: Record<string, unknown>): string {
  switch (tool) {
    case "createEvent":
      return `I'd like to create **${args.summary}** from ${args.start} to ${args.end}${args.location ? ` at ${args.location}` : ""}.`;
    case "moveEvent":
      return `I'd like to move event \`${args.uid}\` to ${args.newStart} – ${args.newEnd}.`;
    case "cancelEvent":
      return `I'd like to cancel event \`${args.uid}\`.`;
    case "createTask":
      return `I'd like to add a task **${args.summary}**${args.due ? ` due ${args.due}` : ""}.`;
    case "completeTask":
      return `I'd like to mark task \`${args.uid}\` complete.`;
    default:
      return `Proposed tool: ${tool} with args ${JSON.stringify(args)}`;
  }
}
