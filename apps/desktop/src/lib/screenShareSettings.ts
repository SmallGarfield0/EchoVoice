import type { DesktopMediaCapabilities } from "./types";

export type ScreenShareResolutionPreset = "source" | "480p" | "720p" | "1080p" | "1440p" | "2160p";
export type ScreenShareContentMode = "detail" | "balanced" | "motion" | "smart";
export type ScreenShareBitrateOption = "auto" | 2 | 4 | 6 | 8 | 12 | 20 | 32 | 48 | 64 | 80;

export const screenShareResolutionOptions: ScreenShareResolutionPreset[] = [
  "source",
  "480p",
  "720p",
  "1080p",
  "1440p",
  "2160p"
];

export const screenShareResolutionSizes: Record<
  Exclude<ScreenShareResolutionPreset, "source">,
  { width: number; height: number }
> = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "2160p": { width: 3840, height: 2160 }
};

export const defaultScreenShareFrameRates = [15, 24, 30, 45, 60, 90, 120];
export const screenShareBitrateOptions: ScreenShareBitrateOption[] = ["auto", 2, 4, 6, 8, 12, 20, 32, 48, 64, 80];
export const screenShareContentModes: ScreenShareContentMode[] = ["detail", "balanced", "motion", "smart"];

const storageKeys = {
  resolution: "ev.screenShare.resolution",
  frameRate: "ev.screenShare.frameRate",
  bitrate: "ev.screenShare.bitrateMbps",
  contentMode: "ev.screenShare.contentMode",
  captureCursor: "ev.screenShare.captureCursor"
} as const;

export function loadScreenShareResolution(storage: Storage): ScreenShareResolutionPreset {
  const value = storage.getItem(storageKeys.resolution) as ScreenShareResolutionPreset | null;
  return value && screenShareResolutionOptions.includes(value) ? value : "720p";
}

export function loadScreenShareFrameRate(storage: Storage): number {
  const value = Number(storage.getItem(storageKeys.frameRate));
  return defaultScreenShareFrameRates.includes(value) ? value : 60;
}

export function loadScreenShareBitrate(storage: Storage): ScreenShareBitrateOption {
  const raw = storage.getItem(storageKeys.bitrate);
  if (raw === "auto" || raw == null) return "auto";
  const value = Number(raw) as ScreenShareBitrateOption;
  return screenShareBitrateOptions.includes(value) ? value : "auto";
}

export function loadScreenShareContentMode(storage: Storage): ScreenShareContentMode {
  const value = storage.getItem(storageKeys.contentMode) as ScreenShareContentMode | null;
  return value && screenShareContentModes.includes(value) ? value : "balanced";
}

export function loadScreenShareCaptureCursor(storage: Storage): boolean {
  return storage.getItem(storageKeys.captureCursor) !== "false";
}

export function saveScreenShareResolution(storage: Storage, value: ScreenShareResolutionPreset) {
  storage.setItem(storageKeys.resolution, value);
}

export function saveScreenShareFrameRate(storage: Storage, value: number) {
  storage.setItem(storageKeys.frameRate, String(value));
}

export function saveScreenShareBitrate(storage: Storage, value: ScreenShareBitrateOption) {
  storage.setItem(storageKeys.bitrate, String(value));
}

export function saveScreenShareContentMode(storage: Storage, value: ScreenShareContentMode) {
  storage.setItem(storageKeys.contentMode, value);
}

export function saveScreenShareCaptureCursor(storage: Storage, value: boolean) {
  storage.setItem(storageKeys.captureCursor, String(value));
}

export function screenShareResolutionSize(preset: ScreenShareResolutionPreset) {
  return preset === "source" ? null : screenShareResolutionSizes[preset];
}

