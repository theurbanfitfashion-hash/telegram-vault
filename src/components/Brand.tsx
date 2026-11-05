import { cn } from "@/lib/utils";

/** Telegram cloud mark used across the app. */
export function BrandMark({ className, glyphClassName }: { className?: string; glyphClassName?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-[#061431]", className)} aria-hidden="true">
      <svg viewBox="0 0 64 64" fill="none" className={cn("size-[88%]", glyphClassName)}>
        <defs><linearGradient id="vault-cloud-gradient" x1="10" y1="9" x2="53" y2="54" gradientUnits="userSpaceOnUse"><stop stopColor="#35E5F2"/><stop offset="1" stopColor="#0865F5"/></linearGradient></defs>
        <path d="M17.2 49.2h30.1a10.2 10.2 0 0 0 1.1-20.3 16.8 16.8 0 0 0-32.1-3.8 12.2 12.2 0 0 0 .9 24.1Z" stroke="url(#vault-cloud-gradient)" strokeWidth="4.1" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="m17.5 31.1 31-12.2c1.4-.5 2.7.8 2.2 2.2L39 51.7c-.5 1.3-2.3 1.5-3 .3l-6.1-10.2-10.5-6.8c-1.4-.9-1.1-3.2.5-3.9Z" fill="#fff"/>
        <path d="m29.9 41.8 20.1-21.1-13.7 24.1-6.4-3Z" fill="#83C7FF"/>
      </svg>
    </span>
  );
}
export function BrandWordmark({ className, markClassName, compact = false }: { className?: string; markClassName?: string; compact?: boolean }) {
  return <span className={cn("flex min-w-0 items-center gap-2.5", className)}><BrandMark className={cn("size-8", markClassName)}/>{!compact && <span className="min-w-0"><span className="block truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">Telegram Vault</span></span>}</span>;
}
