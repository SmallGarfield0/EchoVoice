// Layout domain: panel widths, resize orchestration, user-status panel height
// measurement, and viewport-driven layout reconciliation. The controller owns
// member-panel width + persistence and the user-status panel height; channel
// panel width stays owned by ChannelsController (lib/channels.svelte.ts) and
// is exposed here as a proxy so App.svelte can treat layout as one surface.

import type { ChannelsController } from "./channels.svelte";
import type { ScreenShareSetupController } from "./screen-share-setup.svelte";

export const serverRailWidth = 72;
export const defaultMemberPanelWidth = 248;
export const minMemberPanelWidth = 220;
export const maxMemberPanelWidth = 420;
export const minContentPanelWidth = 420;
const memberPanelWidthStorageKey = "ev.layout.memberPanelWidth";

export type LayoutHooks = {
  channelsController: ChannelsController;
  screenShareSetup: ScreenShareSetupController;
  adjustComposerHeight: () => void;
  closeServerMenu: () => void;
  closeCreateChannelMenu: () => void;
  closeChannelContextMenu: () => void;
  closeVoiceNetworkDetails: () => void;
  closeSoundboardPopover: () => void;
  soundboardPopoverOpen: () => boolean;
  updateSoundboardPopoverPosition: () => void;
  accompanimentVolumePopoverOpen: () => boolean;
  updateAccompanimentVolumePopoverPosition: () => void;
  emojiPickerOpen: () => boolean;
  updateEmojiPickerPosition: () => void;
  channelPermissionTargetPickerOpen: () => boolean;
  updateChannelPermissionTargetMenuPosition: () => void;
  screenShareViewerPanelShareId: () => string;
  updateScreenShareViewerPanelPosition: () => void;
};

function loadMemberPanelWidth(): number {
  const parsed = Number(localStorage.getItem(memberPanelWidthStorageKey));
  const width = Number.isFinite(parsed) ? parsed : defaultMemberPanelWidth;
  return Math.round(Math.max(minMemberPanelWidth, Math.min(maxMemberPanelWidth, width)));
}

export class LayoutController {
  memberPanelWidth = $state(loadMemberPanelWidth());
  memberPanelResizing = $state(false);
  userStatusPanelHeight = $state(60);
  private memberPanelResizeStartX = 0;
  private memberPanelResizeStartWidth = this.memberPanelWidth;

  constructor(private hooks: LayoutHooks) {}

  // ---- channel panel (owned by ChannelsController, proxied here) ------------

  get channelPanelWidth(): number {
    return this.hooks.channelsController.channelPanelWidth;
  }

  get channelPanelResizing(): boolean {
    return this.hooks.channelsController.channelPanelResizing;
  }

  clampChannelPanelWidth(width: number): number {
    return this.hooks.channelsController.clampChannelPanelWidth(width);
  }

  setChannelPanelWidth(width: number): void {
    this.hooks.channelsController.setChannelPanelWidth(width);
  }

  startChannelPanelResize = (event: PointerEvent): void => {
    this.hooks.channelsController.startChannelPanelResize(event);
  };

  resizeChannelPanel = (event: PointerEvent): void => {
    this.hooks.channelsController.resizeChannelPanel(event);
  };

  finishChannelPanelResize = (): void => {
    this.hooks.channelsController.finishChannelPanelResize();
  };

  handleChannelPanelResizeKeydown = (event: KeyboardEvent): void => {
    this.hooks.channelsController.handleChannelPanelResizeKeydown(event);
  };

  // ---- member panel ----------------------------------------------------------

  maxAllowedMemberPanelWidth(): number {
    if (typeof window === "undefined") return maxMemberPanelWidth;
    const available = window.innerWidth - serverRailWidth - this.channelPanelWidth - minContentPanelWidth;
    return Math.max(minMemberPanelWidth, Math.min(maxMemberPanelWidth, available));
  }

  clampMemberPanelWidth(width: number): number {
    return Math.round(Math.max(minMemberPanelWidth, Math.min(this.maxAllowedMemberPanelWidth(), width)));
  }

  persistMemberPanelWidth(): void {
    localStorage.setItem(memberPanelWidthStorageKey, String(this.memberPanelWidth));
  }

