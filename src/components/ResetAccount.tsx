import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

export function ResetAccount() {
  const beginReset = useMutation(api.vault.beginAccountReset);
  const status = useQuery(api.vault.getAccountResetStatus);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started && status?.isResetting === false) {
      toast.success("Account reset complete. You can now connect a new Telegram bot.");
      setStarted(false);
    }
  }, [started, status?.isResetting]);

  const reset = async () => {
    const confirmed = window.confirm(
      "Reset this Telegram Vault account? This removes files and folders from the app, clears the bot connection, and releases the bot. The actual files already stored in Telegram will NOT be deleted. This cannot be undone."
    );
    if (!confirmed || busy || status?.isResetting) return;

    setBusy(true);
    try {
      await beginReset({});
      setStarted(true);
      toast("Account reset started", {
        description: "Your app records are being cleared. Telegram files will remain untouched.",
      });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-destructive/40 p-4 text-left">
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert className="h-4 w-4 text-destructive" />
        Reset account
      </div>
      <p className="text-sm text-muted-foreground">
        Start fresh with another Telegram bot. This clears your app's file and folder records, upload/download sessions, and current bot connection. Your Google account stays active.
      </p>
      <p className="text-xs text-muted-foreground">
        Important: files already stored in your Telegram chat are not deleted. They will no longer appear in this vault after the reset.
      </p>
      <Button
        type="button"
        variant="destructive"
        className="w-full"
        onClick={reset}
        disabled={busy || status === undefined || status.isResetting}
      >
        {busy || status?.isResetting ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="mr-2 h-4 w-4" />
        )}
        {status?.isResetting ? "Resetting account…" : busy ? "Starting reset…" : "Reset account"}
      </Button>
      {status?.isResetting ? (
        <p role="status" className="text-xs text-muted-foreground">
          Reset is running safely in the background. Keep this account signed in; the page will update when it is complete.
        </p>
      ) : null}
    </section>
  );
}
