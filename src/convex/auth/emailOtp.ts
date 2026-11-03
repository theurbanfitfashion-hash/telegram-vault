import { Email } from "@convex-dev/auth/providers/Email";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";

export const emailOtp = Email({
  id: "email-otp",
  maxAge: 60 * 15,
  async generateVerificationToken() {
    const random: RandomReader = {
      read(bytes: Uint8Array) {
        crypto.getRandomValues(bytes);
      },
    };
    return generateRandomString(random, "0123456789", 6);
  },
  async sendVerificationRequest({ identifier: email, token }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.AUTH_EMAIL_FROM;
    if (!apiKey || !from) {
      throw new Error(
        "Email sign-in is not configured yet. Set RESEND_API_KEY and AUTH_EMAIL_FROM on this Telegram Vault Convex deployment.",
      );
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: "Your Telegram Vault sign-in code",
        text: `Your Telegram Vault verification code is ${token}. It expires in 15 minutes. If you did not request this code, you can ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px"><h2>Telegram Vault sign-in</h2><p>Your verification code is:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${token}</p><p>This code expires in 15 minutes. If you did not request it, ignore this email.</p></div>`,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Resend email delivery failed:", response.status, detail);
      throw new Error(`Could not send the sign-in code (email provider returned ${response.status}). Check the Resend API key and verified sender address.`);
    }
  },
});
