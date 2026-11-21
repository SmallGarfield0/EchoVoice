<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";

  export let source = "";
  export let startMS = 0;
  export let endMS = 0;
  export let title = "";
  export let description = "";
  export let startLabel = "";
  export let endLabel = "";
  export let loadingLabel = "";
  export let unavailableLabel = "";
  export let onRangeChange: (startMS: number, endMS: number) => void = () => {};
  export let onDurationChange: (durationMS: number) => void = () => {};

  let canvas: HTMLCanvasElement | null = null;
  let root: HTMLDivElement | null = null;
  let durationMS = 0;
  let peaks: number[] = [];
  let loading = false;
  let failed = false;
  let mounted = false;
  let loadedSource = "";
  let loadGeneration = 0;
  let resizeObserver: ResizeObserver | null = null;

  $: effectiveEndMS = endMS > 0 ? Math.min(endMS, durationMS || endMS) : durationMS;
  $: maximumStartMS = Math.max(0, effectiveEndMS - 10);
  $: minimumEndMS = Math.min(durationMS, startMS + 10);
  $: selectionStartPercent = durationMS > 0 ? Math.min(100, Math.max(0, startMS / durationMS * 100)) : 0;
  $: selectionEndPercent = durationMS > 0 ? Math.min(100, Math.max(selectionStartPercent, effectiveEndMS / durationMS * 100)) : 100;
  $: selectionStyle = `--soundboard-selection-start: ${selectionStartPercent}%; --soundboard-selection-end: ${selectionEndPercent}%;`;
  $: if (mounted && source !== loadedSource) void loadWaveform(source);
  $: if (mounted && canvas && peaks.length > 0) {
    selectionStartPercent;
    selectionEndPercent;
    drawWaveform();
  }

  onMount(() => {
    mounted = true;
    resizeObserver = new ResizeObserver(() => drawWaveform());
    if (root) resizeObserver.observe(root);
    void loadWaveform(source);
  });

  onDestroy(() => {
    mounted = false;
    loadGeneration += 1;
    resizeObserver?.disconnect();
  });

  async function loadWaveform(nextSource: string) {
    const generation = ++loadGeneration;
    loadedSource = nextSource;
    durationMS = 0;
    peaks = [];
    failed = false;
    loading = Boolean(nextSource);
    if (!nextSource) {
      loading = false;
      return;
    }
    let context: AudioContext | null = null;
    try {
      const response = await fetch(nextSource);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      context = new AudioContext({ latencyHint: "playback" });
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (!mounted || generation !== loadGeneration) return;
      durationMS = Math.max(1, Math.round(buffer.duration * 1000));
      peaks = extractPeaks(buffer, 192);
      startMS = Math.min(Math.max(0, startMS), Math.max(0, durationMS - 10));
      if (endMS > durationMS) endMS = 0;
      onDurationChange(durationMS);
      onRangeChange(startMS, endMS);
      await tick();
      drawWaveform();
    } catch {
      if (mounted && generation === loadGeneration) failed = true;
    } finally {
      if (context) void context.close().catch(() => undefined);
      if (mounted && generation === loadGeneration) loading = false;
    }
  }

  function extractPeaks(buffer: AudioBuffer, bucketCount: number) {
    const values = Array.from({ length: bucketCount }, () => 0);
    const samplesPerBucket = Math.max(1, Math.floor(buffer.length / bucketCount));
    const sampleStride = Math.max(1, Math.floor(samplesPerBucket / 160));
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const from = bucket * samplesPerBucket;
      const to = Math.min(buffer.length, from + samplesPerBucket);
      let peak = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const samples = buffer.getChannelData(channel);
        for (let index = from; index < to; index += sampleStride) {
          peak = Math.max(peak, Math.abs(samples[index] ?? 0));
        }
      }
      values[bucket] = Math.max(0.035, Math.min(1, peak));
    }
    return values;
  }

  function drawWaveform() {
    if (!canvas || peaks.length === 0) return;
    const cssWidth = Math.max(1, canvas.clientWidth);
    const cssHeight = Math.max(1, canvas.clientHeight);
    const scale = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssWidth * scale);
    canvas.height = Math.round(cssHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    const center = cssHeight / 2;
    const step = cssWidth / peaks.length;
    const barWidth = Math.max(1, step * 0.58);
    for (let index = 0; index < peaks.length; index += 1) {
      const positionPercent = index / Math.max(1, peaks.length - 1) * 100;
      const selected = positionPercent >= selectionStartPercent && positionPercent <= selectionEndPercent;
      const height = Math.max(2, peaks[index] * (cssHeight - 18));
      context.fillStyle = selected ? "rgba(142, 203, 255, 0.92)" : "rgba(142, 203, 255, 0.24)";
      context.fillRect(index * step + (step - barWidth) / 2, center - height / 2, barWidth, height);
    }
  }

  function updateStart(event: Event) {
    const next = Math.min(maximumStartMS, Math.max(0, Number((event.currentTarget as HTMLInputElement).value)));
    startMS = Math.round(next);
    onRangeChange(startMS, endMS);
  }

  function updateEnd(event: Event) {
    const next = Math.min(durationMS, Math.max(minimumEndMS, Number((event.currentTarget as HTMLInputElement).value)));
    endMS = durationMS - next <= 10 ? 0 : Math.round(next);
    onRangeChange(startMS, endMS);
  }

  function formatPosition(milliseconds: number) {
    const safe = Math.max(0, Math.round(milliseconds));
    const minutes = Math.floor(safe / 60_000);
    const seconds = Math.floor(safe % 60_000 / 1000);
    const millis = safe % 1000;
    return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }
