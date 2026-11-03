import { convexAuth } from "@convex-dev/auth/server";
import Google from "@auth/core/providers/google";
import { emailOtp } from "./auth/emailOtp";

// Convex Auth's built-in trusted-provider linking is intentional here:
// Google OAuth and verified email OTP sign-ins using the same email resolve
// to the same users row. Do not add a custom createOrUpdateUser callback;
// overriding the default would disable this safe account-linking behavior.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [emailOtp, Google],
});