export function fitScreenShareOutputSize(
  sourceWidth: number,
  sourceHeight: number,
  maximumWidth: number,
  maximumHeight: number
) {
  const safeSourceWidth = Math.max(2, Math.round(sourceWidth));
  const safeSourceHeight = Math.max(2, Math.round(sourceHeight));
  const scale = Math.min(
    1,
    Math.max(2, maximumWidth) / safeSourceWidth,
    Math.max(2, maximumHeight) / safeSourceHeight
  );
  const evenFloor = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  return {
    width: evenFloor(safeSourceWidth * scale),
    height: evenFloor(safeSourceHeight * scale)
  };
}

export function availableScreenShareFrameRates(capabilities: DesktopMediaCapabilities | null, size?: {maxWidth: number; maxHeight: number}) {
  if (capabilities?.configuredHardwareProfiles && size) {
    const profile = capabilities.configuredHardwareProfiles.find(p => p.width === size.maxWidth && p.height === size.maxHeight);
    // Arbitrary window dimensions are admitted by the actual encoder at start.
    if (!profile) return defaultScreenShareFrameRates;
    return defaultScreenShareFrameRates.filter(fps => fps <= 30 || profile.frameRates.includes(fps));
  }
  const supported = capabilities?.supportedFrameRates?.filter((value) => value > 0 && value <= 120) ?? [];
  return supported.length > 0 ? [...new Set(supported)].sort((left, right) => left - right) : defaultScreenShareFrameRates;
}

export function resolveScreenShareBitrateBps(
  option: ScreenShareBitrateOption,
  width: number,
  height: number,
  frameRate: number,
  contentMode: ScreenShareContentMode = "balanced"
) {
  if (option !== "auto") return option * 1_000_000;
  const megapixels = Math.max(1, width) * Math.max(1, height) / 1_000_000;
  // Bits per pixel per frame. Text and flat surfaces survive ~0.04, but a scene
  // that moves — scrolling, video, a dragged window — needs closer to 0.1, and a
  // budget below that shows up as a picture that is sharp while still and mushy
  // the moment anything moves. The sender still gives rate back on REMB, so this
  // is a ceiling per content mode rather than a promise to fill the link.
  const bitsPerMegapixelFrame =
    contentMode === "detail" ? 120_000 : contentMode === "motion" ? 70_000 : 90_000;
  const maximumBitrate = contentMode === "detail" ? 64_000_000 : 48_000_000;
  return Math.max(
    1_500_000,
    Math.min(maximumBitrate, Math.round(megapixels * Math.max(1, frameRate) * bitsPerMegapixelFrame))
  );
}

export function screenShareContentHint(mode: ScreenShareContentMode): string {
  if (mode === "motion") return "motion";
  // An empty hint means "camera video", which is wrong for every screen
  // capture: the encoder then tunes for faces and motion instead of for the
  // sharp edges and flat regions that text is made of. Balanced already asks to
  // keep resolution under pressure (screenShareDegradationPreference), so its
  // hint has to agree with that choice.
  return "detail";
}

export function screenShareDegradationPreference(
  mode: ScreenShareContentMode
): "maintain-framerate" | "maintain-resolution" | "balanced" {
  if (mode === "motion") return "maintain-framerate";
  return "maintain-resolution";
}

/**
 * The label already says which size we encode; this says what the screen
 * actually is. Without it a 1280x720 preset on a 2560x1440 monitor looks like a
 * deliberate choice instead of a 4x downscale nobody noticed.
 *
 * Only a real downscale is worth mentioning: within 10% of the source reads the
 * same, and repeating the size back is noise.
 */
export function screenShareSourceSizeHint(
  encodedWidth: number,
  encodedHeight: number,
  sourceWidth: number,
  sourceHeight: number
): string {
  const usable = (value: number) => Number.isFinite(value) && value > 0;
  if (!usable(encodedWidth) || !usable(encodedHeight)) return "";
  if (!usable(sourceWidth) || !usable(sourceHeight)) return "";
  if (encodedWidth >= sourceWidth * 0.9 && encodedHeight >= sourceHeight * 0.9) {
    return "";
  }
  return `${Math.round(sourceWidth)}×${Math.round(sourceHeight)}`;
}
