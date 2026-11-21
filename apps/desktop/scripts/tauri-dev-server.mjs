import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const devUrl = `http://${host}:${devPort}/`;

async function isDevServerRunning() {
  try {
    const response = await fetch(devUrl, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

if (await isDevServerRunning()) {
  console.log(`Reusing existing Vite dev server at ${devUrl}`);
  process.exit(0);
}

const viteCli = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const child = spawn(process.execPath, [viteCli, "--host", host, "--port", String(devPort), "--strictPort"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, EV_DESKTOP_DEV_PORT: String(devPort) },
  shell: false
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
