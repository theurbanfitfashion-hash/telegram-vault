import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/errors";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { api } from "@/convex/_generated/api";
import { convexSiteUrl } from "@/lib/convex-site";
import { useMutation } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Download,
  Eye,
  File as FileIcon,
  FileCode,
  FileArchive,
  FileText,
  Film,
  Folder,
  Image,
  Loader2,
  MoreHorizontal,
  Move,
  Music,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  Grid2X2,
  List,
} from "lucide-react";

/** A file as the list sees it — its Telegram parts never leave the server. */
export type ListedFile = Omit<Doc<"files">, "parts">;

function fileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

function iconForFile(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif", "bmp"].includes(extension)) {
    return Image;
  }
  if (["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(extension)) {
    return Film;
  }
  if (["mp3", "wav", "flac", "aac", "m4a", "ogg"].includes(extension)) {
    return Music;
  }
  if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(extension)) {
    return FileArchive;
  }
  if (["js", "ts", "tsx", "jsx", "py", "go", "rs", "java", "html", "css", "json", "sh"].includes(extension)) {
    return FileCode;
  }
  if (["pdf", "txt", "md", "doc", "docx", "rtf", "csv", "xlsx", "ppt", "pptx"].includes(extension)) {
    return FileText;
  }
  return FileIcon;
}

function isImageFile(file: ListedFile) {
  const ext = fileExtension(file.name);
  return file.mimeType.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif", "bmp"].includes(ext);
}

function isVideoFile(file: ListedFile) {
  return file.mimeType.startsWith("video/") || ["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(fileExtension(file.name));
}

function isAudioFile(file: ListedFile) {
  return file.mimeType.startsWith("audio/") || ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma"].includes(fileExtension(file.name));
}

function synchsafeSize(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

function extractMp3Artwork(buffer: ArrayBuffer): Blob | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 10 || String.fromCharCode(...bytes.slice(0, 3)) !== "ID3") return null;
  const version = bytes[3];
  const tagEnd = Math.min(bytes.length, 10 + synchsafeSize(bytes, 6));
  const frameSizeAt = (at: number) => version === 3
    ? (bytes[at] * 0x1000000 + bytes[at + 1] * 0x10000 + bytes[at + 2] * 0x100 + bytes[at + 3])
    : synchsafeSize(bytes, at);
  let offset = 10;
  while (offset + 10 <= tagEnd) {
    const frameId = String.fromCharCode(...bytes.slice(offset, offset + 4));
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
    const frameSize = frameSizeAt(offset + 4);
    if (frameSize <= 0 || offset + 10 + frameSize > tagEnd) break;
    if (frameId === "APIC") {
      const frame = bytes.slice(offset + 10, offset + 10 + frameSize);
      const encoding = frame[0];
      let cursor = 1;
      while (cursor < frame.length && frame[cursor] !== 0) cursor++;
      const mime = new TextDecoder().decode(frame.slice(1, cursor)) || "image/jpeg";
      cursor += 1; // MIME terminator
      cursor += 1; // picture type
      if (encoding === 1 || encoding === 2) {
        while (cursor + 1 < frame.length && (frame[cursor] !== 0 || frame[cursor + 1] !== 0)) cursor += 2;
        cursor += 2;
      } else {
        while (cursor < frame.length && frame[cursor] !== 0) cursor++;
        cursor += 1;
      }
      if (cursor < frame.length) return new Blob([frame.slice(cursor)], { type: mime });
    }
    offset += 10 + frameSize;
  }
  return null;
}

