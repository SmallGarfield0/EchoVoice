export type ServerURLValidationCode =
  | "empty"
  | "invalid"
  | "unsupported_protocol"
  | "web_https_required";

export type ServerURLValidation =
  | { ok: true; url: string }
  | { ok: false; code: ServerURLValidationCode };

export type ServerURLValidationOptions = {
  desktop: boolean;
  allowInsecureLoopback?: boolean;
};

export function serverURLValidationOptions(input: {
  desktop: boolean;
  development: boolean;
}): ServerURLValidationOptions {
  return {
    desktop: input.desktop,
    allowInsecureLoopback: !input.desktop && input.development
  };
}

export type ParsedServerInviteLink = {
  baseUrl: string;
  token: string;
};

export function parseServerInviteLink(input: string): ParsedServerInviteLink | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const match = parsed.pathname.match(/^\/invite\/([^/]+)\/?$/);
  if (!match) return null;
  let token = "";
  try {
    token = decodeURIComponent(match[1]).trim();
  } catch {
    return null;
  }
  if (!token || parsed.username || parsed.password) return null;
  return { baseUrl: parsed.origin, token };
}

export function validateServerURL(
  input: string,
  options: ServerURLValidationOptions
): ServerURLValidation {
  const value = input.trim().replace(/\/+$/, "");
  if (!value) return { ok: false, code: "empty" };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, code: "invalid" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "unsupported_protocol" };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, code: "invalid" };
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return { ok: false, code: "invalid" };
  }

  const insecureLoopbackAllowed = Boolean(
    options.allowInsecureLoopback &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]")
  );
  if (!options.desktop && parsed.protocol !== "https:" && !insecureLoopbackAllowed) {
    return { ok: false, code: "web_https_required" };
  }

  parsed.pathname = "";
  return { ok: true, url: parsed.toString().replace(/\/+$/, "") };
}
