import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import { convexSiteUrl } from "@/lib/convex-site";
import { errorMessage } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { viewerKind, type ViewerKind } from "@/lib/mime";
import { cn } from "@/lib/utils";
import { useMutation } from "convex/react";
import {
  AlertCircle,
  Download,
  ExternalLink,
  File as FileIcon,
  FileCode,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ListedFile } from "./FileList";

/**
 * Largest text file the viewer reads into the pane; bigger ones open in a new
 * tab or save to disk instead of being pulled through the tab's memory.
 */
const TEXT_RENDER_LIMIT = 2 * 1024 * 1024;


const KIND_ICON: Record<ViewerKind, LucideIcon> = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  pdf: FileText,
  text: FileCode,
  other: FileIcon,
};

const KIND_LABEL: Record<ViewerKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF document",
  text: "Text",
  other: "File",
};

function Working({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

function InfoPanel({
  icon,
  title,
  detail,
  children,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
        {icon}
      </span>
      <div className="space-y-1.5">
        <p className="text-base font-medium tracking-[-0.01em]">{title}</p>
        <p className="mx-auto max-w-sm text-sm leading-6 text-muted-foreground">
          {detail}
        </p>
      </div>
      {children ? (
        <div className="flex flex-wrap justify-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

/**
 * Opens a stored file the way a browser opens a file: an image is drawn, a
 * video plays with real seeking, a PDF renders in place, text is read — all
 * from one streamed URL that also works outside the app, in a new tab.
 *
 * One mount per viewing session: the parent keys this component, so every
 * state below starts fresh and the link is minted anew each time it opens.
 */
function ViewerSurface({
  file,
  onClose,
  onDownload,
}: {
  file: ListedFile;
  onClose: () => void;
  onDownload: (file: ListedFile) => void;
}) {
  const createDownloadToken = useMutation(api.vault.createDownloadToken);

  const [source, setSource] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const kind = viewerKind(file.name, file.mimeType);
  const renderText = kind === "text" && file.size <= TEXT_RENDER_LIMIT;

  useEffect(() => {
    let cancelled = false;
    createDownloadToken({ fileId: file._id })
      .then((token) => {
        const site = convexSiteUrl();
        if (!site) throw new Error("This deployment has no download endpoint.");
        if (!cancelled) setSource(`${site}/file/${token}`);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLinkError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [file._id, createDownloadToken]);

  useEffect(() => {
    if (!renderText || source === null) return;
    let cancelled = false;
    fetch(source)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`The server answered ${response.status}.`);
        }
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch((error: unknown) => {
        console.error(error);
        if (!cancelled) setBodyError("This file couldn't be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [renderText, source]);

  function openInNewTab() {
    if (source) window.open(source, "_blank", "noopener,noreferrer");
  }

  function renderBody(): ReactNode {
    if (linkError) {
      return (
        <InfoPanel
          icon={<AlertCircle className="size-6" />}
          title="Couldn't open this file"
          detail={linkError}
        >
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </InfoPanel>
      );
    }
    if (source === null) return <Working label="Opening file…" />;
    if (bodyError) {
      return (
        <InfoPanel
          icon={<AlertCircle className="size-6" />}
          title="Couldn't display this file"
          detail={bodyError}
        >
          <Button size="sm" variant="outline" onClick={openInNewTab}>
            <ExternalLink className="sm:mr-2 size-4" />
            <span className="hidden sm:inline">Open in new tab</span>
          </Button>
          <Button size="sm" onClick={() => onDownload(file)}>
            <Download className="sm:mr-2 size-4" />
            <span className="hidden sm:inline">Download</span>
          </Button>
        </InfoPanel>
      );
    }

    switch (kind) {
      case "image":
        return (
          <div className="relative flex h-full items-center justify-center overflow-hidden bg-muted/40 p-4">
            <img
              src={source ?? undefined}
              alt={file.name}
              className={cn(
                "max-h-full max-w-full object-contain transition-opacity duration-200",
                ready ? "opacity-100" : "opacity-0",
              )}
              onLoad={() => setReady(true)}
              onError={async () => {
                // An <img> error hides the HTTP status and response body.
                // Probe the same URL so the viewer can show the server error.
                try {
                  const response = await fetch(source);
                  if (!response.ok) {
                    const detail = await response.text().catch(() => "");
                    setBodyError(
                      "File server returned HTTP " + response.status +
                      (detail ? ": " + detail : "."),
                    );
                    return;
                  }
                  setBodyError("The server returned the file, but the browser could not decode it as an image.");
                } catch (error) {
                  setBodyError(
                    error instanceof Error
                      ? "Network/CORS error while requesting the file: " + error.message
                      : "Network/CORS error while requesting the file.",
                  );
                }
              }}
            />
            {!ready ? (
              <div className="absolute inset-0 grid place-items-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : null}
          </div>
        );

      case "video":
        return (
          <div className="flex h-full w-full items-center justify-center overflow-hidden bg-black p-2 sm:p-4">
            <video
              src={source}
              controls
              playsInline
              preload="metadata"
              className="max-h-full max-w-full"
              onError={() =>
                setBodyError("Your browser couldn't play this video. The video codec may not be supported.")
              }
            >
              Your browser does not support HTML5 video.
            </video>
          </div>
        );

      case "audio":
        return (
          <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
            <span className="grid size-16 place-items-center rounded-2xl bg-[var(--brand-soft)] text-[var(--brand-soft-foreground)]">
              <Music className="size-7" />
            </span>
            <div className="w-full max-w-md px-4">
              <audio
                src={source}
                controls
                className="w-full"
                onError={() =>
                  setBodyError("This audio couldn't be played in the browser.")
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.size)}
            </p>
          </div>
        );

      case "pdf":
        return (
          <iframe
            src={source}
            title={file.name}
            className="h-full w-full border-0 bg-white"
          />
        );

      case "text":
        if (!renderText) {
          return (
            <InfoPanel
              icon={<FileText className="size-6" />}
              title="Too large to open here"
              detail={`This text file is ${formatBytes(file.size)}. Open it in a new tab or save it instead.`}
            >
              <Button size="sm" variant="outline" onClick={openInNewTab}>
                <ExternalLink className="sm:mr-2 size-4" />
                <span className="hidden sm:inline">Open in new tab</span>
              </Button>
              <Button size="sm" onClick={() => onDownload(file)}>
                <Download className="sm:mr-2 size-4" />
                <span className="hidden sm:inline">Download</span>
              </Button>
            </InfoPanel>
          );
        }
        if (text === null) return <Working label="Reading file…" />;
        return (
          <div className="h-full overflow-auto bg-muted/30">
            <pre className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-foreground">
              {text}
            </pre>
          </div>
        );

      case "other":
      default:
        return (
          <InfoPanel
            icon={<FileIcon className="size-6" />}
            title="No in-browser viewer for this format"
            detail="It's stored as a real file — open it in a new tab and your browser decides what to do with it, or save it to your computer."
          >
            <Button size="sm" variant="outline" onClick={openInNewTab}>
              <ExternalLink className="sm:mr-2 size-4" />
              <span className="hidden sm:inline">Open in new tab</span>
            </Button>
            <Button size="sm" onClick={() => onDownload(file)}>
              <Download className="sm:mr-2 size-4" />
              <span className="hidden sm:inline">Download</span>
            </Button>
          </InfoPanel>
        );
    }
  }

  const Icon = KIND_ICON[kind];

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border/70 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand-soft-foreground)]">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate text-sm font-medium tracking-[-0.01em]">
            {file.name}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs">
            {KIND_LABEL[kind]} · {formatBytes(file.size)}
          </DialogDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!source}
          onClick={openInNewTab}
        >
          <ExternalLink className="sm:mr-2 size-4" />
          <span className="hidden sm:inline">New tab</span>
        </Button>
        <Button variant="outline" size="sm" onClick={() => onDownload(file)}>
          <Download className="sm:mr-2 size-4" />
          <span className="hidden sm:inline">Download</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label="Close viewer"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1">{renderBody()}</div>
    </>
  );
}

/** Dialog shell: holds the last file while the viewer animates out. */
export function FileViewer({
  file,
  onClose,
  onDownload,
}: {
  file: ListedFile | null;
  onClose: () => void;
  onDownload: (file: ListedFile) => void;
}) {
  const open = file !== null;

  const [held, setHeld] = useState<ListedFile | null>(null);
  if (file !== null && file !== held) setHeld(file);

  // A new session on every open — the key remounts the surface so each
  // viewing mints a fresh link instead of reusing one that may have expired.
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((value) => value + 1);
  }

  const shown = file ?? held;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(92dvh,54rem)] w-[min(98vw,72rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,72rem)]"
      >
        {shown ? (
          <ViewerSurface
            key={`${shown._id}:${session}`}
            file={shown}
            onClose={onClose}
            onDownload={onDownload}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
