"use server";

import { login, isPasswordSet, setPassword, createSession } from "@/lib/auth";
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

export async function setupAction(
  _prevState: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  if (isPasswordSet()) {
    return { error: "Password already configured" };
  }

  const password = formData.get("password") as string;
  const confirm = formData.get("confirm") as string;

  if (!password) {
    return { error: "Password required" };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters" };
  }

  if (password !== confirm) {
    return { error: "Passwords do not match" };
  }

  setPassword(password);
  await createSession();
  redirect("/chat");
}
