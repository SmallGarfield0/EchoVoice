import type { Channel, ChannelOrderItem } from "./types";

export type ChannelDropPlacement = "before" | "after" | "inside";

export type ChannelDropTarget = {
  parentId: string;
  index: number;
};

export type ChannelTree = {
  byId: Map<string, Channel>;
  categoryIds: Set<string>;
  categories: Channel[];
  topLevel: Channel[];
  childrenByParentId: Map<string, Channel[]>;
};

const channelPositionStep = 1000;

export function sortChannels(items: Channel[]) {
  return [...items].sort((left, right) => left.position - right.position || left.channel_id.localeCompare(right.channel_id));
}

export function buildChannelTree(channels: Channel[]): ChannelTree {
  const sorted = sortChannels(channels);
  const byId = new Map(sorted.map((channel) => [channel.channel_id, channel]));
  const categories = sorted.filter((channel) => channel.type === "category");
  const categoryIds = new Set(categories.map((channel) => channel.channel_id));
  const childrenByParentId = new Map<string, Channel[]>();
  const topLevel: Channel[] = [];

  for (const channel of sorted) {
    if (channel.type === "category" || !channel.parent_id || !categoryIds.has(channel.parent_id)) {
      topLevel.push(channel);
      continue;
    }
    const children = childrenByParentId.get(channel.parent_id) ?? [];
    children.push(channel);
    childrenByParentId.set(channel.parent_id, children);
  }

  for (const category of categories) {
    if (!childrenByParentId.has(category.channel_id)) {
      childrenByParentId.set(category.channel_id, []);
    }
  }

  return { byId, categoryIds, categories, topLevel, childrenByParentId };
}

export function categoryChannels(tree: ChannelTree) {
  return tree.categories;
}

export function childChannels(tree: ChannelTree, parentId: string) {
  return tree.childrenByParentId.get(parentId) ?? [];
}

export function channelsInParent(tree: ChannelTree, parentId: string) {
  return parentId ? childChannels(tree, parentId) : tree.topLevel;
}

export function effectiveChannelParentId(tree: ChannelTree, channel: Channel) {
  if (channel.type === "category") return "";
  return channel.parent_id && tree.categoryIds.has(channel.parent_id) ? channel.parent_id : "";
}

export function isTopLevelChannel(tree: ChannelTree, channel: Channel) {
  return channel.type === "category" || effectiveChannelParentId(tree, channel) === "";
}

