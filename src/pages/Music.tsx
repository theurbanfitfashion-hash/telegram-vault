import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { convexSiteUrl } from "@/lib/convex-site";
import { formatBytes } from "@/lib/format";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft, AudioLines, Disc3, ListMusic, Loader2, Pause, Play,
  Repeat, Repeat1, SkipBack, SkipForward, Shuffle, Volume2, VolumeX, ListPlus, Plus, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";

type SavedPlaylist = { id: string; name: string; trackIds: string[] };

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
  const location = useLocation();
  const { isAuthenticated } = useAuth();
  const isPlayerPage = location.pathname === "/music";
  const files = useQuery(api.vault.listAllFiles, isAuthenticated && isPlayerPage ? {} : "skip");
  const createToken = useMutation(api.vault.createDownloadToken);
  const tracks = useMemo(() => (files ?? []).filter((file) => file.status === "ready" && isAudio(file)), [files]);
  const [activeId, setActiveId] = useState<Id<"files"> | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("off");
  const [upNext, setUpNext] = useState<Id<"files">[]>([]);
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>(() => {
    try { return JSON.parse(localStorage.getItem("telegram-vault:music-playlists:v1") ?? "[]") as SavedPlaylist[]; }
    catch { return []; }
  });
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("all");
  const audioRef = useRef<HTMLAudioElement>(null);
  const autoplayAfterLoad = useRef(false);
  const prefetchedTokens = useRef(new Map<Id<"files">, string>());
  const warmedTracks = useRef(new Set<Id<"files">>());
  const visibleTracks = selectedPlaylistId === "all"
    ? tracks
    : tracks.filter((track) => playlists.find((list) => list.id === selectedPlaylistId)?.trackIds.includes(track._id));
  const activeTrack = tracks.find((track) => track._id === activeId) ?? null;

  useEffect(() => {
    localStorage.setItem("telegram-vault:music-playlists:v1", JSON.stringify(playlists));
  }, [playlists]);

  const createPlaylist = () => {
    const name = window.prompt("Name your playlist");
    if (!name?.trim()) return;
    const playlist = { id: crypto.randomUUID(), name: name.trim(), trackIds: activeTrack ? [activeTrack._id] : [] };
    setPlaylists((current) => [...current, playlist]);
    setSelectedPlaylistId(playlist.id);
  };

  const addToPlaylist = (playlistId: string, trackId: Id<"files">) => {
    setPlaylists((current) => current.map((list) => list.id !== playlistId ? list : {
      ...list, trackIds: list.trackIds.includes(trackId) ? list.trackIds : [...list.trackIds, trackId],
    }));
  };

  const playNext = (trackId: Id<"files">) => {
    setUpNext((current) => [...current.filter((id) => id !== trackId), trackId]);
  };

  useEffect(() => {
    if (activeId && files !== undefined && !tracks.some((track) => track._id === activeId)) {
      setActiveId(null);
    }
  }, [tracks, activeId, files]);

  useEffect(() => {
    let cancelled = false;
    if (!activeTrack) { setSource(null); setLoadingSource(false); return; }
    setLoadingSource(true);
    setSource(null);
    setPlaying(false);
    setPlaybackError(null);
    setCurrentTime(0);
    setDuration(0);
    const cachedToken = prefetchedTokens.current.get(activeTrack._id);
    const tokenPromise = cachedToken
      ? Promise.resolve(cachedToken)
      : createToken({ fileId: activeTrack._id });
    tokenPromise
      .then((token) => {
        prefetchedTokens.current.set(activeTrack._id, token);
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

  // Fetch audio only when a track is selected. Background media warming
  // downloads complete Telegram parts for tiny browser byte-range requests.

  useEffect(() => {
    if (!activeTrack || !tracks.length) return;
    let cancelled = false;
    const queueIds = upNext.filter((id) => id !== activeTrack._id);
    const playbackPool = shuffle ? tracks : (visibleTracks.length ? visibleTracks : tracks);
    const pool = playbackPool
      .filter((track) => track._id !== activeTrack._id && !queueIds.includes(track._id));
    if (shuffle) {
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    } else {
      const currentIndex = playbackPool.findIndex((track) => track._id === activeTrack._id);
      const ordered = playbackPool
        .slice(currentIndex + 1)
        .filter((track) => !queueIds.includes(track._id));
      pool.splice(0, pool.length, ...ordered);
    }
    const nextIds = [...queueIds, ...pool.map((track) => track._id)].slice(0, 2);
    const site = convexSiteUrl();
    if (!site) return;
    void (async () => {
      for (const id of nextIds) {
        if (cancelled) return;
        try {
          let token = prefetchedTokens.current.get(id);
          if (!token) {
            token = await createToken({ fileId: id });
            if (cancelled) return;
            prefetchedTokens.current.set(id, token);
          }
          if (warmedTracks.current.has(id)) continue;
          const response = await fetch(`${site}/file/${token}`, {
            headers: { Range: "bytes=0-262143" },
          });
          if (!response.ok && response.status !== 206) continue;
          await response.arrayBuffer();
          warmedTracks.current.add(id);
        } catch (error) {
          console.debug("Next-track preloading skipped", error);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeTrack?._id, tracks, visibleTracks, upNext, shuffle, createToken]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted;
  }, [volume, muted, source]);

  const playTrack = useCallback(async (id: Id<"files">) => {
    autoplayAfterLoad.current = true;
    setActiveId(id);
    setPlaying(false);
    setPlaybackError(null);
  }, []);

  const next = useCallback(() => {
    if (!tracks.length) return;
    if (upNext.length) {
      autoplayAfterLoad.current = true;
      setActiveId(upNext[0]);
      setUpNext((current) => current.slice(1));
      setPlaying(false);
      return;
    }
    const queueTracks = visibleTracks.length ? visibleTracks : tracks;
    const index = queueTracks.findIndex((track) => track._id === activeTrack?._id);
    if ((shuffle && tracks.length > 1) || index < queueTracks.length - 1 || repeat === "all") {
      autoplayAfterLoad.current = true;
    }
    if (shuffle && tracks.length > 1) {
      let random = index;
      while (random === index) random = Math.floor(Math.random() * tracks.length);
      setActiveId(tracks[random]._id);
    } else if (index < queueTracks.length - 1) setActiveId(queueTracks[index + 1]._id);
    else if (repeat === "all") setActiveId(queueTracks[0]._id);
    else setPlaying(false);
    setPlaying(false);
  }, [tracks, visibleTracks, upNext, activeTrack?._id, shuffle, repeat]);

  const previous = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    const index = tracks.findIndex((track) => track._id === activeTrack?._id);
    if (index > 0) { autoplayAfterLoad.current = true; setActiveId(tracks[index - 1]._id); }
    else if (repeat === "all" && tracks.length) { autoplayAfterLoad.current = true; setActiveId(tracks[tracks.length - 1]._id); }
    setPlaying(false);
  }, [tracks, activeTrack?._id, repeat]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || !source) return;
    if (audio.paused) void audio.play().then(() => { setPlaybackError(null); setPlaying(true); }).catch((error: unknown) => { console.error("Audio playback failed", error); setPlaybackError("Playback was blocked or the audio format is unsupported. Tap Play again, or try downloading the file."); setPlaying(false); });
    else { audio.pause(); setPlaying(false); }
  };

  const audioElement = <audio className="hidden" ref={audioRef} src={source ?? undefined} preload="none" onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)} onCanPlay={() => { if (autoplayAfterLoad.current && audioRef.current) { autoplayAfterLoad.current = false; void audioRef.current.play().then(() => { setPlaybackError(null); setPlaying(true); }).catch((error: unknown) => { console.error("Automatic playback failed", error); setPlaybackError("Tap Play to start this track. Your browser blocked automatic playback."); setPlaying(false); }); } }} onEnded={() => { if (repeat === "one" && audioRef.current) { audioRef.current.currentTime = 0; void audioRef.current.play(); } else next(); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => { if (source) { setPlaying(false); setPlaybackError("The audio stream could not be loaded. Check the file format or try downloading it."); } }} />;

  if (!isAuthenticated || !isPlayerPage) return null;

  if (files === undefined) return <>{audioElement}<main className="grid min-h-dvh place-items-center bg-[#090d13] text-white"><Loader2 className="size-6 animate-spin text-cyan-300" /></main></>;

  return (
    <>
    {audioElement}
    <main className="min-h-dvh bg-[#090d13] text-white">
      <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col px-4 pb-4 pt-0 sm:px-8">
        <section className="grid flex-1 grid-cols-1 items-start gap-4 pt-3 pb-2 sm:gap-6 sm:pt-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)]">
          <div className="mx-auto w-full max-w-xl">
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="relative mx-auto mb-5 aspect-square w-full max-w-[340px] overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-[#17334a] via-[#132231] to-[#281b3b] p-5" style={{ maxWidth: "min(340px, 32dvh)" }}>
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

            <div className="mt-5">
              <div className="mb-2 flex justify-between font-mono text-[11px] text-white/45"><span>{clock(currentTime)}</span><span>{clock(duration)}</span></div>
              <input aria-label="Seek track" type="range" min={0} max={duration || 1} step={0.1} value={Math.min(currentTime, duration || 1)} onChange={(event) => { const time = Number(event.target.value); if (audioRef.current) audioRef.current.currentTime = time; setCurrentTime(time); }} className="h-1.5 w-full cursor-pointer accent-cyan-300" />
              <div className="mt-4 flex items-center justify-center gap-5">
                <button aria-label="Shuffle" onClick={() => setShuffle(!shuffle)} className={`rounded-full p-2 ${shuffle ? "text-cyan-300" : "text-white/45 hover:text-white"}`}><Shuffle className="size-4" /></button>
                <button aria-label="Previous track" onClick={previous} className="rounded-full p-2 text-white/80 hover:text-cyan-200"><SkipBack className="size-6" fill="currentColor" /></button>
                <button aria-label={playing ? "Pause" : "Play"} onClick={togglePlay} disabled={!activeTrack || loadingSource || !source} className="grid size-16 place-items-center rounded-full bg-cyan-300 text-[#07121c] transition-transform hover:scale-105 disabled:opacity-40">{playing ? <Pause className="size-6" fill="currentColor" /> : <Play className="ml-1 size-6" fill="currentColor" />}</button>
                <button aria-label="Next track" onClick={next} className="rounded-full p-2 text-white/80 hover:text-cyan-200"><SkipForward className="size-6" fill="currentColor" /></button>
                <button aria-label="Repeat mode" onClick={() => setRepeat((value) => value === "off" ? "all" : value === "all" ? "one" : "off")} className={`rounded-full p-2 ${repeat !== "off" ? "text-cyan-300" : "text-white/45 hover:text-white"}`}>{repeat === "one" ? <Repeat1 className="size-4" /> : <Repeat className="size-4" />}</button>
              </div>
              <div className="mt-4 flex items-center justify-center gap-3 text-white/50">
                <button aria-label="Mute" onClick={() => setMuted(!muted)}>{muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}</button>
                <input aria-label="Volume" type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(event) => { setVolume(Number(event.target.value)); setMuted(false); }} className="w-28 cursor-pointer accent-cyan-300" />
              </div>
            </div>
            {loadingSource ? <p className="mt-4 text-center text-xs text-white/40">Preparing audio stream…</p> : playbackError ? <p role="alert" className="mt-4 text-center text-xs text-rose-300">{playbackError}</p> : activeTrack && !source ? <p className="mt-4 text-center text-xs text-white/40">Audio link is not ready yet.</p> : null}

          </div>

          <aside className="mx-auto w-full max-w-xl overflow-hidden rounded-3xl border border-white/10 bg-white/[0.035]">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">Your music</p>
                <p className="mt-1 text-xs text-white/40">{visibleTracks.length} tracks · {upNext.length} queued next</p>
              </div>
              <button aria-label="Create playlist" title="Create playlist" onClick={createPlaylist} className="rounded-lg p-2 text-cyan-300 hover:bg-white/10"><Plus className="size-5" /></button>
              <ListMusic className="size-5 text-cyan-300" />
            </div>
            <div className="border-b border-white/10 px-4 py-3">
              <select aria-label="Choose playlist" value={selectedPlaylistId} onChange={(event) => setSelectedPlaylistId(event.target.value)} className="w-full rounded-lg border border-white/10 bg-[#111b29] px-3 py-2 text-sm text-white">
                <option value="all">All songs</option>
                {playlists.map((list) => <option key={list.id} value={list.id}>{list.name} ({list.trackIds.length})</option>)}
              </select>
            </div>
            {tracks.length === 0 ? (
              <div className="px-6 py-16 text-center"><Disc3 className="mx-auto size-9 text-white/25" /><p className="mt-4 font-medium">No music found yet</p><p className="mt-2 text-sm leading-6 text-white/45">Upload MP3, M4A, WAV, FLAC or OGG files anywhere in your Vault.</p><Button className="mt-5 bg-cyan-300 text-slate-950 hover:bg-cyan-200" onClick={() => navigate("/dashboard")}>Open Vault</Button></div>
            ) : (
              <div className="max-h-[55dvh] overflow-y-auto p-2">
                <AnimatePresence initial={false}>
                  {visibleTracks.map((track, index) => {
                    const selected = track._id === activeTrack?._id;
                    return <motion.div key={track._id} role="button" tabIndex={0} layout initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} onClick={() => void playTrack(track._id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void playTrack(track._id); } }} className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${selected ? "bg-cyan-300/10" : "hover:bg-white/[0.06]"}`}>
                      <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${selected ? "bg-cyan-300 text-slate-950" : "bg-white/[0.07] text-white/55"}`}>{selected && playing ? <AudioLines className="size-4" /> : <span className="font-mono text-xs">{String(index + 1).padStart(2, "0")}</span>}</span>
                      <span className="min-w-0 flex-1"><span className={`block truncate text-sm font-medium ${selected ? "text-cyan-200" : "text-white/85"}`}>{titleOf(track.name)}</span><span className="mt-1 block text-xs text-white/40">{formatBytes(track.size)}</span></span>
                      <span className="flex shrink-0 items-center gap-1">
                        <button type="button" title="Play this next" aria-label={`Play ${titleOf(track.name)} next`} onClick={(event) => { event.stopPropagation(); playNext(track._id); }} className="rounded-md p-1.5 text-white/35 hover:bg-white/10 hover:text-cyan-200"><SkipForward className="size-4" /></button>
                        {playlists.length > 0 && <button type="button" title="Add to playlist" aria-label={`Add ${titleOf(track.name)} to playlist`} onClick={(event) => { event.stopPropagation(); const target = selectedPlaylistId === "all" ? playlists[0] : playlists.find((list) => list.id === selectedPlaylistId); if (playlists.length) {
                          const chosen = window.prompt(`Add to which playlist? Enter a name:\\n${playlists.map((list) => list.name).join("\\n")}`);
                          const destination = playlists.find((list) => list.name.toLowerCase() === chosen?.trim().toLowerCase());
                          if (destination) addToPlaylist(destination.id, track._id);
                        } }} className="rounded-md p-1.5 text-white/35 hover:bg-white/10 hover:text-cyan-200"><ListPlus className="size-4" /></button>}
                        {selected ? <Pause className="size-4 text-cyan-300" /> : <Play className="size-4 text-white/35" />}
                      </span>
                    </motion.div>;
                  })}
                </AnimatePresence>
              </div>
            )}
            {playlists.length > 0 && <div className="border-t border-white/10 px-4 py-3 text-xs text-white/45">Select a playlist, then use <ListPlus className="inline size-3.5" /> on a song to add it. New playlists start with the current song.</div>}
            {upNext.length > 0 && <div className="border-t border-white/10 px-4 py-3">
              <div className="mb-2 flex items-center justify-between text-xs font-semibold text-white/60"><span>Up next ({upNext.length})</span><button onClick={() => setUpNext([])} className="text-white/40 hover:text-white">Clear</button></div>
              {upNext.slice(0, 3).map((id) => <div key={id} className="flex items-center justify-between py-1 text-xs text-white/55"><span className="truncate">{titleOf(tracks.find((track) => track._id === id)?.name ?? "Unavailable track")}</span><button aria-label="Remove from queue" onClick={() => setUpNext((current) => current.filter((item) => item !== id))}><X className="size-3.5" /></button></div>)}
            </div>}
          </aside>
        </section>
        <footer className="text-center text-[11px] tracking-wide text-white/25">PRIVATE AUDIO LIBRARY · STORED IN YOUR TELEGRAM CHAT</footer>
      </div>
    </main>
    </>
  );
}
