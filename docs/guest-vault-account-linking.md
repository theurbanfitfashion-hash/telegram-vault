# Linking a Telegram Vault guest vault to Google/email

1. Sign in with the existing Telegram bot-token guest login.
2. Open the account page and choose **Generate one-time linking code**.
3. Copy the code. It expires after 10 minutes.
4. Sign out, then sign in with the Google account (or verified email account) you want to use.
5. Paste the code into **Finish linking your guest vault** and submit it.

The verified account is mapped to the original guest vault owner. File, folder, Telegram connection, and download-token records are not copied or reassigned. The bot-token guest login remains available and resolves to the same original guest vault.

**Security note:** the guest login is intentionally shared by bot identity. Anyone who obtains the Telegram bot token can still sign in to that shared guest vault. Linking Google does not disable or add a second factor to bot-token login.

Link codes are random, stored only as SHA-256 hashes, expire after 10 minutes, and can be redeemed once.
