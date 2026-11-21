import { strict as assert } from "node:assert";
import {
  availableScreenShareFrameRates,
  fitScreenShareOutputSize,
  loadScreenShareBitrate,
  loadScreenShareCaptureCursor,
  loadScreenShareContentMode,
  loadScreenShareFrameRate,
  loadScreenShareResolution,
  resolveScreenShareBitrateBps,
  saveScreenShareBitrate,
  saveScreenShareCaptureCursor,
  saveScreenShareContentMode,
  saveScreenShareFrameRate,
  saveScreenShareResolution,
  screenShareContentHint,
  screenShareDegradationPreference,
  screenShareResolutionSize,
  screenShareSourceSizeHint
} from "../src/lib/screenShareSettings.ts";
import type { DesktopMediaCapabilities } from "../src/lib/types.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

run("persists user-selected screen share settings", () => {
  const storage = new MemoryStorage();
  saveScreenShareResolution(storage, "2160p");
  saveScreenShareFrameRate(storage, 120);
  saveScreenShareBitrate(storage, 64);
  saveScreenShareContentMode(storage, "motion");
  saveScreenShareCaptureCursor(storage, false);

  assert.equal(loadScreenShareResolution(storage), "2160p");
  assert.equal(loadScreenShareFrameRate(storage), 120);
  assert.equal(loadScreenShareBitrate(storage), 64);
  assert.equal(loadScreenShareContentMode(storage), "motion");
  saveScreenShareContentMode(storage, "smart");
  assert.equal(loadScreenShareContentMode(storage), "smart");
  saveScreenShareContentMode(storage, "balanced");
  assert.equal(loadScreenShareContentMode(storage), "balanced");
  assert.equal(loadScreenShareCaptureCursor(storage), false);
});

run("maps resolution and content preferences", () => {
  assert.deepEqual(screenShareResolutionSize("1080p"), { width: 1920, height: 1080 });
  assert.equal(screenShareResolutionSize("source"), null);
  assert.equal(screenShareContentHint("detail"), "detail");
  assert.equal(screenShareContentHint("motion"), "motion");
  // Balanced must never fall back to camera tuning: it is still a screen capture.
  assert.equal(screenShareContentHint("balanced"), "detail");
  assert.equal(screenShareDegradationPreference("detail"), "maintain-resolution");
  assert.equal(screenShareDegradationPreference("balanced"), "maintain-resolution");
  assert.equal(screenShareDegradationPreference("motion"), "maintain-framerate");
});

run("fits native output inside the source without stretching or upscaling", () => {
  assert.deepEqual(fitScreenShareOutputSize(3840, 2160, 1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(fitScreenShareOutputSize(2560, 1440, 3840, 2160), { width: 2560, height: 1440 });
  assert.deepEqual(fitScreenShareOutputSize(1600, 1000, 1280, 720), { width: 1152, height: 720 });
  assert.deepEqual(fitScreenShareOutputSize(5120, 1440, 3840, 2160), { width: 3840, height: 1080 });
});

run("honors declared desktop frame-rate capabilities", () => {
  const capabilities = {
    supportedFrameRates: [120, 30, 60, 60]
  } as DesktopMediaCapabilities;
  assert.deepEqual(availableScreenShareFrameRates(capabilities), [30, 60, 120]);
  capabilities.configuredHardwareProfiles = [{ width: 1920, height: 1080, frameRates: [45, 60] }];
  assert.deepEqual(availableScreenShareFrameRates(capabilities, { maxWidth: 1920, maxHeight: 1080 }), [15, 24, 30, 45, 60]);
  assert.ok(availableScreenShareFrameRates(capabilities, { maxWidth: 1560, maxHeight: 900 }).includes(120));
});

run("uses exact manual bitrate and bounds automatic bitrate", () => {
  assert.equal(resolveScreenShareBitrateBps(12, 1280, 720, 60), 12_000_000);
  assert.equal(resolveScreenShareBitrateBps("auto", 1280, 720, 60), 4_976_640);
  assert.equal(resolveScreenShareBitrateBps("auto", 1280, 720, 120), 9_953_280);
  assert.equal(resolveScreenShareBitrateBps("auto", 320, 180, 15), 1_500_000);
  assert.equal(resolveScreenShareBitrateBps("auto", 3840, 2160, 120), 48_000_000);
  assert.equal(resolveScreenShareBitrateBps("auto", 3840, 2160, 60, "detail"), 59_719_680);
  assert.equal(resolveScreenShareBitrateBps("auto", 3840, 2160, 60, "motion"), 34_836_480);
});

run("names the screen size only when the share is a real downscale", () => {
  // 1080p screen shared at 720p: the user should see what they are giving up.
  assert.equal(screenShareSourceSizeHint(1280, 720, 1920, 1080), "1920×1080");
  assert.equal(screenShareSourceSizeHint(1280, 720, 2560, 1440), "2560×1440");
  // Matching the screen, or being within a tenth of it, is not worth a suffix.
  assert.equal(screenShareSourceSizeHint(1920, 1080, 1920, 1080), "");
  assert.equal(screenShareSourceSizeHint(1750, 990, 1920, 1080), "");
  // Missing or nonsense sizes must not produce "0×0".
  assert.equal(screenShareSourceSizeHint(0, 0, 1920, 1080), "");
  assert.equal(screenShareSourceSizeHint(1280, 720, 0, 1080), "");
  assert.equal(screenShareSourceSizeHint(Number.NaN, 720, 1920, 1080), "");
});

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
