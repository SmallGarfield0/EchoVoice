export type EffectiveScreenContent = "balanced" | "detail" | "motion";

// Compare a 32×18 thumbnail. Ignore small colour changes and sparse pointers.
export function changedScreenArea(previous: Uint8ClampedArray, next: Uint8ClampedArray) {
  let changed = 0;
  for (let i = 0; i < next.length; i += 4) {
    const difference = Math.abs(previous[i] - next[i]) + Math.abs(previous[i + 1] - next[i + 1]) +
      Math.abs(previous[i + 2] - next[i + 2]);
    if (difference >= 72) changed++;
  }
  return changed / (next.length / 4);
}

export class ScreenContentClassifier {
  mode: EffectiveScreenContent = "balanced";
  private motionWindows = 0;
  private quietWindows = 0;

  update(area: number) {
    this.motionWindows = area >= 0.18 ? this.motionWindows + 1 : 0;
    this.quietWindows = area <= 0.06 ? this.quietWindows + 1 : 0;
    if (this.motionWindows >= 2) this.mode = "motion";
    if (this.quietWindows >= 5) this.mode = "detail";
    return this.mode;
  }
}

/** One content observation per publisher, irrespective of subscriber count. */
export class ScreenShareContentMonitor {
  private track?: MediaStreamTrack;
  private video?: HTMLVideoElement;
  private context?: CanvasRenderingContext2D;
  private previous?: Uint8ClampedArray;
  private sampledAt = -Infinity;
  private classifier = new ScreenContentClassifier();
  changedArea?: number;

  sample(track: MediaStreamTrack, preview: HTMLVideoElement | null) {
    if (this.track !== track) {
      this.stop();
      this.track = track;
    }
    const now = performance.now();
    if (now - this.sampledAt < 900) return this.classifier.mode;
    if (now - this.sampledAt > 3500) this.clearEvidence();
    this.sampledAt = now;
    // Hidden pages can have a suspended renderer. Stale pixels carry no evidence.
    if (document.hidden || track.readyState !== "live" || track.muted) {
      this.clearEvidence();
      return this.classifier.mode;
    }
    const previewStream = preview?.srcObject;
    const readyPreview = preview && previewStream instanceof MediaStream &&
      previewStream.getVideoTracks()[0] === track && !preview.paused && preview.readyState >= 2;
    if (readyPreview) this.releaseVideo();
    else if (!this.video) {
      this.video = document.createElement("video");
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = new MediaStream([track]);
      void this.video.play().catch(() => undefined);
    }
    const node = readyPreview ? preview : this.video;
    if (!node || node.paused || node.readyState < 2 || !node.videoWidth) {
      this.clearEvidence();
      return this.classifier.mode;
    }
    try {
      if (!this.context) {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 18;
        this.context = canvas.getContext("2d", { willReadFrequently: true }) ?? undefined;
      }
      const context = this.context;
      if (!context) return this.classifier.mode;
      context.drawImage(node, 0, 0, 32, 18);
      const pixels = context.getImageData(0, 0, 32, 18).data;
      if (this.previous) {
        this.changedArea = changedScreenArea(this.previous, pixels);
        this.classifier.update(this.changedArea);
      }
      this.previous = pixels;
    } catch {
      this.clearEvidence();
    }
    return this.classifier.mode;
  }

  private clearEvidence() {
    this.previous = undefined;
    this.changedArea = undefined;
    this.classifier = new ScreenContentClassifier();
  }

  private releaseVideo() {
    if (!this.video) return;
    this.video.pause();
    this.video.srcObject = null;
    this.video = undefined;
  }

  stop() {
    this.releaseVideo();
    this.track = undefined;
    this.context = undefined;
    this.clearEvidence();
    this.sampledAt = -Infinity;
  }
}
