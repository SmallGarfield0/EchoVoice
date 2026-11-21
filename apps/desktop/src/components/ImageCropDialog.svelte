<script lang="ts">
  import { onDestroy } from "svelte";

  export let source: string;
  export let eyebrow = "EchoVoice";
  export let title: string;
  export let description = "";
  export let ariaLabel = title;
  export let cancelLabel = "Cancel";
  export let applyLabel = "Apply";
  export let busyLabel = "Processing...";
  export let closeLabel = "Close";
  export let zoomLabel = "Zoom";
  export let horizontalLabel = "Horizontal";
  export let verticalLabel = "Vertical";
  export let invalidMessage = "Unable to process this image.";
  export let outputSize = 256;
  export let maxOutputBytes = 96 * 1024;
  export let roundPreview = false;
  export let onApply: (dataURL: string) => void | Promise<void> = () => {};
  export let onCancel: () => void = () => {};

  let zoom = 1;
  let xPercent = 50;
  let yPercent = 50;
  let busy = false;
  let errorMessage = "";
  let previewCanvas: HTMLCanvasElement | null = null;
  let image: HTMLImageElement | null = null;
  let loadedSource = "";
  let loadSequence = 0;
  let drag: { pointerId: number; clientX: number; clientY: number; x: number; y: number } | null = null;

  $: if (source && source !== loadedSource) void loadSource(source);
  $: renderPreview(previewCanvas, image, zoom, xPercent, yPercent);

  onDestroy(() => {
    loadSequence += 1;
    image = null;
    drag = null;
  });

  async function loadSource(nextSource: string) {
    const sequence = ++loadSequence;
    loadedSource = nextSource;
    zoom = 1;
    xPercent = 50;
    yPercent = 50;
    errorMessage = "";
    image = null;
    try {
      const loaded = await loadImage(nextSource);
      if (sequence === loadSequence) image = loaded;
    } catch {
      if (sequence === loadSequence) errorMessage = invalidMessage;
    }
  }

  function loadImage(imageSource: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = reject;
      element.src = imageSource;
    });
  }

  function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function cropRect(target: HTMLImageElement, cropZoom: number, cropX: number, cropY: number) {
    const naturalWidth = Math.max(1, target.naturalWidth);
    const naturalHeight = Math.max(1, target.naturalHeight);
    const size = Math.max(1, Math.min(naturalWidth, naturalHeight) / Math.max(1, cropZoom));
    return {
      x: Math.max(0, naturalWidth - size) * clamp(cropX, 0, 100) / 100,
      y: Math.max(0, naturalHeight - size) * clamp(cropY, 0, 100) / 100,
      size
    };
  }

  function renderPreview(
    canvas: HTMLCanvasElement | null,
    target: HTMLImageElement | null,
    cropZoom: number,
    cropX: number,
    cropY: number
  ) {
    if (!canvas || !target) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    const crop = cropRect(target, cropZoom, cropX, cropY);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(target, crop.x, crop.y, crop.size, crop.size, 0, 0, canvas.width, canvas.height);
  }

  function zoomCrop(event: WheelEvent) {
    if (busy) return;
    const direction = event.deltaY < 0 ? 1 : -1;
    zoom = clamp(Math.round((zoom + direction * 0.1) * 100) / 100, 1, 3);
  }

  function startDrag(event: PointerEvent) {
    if (busy || event.button !== 0) return;
    const preview = event.currentTarget as HTMLElement;
    preview.setPointerCapture(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: xPercent,
      y: yPercent
    };
  }

  function moveDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const horizontalDelta = ((event.clientX - drag.clientX) / bounds.width) * (100 / zoom);
    const verticalDelta = ((event.clientY - drag.clientY) / bounds.height) * (100 / zoom);
    xPercent = clamp(drag.x - horizontalDelta, 0, 100);
    yPercent = clamp(drag.y - verticalDelta, 0, 100);
  }

  function endDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const preview = event.currentTarget as HTMLElement;
    if (preview.hasPointerCapture(event.pointerId)) preview.releasePointerCapture(event.pointerId);
    drag = null;
  }

  async function applyCrop() {
    if (!image || busy) return;
    busy = true;
    errorMessage = "";
    try {
      const canvas = document.createElement("canvas");
      canvas.width = outputSize;
      canvas.height = outputSize;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error(invalidMessage);
      const crop = cropRect(image, zoom, xPercent, yPercent);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, outputSize, outputSize);
      const encoded = await encodeWebP(canvas, maxOutputBytes);
      await onApply(await blobToDataURL(encoded));
    } catch {
      errorMessage = invalidMessage;
    } finally {
      busy = false;
    }
  }

  async function encodeWebP(canvas: HTMLCanvasElement, maximumBytes: number) {
    let smallest: Blob | null = null;
    for (let quality = 0.92; quality >= 0.2; quality -= 0.08) {
      const encoded = await canvasToBlob(canvas, "image/webp", quality);
      if (!smallest || encoded.size < smallest.size) smallest = encoded;
      if (encoded.size <= maximumBytes) return encoded;
    }
    if (smallest && smallest.size <= maximumBytes) return smallest;
    throw new Error(invalidMessage);
  }

  function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(invalidMessage)), type, quality);
    });
  }

  function blobToDataURL(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(invalidMessage));
      reader.onerror = () => reject(reader.error ?? new Error(invalidMessage));
      reader.readAsDataURL(blob);
    });
  }
