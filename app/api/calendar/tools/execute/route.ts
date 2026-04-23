import {
  WRITE_TOOLS,
  executeTool,
  verifyProposal,
  validateArgs,
  type ToolName,
} from "@/lib/calendarTools";

interface ExecuteBody {
  id?: string;
  tool?: string;
  args?: Record<string, unknown>;
  issuedAt?: number;
  signature?: string;
}

const MAX_PROPOSAL_AGE_MS = 15 * 60_000; // 15 minutes

export async function POST(request: Request) {
  let body: ExecuteBody;
  try {
    body = (await request.json()) as ExecuteBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, tool, args, issuedAt, signature } = body;
  if (!id || !tool || !args || !issuedAt || !signature) {
    return Response.json(
      { error: "Missing one of: id, tool, args, issuedAt, signature" },
      { status: 400 }
    );
  }

  if (!(WRITE_TOOLS as string[]).includes(tool)) {
    return Response.json(
      { error: `Tool ${tool} is not a confirmable write tool` },
      { status: 400 }
    );
  }

  // Verify signature against the exact payload shape produced by the chat route.
  const payload = { id, tool, args, issuedAt };
  if (!verifyProposal(payload, signature)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Reject stale proposals — prevents replay of an old signed payload long
  // after the user dismissed it.
  if (Date.now() - issuedAt > MAX_PROPOSAL_AGE_MS) {
    return Response.json({ error: "Proposal expired" }, { status: 410 });
  }

  // Re-validate the args via zod — signature attests to the payload we signed,
  // but the schema check guards against shape drift between versions.
  try {
    validateArgs(tool as ToolName, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Invalid args: ${message}` }, { status: 400 });
  }

  const result = await executeTool(tool as ToolName, args);
  const status = result.ok ? 200 : 502;
  return Response.json(result, { status });
}
