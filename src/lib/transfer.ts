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
  phase: "uploading" | "storing" | "done" | "error";
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

/** POSTs one part straight into Convex storage, reporting byte progress. */
function postSlice(
  url: string,
  slice: Blob,
  onLoaded: (loaded: number) => void,
): Promise<Id<"_storage">> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader(
      "Content-Type",
      slice.type || "application/octet-stream",
    );
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onLoaded(event.loaded);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          const { storageId } = JSON.parse(request.responseText) as {
            storageId: string;
          };
          resolve(storageId as Id<"_storage">);
        } catch {
          reject(new Error("The upload finished with an unexpected response."));
        }
      } else {
        reject(new Error(`Storage rejected the upload (${request.status}).`));
      }
    };
    request.onerror = () =>
      reject(new Error("Network error while uploading — check your connection."));
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
 * Everything that moves bytes: parts are uploaded one at a time (which keeps
 * Telegram's per-chat pacing happy) and downloads stream back part by part.
 */
export function useTransfer() {
  const createFile = useMutation(api.vault.createFile);
  const getChunkUploadUrl = useMutation(api.vault.getChunkUploadUrl);
  const finishUpload = useMutation(api.vault.finishUpload);
  const createDownloadToken = useMutation(api.vault.createDownloadToken);
  const sendChunk = useAction(api.telegram.sendChunk);
  const removeFile = useAction(api.telegram.removeFile);

  async function uploadFile({
    file,
    folderId,
    onPatch,
  }: {
    file: File;
    folderId: Id<"folders"> | null;
    onPatch: (patch: UploadPatch) => void;
  }): Promise<Id<"files">> {
    const name = file.name.slice(0, MAX_NAME_LENGTH) || "untitled";
    const { fileId, chunkCount } = await createFile({
      name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      folderId,
    });
    onPatch({ fileId, name, size: file.size, chunkCount });

    let confirmed = 0;
    let reportedLoaded = 0;
    const reportLoaded = (loaded: number) => {
      reportedLoaded = Math.max(reportedLoaded, Math.min(loaded, file.size));
      onPatch({ loaded: reportedLoaded });
    };
    try {
      // Upload the next part to temporary Convex storage while the previous
      // part is being forwarded to Telegram. Telegram sends remain sequential
      // to respect per-chat rate limits and preserve the ordered parts list.
      const prepareChunk = async (index: number) => {
        const start = index * CHUNK_BYTES;
        const slice = file.slice(start, Math.min(start + CHUNK_BYTES, file.size));
        const baseLoaded = start;
        onPatch({ phase: "uploading", chunkIndex: index, loaded: reportedLoaded });

        const uploadUrl = await getChunkUploadUrl({ fileId, index });
        const storageId = await postSlice(uploadUrl, slice, (loaded) =>
          onPatch({ phase: "uploading", chunkIndex: index });
          reportLoaded(baseLoaded + Math.min(loaded, slice.size));
        );
        return { index, slice, storageId };
      };

      let current = chunkCount > 0 ? await prepareChunk(0) : null;
      while (current) {
        // Keep at most one additional 18 MiB part in flight. This overlaps
        // client-to-Convex transfer with the server-to-Telegram transfer
        // without creating an unbounded queue on mobile connections.
        const next = current.index + 1 < chunkCount
          ? prepareChunk(current.index + 1)
          : null;

        onPatch({
          phase: "storing",
          chunkIndex: current.index,
          loaded: reportedLoaded,
        });
        reportLoaded(current.index * CHUNK_BYTES + current.slice.size);
        await sendChunk({
          fileId,
          index: current.index,
          storageId: current.storageId,
        });
        confirmed += current.slice.size;
        reportLoaded(confirmed);

        current = next ? await next : null;
      }

      await finishUpload({ fileId });
      onPatch({ phase: "done", loaded: file.size });
      return fileId;
    } catch (error) {
      // Never leave a half-written record (or its parts) behind.
      await removeFile({ fileId }).catch(() => {});
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
