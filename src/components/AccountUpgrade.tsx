import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, Loader2, Mail } from "lucide-react";

export function AccountUpgrade() {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const continueWithGoogle = async () => {
    setLoading(true);
    setError(null);
    try {
      // The Convex Auth callback links this verified Google identity to the
      // currently signed-in guest user, preserving the existing vault owner.
      await signIn("google", { redirectTo: "/dashboard" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect Google account.");
      setLoading(false);
    }
  };

  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("email", email.trim());
      await signIn("email-otp", form);
      setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send code.");
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("email", email.trim());
      form.set("code", code.trim());
      await signIn("email-otp", form);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify code.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <p className="font-medium">Save this guest vault across devices</p>
        <p className="text-sm text-muted-foreground">
          Connect a permanent sign-in to this guest account. Your existing files,
          folders, and Telegram connection should remain in this vault.
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={continueWithGoogle}
        disabled={loading}
      >
        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <GoogleIcon />}
        Continue with Google
      </Button>

      <div className="relative py-1">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">Or use email code</span>
        </div>
      </div>

      {step === "email" ? (
        <form onSubmit={sendCode} className="flex gap-2">
          <div className="relative flex-1">
            <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          </Button>
        </form>
      ) : (
        <form onSubmit={verifyCode} className="flex gap-2">
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit email code"
            disabled={loading}
          />
          <Button type="submit" disabled={loading || code.length !== 6}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
          </Button>
        </form>
      )}

      {step === "code" && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => { setStep("email"); setCode(""); }}
          disabled={loading}
        >
          Use a different email
        </button>
      )}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mr-2 h-4 w-4">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3.02h3.88c2.27-2.09 3.54-5.17 3.54-8.89z"/>
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.01c-1.08.72-2.45 1.16-4.05 1.16-3.13 0-5.78-2.11-6.73-4.96H1.26v3.11A11.99 11.99 0 0 0 12 24z"/>
      <path fill="#FBBC05" d="M5.27 14.28A7.19 7.19 0 0 1 4.89 12c0-.79.14-1.56.38-2.28V6.61H1.26A12 12 0 0 0 0 12c0 1.94.46 3.77 1.26 5.39l4.01-3.11z"/>
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.7 0 3.99 2.47 1.26 6.61l4.01 3.11C6.22 6.86 8.87 4.75 12 4.75z"/>
    </svg>
  );
}
