// A tiny ring buffer of why a sharer did or did not answer a watch request.
//
// Every branch in `handleWatchSignal` that returns early is silent by design
// (the signal just does not apply), which makes "the viewer keeps asking and
// nothing happens" impossible to diagnose from the outside. Recording the
// decision keeps that silence debuggable without adding noise to the console.
export const screenShareWatchLogLimit = 30;

const decisions: string[] = [];

export function noteScreenShareWatchDecision(reason: string): void {
  decisions.push(`${Math.round(performance.now())}ms ${reason}`);
  if (decisions.length > screenShareWatchLogLimit) decisions.shift();
  // Exposed in every build, not just development ones: the whole point is to be
  // able to ask "why did this sharer never answer" on a real deployment, where
  // the console is the only channel available.
  (globalThis as unknown as Record<string, unknown>).__evScreenShareWatchLog = decisions;
}

export function screenShareWatchDecisions(): string[] {
  return [...decisions];
}
