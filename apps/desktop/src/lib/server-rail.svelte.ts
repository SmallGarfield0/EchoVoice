// Server rail domain controller.
//
// Owns the saved-server rail state and actions: the persisted layout and its
// reconciliation against savedServers, drag & drop, the folder/server context
// menus, tooltips, storage migrations, connected-server bookkeeping, and the
// leave/remove-from-device flows.
//
// Workspace-core state (savedServers, storedCredential, activeServerId, the
// write queue, and the derived savedServersByID map) stays in the workspace
// component and is reached through hooks. The component keeps legacy-reactive
// aliases for template-bound fields; hot paths read this controller directly.

import {
  createServerRailFolder,
  emptyServerRailLayout,
  loadServerRailLayout,
  moveServerRailItemToTopLevel,
  moveServerRailServerIntoFolder,
  normalizeServerRailLayout,
  renameServerRailFolder,
  saveServerRailLayout,
  setServerRailFolderCollapsed,
  summarizeServerRailFolderServerNames,
  ungroupServerRailFolder,
  type ServerRailFolderItem,
  type ServerRailLayout
} from "./serverRail";
import { leaveServer } from "./api";
import {
  clearLegacyCredential,
  loadActiveServerId,
  loadLegacyCredential,
  removeServer
} from "./storage";
import type { VoiceConnectionContext } from "./voice-state.svelte";
import type {
  ConnectResponse,
  ServerSummary,
  StoredCredential,
  StoredServer
} from "./types";

export type ServerRailDragState = {
  type: "server" | "folder";
  id: string;
};

export type ServerRailPointerPressState = {
  type: "server" | "folder";
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
};

export type ServerRailDropTarget =
  | { type: "top-level"; index: number }
  | { type: "folder"; folderId: string; index: number }
  | { type: "merge"; serverId: string };

export type ServerRailTooltipState = {
  key: string;
  label: string;
  left: number;
  top: number;
};

export type ServerRailFolderContextMenuState = {
  folderId: string;
  x: number;
  y: number;
};

export type ServerRailServerContextMenuState = {
  serverId: string;
  x: number;
  y: number;
};

/**
 * Cross-cutting dependencies injected by the workspace component. Workspace
 * core state, storage APIs, dialogs, and other domain actions flow through
 * these lazy arrow hooks so this controller never imports the component.
 */
