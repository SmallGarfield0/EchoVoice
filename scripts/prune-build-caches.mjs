#!/usr/bin/env node
/**
 * Prunes build cache that Cargo never garbage-collects.
 *
 * Cargo keeps one artifact set per dependency version, feature set and profile
 * forever: after a `Cargo.lock` bump the previous `rlib`/`rmeta`/`pdb` copies
 * stay in `target/<profile>/deps`, and every incremental session leaves its own
 * directory behind. EchoVoice accumulated ~22 GB that way.
 *
 * The prune is conservative by construction: an artifact is only removed when
 * the crate version recorded in its dep-info (`.d`) file is no longer part of
 * `Cargo.lock`. Anything that cannot be identified - path dependencies, git
 * dependencies, artifacts without a `.d` file - is kept. A prune therefore
 * never deletes something the current build needs, so it cannot force a
 * recompile of a live dependency.
 *
 * Usage:
 *   node scripts/prune-build-caches.mjs [options]
 *
 * Options:
 *   --dry-run                  Report what would be removed, delete nothing.
 *   --force                    Ignore the throttle stamp.
 *   --verbose                  List every removed artifact.
 *   --incremental-days=<n>     Age before unused incremental dirs go (14).
 *   --keep-incremental=<n>     Always keep the newest n incremental dirs (2).
 *   --min-hours=<n>            Throttle: run at most once per n hours (12).
 *   --max-size=<size>          Hard cap on target/, e.g. 10GB. Deletes the
 *                              oldest artifacts until target/ fits. Off by
 *                              default because it can evict live artifacts and
 *                              force a rebuild.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(repoRoot, "target");
const stampPath = join(targetDir, ".cache-prune.json");
const HASH = /-([0-9a-f]{16})\.[^.]+$/;
const REGISTRY = /registry[\\/]src[\\/][^\\/]+[\\/](.+?)-(\d+\.\d+\.\d+[^\\/]*)[\\/]/;

const options = {
  dryRun: false,
  force: false,
  verbose: false,
  incrementalDays: 14,
  keepIncremental: 2,
  minHours: 12,
  maxSizeBytes: 0,
};

const stats = { freed: 0, removed: 0, kept: 0, failed: 0 };

function parseSize(text) {
  const match = /^([\d.]+)\s*(b|kb|mb|gb|tb)?$/i.exec(text.trim());
  if (!match) return 0;
  const units = { b: 1, kb: 1 << 10, mb: 1 << 20, gb: 1 << 30, tb: 1 << 40 };
  return Math.round(Number(match[1]) * (units[(match[2] || "b").toLowerCase()] || 1));
}

function human(bytes) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(0)} KB`;
  return `${bytes} B`;
}

function parseArgs(argv) {
  for (const arg of argv) {
    const [key, raw] = arg.split("=");
    switch (key) {
      case "--dry-run": options.dryRun = true; break;
      case "--force": options.force = true; break;
      case "--verbose": options.verbose = true; break;
      case "--incremental-days": options.incrementalDays = Number(raw ?? 14); break;
      case "--keep-incremental": options.keepIncremental = Number(raw ?? 2); break;
      case "--min-hours": options.minHours = Number(raw ?? 12); break;
      case "--max-size": options.maxSizeBytes = parseSize(raw ?? ""); break;
      case "--help":
        console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
        break;
      default:
        console.warn(`[prune] ignoring unknown option ${arg}`);
    }
  }
}

/** Depth-first walk without following symlinks. */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile()) {
      try {
        const info = statSync(path);
        yield { path, size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        // Raced with another process; ignore.
      }
    }
  }
}

function dirSize(dir) {
  let total = 0;
  for (const file of walk(dir)) total += file.size;
  return total;
}

function remove(path, size) {
  if (options.dryRun) {
    stats.freed += size;
    stats.removed += 1;
    if (options.verbose) console.log(`[prune] would remove ${path}`);
    return true;
  }
  try {
    rmSync(path, { recursive: true, force: true });
    stats.freed += size;
    stats.removed += 1;
    if (options.verbose) console.log(`[prune] removed ${path}`);
    return true;
  } catch (error) {
    stats.failed += 1;
    if (options.verbose) console.warn(`[prune] could not remove ${path}: ${error.message}`);
    return false;
  }
}

/** A build in flight owns these files; never race it. */
function buildIsRunning() {
  const probe = process.platform === "win32"
    ? spawnSync("tasklist", ["/NH", "/FO", "CSV"], { encoding: "utf8" })
    : spawnSync("ps", ["-A", "-o", "comm="], { encoding: "utf8" });
  if (probe.status !== 0 || !probe.stdout) return false;
  return /\b(cargo|rustc|tauri)(\.exe)?\b/i.test(probe.stdout);
}

function readLock() {
  if (!existsSync(join(repoRoot, "Cargo.lock"))) return null;
  const text = readFileSync(join(repoRoot, "Cargo.lock"), "utf8");
  const versions = new Set();
  const names = new Set();
  for (const match of text.matchAll(/\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g)) {
    names.add(match[1]);
    versions.add(`${match[1]}@${match[2]}`);
  }
  return { versions, names };
}

/** `windows-0.58.0` from the registry path in a dep-info file. */
function crateFromDepInfo(path) {
  let head;
  try {
    head = readFileSync(path, "utf8").slice(0, 8192);
  } catch {
    return null;
  }
  const match = REGISTRY.exec(head);
  return match ? { name: match[1], version: match[2] } : null;
}

function hashOf(fileName) {
  const match = HASH.exec(fileName);
  return match ? match[1] : null;
}