  setMemberPanelWidth(width: number): void {
    this.memberPanelWidth = this.clampMemberPanelWidth(width);
    this.persistMemberPanelWidth();
    this.hooks.adjustComposerHeight();
  }

  startMemberPanelResize = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.hooks.closeServerMenu();
    this.hooks.closeCreateChannelMenu();
    this.hooks.closeChannelContextMenu();
    this.hooks.closeVoiceNetworkDetails();
    this.hooks.closeSoundboardPopover();
    this.memberPanelResizing = true;
    this.memberPanelResizeStartX = event.clientX;
    this.memberPanelResizeStartWidth = this.memberPanelWidth;
    document.body.classList.add("member-panel-resize-active");
    window.addEventListener("pointermove", this.resizeMemberPanel);
    window.addEventListener("pointerup", this.finishMemberPanelResize);
    window.addEventListener("pointercancel", this.finishMemberPanelResize);
  };

  resizeMemberPanel = (event: PointerEvent): void => {
    if (!this.memberPanelResizing) return;
    event.preventDefault();
    this.memberPanelWidth = this.clampMemberPanelWidth(
      this.memberPanelResizeStartWidth + this.memberPanelResizeStartX - event.clientX
    );
    this.hooks.adjustComposerHeight();
  };

  finishMemberPanelResize = (): void => {
    if (!this.memberPanelResizing) return;
    this.memberPanelResizing = false;
    this.memberPanelWidth = this.clampMemberPanelWidth(this.memberPanelWidth);
    this.persistMemberPanelWidth();
    this.hooks.adjustComposerHeight();
    document.body.classList.remove("member-panel-resize-active");
    window.removeEventListener("pointermove", this.resizeMemberPanel);
    window.removeEventListener("pointerup", this.finishMemberPanelResize);
    window.removeEventListener("pointercancel", this.finishMemberPanelResize);
  };

  handleMemberPanelResizeKeydown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.setMemberPanelWidth(this.memberPanelWidth + 12);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      this.setMemberPanelWidth(this.memberPanelWidth - 12);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      this.setMemberPanelWidth(minMemberPanelWidth);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      this.setMemberPanelWidth(this.maxAllowedMemberPanelWidth());
    }
  };

  measureUserStatusPanel = (node: HTMLElement) => {
    const update = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      if (nextHeight > 0 && nextHeight !== this.userStatusPanelHeight) this.userStatusPanelHeight = nextHeight;
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    window.addEventListener("resize", update);
    return {
      destroy() {
        observer?.disconnect();
        window.removeEventListener("resize", update);
      }
    };
  };

  handleLayoutResize = (): void => {
    const nextMemberWidth = this.clampMemberPanelWidth(this.memberPanelWidth);
    if (nextMemberWidth !== this.memberPanelWidth) {
      this.memberPanelWidth = nextMemberWidth;
      this.persistMemberPanelWidth();
    }
    const nextWidth = this.clampChannelPanelWidth(this.channelPanelWidth);
    if (nextWidth !== this.channelPanelWidth) {
      this.setChannelPanelWidth(nextWidth);
    }
    this.hooks.adjustComposerHeight();
    const setup = this.hooks.screenShareSetup;
    if (setup.resolutionMenuOpen) setup.updateResolutionMenuPosition();
    if (setup.frameRateMenuOpen) setup.updateFrameRateMenuPosition();
    if (setup.bitrateMenuOpen) setup.updateBitrateMenuPosition();
    if (setup.contentModeMenuOpen) setup.updateContentModeMenuPosition();
    if (this.hooks.soundboardPopoverOpen()) this.hooks.updateSoundboardPopoverPosition();
    if (this.hooks.accompanimentVolumePopoverOpen()) this.hooks.updateAccompanimentVolumePopoverPosition();
    if (this.hooks.emojiPickerOpen()) this.hooks.updateEmojiPickerPosition();
    if (this.hooks.channelPermissionTargetPickerOpen()) this.hooks.updateChannelPermissionTargetMenuPosition();
    if (this.hooks.screenShareViewerPanelShareId()) this.hooks.updateScreenShareViewerPanelPosition();
  };
}
