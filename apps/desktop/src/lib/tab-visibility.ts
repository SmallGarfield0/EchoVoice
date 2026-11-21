// Central Page Lifecycle tracking for browser background suspension.
// Browsers throttle hidden tabs and can freeze silent ones entirely, so
// wall-clock deltas measured across a hidden window must never be treated as
// evidence of a broken peer connection.

export type TabVisibilityCallbacks = {
  onHidden?: () => void;
  onVisible?: () => void;
  onFreeze?: () => void;
  onResume?: () => void;
  onPageShow?: () => void;
};

export class TabVisibilityMonitor {
  hiddenSinceMS = 0;
  frozenSinceMS = 0;
  private callbacks: TabVisibilityCallbacks;
  private started = false;

  constructor(callbacks: TabVisibilityCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get hidden(): boolean {
    return this.hiddenSinceMS > 0;
  }

  hiddenAcross(startAtMS: number): boolean {
    return this.hiddenSinceMS > 0 && startAtMS <= this.hiddenSinceMS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    document.addEventListener("freeze", this.handleFreeze);
    document.addEventListener("resume", this.handleResume);
    window.addEventListener("pageshow", this.handlePageShow);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    document.removeEventListener("freeze", this.handleFreeze);
    document.removeEventListener("resume", this.handleResume);
    window.removeEventListener("pageshow", this.handlePageShow);
    this.hiddenSinceMS = 0;
    this.frozenSinceMS = 0;
  }

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.hiddenSinceMS = Date.now();
      this.callbacks.onHidden?.();
    } else {
      this.hiddenSinceMS = 0;
      this.frozenSinceMS = 0;
      this.callbacks.onVisible?.();
    }
  };

  private handleFreeze = (): void => {
    this.frozenSinceMS = Date.now();
    if (!this.hiddenSinceMS) this.hiddenSinceMS = Date.now();
    this.callbacks.onFreeze?.();
  };

  private handleResume = (): void => {
    this.frozenSinceMS = 0;
    this.callbacks.onResume?.();
  };

  private handlePageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    this.frozenSinceMS = 0;
    this.callbacks.onPageShow?.();
  };
}