/**
 * Removes dependency artifacts whose version is absent from Cargo.lock.
 * The hash suffix links `.d`, `.rlib`, `.rmeta`, `.pdb` and `.dll` files of the
 * same unit, so a doomed unit always leaves as a set.
 */
function pruneDeps(profileDir, lock) {
  const depsDir = join(profileDir, "deps");
  if (!existsSync(depsDir)) return;

  let entries;
  try {
    entries = readdirSync(depsDir, { withFileTypes: true }).filter((e) => e.isFile());
  } catch {
    return;
  }

  const unitCrates = new Map();
  for (const entry of entries) {
    if (!entry.name.endsWith(".d")) continue;
    const hash = hashOf(entry.name);
    if (!hash) continue;
    const crate = crateFromDepInfo(join(depsDir, entry.name));
    if (crate) unitCrates.set(hash, crate);
  }

  const doomedHashes = new Set();
  for (const [hash, crate] of unitCrates) {
    if (!lock.versions.has(`${crate.name}@${crate.version}`)) doomedHashes.add(hash);
  }
  if (doomedHashes.size === 0) return;

  const doomedSizes = new Map();
  for (const entry of entries) {
    const hash = hashOf(entry.name);
    if (!hash || !doomedHashes.has(hash)) continue;
    const path = join(depsDir, entry.name);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (remove(path, size)) doomedSizes.set(hash, (doomedSizes.get(hash) || 0) + size);
  }

  if (options.verbose) {
    for (const hash of doomedSizes.keys()) {
      const crate = unitCrates.get(hash);
      console.log(`[prune] obsolete dependency ${crate.name} ${crate.version}`);
    }
  }
}

/** Removes build-script dirs of dependencies that left Cargo.lock. */
function pruneBuild(profileDir, lock) {
  const buildDir = join(profileDir, "build");
  if (!existsSync(buildDir)) return;

  for (const entry of readdirSync(buildDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(buildDir, entry.name);
    const match = /^(.+?)-[0-9a-f]{16}$/.exec(entry.name);
    if (!match) continue;
    const crateName = match[1];

    // Name vanished from the lock: nothing in the graph can reference it.
    if (!lock.names.has(crateName)) {
      remove(path, dirSize(path));
      continue;
    }

    // Otherwise only trust a dep-info file that names an older version.
    let doomed = false;
    for (const file of walk(path)) {
      if (!file.path.endsWith(".d")) continue;
      const crate = crateFromDepInfo(file.path);
      if (crate && crate.name === crateName && !lock.versions.has(`${crate.name}@${crate.version}`)) {
        doomed = true;
        break;
      }
    }
    if (doomed) remove(path, dirSize(path));
  }
}

/**
 * Incremental state is a pure cache: dropping it only costs recompiling the
 * workspace crates, never the dependency graph. Session dirs pile up, one per
 * debugging session, so anything past the newest few and older than the
 * threshold goes.
 */
function pruneIncremental(profileDir) {
  const incrementalDir = join(profileDir, "incremental");
  if (!existsSync(incrementalDir)) return;

  let sessions;
  try {
    sessions = readdirSync(incrementalDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const path = join(incrementalDir, e.name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {
          // ignore
        }
        return { path, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }

  const cutoff = Date.now() - options.incrementalDays * 86_400_000;
  const keep = Math.max(0, options.keepIncremental);
  sessions.forEach((session, index) => {
    if (index < keep) return;
    if (session.mtimeMs >= cutoff) return;
    remove(session.path, dirSize(session.path));
  });
}

/** Opt-in hard cap: evict oldest artifacts until target/ fits. */
function enforceMaxSize() {
  if (!options.maxSizeBytes) return;
  let total = dirSize(targetDir);
  if (total <= options.maxSizeBytes) return;

  const files = [];
  for (const profile of readdirSync(targetDir, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue;
    for (const folder of ["deps", "build", "incremental"]) {
      const dir = join(targetDir, profile.name, folder);
      if (existsSync(dir)) files.push(...walk(dir));
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    if (total <= options.maxSizeBytes) break;
    if (remove(file.path, file.size)) total -= file.size;
  }
}

function throttled() {
  if (options.force || options.dryRun) return false;
  if (!existsSync(stampPath)) return false;
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    const hours = (Date.now() - Date.parse(stamp.at)) / 3_600_000;
    return hours < options.minHours;
  } catch {
    return false;
  }
}

function main() {
  parseArgs(process.argv.slice(2));
  if (!existsSync(targetDir)) return;
  if (throttled()) return;
  // A prune is never worth racing a build: cargo would just redo the work.
  if (buildIsRunning()) {
    if (options.verbose) console.log("[prune] build in progress, skipping");
    return;
  }

  const lock = readLock();
  if (!lock) return;

  const profiles = readdirSync(targetDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(targetDir, e.name));

  for (const profile of profiles) {
    pruneIncremental(profile);
    pruneDeps(profile, lock);
    pruneBuild(profile, lock);
  }
  enforceMaxSize();

  if (stats.removed > 0) {
    const verb = options.dryRun ? "would free" : "freed";
    console.log(`[prune] ${verb} ${human(stats.freed)} (${stats.removed} artifacts)`);
  }
  if (!options.dryRun && stats.removed > 0) {
    writeFileSync(stampPath, JSON.stringify({ at: new Date().toISOString(), freed: stats.freed }));
  }
}

try {
  main();
} catch (error) {
  // A failed prune must never break `npm run tauri:dev` / `tauri:build`.
  console.warn(`[prune] skipped: ${error.message}`);
}
