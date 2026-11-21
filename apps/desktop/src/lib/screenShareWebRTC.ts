import type { ScreenShareContentMode } from "./screenShareSettings";

export type ScreenShareCodecCapability = {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  sdpFmtpLine?: string;
};

export type ScreenShareOutboundSample = {
  id: string;
  timestampMS: number;
  bytesSent?: number;
  framesEncoded?: number;
  framesSent?: number;
  captureFps?: number;
  keyFramesEncoded?: number;
  totalEncodeTimeSeconds?: number;
  retransmittedBytesSent?: number;
  frameWidth?: number;
  frameHeight?: number;
  reportedFramesPerSecond?: number;
  targetBitrateBps?: number;
  qualityLimitationReason?: string;
  qualityLimitationResolutionChanges?: number;
  nackCount?: number;
  pliCount?: number;
  codecMimeType: string;
  codecFmtpLine: string;
};

export type ScreenShareSenderTelemetry = {
  effectiveContentMode?: "detail" | "balanced" | "motion";
  changedArea?: number;
  qualityTier?: number;
  adaptationReason?: "cpu" | "bandwidth" | "recovery";
  availableBps?: number;
  measuredAtMS: number;
  sentFps?: number;
  captureFps?: number;
  bitrateBps?: number;
  encodedFramesPerSecond?: number;
  averageEncodeTimeMS?: number;
  frameWidth?: number;
  frameHeight?: number;
  targetBitrateBps?: number;
  qualityLimitationReason?: string;
  qualityLimitationResolutionChanges?: number;
  keyFramesEncoded?: number;
  retransmittedBitrateBps?: number;
  nackCount?: number;
  pliCount?: number;
  codecMimeType: string;
  codecFmtpLine: string;
};

const screenSharePrimaryCodecOrder: Record<ScreenShareContentMode, string[]> = {
  detail: ["video/vp9", "video/h264", "video/vp8", "video/av1"],
  balanced: ["video/h264", "video/vp9", "video/vp8", "video/av1"],
  smart: ["video/h264", "video/vp9", "video/vp8", "video/av1"],
  motion: ["video/h264", "video/vp9", "video/vp8", "video/av1"]
};

/**
 * The order used once software encoding would cost more than it saves.
 *
 * VP9 compresses screen content slightly better than H.264 at an identical
 * bitrate, which is why detail mode asks for it first. That trade only holds
 * while the encoder keeps up: a mesh share runs one encoder per viewer, and
 * VP9/AV1 have hardware encoders on far fewer machines than H.264. Past a
 * point the software encoder becomes the bottleneck and every viewer watches
 * the result, so we prefer the codec that is hardware accelerated nearly
 * everywhere instead of the one that is a few percent smaller.
 */
const screenShareHardwareCodecOrder = ["video/h264", "video/vp9", "video/vp8", "video/av1"];

/** Pixel throughput (all viewers combined) at which software encoding is a risk. */
export const screenShareHardwareEncodeLoad = 1920 * 1080 * 30;

export type ScreenShareCodecLoad = {
  width: number;
  height: number;
  frameRate: number;
  /** Number of simultaneous encoders this sender runs, i.e. one per viewer. */
  encoders: number;
};

export function screenShareCodecOrder(
  mode: ScreenShareContentMode,
  load?: ScreenShareCodecLoad
): string[] {
  if (!load) return screenSharePrimaryCodecOrder[mode];
  const pixelsPerSecond =
    Math.max(1, load.width) * Math.max(1, load.height) * Math.max(1, load.frameRate);
  const combinedLoad = pixelsPerSecond * Math.max(1, load.encoders);
  return combinedLoad >= screenShareHardwareEncodeLoad
    ? screenShareHardwareCodecOrder
    : screenSharePrimaryCodecOrder[mode];
}

const screenSharePrimaryCodecMimeTypes = new Set([
  "video/h264",
  "video/vp9",
  "video/vp8",
  "video/av1"
]);