</script>

{#if source}
<div class="image-crop-backdrop" role="presentation">
  <dialog class="image-crop-dialog" open aria-label={ariaLabel}>
    <header>
      <div>
        <p class="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      <button type="button" aria-label={closeLabel} disabled={busy} onclick={onCancel}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
      </button>
    </header>

    {#if description}<p class="image-crop-description">{description}</p>{/if}

    <div
      class="image-crop-preview"
      class:dragging={Boolean(drag)}
      class:round={roundPreview}
      role="application"
      aria-label={ariaLabel}
      onwheel={(event) => { event.preventDefault(); const handler = (zoomCrop); if (handler) return handler(event); }}
      onpointerdown={startDrag}
      onpointermove={moveDrag}
      onpointerup={endDrag}
      onpointercancel={endDrag}
    >
      <canvas bind:this={previewCanvas} width="600" height="600" aria-hidden="true"></canvas>
      <span class="image-crop-guide" aria-hidden="true"></span>
      {#if !image && !errorMessage}<span class="image-crop-loading">{busyLabel}</span>{/if}
    </div>

    <div class="image-crop-controls">
      <label>
        <span><span class="material-symbols-rounded app-icon" aria-hidden="true">zoom_in</span>{zoomLabel}</span>
        <input type="range" min="1" max="3" step="0.01" bind:value={zoom} disabled={busy || !image} />
      </label>
      <label>
        <span><span class="material-symbols-rounded app-icon" aria-hidden="true">swap_horiz</span>{horizontalLabel}</span>
        <input type="range" min="0" max="100" step="1" bind:value={xPercent} disabled={busy || !image} />
      </label>
      <label>
        <span><span class="material-symbols-rounded app-icon" aria-hidden="true">swap_vert</span>{verticalLabel}</span>
        <input type="range" min="0" max="100" step="1" bind:value={yPercent} disabled={busy || !image} />
      </label>
    </div>

    {#if errorMessage}<p class="image-crop-error" role="alert">{errorMessage}</p>{/if}

    <footer>
      <button type="button" disabled={busy} onclick={onCancel}>{cancelLabel}</button>
      <button class="primary" type="button" disabled={busy || !image} onclick={() => void applyCrop()}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">crop</span>
        <span>{busy ? busyLabel : applyLabel}</span>
      </button>
    </footer>
  </dialog>
</div>
{/if}

<style>
  .image-crop-backdrop {
    position: fixed;
    inset: 0;
    z-index: 170;
    display: grid;
    place-items: center;
    padding: 20px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.76);
  }

  .image-crop-dialog {
    position: relative;
    inset: auto;
    display: grid;
    gap: 16px;
    width: min(520px, calc(100vw - 40px));
    max-height: calc(100vh - 40px);
    margin: 0;
    padding: 20px;
    overflow-x: hidden;
    overflow-y: auto;
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    color: var(--color-text);
    background: #111315;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.65);
    scrollbar-color: var(--scrollbar-thumb) transparent;
    scrollbar-width: thin;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    margin-top: 4px;
    font-size: 18px;
    letter-spacing: 0;
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

  .image-crop-description {
    color: var(--color-text-muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .image-crop-preview {
    position: relative;
    justify-self: center;
    width: min(300px, 70vw);
    aspect-ratio: 1;
    overflow: hidden;
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    background: var(--color-black);
    cursor: grab;
    touch-action: none;
    user-select: none;
    overscroll-behavior: contain;
  }

  .image-crop-preview.round,
  .image-crop-preview.round .image-crop-guide {
    border-radius: 50%;
  }

  .image-crop-preview.dragging {
    cursor: grabbing;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
    pointer-events: none;
    user-select: none;
    -webkit-user-drag: none;
  }

  .image-crop-guide {
    position: absolute;
    inset: 0;
    border: 2px solid rgba(155, 220, 255, 0.82);
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.62);
    pointer-events: none;
  }

  .image-crop-loading {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--color-text-muted);
    font-size: 12px;
    pointer-events: none;
  }

  .image-crop-controls {
    display: grid;
    gap: 12px;
  }

  .image-crop-controls label {
    display: grid;
    grid-template-columns: 150px minmax(0, 1fr);
    align-items: center;
    gap: 12px;
  }

  .image-crop-controls label > span {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--color-text-muted);
    font-size: 12px;
  }

  input[type="range"] {
    width: 100%;
    accent-color: var(--color-accent);
  }

  .image-crop-error {
    color: var(--color-danger);
    font-size: 12px;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  footer button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 96px;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 6px;
    color: var(--color-text);
    background: var(--color-surface-3);
  }

  footer button.primary {
    color: var(--color-accent-text);
    background: var(--color-accent);
  }

  button:disabled,
  input:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  @media (max-width: 620px) {
    .image-crop-controls label {
      grid-template-columns: minmax(0, 1fr);
      gap: 6px;
    }
  }
</style>
