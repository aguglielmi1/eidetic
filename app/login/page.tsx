"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, undefined);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-8">
          <h1 className="text-xl font-semibold text-zinc-100 mb-1 text-center">
            eidetic
          </h1>
          <p className="text-sm text-zinc-500 mb-6 text-center">
            Enter your password to continue
          </p>

          <form action={action} className="space-y-4">
            <div>
              <input
                type="password"
                name="password"
                placeholder="Password"
                required
                autoFocus
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 transition-colors"
              />
            </div>

            {state?.error && (
              <p className="text-sm text-red-400 text-center">{state.error}</p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {pending ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
