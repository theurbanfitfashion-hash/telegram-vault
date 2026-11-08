import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes, formatPercent } from "@/lib/format";
import type { UploadState } from "@/lib/transfer";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";

function statusLine(entry: UploadState): string {
  switch (entry.phase) {
    case "uploading":
      return entry.resumed && entry.loaded > 0
        ? `Resuming · part ${Math.min(entry.chunkIndex + 1, entry.chunkCount)} of ${entry.chunkCount}`
        : `Uploading part ${Math.min(entry.chunkIndex + 1, entry.chunkCount)} of ${entry.chunkCount}`;
    case "storing":
      return "Sending to Telegram…";
    case "done":
      return `Stored ${formatBytes(entry.size)}`;
    case "error":
      return entry.error ?? "Upload failed";
  }
}

/** The in-flight transfer queue: one row per file being written to Telegram. */
export function UploadQueue({
  uploads,
  onDismiss,
}: {
  uploads: UploadState[];
  onDismiss: (key: string) => void;
}) {
  if (uploads.length === 0) return null;

  const active = uploads.filter((entry) => entry.phase !== "error").length;

  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-card">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
        <p className="text-sm font-medium tracking-[-0.005em]">
          {active > 0 ? "Writing to Telegram" : "Transfers"}
        </p>
        <p className="font-mono-nums text-xs text-muted-foreground">
          {uploads.length} {uploads.length === 1 ? "file" : "files"}
        </p>
      </header>

      <ul className="divide-y divide-border/60">
        {uploads.map((entry) => {
          const percent = formatPercent(entry.loaded, entry.size);
          const failed = entry.phase === "error";
          return (
            <li key={entry.key} className="flex items-center gap-3 px-4 py-3">
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full",
                  failed
                    ? "bg-destructive/10 text-destructive"
                    : entry.phase === "done"
                      ? "bg-[var(--brand-soft)] text-[var(--brand-soft-foreground)]"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {failed ? (
                  <AlertTriangle className="size-4" />
                ) : entry.phase === "done" ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <Loader2 className="size-4 animate-spin" />
                )}
              </span>

              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate text-sm">{entry.name} <span className="text-muted-foreground">· Worker {entry.workerIndex + 1}</span></p>
                  <p
                    className={cn(
                      "shrink-0 font-mono-nums text-xs",
                      failed
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {failed
                      ? "failed"
                      : entry.phase === "done"
                        ? "100%"
                        : `${percent}%`}
                  </p>
                </div>
                {failed ? (
                  <p className="truncate text-xs text-destructive">
                    {statusLine(entry)}
                  </p>
                ) : (
                  <Progress
                    value={percent}
                    aria-label={`${entry.name} upload progress`}
                    className="h-1.5 bg-primary/15 [&_[data-slot=progress-indicator]]:bg-[var(--brand)]"
                  />
                )}
                <p className="truncate text-xs text-muted-foreground">
                  {failed ? "Saved parts kept — select this file again to resume" : statusLine(entry)}
                  {!failed && entry.size > 0
                    ? ` · ${formatBytes(entry.loaded)} / ${formatBytes(entry.size)}`
                    : ""}
                </p>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
                aria-label={`Dismiss ${entry.name}`}
                onClick={() => onDismiss(entry.key)}
              >
                <X className="size-4" />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
