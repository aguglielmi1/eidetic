export default function SettingsPage() {
  return (
    <div className="flex-1 overflow-y-auto p-8 max-w-2xl mx-auto w-full">
      <h1 className="text-xl font-semibold text-zinc-100 mb-6">Settings</h1>

      <section className="space-y-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-sm font-medium text-zinc-300 mb-3">LLM Runtime</h2>
          <div className="space-y-2 text-sm text-zinc-400">
            <div className="flex justify-between">
              <span>Ollama URL</span>
              <code className="text-zinc-300">http://localhost:11434</code>
            </div>
            <div className="flex justify-between">
              <span>Model</span>
              <code className="text-zinc-300">gemma3</code>
            </div>
          </div>
          <p className="mt-3 text-xs text-zinc-600">
            Override with OLLAMA_URL and OLLAMA_MODEL environment variables.
          </p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-sm font-medium text-zinc-300 mb-3">Storage</h2>
          <div className="space-y-2 text-sm text-zinc-400">
            <div className="flex justify-between">
              <span>Raw files</span>
              <code className="text-zinc-300">storage/raw</code>
            </div>
            <div className="flex justify-between">
              <span>Database</span>
              <code className="text-zinc-300">storage/eidetic.db</code>
            </div>
            <div className="flex justify-between">
              <span>Wiki pages</span>
              <code className="text-zinc-300">storage/wiki</code>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
