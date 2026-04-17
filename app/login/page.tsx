import { isPasswordSet } from "@/lib/auth";
import { LoginForm } from "./LoginForm";
import { SetupForm } from "./SetupForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const needsSetup = !isPasswordSet();

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-8">
          <h1 className="text-xl font-semibold text-zinc-100 mb-1 text-center">
            eidetic
          </h1>
          <p className="text-sm text-zinc-500 mb-6 text-center">
            {needsSetup
              ? "Choose a password to get started"
              : "Enter your password to continue"}
          </p>

          {needsSetup ? <SetupForm /> : <LoginForm />}
        </div>
      </div>
    </div>
  );
}
