import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("requesting a new Telegram pairing preserves the currently verified chat", async () => {
  const source = await read("../src/convex/vault.ts");
  const start = source.indexOf("export const saveChatChallenge");
  const end = source.indexOf("export const saveChat =", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  assert.match(body, /chatChallenge: challenge/);
  assert.match(body, /chatChallengeExpiresAt: expiresAt/);
  assert.doesNotMatch(body, /chatId:\s*undefined|chatTitle:\s*undefined|chatVerified:\s*false/);
});

test("Telegram chat replacement requires the current unexpired one-time challenge", async () => {
  const source = await read("../src/convex/vault.ts");
  const start = source.indexOf("export const saveChat =");
  const end = source.indexOf("/** Records one part", start);
  const body = source.slice(start, end);
  assert.match(body, /existing\.chatChallenge !== challenge/);
  assert.match(body, /existing\.chatChallengeExpiresAt <= Date\.now\(\)/);
  assert.match(body, /chatVerified: true/);
  assert.match(body, /chatChallenge: undefined/);
});

test("Telegram pairing does not delete webhooks when polling is unavailable", async () => {
  const source = await read("../src/convex/telegram.ts");
  assert.match(source, /webhook or another polling session/i);
  assert.doesNotMatch(source, /deleteWebhook/);
});

test("guest vault link codes are high entropy, hashed, short-lived, and single-use", async () => {
  const source = await read("../src/convex/vault.ts");
  const start = source.indexOf("export const createGuestVaultLinkCode");
  const end = source.indexOf("export const linkGuestVault", start);
  const createBody = source.slice(start, end);
  assert.match(createBody, /new Uint8Array\(32\)/);
  assert.match(createBody, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(createBody, /10 \* 60 \* 1000/);

  const linkStart = source.indexOf("export const linkGuestVault");
  const linkEnd = source.indexOf("export const getGuestVaultLinkStatus", linkStart);
  const linkBody = source.slice(linkStart, linkEnd);
  assert.match(linkBody, /emailVerificationTime === undefined/);
  assert.match(linkBody, /by_link_code_hash/);
  assert.match(linkBody, /linkCodeHash: undefined/);
  assert.match(linkBody, /linkCodeExpiresAt: undefined/);
});

test("vault and Telegram actions resolve linked identities to the original vault owner", async () => {
  const vault = await read("../src/convex/vault.ts");
  const telegram = await read("../src/convex/telegram.ts");
  assert.match(vault, /const vaultUserId = link\?\.vaultUserId \?\? authUserId/);
  assert.match(vault, /return vaultUserId/);
  assert.match(telegram, /internal\.vault\.resolveVaultUserId/);
});

test("linking refuses to overwrite an account that already owns vault data", async () => {
  const source = await read("../src/convex/vault.ts");
  const start = source.indexOf("export const linkGuestVault");
  const end = source.indexOf("export const getGuestVaultLinkStatus", start);
  const body = source.slice(start, end);
  for (const marker of [
    "destinationFiles.length",
    "destinationFolders.length",
    "destinationConfig",
    "destinationGuestVault",
    "destinationUploadTokens.length",
    "destinationDownloadTokens.length",
  ]) {
    assert.ok(body.includes(marker), `missing destination guard: ${marker}`);
  }
});

test("guest login is hidden from the public auth screen but legacy recovery stays in the backend", async () => {
  const authPage = await read("../src/pages/Auth.tsx");
  const authBackend = await read("../src/convex/auth.ts");
  assert.doesNotMatch(authPage, /bot-token-guest|Shared guest vault|Open shared guest vault/);
  assert.match(authBackend, /id: "bot-token-guest"/);
});

test("one Telegram bot can be owned by only one verified account", async () => {
  const schema = await read("../src/convex/schema.ts");
  const vault = await read("../src/convex/vault.ts");
  assert.match(schema, /telegramBotOwners: defineTable/);
  assert.match(schema, /index\("by_bot_id", \["botId"\]\)/);
  assert.match(schema, /index\("by_owner_user", \["ownerUserId"\]\)/);
  assert.match(vault, /This Telegram bot is already connected to another Google\/email account/);
  assert.match(vault, /This account already has a different Telegram bot/);
  assert.match(vault, /const claimedBot = await ctx\.db\.query\("telegramBotOwners"\)/);
});

test("account reset clears app metadata in bounded batches without deleting Telegram messages", async () => {
  const vault = await read("../src/convex/vault.ts");
  const resetStart = vault.indexOf("export const beginAccountReset");
  const resetEnd = vault.indexOf("// ---------------------------------------------------------------------------\n// Reads", resetStart);
  assert.notEqual(resetStart, -1);
  assert.notEqual(resetEnd, -1);
  const reset = vault.slice(resetStart, resetEnd);
  assert.match(reset, /resetting: true/);
  assert.match(reset, /\.take\(100\)/);
  assert.match(reset, /ctx\.db\.delete\(file\._id\)/);
  assert.match(reset, /ctx\.db\.delete\(folder\._id\)/);
  assert.match(reset, /ctx\.db\.delete\(config\._id\)/);
  assert.match(reset, /releasedAt: Date\.now\(\)/);
  assert.doesNotMatch(reset, /deleteMessage|purgeMessages/);
});

test("Telegram connections no longer fall back to a shared deployment bot token", async () => {
  const source = await read("../src/convex/telegram.ts");
  assert.doesNotMatch(source, /envToken\(\)|TELEGRAM_BOT_TOKEN/);
});

test("linked guest sessions cannot keep accessing the vault after linking", async () => {
  const vault = await read("../src/convex/vault.ts");
  assert.match(vault, /This guest vault is linked to a Google\/email account/);
  assert.match(vault, /withIndex\("by_vault_user"/);
});

test("dashboard surfaces bot ownership conflicts and provides a path to account reset", async () => {
  const dashboard = await read("../src/pages/Dashboard.tsx");
  assert.match(dashboard, /setStatusError\(errorMessage\(error\)\)/);
  assert.match(dashboard, /navigate\("\/account"\)/);
});
