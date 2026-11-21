import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import {
  applyChannelMove,
  buildChannelTree,
  channelDropTargetForChannel,
  channelOrderItems,
  childChannels,
  dropTargetLineIndex
} from "../src/lib/channelList.ts";
import type { Channel } from "../src/lib/types.ts";

const channels = (): Channel[] => [
  channel("cat-a", "category", "Project A", "", 1000),
  channel("general", "text", "general", "", 2000),
  channel("cat-b", "category", "Project B", "", 3000),
  channel("alpha", "text", "alpha", "cat-a", 1000),
  channel("beta", "voice", "beta", "cat-a", 2000),
  channel("ops", "text", "ops", "cat-b", 1000)
];

run("builds visible channel tree", () => {
  const tree = buildChannelTree(channels());
  assert.deepEqual(
    tree.topLevel.map((item) => item.channel_id),
    ["cat-a", "general", "cat-b"]
  );
  assert.deepEqual(
    childChannels(tree, "cat-a").map((item) => item.channel_id),
    ["alpha", "beta"]
  );
});

run("drops a channel onto a category header as first child", () => {
  const list = channels();
  const tree = buildChannelTree(list);
  const target = channelDropTargetForChannel(tree, "general", "cat-a", "inside");
  assert.deepEqual(target, { parentId: "cat-a", index: 0 });
  assert.equal(dropTargetLineIndex(tree, "general", target!), 0);

  const next = applyChannelMove(list, "general", target);
  assertChildOrder(next, "cat-a", ["general", "alpha", "beta"]);
  assertOrderPayload(next, [
    ["cat-a", ""],
    ["general", "cat-a"],
    ["alpha", "cat-a"],
    ["beta", "cat-a"],
    ["cat-b", ""],
    ["ops", "cat-b"]
  ]);
});

run("reorders categories only at the top level", () => {
  const list = channels();
  const tree = buildChannelTree(list);
  const target = channelDropTargetForChannel(tree, "cat-b", "cat-a", "before");
  assert.deepEqual(target, { parentId: "", index: 0 });
  assert.equal(dropTargetLineIndex(tree, "cat-b", target!), 0);

  const next = applyChannelMove(list, "cat-b", target);
  assertTopOrder(next, ["cat-b", "cat-a", "general"]);
  assertChildOrder(next, "cat-b", ["ops"]);
});

run("reorders children inside a category", () => {
  const list = channels();
  const tree = buildChannelTree(list);
  const target = channelDropTargetForChannel(tree, "beta", "alpha", "before");
  assert.deepEqual(target, { parentId: "cat-a", index: 0 });
  assert.equal(dropTargetLineIndex(tree, "beta", target!), 0);

  const next = applyChannelMove(list, "beta", target);
  assertChildOrder(next, "cat-a", ["beta", "alpha"]);
});

run("moves a categorized channel back to top level", () => {
  const list = channels();
  const tree = buildChannelTree(list);
  const target = channelDropTargetForChannel(tree, "alpha", "cat-b", "after");
  assert.deepEqual(target, { parentId: "", index: 3 });

  const next = applyChannelMove(list, "alpha", target);
  assertTopOrder(next, ["cat-a", "general", "cat-b", "alpha"]);
  assertChildOrder(next, "cat-a", ["beta"]);
});

run("shows insertion targets for the original slot without moving", () => {
  const list = channels();
  const tree = buildChannelTree(list);
  const afterPrevious = channelDropTargetForChannel(tree, "general", "cat-a", "after");
  const beforeNext = channelDropTargetForChannel(tree, "general", "cat-b", "before");

  assert.deepEqual(afterPrevious, { parentId: "", index: 1 });
  assert.deepEqual(beforeNext, afterPrevious);
  assert.equal(applyChannelMove(list, "general", afterPrevious), null);
});

run("rejects category drops inside categories", () => {
  const tree = buildChannelTree(channels());
  assert.equal(channelDropTargetForChannel(tree, "cat-b", "cat-a", "inside"), null);
  assert.equal(channelDropTargetForChannel(tree, "cat-b", "alpha", "before"), null);
});

run("survives frequent moves without missing or duplicated channels", () => {
  let list = channels();
  const moves: Array<[string, string, "before" | "after" | "inside"]> = [
    ["general", "cat-a", "inside"],
    ["beta", "general", "before"],
    ["cat-b", "cat-a", "before"],
    ["ops", "cat-a", "inside"],
    ["general", "cat-b", "after"],
    ["alpha", "ops", "after"]
  ];

  for (let count = 0; count < 30; count += 1) {
    const [sourceId, targetId, placement] = moves[count % moves.length];
    const tree = buildChannelTree(list);
    const target = channelDropTargetForChannel(tree, sourceId, targetId, placement);
    if (!target) continue;
    list = applyChannelMove(list, sourceId, target) ?? list;
    assertNoDuplicateOrMissing(list, channels().map((item) => item.channel_id));
  }
});

