"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface UploadFile {
  id: string;
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
  docId?: string;
}

const ALLOWED_EXTS = new Set([
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "png", "jpg", "jpeg",
]);

function fileExt(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [dragging, setDragging] = useState(false);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    const valid = list.filter((f) => ALLOWED_EXTS.has(fileExt(f.name)));
    const invalid = list.filter((f) => !ALLOWED_EXTS.has(fileExt(f.name)));

    setFiles((prev) => [
      ...prev,
      ...valid.map((f) => ({
        id: crypto.randomUUID(),
        file: f,
        status: "pending" as const,
      })),
      ...invalid.map((f) => ({
        id: crypto.randomUUID(),
        file: f,
        status: "error" as const,
        error: `Unsupported type: .${fileExt(f.name)}`,
      })),
    ]);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const uploadAll = async () => {
    const pending = files.filter((f) => f.status === "pending");
    for (const item of pending) {
      setFiles((prev) =>
        prev.map((f) => (f.id === item.id ? { ...f, status: "uploading" } : f))
      );

      try {
        const fd = new FormData();
        fd.append("file", item.file);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();

        if (!res.ok) {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === item.id
                ? { ...f, status: "error", error: data.error ?? "Upload failed" }
                : f
            )
          );
        } else {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === item.id ? { ...f, status: "done", docId: data.id } : f
            )
          );
        }
      } catch {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === item.id ? { ...f, status: "error", error: "Network error" } : f
          )
        );
      }
    }
    router.refresh();
  };

  const removePending = (id: string) =>
    setFiles((prev) => prev.filter((f) => f.id !== id || f.status !== "pending"));

  const hasPending = files.some((f) => f.status === "pending");
  const hasDone = files.some((f) => f.status === "done");

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Upload files</h1>
        <p className="text-sm text-zinc-500 mt-1">
          PDF, DOCX, PPTX, XLSX, and receipt images (JPG/PNG)
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
          dragging
            ? "border-blue-500 bg-blue-500/10"
            : "border-zinc-700 hover:border-zinc-500"
        }`}
      >
        <span className="text-4xl">⬆️</span>
        <p className="mt-3 text-sm text-zinc-400">
          Drag files here or <span className="text-blue-400 underline">browse</span>
        </p>
        <p className="text-xs text-zinc-600 mt-1">
          pdf · docx · pptx · xlsx · jpg · png
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg"
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
      </div>

      {/* File list */}
      {files.length > 0 && (
        <ul className="flex flex-col gap-2">
          {files.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-3 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3 text-sm"
            >
              <span className="text-lg shrink-0">
                {item.status === "done"
                  ? "✅"
                  : item.status === "error"
                  ? "❌"
                  : item.status === "uploading"
                  ? "⏳"
                  : "📄"}
              </span>
              <span className="flex-1 truncate text-zinc-200">{item.file.name}</span>
              <span className="text-zinc-500 shrink-0">{formatBytes(item.file.size)}</span>
              {item.status === "error" && (
                <span className="text-red-400 text-xs shrink-0 max-w-[180px] truncate">
                  {item.error}
                </span>
              )}
              {item.status === "pending" && (
                <button
                  onClick={(e) => { e.stopPropagation(); removePending(item.id); }}
                  className="text-zinc-600 hover:text-zinc-300 shrink-0"
                  title="Remove"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        {hasPending && (
          <button
            onClick={uploadAll}
            className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
          >
            Upload {files.filter((f) => f.status === "pending").length} file
            {files.filter((f) => f.status === "pending").length !== 1 ? "s" : ""}
          </button>
        )}
        {hasDone && (
          <button
            onClick={() => router.push("/library")}
            className="px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm font-medium text-zinc-200 transition-colors"
          >
            Go to library →
          </button>
        )}
        {files.length > 0 && (
          <button
            onClick={() => setFiles([])}
            className="px-5 py-2.5 rounded-xl text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
