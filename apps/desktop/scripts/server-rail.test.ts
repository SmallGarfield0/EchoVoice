import assert from "node:assert/strict";
import {
  createServerRailFolder,
  moveServerRailItemToTopLevel,
  moveServerRailServerIntoFolder,
  normalizeServerRailLayout,
  renameServerRailFolder,
  summarizeServerRailFolderServerNames,
  ungroupServerRailFolder
} from "../src/lib/serverRail.ts";
import type { StoredServer } from "../src/lib/types.ts";

const server = (server_id: string): StoredServer => ({
  server_id,
  name: server_id,
  base_url: `https://${server_id}.example.test`,
  member_id: `member_${server_id}`,
  last_connected_at_ms: 1
});

const servers = [server("a"), server("b"), server("c"), server("d")];
let layout = normalizeServerRailLayout(null, servers);
assert.deepEqual(layout.items.map((item) => item.type === "server" ? item.server_id : item.folder_id), ["a", "b", "c", "d"]);

layout = createServerRailFolder(layout, "b", "a", "Friends", "folder_one");
assert.equal(layout.items[0].type, "folder");
assert.deepEqual(layout.items[0].type === "folder" ? layout.items[0].server_ids : [], ["a", "b"]);
assert.equal(layout.items[0].type === "folder" ? layout.items[0].auto_name : false, true);

layout = moveServerRailServerIntoFolder(layout, "d", "folder_one", 1);
assert.deepEqual(layout.items[0].type === "folder" ? layout.items[0].server_ids : [], ["a", "d", "b"]);

layout = moveServerRailServerIntoFolder(layout, "a", "folder_one", 2);
assert.deepEqual(layout.items[0].type === "folder" ? layout.items[0].server_ids : [], ["d", "a", "b"]);

layout = moveServerRailItemToTopLevel(layout, { type: "server", id: "d" }, 2);
assert.deepEqual(layout.items.map((item) => item.type === "server" ? item.server_id : item.folder_id), ["folder_one", "c", "d"]);

layout = renameServerRailFolder(layout, "folder_one", "  Games  ");
assert.equal(layout.items[0].type === "folder" ? layout.items[0].name : "", "Games");
assert.equal(layout.items[0].type === "folder" ? layout.items[0].auto_name : true, false);

layout = ungroupServerRailFolder(layout, "folder_one");
assert.deepEqual(layout.items.map((item) => item.type === "server" ? item.server_id : item.folder_id), ["a", "b", "c", "d"]);

const normalized = normalizeServerRailLayout(
  {
    items: [
      { type: "folder", folder_id: "folder_old", name: "Old", server_ids: ["a", "missing", "a"] },
      { type: "server", server_id: "b" }
    ]
  },
  servers
);
assert.deepEqual(
  normalized.items.flatMap((item) => item.type === "server" ? [item.server_id] : item.server_ids),
  ["a", "b", "c", "d"]
);
assert.equal(normalized.items[0].type === "folder" ? normalized.items[0].auto_name : true, false);

const migratedDefaultFolder = normalizeServerRailLayout(
  {
    items: [
      { type: "folder", folder_id: "folder_default", name: "服务器文件夹", server_ids: ["a", "b"] }
    ]
  },
  servers
);
assert.equal(migratedDefaultFolder.items[0].type === "folder" ? migratedDefaultFolder.items[0].auto_name : false, true);

assert.equal(
  summarizeServerRailFolderServerNames(["Alpha", "Beta", "Gamma", "Delta"], "、"),
  "Alpha、Beta、Gamma"
);
assert.equal(
  summarizeServerRailFolderServerNames(["ABCDEFGHIJKLM", "Short"], ", "),
  "ABCDEFGHIJKL..., Short"
);

console.log("server rail tests passed");
