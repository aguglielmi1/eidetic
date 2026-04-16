"use server";

import { login } from "@/lib/auth";
import { redirect } from "next/navigation";

export async function loginAction(
  _prevState: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  const password = formData.get("password") as string;

  if (!password) {
    return { error: "Password required" };
  }

  const result = await login(password);

  if (result.error) {
    return { error: result.error };
  }

  redirect("/chat");
}
