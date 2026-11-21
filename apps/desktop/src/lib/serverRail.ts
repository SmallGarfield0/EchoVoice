import type { StoredServer } from "./types";

export const serverRailLayoutStorageKey = "ev.serverRail.layout.v1";

export type ServerRailServerItem = {
  type: "server";
  server_id: string;
};

export type ServerRailFolderItem = {
  type: "folder";
  folder_id: string;
  name: string;
  auto_name: boolean;
  server_ids: string[];
  collapsed: boolean;
};

export type ServerRailItem = ServerRailServerItem | ServerRailFolderItem;

export type ServerRailLayout = {
  version: 1;
  items: ServerRailItem[];
};

export type ServerRailStorage = Pick<Storage, "getItem" | "setItem">;

export function emptyServerRailLayout(): ServerRailLayout {
  return { version: 1, items: [] };
}

export function loadServerRailLayout(
  servers: StoredServer[],
  storage: ServerRailStorage = localStorage
): ServerRailLayout {
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(serverRailLayoutStorageKey) ?? "null");
  } catch {
    raw = null;
  }
  return normalizeServerRailLayout(raw, servers);
}

export function saveServerRailLayout(
  layout: ServerRailLayout,
  storage: ServerRailStorage = localStorage
) {
  storage.setItem(serverRailLayoutStorageKey, JSON.stringify(layout));
}

export function normalizeServerRailLayout(raw: unknown, servers: StoredServer[]): ServerRailLayout {
  const available = new Set(servers.map((server) => server.server_id));
  const seen = new Set<string>();
  const sourceItems = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  const items: ServerRailItem[] = [];

  for (const source of sourceItems) {
    if (!isRecord(source)) continue;
    if (source.type === "server") {
      const serverID = stringValue(source.server_id);
      if (!available.has(serverID) || seen.has(serverID)) continue;
      seen.add(serverID);
      items.push({ type: "server", server_id: serverID });
      continue;
    }
    if (source.type !== "folder") continue;
    const folderID = stringValue(source.folder_id);
    if (!folderID) continue;
    const serverIDs: string[] = [];
    if (Array.isArray(source.server_ids)) {
      for (const value of source.server_ids) {
        const serverID = stringValue(value);
        if (!available.has(serverID) || seen.has(serverID)) continue;
        seen.add(serverID);
        serverIDs.push(serverID);
      }
    }
    if (serverIDs.length === 0) continue;
    const folderName = stringValue(source.name).trim() || "Server folder";
    const autoName = source.auto_name === true
      || (!("auto_name" in source) && (folderName === "Server folder" || folderName === "服务器文件夹"));
    items.push({
      type: "folder",
      folder_id: folderID,
      name: folderName,
      auto_name: autoName,
      server_ids: serverIDs,
      collapsed: source.collapsed !== false
    });
  }

  for (const server of servers) {
    if (seen.has(server.server_id)) continue;
    items.push({ type: "server", server_id: server.server_id });
  }
  return { version: 1, items };
}

export function setServerRailFolderCollapsed(
  layout: ServerRailLayout,
  folderID: string,
  collapsed: boolean
): ServerRailLayout {
  return {
    ...layout,
    items: layout.items.map((item) =>
      item.type === "folder" && item.folder_id === folderID ? { ...item, collapsed } : item
    )
  };
}

export function renameServerRailFolder(
  layout: ServerRailLayout,
  folderID: string,
  name: string
): ServerRailLayout {
  const normalizedName = name.trim();
  if (!normalizedName) return layout;
  return {
    ...layout,
    items: layout.items.map((item) =>
      item.type === "folder" && item.folder_id === folderID
        ? { ...item, name: normalizedName.slice(0, 48), auto_name: false }
        : item
    )
  };
}

export function moveServerRailItemToTopLevel(
  layout: ServerRailLayout,
  source: { type: "server"; id: string } | { type: "folder"; id: string },
  insertionIndex: number
): ServerRailLayout {
  if (source.type === "folder") {
    const sourceIndex = layout.items.findIndex(
      (item) => item.type === "folder" && item.folder_id === source.id
    );
    if (sourceIndex < 0) return layout;
    const items = [...layout.items];
    const [folder] = items.splice(sourceIndex, 1);
    const adjustedIndex = sourceIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
    items.splice(clampIndex(adjustedIndex, items.length), 0, folder);
    return { ...layout, items };
  }

  const extracted = extractServer(layout, source.id);
  if (!extracted.found) return layout;
  const adjustedIndex = extracted.topLevelIndex >= 0 && extracted.topLevelIndex < insertionIndex
    ? insertionIndex - 1
    : insertionIndex;
  extracted.items.splice(clampIndex(adjustedIndex, extracted.items.length), 0, {
    type: "server",
    server_id: source.id
  });
  return { ...layout, items: extracted.items };
}

