interface Env {
  CONVEX_SITE_URL: string;
  TRANSFER_WORKER_SECRET: string;
  APP_ORIGIN: string;
}

const MAX_CHUNK_BYTES = 18 * 1024 * 1024;
const encoder = new TextEncoder();

function json(status: number, value: unknown, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

function corsHeaders(origin: string | null, env: Env): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Disposition",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin && origin === env.APP_ORIGIN) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function withCors(response: Response, origin: string | null, env: Env): Response {
  const headers = new Headers(response.headers);
  corsHeaders(origin, env).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function convexPost<T>(env: Env, path: string, body: unknown): Promise<T> {
  const response = await fetch(new URL(path, env.CONVEX_SITE_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-transfer-worker-secret": env.TRANSFER_WORKER_SECRET,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null) as T | { error?: string } | null;
  if (!response.ok) {
    const message = result && typeof result === "object" && "error" in result
      ? String(result.error)
      : "Convex transfer authorization failed";
    throw new Error(message);
  }
  return result as T;
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([a-f0-9]{48})$/.exec(value);
  return match?.[1] ?? null;
}

function safeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_").slice(0, 200) || "upload.bin";
}

interface UploadAuthorization {
  botToken: string;
  chatId: string;
  fileName: string;
  index: number;
  chunkCount: number;
}

interface TelegramMessage {
  message_id: number;
  document?: { file_id?: string };
  audio?: { file_id?: string };
  video?: { file_id?: string };
  animation?: { file_id?: string };
  voice?: { file_id?: string };
  video_note?: { file_id?: string };
  photo?: Array<{ file_id?: string }>;
}

function multipartStream(
  body: ReadableStream<Uint8Array>,
  chatId: string,
  filename: string,
  boundary: string,
): ReadableStream<Uint8Array> {
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="disable_notification"\r\n\r\ntrue\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeFilename(filename)}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = body.getReader();
  let phase: 0 | 1 | 2 | 3 = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (phase === 0) {
          phase = 1;
          controller.enqueue(prefix);
          return;
        }
        if (phase === 1) {
          const next = await reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          phase = 2;
        }
        if (phase === 2) {
          phase = 3;
          controller.enqueue(suffix);
          return;
        }
        controller.close();
        reader.releaseLock();
      } catch (error) {
        controller.error(error);
        await reader.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

async function upload(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return json(401, { error: "Upload authorization is missing." });
  if (!request.body) return json(400, { error: "Upload body is missing." });

  const length = Number(request.headers.get("Content-Length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_CHUNK_BYTES) {
    return json(413, { error: "Each upload part must be between 1 byte and 18 MB." });
  }

  const authorization = await convexPost<UploadAuthorization>(
    env,
    "/transfer/upload/authorize",
    { token },
  );
  if (!authorization.botToken || !authorization.chatId) {
    return json(409, { error: "Connect and verify your Telegram chat before uploading." });
  }

  const boundary = `----TelegramVault${crypto.randomUUID().replace(/-/g, "")}`;
  const body = multipartStream(request.body, authorization.chatId, 
    authorization.chunkCount > 1
      ? `${authorization.fileName}.part${String(authorization.index + 1).padStart(4, "0")}`
      : authorization.fileName,
    boundary,
  );
  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${authorization.botToken}/sendDocument`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    },
  );
  const telegramResult = await telegramResponse.json().catch(() => null) as
    | { ok?: boolean; result?: TelegramMessage; description?: string }
    | null;
  if (!telegramResponse.ok || !telegramResult?.ok || !telegramResult.result) {
    return json(502, {
      error: telegramResult?.description ?? `Telegram upload failed (HTTP ${telegramResponse.status}).`,
    });
  }

  const message = telegramResult.result;
  const telegramFileId =
    message.document?.file_id ??
    message.audio?.file_id ??
    message.video?.file_id ??
    message.animation?.file_id ??
    message.voice?.file_id ??
    message.video_note?.file_id ??
    message.photo?.[message.photo.length - 1]?.file_id;
  if (!telegramFileId || !Number.isSafeInteger(message.message_id)) {
    return json(502, { error: "Telegram did not return a usable file reference." });
  }

  await convexPost(env, "/transfer/upload/complete", {
    token,
    telegramFileId,
    messageId: message.message_id,
  });
  return json(200, { ok: true, index: authorization.index });
}

interface DownloadAuthorization {
  botToken: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunkBytes: number;
  partIds: string[];
}

async function resolveDownload(env: Env, token: string): Promise<DownloadAuthorization> {
  return convexPost<DownloadAuthorization>(
    env,
    "/transfer/download/resolve",
    { token },
  );
}

async function telegramPartStream(botToken: string, fileId: string): Promise<ReadableStream<Uint8Array>> {
  const metaResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  const meta = await metaResponse.json().catch(() => null) as
    | { ok?: boolean; result?: { file_path?: string }; description?: string }
    | null;
  if (!metaResponse.ok || !meta?.ok || !meta.result?.file_path) {
    throw new Error(meta?.description ?? "Telegram could not locate this file part.");
  }
  const fileResponse = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`,
  );
  if (!fileResponse.ok || !fileResponse.body) {
    throw new Error(`Telegram file download failed (HTTP ${fileResponse.status}).`);
  }
  return fileResponse.body;
}

type ByteRange = { start: number; end: number };

function parseRange(header: string | null, size: number): ByteRange | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

function fileStream(
  file: DownloadAuthorization,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let index = Math.floor(start / file.chunkBytes);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let skip = start - index * file.chunkBytes;
  let remaining = end - start + 1;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (remaining > 0) {
          if (!reader) {
            if (index >= file.partIds.length) {
              controller.error(new Error("The stored file is missing a part."));
              return;
            }
            const part = await telegramPartStream(file.botToken, file.partIds[index]);
            reader = part.getReader();
          }
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            reader = null;
            index += 1;
            skip = 0;
            continue;
          }
          let bytes = next.value;
          if (skip > 0) {
            const skipped = Math.min(skip, bytes.byteLength);
            skip -= skipped;
            bytes = bytes.subarray(skipped);
          }
          if (bytes.byteLength === 0) continue;
          const output = bytes.subarray(0, remaining);
          remaining -= output.byteLength;
          controller.enqueue(output);
          if (remaining === 0) {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
            reader = null;
            controller.close();
          }
          return;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
        await reader?.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason).catch(() => {});
    },
  });
}

