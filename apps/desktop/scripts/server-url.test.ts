import assert from "node:assert/strict";
import { parseServerInviteLink, serverURLValidationOptions, validateServerURL } from "../src/lib/server-url.ts";

const webDevelopmentPolicy = serverURLValidationOptions({ desktop: false, development: true });
const webProductionPolicy = serverURLValidationOptions({ desktop: false, development: false });
const desktopProductionPolicy = serverURLValidationOptions({ desktop: true, development: false });

assert.deepEqual(validateServerURL("https://voice.example.com:17878/", { desktop: false }), {
  ok: true,
  url: "https://voice.example.com:17878"
});
assert.deepEqual(validateServerURL("http://voice.example.com:17878", webProductionPolicy), {
  ok: false,
  code: "web_https_required"
});
assert.deepEqual(validateServerURL("http://127.0.0.1:17878", desktopProductionPolicy), {
  ok: true,
  url: "http://127.0.0.1:17878"
});
assert.deepEqual(
  validateServerURL("http://127.0.0.1:17878", webDevelopmentPolicy),
  { ok: true, url: "http://127.0.0.1:17878" }
);
assert.deepEqual(validateServerURL("http://localhost:17878", webDevelopmentPolicy), {
  ok: true,
  url: "http://localhost:17878"
});
assert.deepEqual(validateServerURL("http://[::1]:17878", webDevelopmentPolicy), {
  ok: true,
  url: "http://[::1]:17878"
});
assert.deepEqual(validateServerURL("http://192.168.1.10:17878", webDevelopmentPolicy), {
  ok: false,
  code: "web_https_required"
});
assert.deepEqual(validateServerURL("http://127.0.0.1:17878", webProductionPolicy), {
  ok: false,
  code: "web_https_required"
});

assert.deepEqual(parseServerInviteLink("https://voice.example.test:17878/invite/invite_abc"), {
  baseUrl: "https://voice.example.test:17878",
  token: "invite_abc"
});
assert.equal(parseServerInviteLink("https://voice.example.test/not-an-invite"), null);
assert.deepEqual(validateServerURL("ftp://voice.example.com", { desktop: true }), {
  ok: false,
  code: "unsupported_protocol"
});
assert.deepEqual(validateServerURL("https://voice.example.com/subpath", { desktop: true }), {
  ok: false,
  code: "invalid"
});

console.log("server URL validation tests passed");
