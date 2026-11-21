/**
 * Summarises which viewers are served from the reduced-tier encode.
 *
 * The live panel answers one question — how many people are watching — so it
 * does not name media paths or uplink estimates. What it does show is who is
 * not on the shared full-quality encode, because that is the only part of the
 * picture a viewer of the panel can act on.
 */
export type ScreenShareViewerLayerSummary = {
  viewers: number;
  /** Viewers served from the reduced-tier encode instead of the shared one. */
  reduced: number;
};

/**
 * Counts the viewers that are not on the shared full-quality encode. This is
 * the visible answer to "does a far-away viewer cost me sharpness": nobody on
 * the reduced tier appears here as a cost to the others.
 */
export function summarizeScreenShareViewerLayers(
  viewerIds: readonly string[],
  layers: Record<string, string> | undefined
): ScreenShareViewerLayerSummary {
  let reduced = 0;
  if (layers) {
    for (const viewerId of viewerIds) {
      if (layers[viewerId] === "low") reduced += 1;
    }
  }
  return { viewers: viewerIds.length, reduced };
}

/**
 * Suffix naming the viewers on the reduced encode, or "" when everyone shares
 * the full-quality one.
 */
export function screenShareViewerLayerSuffix(
  summary: ScreenShareViewerLayerSummary,
  translate: (key: string, params?: Record<string, string | number>) => string
): string {
  if (summary.reduced <= 0) return "";
  return ` · ${translate("screenShare.viewerLayersReduced", {
    reduced: summary.reduced,
    count: summary.viewers
  })}`;
}
