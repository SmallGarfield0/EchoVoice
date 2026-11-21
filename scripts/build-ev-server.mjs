import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repositoryDir, "services", "ev-server");
const outputDir = join(serverDir, "bin");
const webClientDir = join(repositoryDir, "apps", "desktop", "dist");
const embeddedDir = join(serverDir, "internal", "webassets", "dist");
const serverVersion = JSON.parse(readFileSync(join(repositoryDir, "package.json"), "utf8")).version;
const versionVariable = "github.com/echovoice/echovoice/services/ev-server/internal/buildinfo.Version";
const targets = [
  { goos: "windows", goarch: "amd64", file: "ev-server-windows-amd64.exe" },
  { goos: "linux", goarch: "amd64", file: "ev-server-linux-amd64" }
];

// Bundling the Web client is what makes a single ev-server.exe a complete
// deployment (web.root: "" serves this copy). The files have to live inside the
// package directory while `go build` runs, so they are staged and then removed:
// a build should never leave generated assets behind in the working tree.
let staged = [];

function stageWebClient() {
  if (!existsSync(join(webClientDir, "index.html"))) {
    console.warn(
      `No built Web client at ${webClientDir}; these binaries will need web.root to point at a directory.`
    );
    return;
  }
  for (const entry of readdirSync(webClientDir)) {
    const source = join(webClientDir, entry);
    const target = join(embeddedDir, entry);
    cpSync(source, target, { recursive: statSync(source).isDirectory() });
    staged.push(target);
  }
  console.log(`Bundling Web client from ${webClientDir} (${staged.length} entries)`);
}

function unstageWebClient() {
  for (const target of staged) rmSync(target, { recursive: true, force: true });
  staged = [];
}

mkdirSync(outputDir, { recursive: true });
mkdirSync(embeddedDir, { recursive: true });

stageWebClient();
try {
  for (const target of targets) {
    const output = join(outputDir, target.file);
    console.log(`Building EV Server ${target.goos}/${target.goarch} -> ${output}`);
    const result = spawnSync(
      "go",
      [
        "build",
        "-buildvcs=false",
        "-trimpath",
        `-ldflags=-s -w -X ${versionVariable}=${serverVersion}`,
        "-o",
        output,
        "./cmd/ev-server"
      ],
      {
        cwd: serverDir,
        env: {
          ...process.env,
          CGO_ENABLED: "0",
          GOOS: target.goos,
          GOARCH: target.goarch
        },
        stdio: "inherit",
        shell: false
      }
    );

    if (result.error) {
      console.error(`Could not start Go: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} finally {
  unstageWebClient();
}

console.log("EV Server Windows and Linux builds completed.");
