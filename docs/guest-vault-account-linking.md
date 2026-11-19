# Linking a Telegram Vault guest vault to Google/email

1. Sign in with the existing Telegram bot-token guest login.
2. Open the account page and choose **Generate one-time linking code**.
3. Copy the code. It expires after 10 minutes.
4. Sign out, then sign in with the Google account (or verified email account) you want to use.
5. Paste the code into **Finish linking your guest vault** and submit it.

The verified account is mapped to the original guest vault owner. File, folder, Telegram connection, and download-token records are not copied or reassigned. The bot-token guest login remains available and resolves to the same original guest vault.

**Security note:** the guest login is intentionally shared by bot identity. Anyone who obtains the Telegram bot token can still sign in to that shared guest vault. Linking Google does not disable or add a second factor to bot-token login.

Link codes are random, stored only as SHA-256 hashes, expire after 10 minutes, and can be redeemed once.

## Security regression and end-to-end verification

The CI workflow runs a source-level regression suite for the pairing and linking invariants. These checks prevent the specific reviewed regressions from silently returning, but they do not replace testing against a live Telegram bot and Convex deployment.

Before merging, verify in a non-production/test vault:

1. **Pairing continuity:** with an already verified chat and existing files, generate a new pairing link but do not open it. Confirm uploads and downloads still work through the old chat.
2. **Successful re-pair:** open the newest link and press Start. Confirm the new chat becomes the destination and old files remain visible and downloadable.
3. **Failed pairing:** try an expired, incorrect, or superseded challenge. Confirm it is rejected and the previous verified chat remains active.
4. **Webhook conflict:** configure a webhook or another polling process and attempt pairing. Confirm the UI explains the conflict and the application does not call `deleteWebhook` or clear the previous chat.
5. **Link-code validation:** reject malformed, wrong, expired, and already-redeemed codes. A newly generated code should invalidate the previously generated code for that guest vault.
6. **Authorization:** reject linking from an anonymous account, an unverified email identity, an already-linked Google/email identity, and a guest vault already linked to another identity.
7. **Destination safety:** reject linking if the destination Google/email account already has files, folders, Telegram configuration, guest-vault ownership, upload tokens, or download tokens.
8. **Data continuity:** after successful linking, sign in with Google and verify the same file/folder list, upload, download, rename, move, and delete operations. Sign out and verify bot-token guest login still opens the same shared vault.
9. **Concurrency:** attempt to redeem one code from two different verified accounts at nearly the same time. Exactly one account may succeed.
10. **Cross-device:** verify the linked Google account opens the same vault from a second device/browser.

The dashboard's **Account** entry opens the account-linking screen. The same screen is also available at `/account`.
