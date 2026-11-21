<script lang="ts">
  import { onDestroy } from "svelte";

  export let file: File;
  export let source: string;
  export let title: string;
  export let description: string;
  export let previewLabel: string;
  export let zoomLabel: string;
  export let rotateLeftLabel: string;
  export let rotateRightLabel: string;
  export let cancelLabel: string;
  export let applyLabel: string;
  export let useOriginalLabel: string;
  export let gifNotice: string;
  export let closeLabel: string;
  export let processingLabel: string;
  export let invalidMessage: string;
  export let outputSize = 256;
  export let onApply: (file: File) => void | Promise<void> = () => {};
  export let onUseOriginal: (file: File) => void | Promise<void> = () => {};
  export let onCancel: () => void = () => {};

  let image: HTMLImageElement | null = null;
  let previewCanvas: HTMLCanvasElement | null = null;
  let sampleCanvas: HTMLCanvasElement | null = null;
  let zoom = 1;
  let xPercent = 50;
  let yPercent = 50;
  let rotation = 0;
  let busy = false;
  let errorMessage = "";
  let loadedSource = "";
  let loadSequence = 0;
  let drag: { pointerId: number; clientX: number; clientY: number; x: number; y: number } | null = null;

  $: if (source && source !== loadedSource) void loadSource(source);
  $: renderCanvas(previewCanvas, image, zoom, xPercent, yPercent, rotation);
  $: renderCanvas(sampleCanvas, image, zoom, xPercent, yPercent, rotation);

  onDestroy(() => {
    loadSequence += 1;
    image = null;
    drag = null;
  });

  function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  async function loadSource(nextSource: string) {
    const sequence = ++loadSequence;
    loadedSource = nextSource;
    image = null;
    zoom = 1;
    xPercent = 50;
    yPercent = 50;
    rotation = 0;
    errorMessage = "";
    try {
      const loaded = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = reject;
        element.src = nextSource;
      });
      if (sequence === loadSequence) image = loaded;
    } catch {
      if (sequence === loadSequence) errorMessage = invalidMessage;
    }
  }

  function renderCanvas(
    canvas: HTMLCanvasElement | null,
    target: HTMLImageElement | null,
    cropZoom: number,
    cropX: number,
    cropY: number,
    angle: number
  ) {
    if (!canvas || !target) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    const radians = angle * Math.PI / 180;
    const quarterTurn = Math.abs(angle % 180) === 90;
    const rotatedWidth = quarterTurn ? target.naturalHeight : target.naturalWidth;
    const rotatedHeight = quarterTurn ? target.naturalWidth : target.naturalHeight;
    const scale = Math.max(width / Math.max(1, rotatedWidth), height / Math.max(1, rotatedHeight)) * cropZoom;
    const overflowX = Math.max(0, rotatedWidth * scale - width);
    const overflowY = Math.max(0, rotatedHeight * scale - height);
    const offsetX = (50 - clamp(cropX, 0, 100)) / 50 * overflowX / 2;
    const offsetY = (50 - clamp(cropY, 0, 100)) / 50 * overflowY / 2;

    context.clearRect(0, 0, width, height);
    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.translate(width / 2 + offsetX, height / 2 + offsetY);
    context.rotate(radians);
    context.drawImage(
      target,
      -target.naturalWidth * scale / 2,
      -target.naturalHeight * scale / 2,
      target.naturalWidth * scale,
      target.naturalHeight * scale
    );
    context.restore();
  }

  function zoomImage(event: WheelEvent) {
    if (busy) return;
    zoom = clamp(Math.round((zoom + (event.deltaY < 0 ? 0.1 : -0.1)) * 100) / 100, 1, 4);
  }

  function rotate(delta: number) {
    if (busy) return;
    rotation = (rotation + delta + 360) % 360;
  }

  function startDrag(event: PointerEvent) {
    if (busy || event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: xPercent, y: yPercent };
  }

  function moveDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    xPercent = clamp(drag.x - (event.clientX - drag.clientX) / bounds.width * 100 / zoom, 0, 100);
    yPercent = clamp(drag.y - (event.clientY - drag.clientY) / bounds.height * 100 / zoom, 0, 100);
  }

  function endDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    drag = null;
  }

  async function applyEdit() {
    if (!image || busy) return;
    busy = true;
    errorMessage = "";
    try {
      const canvas = document.createElement("canvas");
      canvas.width = outputSize;
      canvas.height = outputSize;
      renderCanvas(canvas, image, zoom, xPercent, yPercent, rotation);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error(invalidMessage)), "image/webp", 0.94);
      });
      const baseName = file.name.replace(/\.[^.]+$/, "").trim() || "emoji";
      await onApply(new File([blob], `${baseName}.webp`, { type: "image/webp", lastModified: Date.now() }));
    } catch {
      errorMessage = invalidMessage;
    } finally {
      busy = false;
    }
  }

  async function useOriginal() {
    if (busy) return;
    busy = true;
    try {
      await onUseOriginal(file);
    } finally {
      busy = false;
    }
  }
