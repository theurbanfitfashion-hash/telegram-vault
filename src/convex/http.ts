import { httpRouter } from "convex/server";
import { mimeForFile } from "../lib/mime";
import { auth } from "./auth";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

auth.addHttpRoutes(http);

/**
 * The app runs on a different origin than the Convex deployment, so every
 * response coming off this router carries permissive CORS headers. Responses
 * only ever contain bytes the caller already unlocked with a download token.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Disposition",
};

/** Types that can run code if opened as a document; they get a sandbox. */
const ACTIVE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
]);

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** `filename*` encoding (RFC 5987), including what encodeURIComponent spares. */
function filenameStar(fileName: string): string {
  return encodeURIComponent(fileName).replace(
    /['()!*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Inline rendering with an ASCII fallback name — the browser decides what a
 * PDF or a video means instead of being told to save it.
 */
function inlineDisposition(fileName: string): string {
  const ascii = fileName
    .replace(/[^\u0020-\u007e]/g, "_")
    .replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${filenameStar(fileName)}`;
}

/**
 * Resolves one part's Telegram handle and opens its byte stream. `file_path`
 * is only guaranteed fresh for an hour, so ask for it on every use.
 */
async function openPart(
  botToken: string,
  telegramFileId: string,
): Promise<ReadableStream<Uint8Array>> {
  const metaResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(
      telegramFileId,
    )}`,
  );
  const meta = (await metaResponse.json().catch(() => null)) as {
    ok?: boolean;
    result?: { file_path?: string };
    description?: string;
  } | null;
  if (!metaResponse.ok || !meta?.ok || !meta.result?.file_path) {
    throw new Error(
      meta?.description ?? `Telegram getFile failed (HTTP ${metaResponse.status}).`,
    );
  }
  const upstream = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`,
  );
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Telegram file download failed (HTTP ${upstream.status}).`);
  }
  return upstream.body;
}

type ByteRange = { start: number; end: number };

/**
 * Single-range parsing per RFC 7233. Returns null for "no range / a form we
 * don't handle" (serve the whole file), or "unsatisfiable" for 416.
 */
function parseRangeHeader(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // Suffix form: `bytes=-500` means the last 500 bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return "unsatisfiable";
  if (start >= size) return "unsatisfiable";
  if (rawEnd === "") return { start, end: size - 1 };

  const requestedEnd = Number(rawEnd);
  if (!Number.isSafeInteger(requestedEnd) || start > requestedEnd) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** Keeps only `take` bytes of `source`, dropping `skip` bytes up front. */
function takeBytes(
  source: ReadableStream<Uint8Array>,
  skip: number,
  take: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let skipped = 0;
  let remaining = take;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (remaining <= 0) {
          controller.close();
          await reader.cancel().catch(() => {});
          return;
        }
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        let chunk = value;
        if (skipped < skip) {
          const drop = Math.min(skip - skipped, chunk.byteLength);
          skipped += drop;
          chunk = chunk.subarray(drop);
        }
        if (chunk.byteLength === 0) continue;
        if (chunk.byteLength > remaining) chunk = chunk.subarray(0, remaining);
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
        if (remaining <= 0) {
          controller.close();
          await reader.cancel().catch(() => {});
        }
        return;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/**
 * Serves the requested byte window by walking only the parts it touches. The
 * next part's fetch starts while the current one streams, so playback never
 * waits on a round trip it could have hidden.
 */
function streamRange(
  partIds: string[],
  chunkBytes: number,
  botToken: string,
  start: number,
  end: number,
  size: number,
  firstStream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const openers = new Map<number, Promise<ReadableStream<Uint8Array>>>();
  // Open the first Telegram part before sending HTTP headers. This lets the
  // route return a useful 502 response instead of a browser "Failed to fetch".
  const firstIndex = Math.min(Math.floor(start / chunkBytes), partIds.length - 1);
  openers.set(firstIndex, Promise.resolve(firstStream));
  const open = (index: number) => {
    let pending = openers.get(index);
    if (!pending) {
      pending = openPart(botToken, partIds[index]);
      openers.set(index, pending);
      // A prefetched part may go unread if the client stops early.
      pending.catch(() => {});
    }
    return pending;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let cursor = start;
        while (cursor <= end) {
          const index = Math.min(
            Math.floor(cursor / chunkBytes),
            partIds.length - 1,
          );
          const partStart = index * chunkBytes;
          const partEnd = Math.min(partStart + chunkBytes, size) - 1;
          const take = Math.min(end, partEnd) - cursor + 1;
          if (index + 1 < partIds.length) void open(index + 1);

          const slice = takeBytes(await open(index), cursor - partStart, take);
          const reader = slice.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          cursor += take;
        }
        controller.close();
      } catch (error) {
        // Headers are already out; dropping the stream surfaces as a failed
        // load rather than a silently truncated file.
        controller.error(error);
      }
    },
  });
}