export type ServerRailHooks = {
  savedServers: () => StoredServer[];
  setSavedServers: (servers: StoredServer[]) => void;
  savedServersByID: () => ReadonlyMap<string, StoredServer>;
  storedCredential: () => StoredCredential | null;
  setStoredCredential: (credential: StoredCredential | null) => void;
  storedServerWriteQueue: () => Promise<void>;
  setStoredServerWriteQueue: (queue: Promise<void>) => void;
  activeServerId: () => string;
  setActiveServerId: (serverId: string) => void;
  server: () => ServerSummary | null;
  baseUrl: () => string;
  sessionToken: () => string;
  memberId: () => string;
  isOwner: () => boolean;
  voiceConnectionContext: () => VoiceConnectionContext | null;
  translate: (key: string, params?: Record<string, string | number>) => string;
  setError: (message: string) => void;
  setStatusKey: (key: string) => void;
  setConnectDialogOpen: (open: boolean) => void;
  setConnectError: (message: string) => void;
  showAppAlert: (message: string, options?: {
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }) => Promise<void>;
  showAppConfirm: (message: string, options?: {
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  showAppPrompt: (message: string, initialValue?: string, options?: {
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }) => Promise<string | null>;
  closeServerMenu: () => void;
  closeChannelContextMenu: () => void;
  closeMessageContextMenu: () => void;
  // Workspace-owned flows that the rail hands back to the component.
  reconnectSavedServer: (savedServer: StoredServer) => Promise<void>;
  reconnectToServer: (credential: StoredCredential, externalSignal?: AbortSignal) => Promise<void>;
  clearActiveServerWorkspace: (preserveServerId?: string) => void;
  disconnectVoiceConnection: (context: VoiceConnectionContext, reportFailure: boolean) => Promise<void>;
  // Storage boundary helpers owned by the workspace component.
  saveActiveServerId: (serverId: string) => void;
  loadServers: () => Promise<StoredServer[]>;
  loadCredential: (serverId: string) => Promise<StoredCredential | null>;
  saveCredential: (credential: StoredCredential) => Promise<void>;
  saveServer: (server: StoredServer) => Promise<void>;
  normalizeDevelopmentBaseUrl: (value: string) => string;
};

function serverListSignature(servers: StoredServer[]) {
  return servers.map((item) => item.server_id).sort().join("|");
}

export class ServerRailController {
  // Persisted layout. `serverSignature` records which savedServers snapshot
  // the layout was reconciled against so saves/removals reload it once.
  layout = $state<ServerRailLayout>(emptyServerRailLayout());
  serverSignature = $state("");
  // Drag & drop.
  drag = $state<ServerRailDragState | null>(null);
  dragX = $state(0);
  dragY = $state(0);
  dropTarget = $state<ServerRailDropTarget | null>(null);
  suppressClickUntil = $state(0);
  // Popups.
  folderContextMenu = $state<ServerRailFolderContextMenuState | null>(null);
  tooltip = $state<ServerRailTooltipState | null>(null);
  serverContextMenu = $state<ServerRailServerContextMenuState | null>(null);
  leaveBusy = $state(false);
  private pointerPress: ServerRailPointerPressState | null = null;

  private hooks: ServerRailHooks;

  constructor(hooks: ServerRailHooks) {
    this.hooks = hooks;
  }

  // ---- persisted layout -------------------------------------------------------

  /** Reloads and persists the layout when the savedServers set changes. */
  syncLayoutToSavedServers() {
    const signature = serverListSignature(this.hooks.savedServers());
    if (signature === this.serverSignature) return;
    this.serverSignature = signature;
    this.layout = loadServerRailLayout(this.hooks.savedServers());
    saveServerRailLayout(this.layout);
  }

  persistLayout(nextLayout: ServerRailLayout) {
    this.layout = normalizeServerRailLayout(nextLayout, this.hooks.savedServers());
    this.serverSignature = serverListSignature(this.hooks.savedServers());
    saveServerRailLayout(this.layout);
  }

  // ---- storage initialization & migrations -----------------------------------

  async initializeStorage() {
    this.hooks.setConnectDialogOpen(false);
    this.hooks.setConnectError("");
    this.hooks.setSavedServers(await this.hooks.loadServers());
    await this.migrateLegacyCredential();
    await this.migrateLegacyDevelopmentServerPort();
    this.hooks.setSavedServers(this.normalizeStoredServers(await this.hooks.loadServers()));

    const savedServers = this.hooks.savedServers();
    const requestedServerId = loadActiveServerId();
    const preferredServerId = savedServers.some((item) => item.server_id === requestedServerId)
      ? requestedServerId
      : savedServers[0]?.server_id ?? "";
    const reconnectOrder = [
      ...savedServers.filter((item) => item.server_id === preferredServerId),
      ...savedServers.filter((item) => item.server_id !== preferredServerId)
    ];
    for (const savedServer of reconnectOrder) {
      const credential = await this.hooks.loadCredential(savedServer.server_id);
      if (!credential) continue;
      this.hooks.setActiveServerId(savedServer.server_id);
      this.hooks.saveActiveServerId(savedServer.server_id);
      await this.hooks.reconnectToServer(credential);
      return;
    }

    this.hooks.setActiveServerId("");
    this.hooks.setStatusKey("status.disconnected");
  }

  private async migrateLegacyCredential() {
    const legacy = loadLegacyCredential();
    if (!legacy) return;
    const normalizedLegacy = this.normalizeStoredCredential(legacy);
    if (!(await this.hooks.loadCredential(normalizedLegacy.server_id))) {
      await this.hooks.saveCredential(normalizedLegacy);
    }
    if (!this.hooks.savedServers().some((item) => item.server_id === normalizedLegacy.server_id)) {
      await this.hooks.saveServer({
        server_id: normalizedLegacy.server_id,
        name: normalizedLegacy.baseUrl,
        base_url: normalizedLegacy.baseUrl,
        member_id: normalizedLegacy.member_id,
        last_connected_at_ms: Date.now()
      });
    }
    clearLegacyCredential();
  }

  normalizeStoredCredential(credential: StoredCredential): StoredCredential {
    return {
      ...credential,
      baseUrl: this.hooks.normalizeDevelopmentBaseUrl(credential.baseUrl)
    };
  }

  private normalizeStoredServers(servers: StoredServer[]): StoredServer[] {
    return servers.map((server) => {
      const base_url = this.hooks.normalizeDevelopmentBaseUrl(server.base_url);
      return {
        ...server,
        base_url,
        name: server.name === server.base_url ? base_url : server.name
      };
    });
  }

  private async migrateLegacyDevelopmentServerPort() {
    const savedServers = this.hooks.savedServers();
    const normalizedServers = this.normalizeStoredServers(savedServers);
    for (const server of normalizedServers) {
      const original = savedServers.find((item) => item.server_id === server.server_id);
      if (original && original.base_url !== server.base_url) {
        await this.hooks.saveServer(server);
      }
      const credential = await this.hooks.loadCredential(server.server_id);
      if (credential) {
        const normalizedCredential = this.normalizeStoredCredential(credential);
        if (normalizedCredential.baseUrl !== credential.baseUrl) {
          await this.hooks.saveCredential(normalizedCredential);
        }
      }
    }
  }

  // ---- connected-server bookkeeping -------------------------------------------

  async rememberConnectedServer(session: ConnectResponse, accessKey: string) {
    const credential = {
      baseUrl: this.hooks.baseUrl(),
      server_id: session.server_id,
      member_id: session.member_id,
      access_key: accessKey
    };
    this.hooks.setStoredCredential(credential);
    this.hooks.setActiveServerId(session.server_id);
    this.hooks.saveActiveServerId(session.server_id);
    await this.hooks.saveCredential(credential);
    await this.hooks.saveServer({
      server_id: session.server_id,
      name: this.hooks.server()?.name ?? this.hooks.baseUrl(),
      icon_data_url: this.hooks.server()?.icon_data_url ?? "",
      base_url: this.hooks.baseUrl(),
      member_id: session.member_id,
      last_connected_at_ms: Date.now()
    });
    this.hooks.setSavedServers(await this.hooks.loadServers());
  }

  syncSavedServerSummary(summary: ServerSummary): Promise<void> {
    const savedServers = this.hooks.savedServers();
    const existing = savedServers.find((item) => item.server_id === summary.server_id);
    const isCurrentServer = this.hooks.activeServerId() === summary.server_id ||
      this.hooks.server()?.server_id === summary.server_id;
    if (!existing && !isCurrentServer) return Promise.resolve();
    const next: StoredServer = {
      server_id: summary.server_id,
      name: summary.name,
      icon_data_url: summary.icon_data_url ?? "",
      base_url: existing?.base_url ?? this.hooks.baseUrl(),
      member_id: existing?.member_id || this.hooks.memberId(),
      last_connected_at_ms: existing?.last_connected_at_ms ?? Date.now()
    };
    this.hooks.setSavedServers(
      existing
        ? savedServers.map((item) => (item.server_id === next.server_id ? next : item))
        : [...savedServers, next]
    );
    if (this.tooltip?.key === `server:${summary.server_id}`) {
      this.tooltip = { ...this.tooltip, label: summary.name };
    }
    const queue = this.hooks.storedServerWriteQueue()
      .catch(() => undefined)
      .then(() => this.hooks.saveServer(next))
      .catch(() => undefined);
    this.hooks.setStoredServerWriteQueue(queue);
    return queue;
  }

  savedServerByID(serverID: string) {
    return this.hooks.savedServersByID().get(serverID);
  }

  activateSavedServer(savedServer: StoredServer, event: MouseEvent) {
    this.hideTooltip();
    (event.currentTarget as HTMLButtonElement).blur();
    if (this.hooks.activeServerId() === savedServer.server_id &&
      this.hooks.sessionToken() &&
      this.hooks.server()?.server_id === savedServer.server_id) {
      return;
    }
    void this.hooks.reconnectSavedServer(savedServer);
  }

  generatedFolderName(
    serverIDs: string[],
    serversByID: ReadonlyMap<string, StoredServer> = this.hooks.savedServersByID()
  ) {
    const serverNames = serverIDs.map((serverID) => serversByID.get(serverID)?.name ?? "");
    const summary = summarizeServerRailFolderServerNames(
      serverNames,
      this.hooks.translate("server.folderNameSeparator")
    );
    return summary
      ? this.hooks.translate("server.folderGeneratedName", { servers: summary })
      : this.hooks.translate("server.folderDefaultName");
  }

  folderDisplayName(
    folder: ServerRailFolderItem,
    serversByID: ReadonlyMap<string, StoredServer> = this.hooks.savedServersByID()
  ) {
    return folder.auto_name ? this.generatedFolderName(folder.server_ids, serversByID) : folder.name;
  }

  // ---- tooltips ---------------------------------------------------------------

  showTooltip(key: string, label: string, event: Event) {
    if (this.drag) return;
    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLElement)) return;
    const rect = trigger.getBoundingClientRect();
    this.tooltip = {
      key,
      label,
      left: Math.round(rect.right + 10),
      top: Math.round(Math.max(18, Math.min(window.innerHeight - 18, rect.top + rect.height / 2)))
    };
  }

  hideTooltip(key = "") {
    if (!key || this.tooltip?.key === key) this.tooltip = null;
  }

  // ---- pointer / drag handling -------------------------------------------------

  handlePointerDown(type: "server" | "folder", id: string, event: PointerEvent) {
    if (event.button !== 0) return;
    this.pointerPress = {
      type,
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
    };
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  handlePointerMove(type: "server" | "folder", id: string, event: PointerEvent) {
    const press = this.pointerPress;
    if (!press || press.type !== type || press.id !== id || press.pointerId !== event.pointerId) return;
    if (!this.drag && Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > 6) {
      this.beginPointerDrag(type, id);
    }
    if (!this.drag) return;
    event.preventDefault();
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    this.scrollDuringDrag(event.clientY);
    this.dropTarget = this.dropCandidateFromPoint(event.clientX, event.clientY);
  }

  handlePointerUp(type: "server" | "folder", id: string, event: PointerEvent) {
    const press = this.pointerPress;
    this.pointerPress = null;
    if (!press || press.type !== type || press.id !== id || press.pointerId !== event.pointerId) return;
    if (!this.drag) return;
    event.preventDefault();
    event.stopPropagation();
    this.commitPointerDrop();
  }

  handlePointerCancel(type: "server" | "folder", id: string, event: PointerEvent) {
    const press = this.pointerPress;
    if (!press || press.type !== type || press.id !== id || press.pointerId !== event.pointerId) return;
    this.pointerPress = null;
    this.finishDrag();
  }

  beginPointerDrag(type: "server" | "folder", id: string) {
    this.closeServerContextMenu();
    this.closeFolderContextMenu();
    this.hideTooltip();
    this.drag = { type, id };
    this.dropTarget = null;
    this.suppressClickUntil = Date.now() + 600;
    document.body.classList.add("server-rail-drag-active");
  }

  finishDrag() {
    document.body.classList.remove("server-rail-drag-active");
    this.pointerPress = null;
    this.drag = null;
    this.dropTarget = null;
    this.suppressClickUntil = Date.now() + 240;
  }

  commitPointerDrop() {
    const source = this.drag;
    const target = this.dropTarget;
    if (!source || !target) {
      this.finishDrag();
      return;
    }
    if (target.type === "merge" && source.type === "server") {
      const serverIDs = [target.serverId, source.id];
      this.persistLayout(
        createServerRailFolder(this.layout, source.id, target.serverId, this.generatedFolderName(serverIDs))
      );
    } else if (target.type === "folder" && source.type === "server") {
      this.persistLayout(moveServerRailServerIntoFolder(this.layout, source.id, target.folderId, target.index));
    } else if (target.type === "top-level") {
      this.persistLayout(moveServerRailItemToTopLevel(this.layout, source, target.index));
    }
    this.finishDrag();
  }

  dropCandidateFromPoint(x: number, y: number): ServerRailDropTarget | null {
    const source = this.drag;
    const hit = document.elementFromPoint(x, y);
    if (!source || !(hit instanceof Element)) return null;

    const topZone = hit.closest<HTMLElement>("[data-server-rail-top-drop-index]");
    if (topZone) {
      const index = Number.parseInt(topZone.dataset.serverRailTopDropIndex ?? "", 10);
      return Number.isInteger(index) ? { type: "top-level", index } : null;
    }

    const folderZone = hit.closest<HTMLElement>("[data-server-rail-folder-drop-index]");
    if (folderZone && source.type === "server") {
      const index = Number.parseInt(folderZone.dataset.serverRailFolderDropIndex ?? "", 10);
      const folderId = folderZone.dataset.serverRailFolderId ?? "";
      return folderId && Number.isInteger(index) ? { type: "folder", folderId, index } : null;
    }

    const child = hit.closest<HTMLElement>("[data-server-rail-child-index]");
    if (child && source.type === "server") {
      const index = Number.parseInt(child.dataset.serverRailChildIndex ?? "", 10);
      const folderId = child.dataset.serverRailFolderId ?? "";
      const rect = child.getBoundingClientRect();
      return folderId && Number.isInteger(index)
        ? { type: "folder", folderId, index: index + (y >= rect.top + rect.height / 2 ? 1 : 0) }
        : null;
    }

    const serverItem = hit.closest<HTMLElement>("[data-server-rail-server-id][data-server-rail-item-index]");
    if (serverItem) {
      const serverId = serverItem.dataset.serverRailServerId ?? "";
      const index = Number.parseInt(serverItem.dataset.serverRailItemIndex ?? "", 10);
      const rect = serverItem.getBoundingClientRect();
      const relativeY = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
      if (source.type === "server" && source.id !== serverId && relativeY >= 0.2 && relativeY <= 0.8) {
        return { type: "merge", serverId };
      }
      return Number.isInteger(index)
        ? { type: "top-level", index: index + (relativeY >= 0.5 ? 1 : 0) }
        : null;
    }

    const folderItem = hit.closest<HTMLElement>("[data-server-rail-folder-id][data-server-rail-item-index]");
    if (folderItem) {
      const folderId = folderItem.dataset.serverRailFolderId ?? "";
      if (source.type === "server") {
        const folder = this.layout.items.find(
          (item): item is ServerRailFolderItem => item.type === "folder" && item.folder_id === folderId
        );
        return folder ? { type: "folder", folderId, index: folder.server_ids.length } : null;
      }
      const index = Number.parseInt(folderItem.dataset.serverRailItemIndex ?? "", 10);
      const rect = folderItem.getBoundingClientRect();
      return Number.isInteger(index)
        ? { type: "top-level", index: index + (y >= rect.top + rect.height / 2 ? 1 : 0) }
        : null;
    }

    const rail = hit.closest<HTMLElement>(".server-rail-items");
    return rail ? { type: "top-level", index: this.layout.items.length } : null;
  }

  scrollDuringDrag(pointerY: number) {
    const rail = document.querySelector<HTMLElement>(".server-rail-items");
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    if (pointerY < rect.top + 28) rail.scrollTop -= 14;
    else if (pointerY > rect.bottom - 28) rail.scrollTop += 14;
  }

  draggedLabel() {
    if (!this.drag) return "";
    if (this.drag.type === "server") return this.savedServerByID(this.drag.id)?.name ?? "";
    const folder = this.layout.items.find(
      (item): item is ServerRailFolderItem => item.type === "folder" && item.folder_id === this.drag?.id
    );
    return folder ? this.folderDisplayName(folder) : "";
  }

  toggleFolder(folder: ServerRailFolderItem) {
    this.persistLayout(setServerRailFolderCollapsed(this.layout, folder.folder_id, !folder.collapsed));
  }

  // ---- folder context menu -----------------------------------------------------

  openFolderContextMenu(folder: ServerRailFolderItem, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.closeServerContextMenu();
    this.hooks.closeServerMenu();
    this.folderContextMenu = {
      folderId: folder.folder_id,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 126))
    };
  }

  closeFolderContextMenu() {
    this.folderContextMenu = null;
  }

  folderContextMenuStyle() {
    if (!this.folderContextMenu) return "";
    return `left: ${this.folderContextMenu.x}px; top: ${this.folderContextMenu.y}px;`;
  }

  async renameFolderFromContextMenu() {
    const folderID = this.folderContextMenu?.folderId ?? "";
    const folder = this.layout.items.find(
      (item): item is ServerRailFolderItem => item.type === "folder" && item.folder_id === folderID
    );
    this.closeFolderContextMenu();
    if (!folder) return;
    const name = await this.hooks.showAppPrompt(
      this.hooks.translate("server.folderRenamePrompt"),
      this.folderDisplayName(folder),
      { title: this.hooks.translate("server.folderRename") }
    );
    if (name?.trim()) this.persistLayout(renameServerRailFolder(this.layout, folderID, name));
  }

  ungroupFolderFromContextMenu() {
    const folderID = this.folderContextMenu?.folderId ?? "";
    this.closeFolderContextMenu();
    if (folderID) this.persistLayout(ungroupServerRailFolder(this.layout, folderID));
  }

  // ---- server context menu -----------------------------------------------------

  openServerContextMenu(savedServer: StoredServer, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.hooks.closeServerMenu();
    this.closeFolderContextMenu();
    this.hooks.closeChannelContextMenu();
    this.hooks.closeMessageContextMenu();
    this.serverContextMenu = {
      serverId: savedServer.server_id,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 132))
    };
  }

  closeServerContextMenu() {
    this.serverContextMenu = null;
  }

  serverContextMenuStyle() {
    if (!this.serverContextMenu) return "";
    return `left: ${this.serverContextMenu.x}px; top: ${this.serverContextMenu.y}px;`;
  }

  async leaveFromContextMenu() {
    const targetServerId = this.serverContextMenu?.serverId ?? "";
    this.closeServerContextMenu();
    if (!targetServerId || this.leaveBusy) return;
    const target = this.hooks.savedServers().find((item) => item.server_id === targetServerId);
    if (!target) return;
    if (targetServerId === this.hooks.activeServerId() && this.hooks.isOwner()) {
      await this.hooks.showAppAlert(this.hooks.translate("server.ownerLeaveBlocked"), {
        title: this.hooks.translate("server.leave")
      });
      return;
    }

    const hasActiveSession = targetServerId === this.hooks.activeServerId() && Boolean(this.hooks.sessionToken());
    let credential: StoredCredential | null = null;
    try {
      credential = hasActiveSession ? this.hooks.storedCredential() : await this.hooks.loadCredential(targetServerId);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.connectionFailed"));
    }
    if (!hasActiveSession && !credential) {
      if (await this.confirmRemoveFromDevice(target, true)) {
        await this.removeFromDevice(target.server_id);
      }
      return;
    }

    if (!(await this.hooks.showAppConfirm(
      this.hooks.translate("server.leaveConfirm", { name: target.name }),
      {
        title: this.hooks.translate("server.leave"),
        confirmLabel: this.hooks.translate("server.leave"),
        danger: true
      }
    ))) return;
    this.leaveBusy = true;
    this.hooks.setError("");
    try {
      if (!hasActiveSession && credential) {
        await this.hooks.reconnectToServer(credential);
      }
      if (!this.hooks.sessionToken() || this.hooks.activeServerId() !== targetServerId) {
        throw new Error(this.hooks.translate("error.connectionFailed"));
      }
      if (this.hooks.isOwner()) {
        await this.hooks.showAppAlert(this.hooks.translate("server.ownerLeaveBlocked"), {
          title: this.hooks.translate("server.leave")
        });
        return;
      }
      await leaveServer(this.hooks.baseUrl(), this.hooks.sessionToken());
      await this.removeFromDevice(targetServerId, true);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("server.leaveFailed"));
    } finally {
      this.leaveBusy = false;
    }
  }

  async removeFromContextMenu() {
    const targetServerId = this.serverContextMenu?.serverId ?? "";
    this.closeServerContextMenu();
    if (!targetServerId || this.leaveBusy) return;
    const target = this.hooks.savedServers().find((item) => item.server_id === targetServerId);
    if (!target || !(await this.confirmRemoveFromDevice(target, false))) return;
    await this.removeFromDevice(targetServerId);
  }

  async confirmRemoveFromDevice(target: StoredServer, credentialMissing: boolean) {
    return this.hooks.showAppConfirm(
      this.hooks.translate(
        credentialMissing ? "server.removeFromDeviceMissingCredentialConfirm" : "server.removeFromDeviceConfirm",
        { name: target.name }
      ),
      {
        title: this.hooks.translate("server.removeFromDevice"),
        confirmLabel: this.hooks.translate("server.removeFromDevice"),
        danger: true
      }
    );
  }

  async removeFromDevice(targetServerId: string, alreadyBusy = false) {
    if (this.leaveBusy && !alreadyBusy) return;
    if (!alreadyBusy) this.leaveBusy = true;
    this.hooks.setError("");
    try {
      const connection = this.hooks.voiceConnectionContext();
      if (connection?.serverId === targetServerId) {
        await this.hooks.disconnectVoiceConnection(connection, false);
      }
      await removeServer(targetServerId);
      this.hooks.setSavedServers(await this.hooks.loadServers());
      if (this.hooks.activeServerId() === targetServerId) {
        this.hooks.clearActiveServerWorkspace();
      }
    } catch (caught) {
      this.hooks.setSavedServers(await this.hooks.loadServers());
      if (this.hooks.activeServerId() === targetServerId &&
        !this.hooks.savedServers().some((item) => item.server_id === targetServerId)) {
        this.hooks.clearActiveServerWorkspace();
      }
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("server.removeFromDeviceFailed"));
    } finally {
      if (!alreadyBusy) this.leaveBusy = false;
    }
  }

  /** Closes transient server-rail UI when the active workspace is torn down. */
  resetWorkspaceState() {
    this.closeServerContextMenu();
    this.closeFolderContextMenu();
    this.hideTooltip();
    this.pointerPress = null;
    this.drag = null;
    this.dropTarget = null;
    document.body.classList.remove("server-rail-drag-active");
  }
}
