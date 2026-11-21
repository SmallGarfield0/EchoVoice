// Video-only WebRTC receiver counters. Report identifiers change on
// renegotiation. Never subtract counters across different sets of SSRCs.
export interface ScreenShareInboundVideo {
  id: string;
  timestamp: number;
  framesReceived?: number;
  framesDecoded?: number;
  bytesReceived?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  totalDecodeTime?: number;
  framesDropped?: number;
  freezeCount?: number;
}

export interface ScreenShareReceiverMetrics {
  receivedFps?: number;
  decodedFps?: number;
  bitrateMbps?: number;
  jitterBufferMS?: number;
  decodeMS?: number;
  droppedFrames?: number;
  freezes?: number;
  jitterMS?: number;
  rttMS?: number;
}

function sumReports(reports: ScreenShareInboundVideo[], field: keyof Omit<ScreenShareInboundVideo, "id">) {
  let total = 0;
  for (const report of reports) {
    const value = report[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    total += value;
  }
  return total;
}

function difference(current?: number, previous?: number) {
  if (current === undefined || previous === undefined || current < previous) return undefined;
  return current - previous;
}

function rate(count: number | undefined, denominator: number | undefined, factor: number) {
  if (count === undefined || denominator === undefined || denominator <= 0) return undefined;
  return count * factor / denominator;
}

export class ScreenShareReceiverSampler {
  private previous?: ScreenShareInboundVideo;
  private latest: ScreenShareReceiverMetrics = {};

  sample(reports: ScreenShareInboundVideo[]): ScreenShareReceiverMetrics {
    if (!reports.length) {
      this.previous = undefined;
      this.latest = {};
      return this.latest;
    }
    const current = {
      id: JSON.stringify(reports.map(report => report.id).sort()),
      timestamp: Math.max(...reports.map(report => report.timestamp)),
      framesReceived: sumReports(reports, "framesReceived"),
      framesDecoded: sumReports(reports, "framesDecoded"),
      bytesReceived: sumReports(reports, "bytesReceived"),
      totalDecodeTime: sumReports(reports, "totalDecodeTime"),
      jitterBufferDelay: sumReports(reports, "jitterBufferDelay"),
      jitterBufferEmittedCount: sumReports(reports, "jitterBufferEmittedCount")
    };
    const previous = this.previous?.id === current.id ? this.previous : undefined;
    const elapsedMS = previous && current.timestamp - previous.timestamp;
    // Startup bursts must neither invent a rate nor move the sampling baseline.
    if (elapsedMS !== undefined && elapsedMS < 500) return this.latest;
    this.previous = current;
    const decoded = difference(current.framesDecoded, previous?.framesDecoded);
    this.latest = {
      receivedFps: rate(difference(current.framesReceived, previous?.framesReceived), elapsedMS, 1000),
      decodedFps: rate(decoded, elapsedMS, 1000),
      bitrateMbps: rate(difference(current.bytesReceived, previous?.bytesReceived), elapsedMS, 0.008),
      decodeMS: rate(difference(current.totalDecodeTime, previous?.totalDecodeTime), decoded, 1000),
      jitterBufferMS: rate(
        difference(current.jitterBufferDelay, previous?.jitterBufferDelay),
        difference(current.jitterBufferEmittedCount, previous?.jitterBufferEmittedCount),
        1000
      ),
      droppedFrames: sumReports(reports, "framesDropped"),
      freezes: sumReports(reports, "freezeCount")
    };
    return this.latest;
  }
}
