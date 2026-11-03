import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import {
  CHUNK_BYTES,
  DOWNLOAD_TOKEN_TTL_MS,
  MAX_NAME_LENGTH,
} from "../lib/constants";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

/** Rejects anonymous callers with a message the UI can surface. */
async function requireUser(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  // ConvexError, not Error: production deployments redact plain error
  // messages to "Server Error"; this one is meant for the person clicking.
  if (userId === null) {
    throw new ConvexError("You need to sign in to do that.");
  }
  return userId;
}

/** Normalises user-supplied names: trimmed, flat, bounded. */
function cleanName(raw: string): string {
  const withoutControls = raw
    .split("")
    .filter((character) => character >= " " && character !== "\u007f")
    .join("");
  const cleaned = withoutControls.trim().replace(/[\\/]+/g, "-");
  if (!cleaned) throw new Error("Give it a name first.");
  if (cleaned.length > MAX_NAME_LENGTH) {
    throw new Error(`Names are limited to ${MAX_NAME_LENGTH} characters.`);
  }
  return cleaned;
}

/** Everything the client is allowed to see about a stored file. */
function toListed(file: Doc<"files">) {
  return {
    _id: file._id,
    _creationTime: file._creationTime,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    folderId: file.folderId,
    userId: file.userId,
    createdAt: file.createdAt,
    status: file.status,
    chunkCount: file.chunkCount,
  };
}

async function getOwnedFolder(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  folderId: Id<"folders">,
): Promise<Doc<"folders">> {
  const folder = await ctx.db.get(folderId);
  if (!folder || folder.userId !== userId || !("parentId" in folder)) {
    throw new Error("That folder no longer exists.");
  }
  return folder;
}

// ---------------------------------------------------------------------------
// Guest vault identity
// ---------------------------------------------------------------------------

/** Resolve a verified Telegram bot to one shared guest user across devices. */
export const resolveGuestBotVault = internalMutation({
  args: { botId: v.string(), botToken: v.string(), botUsername: v.string() },
  handler: async (ctx, { botId, botToken, botUsername }) => {
    const existing = await ctx.db
      .query("guestBotVaults")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId))
      .unique();
    let userId: Id<"users">;
    if (existing) {
      userId = existing.userId;
      await ctx.db.patch(existing._id, { botUsername, updatedAt: Date.now() });
    } else {
      userId = await ctx.db.insert("users", {
        name: `Guest vault · @${botUsername}`,
        isAnonymous: true,
      });
      await ctx.db.insert("guestBotVaults", {
        botId, userId, botUsername, createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
    const config = await ctx.db
      .query("telegramConfig")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (config) {
      await ctx.db.patch(config._id, { botToken, botUsername, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("telegramConfig", {
        userId, botToken, botUsername, updatedAt: Date.now(),
      });
    }
    return userId;
  },
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listFolders = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    return await ctx.db
      .query("folders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const listFiles = query({
  args: { folderId: v.union(v.id("folders"), v.null()) },
  handler: async (ctx, { folderId }) => {
    const userId = await requireUser(ctx);
    if (folderId !== null) await getOwnedFolder(ctx, userId, folderId);
    const files = await ctx.db
      .query("files")
      .withIndex("by_user_folder", (q) =>
        q.eq("userId", userId).eq("folderId", folderId),
      )
      .collect();
    // Parts (the Telegram handles) stay on the server; the list never needs them.
    return files.map(toListed);
  },
});

/** Returns the total size of completed uploads across all folders. */
export const getStorageUsage = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const files = await ctx.db
      .query("files")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return files.reduce(
      (total, file) => total + (file.status === "ready" ? file.size : 0),
      0,
    );
  },
});

/** Lists this user's files across every folder for global views such as Music. */
export const listAllFiles = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const files = await ctx.db
      .query("files")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return files.map(toListed);
  },
});

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export const createFolder = mutation({
  args: {
    name: v.string(),
    parentId: v.union(v.id("folders"), v.null()),
  },
  handler: async (ctx, { name, parentId }) => {
    const userId = await requireUser(ctx);
    if (parentId !== null) await getOwnedFolder(ctx, userId, parentId);
    return await ctx.db.insert("folders", {
      name: cleanName(name),
      parentId,
      userId,
      createdAt: Date.now(),
    });
  },
});

export const renameFolder = mutation({
  args: { folderId: v.id("folders"), name: v.string() },
  handler: async (ctx, { folderId, name }) => {
    const userId = await requireUser(ctx);
    const folder = await getOwnedFolder(ctx, userId, folderId);
    await ctx.db.patch(folder._id, { name: cleanName(name) });
  },
});

