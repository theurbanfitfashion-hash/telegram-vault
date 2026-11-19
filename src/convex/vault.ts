import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
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
  const authUserId = await getAuthUserId(ctx);
  // ConvexError, not Error: production deployments redact plain error
  // messages to "Server Error"; this one is meant for the person clicking.
  if (authUserId === null) {
    throw new ConvexError("You need to sign in to do that.");
  }
  const authUser = await ctx.db.get(authUserId);
  if (authUser?.isAnonymous === true) {
    const linkedGuestVault = await ctx.db.query("guestVaultLinks")
      .withIndex("by_vault_user", (q) => q.eq("vaultUserId", authUserId)).unique();
    if (linkedGuestVault) {
      throw new ConvexError("This guest vault is linked to a Google/email account. Sign in with that account instead.");
    }
  }
  const link = await ctx.db
    .query("guestVaultLinks")
    .withIndex("by_auth_user", (q) => q.eq("authUserId", authUserId))
    .unique();
  const vaultUserId = link?.vaultUserId ?? authUserId;
  const vaultUser = await ctx.db.get(vaultUserId);
  if (vaultUser?.resetting === true) {
    throw new ConvexError("Your account reset is still in progress. Please wait a moment.");
  }
  return vaultUserId;
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
    const claimedBot = await ctx.db.query("telegramBotOwners")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId)).unique();
    if (claimedBot) {
      throw new ConvexError("This bot is reserved for a Google/email account. Sign in with that account instead of guest login.");
    }
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
      await ctx.db.patch(config._id, { botId, botToken, botUsername, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("telegramConfig", {
        userId, botId, botToken, botUsername, updatedAt: Date.now(),
      });
    }
    return userId;
  },
});

// ---------------------------------------------------------------------------
// Guest vault account linking
// ---------------------------------------------------------------------------

/** Resolve an authenticated identity to the canonical owner of its vault. */
export const resolveVaultUserId = internalQuery({
  args: { userId: v.id("users") },
  returns: v.id("users"),
  handler: async (ctx, { userId }) => {
    const authUser = await ctx.db.get(userId);
    if (authUser?.isAnonymous === true) {
      const linkedGuestVault = await ctx.db.query("guestVaultLinks")
        .withIndex("by_vault_user", (q) => q.eq("vaultUserId", userId)).unique();
      if (linkedGuestVault) {
        throw new ConvexError("This guest vault is linked to a Google/email account. Sign in with that account instead.");
      }
    }
    const link = await ctx.db
      .query("guestVaultLinks")
      .withIndex("by_auth_user", (q) => q.eq("authUserId", userId))
      .unique();
    const vaultUserId = link?.vaultUserId ?? userId;
    const vaultUser = await ctx.db.get(vaultUserId);
    if (vaultUser?.resetting === true) {
      throw new ConvexError("Your account reset is still in progress. Please wait a moment.");
    }
    return vaultUserId;
  },
});

/** Create a one-time code while signed in to the original bot-token guest vault. */
export const createGuestVaultLinkCode = mutation({
  args: {},
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (authUserId === null) throw new ConvexError("Sign in with your existing bot-token guest login first.");
    const user = await ctx.db.get(authUserId);
    if (!user || user.isAnonymous !== true) {
      throw new ConvexError("This step must be started from your original guest vault login.");
    }
    const guestVault = await ctx.db
      .query("guestBotVaults")
      .withIndex("by_user", (q) => q.eq("userId", authUserId))
      .unique();
    if (!guestVault) throw new ConvexError("No bot-token guest vault is connected to this session.");
    const existingLink = await ctx.db
      .query("guestVaultLinks")
      .withIndex("by_vault_user", (q) => q.eq("vaultUserId", authUserId))
      .unique();
    if (existingLink) throw new ConvexError("This guest vault is already linked to a sign-in account.");

    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const code = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const codeHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const expiresAt = Date.now() + 10 * 60 * 1000;
    await ctx.db.patch(guestVault._id, {
      linkCodeHash: codeHash,
      linkCodeExpiresAt: expiresAt,
      updatedAt: Date.now(),
    });
    return { code, expiresAt };
  },
});