export function moveServerRailServerIntoFolder(
  layout: ServerRailLayout,
  serverID: string,
  folderID: string,
  insertionIndex = Number.MAX_SAFE_INTEGER
): ServerRailLayout {
  const extracted = extractServer(layout, serverID);
  if (!extracted.found) return layout;
  const folderIndex = extracted.items.findIndex(
    (item) => item.type === "folder" && item.folder_id === folderID
  );
  if (folderIndex < 0) return layout;
  const folder = extracted.items[folderIndex] as ServerRailFolderItem;
  const serverIDs = [...folder.server_ids];
  const adjustedIndex = extracted.folderID === folderID && extracted.folderChildIndex < insertionIndex
    ? insertionIndex - 1
    : insertionIndex;
  serverIDs.splice(clampIndex(adjustedIndex, serverIDs.length), 0, serverID);
  extracted.items[folderIndex] = { ...folder, server_ids: serverIDs, collapsed: false };
  return { ...layout, items: extracted.items };
}

export function createServerRailFolder(
  layout: ServerRailLayout,
  draggedServerID: string,
  targetServerID: string,
  name: string,
  folderID = createFolderID()
): ServerRailLayout {
  if (!draggedServerID || draggedServerID === targetServerID) return layout;
  const targetIndex = layout.items.findIndex(
    (item) => item.type === "server" && item.server_id === targetServerID
  );
  if (targetIndex < 0) return layout;
  const extracted = extractServer(layout, draggedServerID);
  if (!extracted.found) return layout;
  const nextTargetIndex = extracted.items.findIndex(
    (item) => item.type === "server" && item.server_id === targetServerID
  );
  if (nextTargetIndex < 0) return layout;
  extracted.items.splice(nextTargetIndex, 1, {
    type: "folder",
    folder_id: folderID,
    name: name.trim() || "Server folder",
    auto_name: true,
    server_ids: [targetServerID, draggedServerID],
    collapsed: false
  });
  return { ...layout, items: extracted.items };
}

export function ungroupServerRailFolder(layout: ServerRailLayout, folderID: string): ServerRailLayout {
  const folderIndex = layout.items.findIndex(
    (item) => item.type === "folder" && item.folder_id === folderID
  );
  if (folderIndex < 0) return layout;
  const folder = layout.items[folderIndex] as ServerRailFolderItem;
  const items = [...layout.items];
  items.splice(
    folderIndex,
    1,
    ...folder.server_ids.map<ServerRailServerItem>((serverID) => ({ type: "server", server_id: serverID }))
  );
  return { ...layout, items };
}

export function summarizeServerRailFolderServerNames(
  serverNames: string[],
  separator: string,
  maximumNames = 3,
  maximumNameLength = 12
) {
  const nameLimit = Math.max(1, Math.trunc(maximumNames));
  const characterLimit = Math.max(1, Math.trunc(maximumNameLength));
  return serverNames
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, nameLimit)
    .map((name) => {
      const characters = Array.from(name);
      return characters.length > characterLimit
        ? `${characters.slice(0, characterLimit).join("")}...`
        : name;
    })
    .join(separator);
}

function extractServer(layout: ServerRailLayout, serverID: string) {
  let found = false;
  let topLevelIndex = -1;
  let folderID = "";
  let folderChildIndex = -1;
  const items: ServerRailItem[] = [];
  layout.items.forEach((item, index) => {
    if (item.type === "server") {
      if (item.server_id === serverID) {
        found = true;
        topLevelIndex = index;
      } else {
        items.push(item);
      }
      return;
    }
    if (!item.server_ids.includes(serverID)) {
      items.push(item);
      return;
    }
    found = true;
    folderID = item.folder_id;
    folderChildIndex = item.server_ids.indexOf(serverID);
    const serverIDs = item.server_ids.filter((id) => id !== serverID);
    if (serverIDs.length === 1) {
      items.push({ type: "server", server_id: serverIDs[0] });
    } else if (serverIDs.length > 1) {
      items.push({ ...item, server_ids: serverIDs });
    }
  });
  return { found, items, topLevelIndex, folderID, folderChildIndex };
}

function clampIndex(index: number, length: number) {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(Math.trunc(index), length));
}

function createFolderID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `folder_${crypto.randomUUID()}`;
  }
  return `folder_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