</script>

<section class="soundboard-range-tool" bind:this={root} aria-label={title} style={selectionStyle}>
  <header>
    <div>
      <strong>{title}</strong>
      <small>{description}</small>
    </div>
    {#if durationMS > 0}<span>{formatPosition(durationMS)}</span>{/if}
  </header>

  <div class="waveform-shell" class:loading class:failed>
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
    <div class="selection-window" aria-hidden="true"></div>
    {#if durationMS > 0}
      <input
        class="range-handle start"
        type="range"
        min="0"
        max={maximumStartMS}
        step="10"
        value={startMS}
        aria-label={startLabel}
        aria-valuetext={formatPosition(startMS)}
        oninput={updateStart}
      />
      <input
        class="range-handle end"
        type="range"
        min={minimumEndMS}
        max={durationMS}
        step="10"
        value={effectiveEndMS}
        aria-label={endLabel}
        aria-valuetext={formatPosition(effectiveEndMS)}
        oninput={updateEnd}
      />
    {:else}
      <div class="waveform-status">
        <span class="material-symbols-rounded app-icon" aria-hidden="true">{failed ? "error" : "graphic_eq"}</span>
        <span>{failed ? unavailableLabel : loadingLabel}</span>
      </div>
    {/if}
  </div>

  <footer>
    <span><i class="start-marker" aria-hidden="true"></i>{startLabel}<b>{formatPosition(startMS)}</b></span>
    <span><i class="end-marker" aria-hidden="true"></i>{endLabel}<b>{endMS > 0 ? formatPosition(endMS) : durationMS > 0 ? formatPosition(durationMS) : "—"}</b></span>
  </footer>
</section>

<style>
  .soundboard-range-tool {
    display: grid;
    gap: 9px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--color-border);
    border-radius: 7px;
    background: #0b0d10;
  }

  header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 12px;
  }

  header > div {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  header strong {
    color: var(--color-text);
    font-size: 12px;
  }

  header small,
  header > span {
    color: var(--color-text-dim);
    font-size: 10px;
    line-height: 1.4;
  }

  header > span {
    flex: 0 0 auto;
    font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  }

  .waveform-shell {
    position: relative;
    height: 108px;
    overflow: hidden;
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
    background:
      linear-gradient(to bottom, transparent calc(50% - 0.5px), rgba(142, 203, 255, 0.12) 50%, transparent calc(50% + 0.5px)),
      #07090b;
  }

  canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
  }

  .selection-window {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--soundboard-selection-start);
    right: calc(100% - var(--soundboard-selection-end));
    border-right: 1px solid rgba(142, 203, 255, 0.72);
    border-left: 1px solid rgba(142, 203, 255, 0.72);
    background: rgba(142, 203, 255, 0.055);
    pointer-events: none;
  }

  .range-handle {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    pointer-events: none;
    appearance: none;
  }

  .range-handle::-webkit-slider-runnable-track {
    height: 100%;
    background: transparent;
  }

  .range-handle::-webkit-slider-thumb {
    width: 15px;
    height: 108px;
    margin-top: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    cursor: ew-resize;
    pointer-events: auto;
    appearance: none;
  }

  .range-handle::-moz-range-track {
    height: 100%;
    border: 0;
    background: transparent;
  }

  .range-handle::-moz-range-thumb {
    width: 15px;
    height: 108px;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: ew-resize;
    pointer-events: auto;
  }

  .range-handle:focus-visible {
    outline: 1px solid var(--color-accent);
    outline-offset: -2px;
  }

  .waveform-status {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 6px;
    color: var(--color-text-dim);
    font-size: 11px;
  }

  .waveform-status :global(.app-icon) {
    color: var(--color-accent);
    font-size: 25px;
  }

  .failed .waveform-status :global(.app-icon) {
    color: #ff9baa;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--color-text-muted);
    font-size: 10px;
  }

  footer > span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }

  footer b {
    color: var(--color-text);
    font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
    font-size: 10px;
    font-weight: 600;
  }

  footer i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-accent);
  }

  footer .end-marker {
    background: #d6e9f7;
  }
</style>