run("handles create and delete reshaping", () => {
  const created = [...channels(), channel("new-text", "text", "new text", "cat-a", 3000)];
  assertChildOrder(created, "cat-a", ["alpha", "beta", "new-text"]);

  const deletedCategory = created
    .filter((item) => item.channel_id !== "cat-b")
    .map((item) => (item.parent_id === "cat-b" ? { ...item, parent_id: undefined, position: 3000 } : item));
  const tree = buildChannelTree(deletedCategory);
  assertTopOrder(deletedCategory, ["cat-a", "general", "ops"]);
  assert.equal(tree.byId.get("ops")?.parent_id ?? "", "");
});

run("renders dedicated insertion line nodes", () => {
  const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
  // Channel template/DOM logic now lives in the sidebar component and the
  // ChannelsController; App.svelte only wires them together.
  const sidebar = readFileSync(new URL("../src/components/ChannelSidebar.svelte", import.meta.url), "utf8");
  const contentPanel = readFileSync(new URL("../src/components/ContentPanel.svelte", import.meta.url), "utf8");
  const channelsModule = readFileSync(new URL("../src/lib/channels.svelte.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
  const overlayCount = sidebar.match(/class="channel-insert-line-overlay"/g)?.length ?? 0;
  const listIndex = sidebar.indexOf('class="channel-list"');
  const overlayIndex = sidebar.indexOf('class="channel-insert-line-overlay"');
  assert.equal(overlayCount, 1);
  assert.ok(listIndex >= 0 && overlayIndex > listIndex && overlayIndex < sidebar.length);
  assert.match(sidebar, /class="channel-insert-line-overlay"/);
  assert.match(sidebar, /style=\{channelDropLineStyle\(channelDrag\.line\)\}/);
  assert.doesNotMatch(sidebar, /handleChannelDocumentDragOver/);
  assert.doesNotMatch(sidebar, /draggable=\{canManageChannels\}/);
  assert.match(channelsModule, /clearChannelDragState\(\)/);
  assert.match(channelsModule, /scheduleCategoryDragExpand\(categoryId: string\)/);
  assert.match(channelsModule, /clearCategoryDragExpandTimer\(\)/);
  assert.match(sidebar, /class="empty-category nested-empty-category"/);
  assert.match(sidebar, /class="material-symbols-rounded app-icon category-toggle-icon"/);
  assert.match(sidebar, /collapsedCategoryIds\.has\(entry\.channel_id\)/);
  assert.doesNotMatch(sidebar, /isCategoryCollapsed\(entry\.channel_id\)/);
  assert.match(app, /\$: selectedChannel = channels\.find\(\(channel\) => channel\.channel_id === selectedChannelId\)/);
  assert.match(app, /\$: selectedChannelTitle = \(languagePack, serverPreviewLanguageId, selectedChannel/);
  assert.match(contentPanel, /<h1>\{selectedChannelTitle\}<\/h1>/);
  assert.doesNotMatch(contentPanel, /selectedChannelTitle\(\)/);
  assert.match(sidebar, /class="channel-context-menu"/);
  assert.match(channelsModule, /openChannelContextMenu\(channel: Channel, event: MouseEvent\)/);
  assert.match(channelsModule, /handleChannelRowPointerDown\(channel: Channel, event: PointerEvent\)/);
  assert.match(channelsModule, /handleChannelRowPointerMove\(channel: Channel, event: PointerEvent\)/);
  assert.match(channelsModule, /handleChannelRowPointerUp\(channel: Channel, event: PointerEvent\)/);
  assert.match(channelsModule, /beginPointerChannelDrag\(channel: Channel\)/);
  // The sidebar is a Svelte 5 component, so handlers are plain attributes
  // (`onpointerdown`) rather than the legacy `on:pointerdown` directives.
  assert.match(sidebar, /onpointerdown=\{\(event\) => handleChannelRowPointerDown\(entry, event\)\}/);
  assert.match(sidebar, /onpointerdown=\{\(event\) => handleChannelRowPointerDown\(channel, event\)\}/);
  assert.match(sidebar, /onpointermove=\{\(event\) => handleChannelRowPointerMove\(entry, event\)\}/);
  assert.match(sidebar, /onpointerup=\{\(event\) => handleChannelRowPointerUp\(entry, event\)\}/);
  assert.match(sidebar, /class="category-collapse-button"/);
  assert.match(sidebar, /onclick=\{\(\) => focusCategoryChannel\(entry\)\}/);
  assert.match(sidebar, /oncontextmenu=\{\(event\) => openChannelContextMenu\(entry, event\)\}/);
  assert.match(sidebar, /channelContextEditLabelKey\(channelContextMenuChannel\(\)\)/);
  assert.match(sidebar, /channelContextDeleteLabelKey\(channelContextMenuChannel\(\)\)/);
  assert.match(sidebar, /onclick=\{deleteContextMenuChannel\}/);
  assert.doesNotMatch(sidebar, /class="channel-action"/);
  assert.doesNotMatch(sidebar, /category-edit-action/);
  assert.match(channelsModule, /"channel\.editCategory"/);
  assert.match(channelsModule, /"channel\.deleteCategory"/);
  assert.match(channelsModule, /"channel\.deleteCategoryConfirm"/);
  assert.match(channelsModule, /document\.body\.classList\.add\("channel-drag-active"\)/);
  assert.match(channelsModule, /document\.body\.classList\.remove\("channel-drag-active"\)/);
  assert.doesNotMatch(channelsModule, /querySelectorAll\("\.channel-insert-line-overlay"\)/);
  assert.doesNotMatch(channelsModule, /querySelectorAll\("\.category-heading\.dragging, \.channel-row\.dragging"\)/);
  assert.match(channelsModule, /channelDropLineForTarget\(dropTarget: ChannelDropTarget, fallbackElement: HTMLElement\)/);
  assert.match(channelsModule, /sourceParentId === dropTarget\.parentId && sourceIndex === dropTarget\.index && sourceRect/);
  assert.match(channelsModule, /top: sourceRect\.top/);
  assert.match(channelsModule, /beforeRect\.bottom \+ \(afterRect\.top - beforeRect\.bottom\) \/ 2/);
  assert.doesNotMatch(channelsModule, /placement === "before" \? rect\.top : rect\.bottom/);
  assert.match(channelsModule, /const sourceId = this\.channelDrag\.sourceId;\s*const target = this\.channelDrag\.target;\s*this\.hooks\.setSuppressChannelClickUntil\(Date\.now\(\) \+ 220\);\s*this\.clearChannelDragState\(\);\s*if \(!target\) return;\s*await this\.applyChannelDropTarget\(sourceId, target\);/s);
  assert.match(css, /\.channel-insert-line-overlay/);
  assert.match(css, /position: fixed/);
  assert.match(css, /z-index: 2147483000/);
  assert.match(css, /body\.channel-drag-active \.category-heading\.dragging/);
  assert.match(css, /body:not\(\.channel-drag-active\) \.channel-insert-line-overlay/);
  assert.doesNotMatch(css, /\.channel-insert-line-overlay::before/);
  assert.match(css, /\.category-toggle-icon/);
  assert.match(css, /\.channel-context-menu/);
  assert.match(css, /\.channel-context-menu button\.danger/);
  assert.doesNotMatch(css, /\.channel-row \.channel-action/);
  assert.doesNotMatch(css, /category-edit-action/);
  assert.match(css, /\.category-collapse-button/);
  assert.match(css, /\.nested-empty-category/);
  assert.match(css, /body\.channel-drag-active \.nested-empty-category/);
  assert.match(css, /height: 2px/);
});

function channel(
  channel_id: string,
  type: Channel["type"],
  name: string,
  parent_id: string,
  position: number
): Channel {
  return { channel_id, type, name, parent_id: parent_id || undefined, position };
}

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function assertTopOrder(list: Channel[] | null, expected: string[]) {
  assert.ok(list);
  const tree = buildChannelTree(list);
  assert.deepEqual(tree.topLevel.map((item) => item.channel_id), expected);
}

function assertChildOrder(list: Channel[] | null, parentId: string, expected: string[]) {
  assert.ok(list);
  const tree = buildChannelTree(list);
  assert.deepEqual(childChannels(tree, parentId).map((item) => item.channel_id), expected);
}

function assertOrderPayload(list: Channel[] | null, expected: Array<[string, string]>) {
  assert.ok(list);
  assert.deepEqual(
    channelOrderItems(list).map((item) => [item.channel_id, item.parent_id ?? ""]),
    expected
  );
}

function assertNoDuplicateOrMissing(list: Channel[], expectedIds: string[]) {
  const ids = list.map((item) => item.channel_id).sort();
  assert.deepEqual(ids, [...expectedIds].sort());
  for (const channel of list) {
    if (channel.type === "category") {
      assert.equal(channel.parent_id ?? "", "");
    }
  }
}
