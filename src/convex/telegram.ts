"use node";

import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, type ActionCtx } from "./_generated/server";

const TELEGRAM_API = "https://api.telegram.org";

/** Deleting messages is best effort — batched so one call can't time out. */
const PURGE_BATCH = 4;
const PURGE_LIMIT = 4000;

type TelegramOk<T> = { ok: true; result: T };
type TelegramErr = {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

interface BotInfo {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  title?: string;
}

interface TelegramFileHandle {
  file_id?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
  document?: TelegramFileHandle;
  audio?: TelegramFileHandle;
  video?: TelegramFileHandle;
  animation?: TelegramFileHandle;
  voice?: TelegramFileHandle;
  video_note?: TelegramFileHandle;
  photo?: TelegramFileHandle[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One call to Telegram with the etiquette the API asks for: honour
 * `retry_after` exactly, back off on 5xx, fail fast on anything else.
 */
async function telegram<T>(
  method: string,
  token: string,
  payload: { json?: Record<string, unknown>; form?: FormData },
): Promise<T> {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  let lastError = "Telegram did not answer. Please try again.";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    let response: Response;
    try {
      response = payload.form
        ? await fetch(url, { method: "POST", body: payload.form })
        : await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload.json ?? {}),
          });
    } catch {
      lastError = "Could not reach Telegram. Check the connection and retry.";
      continue;
    }

    let data: TelegramOk<T> | TelegramErr;
    try {
      data = (await response.json()) as TelegramOk<T> | TelegramErr;
    } catch {
      lastError = `Telegram responded with status ${response.status}.`;
      continue;
    }

    if (data.ok) return data.result;
    lastError = data.description ?? `Telegram error ${response.status}`;
    if (data.error_code === 429) {
      await sleep(((data.parameters?.retry_after ?? 2) + 0.5) * 1000);
      continue;
    }
    if ((data.error_code ?? 0) >= 500) continue;
    // ConvexError (not Error): production deployments redact plain error
    // messages to "Server Error", but ConvexError data always reaches the
    // client — these messages exist for the person clicking the button.
    throw new ConvexError(lastError);
  }
  throw new ConvexError(lastError);
}

async function requireUser(ctx: ActionCtx): Promise<Id<"users">> {
  const authUserId = await getAuthUserId(ctx);
  if (authUserId === null) {
    throw new ConvexError("You need to sign in to do that.");
  }
  return await ctx.runQuery(internal.vault.resolveVaultUserId, { userId: authUserId });
}

/**
 * Validates a token with `getMe` (network) and reports which bot + chat the
 * vault is wired to. Used by the connect screen, not on the transfer path.
 * An `TELEGRAM_BOT_TOKEN` env var is folded into the stored config here so the
 * rest of the app only ever has to look at one place.
 */
