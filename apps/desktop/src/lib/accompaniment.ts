import type { DesktopAudioProcessSource } from "./types.ts";

export function accompanimentSourceDisplayName(source: DesktopAudioProcessSource): string {
  return source.name.trim() || source.appName?.trim() || "Desktop audio";
}

export function accompanimentSourceSessionName(source: DesktopAudioProcessSource): string {
  return accompanimentSessionName(accompanimentSourceDisplayName(source), "Desktop audio");
}

export function accompanimentSessionName(value: string, fallback: string): string {
  return Array.from(value.trim() || fallback).slice(0, 120).join("");
}

const musicOpusParameters = [
  "stereo=1",
  "sprop-stereo=1",
  "maxaveragebitrate=256000",
  "useinbandfec=1",
  "usedtx=0",
  "cbr=0"
];

/**
 * Shared screen audio is a soundtrack: stereo, and at a bitrate the browser's
 * default Opus fmtp never asks for. These are the values the native sharer
 * already advertises, so both sharers produce the same sound.
 */
const screenShareOpusParameters = [
  "stereo=1",
  "sprop-stereo=1",
  "maxaveragebitrate=160000",
  "useinbandfec=1",
  "usedtx=0"
];

function enhanceOpusFmtp(section: string, parameters: readonly string[]): string {
  const opusPayload = section.match(/^a=rtpmap:(\d+) opus\/48000\/2$/im)?.[1];
  if (!opusPayload) return section;
  const fmtpPattern = new RegExp(`^a=fmtp:${opusPayload} (.*)$`, "im");
  const existing = section.match(fmtpPattern)?.[1]
    ?.split(";")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  const controlledNames = new Set(parameters.map((value) => value.split("=")[0]));
  const merged = [
    ...existing.filter((value) => !controlledNames.has(value.split("=")[0].toLowerCase())),
    ...parameters
  ].join(";");
  return fmtpPattern.test(section)
    ? section.replace(fmtpPattern, `a=fmtp:${opusPayload} ${merged}`)
    : `${section}\r\na=fmtp:${opusPayload} ${merged}`;
}

function enhanceOpusAudioSections(
  sdp: string,
  parameters: readonly string[],
  shouldEnhance: (audioSectionIndex: number) => boolean
): string {
  if (!sdp) return sdp;
  const sections = sdp.split("\r\nm=");
  let audioSectionIndex = 0;
  return sections.map((section, index) => {
    const normalized = index === 0 ? section : `m=${section}`;
    if (!normalized.startsWith("m=audio ")) return index === 0 ? normalized : normalized.slice(2);
    audioSectionIndex += 1;
    if (!shouldEnhance(audioSectionIndex)) return index === 0 ? normalized : normalized.slice(2);
    const updated = enhanceOpusFmtp(normalized, parameters);
    return index === 0 ? updated : updated.slice(2);
  }).join("\r\nm=");
}

/**
 * The voice connection carries two audio sections: the microphone first and the
 * desktop accompaniment second. Only the accompaniment is treated as music.
 */
export function enhanceAccompanimentOpusSDP(sdp: string): string {
  return enhanceOpusAudioSections(sdp, musicOpusParameters, (index) => index === 2);
}

/**
 * A screen-share connection carries the shared system audio, and nothing else
 * needs protecting: every audio section in it is that soundtrack.
 */
export function enhanceScreenShareOpusSDP(sdp: string): string {
  return enhanceOpusAudioSections(sdp, screenShareOpusParameters, () => true);
}
