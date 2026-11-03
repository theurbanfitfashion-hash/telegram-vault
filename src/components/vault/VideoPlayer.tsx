import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function timeLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export default function VideoPlayer({ src, title, onError }: { src: string; title: string; onError: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  // Keep the native media element in sync with React controls on every mount.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
    video.playbackRate = speed;
  }, [volume, muted, speed, src]);

  const revealControls = () => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playing) hideTimer.current = setTimeout(() => setControlsVisible(false), 2600);
  };
  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch((error) => { console.error("Video playback failed", error); onError(); });
    else video.pause();
  };
  const seekBy = (amount: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + amount));
  };
  const toggleFullscreen = async () => {
    if (!shellRef.current) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shellRef.current.requestFullscreen();
    } catch { /* Fullscreen may be unavailable in embedded browsers. */ }
  };
  const togglePip = async () => {
    const video = videoRef.current;
    if (!video || !("pictureInPictureEnabled" in document)) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { /* PiP is not supported in every browser. */ }
  };

  return (
    <div ref={shellRef} className="group relative flex h-full w-full items-center justify-center overflow-hidden bg-[#05070b]" onMouseMove={revealControls} onTouchStart={revealControls} onClick={revealControls}>
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="metadata"
        className="max-h-full max-w-full"
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onPlay={() => { setPlaying(true); revealControls(); }}
        onPause={() => { setPlaying(false); setControlsVisible(true); }}
        onEnded={() => setPlaying(false)}
        onError={onError}
        onClick={togglePlay}
      />
      <div className={cn("absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/65 to-transparent px-3 pb-3 pt-14 transition-opacity duration-200 sm:px-5 sm:pb-5", controlsVisible ? "opacity-100" : "pointer-events-none opacity-0")}>
        <p className="mb-2 truncate text-xs font-medium text-white/80">{title}</p>
        <input aria-label="Seek video" type="range" min={0} max={duration || 1} step={0.1} value={Math.min(current, duration || 1)} onChange={(e) => { const t=Number(e.target.value); if(videoRef.current) videoRef.current.currentTime=t; setCurrent(t); }} className="mb-2 h-1.5 w-full cursor-pointer accent-cyan-300" />
        <div className="flex items-center gap-2 text-white sm:gap-3">
          <Button variant="ghost" size="icon" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay} className="size-9 text-white hover:bg-white/15 hover:text-white">{playing ? <Pause className="size-5" /> : <Play className="size-5" />}</Button>
          <Button variant="ghost" size="icon" aria-label="Back 10 seconds" onClick={() => seekBy(-10)} className="size-9 text-white hover:bg-white/15 hover:text-white"><RotateCcw className="size-4" /><span className="sr-only">10</span></Button>
          <Button variant="ghost" size="icon" aria-label="Forward 10 seconds" onClick={() => seekBy(10)} className="size-9 text-white hover:bg-white/15 hover:text-white"><RotateCw className="size-4" /></Button>
          <span className="min-w-[86px] font-mono text-[11px] text-white/75">{timeLabel(current)} / {timeLabel(duration)}</span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Mute" onClick={() => setMuted(!muted)} className="size-9 text-white hover:bg-white/15 hover:text-white">{muted || volume===0 ? <VolumeX className="size-4"/> : <Volume2 className="size-4"/>}</Button>
            <input aria-label="Volume" type="range" min={0} max={1} step={0.05} value={muted?0:volume} onChange={(e)=>{setVolume(Number(e.target.value));setMuted(false);if(videoRef.current)videoRef.current.volume=Number(e.target.value);}} className="hidden w-20 cursor-pointer accent-cyan-300 sm:block"/>
            <select aria-label="Playback speed" value={speed} onChange={(e)=>{const v=Number(e.target.value);setSpeed(v);if(videoRef.current)videoRef.current.playbackRate=v;}} className="h-8 rounded-md border border-white/15 bg-black/50 px-1.5 text-xs text-white outline-none">
              {[0.5,0.75,1,1.25,1.5,1.75,2].map(v=><option key={v} value={v}>{v}x</option>)}
            </select>
            <Button variant="ghost" size="icon" aria-label="Picture in picture" onClick={togglePip} className="size-9 text-white hover:bg-white/15 hover:text-white"><PictureInPicture2 className="size-4"/></Button>
            <Button variant="ghost" size="icon" aria-label={fullscreen?"Exit fullscreen":"Fullscreen"} onClick={toggleFullscreen} className="size-9 text-white hover:bg-white/15 hover:text-white">{fullscreen?<Minimize className="size-4"/>:<Maximize className="size-4"/>}</Button>
          </div>
        </div>
      </div>
      {!playing && <button onClick={togglePlay} aria-label="Play video" className="absolute grid size-16 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm transition hover:scale-105"><Play className="ml-1 size-7" fill="currentColor"/></button>}
    </div>
  );
}
