import { convexAuth } from "@convex-dev/auth/server";
import Google from "@auth/core/providers/google";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { internal } from "./_generated/api";
import { emailOtp } from "./auth/emailOtp";

// Convex Auth's built-in trusted-provider linking is intentional here:
// Google OAuth and verified email OTP sign-ins using the same email resolve
// to the same users row. Do not add a custom createOrUpdateUser callback;
// overriding the default would disable this safe account-linking behavior.
const botTokenGuest = ConvexCredentials({
  id: "bot-token-guest",
  authorize: async (credentials, ctx) => {
    const botToken = String(credentials.botToken ?? "").trim();
    if (!/^\\d{5,}:[A-Za-z0-9_-]{10,}$/.test(botToken)) {
      throw new Error("Enter a valid Telegram bot token.");
    }
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: "POST",
    });
    const result = await response.json() as {
      ok?: boolean;
      result?: { id: number; is_bot: boolean; username?: string };
    };
    if (!response.ok || !result.ok || !result.result?.is_bot || !result.result.username) {
      throw new Error("Telegram rejected this bot token. Check it with @BotFather.");
    }
    const userId = await ctx.runMutation(internal.vault.resolveGuestBotVault, {
      botId: String(result.result.id),
      botToken,
      botUsername: result.result.username,
    });
    return { userId };
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [emailOtp, Google, botTokenGuest],
});
