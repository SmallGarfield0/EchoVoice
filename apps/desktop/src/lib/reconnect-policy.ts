// Exponential reconnect backoff shared by the workspace and voice event
// sockets. Background tabs throttle chained timers down to once per minute, so
// the computed delay is an intent, not a promise; reconnect handlers re-align
// as soon as the browser returns.

export type ReconnectPolicyOptions = {
  baseMS?: number;
  maxMS?: number;
  maxExponent?: number;
};

export function reconnectDelayMS(attempt: number, options: ReconnectPolicyOptions = {}): number {
  const baseMS = options.baseMS ?? 1_000;
  const maxMS = options.maxMS ?? 15_000;
  const maxExponent = options.maxExponent ?? 4;
  if (attempt <= 0) return 0;
  return Math.min(maxMS, baseMS * 2 ** Math.min(attempt, maxExponent));
}