function disposition(name: string, attachment: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()!*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${attachment ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function download(request: Request, env: Env, token: string, index?: number): Promise<Response> {
  const file = await resolveDownload(env, token);
  if (index !== undefined) {
    if (!Number.isInteger(index) || index < 0 || index >= file.partIds.length) {
      return new Response("Part not found", { status: 404 });
    }
    const body = await telegramPartStream(file.botToken, file.partIds[index]);
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="part-${index}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  if (file.size === 0 || file.partIds.length === 0) {
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": file.mimeType || "application/octet-stream",
        "Content-Length": "0",
        "Content-Disposition": disposition(file.fileName, new URL(request.url).searchParams.get("download") === "1"),
        "Cache-Control": "private, no-store",
      },
    });
  }
  const range = parseRange(request.headers.get("Range"), file.size);
  if (range === "invalid") {
    return new Response("Requested range not satisfiable.", {
      status: 416,
      headers: { "Content-Range": `bytes */${file.size}`, "Cache-Control": "no-store" },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? file.size - 1;
  const attachment = new URL(request.url).searchParams.get("download") === "1";
  const headers = new Headers({
    "Content-Type": file.mimeType || "application/octet-stream",
    "Content-Disposition": disposition(file.fileName, attachment),
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
  return new Response(fileStream(file, start, end), {
    status: range ? 206 : 200,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && origin !== env.APP_ORIGIN) {
      return withCors(json(403, { error: "Origin not allowed." }), origin, env);
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return withCors(json(200, { ok: true, service: "telegram-transfer" }), origin, env);
    }

    try {
      if (url.pathname === "/upload" && request.method === "POST") {
        return withCors(await upload(request, env), origin, env);
      }
      if (url.pathname.startsWith("/file/") && request.method === "GET") {
        const [, , token, rawIndex] = url.pathname.split("/");
        if (!token || !/^[a-f0-9]{48}$/.test(token)) {
          return withCors(new Response("Invalid download link", { status: 400 }), origin, env);
        }
        const index = rawIndex === undefined ? undefined : Number(rawIndex);
        return withCors(await download(request, env, token, index), origin, env);
      }
      return withCors(new Response("Not found", { status: 404 }), origin, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transfer failed.";
      console.error(JSON.stringify({ event: "transfer_error", path: url.pathname, message }));
      return withCors(json(502, { error: message }), origin, env);
    }
  },
};