/**
 * `GET /file/:token` — the whole file as one real, browser-viewable resource.
 *
 * Parts, not whole files, live in Telegram, but the browser never sees that:
 * this route concatenates them on the way out with the correct type, length
 * and range support, so an `<img>`, `<video>`, or PDF viewer can load it the
 * same way it would load any other URL — including seeking, which is why the
 * byte window of a range request maps straight onto the parts it covers.
 */
const downloadWhole = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const { pathname } = url;
    const [, route, token] = pathname.split("/");
    if (route !== "file" || !token) return textResponse(404, "Not found");
  
    const file = await ctx.runQuery(internal.vault.resolveWholeFile, { token });
    if (!file) return textResponse(410, "This download link has expired.");
  
    const contentType = mimeForFile(file.fileName, file.mimeType);
    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Content-Disposition": url.searchParams.get("download") === "1"
        ? attachmentDisposition(file.fileName)
        : inlineDisposition(file.fileName),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
    };
    if (ACTIVE_TYPES.has(contentType)) {
      // HTML/SVG/XML opened as a document stay inert — no scripts, no forms.
      headers["Content-Security-Policy"] = "sandbox";
    }
  
    if (file.size === 0 || file.partIds.length === 0) {
      headers["Content-Length"] = "0";
      return new Response(null, { status: 200, headers });
    }
  
    const range = parseRangeHeader(request.headers.get("Range"), file.size);
    if (range === "unsatisfiable") {
      return new Response("Requested range not satisfiable.", {
        status: 416,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Range": `bytes */${file.size}`,
          "Cache-Control": "no-store",
        },
      });
    }
  
    const start = range ? range.start : 0;
    const end = range ? range.end : file.size - 1;
    headers["Content-Length"] = String(end - start + 1);
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
  
    // Resolve the first part before committing the response. Previously a
    // Telegram error occurred inside the response stream after status 200 had
    // already been sent, which browsers report only as "Failed to fetch".
    const firstIndex = Math.min(
      Math.floor(start / file.chunkBytes),
      file.partIds.length - 1,
    );
    let firstStream: ReadableStream<Uint8Array>;
    try {
      firstStream = await openPart(file.botToken, file.partIds[firstIndex]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown Telegram error.";
      return textResponse(502, detail);
    }
  
    const stream = streamRange(
      file.partIds,
      file.chunkBytes,
      file.botToken,
      start,
      end,
      file.size,
      firstStream,
    );
    return new Response(stream, { status: range ? 206 : 200, headers });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unexpected file server error.";
    return textResponse(500, detail);
  }
});

/**
 * `GET /file/:token/:index` — streams one 18 MB part, kept for the download
 * loop in the app, which writes part by part so large saves stream straight
 * to disk instead of assembling in memory.
 */
const downloadPart = httpAction(async (ctx, request) => {
  const { pathname } = new URL(request.url);
  const [, route, token, indexPart] = pathname.split("/");
  if (route !== "file" || !token) return textResponse(404, "Not found");

  const index = Number(indexPart);
  if (!Number.isInteger(index) || index < 0) {
    return textResponse(400, "Bad part index");
  }

  const part = await ctx.runQuery(internal.vault.resolveDownload, {
    token,
    index,
  });
  if (!part) {
    return textResponse(410, "This download link has expired.");
  }

  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await openPart(part.botToken, part.telegramFileId);
  } catch {
    return textResponse(502, "Telegram could not serve this file.");
  }

  return new Response(upstream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="part-${index}"`,
      "Cache-Control": "private, max-age=0",
    },
  });
});

const healthCheck = httpAction(async () => {
  return new Response("telegram-vault-file-endpoint-ok", {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});

const corsPreflight = httpAction(async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
});

http.route({ path: "/health", method: "GET", handler: healthCheck });
http.route({ path: "/health", method: "OPTIONS", handler: corsPreflight });

// Convex supports exact paths and path prefixes, not Express-style ":param"
// segments. Match /file/ and parse token/index in the handlers above.
http.route({ pathPrefix: "/file/", method: "GET", handler: downloadWhole });
http.route({ pathPrefix: "/file/", method: "OPTIONS", handler: corsPreflight });

export default http;