export const moveFolder = mutation({
  args: {
    folderId: v.id("folders"),
    parentId: v.union(v.id("folders"), v.null()),
  },
  handler: async (ctx, { folderId, parentId }) => {
    const userId = await requireUser(ctx);
    const folder = await getOwnedFolder(ctx, userId, folderId);
    if (parentId === null) {
      await ctx.db.patch(folder._id, { parentId: null });
      return;
    }
    if (parentId === folderId) throw new Error("A folder can't live inside itself.");
    // Walk up from the destination: landing back on this folder means a cycle.
    let cursor: Id<"folders"> | null = parentId;
    while (cursor !== null) {
      if (cursor === folderId) {
        throw new Error("That destination is inside this folder.");
      }
      const parent = await getOwnedFolder(ctx, userId, cursor);
      cursor = parent.parentId;
    }
    await ctx.db.patch(folder._id, { parentId });
  },
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const createFile = mutation({
  args: {
    name: v.string(),
    size: v.number(),
    mimeType: v.string(),
    folderId: v.union(v.id("folders"), v.null()),
  },
  handler: async (ctx, { name, size, mimeType, folderId }) => {
    const userId = await requireUser(ctx);
    if (folderId !== null) await getOwnedFolder(ctx, userId, folderId);
    if (!Number.isFinite(size) || size < 0) throw new Error("Invalid file size.");
    const bytes = Math.floor(size);
    const chunkCount = bytes === 0 ? 0 : Math.ceil(bytes / CHUNK_BYTES);
    const fileId = await ctx.db.insert("files", {
      name: cleanName(name),
      size: bytes,
      mimeType: mimeType || "application/octet-stream",
      folderId,
      userId,
      createdAt: Date.now(),
      status: "uploading",
      chunkCount,
      chunkBytes: CHUNK_BYTES,
      parts: [],
    });
    return { fileId, chunkCount };
  },
});

export const getChunkUploadUrl = mutation({
  args: { fileId: v.id("files"), index: v.number() },
  handler: async (ctx, { fileId, index }) => {
    const userId = await requireUser(ctx);
    const file = await ctx.db.get(fileId);
    if (!file || file.userId !== userId) throw new Error("Upload not found.");
    if (file.status !== "uploading") throw new Error("Upload already finished.");
    if (index < 0 || index >= file.chunkCount) {
      throw new Error("That part is out of range.");
    }
    return await ctx.storage.generateUploadUrl();
  },
});

export const finishUpload = mutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const userId = await requireUser(ctx);
    const file = await ctx.db.get(fileId);
    if (!file || file.userId !== userId) throw new Error("Upload not found.");
    const partMap = file.partMap ?? {};
    const orderedParts = Array.from({ length: file.chunkCount }, (_, index) => {
      const part = partMap[String(index)];
      if (!part) {
        throw new Error(`Part ${index + 1} of ${file.chunkCount} never arrived — retry the upload.`);
      }
      return part;
    });
    await ctx.db.patch(fileId, {
      parts: orderedParts,
      partMap: undefined,
      status: "ready",
    });
  },
});

export const renameFile = mutation({
  args: { fileId: v.id("files"), name: v.string() },
  handler: async (ctx, { fileId, name }) => {
    const userId = await requireUser(ctx);
    const file = await ctx.db.get(fileId);
    if (!file || file.userId !== userId) throw new Error("File not found.");
    await ctx.db.patch(fileId, { name: cleanName(name) });
  },
});

export const moveFile = mutation({
  args: {
    fileId: v.id("files"),
    folderId: v.union(v.id("folders"), v.null()),
  },
  handler: async (ctx, { fileId, folderId }) => {
    const userId = await requireUser(ctx);
    const file = await ctx.db.get(fileId);
    if (!file || file.userId !== userId) throw new Error("File not found.");
    if (folderId !== null) await getOwnedFolder(ctx, userId, folderId);
    await ctx.db.patch(fileId, { folderId });
  },
});

/**
 * Mints a short-lived token for the HTTP download route. The route needs no
 * session of its own, so the browser can fetch one part after another with it.
 */
export const createDownloadToken = mutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const userId = await requireUser(ctx);
    const file = await ctx.db.get(fileId);
    if (!file || file.userId !== userId) throw new Error("File not found.");
    if (file.status !== "ready") throw new Error("That file is still uploading.");

    const now = Date.now();
    const stale = await ctx.db
      .query("downloadTokens")
      .withIndex("by_user_expiry", (q) =>
        q.eq("userId", userId).lt("expiresAt", now),
      )
      .take(25);
    for (const token of stale) await ctx.db.delete(token._id);

    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    await ctx.db.insert("downloadTokens", {
      token,
      fileId,
      userId,
      expiresAt: now + DOWNLOAD_TOKEN_TTL_MS,
    });
    return token;
  },
});

