import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { convexSiteUrl } from "@/lib/convex-site";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { Music2 } from "lucide-react";

type Props = { track: { _id: Id<"files">; name: string } };

function synchsafe(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

function artworkFromMp3(buffer: ArrayBuffer): Blob | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 10 || String.fromCharCode(...bytes.slice(0, 3)) !== "ID3") return null;
  const version = bytes[3];
  const end = Math.min(bytes.length, 10 + synchsafe(bytes, 6));
  let offset = 10;
  while (offset + 10 <= end) {
    const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = version === 3
      ? bytes[offset + 4] * 0x1000000 + bytes[offset + 5] * 0x10000 + bytes[offset + 6] * 0x100 + bytes[offset + 7]
      : synchsafe(bytes, offset + 4);
    if (size <= 0 || offset + 10 + size > end) break;
    if (id === "APIC") {
      const frame = bytes.slice(offset + 10, offset + 10 + size);
      let cursor = 1;
      while (cursor < frame.length && frame[cursor] !== 0) cursor++;
      const mime = new TextDecoder().decode(frame.slice(1, cursor)) || "image/jpeg";
      cursor += 2;
      if (frame[0] === 1 || frame[0] === 2) {
        while (cursor + 1 < frame.length && (frame[cursor] !== 0 || frame[cursor + 1] !== 0)) cursor += 2;
        cursor += 2;
      } else {
        while (cursor < frame.length && frame[cursor] !== 0) cursor++;
        cursor++;
      }
      return cursor < frame.length ? new Blob([frame.slice(cursor)], { type: mime }) : null;
    }
    offset += 10 + size;
  }
  return null;
}

export function PlayerArtwork({ track }: Props) {
  const createToken = useMutation(api.vault.createDownloadToken);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    if (!track.name.toLowerCase().endsWith(".mp3")) { setSrc(null); return; }
    createToken({ fileId: track._id }).then(async (token) => {
      const site = convexSiteUrl();
      if (!site || cancelled) return;
      const response = await fetch(`${site}/file/${token}`, { headers: { Range: "bytes=0-262143" } });
      if (!response.ok || cancelled) return;
      const blob = artworkFromMp3(await response.arrayBuffer());
      if (blob && !cancelled) {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [track._id, track.name, createToken]);
  return src ? <img src={src} alt="" className="h-full w-full object-cover" /> : <Music2 className="size-5 text-muted-foreground" />;
}
