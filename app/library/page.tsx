export default function LibraryPage() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-4 p-8">
      <span className="text-5xl">📁</span>
      <h1 className="text-xl font-semibold text-zinc-300">File library</h1>
      <p className="text-sm text-center max-w-sm">
        Your uploaded and processed files will appear here. Upload files first
        to get started.
      </p>
    </div>
  );
}