export function orderScreenShareCodecs<T extends ScreenShareCodecCapability>(
  codecs: readonly T[],
  mode: ScreenShareContentMode,
  load?: ScreenShareCodecLoad
): T[] {
  const order = screenShareCodecOrder(mode, load);
  const groups: Array<{ codecs: T[]; index: number }> = [];
  const supplemental: T[] = [];
  let currentGroup: { codecs: T[]; index: number } | null = null;
  codecs.forEach((codec, index) => {
    const mimeType = codec.mimeType.toLowerCase();
    if (screenSharePrimaryCodecMimeTypes.has(mimeType)) {
      currentGroup = { codecs: [codec], index };
      groups.push(currentGroup);
      return;
    }
    if (mimeType === "video/rtx" && currentGroup) {
      currentGroup.codecs.push(codec);
      return;
    }
    supplemental.push(codec);
  });
  groups.sort((left, right) => {
    const leftRank = codecRank(left.codecs[0].mimeType, order);
    const rightRank = codecRank(right.codecs[0].mimeType, order);
    return leftRank - rightRank || left.index - right.index;
  });
  return [...groups.flatMap((group) => group.codecs), ...supplemental];
}

export function deriveScreenShareSenderTelemetry(
  previous: ScreenShareOutboundSample | undefined,
  current: ScreenShareOutboundSample
): ScreenShareSenderTelemetry {
  const elapsedMS = previous?.id === current.id
    ? Math.max(0, current.timestampMS - previous.timestampMS)
    : 0;
  const bytesDelta = counterDelta(previous?.bytesSent, current.bytesSent);
  const retransmittedBytesDelta = counterDelta(
    previous?.retransmittedBytesSent,
    current.retransmittedBytesSent
  );
  const framesDelta = counterDelta(previous?.framesEncoded, current.framesEncoded);
  const sentDelta = counterDelta(previous?.framesSent, current.framesSent);
  const encodeTimeDelta = counterDelta(
    previous?.totalEncodeTimeSeconds,
    current.totalEncodeTimeSeconds
  );
  const measuredFramesPerSecond = elapsedMS > 0 && framesDelta !== undefined
    ? framesDelta * 1_000 / elapsedMS
    : undefined;

  return {
    measuredAtMS: current.timestampMS,
    sentFps: elapsedMS > 0 && sentDelta !== undefined ? sentDelta * 1000 / elapsedMS : undefined,
    captureFps: current.captureFps,
    bitrateBps: elapsedMS > 0 && bytesDelta !== undefined ? bytesDelta * 8_000 / elapsedMS : undefined,
    encodedFramesPerSecond: current.reportedFramesPerSecond ?? measuredFramesPerSecond,
    averageEncodeTimeMS: framesDelta && encodeTimeDelta !== undefined ? encodeTimeDelta * 1_000 / framesDelta : undefined,
    frameWidth: current.frameWidth,
    frameHeight: current.frameHeight,
    targetBitrateBps: current.targetBitrateBps,
    qualityLimitationReason: current.qualityLimitationReason,
    qualityLimitationResolutionChanges: current.qualityLimitationResolutionChanges,
    keyFramesEncoded: current.keyFramesEncoded,
    retransmittedBitrateBps: elapsedMS > 0 && retransmittedBytesDelta !== undefined ? retransmittedBytesDelta * 8_000 / elapsedMS : undefined,
    nackCount: current.nackCount,
    pliCount: current.pliCount,
    codecMimeType: current.codecMimeType,
    codecFmtpLine: current.codecFmtpLine
  };
}

function codecRank(mimeType: string, order: string[]) {
  const index = order.indexOf(mimeType.toLowerCase());
  return index < 0 ? order.length : index;
}

function counterDelta(previous: number | undefined, current: number | undefined) {
  if (previous === undefined || current === undefined || !Number.isFinite(current) || !Number.isFinite(previous) || current < previous) return undefined;
  return current - previous;
}
