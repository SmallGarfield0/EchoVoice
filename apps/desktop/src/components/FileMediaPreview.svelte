<script lang="ts">
  export let src = "";
  export let kind: "video" | "audio" = "video";
  export let compact = false;
  export let playLabel = "Play";
  export let pauseLabel = "Pause";
  export let volumeLabel = "Volume";

  let mediaElement: HTMLMediaElement | null = null;
  let playing = false;
  let currentTime = 0;
  let duration = 0;
  let volume = 1;

  async function togglePlayback() {
    if (!mediaElement) return;
    if (mediaElement.paused) {
      try {
        await mediaElement.play();
      } catch {
        playing = false;
      }
    } else {
      mediaElement.pause();
    }
  }

  function updateTiming() {
    if (!mediaElement) return;
    currentTime = Number.isFinite(mediaElement.currentTime) ? mediaElement.currentTime : 0;
    duration = Number.isFinite(mediaElement.duration) ? mediaElement.duration : 0;
    playing = !mediaElement.paused && !mediaElement.ended;
  }

  function seek(event: Event) {
    if (!mediaElement) return;
    const input = event.currentTarget as HTMLInputElement;
    mediaElement.currentTime = Number(input.value) || 0;
    updateTiming();
  }

  function updateVolume(event: Event) {
    if (!mediaElement) return;
    const input = event.currentTarget as HTMLInputElement;
    volume = Math.max(0, Math.min(1, Number(input.value)));
    mediaElement.volume = volume;
  }

  function formatTime(value: number) {
    const total = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
</script>

<div class:audio={kind === "audio"} class:compact class="file-media-preview">
  {#if kind === "video"}
    <!-- Uploaded videos may not contain a captions track. -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={mediaElement}
      src={src}
      playsinline
      onloadedmetadata={updateTiming}
      ontimeupdate={updateTiming}
      onplay={updateTiming}
      onpause={updateTiming}
      onended={updateTiming}
    ></video>
  {:else}
    <div class="file-audio-visual" aria-hidden="true">
      <span class="material-symbols-rounded app-icon">graphic_eq</span>
    </div>
    <audio
      bind:this={mediaElement}
      src={src}
      onloadedmetadata={updateTiming}
      ontimeupdate={updateTiming}
      onplay={updateTiming}
      onpause={updateTiming}
      onended={updateTiming}
    ></audio>
  {/if}
  <div class="file-media-controls">
    <button type="button" aria-label={playing ? pauseLabel : playLabel} onclick={togglePlayback}>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">{playing ? "pause" : "play_arrow"}</span>
    </button>
    <span class="file-media-time">{formatTime(currentTime)}</span>
    <input
      class="file-media-seek"
      type="range"
      min="0"
      max={Math.max(0, duration)}
      step="0.01"
      value={currentTime}
      aria-label={playLabel}
      oninput={seek}
    />
    <span class="file-media-time">{formatTime(duration)}</span>
    <span class="material-symbols-rounded app-icon file-media-volume-icon" aria-hidden="true">
      {volume === 0 ? "volume_off" : volume < 0.5 ? "volume_down" : "volume_up"}
    </span>
    <input
      class="file-media-volume"
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={volume}
      aria-label={volumeLabel}
      oninput={updateVolume}
    />
  </div>
</div>

<style>
  .file-media-preview {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    width: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: #050505;
  }

  video {
    width: 100%;
    height: 100%;
    min-height: 0;
    object-fit: contain;
    background: #000;
  }

  audio {
    display: none;
  }

  .file-audio-visual {
    display: grid;
    place-items: center;
    min-height: 240px;
    color: #8ecbff;
    background: #080808;
  }

  .file-audio-visual .app-icon {
    font-size: 72px;
    opacity: 0.84;
  }

  .file-media-preview.compact:not(.audio) {
    aspect-ratio: 16 / 9;
  }

  .file-media-preview.compact.audio .file-audio-visual {
    min-height: 86px;
  }

  .file-media-preview.compact.audio .file-audio-visual .app-icon {
    font-size: 40px;
  }

  .file-media-preview.compact .file-media-controls {
    min-height: 42px;
    padding-block: 4px;
  }

  .file-media-controls {
    display: grid;
    grid-template-columns: 34px auto minmax(80px, 1fr) auto 22px minmax(72px, 120px);
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 48px;
    padding: 7px 10px;
    border-top: 1px solid #2b2b2b;
    background: #111;
  }

  button {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: #e8e8e8;
    background: transparent;
  }

  button:hover,
  button:focus-visible {
    color: #8ecbff;
    background: rgba(142, 203, 255, 0.1);
  }

  .file-media-time {
    color: #a9a9a9;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  input[type="range"] {
    min-width: 0;
    height: 4px;
    margin: 0;
    accent-color: #8ecbff;
  }

  .file-media-volume-icon {
    color: #a9a9a9;
    font-size: 18px;
  }

  @media (max-width: 680px) {
    .file-media-controls {
      grid-template-columns: 34px auto minmax(60px, 1fr) auto;
    }

    .file-media-volume-icon,
    .file-media-volume {
      display: none;
    }
  }
</style>
