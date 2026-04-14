import { notFound } from "next/navigation";
import db from "@/lib/db";
import ChatView from "@/components/ChatView";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
}

interface Conversation {
  id: string;
  title: string;
  mode: string;
  created_at: number;
  updated_at: number;
}

export default async function ConversationPage(
  props: PageProps<"/chat/[id]">
) {
  const { id } = await props.params;

  const conversation = db
    .prepare(`SELECT * FROM conversations WHERE id = ?`)
    .get(id) as Conversation | undefined;

  if (!conversation) notFound();

  const messages = db
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(id) as Message[];

  return (
    <ChatView
      conversationId={id}
      initialMessages={messages}
      initialTitle={conversation.title}
    />
  );
}

export async function generateMetadata(props: PageProps<"/chat/[id]">) {
  const { id } = await props.params;
  const conv = db
    .prepare(`SELECT title FROM conversations WHERE id = ?`)
    .get(id) as { title: string } | undefined;
  return { title: conv ? `${conv.title} — eidetic` : "eidetic" };
}
