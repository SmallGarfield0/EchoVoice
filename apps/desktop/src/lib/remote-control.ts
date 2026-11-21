import type { RemoteControlInputEvent } from "./types";

export type RemoteControlVideoGeometry = {
  left: number;
  top: number;
  width: number;
  height: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
};

export function normalizeNativeRemoteControlInputEvent(
  event: RemoteControlInputEvent
): RemoteControlInputEvent {
  switch (event.type) {
    case "pointer_move":
      return {
        type: event.type,
        x: Number(event.x ?? 0),
        y: Number(event.y ?? 0),
        buttons: Number(event.buttons ?? 0)
      };
    case "pointer_button":
      return {
        type: event.type,
        x: Number(event.x ?? 0),
        y: Number(event.y ?? 0),
        button: Number(event.button ?? 0),
        buttons: Number(event.buttons ?? 0),
        pressed: Boolean(event.pressed)
      };
    case "wheel":
      return {
        type: event.type,
        x: Number(event.x ?? 0),
        y: Number(event.y ?? 0),
        delta_x: Number(event.delta_x ?? 0),
        delta_y: Number(event.delta_y ?? 0)
      };
    case "key":
      return {
        type: event.type,
        code: String(event.code ?? ""),
        key: String(event.key ?? ""),
        pressed: Boolean(event.pressed),
        repeat: Boolean(event.repeat),
        modifiers: Array.isArray(event.modifiers) ? event.modifiers : []
      };
    case "release_all":
      return { type: event.type };
  }
}

export function normalizedRemoteControlPoint(
  geometry: RemoteControlVideoGeometry,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  if (
    geometry.width <= 0 ||
    geometry.height <= 0 ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY)
  ) return null;

  const intrinsicRatio = geometry.intrinsicWidth > 0 && geometry.intrinsicHeight > 0
    ? geometry.intrinsicWidth / geometry.intrinsicHeight
    : geometry.width / geometry.height;
  let contentWidth = geometry.width;
  let contentHeight = contentWidth / intrinsicRatio;
  if (contentHeight > geometry.height) {
    contentHeight = geometry.height;
    contentWidth = contentHeight * intrinsicRatio;
  }
  const left = geometry.left + (geometry.width - contentWidth) / 2;
  const top = geometry.top + (geometry.height - contentHeight) / 2;
  const x = (clientX - left) / contentWidth;
  const y = (clientY - top) / contentHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

export class SerialAsyncQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(task: () => Promise<void>, onError: (error: unknown) => void): void {
    this.tail = this.tail
      .catch(() => undefined)
      .then(task)
      .catch(onError);
  }

  async idle(): Promise<void> {
    await this.tail;
  }
}
