export const avatarColorPalette = [
  "#7db5e8",
  "#76c7a1",
  "#d79ac8",
  "#d6b36a",
  "#9e9ade",
  "#e89b82",
  "#71c5c8",
  "#b3c875",
  "#8da7e8",
  "#c79ddd",
  "#e0a66f",
  "#92b5a7"
] as const;

const avatarColorPattern = /^#[0-9a-f]{6}$/i;

export function avatarColorForIdentity(identityKey: string): string {
  let hash = 2166136261;
  for (const character of identityKey || "echovoice") {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return avatarColorPalette[(hash >>> 0) % avatarColorPalette.length];
}

export function normalizeAvatarColor(color: string | null | undefined, identityKey: string): string {
  const normalized = String(color ?? "").trim().toLowerCase();
  return avatarColorPattern.test(normalized) ? normalized : avatarColorForIdentity(identityKey);
}

export function avatarTextColor(background: string): string {
  const color = normalizeAvatarColor(background, background);
  const red = Number.parseInt(color.slice(1, 3), 16) / 255;
  const green = Number.parseInt(color.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(color.slice(5, 7), 16) / 255;
  const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  return luminance > 0.43 ? "#071018" : "#ffffff";
}

export function avatarStyleVariables(color: string | null | undefined, identityKey: string): string {
  const background = normalizeAvatarColor(color, identityKey);
  return `--member-avatar-bg: ${background}; --member-avatar-text: ${avatarTextColor(background)};`;
}