async function resolveBot(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<{
  token: string;
  botId: string;
  username?: string;
  chatId?: string;
  chatTitle?: string;
} | null> {
  const config = await ctx.runQuery(internal.vault.getTelegramConfigDoc, { userId });
  // Each account must connect its own bot. Never fall back to a shared
  // deployment-wide token, which would violate one-account/one-bot ownership.
  const candidates: { token: string }[] = [];
  if (config?.botToken) candidates.push({ token: config.botToken });

  for (const candidate of candidates) {
    let me: BotInfo;
    try {
      me = await telegram<BotInfo>("getMe", candidate.token, { json: {} });
    } catch {
      continue;
    }
    if (!me.username) continue;
    const botId = String(me.id);
    await ctx.runMutation(internal.vault.saveTelegramConfig, {
      userId,
      botId,
      botToken: candidate.token,
      botUsername: me.username,
      resetChat: false,
    });
    const shared = await ctx.runQuery(internal.vault.getTelegramBotDoc, { botId });
    return {
      token: candidate.token,
      botId,
      username: me.username,
      chatId: shared?.chatVerified === true ? shared.chatId : undefined,
      chatTitle: shared?.chatVerified === true ? shared.chatTitle : undefined,
    };
  }
  return null;
}

/** Cheap lookup for the transfer path — no extra API round trips. */
async function requireConnection(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<{ token: string; chatId: string }> {
  const config = await ctx.runQuery(internal.vault.getTelegramConfigDoc, { userId });
  const token = config?.botToken;
  if (!token) throw new Error("Connect your personal Telegram bot before storing files.");
  const shared = config?.botId
    ? await ctx.runQuery(internal.vault.getTelegramBotDoc, { botId: config.botId })
    : null;
  const chatId = shared?.chatVerified === true ? shared.chatId : undefined;
  if (!chatId) throw new Error("Reconnect your Telegram chat using the secure pairing link before transferring files.");
  return { token: shared?.botToken ?? token, chatId };
}

function partName(name: string, index: number, chunkCount: number): string {
  if (chunkCount <= 1) return name;
  return `${name}.part${String(index + 1).padStart(4, "0")}`;
}

async function purgeMessages(
  ctx: ActionCtx,
  userId: Id<"users">,
  messageIds: number[],
) {
  if (messageIds.length === 0) return;
  let connection: { token: string; chatId: string };
  try {
    connection = await requireConnection(ctx, userId);
  } catch {
    return;
  }
  const queue = messageIds.slice(0, PURGE_LIMIT);
  for (let i = 0; i < queue.length; i += PURGE_BATCH) {
    const batch = queue.slice(i, i + PURGE_BATCH);
    await Promise.all(
      batch.map(async (messageId) => {
        try {
          await telegram("deleteMessage", connection.token, {
            json: { chat_id: connection.chatId, message_id: messageId },
          });
        } catch {
          // Telegram refuses to delete some old messages; an orphaned copy in
          // the chat is harmless — the vault no longer lists it either way.
        }
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export const telegramStatus = action({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const bot = await resolveBot(ctx, userId);
    if (!bot) {
      return {
        hasToken: false,
        botUsername: null as string | null,
        chatConnected: false,
        chatTitle: null as string | null,
      };
    }
    return {
      hasToken: true,
      botUsername: bot.username ?? null,
      chatConnected: !!bot.chatId,
      chatTitle: bot.chatTitle ?? null,
    };
  },
});

export const connectBot = action({
  args: { botToken: v.string() },
  handler: async (ctx, { botToken }) => {
    const userId = await requireUser(ctx);
    const token = botToken.trim();
    if (!token) {
      throw new ConvexError("Paste the token BotFather gave you.");
    }
    if (!/^\d{5,}:[A-Za-z0-9_-]{10,}$/.test(token)) {
      throw new ConvexError(
        "That doesn't look like a bot token — it looks like 123456789:AA....",
      );
    }
    let me: BotInfo;
    try {
      me = await telegram<BotInfo>("getMe", token, { json: {} });
    } catch (error) {
      throw new ConvexError(
        `Telegram rejected that token. ${
          error instanceof Error ? error.message : "Check it in @BotFather."
        }`,
      );
    }
    if (!me.username) {
      throw new ConvexError("That bot has no username yet.");
    }
    await ctx.runMutation(internal.vault.saveTelegramConfig, {
      userId,
      botId: String(me.id),
      botToken: token,
      botUsername: me.username,
      resetChat: false,
    });
    return { botUsername: me.username };
  },
});

export const beginChatConnection = action({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const bot = await resolveBot(ctx, userId);
    if (!bot?.username) throw new ConvexError("Connect your bot token first.");

    // Telegram deep-link start parameters support URL-safe alphanumeric characters.
    const challenge = Array.from(
      crypto.getRandomValues(new Uint8Array(24)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await ctx.runMutation(internal.vault.saveChatChallenge, {
      botId: bot.botId,
      challenge,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return {
      challenge,
      deepLink: `https://t.me/${bot.username}?start=${challenge}`,
    };
  },
});

export const detectChat = action({
  args: { challenge: v.string() },
  handler: async (ctx, { challenge }) => {
    const userId = await requireUser(ctx);
    const bot = await resolveBot(ctx, userId);
    if (!bot) throw new ConvexError("Connect your bot token first.");
    if (!/^[a-f0-9]{48}$/.test(challenge)) {
      throw new ConvexError("Generate a new secure Telegram pairing link.");
    }

    // Do not delete a webhook or accept arbitrary private messages. Only the
    // exact one-time /start challenge generated for this signed-in session
    // proves control of the intended Telegram chat.
    let updates: TelegramUpdate[];
    try {
      updates = await telegram<TelegramUpdate[]>("getUpdates", bot.token, {
        json: { timeout: 0, allowed_updates: ["message"] },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/webhook|conflict.*getupdates|terminated by other getupdates/i.test(message)) {
        throw new ConvexError(
          "Telegram is currently using a webhook or another polling session, so secure pairing cannot read the Start confirmation. We will not remove your webhook or disconnect your existing verified chat. Disable the competing poller or configure the bot for polling, then generate a fresh pairing link.",
        );
      }
      throw error;
    }
    const matched = updates.find(
      (update) =>
        update.message?.chat?.type === "private" &&
        update.message.text === `/start ${challenge}`,
    );
    if (!matched?.message) {
      throw new ConvexError(
        "We haven't received your secure Start confirmation yet. Open the generated link, press Start, then try again.",
      );
    }

    const chat = matched.message.chat;
    const chatTitle =
      [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
      chat.title ||
      "Telegram";
    await ctx.runMutation(internal.vault.saveChat, {
      botId: bot.botId,
      chatId: String(chat.id),
      chatTitle,
      challenge,
    });

    // Acknowledge updates only after the matching challenge was saved.
    const offset = Math.max(...updates.map((update) => update.update_id)) + 1;
    await telegram("getUpdates", bot.token, {
      json: { offset, allowed_updates: ["message"] },
    }).catch(() => {});
    return { chatTitle };
  },
});

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export const sendChunk = action({
  args: {
    fileId: v.id("files"),
    index: v.number(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, { fileId, index, storageId }) => {
    let stage = "checking your account";
    try {
      const userId = await requireUser(ctx);
      stage = "checking the upload record";
      const file = await ctx.runQuery(internal.vault.getFileForUpload, {
        fileId,
        userId,
      });
      if (!file) throw new ConvexError("This upload no longer exists.");
      if (index < 0 || index >= file.chunkCount) {
        throw new ConvexError("That part is out of range.");
      }

      stage = "checking your Telegram connection";
      const { token, chatId } = await requireConnection(ctx, userId);
      stage = "reading the temporary upload part";
      const blob = await ctx.storage.get(storageId);
      if (!blob) {
        throw new ConvexError("That part expired before it reached Telegram — retry it.");
      }

      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("disable_notification", "true");
      form.append("document", blob, partName(file.name, index, file.chunkCount));

      stage = "sending the file to Telegram";
      const message = await telegram<TelegramMessage>("sendDocument", token, {
        form,
      });
      // Telegram may classify a media upload under its native Message field
      // (audio/video/animation/etc.) rather than document. Any of these
      // file_id values can be passed to getFile for downloading later.
      const telegramFileId =
        message.document?.file_id ??
        message.audio?.file_id ??
        message.video?.file_id ??
        message.animation?.file_id ??
        message.voice?.file_id ??
        message.video_note?.file_id ??
        message.photo?.[message.photo.length - 1]?.file_id;
      if (!telegramFileId) {
        const returnedFields = Object.keys(message).filter(
          (key) => !["chat", "from", "sender_chat"].includes(key),
        );
        throw new ConvexError(
          `Telegram returned a message without a file handle (fields: ${returnedFields.join(", ") || "none"}).`,
        );
      }

      stage = "saving the Telegram file reference";
      await ctx.runMutation(internal.vault.recordPart, {
        fileId,
        index,
        telegramFileId,
        messageId: message.message_id,
      });
      await ctx.storage.delete(storageId).catch(() => {});
      return { ok: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConvexError(`Upload failed while ${stage}: ${detail}`);
    }
  },
});

export const removeFile = action({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const userId = await requireUser(ctx);
    const { folderIds, fileIds, messageIds } = await ctx.runQuery(
      internal.vault.collectFile,
      { fileId, userId },
    );
    await purgeMessages(ctx, userId, messageIds);
    await ctx.runMutation(internal.vault.removeRecords, { folderIds, fileIds });
  },
});

export const removeFolder = action({
  args: { folderId: v.id("folders") },
  handler: async (ctx, { folderId }) => {
    const userId = await requireUser(ctx);
    const { folderIds, fileIds, messageIds } = await ctx.runQuery(
      internal.vault.collectFolder,
      { folderId, userId },
    );
    await purgeMessages(ctx, userId, messageIds);
    await ctx.runMutation(internal.vault.removeRecords, { folderIds, fileIds });
  },
});
