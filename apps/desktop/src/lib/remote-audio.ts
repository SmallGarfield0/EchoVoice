// Remote voice playback mixer. Owns the AudioContext graph that renders
// incoming WebRTC voice, accompaniment, and screen-share audio, plus the muted
// render-anchor elements Chromium needs to keep pulling decoded media while a
// tab is in the background.
//
// Extracted from the workspace component so the playback graph is a single
// testable subsystem instead of a thousand lines of component state.

export type RemoteAudioScope = "voice" | "accompaniment" | "screen-share";

export type RemoteVoiceMixerHooks = {
  outputVolumePercent: () => number;
  audioDeafened: () => boolean;
  streamVolumePercent: (remoteMemberId: string, scope: RemoteAudioScope) => number;
  onPlaybackBlocked: (blocked: boolean) => void;
  onPlaybackResumed: () => void;
  onContextCreated: () => void;
  onElementCreated: (audio: HTMLAudioElement) => void;
  reapplyVolume: (remoteMemberId: string, scope: RemoteAudioScope) => void;
};

const declickModulePromises = new WeakMap<AudioContext, Promise<boolean>>();

export function ensureAudioDeclickModule(context: AudioContext): Promise<boolean> {
  if (!context.audioWorklet || typeof AudioWorkletNode === "undefined") {
    return Promise.resolve(false);
  }
  const existing = declickModulePromises.get(context);
  if (existing) return existing;
  const moduleURL = new URL("../audio/remote-audio-declick-worklet.js?no-inline", import.meta.url).toString();
  const promise = context.audioWorklet.addModule(moduleURL)
    .then(() => true)
    .catch((caught) => {
      console.warn("[EchoVoice] audio de-click worklet unavailable", caught);
      return false;
    });
  declickModulePromises.set(context, promise);
  return promise;
}

export function armAudioDeclick(node: AudioWorkletNode | null): void {
  node?.port.postMessage({ type: "smooth-next-block" });
}

export function remoteAudioKey(
  remoteMemberId: string,
  stream: MediaStream,
  scope: RemoteAudioScope
): string {
  const trackId = stream.getAudioTracks()[0]?.id || stream.id;
  return `${scope}:${remoteMemberId}:${trackId}`;
}

export function remoteAudioKeyMatchesMember(
  key: string,
  targetMemberId: string,
  scope?: RemoteAudioScope
): boolean {
  return scope
    ? key.startsWith(`${scope}:${targetMemberId}:`)
    : key.startsWith(`voice:${targetMemberId}:`)
      || key.startsWith(`accompaniment:${targetMemberId}:`)
      || key.startsWith(`screen-share:${targetMemberId}:`);
}

/**
 * De-click nodes must keep the channel layout they are given.
 *
 * A mono node in this graph silently downmixes everything behind it, and both
 * the mix stage and the per-stream stage sit in front of the speakers. Screen
 * share and accompaniment negotiate Opus `stereo=1`, so a mono node here throws
 * that away at the very last step and the listener hears a downmix.
 */
export function remoteAudioDeclickNodeOptions(): {
  channelCount: number;
  channelCountMode: ChannelCountMode;
  outputChannelCount: number[];
} {
  return { channelCount: 2, channelCountMode: "explicit", outputChannelCount: [2] };
}

/**
 * Member ids that currently have audio attached for a scope.
 *
 * Every key in the graph counts, not just the ones that fell back to an
 * `<audio>` element: the WebAudio path is the normal one, and enumerating only
 * the fallback would leave every member on the normal path out of a re-apply.
 */
export function remoteAudioMemberIds(keys: Iterable<string>, scope: RemoteAudioScope): string[] {
  const prefix = `${scope}:`;
  const members = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const memberId = key.slice(prefix.length).split(":")[0];
    if (memberId) members.add(memberId);
  }
  return [...members];
}

export class RemoteVoiceMixer {
  context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private mixDeclick: AudioWorkletNode | null = null;
  private hooks: RemoteVoiceMixerHooks;
  private tracks = new Map<string, MediaStreamTrack>();
  private sources = new Map<string, MediaStreamAudioSourceNode>();
  private gains = new Map<string, GainNode>();
  private declickNodes = new Map<string, AudioWorkletNode>();
  private elements = new Map<string, HTMLAudioElement>();
  private renderAnchors = new Map<string, HTMLAudioElement>();

  constructor(hooks: RemoteVoiceMixerHooks) {
    this.hooks = hooks;
  }

  get elementMap(): Map<string, HTMLAudioElement> {
    return this.elements;
  }