/** Attach the currently authenticated, verified email identity to a guest vault. */
export const linkGuestVault = mutation({
  args: { code: v.string() },
  returns: v.object({ linked: v.boolean() }),
  handler: async (ctx, { code }) => {
    const authUserId = await getAuthUserId(ctx);
    if (authUserId === null) throw new ConvexError("Sign in with Google or a verified email account first.");
    const authUser = await ctx.db.get(authUserId);
    if (!authUser || authUser.isAnonymous === true || !authUser.email || authUser.emailVerificationTime === undefined) {
      throw new ConvexError("Use a verified Google or email account to link this vault.");
    }
    if (!/^[a-f0-9]{64}$/.test(code)) throw new ConvexError("Enter the complete 64-character linking code.");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const codeHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const guestVault = await ctx.db.query("guestBotVaults")
      .withIndex("by_link_code_hash", (q) => q.eq("linkCodeHash", codeHash)).unique();
    if (!guestVault || !guestVault.linkCodeExpiresAt || guestVault.linkCodeExpiresAt <= Date.now()) {
      throw new ConvexError("This linking code is invalid or expired. Generate a new code from your guest login.");
    }
    if (guestVault.userId === authUserId) throw new ConvexError("This account is already the guest vault owner.");

    const existingAuthLink = await ctx.db.query("guestVaultLinks")
      .withIndex("by_auth_user", (q) => q.eq("authUserId", authUserId)).unique();
    if (existingAuthLink) throw new ConvexError("This Google/email account is already linked to a guest vault.");
    const existingVaultLink = await ctx.db.query("guestVaultLinks")
      .withIndex("by_vault_user", (q) => q.eq("vaultUserId", guestVault.userId)).unique();
    if (existingVaultLink) throw new ConvexError("This guest vault is already linked to another sign-in account.");

    const destinationFiles = await ctx.db.query("files")
      .withIndex("by_user", (q) => q.eq("userId", authUserId)).take(1);
    const destinationFolders = await ctx.db.query("folders")
      .withIndex("by_user", (q) => q.eq("userId", authUserId)).take(1);
    const destinationUploadTokens = await ctx.db.query("uploadTokens")
      .withIndex("by_user_expiry", (q) => q.eq("userId", authUserId)).take(1);
    const destinationDownloadTokens = await ctx.db.query("downloadTokens")
      .withIndex("by_user_expiry", (q) => q.eq("userId", authUserId)).take(1);
    const destinationGuestVault = await ctx.db.query("guestBotVaults")
      .withIndex("by_user", (q) => q.eq("userId", authUserId)).unique();
    const destinationConfig = await ctx.db.query("telegramConfig")
      .withIndex("by_user", (q) => q.eq("userId", authUserId)).unique();

    if (destinationFiles.length || destinationFolders.length ||
        destinationUploadTokens.length || destinationDownloadTokens.length ||
        destinationGuestVault) {
      throw new ConvexError("This Google/email account already has vault data. It cannot be linked without a separate safe merge.");
    }
    if (destinationConfig && destinationConfig.botId !== guestVault.botId) {
      throw new ConvexError("This Google/email account has a different bot connected. No data was changed.");
    }

    const accountBots = await ctx.db.query("telegramBotOwners")
      .withIndex("by_owner_user", (q) => q.eq("ownerUserId", authUserId)).take(1);
    if (accountBots.some((record) => record.botId !== guestVault.botId)) {
      throw new ConvexError("This Google/email account already owns a different Telegram bot.");
    }
    const botOwner = await ctx.db.query("telegramBotOwners")
      .withIndex("by_bot_id", (q) => q.eq("botId", guestVault.botId)).unique();
    if (botOwner?.ownerUserId && botOwner.ownerUserId !== authUserId) {
      throw new ConvexError("This Telegram bot is already connected to another Google/email account.");
    }

    const guestConfig = await ctx.db.query("telegramConfig")
      .withIndex("by_user", (q) => q.eq("userId", guestVault.userId)).unique();
    if (!guestConfig) {
      throw new ConvexError("The original guest vault connection is incomplete. Contact support before linking; no data was changed.");
    }
    if (guestConfig.botId && guestConfig.botId !== guestVault.botId) {
      throw new ConvexError("The guest vault's saved bot does not match its registered bot identity.");
    }

    await ctx.db.patch(guestConfig._id, {
      botId: guestVault.botId,
      botToken: destinationConfig?.botToken ?? guestConfig.botToken,
      botUsername: destinationConfig?.botUsername ?? guestConfig.botUsername,
      updatedAt: Date.now(),
    });
    if (destinationConfig) await ctx.db.delete(destinationConfig._id);
    if (botOwner) {
      await ctx.db.patch(botOwner._id, {
        ownerUserId: authUserId,
        releasedAt: undefined,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("telegramBotOwners", {
        botId: guestVault.botId,
        ownerUserId: authUserId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    await ctx.db.insert("guestVaultLinks", {
      authUserId,
      vaultUserId: guestVault.userId,
      createdAt: Date.now(),
    });
    await ctx.db.patch(guestVault._id, {
      linkCodeHash: undefined,
      linkCodeExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    return { linked: true };
  },
});

/** Reports whether the signed-in identity is already linked to a guest vault. */
export const getGuestVaultLinkStatus = query({
  args: {},
  returns: v.object({ linked: v.boolean() }),
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (authUserId === null) return { linked: false };
    const link = await ctx.db
      .query("guestVaultLinks")
      .withIndex("by_auth_user", (q) => q.eq("authUserId", authUserId))
      .unique();
    return { linked: link !== null };
  },
});

// ---------------------------------------------------------------------------
// Account reset
// ---------------------------------------------------------------------------

/** Reports reset progress without exposing any private account data. */
export const getAccountResetStatus = query({
  args: {},
  returns: v.object({ isResetting: v.boolean() }),
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (authUserId === null) return { isResetting: false };
    const authUser = await ctx.db.get(authUserId);
    if (!authUser || authUser.isAnonymous === true || !authUser.email || authUser.emailVerificationTime === undefined) {
      return { isResetting: false };
    }
    const link = await ctx.db.query("guestVaultLinks")
      .withIndex("by_auth_user", (q) => q.eq("authUserId", authUserId)).unique();
    const vaultUser = await ctx.db.get(link?.vaultUserId ?? authUserId);
    return { isResetting: vaultUser?.resetting === true };
  },
});

/** Starts a resumable reset. Telegram messages are deliberately not deleted. */
export const beginAccountReset = mutation({
  args: {},
  returns: v.object({ started: v.boolean() }),
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (authUserId === null) throw new ConvexError("Sign in before resetting your account.");
    const authUser = await ctx.db.get(authUserId);
    if (!authUser || authUser.isAnonymous === true || !authUser.email || authUser.emailVerificationTime === undefined) {
      throw new ConvexError("Account reset is available only to a verified Google/email account.");
    }
    const link = await ctx.db.query("guestVaultLinks")
      .withIndex("by_auth_user", (q) => q.eq("authUserId", authUserId)).unique();
    const vaultUserId = link?.vaultUserId ?? authUserId;
    const vaultUser = await ctx.db.get(vaultUserId);
    if (!vaultUser) throw new ConvexError("Your vault account could not be found.");
    if (vaultUser.resetting === true) return { started: true };
    await ctx.db.patch(vaultUserId, { resetting: true });
    await ctx.scheduler.runAfter(0, internal.vault.continueAccountReset, { authUserId, vaultUserId });
    return { started: true };
  },
});

/** Deletes metadata in bounded batches so large vaults can reset safely. */
export const continueAccountReset = internalMutation({
  args: {
    authUserId: v.id("users"),
    vaultUserId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, { authUserId, vaultUserId }) => {
    const vaultUser = await ctx.db.get(vaultUserId);
    if (!vaultUser || vaultUser.resetting !== true) return null;

    const files = await ctx.db.query("files")
      .withIndex("by_user", (q) => q.eq("userId", vaultUserId)).take(100);
    const folders = await ctx.db.query("folders")
      .withIndex("by_user", (q) => q.eq("userId", vaultUserId)).take(100);
    const uploads = await ctx.db.query("uploadTokens")
      .withIndex("by_user_expiry", (q) => q.eq("userId", vaultUserId)).take(100);
    const downloads = await ctx.db.query("downloadTokens")
      .withIndex("by_user_expiry", (q) => q.eq("userId", vaultUserId)).take(100);

    for (const file of files) await ctx.db.delete(file._id);
    for (const folder of folders) await ctx.db.delete(folder._id);
    for (const token of uploads) await ctx.db.delete(token._id);
    for (const token of downloads) await ctx.db.delete(token._id);

    if (files.length || folders.length || uploads.length || downloads.length) {
      await ctx.scheduler.runAfter(0, internal.vault.continueAccountReset, { authUserId, vaultUserId });
      return null;
    }

    const config = await ctx.db.query("telegramConfig")
      .withIndex("by_user", (q) => q.eq("userId", vaultUserId)).unique();
    const guestVault = await ctx.db.query("guestBotVaults")
      .withIndex("by_user", (q) => q.eq("userId", vaultUserId)).unique();
    const existingOwner = await ctx.db.query("telegramBotOwners")
      .withIndex("by_owner_user", (q) => q.eq("ownerUserId", authUserId)).take(1);
    const botId = config?.botId ?? guestVault?.botId ?? existingOwner[0]?.botId;

    if (botId) {
      const owner = await ctx.db.query("telegramBotOwners")
        .withIndex("by_bot_id", (q) => q.eq("botId", botId)).unique();
      if (owner?.ownerUserId === authUserId) {
        await ctx.db.patch(owner._id, {
          ownerUserId: undefined,
          releasedAt: Date.now(),
          updatedAt: Date.now(),
        });
        const shared = await ctx.db.query("telegramBots")
          .withIndex("by_bot_id", (q) => q.eq("botId", botId)).unique();
        if (shared) await ctx.db.delete(shared._id);
      } else if (!owner) {
        const guestOwner = await ctx.db.query("guestBotVaults")
          .withIndex("by_bot_id", (q) => q.eq("botId", botId)).unique();
        if (!guestOwner || guestOwner.userId === vaultUserId) {
          await ctx.db.insert("telegramBotOwners", {
            botId,
            releasedAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          const shared = await ctx.db.query("telegramBots")
            .withIndex("by_bot_id", (q) => q.eq("botId", botId)).unique();
          if (shared) await ctx.db.delete(shared._id);
        }
      }
    }

    if (config) await ctx.db.delete(config._id);
    if (guestVault) await ctx.db.delete(guestVault._id);
    await ctx.db.patch(vaultUserId, { resetting: false });
    return null;
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
    sourceLastModified: v.number(),
  },
  returns: v.object({
    fileId: v.id("files"),
    chunkCount: v.number(),
    uploadedIndexes: v.array(v.number()),
    resumed: v.boolean(),
  }),
  handler: async (ctx, { name, size, mimeType, folderId, sourceLastModified }) => {
    const userId = await requireUser(ctx);
    if (folderId !== null) await getOwnedFolder(ctx, userId, folderId);
    if (!Number.isFinite(size) || size < 0) throw new Error("Invalid file size.");
    const cleanedName = cleanName(name);
    const bytes = Math.floor(size);
    const normalizedMimeType = mimeType || "application/octet-stream";
    const chunkCount = bytes === 0 ? 0 : Math.ceil(bytes / CHUNK_BYTES);

    // Reuse the newest matching incomplete upload. The successfully stored
    // Telegram part indexes live in partMap, so the browser only resends gaps.
    const recentFiles = await ctx.db
      .query("files")
      .withIndex("by_user_folder", (q) =>
        q.eq("userId", userId).eq("folderId", folderId),
      )
      .order("desc")
      .take(50);
    const pending = recentFiles.find((file) =>
      file.status === "uploading" &&
      file.name === cleanedName &&
      file.size === bytes &&
      file.mimeType === normalizedMimeType &&
      file.sourceLastModified === sourceLastModified &&
      (file.chunkBytes ?? CHUNK_BYTES) === CHUNK_BYTES &&
      file.chunkCount === chunkCount,
    );
    if (pending) {
      return {
        fileId: pending._id,
        chunkCount: pending.chunkCount,
        uploadedIndexes: Object.keys(pending.partMap ?? {})
          .map(Number)
          .filter((index) => Number.isInteger(index) && index >= 0 && index < pending.chunkCount)
          .sort((a, b) => a - b),
        resumed: true,
      };
    }

    const fileId = await ctx.db.insert("files", {
      name: cleanedName,
      size: bytes,
      mimeType: normalizedMimeType,
      folderId,
      userId,
      createdAt: Date.now(),
      status: "uploading",
      chunkCount,
      chunkBytes: CHUNK_BYTES,
      sourceLastModified,
      parts: [],
    });
    return { fileId, chunkCount, uploadedIndexes: [], resumed: false };
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
    const chatId = bot?.chatVerified === true ? bot.chatId : undefined;
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
    const chatId = bot?.chatVerified === true ? bot.chatId : undefined;
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
    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError("The vault account no longer exists.");
    const existing = await ctx.db.query("telegramConfig")
      .withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    const otherBotConfigs = await ctx.db.query("telegramConfig")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId)).take(2);
    if (otherBotConfigs.some((config) => config.userId !== userId)) {
      throw new ConvexError("This bot is already configured in another account. We won't choose an owner automatically because that could expose or hide existing files.");
    }
    const guestVault = await ctx.db.query("guestBotVaults")
      .withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    const legacyBotVault = await ctx.db.query("guestBotVaults")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId)).unique();
    if (legacyBotVault && legacyBotVault.userId !== userId) {
      throw new ConvexError("This bot already has an existing guest vault. Recover and link that vault before connecting it to this account.");
    }
    const linkedIdentity = await ctx.db.query("guestVaultLinks")
      .withIndex("by_vault_user", (q) => q.eq("vaultUserId", userId)).unique();
    const accountOwnerId = linkedIdentity?.authUserId ??
      (user.isAnonymous === true ? null : userId);
    const currentBotId = existing?.botId ?? guestVault?.botId;
    if (currentBotId && currentBotId !== botId) {
      throw new ConvexError("This account already has a different Telegram bot. Use Reset Account before connecting another bot.");
    }

    const botOwner = await ctx.db.query("telegramBotOwners")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId)).unique();
    if (accountOwnerId) {
      const accountBots = await ctx.db.query("telegramBotOwners")
        .withIndex("by_owner_user", (q) => q.eq("ownerUserId", accountOwnerId)).take(1);
      if (accountBots.some((record) => record.botId !== botId)) {
        throw new ConvexError("This Google/email account already has a different Telegram bot. Use Reset Account first.");
      }
      if (botOwner?.ownerUserId && botOwner.ownerUserId !== accountOwnerId) {
        throw new ConvexError("This Telegram bot is already connected to another Google/email account.");
      }
      if (botOwner) {
        await ctx.db.patch(botOwner._id, {
          ownerUserId: accountOwnerId,
          releasedAt: undefined,
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.insert("telegramBotOwners", {
          botId,
          ownerUserId: accountOwnerId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    } else if (botOwner) {
      throw new ConvexError("This bot is reserved for a Google/email account. Sign in with that account instead of guest login.");
    } else if (guestVault && guestVault.botId !== botId) {
      throw new ConvexError("A guest vault cannot be moved to a different bot. Link it to a verified account first.");
    }

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

    const shared = await ctx.db.query("telegramBots")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId)).unique();
    if (shared) {
      await ctx.db.patch(shared._id, { botToken, botUsername, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("telegramBots", { botId, botToken, botUsername, updatedAt: Date.now() });
    }
  },
});

export const saveChatChallenge = internalMutation({
  args: {
    botId: v.string(),
    challenge: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, { botId, challenge, expiresAt }) => {
    const existing = await ctx.db
      .query("telegramBots")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId))
      .unique();
    if (!existing) throw new Error("Connect the bot before pairing its Telegram chat.");
    // Keep the last verified destination live until a replacement challenge
    // is successfully redeemed. A failed or abandoned pairing must not
    // interrupt existing uploads and downloads.
    await ctx.db.patch(existing._id, {
      chatChallenge: challenge,
      chatChallengeExpiresAt: expiresAt,
      updatedAt: Date.now(),
    });
  },
});

export const saveChat = internalMutation({
  args: {
    botId: v.string(),
    chatId: v.string(),
    chatTitle: v.optional(v.string()),
    challenge: v.string(),
  },
  handler: async (ctx, { botId, chatId, chatTitle, challenge }) => {
    const existing = await ctx.db
      .query("telegramBots")
      .withIndex("by_bot_id", (q) => q.eq("botId", botId))
      .unique();
    if (!existing) throw new Error("Connect the bot before saving its Telegram chat.");
    if (
      !existing.chatChallenge ||
      existing.chatChallenge !== challenge ||
      !existing.chatChallengeExpiresAt ||
      existing.chatChallengeExpiresAt <= Date.now()
    ) {
      throw new ConvexError("This Telegram pairing link is invalid or expired. Generate a new one.");
    }
    await ctx.db.patch(existing._id, {
      chatId,
      chatTitle,
      chatVerified: true,
      chatChallenge: undefined,
      chatChallengeExpiresAt: undefined,
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
