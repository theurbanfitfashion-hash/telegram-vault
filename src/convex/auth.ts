// Custom account linking keeps an existing guest user's vault when they add a verified login method.
import { convexAuth, getAuthUserId } from "@convex-dev/auth/server";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import Google from "@auth/core/providers/google";
import { emailOtp } from "./auth/emailOtp";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [emailOtp, Anonymous, Google],
  callbacks: {
    async createOrUpdateUser(ctx, args) {
      if (args.existingUserId) {
        const currentUserId = await getAuthUserId(ctx);
        if (currentUserId && currentUserId !== args.existingUserId) {
          const currentUser = await ctx.db.get(currentUserId);
          if (currentUser?.isAnonymous) {
            throw new Error(
              "This email or Google account is already linked to another Telegram Vault. Sign out and sign in to that account instead; your guest vault has not been changed.",
            );
          }
        }
        return args.existingUserId;
      }

      const currentUserId = await getAuthUserId(ctx);
      if (currentUserId) {
        const currentUser = await ctx.db.get(currentUserId);
        if (currentUser?.isAnonymous && args.provider.id !== "anonymous") {
          await ctx.db.patch(currentUserId, {
            email: args.profile.email,
            name: typeof args.profile.name === "string" ? args.profile.name : currentUser.name,
            image: typeof args.profile.image === "string" ? args.profile.image : currentUser.image,
            isAnonymous: false,
          });
          return currentUserId;
        }
      }

      return await ctx.db.insert("users", {
        email: args.profile.email,
        name: typeof args.profile.name === "string" ? args.profile.name : undefined,
        image: typeof args.profile.image === "string" ? args.profile.image : undefined,
        isAnonymous: args.provider.id === "anonymous",
      });
    },
  },
});
