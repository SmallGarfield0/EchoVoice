<script lang="ts">
  import type { ScreenShareWatchStatus } from "../lib/screen-share.svelte";

  import type { ScreenShareSenderTelemetry } from "../lib/screenShareWebRTC";
  import type { NativeScreenShareSenderStatus } from "../lib/types";

  let { video, stream, status, publishing, nativeStatus, senders, senderPaths, viewerName, t }: {
    publishing?: "web" | "native";
    nativeStatus?: NativeScreenShareSenderStatus | null;
    senders: Map<string, ScreenShareSenderTelemetry>;
    senderPaths: Map<string, string>;
    viewerName: (peerId: string) => string;
    video?: HTMLVideoElement;
    stream?: MediaStream;
    status?: ScreenShareWatchStatus;
    t: (key: string) => string;
  } = $props();

  let displayFps = $state<number>();
  let sincePresentationMS = $state<number>();

  $effect(() => {
    const node = video;
    const source = stream;
    displayFps = undefined;
    sincePresentationMS = undefined;
    if (!source || !node || typeof node.requestVideoFrameCallback !== "function") return;

    let lastCount: number | undefined;
    let baseline: number | undefined;
    let baselineTime = performance.now();
    let lastPresentation: number | undefined;
    let callback: number;
    const onFrame: VideoFrameRequestCallback = (_, meta) => {
      if (!document.hidden && node.srcObject === source) {
        lastCount = meta.presentedFrames;
        lastPresentation = meta.presentationTime;
        if (baseline === undefined) {
          baseline = lastCount;
          baselineTime = performance.now();
        }
      }
      callback = node.requestVideoFrameCallback(onFrame);
    };
    callback = node.requestVideoFrameCallback(onFrame);
    const reset = () => {
      lastCount = baseline = lastPresentation = undefined;
      displayFps = sincePresentationMS = undefined;
    };
    document.addEventListener("visibilitychange", reset);
    const timer = window.setInterval(() => {
      if (document.hidden || node.srcObject !== source || lastCount === undefined || baseline === undefined) return;
      const now = performance.now();
      const elapsed = now - baselineTime;
      if (elapsed < 500) return;
      displayFps = lastCount >= baseline ? (lastCount - baseline) * 1000 / elapsed : undefined;
      sincePresentationMS = lastPresentation === undefined ? undefined : Math.max(0, now - lastPresentation);
      baseline = lastCount;
      baselineTime = now;
    }, 1000);
    return () => {
      window.clearInterval(timer);
      node.cancelVideoFrameCallback(callback);
      document.removeEventListener("visibilitychange", reset);
    };
  });

  const metrics = $derived(status?.receiverMetrics);
  const receiverRows = $derived([
    ["receivedFps", metrics?.receivedFps, "FPS"],
    ["decodedFps", metrics?.decodedFps, "FPS"],
    ["displayFps", displayFps, "FPS"],
    ["sincePresentation", sincePresentationMS, "ms"],
    ["bitrate", metrics?.bitrateMbps, "Mbps"],
    ["rtt", metrics?.rttMS, "ms"],
    ["jitter", metrics?.jitterMS, "ms"],
    ["residence", metrics?.jitterBufferMS, "ms"],
    ["decodeTime", metrics?.decodeMS, "ms"],
    ["dropped", metrics?.droppedFrames, ""],
    ["freezes", metrics?.freezes, ""]
  ] as const);

  const stages = $derived(nativeStatus?.pipelineMetrics);
  function modeLabel(mode: unknown) {
    return mode === "balanced" || mode === "detail" || mode === "motion" ? t("screenShare.contentMode." + mode) : undefined;
  }
  function reasonLabel(reason: unknown) {
    return typeof reason === "string" && ["observing", "sustained-motion", "encoder-pressure", "low-activity", "encoder-unsupported"].includes(reason)
      ? t("screenShare.smartReason." + reason) : undefined;
  }
  const nativeRows = $derived([
    ["captureFps", stages?.captureFps, "FPS"], ["encodeFps", stages?.encodeFps, "FPS"],
    ["captureAge", stages?.captureAge, "ms"], ["readback", stages?.readback, "ms"],
    ["encodeCall", stages?.encodeCall, "ms"], ["hardwareResidence", stages?.hardwareResidence, "ms"],
    ["gpuUsage", stages?.gpuUsage, "MiB"], ["gpuBudget", stages?.gpuBudget, "MiB"],
    ["encoderTarget", stages?.encoderTarget, "Mbps"], ["copies", stages?.copies, ""],
    ["pressure", stages?.pressure, ""], ["viewerDrops", stages?.viewerDrops, ""], ["audioDrops", stages?.audioDrops, ""]
  ] as const);
  function senderRows(peerId: string, sender: ScreenShareSenderTelemetry) {
    const path = senderPaths.get(peerId);
    const rows: Row[] = [
      ["path", path === "direct" ? t("screenShare.pathDirect") : path === "relay" ? t("screenShare.pathRelay") : undefined, ""],
      ["codec", sender.codecMimeType || undefined, ""],
      ["size", sender.frameWidth && sender.frameHeight ? sender.frameWidth + " × " + sender.frameHeight : undefined, ""],
      ["captureFps", sender.captureFps, "FPS"], ["encodeFps", sender.encodedFramesPerSecond, "FPS"],
      ["sentFps", sender.sentFps, "FPS"], ["encodeCall", sender.averageEncodeTimeMS, "ms"],
      ["sendRate", sender.bitrateBps !== undefined ? sender.bitrateBps / 1e6 : undefined, "Mbps"],
      ["nack", sender.nackCount, ""], ["pli", sender.pliCount, ""]
    ];
    if (sender.effectiveContentMode) {
      rows.push(["effectiveMode", modeLabel(sender.effectiveContentMode), ""],
        ["changedArea", sender.changedArea === undefined ? undefined : sender.changedArea * 100, "%"]);
    }
    if (sender.qualityTier !== undefined) rows.push(["qualityTier", sender.qualityTier, ""],
      ["availableRate", sender.availableBps === undefined ? undefined : sender.availableBps / 1e6, "Mbps"]);
    if (sender.adaptationReason) rows.push(["tierReason", t("screenShare.tierReason." + sender.adaptationReason), ""]);
    return rows;
  }
  type Row = readonly [string, string | number | undefined, string];