function FileThumbnail({ file, className }: { file: ListedFile; className?: string }) {
  const createDownloadToken = useMutation(api.vault.createDownloadToken);
  const [src, setSrc] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const image = isImageFile(file);
  const video = isVideoFile(file);
  const audio = isAudioFile(file);
  const Icon = iconForFile(file.name);

  useEffect(() => {
    if (file.status !== "ready" || (!image && !video && !audio)) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    let videoElement: HTMLVideoElement | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    createDownloadToken({ fileId: file._id })
      .then(async (token) => {
        const site = convexSiteUrl();
        if (!site || cancelled) return;
        const url = `${site}/file/${token}`;
        setSrc(url);

        if (audio && fileExtension(file.name) === "mp3") {
          try {
            const response = await fetch(url, { headers: { Range: "bytes=0-1048575" } });
            if (!response.ok) return;
            const artwork = extractMp3Artwork(await response.arrayBuffer());
            if (artwork && !cancelled) {
              objectUrl = URL.createObjectURL(artwork);
              setPreview(objectUrl);
            }
          } catch { /* MP3s without readable ID3 artwork use the music icon. */ }
        }

        if (video) {
          videoElement = document.createElement("video");
          videoElement.crossOrigin = "anonymous";
          videoElement.muted = true;
          videoElement.preload = "metadata";
          videoElement.playsInline = true;
          videoElement.src = url;
          const capture = () => {
            if (!videoElement || cancelled || !videoElement.videoWidth) return;
            try {
              const canvas = document.createElement("canvas");
              canvas.width = videoElement.videoWidth;
              canvas.height = videoElement.videoHeight;
              const context = canvas.getContext("2d");
              if (!context) return;
              context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
              canvas.toBlob((blob) => {
                if (blob && !cancelled) {
                  objectUrl = URL.createObjectURL(blob);
                  setPreview(objectUrl);
                }
              }, "image/jpeg", 0.78);
            } catch { /* Unsupported/tainted video frame: keep the video icon. */ }
          };
          videoElement.addEventListener("loadedmetadata", () => {
            if (!videoElement || cancelled) return;
            const seekTo = Math.min(1, Math.max(0, (videoElement.duration || 1) / 4));
            if (seekTo === 0) capture();
            else {
              videoElement.addEventListener("seeked", capture, { once: true });
              videoElement.currentTime = seekTo;
            }
          }, { once: true });
          videoElement.addEventListener("error", () => { if (!cancelled) setFailed(true); }, { once: true });
          timeout = setTimeout(capture, 9000);
          videoElement.load();
        }
      })
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      videoElement?.pause();
      if (videoElement) {
        videoElement.removeAttribute("src");
        videoElement.load();
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [createDownloadToken, file._id, file.status, file.name, image, video, audio]);

  return (
    <span className={cn("grid shrink-0 place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground", className)}>
      {image && src && !failed ? (
        <img src={src} alt={file.name} loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : preview && !failed ? (
        <img src={preview} alt={`${file.name} thumbnail`} loading="lazy" className="h-full w-full object-cover" />
      ) : <Icon className="size-5" />}
    </span>
  );
}

const ROW_ACTIONS =
  "grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-opacity hover:bg-accent focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover:opacity-100";

export function FileList({
  folders,
  files,
  downloads,
  onOpenFolder,
  onOpen,
  onDownload,
  onNewFolder,
  onUpload,
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
}: {
  folders: Doc<"folders">[];
  files: ListedFile[];
  downloads: Record<string, { done: number; total: number }>;
  onOpenFolder: (id: Id<"folders">) => void;
  onOpen: (file: ListedFile) => void;
  onDownload: (file: ListedFile) => Promise<void>;
  onNewFolder: () => void;
  onUpload: () => void;
  onRenameFolder: (folder: Doc<"folders">) => void;
  onMoveFolder: (folder: Doc<"folders">) => void;
  onDeleteFolder: (folder: Doc<"folders">) => void;
  onRenameFile: (file: ListedFile) => void;
  onMoveFile: (file: ListedFile) => void;
  onDeleteFile: (file: ListedFile) => void;
}) {
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<"date" | "size" | "name" | "type">("date");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [viewMode, setViewMode] = useState<"list" | "grid">(() => {
    if (typeof window === "undefined") return "list";
    return window.localStorage.getItem("telegram-vault-file-view") === "grid" ? "grid" : "list";
  });

  useEffect(() => {
    window.localStorage.setItem("telegram-vault-file-view", viewMode);
  }, [viewMode]);
  const sortLabel = {
    date: "Date modified",
    size: "Size",
    name: "Filename",
    type: "Type",
  }[sortField];

  const visibleFolders = useMemo(() => folders
    .filter((folder) => folder.name.toLowerCase().includes(search.trim().toLowerCase()))
    .slice()
    .sort((a, b) => {
      const result = sortField === "date"
        ? a.createdAt - b.createdAt
        : a.name.localeCompare(b.name);
      return sortDirection === "asc" ? result : -result;
    }), [folders, search, sortField, sortDirection]);

  const visibleFiles = useMemo(() => files
    .filter((file) => file.name.toLowerCase().includes(search.trim().toLowerCase()))
    .slice()
    .sort((a, b) => {
      let result = 0;
      if (sortField === "date") result = a.createdAt - b.createdAt;
      else if (sortField === "size") result = a.size - b.size;
      else if (sortField === "name") result = a.name.localeCompare(b.name);
      else {
        const typeA = fileExtension(a.name);
        const typeB = fileExtension(b.name);
        result = typeA.localeCompare(typeB) || a.name.localeCompare(b.name);
      }
      return sortDirection === "asc" ? result : -result;
    }), [files, search, sortField, sortDirection]);

  if (folders.length === 0 && files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-20 text-center">
        <div className="grid size-14 place-items-center rounded-2xl bg-[var(--brand-soft)] text-[var(--brand-soft-foreground)]">
          <Folder className="size-6" />
        </div>
        <div className="space-y-1.5">
          <p className="text-base font-medium tracking-[-0.01em]">
            This folder is empty
          </p>
          <p className="mx-auto max-w-sm text-sm leading-6 text-muted-foreground">
            Drop files anywhere in this window, or use the buttons above. They
            land in Telegram a few seconds later.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" onClick={onUpload}>
            <Upload className="mr-2 size-4" />
            Upload files
          </Button>
          <Button size="sm" variant="outline" onClick={onNewFolder}>
            <Plus className="mr-2 size-4" />
            New folder
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/60">
      <div className="flex flex-col gap-2 border-b border-border/60 p-3 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search files and folders"
            aria-label="Search files and folders"
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          />
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Sort by ${sortLabel}, ${sortDirection === "asc" ? "ascending" : "descending"}`}
              className="h-10 shrink-0 justify-between gap-3 px-3"
            >
              <span>{sortLabel}</span>
              {sortDirection === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            {([
              ["date", "Date modified"],
              ["size", "Size"],
              ["name", "Filename"],
              ["type", "Type"],
            ] as const).map(([field, label]) => (
              <DropdownMenuItem key={field} onClick={() => setSortField(field)}>
                <span className="flex-1">{label}</span>
                {sortField === field ? <Check className="size-4 text-primary" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Order</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setSortDirection("asc")}>
              <ArrowUp className="mr-2 size-4" />
              <span className="flex-1">Ascending</span>
              {sortDirection === "asc" ? <Check className="size-4 text-primary" /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSortDirection("desc")}>
              <ArrowDown className="mr-2 size-4" />
              <span className="flex-1">Descending</span>
              {sortDirection === "desc" ? <Check className="size-4 text-primary" /> : null}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex h-10 shrink-0 items-center rounded-lg border border-input p-1" role="group" aria-label="File view">
          <Button type="button" size="icon" variant={viewMode === "list" ? "secondary" : "ghost"} className="size-8" aria-label="List view" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List className="size-4" /></Button>
          <Button type="button" size="icon" variant={viewMode === "grid" ? "secondary" : "ghost"} className="size-8" aria-label="Grid view" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><Grid2X2 className="size-4" /></Button>
        </div>
      </div>
      {visibleFolders.length === 0 && visibleFiles.length === 0 ? (
        <div className="px-6 py-14 text-center text-sm text-muted-foreground">No matching files or folders.</div>
      ) : null}
      <div className={cn(viewMode === "grid" ? "grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" : "divide-y divide-border/60")}>
      <div className={viewMode === "grid" ? "hidden" : "flex items-center gap-3 bg-muted/50 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"}>
        <span className="flex-1">Name</span>
        <span className="w-24 shrink-0 text-right">Size</span>
        <span className="hidden w-32 shrink-0 text-right md:block">Modified</span>
        <span className="w-8 shrink-0" />
      </div>

      {visibleFolders.map((folder) => (
        <div
          key={folder._id}
          className={cn("group flex items-center gap-3 transition-colors hover:bg-accent/70", viewMode === "grid" ? "min-w-0 flex-col items-stretch rounded-xl border border-border/70 bg-card p-3" : "px-4 py-2.5")}
        >
          <button
            type="button"
            onClick={() => onOpenFolder(folder._id)}
            aria-label={`Open folder ${folder.name}`}
            className={cn("grid shrink-0 place-items-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand-soft-foreground)] transition-colors hover:brightness-95", viewMode === "grid" ? "h-24 w-full" : "size-8")}
          >
            <Folder className={cn(viewMode === "grid" ? "size-9" : "size-4")} />
          </button>
          <button
            type="button"
            onClick={() => onOpenFolder(folder._id)}
            className={cn("min-w-0 truncate text-left text-sm font-medium tracking-[-0.005em] transition-colors hover:text-[var(--brand)]", viewMode === "grid" ? "w-full" : "flex-1")}
          >
            {folder.name}
          </button>
          <span className={cn("w-24 shrink-0 text-right font-mono-nums text-xs text-muted-foreground", viewMode === "grid" ? "hidden" : "hidden sm:block")}>
            —
          </span>
          <span className={cn("w-32 shrink-0 text-right text-xs text-muted-foreground", viewMode === "grid" ? "hidden" : "hidden md:block")}>
            {formatDate(folder.createdAt)}
          </span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${folder.name}`}
                className={ROW_ACTIONS}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => onOpenFolder(folder._id)}>
                <Folder className="mr-2 size-4" />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRenameFolder(folder)}>
                <Pencil className="mr-2 size-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMoveFolder(folder)}>
                <Move className="mr-2 size-4" />
                Move to…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDeleteFolder(folder)}
              >
                <Trash2 className="mr-2 size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}

      {visibleFiles.map((file) => {
        const download = downloads[file._id];
        const uploading = file.status === "uploading";
        return (
          <div
            key={file._id}
            className={cn("group flex items-center gap-3 transition-colors hover:bg-accent/70", viewMode === "grid" ? "min-w-0 flex-col items-stretch rounded-xl border border-border/70 bg-card p-3" : "px-4 py-2.5")}
          >
            <button
              type="button"
              disabled={uploading}
              onClick={() => onOpen(file)}
              title={uploading ? "Still uploading" : `Open ${file.name}`}
              aria-label={`Preview ${file.name}`}
              className={cn("relative block shrink-0 overflow-hidden rounded-lg text-left transition-opacity hover:opacity-85 disabled:cursor-default", viewMode === "grid" ? "h-28 w-full" : "size-10")}
            >
              {download ? (
                <span className="grid h-full w-full place-items-center rounded-lg bg-muted"><Loader2 className="size-4 animate-spin" /></span>
              ) : (
                <FileThumbnail file={file} className="h-full w-full" />
              )}
            </button>
            <button
              type="button"
              disabled={uploading}
              title={uploading ? "Still uploading" : `Open ${file.name}`}
              onClick={() => onOpen(file)}
              className={cn("min-w-0 truncate text-left text-sm tracking-[-0.005em] transition-colors hover:text-[var(--brand)] disabled:cursor-default disabled:hover:text-foreground", viewMode === "grid" ? "w-full" : "flex-1")}
            >
              {file.name}
              {uploading ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  uploading…
                </span>
              ) : null}
              {download && download.total > 0 ? (
                <span className="ml-2 font-mono-nums text-xs text-muted-foreground">
                  {download.done}/{download.total}
                </span>
              ) : null}
            </button>
            {viewMode === "grid" ? (
              <div className="grid w-full grid-cols-2 gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="truncate">Type: {fileExtension(file.name).toUpperCase() || "Unknown"}</span>
                <span className="text-right">Size: {uploading ? "—" : formatBytes(file.size)}</span>
                <span className="col-span-2 truncate">Modified: {formatDate(file.createdAt)}</span>
              </div>
            ) : null}
            <span className={cn("w-24 shrink-0 text-right font-mono-nums text-xs text-muted-foreground", viewMode === "grid" ? "hidden" : "hidden sm:block")}>
              {uploading ? "—" : formatBytes(file.size)}
            </span>
            <span className={cn("w-32 shrink-0 text-right text-xs text-muted-foreground", viewMode === "grid" ? "hidden" : "hidden md:block")}>
              {formatDate(file.createdAt)}
            </span>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Actions for ${file.name}`}
                  className={ROW_ACTIONS}
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  disabled={uploading}
                  onClick={() => onOpen(file)}
                >
                  <Eye className="mr-2 size-4" />
                  Open
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={uploading}
                  onClick={() =>
                    onDownload(file).catch((error) =>
                      console.error(errorMessage(error)),
                    )
                  }
                >
                  <Download className="mr-2 size-4" />
                  Download
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRenameFile(file)}>
                  <Pencil className="mr-2 size-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onMoveFile(file)}>
                  <Move className="mr-2 size-4" />
                  Move to…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onDeleteFile(file)}
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
      </div>
    </div>
  );
}
