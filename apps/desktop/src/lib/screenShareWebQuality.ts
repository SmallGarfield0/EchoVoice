import type { ScreenShareContentMode } from "./screenShareSettings";

export type WebQualityTier = 0 | 1 | 2;
type QualitySample = {
  atMS: number;
  availableBps?: number;
  rttMS?: number;
  actualBps?: number;
  encodeMS?: number;
  fps?: number;
  activeContent?: boolean;
  limitation?: string;
};

export function webScreenShareEncoding(tier: WebQualityTier, mode: ScreenShareContentMode, maxBps: number, maxFps: number) {
  const bitrate = Math.round(maxBps * [1, 0.7, 0.45][tier]);
  // Each knob affects only the sender for this subscriber. The shared capture
  // track retains its original source resolution and frame rate.
  const scale = mode === "detail" ? 1 : (mode === "motion" ? [1, 1.5, 2] : [1, 1.25, 1.75])[tier];
  const cadence = mode === "motion" ? 1 : (mode === "detail" ? [1, 0.75, 0.5] : [1, 0.85, 0.65])[tier];
  return { maxBitrate: bitrate, maxFramerate: Math.max(1, Math.round(maxFps * cadence)), scaleResolutionDownBy: scale };
}

export class WebScreenShareQualityController {
  tier: WebQualityTier = 0;
  reason?: "cpu" | "bandwidth" | "recovery";
  private stressed = 0;
  private healthy = 0;
  private lastMS = Number.NEGATIVE_INFINITY;
  private nextProbeMS = 0;
  private lastRttMS?: number;

  update(sample: QualitySample, ceilingBps: number, ceilingFps: number): boolean {
    if (!Number.isFinite(sample.atMS) || sample.atMS - this.lastMS < 900) return false;
    if (sample.atMS - this.lastMS > 3000) {
      this.stressed = this.healthy = 0;
      this.lastRttMS = undefined;
    }
    this.lastMS = sample.atMS;
    const risingRtt = this.lastRttMS !== undefined && sample.rttMS !== undefined &&
      sample.rttMS > this.lastRttMS * 1.25 + 10;
    this.lastRttMS = sample.rttMS;
    // The pacer estimate may fall on static content. Low throughput alone says
    // nothing about network capacity or picture quality.
    const moving = sample.activeContent === true || (sample.fps ?? 0) >= Math.min(5, ceilingFps);
    const encoderPressure = sample.limitation === "cpu" || (sample.encodeMS !== undefined && sample.encodeMS > 1000 / ceilingFps);
    const constrained = moving && (encoderPressure || sample.limitation === "bandwidth" ||
      (sample.availableBps !== undefined && sample.actualBps !== undefined &&
        sample.availableBps > 0 && sample.availableBps < ceilingBps * [1, 0.7, 0.45][this.tier] * 0.8 &&
        sample.actualBps > sample.availableBps * (risingRtt ? 0.7 : 0.85)));
    this.stressed = constrained ? this.stressed + 1 : 0;
    const nextBudget = ceilingBps * (this.tier === 2 ? 0.7 : 1);
    const canProbe = moving && !constrained &&
      (sample.limitation === "none" || (sample.availableBps ?? 0) >= nextBudget * 1.2);
    this.healthy = canProbe ? this.healthy + 1 : 0;
    if (this.stressed >= 2 && this.tier < 2) {
      this.reason = encoderPressure ? "cpu" : "bandwidth";
      this.tier = this.tier === 0 ? 1 : 2;
      this.stressed = this.healthy = 0;
      this.nextProbeMS = sample.atMS + 8000;
      return true;
    }
    if (this.healthy >= 5 && this.tier > 0 && sample.atMS >= this.nextProbeMS) {
      this.reason = "recovery";
      // A capped sender can suppress availableOutgoingBitrate discovery. A
      // bounded upward trial lets it recover after a healthy limited interval.
      this.tier = this.tier === 2 ? 1 : 0;
      this.stressed = this.healthy = 0;
      this.nextProbeMS = sample.atMS + 8000;
      return true;
    }
    return false;
  }
}
