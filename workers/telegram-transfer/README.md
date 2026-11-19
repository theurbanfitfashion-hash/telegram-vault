# Telegram Vault transfer Worker

This Worker moves Telegram file bytes without routing them through Convex. Convex remains the source of truth for account ownership, file metadata, Telegram credentials, and short-lived transfer capabilities.

## Routes

- `POST /upload` — accepts one raw 18 MB-or-smaller chunk with an upload capability in `Authorization: Bearer <token>`, streams it to Telegram `sendDocument`, then records the returned Telegram file reference through Convex.
- `GET /file/:downloadToken` — streams the whole file from Telegram, preserving byte-range support for browser media playback and seeking.
- `GET /file/:downloadToken/:partIndex` — streams one Telegram part for the app's part-by-part download flow.
- `GET /health` — health check.

The Worker does not store files, bot tokens, or account data. It does not buffer whole upload/download bodies in memory.

Cloudflare Workers Free allows 50 external subrequests per invocation. The whole-file route therefore accepts a maximum of 24 Telegram parts in one request (about 432 MB with the current 18 MB chunk size). Larger files still work through the app's part-by-part Save File picker flow, because each part is downloaded in a separate Worker request. Chrome 132+ on Android supports the File System Access save picker; desktop Chromium browsers support it as well. Browsers without that API cannot use the Free-plan whole-file fallback for files larger than 24 parts.

## Required configuration

Set these Worker variables for the production deployment:

- `CONVEX_SITE_URL`: the exact `https://<production-deployment>.convex.site` URL for this Telegram Vault project.
- `APP_ORIGIN`: the production frontend origin, currently `https://telegram-vault-web.onrender.com`.

Set `TRANSFER_WORKER_SECRET` as a Worker secret and as a Convex deployment environment variable with exactly the same randomly generated value. Do not commit it, send it in chat, or put it in the frontend.

Example setup from this directory:

```sh
npx wrangler secret put TRANSFER_WORKER_SECRET
npx wrangler deploy
```

Configure non-secret variables in the Cloudflare dashboard or with Wrangler `--var` when deploying. Configure the matching secret in the Convex production deployment's Environment Variables.

## Safe rollout

1. Deploy the Worker and verify `/health`.
2. Set the matching secret on the production Convex deployment.
3. Configure `VITE_TRANSFER_WORKER_URL` on the frontend and rebuild the frontend.
4. Test with a separate Telegram bot first.
5. Only switch production traffic after upload, download, range/seek, retry, and account-isolation checks pass.

The existing Convex transfer endpoints remain available as a rollback path. Do not remove them until the Cloudflare path has been verified in production.
