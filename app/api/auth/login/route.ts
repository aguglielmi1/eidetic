import { login } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { password } = await req.json();

  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  const result = await login(password);

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
