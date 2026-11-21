declare const __ECHOVOICE_CLIENT_VERSION__: string | undefined;

export const clientVersion = typeof __ECHOVOICE_CLIENT_VERSION__ === "string"
  ? __ECHOVOICE_CLIENT_VERSION__
  : "0.1.0";
export const minimumServerVersion = "0.1.0";

export type VersionCompatibility = {
  serverVersionUnknown: boolean;
  serverOutdated: boolean;
  clientOutdated: boolean;
};

type SemanticVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function evaluateVersionCompatibility(input: {
  serverVersion?: string;
  minimumClientVersion?: string;
  clientVersion?: string;
  minimumServerVersion?: string;
  clientUpdateRequired?: boolean;
}): VersionCompatibility {
  const serverVersion = parseSemanticVersion(input.serverVersion ?? "");
  const requiredServerVersion = parseSemanticVersion(input.minimumServerVersion ?? minimumServerVersion);
  const currentClientVersion = parseSemanticVersion(input.clientVersion ?? clientVersion);
  const requiredClientVersion = parseSemanticVersion(input.minimumClientVersion ?? "");
  return {
    serverVersionUnknown: !serverVersion,
    serverOutdated: Boolean(serverVersion && requiredServerVersion && compareSemanticVersions(serverVersion, requiredServerVersion) < 0),
    clientOutdated: Boolean(
      input.clientUpdateRequired ||
      (currentClientVersion && requiredClientVersion && compareSemanticVersions(currentClientVersion, requiredClientVersion) < 0)
    )
  };
}

export function compareVersions(left: string, right: string): number | null {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);
  if (!leftVersion || !rightVersion) return null;
  return compareSemanticVersions(leftVersion, rightVersion);
}

export function publicVersionSeries(value?: string): string | null {
  const version = parseSemanticVersion(value ?? "");
  return version ? `${version.major}.${version.minor}.x` : null;
}

function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = value.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? []
  };
}

function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (const [leftPart, rightPart] of [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch]
  ]) {
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
