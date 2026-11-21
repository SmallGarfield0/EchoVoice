import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const rustSource = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const tsSource = readFileSync(new URL("../src/lib/accompaniment.ts", import.meta.url), "utf8");

function rustOpusFmtp(): Record<string, string> {
  // The engine registration is what lands in the SDP; the track's own
  // `sdp_fmtp_line` is overridden by it. Compare the constant that the engine
  // registration and the track both use, not whichever literal appears first.
  const match = /const SCREEN_SHARE_OPUS_FMTP: &str =\s*"([^"]+)"/.exec(rustSource);
  assert.ok(match, "the native sender must advertise an Opus fmtp line");
  return parseParameters(match[1]);
}

function webOpusParameters(): Record<string, string> {
  const match = /screenShareOpusParameters\s*=\s*\[([^\]]*)\]/.exec(tsSource);
  assert.ok(match, "the web sharer must declare screen-share Opus parameters");
  const values = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  return parseParameters(values.join(";"));
}

function parseParameters(fmtp: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const entry of fmtp.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    parameters[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return parameters;
}

const native = rustOpusFmtp();
const web = webOpusParameters();

run("both senders ask for stereo screen-share audio", () => {
  // The web sharer shipped as mono for eighteen rounds because nothing compared
  // the two ends: the browser default fmtp omits stereo and the native fmtp had
  // it, so only browser sharers sounded flat.
  assert.equal(native["stereo"], "1", "native Opus fmtp must request stereo");
  assert.equal(web["stereo"], "1", "web Opus fmtp must request stereo");
  assert.equal(native["sprop-stereo"], "1");
  assert.equal(web["sprop-stereo"], "1");
});

run("both senders enable Opus in-band FEC", () => {
  assert.equal(native["useinbandfec"], "1");
  assert.equal(web["useinbandfec"], "1");
});

run("both senders allow the same Opus bitrate ceiling", () => {
  assert.equal(native["maxaveragebitrate"], "160000");
  assert.equal(
    web["maxaveragebitrate"],
    native["maxaveragebitrate"],
    "the two ends must not drift apart on the Opus bitrate ceiling"
  );
});

run("the native audio bitrate stays inside the advertised Opus ceiling", () => {
  const bitrate = /const SCREEN_SHARE_AUDIO_BITRATE: i32 = ([\d_]+);/.exec(rustSource);
  assert.ok(bitrate, "the native sender must declare its screen-share audio bitrate");
  const configured = Number(bitrate[1].replaceAll("_", ""));
  assert.ok(
    configured <= Number(native["maxaveragebitrate"]),
    `configured audio bitrate ${configured} exceeds maxaveragebitrate ${native["maxaveragebitrate"]}`
  );
});
