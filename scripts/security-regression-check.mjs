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
  assert.match(vault, /return link\?\.vaultUserId \?\? authUserId/);
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
