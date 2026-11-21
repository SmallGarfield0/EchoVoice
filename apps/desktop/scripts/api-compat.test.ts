import assert from "node:assert/strict";
import {
  getAccompanimentSessions,
  getCustomEmojis,
  getMembers,
  getRemoteControlSessions,
  getRTCConfig,
  getScreenShareSessions,
  getSoundboardItems,
  getVoiceStates,
  startAccompanimentSession
} from "../src/lib/api.ts";

const originalFetch = globalThis.fetch;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const requestedURLs: string[] = [];

try {
  globalThis.fetch = async (input) => {
    requestedURLs.push(String(input));
    return new Response("404 page not found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
  };

  assert.deepEqual(await getScreenShareSessions("http://legacy.test", "session"), []);
  assert.deepEqual(await getAccompanimentSessions("http://legacy.test", "session"), []);
  assert.deepEqual(await getRemoteControlSessions("http://legacy.test", "session"), []);
  assert.deepEqual(await getSoundboardItems("http://legacy.test", "session"), []);
  assert.deepEqual(await getCustomEmojis("http://legacy.test", "session"), []);
  assert.deepEqual(await getRTCConfig("http://legacy.test", "session"), { ice_servers: [] });
  assert.deepEqual(requestedURLs, [
    "http://legacy.test/api/v1/screen-shares",
    "http://legacy.test/api/v1/accompaniments",
    "http://legacy.test/api/v1/remote-controls",
    "http://legacy.test/api/v1/soundboard",
    "http://legacy.test/api/v1/emojis",
    "http://legacy.test/api/v1/rtc-config"
  ]);

  globalThis.fetch = async () => new Response(JSON.stringify({
    voice_states: [{
      channel_id: "voice-1",
      member_id: "member-1",
      joined_at_ms: 123,
      mic_muted: false,
      audio_deafened: false,
      server_muted: false,
      server_deafened: false,
      is_speaking: true
    }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  assert.deepEqual(await getVoiceStates("http://legacy.test", "session"), [{
    channel_id: "voice-1",
    member_id: "member-1",
    participant_id: "member-1",
    device_id: "",
    mode: "primary",
    joined_at_ms: 123,
    mic_muted: false,
    audio_deafened: false,
    server_muted: false,
    server_deafened: false,
    is_speaking: true
  }]);

  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: "EV_INTERNAL", message: "temporary failure" }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );
  await assert.rejects(
    getAccompanimentSessions("http://legacy.test", "session"),
    /temporary failure/
  );

  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: "EV_NOT_FOUND", message: "route not found" }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
  await assert.rejects(
    startAccompanimentSession("http://legacy.test", "session", "voice", "Music window"),
    (error: unknown) => error instanceof Error && (error as Error & { status?: number }).status === 404
  );

  const browserEvents = new EventTarget();
  let invalidSessionDetail: { message?: string; sessionToken?: string } | null = null;
  browserEvents.addEventListener("echovoice:session-invalid", (event) => {
    invalidSessionDetail = (event as CustomEvent<{ message?: string; sessionToken?: string }>).detail;
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: browserEvents
  });
  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: "EV_AUTH_SESSION_INVALID", message: "session token is invalid" }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
  await assert.rejects(
    getMembers("http://legacy.test", "expired-session"),
    /session token is invalid/
  );
  assert.deepEqual(invalidSessionDetail, {
    message: "session token is invalid",
    sessionToken: "expired-session"
  });

  console.log("optional media API compatibility tests passed");
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
}
