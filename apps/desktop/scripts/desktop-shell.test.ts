import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.svelte", import.meta.url), "utf8");
// Window focus lifecycle and the native owner preview moved out of App.svelte
// into the realtime controller and the content panel during the split.
const realtimeSource = await readFile(new URL("../src/lib/realtime.svelte.ts", import.meta.url), "utf8");
const contentPanelSource = await readFile(new URL("../src/components/ContentPanel.svelte", import.meta.url), "utf8");
const rustMainSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");

assert.match(
  appSource,
  /function handleGlobalContextMenu\(event: MouseEvent\) \{\s*event\.preventDefault\(\);\s*if \(screenSharePopoutMode\) return;/,
  "the browser context menu must be suppressed before handling app-owned menus"
);
assert.match(
  appSource,
  /document\.addEventListener\("contextmenu", handleGlobalContextMenu, true\);\s*if \(!screenSharePopoutMode\)/,
  "context-menu suppression must also be installed in the screen-share popout"
);
assert.match(
  rustMainSource,
  /all\(target_os = "windows", not\(debug_assertions\)\)[\s\S]*?windows_subsystem = "windows"/,
  "Windows release builds must use the GUI subsystem without changing debug builds"
);
assert.match(
  appSource,
  /realtime\.attachWindowListeners\(\);[\s\S]*?realtime\.detachWindowListeners\(\);/,
  "the shell must hand window focus wiring to the realtime controller"
);
assert.match(
  realtimeSource,
  /window\.addEventListener\("blur", this\.handleWindowBlur\);[\s\S]*?window\.removeEventListener\("blur", this\.handleWindowBlur\);/,
  "desktop preview rendering must follow window focus lifecycle"
);
assert.match(
  rustMainSource,
  /fn native_screen_share_sender_set_preview_enabled[\s\S]*?manager\.set_preview_enabled/,
  "desktop preview focus lifecycle must reach the native capture pipeline"
);
assert.match(
  rustMainSource,
  /const PREVIEW_MAX_WIDTH: usize = 960;[\s\S]*?const PREVIEW_MAX_HEIGHT: usize = 540;[\s\S]*?data:image\/jpeg;base64/,
  "native local preview must use the higher-resolution lightweight JPEG path"
);
assert.match(
  realtimeSource,
  /async startNativeLocalScreenSharePreview\(share: ScreenShareSession\): Promise<void> \{[\s\S]*?addNativeScreenShareSenderViewer\(/,
  "the full-size owner preview must consume the existing native WebRTC capture stream"
);
assert.match(
  contentPanelSource,
  /data-native-local-screen-share-preview/,
  "the full-size owner preview must render through the native preview element"
);

console.log("ok - desktop shell lifecycle owns context menus, preview focus, and the Windows release subsystem");