</script>

{#snippet table(rows: readonly Row[])}
  <dl>
    {#each rows as [key, value, unit]}
      <dt>{t("screenShare.diag." + key)}</dt>
      <dd data-metric={key} data-value={value}>
        {value === undefined ? t("screenShare.diag.unavailable") : `${typeof value === "number" ? Number(value.toFixed(unit ? 1 : 0)) : value} ${unit}`.trim()}
      </dd>
    {/each}
  </dl>
{/snippet}
<section class="receiver-diagnostics" data-screen-share-diagnostics aria-label={t("screenShare.diagnostics")}>
  {#if publishing === "native"}
    {@render table(nativeRows)}
    {#if nativeStatus?.pipeline?.encoderFallbackReason}
      {@render table([["encoderFallback", nativeStatus.pipeline.encoderFallbackReason, ""]])}
    {/if}
    {#if nativeStatus?.pipeline?.effectiveContentMode}
      {@render table([["effectiveMode", modeLabel(nativeStatus.pipeline.effectiveContentMode), ""],
        ["smartReason", reasonLabel(nativeStatus.pipeline.smartReason), ""]])}
    {/if}
    {#each nativeStatus?.viewerMemberIds ?? [] as id (id)}
      {@const path = nativeStatus?.viewerPaths?.[id]}
      {@const layer = nativeStatus?.viewerLayers?.[id]}
      <h4>{viewerName(id)}</h4>
      {@render table([["path", path ? t(path === "direct" ? "screenShare.pathDirect" : "screenShare.pathRelay") : undefined, ""],
        ["layer", layer ? t("screenShare.layer." + layer) : undefined, ""]])}
    {/each}
  {:else if publishing === "web"}
    {#each [...senders.entries()] as [id, sender] (id)}
      <h4>{viewerName(id)}</h4>
      {@render table(senderRows(id, sender))}
    {:else}
      {t("screenShare.diag.noSenders")}
    {/each}
  {:else}
    {@render table(receiverRows)}
  {/if}
</section>

<style>
  .receiver-diagnostics {
    position: absolute;
    inset: 16px auto auto 16px;
    max-width: calc(100% - 32px);
    max-height: calc(100% - 96px);
    overflow: hidden auto;
    z-index: 2;
    border: 1px solid rgba(142, 203, 255, 0.3);
    border-radius: 8px;
    background: rgba(14, 18, 22, 0.95);
    padding: 10px 14px;
    font-size: 12px;
  }
  dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 16px; margin: 0; }
  h4 { margin: 4px 0; }
  dt { color: #bac5ce; }
  dd { color: #e3f2ff; margin: 0; text-align: end; font-variant-numeric: tabular-nums; max-width: 40ch; overflow-wrap: anywhere; }
</style>