// ---------------------------------------------------------------------------
// Internal reads — reachable only from other Convex functions
// ---------------------------------------------------------------------------

/** Full config including the token. Never handed back to the client. */
export const getTelegramConfigDoc = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("telegramConfig")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
  },
});

export const getTelegramBotDoc = internalQuery({
  args: { botId: v.string() },
  handler: async (ctx, { botId }) => {
    return await ctx.db
      .query("telegramBots")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId))
      .unique();
  },
});

export const getFileForUpload = internalQuery({
  args: { fileId: v.id("files"), userId: v.id("users") },
  handler: async (ctx, { fileId, userId }) => {
    const file = await ctx.db.get(fileId);
    if (!file || file.userId !== userId) return null;
    return {
      name: file.name,
      chunkCount: file.chunkCount,
      status: file.status,
    };
  },
});

/**
 * Resolves a download token into everything the whole-file HTTP route needs:
 * the real filename and type, the byte layout, and the part handles. Parts
 * never leave the server through this path — only the assembled bytes do.
 */
export const resolveWholeFile = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const record = await ctx.db
      .query("downloadTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!record || record.expiresAt < Date.now()) return null;

    const file = await ctx.db.get(record.fileId);
    if (!file || file.status !== "ready") return null;

    const config = await ctx.db
      .query("telegramConfig")
      .withIndex("by_user", (q) => q.eq("userId", record.userId))
      .unique();
    if (!config?.botToken) return null;
    const bot = config.botId
      ? await ctx.db.query("telegramBots")
          .withIndex("by_bot_id", (q) => q.eq("botId", config.botId!))
          .unique()
      : null;
    const botToken = bot?.botToken ?? config.botToken;
    const chatId = bot?.chatId ?? config.chatId;
    if (!botToken || !chatId) return null;

    return {
      fileName: file.name,
      mimeType: file.mimeType,
      size: file.size,
      chunkBytes: file.chunkBytes ?? CHUNK_BYTES,
      botToken,
      partIds: file.parts.map((part) => part.fileId),
    };
  },
});

