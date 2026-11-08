import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { CHUNK_BYTES, MAX_NAME_LENGTH } from "./constants";
import { convexSiteUrl } from "./convex-site";

export interface UploadState {
  key: string;
  fileId: Id<"files"> | null;
  name: string;
  size: number;
  loaded: number;
  chunkIndex: number;
  chunkCount: number;
  workerIndex: number;
  workerCount: number;
  phase: "uploading" | "storing" | "done" | "error";
  resumed?: boolean;
  error?: string;
}

export type UploadPatch = Partial<Omit<UploadState, "key">>;

interface SaveFilePicker {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Uint8Array) => Promise<void>;
      close: () => Promise<void>;
      abort?: () => Promise<void>;
    }>;
  }>;
}

/** Sends one chunk directly to the protected Convex-to-Telegram endpoint. */
function postSlice(url: string, slice: Blob, onLoaded: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => { if (event.lengthComputable) onLoaded(event.loaded); };
    request.onload = () => request.status >= 200 && request.status < 300
      ? resolve()
      : reject(new Error(request.responseText || `Telegram upload failed (${request.status}).`));
    request.onerror = () => reject(new Error("Network error while uploading — check your connection."));
    request.onabort = () => reject(new Error("Upload interrupted."));
    request.send(slice);
  });
}

async function readErrorMessage(response: Response): Promise<string> {
  if (response.status === 410) return "That download link expired — try again.";
  const text = await response.text().catch(() => "");
  return text || `Request failed (${response.status}).`;
}

/**
 * Everything that moves bytes: up to three indexed upload workers run concurrently;
 * slower or data-saving connections use fewer workers; downloads stream part by part.
 */
