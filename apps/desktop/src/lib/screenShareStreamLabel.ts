/**
 * Renders the delivered picture size for the viewer's status line.
 *
 * A viewer calls a share blurry when the encoder gave up resolution *and* when
 * the sharer simply picked a small source. The number tells the two apart
 * without asking anyone to read `about:webrtc`.
 */
export function screenShareResolutionSuffix(width: unknown, height: unknown): string {
  const resolvedWidth = usableDimension(width);
  const resolvedHeight = usableDimension(height);
  if (resolvedWidth <= 0 || resolvedHeight <= 0) return "";
  return ` · ${resolvedWidth}×${resolvedHeight}`;
}

export function screenShareFrameRateSuffix(frameRate: unknown): string {
  if (typeof frameRate !== "number" || !Number.isFinite(frameRate)) return "";
  const rounded = Math.round(frameRate);
  if (rounded < 0) return "";
  return ` · ${rounded} fps`;
}

/**
 * The native encoder is configured once per session, so a quality change made
 * while it is already encoding only applies to the next share. Saying so is
 * better than a label that describes settings the encoder never received.
 */
export function screenSharePendingSettingsSuffix(
  pending: boolean,
  translate: (key: string) => string
): string {
  return pending ? ` · ${translate("screenShare.qualityNextShare")}` : "";
}

export type ScreenShareLimitationHint = "lower-bitrate" | "lower-frame-rate" | "none";

/**
 * What the sharer can actually do about a limitation.
 *
 * "CPU limited" on its own leaves the reader guessing between the four knobs the
 * panel offers. The browser reports which resource ran out, so name the single
 * setting that relieves it rather than listing all of them.
 */
export function screenShareLimitationHint(reason: unknown): ScreenShareLimitationHint {
  if (reason === "cpu") return "lower-frame-rate";
  if (reason === "bandwidth") return "lower-bitrate";
  return "none";
}

function usableDimension(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : 0;
}
