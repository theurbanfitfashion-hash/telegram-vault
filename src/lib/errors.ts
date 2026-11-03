/** Normalises server/client errors into something worth showing a person. */
export function errorMessage(error: unknown): string {
  const candidate = error as { data?: unknown; message?: unknown } | null;
  // ConvexError carries its safe, user-facing message in the data field.
  // In production, message can be only the generic Server Error.
  const raw =
    typeof candidate?.data === "string"
      ? candidate.data
      : typeof candidate?.message === "string"
        ? candidate.message
        : typeof error === "string"
          ? error
          : "";
  const firstLine = raw.split("\n")[0] ?? "";
  const cleaned = firstLine
    .replace(/^Uncaught (Error|ConvexError):\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/\s+at\s+.*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || "Something went wrong. Please try again.";
}