export function useTransfer() {
  const createFile = useMutation(api.vault.createFile);
  const createDirectUploadToken = useMutation(api.vault.createDirectUploadToken);
  const finishUpload = useMutation(api.vault.finishUpload);
  const createDownloadToken = useMutation(api.vault.createDownloadToken);
  const removeFile = useAction(api.telegram.removeFile);

  async function uploadFile({
    file,
    folderId,
    onPatch,
  }: {
    file: File;
    folderId: Id<"folders"> | null;
    onPatch: (patch: UploadPatch, workerIndex: number) => void;
  }): Promise<Id<"files">> {
    const name = file.name.slice(0, MAX_NAME_LENGTH) || "untitled";
    const { fileId, chunkCount, uploadedIndexes, resumed } = await createFile({
      name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      folderId,
      sourceLastModified: file.lastModified,
    });
    const uploadToken = await createDirectUploadToken({ fileId });
    const uploadSite = convexSiteUrl();
    if (!uploadSite) throw new Error("This deployment has no upload endpoint.");
    const connection = (navigator as Navigator & {
      connection?: { effectiveType?: string; saveData?: boolean };
    }).connection;
    const effectiveType = connection?.effectiveType;
    // Keep three parallel part pipelines on ordinary connections.
    // The browser's "3g" estimate is frequently conservative on Wi-Fi/mobile
    // networks and was unnecessarily limiting uploads to two workers.
    const maxWorkers =
      connection?.saveData || effectiveType === "slow-2g" || effectiveType === "2g"
        ? 1
        : 3;
    const concurrency = Math.min(maxWorkers, chunkCount);
    const completed = new Set(uploadedIndexes);
    const confirmedBytes = Array.from({ length: concurrency }, (_, workerIndex) => {
      let total = 0;
      for (const index of completed) {
        if (index % concurrency === workerIndex) {
          total += Math.min(CHUNK_BYTES, file.size - index * CHUNK_BYTES);
        }
      }
      return total;
    });
    const estimatedLoaded = Array.from({ length: concurrency }, () => 0);
    const inFlightProgress = new Map<number, number>();
    const workerSize = (workerIndex: number) => {
      let total = 0;
      for (let index = workerIndex; index < chunkCount; index += concurrency) {
        total += Math.min(CHUNK_BYTES, file.size - index * CHUNK_BYTES);
      }
      return total;
    };
    for (let workerIndex = 0; workerIndex < concurrency; workerIndex++) {
      onPatch({
        fileId, name, size: workerSize(workerIndex), chunkCount,
        workerIndex, workerCount: concurrency, loaded: confirmedBytes[workerIndex], resumed,
      }, workerIndex);
    }
    const reportProgress = (workerIndex: number) => {
      const activeBytes = inFlightProgress.get(workerIndex) ?? 0;
      estimatedLoaded[workerIndex] = Math.max(
        estimatedLoaded[workerIndex],
        Math.min(workerSize(workerIndex), confirmedBytes[workerIndex] + activeBytes),
      );
      onPatch({ loaded: estimatedLoaded[workerIndex] }, workerIndex);
    };
    try {
      // Workers send independently. Every part carries its immutable
      // zero-based index; the backend stores handles by index and assembles
      // the final ordered array only after every index has arrived.
      const uploadPart = async (index: number, workerIndex: number) => {
        const start = index * CHUNK_BYTES;
        const slice = file.slice(start, Math.min(start + CHUNK_BYTES, file.size));
        onPatch({ phase: "uploading", chunkIndex: index }, workerIndex);

        let lastError: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await postSlice(`${uploadSite}/upload/${uploadToken}/${index}`, slice, (loaded) => {
              onPatch({ phase: "uploading", chunkIndex: index }, workerIndex);
              inFlightProgress.set(workerIndex, Math.min(loaded, slice.size));
              reportProgress(workerIndex);
            });
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : "";
            if (/Invalid part size|Invalid upload path|session expired|Telegram rejected/i.test(message) || attempt === 3) throw error;
            inFlightProgress.set(workerIndex, 0);
            await new Promise((resolve) => window.setTimeout(resolve, 1000 * 2 ** attempt));
          }
        }
        if (lastError) throw lastError;
        inFlightProgress.delete(workerIndex);
        confirmedBytes[workerIndex] += slice.size;
        reportProgress(workerIndex);
      };

      const worker = async (workerIndex: number) => {
        for (let index = workerIndex; index < chunkCount; index += concurrency) {
          if (completed.has(index)) continue;
          await uploadPart(index, workerIndex);
        }
      };
      const results = await Promise.allSettled(
        Array.from({ length: concurrency }, (_, workerIndex) => worker(workerIndex)),
      );
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;

      await finishUpload({ fileId });
      for (let workerIndex = 0; workerIndex < concurrency; workerIndex++) {
        onPatch({ phase: "done", loaded: workerSize(workerIndex) }, workerIndex);
      }
      return fileId;
    } catch (error) {
      // Keep completed Telegram parts indexed in Convex. Selecting the same
      // file again resumes at the missing indexes instead of starting over.
      throw error;
    }
  }

  async function downloadFile(
    file: Pick<Doc<"files">, "_id" | "name" | "mimeType" | "chunkCount" | "size">,
    onProgress: (done: number, total: number) => void,
  ): Promise<void> {
    const token = await createDownloadToken({ fileId: file._id });
    const site = convexSiteUrl();
    if (!site) throw new Error("This deployment has no download endpoint.");
    const downloadUrl = `${site}/file/${token}?download=1`;
    const partUrl = (index: number) => `${site}/file/${token}/${index}`;

    // Stream to a user-selected file where supported. Report real byte progress.
    const picker = (window as unknown as SaveFilePicker).showSaveFilePicker;
    if (typeof picker === "function") {
      let handle: Awaited<ReturnType<NonNullable<SaveFilePicker["showSaveFilePicker"]>>> | null = null;
      try {
        handle = await picker({ suggestedName: file.name });
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") throw error;
        // Browser refused the picker; use its native download manager instead.
      }

      if (handle) {
        const writable = await handle.createWritable();
        let loaded = 0;
        onProgress(0, file.size);
        try {
          for (let index = 0; index < file.chunkCount; index++) {
            const response = await fetch(partUrl(index));
            if (!response.ok || !response.body) {
              throw new Error(await readErrorMessage(response));
            }
            const reader = response.body.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              await writable.write(value);
              loaded += value.byteLength;
              onProgress(loaded, file.size);
            }
          }
          await writable.close();
          onProgress(file.size, file.size);
          return;
        } catch (error) {
          await writable.abort?.().catch(() => {});
          throw error;
        }
      }
    }

    // Mobile browsers (including Android Chrome variants) should own the
    // transfer: no giant in-memory Blob, and the file appears in Downloads.
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = file.name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    onProgress(0, 0); // Native browser UI owns byte-level progress.
  }

  /** Removes a file from the vault and, best effort, from the Telegram chat. */
  async function deleteFile(fileId: Id<"files">): Promise<void> {
    await removeFile({ fileId });
  }

  return { uploadFile, downloadFile, deleteFile };
}
