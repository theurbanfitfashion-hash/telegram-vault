import { BrandMark } from "@/components/Brand";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  ArrowRight,
  Check,
  Loader2,
  LogOut,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

export interface TelegramStatus {
  hasToken: boolean;
  botUsername: string | null;
  chatConnected: boolean;
  chatTitle: string | null;
}

function Step({
  index,
  title,
  state,
  children,
}: {
  index: number;
  title: string;
  state: "todo" | "active" | "done";
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3.5">
      <span
        className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold",
          state === "done"
            ? "border-transparent bg-[var(--brand)] text-[var(--brand-foreground)]"
            : state === "active"
              ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-soft-foreground)]"
              : "border-border text-muted-foreground",
        )}
      >
        {state === "done" ? <Check className="size-4" /> : index}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <p
          className={cn(
            "text-sm font-medium leading-7 tracking-[-0.005em]",
            state === "todo" && "text-muted-foreground",
          )}
        >
          {title}
        </p>
        {children}
      </div>
    </li>
  );
}

/**
 * Connect a bot once. Its Telegram destination is shared by all accounts
 * that connect the same bot, so other devices never need to press Start.
 */
export function ConnectPanel({
  status,
  connected,
  onConnected,
  onBack,
}: {
  status: TelegramStatus;
  /** True when the panel is shown as a "change bot" detour, not first run. */
  connected: boolean;
  onConnected: () => void;
  onBack?: () => void;
}) {
  const connectBot = useAction(api.telegram.connectBot);
  const detectChat = useAction(api.telegram.detectChat);
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<null | "bot" | "chat">(null);
  const [error, setError] = useState<string | null>(null);

  const hasBot = status.hasToken && !!status.botUsername;
  const done = status.hasToken && status.chatConnected;

  // This screen is full-page (no sidebar), so without an escape hatch a
  // guest who lands here has no way back to a sign-in form.
  async function handleSignOut() {
    try {
      await signOut();
    } finally {
      navigate("/auth");
    }
  }

  async function submitToken(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy("bot");
    setError(null);
    try {
      await connectBot({ botToken: token });
      setToken("");
      onConnected();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function findChat() {
    if (busy) return;
    setBusy("chat");
    setError(null);
    try {
      await detectChat({});
      onConnected();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <BrandMark className="size-10" />
            <div>
              <p className="text-[15px] font-semibold tracking-[-0.01em]">
                Connect your Telegram vault
              </p>
              <p className="text-sm text-muted-foreground">
                Two minutes of setup, once. Then it's just folders and files.
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-muted-foreground"
            onClick={handleSignOut}
          >
            <LogOut className="mr-2 size-4" />
            Sign out
          </Button>
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-7">
          <ol className="space-y-6">
            <Step
              index={1}
              title="Make a bot in @BotFather"
              state={hasBot ? "done" : "active"}
            >
              <p className="-mt-2 text-sm leading-6 text-muted-foreground">
                Send <span className="font-mono-nums text-foreground">/newbot</span>{" "}
                and copy the token it replies with. This bot becomes your
                storage account.
              </p>
              <Button asChild variant="outline" size="sm">
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Send className="mr-2 size-4" />
                  Open @BotFather
                </a>
              </Button>
            </Step>

            <Step
              index={2}
              title="Paste the bot token"
              state={hasBot ? "done" : "active"}
            >
              {hasBot ? (
                <p className="-mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                  Connected as{" "}
                  <span className="font-mono-nums text-foreground">
                    @{status.botUsername}
                  </span>
                </p>
              ) : (
                <form onSubmit={submitToken} className="-mt-1 space-y-2.5">
                  <Label htmlFor="bot-token" className="sr-only">
                    Bot token
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="bot-token"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      placeholder="123456789:AA..."
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy !== null}
                      className="font-mono-nums"
                    />
                    <Button
                      type="submit"
                      disabled={busy !== null || token.trim().length === 0}
                      className="shrink-0"
                    >
                      {busy === "bot" ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : null}
                      Connect
                    </Button>
                  </div>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldCheck className="size-3.5 shrink-0" />
                    The token stays on the server — it never reaches your
                    browser.
                  </p>
                </form>
              )}
            </Step>

            <Step
              index={3}
              title="Say hello to your bot"
              state={done ? "done" : hasBot ? "active" : "todo"}
            >
              {done ? (
                <p className="-mt-2 text-sm text-muted-foreground">
                  Storing in your chat
                  {status.chatTitle ? (
                    <>
                      {" "}
                      with{" "}
                      <span className="text-foreground">{status.chatTitle}</span>
                    </>
                  ) : null}
                  .
                </p>
              ) : (
                <div className="-mt-1 space-y-3">
                  <p className="text-sm leading-6 text-muted-foreground">
                    The bot owner must open this bot in Telegram and press{" "}
                    <span className="font-medium text-foreground">Start</span> once.
                    After that, every account using this bot can use the same storage
                    destination without opening Telegram again.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      disabled={!hasBot}
                    >
                      <a
                        href={
                          status.botUsername
                            ? `https://t.me/${status.botUsername}`
                            : "https://t.me"
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Send className="mr-2 size-4" />
                        Open my bot
                      </a>
                    </Button>
                    <Button
                      size="sm"
                      onClick={findChat}
                      disabled={!hasBot || busy !== null}
                    >
                      {busy === "chat" ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <ArrowRight className="mr-2 size-4" />
                      )}
                      I pressed Start
                    </Button>
                  </div>
                </div>
              )}
            </Step>
          </ol>

          {error ? (
            <p className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="mt-7 flex items-center justify-between gap-3 border-t border-border/70 pt-5">
            <p className="text-xs text-muted-foreground">
              {connected
                ? "You can come back here any time to change bots."
                : "One bot destination can be reused across your devices and accounts."}
            </p>
            <div className="flex gap-2">
              {connected && onBack ? (
                <Button variant="outline" size="sm" onClick={onBack}>
                  Back to vault
                </Button>
              ) : null}
              {done ? (
                <Button size="sm" onClick={onConnected}>
                  Open my vault
                  <ArrowRight className="ml-2 size-4" />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
