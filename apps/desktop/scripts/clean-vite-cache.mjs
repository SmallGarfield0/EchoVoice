import { rmSync } from "node:fs";
import { resolve } from "node:path";

const cacheDir = resolve("node_modules", ".vite");

rmSync(cacheDir, { recursive: true, force: true });
console.log(`Removed ${cacheDir}`);