  // Read-only view of what is currently attached, for the workspace browser E2E
  // harness. It needs to confirm that a remote track reached playback instead of
  // only that RTP arrived, and that distinction cannot be seen from the wire.
  devMediaSources(): Array<{ key: string; stream: MediaStream }> {
    return [...this.tracks.entries()].map(([key, track]) => ({
      key,
      stream: new MediaStream([track])
    }));
  }

  get renderAnchorCount(): number {
    return this.renderAnchors.size;
  }

  get audioContextState(): string {
    return this.context?.state ?? "";
  }

  ensureContext(): AudioContext | null {
    if (this.context && this.masterGain && this.limiter) return this.context;
    const AudioContextCtor = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return null;
    this.context = new AudioContextCtor({ latencyHint: "interactive" });
    this.masterGain = this.context.createGain();
    this.limiter = this.context.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.12;
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.context.destination);
    this.hooks.onContextCreated();
    return this.context;
  }

  async attach(remoteMemberId: string, stream: MediaStream, scope: RemoteAudioScope): Promise<void> {
    const key = remoteAudioKey(remoteMemberId, stream, scope);
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    if (this.tracks.get(key) === track && (this.sources.has(key) || this.elements.has(key))) {
      this.hooks.reapplyVolume(remoteMemberId, scope);
      return;
    }
    if (this.tracks.has(key)) this.detachKey(key);
    this.tracks.set(key, track);
    track.addEventListener("ended", () => {
      if (this.tracks.get(key) === track) this.detachKey(key);
    }, { once: true });
    const streamVolume = this.hooks.streamVolumePercent(remoteMemberId, scope);
    const context = this.ensureContext();
    if (context && this.masterGain) {
      try {
        // Chromium only pulls decoded WebRTC audio while a media renderer is attached.
        // Keep a muted element as the renderer; audible output still uses the gain graph below.
        this.ensureRenderAnchor(key, stream);
        const source = context.createMediaStreamSource(stream);
        const gain = context.createGain();
        gain.gain.setValueAtTime(0, context.currentTime);
        gain.connect(this.masterGain);
        this.sources.set(key, source);
        this.gains.set(key, gain);
        const declickAvailable = await ensureAudioDeclickModule(context);
        if (this.sources.get(key) !== source || this.tracks.get(key) !== track) return;
        if (declickAvailable) {
          try {
            this.ensureMixDeclick(context);
            const declick = new AudioWorkletNode(
              context,
              "echovoice-declick",
              remoteAudioDeclickNodeOptions()
            );
            source.connect(declick);
            declick.connect(gain);
            this.declickNodes.set(key, declick);
          } catch (caught) {
            console.warn("[EchoVoice] remote audio de-click node unavailable", caught);
            source.connect(gain);
          }
        } else {
          source.connect(gain);
        }
        gain.gain.linearRampToValueAtTime(streamVolume / 100, context.currentTime + 0.03);
        void context.resume().then(() => {
          this.hooks.onPlaybackBlocked(false);
        }).catch(() => {
          this.hooks.onPlaybackBlocked(true);
        });
        return;
      } catch {
        this.detachKey(key);
        this.tracks.set(key, track);
      }
    }
    let audio = this.elements.get(key);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audio.className = "remote-voice-audio";
      document.body.append(audio);
      this.elements.set(key, audio);
      this.hooks.onElementCreated(audio);
    }
    audio.srcObject = stream;
    audio.muted = this.hooks.audioDeafened();
    audio.volume = Math.min(1, (this.hooks.outputVolumePercent() / 100) * (streamVolume / 100));
    void audio.play().then(() => {
      this.hooks.onPlaybackBlocked(false);
    }).catch(() => {
      this.hooks.onPlaybackBlocked(true);
    });
  }

  detachForMember(memberIdToClose: string, scope?: RemoteAudioScope): void {
    const keys = new Set([
      ...this.elements.keys(),
      ...this.renderAnchors.keys(),
      ...this.sources.keys(),
      ...this.gains.keys(),
      ...this.declickNodes.keys(),
      ...this.tracks.keys()
    ]);
    for (const key of keys) {
      if (!remoteAudioKeyMatchesMember(key, memberIdToClose, scope)) continue;
      this.detachKey(key);
    }
  }

  detachKey(key: string): void {
    this.sources.get(key)?.disconnect();
    this.declickNodes.get(key)?.disconnect();
    this.gains.get(key)?.disconnect();
    this.sources.delete(key);
    this.declickNodes.delete(key);
    this.gains.delete(key);
    this.tracks.delete(key);
    const renderAnchor = this.renderAnchors.get(key);
    if (renderAnchor) {
      renderAnchor.pause();
      renderAnchor.srcObject = null;
      renderAnchor.remove();
      this.renderAnchors.delete(key);
    }
    const audio = this.elements.get(key);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      this.elements.delete(key);
    }
  }

  detachAll(): void {
    const keys = new Set([
      ...this.elements.keys(),
      ...this.renderAnchors.keys(),
      ...this.sources.keys(),
      ...this.gains.keys(),
      ...this.declickNodes.keys(),
      ...this.tracks.keys()
    ]);
    for (const key of keys) this.detachKey(key);
  }

  memberIdsForScope(scope: RemoteAudioScope): string[] {
    return remoteAudioMemberIds(
      [
        ...this.elements.keys(),
        ...this.sources.keys(),
        ...this.gains.keys(),
        ...this.declickNodes.keys(),
        ...this.tracks.keys()
      ],
      scope
    );
  }

  applyVolume(targetMemberId: string, scope: RemoteAudioScope, volume: number): void {
    for (const [key, gain] of this.gains.entries()) {
      if (!remoteAudioKeyMatchesMember(key, targetMemberId, scope)) continue;
      if (this.context) gain.gain.setTargetAtTime(volume / 100, this.context.currentTime, 0.01);
      else gain.gain.value = volume / 100;
    }
    for (const [key, audio] of this.elements.entries()) {
      if (!remoteAudioKeyMatchesMember(key, targetMemberId, scope)) continue;
      audio.volume = Math.min(1, (this.hooks.outputVolumePercent() / 100) * (volume / 100));
    }
  }

  setMasterGain(value: number): void {
    if (this.masterGain && this.context) {
      this.masterGain.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
    }
  }

  setElementsMuted(muted: boolean): void {
    for (const audio of this.elements.values()) {
      audio.muted = muted;
    }
  }

  preparePlayback(): void {
    const context = this.ensureContext();
    if (!context) return;
    if (context.state === "suspended" && this.masterGain) {
      for (const declick of this.declickNodes.values()) armAudioDeclick(declick);
      armAudioDeclick(this.mixDeclick);
      const now = context.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(0, now);
    }
    void context.resume().then(() => {
      // Re-apply deafen/output levels; the user may have changed them while
      // the browser had the context suspended.
      this.hooks.onPlaybackResumed();
      this.hooks.onPlaybackBlocked(false);
    }).catch(() => {
      this.hooks.onPlaybackBlocked(true);
    });
  }

  resumeAll(): void {
    if (this.context?.state === "suspended") {
      this.preparePlayback();
    }
    for (const audio of this.elements.values()) {
      void audio.play().then(() => {
        this.hooks.onPlaybackBlocked(false);
      }).catch(() => {
        this.hooks.onPlaybackBlocked(true);
      });
    }
    for (const anchor of this.renderAnchors.values()) {
      void anchor.play().then(() => {
        this.hooks.onPlaybackBlocked(false);
      }).catch(() => {
        this.hooks.onPlaybackBlocked(true);
      });
    }
  }

  dispose(): void {
    this.detachAll();
    this.masterGain?.disconnect();
    this.mixDeclick?.disconnect();
    this.limiter?.disconnect();
    void this.context?.close().catch(() => undefined);
    this.masterGain = null;
    this.mixDeclick = null;
    this.limiter = null;
    this.context = null;
  }

  private ensureRenderAnchor(key: string, stream: MediaStream): void {
    let anchor = this.renderAnchors.get(key);
    if (!anchor) {
      anchor = new Audio();
      anchor.autoplay = true;
      anchor.setAttribute("playsinline", "true");
      anchor.muted = true;
      anchor.volume = 0;
      anchor.className = "remote-voice-render-anchor";
      document.body.append(anchor);
      this.renderAnchors.set(key, anchor);
    }
    anchor.srcObject = stream;
    void anchor.play().then(() => {
      this.hooks.onPlaybackBlocked(false);
    }).catch(() => {
      this.hooks.onPlaybackBlocked(true);
    });
  }

  private ensureMixDeclick(context: AudioContext): void {
    if (this.mixDeclick || !this.masterGain || !this.limiter) return;
    const declick = new AudioWorkletNode(
      context,
      "echovoice-declick",
      remoteAudioDeclickNodeOptions()
    );
    this.masterGain.disconnect(this.limiter);
    this.masterGain.connect(declick);
    declick.connect(this.limiter);
    this.mixDeclick = declick;
  }
}