</script>

{#if file && source}
<div class="emoji-editor-backdrop" role="presentation">
  <dialog class="emoji-editor-dialog" open aria-modal="true" aria-label={title}>
    <header>
      <div>
        <p>{description}</p>
        <h2>{title}</h2>
      </div>
      <button type="button" disabled={busy} aria-label={closeLabel} onclick={onCancel}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
      </button>
    </header>

    <div class="emoji-editor-workspace">
      <div
        class="emoji-editor-crop"
        class:dragging={Boolean(drag)}
        data-crop-x={xPercent.toFixed(2)}
        data-crop-y={yPercent.toFixed(2)}
        data-crop-zoom={zoom.toFixed(2)}
        data-crop-rotation={rotation}
        role="application"
        aria-label={title}
        onwheel={(event) => { event.preventDefault(); const handler = (zoomImage); if (handler) return handler(event); }}
        onpointerdown={startDrag}
        onpointermove={moveDrag}
        onpointerup={endDrag}
        onpointercancel={endDrag}
      >
        <canvas bind:this={previewCanvas} width="520" height="520" aria-hidden="true"></canvas>
        <span class="emoji-editor-guide" aria-hidden="true"></span>
        {#if !image && !errorMessage}<span class="emoji-editor-loading">{processingLabel}</span>{/if}
      </div>
      <aside>
        <span>{previewLabel}</span>
        <canvas bind:this={sampleCanvas} width="96" height="96" aria-hidden="true"></canvas>
        <small>{outputSize} × {outputSize}</small>
      </aside>
    </div>

    <div class="emoji-editor-controls">
      <label>
        <span><span class="material-symbols-rounded app-icon" aria-hidden="true">zoom_in</span>{zoomLabel}</span>
        <input type="range" min="1" max="4" step="0.01" bind:value={zoom} disabled={busy || !image} />
      </label>
      <div class="emoji-editor-rotate-actions">
        <button type="button" disabled={busy || !image} onclick={() => rotate(-90)}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">rotate_left</span>
          <span>{rotateLeftLabel}</span>
        </button>
        <button type="button" disabled={busy || !image} onclick={() => rotate(90)}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">rotate_right</span>
          <span>{rotateRightLabel}</span>
        </button>
      </div>
    </div>

    {#if file.type === "image/gif"}
      <p class="emoji-editor-gif-note"><span class="material-symbols-rounded app-icon" aria-hidden="true">animation</span>{gifNotice}</p>
    {/if}
    {#if errorMessage}<p class="emoji-editor-error" role="alert">{errorMessage}</p>{/if}

    <footer>
      <button type="button" disabled={busy} onclick={onCancel}>{cancelLabel}</button>
      {#if file.type === "image/gif"}
        <button type="button" disabled={busy} onclick={() => void useOriginal()}>{useOriginalLabel}</button>
      {/if}
      <button class="primary" type="button" disabled={busy || !image} onclick={() => void applyEdit()}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">crop_rotate</span>
        <span>{busy ? processingLabel : applyLabel}</span>
      </button>
    </footer>
  </dialog>
</div>
{/if}

<style>
  .emoji-editor-backdrop {
    position: fixed;
    inset: 0;
    z-index: 180;
    display: grid;
    place-items: center;
    padding: 20px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.78);
  }

  .emoji-editor-dialog {
    position: relative;
    inset: auto;
    display: grid;
    gap: 15px;
    width: min(610px, calc(100vw - 40px));
    max-height: calc(100vh - 40px);
    margin: 0;
    padding: 18px;
    overflow-x: hidden;
    overflow-y: auto;
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    color: var(--color-text);
    background: #101215;
    box-shadow: 0 24px 74px rgba(0, 0, 0, 0.68);
  }

  header,
  footer,
  .emoji-editor-rotate-actions {
    display: flex;
    align-items: center;
  }

  header {
    justify-content: space-between;
    gap: 14px;
  }

  header > div {
    display: grid;
    gap: 3px;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: 17px;
  }

  header p {
    color: var(--color-text-dim);
    font-size: 10px;
  }

  header > button {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border-radius: 6px;
    color: var(--color-text-muted);
    background: var(--color-surface-3);
  }

  .emoji-editor-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 118px;
    align-items: start;
    gap: 16px;
  }

  .emoji-editor-crop {
    position: relative;
    justify-self: center;
    width: min(360px, 62vw);
    aspect-ratio: 1;
    overflow: hidden;
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    background:
      linear-gradient(45deg, #090b0d 25%, transparent 25%),
      linear-gradient(-45deg, #090b0d 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #090b0d 75%),
      linear-gradient(-45deg, transparent 75%, #090b0d 75%),
      #14181c;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0;
    background-size: 20px 20px;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .emoji-editor-crop.dragging {
    cursor: grabbing;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .emoji-editor-guide {
    position: absolute;
    inset: 0;
    border: 2px solid rgba(142, 203, 255, 0.75);
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.62);
    pointer-events: none;
  }

  .emoji-editor-loading {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--color-text-muted);
    font-size: 11px;
  }

  aside {
    display: grid;
    place-items: center;
    gap: 8px;
    padding: 12px 10px;
    border: 1px solid var(--color-border);
    border-radius: 7px;
    color: var(--color-text-muted);
    background: var(--color-surface);
    font-size: 10px;
  }

  aside canvas {
    width: 72px;
    height: 72px;
    border-radius: 5px;
    background: #080a0c;
  }

  aside small {
    color: var(--color-text-dim);
    font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  }

  .emoji-editor-controls {
    display: grid;
    gap: 10px;
  }

  .emoji-editor-controls label {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    align-items: center;
    gap: 12px;
  }

  .emoji-editor-controls label > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-muted);
    font-size: 11px;
  }

  input[type="range"] {
    width: 100%;
    accent-color: var(--color-accent);
  }

  .emoji-editor-rotate-actions {
    justify-content: flex-end;
    gap: 8px;
  }

  .emoji-editor-rotate-actions button,
  footer button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 34px;
    padding: 0 11px;
    border-radius: 6px;
    color: var(--color-text-muted);
    background: var(--color-surface-3);
  }

  .emoji-editor-gif-note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 10px;
    border-left: 2px solid var(--color-accent);
    color: var(--color-text-muted);
    background: rgba(142, 203, 255, 0.06);
    font-size: 10px;
    line-height: 1.45;
  }

  .emoji-editor-error {
    color: var(--color-danger);
    font-size: 11px;
  }

  footer {
    justify-content: flex-end;
    gap: 8px;
  }

  footer button.primary {
    color: var(--color-accent-text);
    background: var(--color-accent);
  }

  button:disabled,
  input:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }

  @media (max-width: 620px) {
    .emoji-editor-workspace {
      grid-template-columns: minmax(0, 1fr);
    }

    aside {
      grid-template-columns: auto 56px auto;
      justify-content: center;
    }

    aside canvas {
      width: 56px;
      height: 56px;
    }
  }
</style>
