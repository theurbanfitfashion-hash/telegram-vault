import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { Check, Copy, Link2, Loader2, ShieldAlert } from "lucide-react";

export function GuestVaultLink() {
  const { user } = useAuth();
  const createCode = useMutation(api.vault.createGuestVaultLinkCode);
  const linkVault = useMutation(api.vault.linkGuestVault);
  const linkStatus = useQuery(api.vault.getGuestVaultLinkStatus);
  const [code, setCode] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isGuest = user?.isAnonymous === true;

  const generateCode = async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const result = await createCode({});
      setCode(result.code);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create a linking code.");
    } finally {
      setLoading(false);
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setError("Copy was blocked by your browser. Select and copy the code manually.");
    }
  };

  const claimVault = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);
    try {
      await linkVault({ code: claimCode.trim().toLowerCase() });
      setSuccess(true);
      setClaimCode("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not link this guest vault.");
    } finally {
      setLoading(false);
    }
  };

  if (isGuest) {
    return (
      <div className="space-y-3 rounded-lg border p-4 text-left">
        <div className="flex items-center gap-2 font-medium">
          <Link2 className="h-4 w-4" /> Link this guest vault to Google
        </div>
        <p className="text-sm text-muted-foreground">
          Generate a one-time code here, then sign out and sign in with the Google account you want to use. Enter the code there. Your files stay in their current vault; nothing is copied or deleted.
        </p>
        {code ? (
          <div className="space-y-2">
            <div className="break-all rounded-md bg-muted p-3 font-mono text-xs select-all">{code}</div>
            <Button type="button" variant="outline" className="w-full" onClick={copyCode}>
              {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
              {copied ? "Copied" : "Copy linking code"}
            </Button>
            <p className="text-xs text-muted-foreground">This code expires in 10 minutes and can be used once. Keep it private.</p>
          </div>
        ) : (
          <Button type="button" className="w-full" onClick={generateCode} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
            Generate one-time linking code
          </Button>
        )}
        <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Guest bot-token login remains enabled. Anyone who has the bot token can still open this shared vault.
        </div>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      </div>
    );
  }

  if (linkStatus === undefined) {
    return <div className="rounded-lg border p-4 text-sm text-muted-foreground">Checking account link status…</div>;
  }

  if (linkStatus.linked || success) {
    return (
      <div className="rounded-lg border p-4 text-left">
        <p className="flex items-center gap-2 font-medium text-green-700 dark:text-green-400">
          <Check className="h-4 w-4" /> Google/email account linked
        </p>
        <p className="mt-1 text-sm text-muted-foreground">This sign-in now opens your original guest vault. Your existing file and folder records were left in place.</p>
      </div>
    );
  }

  return (
    <form onSubmit={claimVault} className="space-y-3 rounded-lg border p-4 text-left">
      <div className="flex items-center gap-2 font-medium">
        <Link2 className="h-4 w-4" /> Finish linking your guest vault
      </div>
      <p className="text-sm text-muted-foreground">
        Paste the one-time code you generated while signed in with your previous bot-token guest login.
      </p>
      <Input
        value={claimCode}
        onChange={(event) => setClaimCode(event.target.value)}
        placeholder="Paste 64-character linking code"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={64}
        required
        disabled={loading}
      />
      <Button type="submit" className="w-full" disabled={loading || claimCode.trim().length !== 64}>
        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
        Link existing guest vault
      </Button>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      {success && <p className="text-sm text-green-700">Vault linked successfully.</p>}
    </form>
  );
}
