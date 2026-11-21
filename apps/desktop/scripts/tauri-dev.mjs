import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Cargo keeps the artefacts of superseded dependency versions and one
// incremental session per debugging session forever. Prune them before the
// build starts: the script is idempotent, throttled to once every 12 hours and
// never fails the dev session.
spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/prune-build-caches.mjs", import.meta.url))], {
  stdio: "inherit",
  shell: false
});

const host = "127.0.0.1";
const defaultDevPort = 7173;

function readDevPort() {
  const rawPort = process.env.EV_DESKTOP_DEV_PORT ?? String(defaultDevPort);
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid EV_DESKTOP_DEV_PORT: ${rawPort}`);
  }

  return port;
}

const devPort = readDevPort();
const devUrl = `http://${host}:${devPort}`;
const config = JSON.stringify({
  build: {
    beforeDevCommand: "npm run dev:tauri",
    devUrl
  }
});

const tauriCli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
const child = spawn(process.execPath, [tauriCli, "dev", "--config", config, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, EV_DESKTOP_DEV_PORT: String(devPort) },
  shell: false
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