/** Resolves a download token + part index into the Telegram handle to stream. */
export const resolveDownload = internalQuery({
  args: { token: v.string(), index: v.number() },
  handler: async (ctx, { token, index }) => {
    const record = await ctx.db
      .query("downloadTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!record || record.expiresAt < Date.now()) return null;

    const file = await ctx.db.get(record.fileId);
    if (!file || file.status !== "ready") return null;
    if (index < 0 || index >= file.chunkCount) return null;
    const part = file.parts[index];
    if (!part) return null;

    const config = await ctx.db
      .query("telegramConfig")
      .withIndex("by_user", (q) => q.eq("userId", record.userId))
      .unique();
    if (!config?.botToken) return null;
    const bot = config.botId
      ? await ctx.db.query("telegramBots")
          .withIndex("by_bot_id", (q) => q.eq("botId", config.botId!))
          .unique()
      : null;
    const botToken = bot?.botToken ?? config.botToken;
    const chatId = bot?.chatId ?? config.chatId;
    if (!botToken || !chatId) return null;

    return {
      telegramFileId: part.fileId,
      botToken,
      chatId,
      partCount: file.chunkCount,
      fileName: file.name,
      mimeType: file.mimeType,
    };
  },
});

export const collectFile = internalQuery({
  args: { fileId: v.id("files"), userId: v.id("users") },
  handler: async (ctx, { fileId, userId }) => {
    const file = await ctx.db.get(fileId);
    if (!file || file.userId !== userId) throw new Error("File not found.");
    return {
      folderIds: [] as Id<"folders">[],
      fileIds: [fileId],
      messageIds: file.parts
        .map((part) => part.messageId)
        .filter((id): id is number => id !== undefined),
    };
  },
});

/** Gathers a folder, everything beneath it, and their Telegram message ids. */
export const collectFolder = internalQuery({
  args: { folderId: v.id("folders"), userId: v.id("users") },
  handler: async (ctx, { folderId, userId }) => {
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const known = new Map(folders.map((folder) => [folder._id, folder]));
    if (!known.has(folderId)) throw new Error("That folder no longer exists.");

    const children = new Map<string, Id<"folders">[]>();
    for (const folder of folders) {
      if (folder.parentId === null) continue;
      const siblings = children.get(folder.parentId) ?? [];
      siblings.push(folder._id);
      children.set(folder.parentId, siblings);
    }

    const folderIds: Id<"folders">[] = [];
    const queue: Id<"folders">[] = [folderId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      folderIds.push(current);
      queue.push(...(children.get(current) ?? []));
    }

    const inSubtree = new Set<string>(folderIds);
    const files = await ctx.db
      .query("files")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const fileIds: Id<"files">[] = [];
    const messageIds: number[] = [];
    for (const file of files) {
      if (file.folderId === null || !inSubtree.has(file.folderId)) continue;
      fileIds.push(file._id);
      for (const part of file.parts) {
        if (part.messageId !== undefined) messageIds.push(part.messageId);
      }
    }
    return { folderIds, fileIds, messageIds };
  },
});

// ---------------------------------------------------------------------------
// Internal writes
// ---------------------------------------------------------------------------

export const saveTelegramConfig = internalMutation({
  args: {
    userId: v.id("users"),
    botId: v.string(),
    botToken: v.string(),
    botUsername: v.string(),
    resetChat: v.boolean(),
  },
  handler: async (ctx, { userId, botId, botToken, botUsername, resetChat }) => {
    const existing = await ctx.db
      .query("telegramConfig")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const botChanged =
      (existing?.botId !== undefined && existing.botId !== botId) ||
      (existing?.botUsername !== undefined && existing.botUsername !== botUsername);
    if (existing) {
      await ctx.db.patch(existing._id, {
        botId,
        botToken,
        botUsername,
        updatedAt: Date.now(),
        ...(resetChat || botChanged ? { chatId: undefined, chatTitle: undefined } : {}),
      });
    } else {
      await ctx.db.insert("telegramConfig", {
        userId,
        botId,
        botToken,
        botUsername,
        updatedAt: Date.now(),
      });
    }

    const shared = await ctx.db
      .query("telegramBots")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId))
      .unique();
    const legacyChatId = !botChanged && !resetChat ? existing?.chatId : undefined;
    const legacyChatTitle = !botChanged && !resetChat ? existing?.chatTitle : undefined;
    if (shared) {
      await ctx.db.patch(shared._id, {
        botToken,
        botUsername,
        updatedAt: Date.now(),
        ...(shared.chatId ? {} : legacyChatId ? { chatId: legacyChatId, chatTitle: legacyChatTitle } : {}),
      });
    } else {
      await ctx.db.insert("telegramBots", {
        botId,
        botToken,
        botUsername,
        ...(legacyChatId ? { chatId: legacyChatId, chatTitle: legacyChatTitle } : {}),
        updatedAt: Date.now(),
      });
    }
  },
});

export const saveChat = internalMutation({
  args: {
    botId: v.string(),
    chatId: v.string(),
    chatTitle: v.optional(v.string()),
  },
  handler: async (ctx, { botId, chatId, chatTitle }) => {
    const existing = await ctx.db
      .query("telegramBots")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId))
      .unique();
    if (!existing) throw new Error("Connect the bot before saving its Telegram chat.");
    await ctx.db.patch(existing._id, {
      chatId,
      chatTitle,
      updatedAt: Date.now(),
    });
  },
});

/** Records one part after it landed in Telegram. */
export const recordPart = internalMutation({
  args: {
    fileId: v.id("files"),
    index: v.number(),
    telegramFileId: v.string(),
    messageId: v.optional(v.number()),
  },
  handler: async (ctx, { fileId, index, telegramFileId, messageId }) => {
    const file = await ctx.db.get(fileId);
    if (!file) return;
    if (file.status !== "uploading" || index < 0 || index >= file.chunkCount) return;
    const partMap = { ...(file.partMap ?? {}) };
    partMap[String(index)] = { fileId: telegramFileId, messageId };
    await ctx.db.patch(fileId, { partMap });
  },
});

/** Deletes records after their Telegram messages have been cleaned up. */
export const removeRecords = internalMutation({
  args: {
    folderIds: v.array(v.id("folders")),
    fileIds: v.array(v.id("files")),
  },
  handler: async (ctx, { folderIds, fileIds }) => {
    for (const folderId of folderIds) {
      const folder = await ctx.db.get(folderId);
      if (folder) await ctx.db.delete(folderId);
    }
    for (const fileId of fileIds) {
      const file = await ctx.db.get(fileId);
      if (file) await ctx.db.delete(fileId);
    }
  },
});
