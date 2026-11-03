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

function FileThumbnail({ file, className }: { file: ListedFile; className?: string }) {
  const createDownloadToken = useMutation(api.vault.createDownloadToken);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const image = isImageFile(file);
  const Icon = iconForFile(file.name);

  useEffect(() => {
    if (!image || file.status !== "ready") return;
    let cancelled = false;
    createDownloadToken({ fileId: file._id })
      .then((token) => {
        const site = convexSiteUrl();
        if (site && !cancelled) setSrc(`${site}/file/${token}`);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [createDownloadToken, file._id, file.status, image]);

  return (
    <span className={cn("grid shrink-0 place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground", className)}>
      {image && src && !failed ? (
        <img src={src} alt={file.name} loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
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
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
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
    <div className={viewMode === "grid" ? "grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" : "divide-y divide-border/60"}>
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
      <div className={cn("items-center gap-3 bg-muted/50 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:flex", viewMode === "grid" && "hidden")}>
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
          <span className={cn("grid shrink-0 place-items-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand-soft-foreground)]", viewMode === "grid" ? "h-24 w-full" : "size-8")}>
            <Folder className={cn(viewMode === "grid" ? "size-9" : "size-4")} />
          </span>
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
        const Icon = iconForFile(file.name);
        const download = downloads[file._id];
        const uploading = file.status === "uploading";
        return (
          <div
            key={file._id}
            className={cn("group flex items-center gap-3 transition-colors hover:bg-accent/70", viewMode === "grid" ? "min-w-0 flex-col items-stretch rounded-xl border border-border/70 bg-card p-3" : "px-4 py-2.5")}
          >
            <span
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground",
                uploading && "text-[var(--brand)]",
              )}
            >
              {download ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Icon className="size-4" />
              )}
            </span>
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
  );
}
