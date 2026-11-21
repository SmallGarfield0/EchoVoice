import { readFileSync, writeFileSync } from "node:fs";
const file = "src/App.svelte";
let src = readFileSync(file, "utf8");
const before = src.length;
src = src.replace(/(\(realtimeSyncTick \+= 1, (?:channelsController|channelFiles|screenShare|remoteControl)\.[\w.]+)\(([^;\n]*);/g, "$1($3);");
writeFileSync(file, src);
console.log("chars", before, "->", src.length);
