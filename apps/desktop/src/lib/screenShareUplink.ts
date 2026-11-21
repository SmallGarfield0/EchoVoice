/**
 * Screen sharing sends one copy of the stream per viewer, so the sender's
 * uplink is the per-viewer rate times the number of viewers. The live panel
 * deliberately stays out of that arithmetic (it shows the viewer count and the
 * stream itself); this estimate only appears before a share starts, where it is
 * the one number that explains why a room full of viewers blurs.
 */

/**
 * Before a share starts there are no viewers to sum over, but the arithmetic is
 * already decided: every viewer costs one copy of this number. Saying "auto"
 * alone hides the cost that makes a five-person room blurry.
 */
export function screenSharePerViewerCostLabel(
  bitrateBps: number,
  translate: (key: string, params?: Record<string, string | number>) => string
): string {
  if (!Number.isFinite(bitrateBps) || bitrateBps <= 0) return "";
  const mbps = Math.round((bitrateBps / 1_000_000) * 10) / 10;
  return ` · ${translate("screenShare.perViewerCost", { mbps })}`;
}
