export default function UploadPage() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-4 p-8">
      <span className="text-5xl">⬆️</span>
      <h1 className="text-xl font-semibold text-zinc-300">Upload files</h1>
      <p className="text-sm text-center max-w-sm">
        File ingestion coming in Phase 3. Supported types: PDF, DOCX, PPTX,
        XLSX, and receipt images.
      </p>
    </div>
  );
}
