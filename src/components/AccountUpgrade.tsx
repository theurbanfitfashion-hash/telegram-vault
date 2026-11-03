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

  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true); setError(null);
    try {
      const form = new FormData(); form.set("email", email.trim());
      await signIn("email-otp", form);
      setStep("code");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not send code."); }
    finally { setLoading(false); }
  };

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true); setError(null);
    try {
      const form = new FormData(); form.set("email", email.trim()); form.set("code", code.trim());
      await signIn("email-otp", form);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not verify code."); }
    finally { setLoading(false); }
  };

  return <div className="rounded-lg border p-4 space-y-3">
    <div><p className="font-medium">Save this guest vault across devices</p><p className="text-sm text-muted-foreground">Add a verified email to this account. Your existing files and folders stay in this vault.</p></div>
    {step === "email" ? <form onSubmit={sendCode} className="flex gap-2">
      <div className="relative flex-1"><Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"/><Input className="pl-9" type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" disabled={loading}/></div>
      <Button type="submit" disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin"/> : <ArrowRight className="h-4 w-4"/>}</Button>
    </form> : <form onSubmit={verifyCode} className="flex gap-2">
      <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={e=>setCode(e.target.value)} placeholder="6-digit email code" disabled={loading}/>
      <Button type="submit" disabled={loading || code.length !== 6}>{loading ? <Loader2 className="h-4 w-4 animate-spin"/> : "Verify"}</Button>
    </form>}
    {step === "code" && <button className="text-xs underline text-muted-foreground" onClick={()=>{setStep("email");setCode("");}}>Use a different email</button>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
  </div>;
}
