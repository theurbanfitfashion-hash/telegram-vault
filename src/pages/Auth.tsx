import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { useAuth } from "@/hooks/use-auth";
import logo from "@/assets/logo.svg";
import { ArrowRight, Loader2, LogOut, Mail } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) return returnTo;
  return fallback;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn, signOut, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(searchParams.get("returnTo"), redirectAfterAuth);
  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setIsLoading(false);
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  const handleEmailSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      const email = String(formData.get("email") ?? "").trim().toLowerCase();
      formData.set("email", email);
      await signIn("email-otp", formData);
      setStep({ email });
    } catch (caught) {
      console.error("Email sign-in error:", caught);
      setError(caught instanceof Error ? caught.message : "Failed to send verification code. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData();
      if (typeof step === "string") throw new Error("Please enter your email again.");
      formData.set("email", step.email);
      formData.set("code", otp.trim());
      await signIn("email-otp", formData);
      navigate(redirect, { replace: true });
    } catch (caught) {
      console.error("OTP verification error:", caught);
      setError(caught instanceof Error ? caught.message : "The verification code is incorrect.");
      setOtp("");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signIn("google", { redirectTo: redirect });
    } catch (caught) {
      console.error("Google sign-in error:", caught);
      setError(caught instanceof Error ? caught.message : "Could not continue with Google. Please try again.");
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    setError(null);
    try {
      await signOut();
      setStep("signIn");
    } catch (caught) {
      console.error("Sign-out error:", caught);
      setError("Couldn't sign out. Please try again.");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-sm border shadow-md">
          {authLoading ? (
            <div className="flex items-center justify-center px-6 py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : isAuthenticated ? (
            <>
              <CardHeader className="text-center">
                <div className="flex justify-center">
                  <img src={logo} alt="Telegram Vault" width={64} height={64} className="mb-4 mt-4 rounded-lg" />
                </div>
                <CardTitle className="text-xl">You're signed in</CardTitle>
                <CardDescription>
                  {user?.email ?? user?.name ?? "Your account"} is connected. Use this same verified email with Google or email login on your other devices to open this vault.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 pb-6">
                <Button className="w-full" onClick={() => navigate(redirect, { replace: true })}>
                  Continue to the vault <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <Button variant="outline" className="w-full" onClick={handleSignOut} disabled={signingOut}>
                  {signingOut ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogOut className="mr-2 h-4 w-4" />}
                  Sign out
                </Button>
                {error && <p className="text-center text-sm text-red-500">{error}</p>}
              </CardContent>
            </>
          ) : step === "signIn" ? (
            <>
              <CardHeader className="text-center">
                <div className="flex justify-center">
                  <img src={logo} alt="Telegram Vault" width={64} height={64} className="mb-4 mt-4 rounded-lg" />
                </div>
                <CardTitle className="text-xl">Sign in to Telegram Vault</CardTitle>
                <CardDescription>Use Google or a verified email code. The same email always opens the same account.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <form onSubmit={handleEmailSubmit} className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input name="email" placeholder="name@example.com" type="email" autoComplete="email" className="pl-9" disabled={isLoading} required />
                  </div>
                  <Button type="submit" variant="outline" size="icon" aria-label="Continue with email" disabled={isLoading}>
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  </Button>
                </form>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
                  <div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">Or</span></div>
                </div>
                <Button type="button" variant="outline" className="w-full" onClick={handleGoogleLogin} disabled={isLoading}>
                  <GoogleIcon className="mr-2 h-4 w-4" /> Continue with Google
                </Button>
                {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className="mt-4 text-center">
                <CardTitle>Check your email</CardTitle>
                <CardDescription>We've sent a sign-in code to {step.email}</CardDescription>
              </CardHeader>
              <form onSubmit={handleOtpSubmit}>
                <CardContent className="pb-4">
                  <div className="flex justify-center">
                    <InputOTP value={otp} onChange={setOtp} maxLength={6} disabled={isLoading}>
                      <InputOTPGroup>
                        {Array.from({ length: 6 }).map((_, index) => <InputOTPSlot key={index} index={index} />)}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                  {error && <p role="alert" className="mt-2 text-center text-sm text-red-500">{error}</p>}
                  <p className="mt-4 text-center text-sm text-muted-foreground">
                    Didn't receive a code?{" "}
                    <Button type="button" variant="link" className="h-auto p-0" onClick={() => { setStep("signIn"); setOtp(""); }} disabled={isLoading}>Try again</Button>
                  </p>
                </CardContent>
                <CardFooter className="flex-col gap-2">
                  <Button type="submit" className="w-full" disabled={isLoading || otp.length !== 6}>
                    {isLoading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying...</> : <>Verify code <ArrowRight className="ml-2 h-4 w-4" /></>}
                  </Button>
                  <Button type="button" variant="ghost" className="w-full" onClick={() => { setStep("signIn"); setOtp(""); }} disabled={isLoading}>Use different email</Button>
                </CardFooter>
              </form>
            </>
          )}
          <div className="rounded-b-lg border-t bg-muted px-6 py-4 text-center text-xs text-muted-foreground">
            Your account is securely synced across devices.
          </div>
        </Card>
      </div>
    </div>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3.02h3.88c2.27-2.09 3.54-5.17 3.54-8.89z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.01c-1.08.72-2.45 1.16-4.05 1.16-3.13 0-5.78-2.11-6.73-4.96H1.26v3.11A11.99 11.99 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.28A7.19 7.19 0 0 1 4.89 12c0-.79.14-1.56.38-2.28V6.61H1.26A12 12 0 0 0 0 12c0 1.94.46 3.77 1.26 5.39l4.01-3.11z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.7 0 3.99 2.47 1.26 6.61l4.01 3.11C6.22 6.86 8.87 4.75 12 4.75z" />
    </svg>
  );
}

export default function AuthPage(props: AuthProps) {
  return <Suspense><Auth {...props} /></Suspense>;
}
