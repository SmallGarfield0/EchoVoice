import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repositoryDir = resolve(desktopDir, "..", "..");
const executable = join(repositoryDir, "target", "debug", "echovoice-desktop.exe");
const devUrl = "http://127.0.0.1:7173";
const tempRoot = mkdtempSync(join(tmpdir(), "ev-desktop-popout-"));
const children = [];
let mainClient;
let popoutClient;
let startedVite = false;
let viteProcess;

async function runTest() {
try {
  buildDesktopExecutable();
  if (!(await isHttpReady(devUrl))) {
    const viteEntry = join(desktopDir, "node_modules", "vite", "bin", "vite.js");
    const vite = startChild(process.execPath, [viteEntry, "--host", "127.0.0.1", "--port", "7173", "--strictPort"], {
      cwd: desktopDir,
      env: { ...process.env, EV_DESKTOP_DEV_PORT: "7173" }
    });
    viteProcess = vite;
    children.push(vite);
    startedVite = true;
    await waitForHttp(devUrl, "Vite");
  }

  const debuggingPort = await reservePort();
  const app = startChild(executable, [], {
    cwd: desktopDir,
    env: {
      ...process.env,
      APPDATA: join(tempRoot, "appdata", "roaming"),
      LOCALAPPDATA: join(tempRoot, "appdata", "local"),
      WEBVIEW2_USER_DATA_FOLDER: join(tempRoot, "webview2"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
        `--remote-debugging-port=${debuggingPort}`,
        "--remote-allow-origins=*",
        "--disable-background-networking"
      ].join(" ")
    }
  });
  children.push(app);

  const mainTarget = await waitForTarget(debuggingPort, (target) =>
    target.type === "page" && target.url?.startsWith(devUrl) && !target.url.includes("screenSharePopout=")
  );
  mainClient = await CDP.connect(mainTarget.webSocketDebuggerUrl);
  // WebView2 can expose the intended target URL before committing its initial about:blank document.
  if (await mainClient.evaluate(`location.href === 'about:blank'`)) {
    await mainClient.call("Page.navigate", { url: `${devUrl}/` });
  }
  try {
    await waitForValue(mainClient, `(() => ({
      ready: document.readyState !== 'loading',
      tauri: Boolean(window.__TAURI_INTERNALS__?.invoke),
      shell: Boolean(document.querySelector('.app-shell'))
    }))()`, (value) => value?.ready && value?.tauri && value?.shell);
  } catch (caught) {
    const targetResponse = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).catch(() => null);
    const targets = targetResponse?.ok ? await targetResponse.json() : [];
    const diagnostic = await mainClient.evaluate(`(() => ({
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyText: document.body?.innerText?.slice(0, 500) || '',
      bodyHTML: document.body?.innerHTML?.slice(0, 1000) || '',
      tauriKeys: Object.keys(window).filter((key) => key.includes('TAURI')).sort(),
      resources: performance.getEntriesByType('resource').slice(-12).map((entry) => entry.name)
    }))()`);
    throw new Error(
      `desktop shell did not initialize: ${JSON.stringify(diagnostic)}; targets=${JSON.stringify(targets.map(({ id, type, url, title }) => ({ id, type, url, title })))}; app=${formatChildOutput(app)}; vite=${formatChildOutput(viteProcess)}; ${caught instanceof Error ? caught.message : caught}`
    );
  }

  await mainClient.call("Page.bringToFront");
  const previewRenderingBeforePopout = await waitForValue(
    mainClient,
    `document.querySelector('.app-shell')?.dataset.localScreenSharePreviewRendering || ''`,
    (value) => value === "enabled"
  );
  assert.equal(previewRenderingBeforePopout, "enabled", "focused desktop window unexpectedly paused local preview rendering");

  const openedAt = Date.now();
  const opened = await mainClient.evaluate(`window.__TAURI_INTERNALS__.invoke('open_screen_share_popout', {
    shareId: 'desktop-popout-e2e',
    title: 'EchoVoice Popout E2E'
  }).then(() => ({ ok: true })).catch((error) => ({ ok: false, error: String(error) }))`);
  assert.deepEqual(opened, { ok: true }, `popout command failed: ${JSON.stringify(opened)}`);
  assert.ok(Date.now() - openedAt < 8000, "popout creation blocked the desktop UI thread");

  const popoutTarget = await waitForTarget(debuggingPort, (target) =>
    target.type === "page" && target.url?.includes("screenSharePopout=desktop-popout-e2e")
  );
  popoutClient = await CDP.connect(popoutTarget.webSocketDebuggerUrl);
  await popoutClient.call("Page.bringToFront");
  await mainClient.evaluate(`window.dispatchEvent(new Event('blur'))`);
  const previewRenderingWhileUnfocused = await waitForValue(
    mainClient,
    `document.querySelector('.app-shell')?.dataset.localScreenSharePreviewRendering || ''`,
    (value) => value === "paused"
  );
  assert.equal(previewRenderingWhileUnfocused, "paused", "desktop window did not pause local preview rendering after losing focus");
  const rendered = await waitForValue(popoutClient, `(() => {
    const shell = document.querySelector('.app-shell.screen-share-popout-mode');
    const controls = document.querySelector('.screen-share-popout-controls');
    const volume = controls?.querySelector('.screen-share-popout-volume-slider');
    const close = controls?.querySelector('.screen-share-popout-close');
    if (!shell || !controls || !volume || !close) return null;
    const bodyStyle = getComputedStyle(document.body);
    const htmlStyle = getComputedStyle(document.documentElement);
    return {
      titlebarPresent: Boolean(document.querySelector('.screen-share-popout-titlebar')),
      controlsInShell: shell.contains(controls),
      volumeDisabled: volume.disabled,
      closeLabel: close.getAttribute('aria-label'),
      minimizePresent: Boolean(controls.querySelector('[aria-label*="最小"], [aria-label*="Minimize"]')),
      resizeHandles: document.querySelectorAll('.screen-share-popout-resize-handle').length,
      bodyBackground: bodyStyle.backgroundColor,
      htmlBackground: htmlStyle.backgroundColor,
      width: window.innerWidth,
      height: window.innerHeight
    };
  })()`, Boolean);
  assert.equal(rendered.titlebarPresent, false, "popout still renders the old titlebar");
  assert.equal(rendered.controlsInShell, true, "popout overlay controls are outside the draggable surface");
  assert.equal(rendered.volumeDisabled, true, "volume control should wait for a screen-share session");
  assert.ok(rendered.closeLabel, "popout close control is missing an accessible label");
  assert.equal(rendered.minimizePresent, false, "popout should only expose volume and close controls");
  assert.equal(rendered.resizeHandles, 8, "popout resize handles are incomplete");
  assert.ok(rendered.width >= 420 && rendered.height >= 260, `invalid popout size: ${rendered.width}x${rendered.height}`);
  assert.notEqual(rendered.bodyBackground, "rgb(255, 255, 255)", "popout body rendered as a white page");
  assert.notEqual(rendered.htmlBackground, "rgb(255, 255, 255)", "popout root rendered as a white page");

  await popoutClient.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.floor(rendered.width / 2),
    y: Math.floor(rendered.height / 2)
  });
  const controlsVisible = await waitForValue(popoutClient, `(() => {
    const controls = document.querySelector('.screen-share-popout-controls');
    if (!controls) return false;
    const style = getComputedStyle(controls);
    return style.opacity === '1' && style.pointerEvents === 'auto';
  })()`);
  assert.equal(controlsVisible, true, "popout controls did not appear when the window was hovered");

  const mainResponsive = await mainClient.evaluate(
    `window.__TAURI_INTERNALS__.invoke('desktop_window_is_maximized').then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error) }))`
  );
  assert.equal(mainResponsive.ok, true, `main window stopped responding: ${JSON.stringify(mainResponsive)}`);

  await popoutClient.evaluate(`(() => {
    const close = document.querySelector('.screen-share-popout-close');
    close?.click();
    return Boolean(close);
  })()`);
  await waitForTargetGone(debuggingPort, popoutTarget.id);
  await popoutClient.close().catch(() => undefined);
  popoutClient = undefined;

  await mainClient.call("Page.bringToFront");
  await mainClient.evaluate(`window.dispatchEvent(new Event('focus'))`);
  const previewRenderingAfterFocusReturns = await waitForValue(
    mainClient,
    `document.querySelector('.app-shell')?.dataset.localScreenSharePreviewRendering || ''`,
    (value) => value === "enabled"
  );
  assert.equal(previewRenderingAfterFocusReturns, "enabled", "desktop window did not resume local preview rendering after focus returned");

  const responsiveAfterClose = await mainClient.evaluate(
    `window.__TAURI_INTERNALS__.invoke('desktop_window_is_maximized').then(() => true).catch(() => false)`
  );
  assert.equal(responsiveAfterClose, true, "main window became unresponsive after closing the popout");
  assert.equal(app.exitCode, null, `desktop process exited unexpectedly: ${formatChildOutput(app)}`);

  console.log("ok - desktop popout renders as a video-only surface with hover controls");
  console.log("ok - desktop popout keeps all eight native resize handles");
  console.log("ok - opening and closing the popout leaves the main window responsive");
  console.log("ok - desktop focus changes pause and resume local screen-share preview rendering");
} finally {
  await popoutClient?.close().catch(() => undefined);
  await mainClient?.close().catch(() => undefined);
  for (const child of children.reverse()) await stopChild(child);
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (startedVite) console.log("ok - isolated Vite process stopped");
}
}

