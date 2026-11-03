import { BrandWordmark } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { ConnectPanel, type TelegramStatus } from "@/components/vault/ConnectPanel";
import { FileList, type ListedFile } from "@/components/vault/FileList";
import { FileViewer } from "@/components/vault/FileViewer";
import { FolderTree } from "@/components/vault/FolderTree";
import { ConfirmDialog, MoveDialog, NameDialog } from "@/components/vault/dialogs";
import { UploadQueue } from "@/components/vault/UploadQueue";
import { useAuth } from "@/hooks/use-auth";
import { CHUNK_BYTES } from "@/lib/constants";
import { errorMessage } from "@/lib/errors";
import { buildTree, folderPath, subtreeIds } from "@/lib/folders";
import { useTransfer, type UploadPatch, type UploadState } from "@/lib/transfer";
import { cn } from "@/lib/utils";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  ChevronRight,
  FolderPlus,
  Headphones,
  Loader2,
  LogOut,
  Menu,
  RefreshCw,
  Upload,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

type DialogState =
  | { kind: "newFolder" }
  | { kind: "renameFolder"; folder: Doc<"folders"> }
  | { kind: "renameFile"; file: ListedFile }
  | { kind: "moveFolder"; folder: Doc<"folders"> }
  | { kind: "moveFile"; file: ListedFile }
  | { kind: "deleteFolder"; folder: Doc<"folders"> }
  | { kind: "deleteFile"; file: ListedFile }
  | null;

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { uploadFile, downloadFile, deleteFile } = useTransfer();

  // --- location ----------------------------------------------------------
  const folders = useQuery(api.vault.listFolders);
  const foldersReady = folders !== undefined;
  const requestedId = searchParams.get("f");
  const requestedIsValid =
    foldersReady &&
    requestedId !== null &&
    folders.some((folder) => folder._id === requestedId);
  const activeId = requestedIsValid ? (requestedId as Id<"folders">) : null;
  const notFound = foldersReady && requestedId !== null && !requestedIsValid;

  const files = useQuery(
    api.vault.listFiles,
    !foldersReady || notFound ? "skip" : { folderId: activeId },
  );

  const tree = useMemo(() => buildTree(folders ?? []), [folders]);
  const activePath = useMemo(
    () => folderPath(folders ?? [], activeId),
    [folders, activeId],
  );
  const activePathIds = useMemo(
    () => new Set(activePath.map((folder) => folder._id)),
    [activePath],
  );
  const activeFolder =
    activePath.length > 0 ? activePath[activePath.length - 1] : null;
  const childFolders = useMemo(
    () => (folders ?? []).filter((folder) => folder.parentId === activeId),
    [folders, activeId],
  );
  const listedFiles = files ?? [];

  const navigateTo = useCallback(
    (id: Id<"folders"> | null) => {
      const next = new URLSearchParams(searchParams);
      if (id === null) next.delete("f");
      else next.set("f", id);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  // --- telegram connection ------------------------------------------------
  const telegramStatus = useAction(api.telegram.telegramStatus);
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [statusPhase, setStatusPhase] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [showConnect, setShowConnect] = useState(false);

  const refreshStatus = useCallback(async (): Promise<TelegramStatus | null> => {
    try {
      const next = await telegramStatus({});
      setStatus(next);
      setStatusPhase("ready");
      return next;
    } catch (error) {
      console.error(error);
      setStatusPhase("error");
      return null;
    }
  }, [telegramStatus]);

  useEffect(() => {
    let cancelled = false;
    telegramStatus({})
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setStatusPhase("ready");
      })
      .catch((error: unknown) => {
        console.error(error);
        if (!cancelled) setStatusPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [telegramStatus]);

  const handleConnected = useCallback(async () => {
    const next = await refreshStatus();
    if (next?.hasToken && next.chatConnected) {
      setShowConnect(false);
      toast.success("Telegram connected");
    }
  }, [refreshStatus]);

  // --- vault operations ---------------------------------------------------
  const createFolder = useMutation(api.vault.createFolder);
  const renameFolder = useMutation(api.vault.renameFolder);
  const moveFolderMutation = useMutation(api.vault.moveFolder);
  const renameFileMutation = useMutation(api.vault.renameFile);
  const moveFileMutation = useMutation(api.vault.moveFile);
  const removeFolder = useAction(api.telegram.removeFolder);

  const [dialog, setDialog] = useState<DialogState>(null);
  const [viewerFileId, setViewerFileId] = useState<Id<"files"> | null>(null);
  // Follows the live record, so a rename shows instantly and a deletion
  // closes the viewer on its own.
  const viewerFile =
    viewerFileId === null
      ? null
      : listedFiles.find((file) => file._id === viewerFileId) ?? null;
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [downloads, setDownloads] = useState<
    Record<string, { done: number; total: number }>
  >({});
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [activeId]);

  const patchUpload = useCallback((key: string, patch: UploadPatch) => {
    setUploads((current) =>
      current.map((entry) =>
        entry.key === key ? { ...entry, ...patch } : entry,
      ),
    );
  }, []);

  const dismissUpload = useCallback((key: string) => {
    setUploads((current) => current.filter((entry) => entry.key !== key));
  }, []);

  const ingest = useCallback(
    async (incoming: FileList | File[]) => {
      const chosen = Array.from(incoming);
      if (chosen.length === 0) return;
      for (const file of chosen) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setUploads((current) => [
          ...current,
          {
            key,
            fileId: null,
            name: file.name,
            size: file.size,
            loaded: 0,
            chunkIndex: 0,
            chunkCount: Math.max(1, Math.ceil(file.size / CHUNK_BYTES)),
            phase: "uploading",
          },
        ]);
        try {
          await uploadFile({
            file,
            folderId: activeId,
            onPatch: (patch) => patchUpload(key, patch),
          });
          window.setTimeout(() => dismissUpload(key), 3000);
        } catch (error) {
          patchUpload(key, { phase: "error", error: errorMessage(error) });
        }
      }
    },
    [uploadFile, activeId, patchUpload, dismissUpload],
  );

  const handleDownload = useCallback(
    async (file: ListedFile) => {
      setDownloads((current) => ({
        ...current,
        [file._id]: { done: 0, total: file.chunkCount },
      }));
      try {
        await downloadFile(file, (done, total) =>
          setDownloads((current) => ({ ...current, [file._id]: { done, total } })),
        );
        toast.success("Download started");
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        window.setTimeout(
          () =>
            setDownloads((current) => {
              const next = { ...current };
              delete next[file._id];
              return next;
            }),
          1200,
        );
      }
    },
    [downloadFile],
  );

  async function handleCreateFolder(name: string) {
    const id = await createFolder({ name, parentId: activeId });
    toast.success(`Folder “${name}” created`);
    navigateTo(id);
  }

  async function handleDeleteFolder(folder: Doc<"folders">) {
    await removeFolder({ folderId: folder._id });
    if (activeId && subtreeIds(folders ?? [], folder._id).has(activeId)) {
      navigateTo(folder.parentId);
    }
    toast.success("Folder deleted");
  }

  async function handleDeleteFile(file: ListedFile) {
    await deleteFile(file._id);
    toast.success("File deleted");
  }

  const handleSignOut = async () => {
    try {
      await signOut();
    } finally {
      navigate("/");
    }
  };

  // --- states before the vault ------------------------------------------
  if (statusPhase === "loading" || status === null) return <VaultLoading />;

  if (statusPhase === "error") {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-sm rounded-2xl border border-border/70 bg-card p-7 text-center shadow-card">
          <p className="text-base font-medium tracking-[-0.01em]">
            Couldn't reach your vault
          </p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The connection to the backend dropped. It usually comes back on its
            own.
          </p>
          <Button
            className="mt-5"
            onClick={() => void refreshStatus()}
            size="sm"
          >
            <RefreshCw className="mr-2 size-4" />
            Try again
          </Button>
        </div>
      </main>
    );
  }

  if (!status.hasToken || !status.chatConnected || showConnect) {
    return (
      <ConnectPanel
        status={status}
        connected={status.hasToken && status.chatConnected}
        onConnected={handleConnected}
        onBack={
          status.hasToken && status.chatConnected
            ? () => setShowConnect(false)
            : undefined
        }
      />
    );
  }

  const sidebar = (
    <SidebarBody
      tree={tree}
      activeId={activeId}
      activePathIds={activePathIds}
      status={status}
      userLabel={user?.email ?? user?.name ?? "Signed in"}
      onSelect={(id) => navigateTo(id)}
      onNewFolder={() => setDialog({ kind: "newFolder" })}
      onRename={(folder) => setDialog({ kind: "renameFolder", folder })}
      onMove={(folder) => setDialog({ kind: "moveFolder", folder })}
      onDelete={(folder) => setDialog({ kind: "deleteFolder", folder })}
      onChangeBot={() => setShowConnect(true)}
      onSignOut={handleSignOut}
    />
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sheet>
        <aside className="hidden w-[264px] shrink-0 border-r border-sidebar-border bg-sidebar lg:block">
          {sidebar}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-border/70 bg-background/85 px-4 py-3 backdrop-blur sm:px-5">
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 lg:hidden"
                aria-label="Open folder list"
              >
                <Menu className="size-4" />
              </Button>
            </SheetTrigger>

            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
            >
              <button
                type="button"
                onClick={() => navigateTo(null)}
                className={cn(
                  "max-w-[10rem] truncate rounded-md px-1.5 py-1 transition-colors hover:bg-accent",
                  activeId === null
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                All files
              </button>
              {activePath.map((folder, index) => (
                <Fragment key={folder._id}>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                  {index === activePath.length - 1 ? (
                    <span className="max-w-[14rem] truncate px-1.5 py-1 font-medium text-foreground">
                      {folder.name}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => navigateTo(folder._id)}
                      className="max-w-[14rem] truncate rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {folder.name}
                    </button>
                  )}
                </Fragment>
              ))}
            </nav>

            <span className="hidden font-mono-nums text-xs text-muted-foreground md:block">
              {childFolders.length} {childFolders.length === 1 ? "folder" : "folders"} ·{" "}
              {listedFiles.length} {listedFiles.length === 1 ? "file" : "files"}
            </span>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialog({ kind: "newFolder" })}
            >
              <FolderPlus className="mr-2 size-4" />
              <span className="hidden sm:inline">New folder</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => { const player = window.open(`${window.location.origin}/music`, "telegram-vault-music", "popup=yes,width=460,height=820,resizable=yes,scrollbars=yes"); if (!player) navigate("/music"); else player.focus(); }}>
              <Headphones className="mr-2 size-4" />
              <span className="hidden sm:inline">Music</span>
            </Button>
            <Button size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload className="mr-2 size-4" />
              Upload
            </Button>
          </header>

          <main
            ref={mainRef}
            className="relative flex-1 overflow-y-auto"
            onDragOver={(event) => {
              if (!Array.from(event.dataTransfer.types).includes("Files")) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null))
                return;
              setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void ingest(event.dataTransfer.files);
            }}
          >
            <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-5 sm:px-6">
              <UploadQueue uploads={uploads} onDismiss={dismissUpload} />

              {notFound ? (
                <div className="rounded-xl border border-border/70 bg-card px-6 py-16 text-center shadow-card">
                  <p className="text-base font-medium tracking-[-0.01em]">
                    That folder is gone
                  </p>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                    It was deleted, or the link pointed somewhere that never
                    existed.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-5"
                    onClick={() => navigateTo(null)}
                  >
                    Back to all files
                  </Button>
                </div>
              ) : !foldersReady || files === undefined ? (
                <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4 shadow-card">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-11 w-full" />
                  ))}
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-card">
                  <FileList
                    folders={childFolders}
                    files={listedFiles}
                    downloads={downloads}
                    onOpenFolder={navigateTo}
                    onOpen={(file) => setViewerFileId(file._id)}
                    onDownload={handleDownload}
                    onNewFolder={() => setDialog({ kind: "newFolder" })}
                    onUpload={() => fileInputRef.current?.click()}
                    onRenameFolder={(folder) =>
                      setDialog({ kind: "renameFolder", folder })
                    }
                    onMoveFolder={(folder) =>
                      setDialog({ kind: "moveFolder", folder })
                    }
                    onDeleteFolder={(folder) =>
                      setDialog({ kind: "deleteFolder", folder })
                    }
                    onRenameFile={(file) => setDialog({ kind: "renameFile", file })}
                    onMoveFile={(file) => setDialog({ kind: "moveFile", file })}
                    onDeleteFile={(file) => setDialog({ kind: "deleteFile", file })}
                  />
                </div>
              )}

              <p className="pb-2 text-center text-xs text-muted-foreground">
                Stored in your Telegram chat · parts of {Math.round(CHUNK_BYTES / (1024 * 1024))} MB
                {activeFolder ? ` · inside “${activeFolder.name}”` : ""}
              </p>
            </div>

            {dragging ? (
              <div
                className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--brand)] backdrop-blur-[2px]"
                style={{
                  backgroundColor:
                    "color-mix(in oklab, var(--brand-soft) 85%, transparent)",
                }}
              >
                <p className="flex items-center gap-2 text-sm font-medium text-[var(--brand-soft-foreground)]">
                  <Upload className="size-4" />
                  Drop to upload to {activeFolder ? activeFolder.name : "All files"}
                </p>
              </div>
            ) : null}
          </main>
        </div>

        <SheetContent side="left" className="w-[280px] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Folders</SheetTitle>
          </SheetHeader>
          <div className="h-full">{sidebar}</div>
        </SheetContent>
      </Sheet>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          void ingest(event.target.files ?? []);
          event.target.value = "";
        }}
      />

      {/* Dialogs */}
      <NameDialog
        open={dialog?.kind === "newFolder"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="New folder"
        description={`Created in ${activeFolder ? `“${activeFolder.name}”` : "All files"}.`}
        placeholder="Projects"
        submitLabel="Create folder"
        onSubmit={handleCreateFolder}
      />

      <NameDialog
        open={dialog?.kind === "renameFolder"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Rename folder"
        initialValue={
          dialog?.kind === "renameFolder" ? dialog.folder.name : ""
        }
        placeholder="Folder name"
        submitLabel="Save name"
        onSubmit={async (name) => {
          if (dialog?.kind !== "renameFolder") return;
          await renameFolder({ folderId: dialog.folder._id, name });
          toast.success("Folder renamed");
        }}
      />

      <NameDialog
        open={dialog?.kind === "renameFile"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Rename file"
        initialValue={dialog?.kind === "renameFile" ? dialog.file.name : ""}
        placeholder="File name"
        submitLabel="Save name"
        onSubmit={async (name) => {
          if (dialog?.kind !== "renameFile") return;
          await renameFileMutation({ fileId: dialog.file._id, name });
          toast.success("File renamed");
        }}
      />

      <MoveDialog
        open={dialog?.kind === "moveFolder"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        folders={folders ?? []}
        currentParentId={
          dialog?.kind === "moveFolder" ? dialog.folder.parentId : null
        }
        excluded={
          dialog?.kind === "moveFolder"
            ? subtreeIds(folders ?? [], dialog.folder._id)
            : new Set<string>()
        }
        title="Move folder"
        description="Pick a destination for this folder and everything inside it."
        onSubmit={async (target) => {
          if (dialog?.kind !== "moveFolder") return;
          await moveFolderMutation({
            folderId: dialog.folder._id,
            parentId: target,
          });
          toast.success("Folder moved");
        }}
      />

      <MoveDialog
        open={dialog?.kind === "moveFile"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        folders={folders ?? []}
        currentParentId={
          dialog?.kind === "moveFile" ? dialog.file.folderId : null
        }
        title="Move file"
        description="Pick the folder this file should live in."
        onSubmit={async (target) => {
          if (dialog?.kind !== "moveFile") return;
          await moveFileMutation({ fileId: dialog.file._id, folderId: target });
          toast.success("File moved");
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === "deleteFolder"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={
          dialog?.kind === "deleteFolder"
            ? `Delete “${dialog.folder.name}”?`
            : "Delete folder?"
        }
        description="This folder, every folder inside it, and all of their files leave the vault. The copies in your Telegram chat go too."
        confirmLabel="Delete folder"
        onConfirm={async () => {
          if (dialog?.kind !== "deleteFolder") return;
          await handleDeleteFolder(dialog.folder);
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === "deleteFile"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={
          dialog?.kind === "deleteFile" ? `Delete “${dialog.file.name}”?` : "Delete file?"
        }
        description="The file is removed from the vault and its parts are deleted from your Telegram chat."
        confirmLabel="Delete file"
        onConfirm={async () => {
          if (dialog?.kind !== "deleteFile") return;
          await handleDeleteFile(dialog.file);
        }}
      />

      <FileViewer
        file={viewerFile}
        onClose={() => setViewerFileId(null)}
        onDownload={handleDownload}
      />
    </div>
  );
}

function SidebarBody({
  tree,
  activeId,
  activePathIds,
  status,
  userLabel,
  onSelect,
  onNewFolder,
  onRename,
  onMove,
  onDelete,
  onChangeBot,
  onSignOut,
}: {
  tree: ReturnType<typeof buildTree>;
  activeId: Id<"folders"> | null;
  activePathIds: Set<string>;
  status: TelegramStatus;
  userLabel: string;
  onSelect: (id: Id<"folders"> | null) => void;
  onNewFolder: () => void;
  onRename: (folder: Doc<"folders">) => void;
  onMove: (folder: Doc<"folders">) => void;
  onDelete: (folder: Doc<"folders">) => void;
  onChangeBot: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-3 pt-4">
        <BrandWordmark />
      </div>

      <div className="px-3 pb-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start border-dashed"
          onClick={onNewFolder}
        >
          <FolderPlus className="mr-2 size-4" />
          New folder
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <FolderTree
          tree={tree}
          activeId={activeId}
          activePathIds={activePathIds}
          onSelect={onSelect}
          onRename={onRename}
          onMove={onMove}
          onDelete={onDelete}
        />
      </div>

      <div className="space-y-2.5 border-t border-sidebar-border p-3">
        <div className="rounded-lg bg-[var(--brand-soft)] px-3 py-2.5">
          <p className="flex items-center gap-2 text-xs font-medium text-[var(--brand-soft-foreground)]">
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            <span className="truncate">
              @{status.botUsername ?? "bot"} connected
            </span>
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            Storing in {status.chatTitle ?? "your Telegram chat"}
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 px-1">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {userLabel}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onChangeBot}
            >
              Change bot
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label="Sign out"
              onClick={onSignOut}
            >
              <LogOut className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function VaultLoading() {
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <aside className="hidden w-[264px] shrink-0 space-y-4 border-r border-border/70 bg-sidebar p-4 lg:block">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-full" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-11/12" />
          <Skeleton className="h-7 w-4/5" />
        </div>
      </aside>
      <div className="flex-1 space-y-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4 shadow-card">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-11 w-full" />
          ))}
        </div>
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Opening your vault…
        </div>
      </div>
    </div>
  );
}
