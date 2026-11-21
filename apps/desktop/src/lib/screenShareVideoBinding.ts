// Binding a remote screen-share stream to its <video> element.
//
// The card creates the element the moment a stream exists, but the same action
// is also used for elements whose stream is not known yet (the focused viewer
// and the popout panel both read from a map). Chrome coerces `srcObject =
// undefined` to null instead of throwing, so the real work here is being
// explicit about the empty case: an element with no stream must not be asked to
// play (that only produces a rejected promise nobody sees), and the update path
// must still bind the stream that arrives a moment later.
export type ScreenShareVideoNode = {
  autoplay: boolean;
  muted: boolean;
  playsInline: boolean;
  srcObject: unknown;
  paused?: boolean;
  play: () => Promise<void> | void;
  pause: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

export function attachScreenShareVideo(
  node: ScreenShareVideoNode,
  stream: MediaStream | null | undefined
) {
  node.autoplay = true;
  node.muted = true;
  node.playsInline = true;
  const requestPlayback = () => {
    void node.play()?.catch?.(() => undefined);
  };
  const applyStream = (nextStream: MediaStream | null | undefined) => {
    // `?? null` and not the raw value: see the note above.
    const next = nextStream ?? null;
    if (node.srcObject !== next) {
      node.srcObject = next;
    }
    if (next) requestPlayback();
  };
  node.addEventListener("loadedmetadata", requestPlayback);
  node.addEventListener("canplay", requestPlayback);
  applyStream(stream);
  return {
    update(nextStream: MediaStream | null | undefined) {
      applyStream(nextStream);
    },
    destroy() {
      node.removeEventListener("loadedmetadata", requestPlayback);
      node.removeEventListener("canplay", requestPlayback);
      node.pause();
      node.srcObject = null;
    }
  };
}
