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
 * Everything that moves bytes: two indexed upload workers run concurrently;
 * downloads stream part by part.
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

    let confirmedBytes = 0;
    let estimatedLoaded = 0;
    const inFlightProgress = new Map<number, number>();
    const reportProgress = () => {
      const activeBytes = [...inFlightProgress.values()].reduce((sum, value) => sum + value, 0);
      estimatedLoaded = Math.max(
        estimatedLoaded,
        Math.min(file.size, confirmedBytes + activeBytes),
      );
      onPatch({ loaded: estimatedLoaded });
    };
    try {
      // Two workers send independently. Every part carries its immutable
      // zero-based index; the backend stores handles by index and assembles
      // the final ordered array only after every index has arrived.
      const uploadPart = async (index: number) => {
        const start = index * CHUNK_BYTES;
        const slice = file.slice(start, Math.min(start + CHUNK_BYTES, file.size));
        onPatch({ phase: "uploading", chunkIndex: index });

        const uploadUrl = await getChunkUploadUrl({ fileId, index });
        const storageId = await postSlice(uploadUrl, slice, (loaded) => {
          inFlightProgress.set(index, Math.min(loaded, slice.size));
          onPatch({ phase: "uploading", chunkIndex: index });
          reportProgress();
        });

        onPatch({ phase: "storing", chunkIndex: index });
        inFlightProgress.set(index, slice.size);
        reportProgress();
        await sendChunk({ fileId, index, storageId });

        inFlightProgress.delete(index);
        confirmedBytes += slice.size;
        reportProgress();
      };

      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < chunkCount) {
          const index = nextIndex++;
          await uploadPart(index);
        }
      };
      const concurrency = Math.min(2, chunkCount);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

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
