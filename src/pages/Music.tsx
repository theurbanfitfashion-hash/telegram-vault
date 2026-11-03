import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { convexSiteUrl } from "@/lib/convex-site";
import { formatBytes } from "@/lib/format";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft, AudioLines, Disc3, ListMusic, Loader2, Pause, Play,
  Repeat, Repeat1, SkipBack, SkipForward, Shuffle, Volume2, VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

type Track = {
  _id: Id<"files">;
  name: string;
  size: number;
  mimeType: string;
  status: string;
};

function isAudio(file: Track) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.mimeType.startsWith("audio/") ||
    ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma"].includes(ext);
}
function titleOf(name: string) { return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "); }
function clock(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

export default function Music() {
  const navigate = useNavigate();
  const files = useQuery(api.vault.listFiles, { folderId: null });
  const createToken = useMutation(api.vault.createDownloadToken);
  const tracks = useMemo(() => (files ?? []).filter((file) => file.status === "ready" && isAudio(file)), [files]);
  const [activeId, setActiveId] = useState<Id<"files"> | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("off");
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeTrack = tracks.find((track) => track._id === activeId) ?? tracks[0] ?? null;

  useEffect(() => {
    if (!activeId && tracks.length) setActiveId(tracks[0]._id);
    if (activeId && !tracks.some((track) => track._id === activeId)) setActiveId(tracks[0]?._id ?? null);
  }, [tracks, activeId]);

  useEffect(() => {
    let cancelled = false;
    if (!activeTrack) { setSource(null); return; }
    setLoadingSource(true);
    setSource(null);
    setCurrentTime(0);
    createToken({ fileId: activeTrack._id })
      .then((token) => {
        const site = convexSiteUrl();
        if (!site) throw new Error("The media endpoint is not configured.");
        if (!cancelled) setSource(`${site}/file/${token}`);
      })
      .catch((error: unknown) => {
        console.error(error);
        if (!cancelled) setSource(null);
      })
      .finally(() => { if (!cancelled) setLoadingSource(false); });
    return () => { cancelled = true; };
  }, [activeTrack?._id, createToken]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted;
  }, [volume, muted, source]);

  const playTrack = useCallback(async (id: Id<"files">) => {
    setActiveId(id);
    setPlaying(true);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !source || !playing) return;
    void audio.play().catch(() => setPlaying(false));
  }, [source, playing]);

  const next = useCallback(() => {
    if (!tracks.length) return;
    const index = tracks.findIndex((track) => track._id === activeTrack?._id);
    if (shuffle && tracks.length > 1) {
      let random = index;
      while (random === index) random = Math.floor(Math.random() * tracks.length);
      setActiveId(tracks[random]._id);
    } else if (index < tracks.length - 1) setActiveId(tracks[index + 1]._id);
    else if (repeat === "all") setActiveId(tracks[0]._id);
    else setPlaying(false);
    setPlaying(true);
  }, [tracks, activeTrack?._id, shuffle, repeat]);

  const previous = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    const index = tracks.findIndex((track) => track._id === activeTrack?._id);
    if (index > 0) setActiveId(tracks[index - 1]._id);
    else if (repeat === "all" && tracks.length) setActiveId(tracks[tracks.length - 1]._id);
    setPlaying(true);
  }, [tracks, activeTrack?._id, repeat]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || !source) { setPlaying(true); return; }
    if (audio.paused) void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    else { audio.pause(); setPlaying(false); }
  };

  if (files === undefined) return <main className="grid min-h-dvh place-items-center bg-[#090d13] text-white"><Loader2 className="size-6 animate-spin text-cyan-300" /></main>;

  return (
    <main className="min-h-dvh overflow-hidden bg-[#090d13] text-white">
      <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col px-4 pb-8 pt-5 sm:px-8">
        <header className="flex items-center justify-between">
          <Button variant="ghost" className="text-white/70 hover:bg-white/10 hover:text-white" onClick={() => navigate("/dashboard")}>
            <ArrowLeft className="mr-2 size-4" /> Back to Vault
          </Button>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200/80"><AudioLines className="size-4" /> Vault Music</div>
        </header>

        <section className="grid flex-1 items-center gap-8 py-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,.85fr)]">
          <div className="mx-auto w-full max-w-xl">
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="relative mx-auto mb-9 aspect-square w-full max-w-[390px] overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-[#17334a] via-[#132231] to-[#281b3b] p-7">
              <div className="absolute inset-0 opacity-40" style={{ backgroundImage: "radial-gradient(circle at 25% 20%, #41d9d0 0, transparent 34%), radial-gradient(circle at 80% 80%, #a855f7 0, transparent 38%)" }} />
              <div className="relative flex h-full flex-col items-center justify-center">
                <div className="relative grid size-[68%] place-items-center rounded-full border border-white/20 bg-[#0b111b]/80">
                  <div className="absolute inset-[8%] rounded-full border border-white/10" />
                  <div className={`grid size-[46%] place-items-center rounded-full bg-gradient-to-br from-cyan-300 to-blue-500 text-[#07121c] ${playing ? "animate-[spin_12s_linear_infinite]" : ""}`}>
                    <Disc3 className="size-[68%]" strokeWidth={1.1} />
                  </div>
                  <span className="absolute size-3 rounded-full bg-[#d9faff]" />
                </div>
                <div className="absolute bottom-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.28em] text-white/50"><span className="size-1.5 rounded-full bg-cyan-300" /> Personal listening room</div>
              </div>
            </motion.div>

            <div className="text-center">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300/80">Now playing</p>
              <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{activeTrack ? titleOf(activeTrack.name) : "Choose your soundtrack"}</h1>
              <p className="mt-2 text-sm text-white/45">{activeTrack ? `${formatBytes(activeTrack.size)} · Telegram Vault` : "Your music collection lives here"}</p>
            </div>

            <div className="mt-8">
              <div className="mb-2 flex justify-between font-mono text-[11px] text-white/45"><span>{clock(currentTime)}</span><span>{clock(duration)}</span></div>
              <input aria-label="Seek track" type="range" min={0} max={duration || 1} step={0.1} value={Math.min(currentTime, duration || 1)} onChange={(event) => { const time = Number(event.target.value); if (audioRef.current) audioRef.current.currentTime = time; setCurrentTime(time); }} className="h-1.5 w-full cursor-pointer accent-cyan-300" />
              <div className="mt-5 flex items-center justify-center gap-5">
                <button aria-label="Shuffle" onClick={() => setShuffle(!shuffle)} className={`rounded-full p-2 ${shuffle ? "text-cyan-300" : "text-white/45 hover:text-white"}`}><Shuffle className="size-4" /></button>
                <button aria-label="Previous track" onClick={previous} className="rounded-full p-2 text-white/80 hover:text-cyan-200"><SkipBack className="size-6" fill="currentColor" /></button>
                <button aria-label={playing ? "Pause" : "Play"} onClick={togglePlay} disabled={!activeTrack} className="grid size-16 place-items-center rounded-full bg-cyan-300 text-[#07121c] transition-transform hover:scale-105 disabled:opacity-40">{playing ? <Pause className="size-6" fill="currentColor" /> : <Play className="ml-1 size-6" fill="currentColor" />}</button>
                <button aria-label="Next track" onClick={next} className="rounded-full p-2 text-white/80 hover:text-cyan-200"><SkipForward className="size-6" fill="currentColor" /></button>
                <button aria-label="Repeat mode" onClick={() => setRepeat((value) => value === "off" ? "all" : value === "all" ? "one" : "off")} className={`rounded-full p-2 ${repeat !== "off" ? "text-cyan-300" : "text-white/45 hover:text-white"}`}>{repeat === "one" ? <Repeat1 className="size-4" /> : <Repeat className="size-4" />}</button>
              </div>
              <div className="mt-6 flex items-center justify-center gap-3 text-white/50">
                <button aria-label="Mute" onClick={() => setMuted(!muted)}>{muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}</button>
                <input aria-label="Volume" type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(event) => { setVolume(Number(event.target.value)); setMuted(false); }} className="w-28 cursor-pointer accent-cyan-300" />
              </div>
            </div>
            {loadingSource ? <p className="mt-4 text-center text-xs text-white/40">Preparing audio stream…</p> : null}
            <audio ref={audioRef} src={source ?? undefined} preload="metadata" onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)} onEnded={() => { if (repeat === "one" && audioRef.current) { audioRef.current.currentTime = 0; void audioRef.current.play(); } else next(); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => { if (source) setPlaying(false); }} />
          </div>

          <aside className="mx-auto w-full max-w-xl overflow-hidden rounded-3xl border border-white/10 bg-white/[0.035]">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div><p className="font-semibold">Your playlist</p><p className="mt-1 text-xs text-white/40">{tracks.length} {tracks.length === 1 ? "track" : "tracks"} · Root folder</p></div>
              <ListMusic className="size-5 text-cyan-300" />
            </div>
            {tracks.length === 0 ? (
              <div className="px-6 py-16 text-center"><Disc3 className="mx-auto size-9 text-white/25" /><p className="mt-4 font-medium">No music found yet</p><p className="mt-2 text-sm leading-6 text-white/45">Upload MP3, M4A, WAV, FLAC or OGG files to the Vault root folder.</p><Button className="mt-5 bg-cyan-300 text-slate-950 hover:bg-cyan-200" onClick={() => navigate("/dashboard")}>Open Vault</Button></div>
            ) : (
              <div className="max-h-[520px] overflow-y-auto p-2">
                <AnimatePresence initial={false}>
                  {tracks.map((track, index) => {
                    const selected = track._id === activeTrack?._id;
                    return <motion.button key={track._id} layout initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} onClick={() => void playTrack(track._id)} className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${selected ? "bg-cyan-300/10" : "hover:bg-white/[0.06]"}`}>
                      <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${selected ? "bg-cyan-300 text-slate-950" : "bg-white/[0.07] text-white/55"}`}>{selected && playing ? <AudioLines className="size-4" /> : <span className="font-mono text-xs">{String(index + 1).padStart(2, "0")}</span>}</span>
                      <span className="min-w-0 flex-1"><span className={`block truncate text-sm font-medium ${selected ? "text-cyan-200" : "text-white/85"}`}>{titleOf(track.name)}</span><span className="mt-1 block text-xs text-white/40">{formatBytes(track.size)}</span></span>
                      {selected ? <Pause className="size-4 text-cyan-300" /> : <Play className="size-4 text-white/35" />}
                    </motion.button>;
                  })}
                </AnimatePresence>
              </div>
            )}
          </aside>
        </section>
        <footer className="text-center text-[11px] tracking-wide text-white/25">PRIVATE AUDIO LIBRARY · STORED IN YOUR TELEGRAM CHAT</footer>
      </div>
    </main>
  );
}