export function channelDropPlacementForTarget(
  source: Channel,
  target: Channel,
  rect: Pick<DOMRectReadOnly, "top" | "height">,
  clientY: number
): ChannelDropPlacement {
  if (source.type !== "category" && target.type === "category") {
    const y = (clientY - rect.top) / Math.max(rect.height, 1);
    if (y < 0.22) return "before";
    if (y > 0.78) return "after";
    return "inside";
  }
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

export function channelDropTargetForChannel(
  tree: ChannelTree,
  sourceId: string,
  targetId: string,
  placement: ChannelDropPlacement
) {
  const source = tree.byId.get(sourceId);
  const target = tree.byId.get(targetId);
  if (!source || !target || source.channel_id === target.channel_id) return null;

  if (source.type === "category") {
    if (placement === "inside" || !isTopLevelChannel(tree, target)) return null;
    return normalizeDropTarget(
      tree,
      source,
      {
        parentId: "",
        index: targetIndexForPlacement(tree, source, target, "", placement)
      },
      true
    );
  }

  if (placement === "inside") {
    if (target.type !== "category") return null;
    return normalizeDropTarget(tree, source, { parentId: target.channel_id, index: 0 }, true);
  }

  const parentId = effectiveChannelParentId(tree, target);
  return normalizeDropTarget(
    tree,
    source,
    {
      parentId,
      index: targetIndexForPlacement(tree, source, target, parentId, placement)
    },
    true
  );
}

export function applyChannelMove(channels: Channel[], sourceId: string, target: ChannelDropTarget | null) {
  const tree = buildChannelTree(channels);
  const source = tree.byId.get(sourceId);
  const normalizedTarget = source && target ? normalizeDropTarget(tree, source, target) : null;
  if (!source || !normalizedTarget) return null;

  const groups = channelGroups(tree);
  for (const [parentId, group] of groups) {
    groups.set(parentId, group.filter((channel) => channel.channel_id !== source.channel_id));
  }

  const targetGroup = groups.get(normalizedTarget.parentId) ?? [];
  const moved: Channel = {
    ...source,
    parent_id: source.type === "category" || !normalizedTarget.parentId ? undefined : normalizedTarget.parentId
  };
  targetGroup.splice(Math.min(normalizedTarget.index, targetGroup.length), 0, moved);
  groups.set(normalizedTarget.parentId, targetGroup);

  const next: Channel[] = [];
  for (const [parentId, group] of groups) {
    next.push(...normalizeChannelGroup(group, parentId));
  }
  return sortChannels(next);
}

export function channelOrderItems(channels: Channel[]): ChannelOrderItem[] {
  const tree = buildChannelTree(channels);
  const items: ChannelOrderItem[] = [];
  for (const channel of tree.topLevel) {
    items.push({ channel_id: channel.channel_id });
    if (channel.type !== "category") continue;
    for (const child of childChannels(tree, channel.channel_id)) {
      items.push({ channel_id: child.channel_id, parent_id: channel.channel_id });
    }
  }
  return items;
}

export function dropTargetLineIndex(tree: ChannelTree, sourceId: string, target: ChannelDropTarget) {
  const source = tree.byId.get(sourceId);
  if (!source) return target.index;
  const sourceParentId = effectiveChannelParentId(tree, source);
  if (sourceParentId !== target.parentId) return target.index;
  const sourceIndex = channelsInParent(tree, sourceParentId).findIndex((channel) => channel.channel_id === source.channel_id);
  return sourceIndex >= 0 && sourceIndex <= target.index ? target.index + 1 : target.index;
}

export function sameDropTarget(left: ChannelDropTarget | null, right: ChannelDropTarget | null) {
  return left?.parentId === right?.parentId && left?.index === right?.index;
}

function targetIndexForPlacement(
  tree: ChannelTree,
  source: Channel,
  target: Channel,
  parentId: string,
  placement: "before" | "after"
) {
  const siblings = channelsInParent(tree, parentId).filter((channel) => channel.channel_id !== source.channel_id);
  const targetIndex = siblings.findIndex((channel) => channel.channel_id === target.channel_id);
  if (targetIndex < 0) return -1;
  return placement === "after" ? targetIndex + 1 : targetIndex;
}

function normalizeDropTarget(tree: ChannelTree, source: Channel, target: ChannelDropTarget, allowNoop = false) {
  if (target.index < 0) return null;
  if (source.type === "category" && target.parentId) return null;
  if (target.parentId && !tree.categoryIds.has(target.parentId)) return null;

  const sourceParentId = effectiveChannelParentId(tree, source);
  const targetSiblings = channelsInParent(tree, target.parentId).filter(
    (channel) => channel.channel_id !== source.channel_id
  );
  const index = Math.max(0, Math.min(target.index, targetSiblings.length));
  const sourceIndex = channelsInParent(tree, sourceParentId).findIndex((channel) => channel.channel_id === source.channel_id);
  if (!allowNoop && sourceParentId === target.parentId && sourceIndex === index) return null;
  return { parentId: target.parentId, index };
}

function channelGroups(tree: ChannelTree) {
  const groups = new Map<string, Channel[]>();
  groups.set("", [...tree.topLevel]);
  for (const category of tree.categories) {
    groups.set(category.channel_id, [...childChannels(tree, category.channel_id)]);
  }
  return groups;
}

function normalizeChannelGroup(ordered: Channel[], parentId: string) {
  return ordered.map((channel, index) => ({
    ...channel,
    parent_id: channel.type === "category" ? undefined : parentId || undefined,
    position: (index + 1) * channelPositionStep
  }));
}
