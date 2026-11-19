import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove
      resetting: v.optional(v.boolean()), // blocks vault access while an account reset is being processed

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // Folder tree. parentId === null means "root".
    folders: defineTable({
      name: v.string(),
      parentId: v.union(v.id("folders"), v.null()),
      userId: v.id("users"),
      createdAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_user_parent", ["userId", "parentId"]),

    // Files live in a folder (or the root) and are stored as Telegram parts.
    files: defineTable({
      name: v.string(),
      size: v.number(),
      mimeType: v.string(),
      folderId: v.union(v.id("folders"), v.null()),
      userId: v.id("users"),
      createdAt: v.number(),
      status: v.union(v.literal("uploading"), v.literal("ready")),
      chunkCount: v.number(),
      /**
       * The part size this file was written with. Whole-file streaming walks
       * parts by byte offset, so the layout must stay knowable even if the
       * default chunk size ever changes. Optional: records written before it
       * existed were chunked with the current default.
       */
      chunkBytes: v.optional(v.number()),
      /** Browser file timestamp used to match a reselected file for resume. */
      sourceLastModified: v.optional(v.number()),
      /** Telegram file_id (+ message id for clean-up) for each part, in order. */
      parts: v.array(
        v.object({
          fileId: v.string(),
          messageId: v.optional(v.number()),
        }),
      ),
      /** Temporary index-keyed Telegram handles while concurrent parts arrive. */
      partMap: v.optional(
        v.record(
          v.string(),
          v.object({
            fileId: v.string(),
            messageId: v.optional(v.number()),
          }),
        ),
      ),
    })
      .index("by_user", ["userId"])
      .index("by_user_folder", ["userId", "folderId"]),

    // Per-user Telegram connection. The bot token never leaves the server.
    telegramConfig: defineTable({
      userId: v.id("users"),
      botToken: v.optional(v.string()),
      botId: v.optional(v.string()),
      botUsername: v.optional(v.string()),
      chatId: v.optional(v.string()),
      chatTitle: v.optional(v.string()),
      // Pending replacement credentials stay server-side while old metadata is cleared.
      pendingBotToken: v.optional(v.string()),
      pendingBotId: v.optional(v.string()),
      pendingBotUsername: v.optional(v.string()),
      updatedAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_bot_id", ["botId"]),

    // One canonical Telegram storage destination per bot, shared by all app accounts.
    // The bot token is a secret and is never used as a database key.
    telegramBots: defineTable({
      botId: v.string(),
      botToken: v.string(),
      botUsername: v.string(),
      chatId: v.optional(v.string()),
      chatTitle: v.optional(v.string()),
      // Only chats paired with a one-time challenge may receive or serve vault files.
      chatVerified: v.optional(v.boolean()),
      // One-time, short-lived proof that the person connecting controls this Telegram chat.
      chatChallenge: v.optional(v.string()),
      chatChallengeExpiresAt: v.optional(v.number()),
      updatedAt: v.number(),
    }).index("by_bot_id", ["botId"]),

    // One Google/email account owns a bot at a time. Released rows remain as
    // tombstones so legacy guest-token login cannot reclaim an account-owned bot.
    telegramBotOwners: defineTable({
      botId: v.string(),
      ownerUserId: v.optional(v.id("users")),
      releasedAt: v.optional(v.number()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_bot_id", ["botId"])
      .index("by_owner_user", ["ownerUserId"]),

    // One shared guest vault per Telegram bot. The bot token is never used as a database key.
    guestBotVaults: defineTable({
      botId: v.string(),
      userId: v.id("users"),
      botUsername: v.string(),
      // A short-lived, one-time code proves control of the original guest session.
      linkCodeHash: v.optional(v.string()),
      linkCodeExpiresAt: v.optional(v.number()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_bot_id", ["botId"])
      .index("by_user", ["userId"])
      .index("by_link_code_hash", ["linkCodeHash"]),

    // Maps a verified sign-in identity to the original guest vault owner.
    // File/folder ownership is not copied or rewritten when an account is linked.
    guestVaultLinks: defineTable({
      authUserId: v.id("users"),
      vaultUserId: v.id("users"),
      createdAt: v.number(),
    })
      .index("by_auth_user", ["authUserId"])
      .index("by_vault_user", ["vaultUserId"]),

    // Short-lived tokens that unlock a streamed download.
    downloadTokens: defineTable({
      token: v.string(),
      fileId: v.id("files"),
      userId: v.id("users"),
      expiresAt: v.number(),
    })
      .index("by_token", ["token"])
      .index("by_user_expiry", ["userId", "expiresAt"]),

    uploadTokens: defineTable({
      token: v.string(),
      fileId: v.id("files"),
      userId: v.id("users"),
      index: v.optional(v.number()),
      expiresAt: v.number(),
    })
      .index("by_token", ["token"])
      .index("by_file_index", ["fileId", "index"])
      .index("by_user_expiry", ["userId", "expiresAt"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