function buildDesktopExecutable() {
  if (process.env.EV_SKIP_DESKTOP_BUILD === "1" && existsSync(executable)) return;
  const cargoCandidates = [
    process.env.CARGO_BIN,
    "D:\\Environment\\bin\\cargo.exe",
    "cargo"
  ].filter(Boolean);
  const cargo = cargoCandidates.find((candidate) => candidate === "cargo" || existsSync(candidate));
  const result = spawnSync(cargo, ["build", "-p", "echovoice-desktop"], {
    cwd: repositoryDir,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const buildOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const sourceTime = statSync(join(desktopDir, "src-tauri", "src", "main.rs")).mtimeMs;
    const executableIsCurrent = existsSync(executable) && statSync(executable).mtimeMs >= sourceTime;
    const executableLocked = /failed to remove file[\s\S]*(os error 5|拒绝访问)/i.test(buildOutput);
    if (!executableIsCurrent || !executableLocked) {
      process.stderr.write(buildOutput);
      assert.equal(result.status, 0, "desktop executable build failed");
    }
    console.warn("warning - running desktop client locked the current executable; testing the up-to-date binary already on disk");
  } else if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  assert.equal(existsSync(executable), true, `desktop executable is missing: ${executable}`);
}

async function isHttpReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHttp(url, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${response.status} ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${label} did not start: ${lastError?.message ?? "timeout"}`);
}

async function waitForTarget(port, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        lastTargets = await response.json();
        const target = lastTargets.find((item) => item.webSocketDebuggerUrl && predicate(item));
        if (target) return target;
      }
    } catch {
      // The WebView2 debugging endpoint is not ready yet.
    }
    await delay(100);
  }
  throw new Error(`WebView2 target did not appear: ${JSON.stringify(lastTargets.map(({ id, type, url }) => ({ id, type, url })))}`);
}

async function waitForTargetGone(port, targetId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        if (!targets.some((item) => item.id === targetId)) return;
      }
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error("screen share popout did not close");
}

async function waitForValue(client, expression, predicate = Boolean, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastValue = await client.evaluate(expression);
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(80);
  }
  throw new Error(`WebView value timed out: ${lastError?.message ?? JSON.stringify(lastValue)}`);
}

function startChild(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (child.output.stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (child.output.stderr += String(chunk)));
  return child;
}

function formatChildOutput(child) {
  return `${child.output?.stdout ?? ""}\n${child.output?.stderr ?? ""}`.trim();
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill();
  }
  await Promise.race([exited, delay(2000)]);
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class CDP {
  static connect(url) {
    return new Promise((resolveConnection, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("error", () => reject(new Error("WebView2 debugging connection failed")), { once: true });
      socket.addEventListener("open", () => resolveConnection(new CDP(socket)), { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener("close", (event) => {
      for (const [id, request] of this.pending) {
        clearTimeout(request.timeout);
        request.reject(new Error(`WebView2 debugging socket closed: ${event.code} ${event.reason || "no reason"}`));
        this.pending.delete(id);
      }
    });
  }

  call(method, params = {}) {
    return new Promise((resolveCall, rejectCall) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`WebView2 debugging call timed out: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const evaluated = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (evaluated.exceptionDetails) {
      throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
    }
    return evaluated.result.value;
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolveClose) => this.socket.addEventListener("close", resolveClose, { once: true }));
    this.socket.close();
    await Promise.race([closed, delay(500)]);
  }
}

await runTest();
