import { cn } from "@/lib/utils";

/**
 * The vault mark: a folder with a keyhole — the storage is yours alone.
 */
export function BrandMark({
  className,
  glyphClassName,
}: {
  className?: string;
  glyphClassName?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[11px] bg-[var(--brand)] text-[var(--brand-foreground)]",
        className,
      )}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn("size-[62%]", glyphClassName)}
      >
        <path d="M3.75 7.6A2.35 2.35 0 0 1 6.1 5.25h2.86c.63 0 1.23.3 1.6.81l.9 1.2c.2.26.51.42.84.42h5.6a2.35 2.35 0 0 1 2.35 2.35v5.9a2.35 2.35 0 0 1-2.35 2.35H6.1A2.35 2.35 0 0 1 3.75 16z" />
        <circle cx="12" cy="13.1" r="1.65" />
        <path d="M12 14.75v1.6" />
      </svg>
    </span>
  );
}

export function BrandWordmark({
  className,
  markClassName,
  compact = false,
}: {
  className?: string;
  markClassName?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <BrandMark className={cn("size-8", markClassName)} />
      {!compact && (
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            Telegram Vault
          </span>
        </span>
      )}
    </span>
  );
}
