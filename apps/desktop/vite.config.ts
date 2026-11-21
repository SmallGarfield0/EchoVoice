import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const defaultDevPort = 7173;
const desktopVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")
).version;

function readDevPort() {
  const rawPort = process.env.EV_DESKTOP_DEV_PORT ?? String(defaultDevPort);
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid EV_DESKTOP_DEV_PORT: ${rawPort}`);
  }

  return port;
}

export default defineConfig({
  plugins: [svelte()],
  define: {
    __ECHOVOICE_CLIENT_VERSION__: JSON.stringify(desktopVersion)
  },
  publicDir: fileURLToPath(new URL("../../sound", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: readDevPort(),
    strictPort: true
  }
});
