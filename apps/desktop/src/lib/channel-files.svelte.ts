// Channel file management (the "files" view of a text channel).
//
// Owns the server-authoritative file/directory listing for the currently
// selected channel, breadcrumb navigation, upload / rename / move / delete /
// download operations, multi-selection with pointer drag-to-move, and the
// file preview overlay (blob classification, text/document/archive parsing,
// object URL lifecycle). Message-attachment previews stay in the workspace
// component (messages domain) and reuse the preview helpers through hooks.
//
// Hot-path discipline: event handlers read this state directly; the
// component's legacy `$` aliases (kept fresh by the realtimeSyncTick bump)
// feed templates only.

import {
  createChannelDirectory,
  deleteChannelFileEntry,
  downloadChannelFile,
  fetchChannelFileBlob,
  fetchMessageImageBlob,
  getChannelFiles,
  updateChannelFileEntry,
  uploadChannelFile
} from "./api";
import {
  classifyFilePreview,
  filePreviewIcon,
  readArchivePreview,
  readDocumentPreview,
  readTextPreview,
  updateFileSelection,
  type ArchivePreview,
  type DocumentPreview,
  type FilePreviewKind
} from "./file-storage";
import { saveFileWithSystemPicker, systemFileSaveAvailable } from "./file-save";
import type { MessageImageReference } from "./message-attachments";
import type { ChannelFileEntry } from "./types";

export type ChannelFilesHooks = {
  memberId: () => string;
  sessionToken: () => string;
  baseUrl: () => string;
  translate: (key: string, params?: Record<string, unknown>) => string;
  setError: (message: string) => void;
  setStatusKey: (key: string) => void;
  selectedChannelId: () => string;
  channelContentMode: () => string;
  setChannelContentMode: (mode: string) => void;
  fileStorageAvailable: () => boolean;
  canViewFiles: () => boolean;
  canUploadFiles: () => boolean;
  canDownloadFiles: () => boolean;
  canManageFiles: () => boolean;
  nativeDesktopRuntime: () => boolean;
  fileInputElement: () => HTMLInputElement | null;
  setFileInputElement: (element: HTMLInputElement | null) => void;
  showAppConfirm: (message: string, options?: Record<string, unknown>) => Promise<boolean>;
  showAppPrompt: (title: string, value: string, options?: Record<string, unknown>) => Promise<string | null>;
  messageAttachmentEntries: () => Map<string, ChannelFileEntry>;
  setMessageAttachmentEntries: (entries: Map<string, ChannelFileEntry>) => void;
  composerAttachmentObjectURLs: () => Map<string, string>;
};

export class ChannelFilesController {
  // ---- listing / navigation --------------------------------------------------
  fileEntries = $state<ChannelFileEntry[]>([]);
  fileParentId = $state("");
  fileBreadcrumbs = $state<ChannelFileEntry[]>([]);
  fileLoading = $state(false);
  // ---- upload ----------------------------------------------------------------
  fileUploading = $state(false);
  fileUploadProgress = $state(0);
  // ---- operations ------------------------------------------------------------
  fileActionBusyId = $state("");
  // ---- selection + drag ------------------------------------------------------
  selectedFileEntryIds = $state<Set<string>>(new Set());
  fileSelectionAnchorId = $state("");
  filePointerPress = $state<{
    entryId: string;
    x: number;
    y: number;
    pointerId: number;
    dragging: boolean;
    preserveSelection: boolean;
  } | null>(null);
  fileDragX = $state(0);
  fileDragY = $state(0);
  fileDragTargetId = $state<string | null>(null);
  fileDragBusy = $state(false);
  private fileDragListenersAttached = false;
  // ---- preview ---------------------------------------------------------------
  filePreviewEntry = $state<ChannelFileEntry | null>(null);
  filePreviewMessageImageReference = $state<MessageImageReference | null>(null);
  filePreviewKind = $state<FilePreviewKind>("unknown");
  filePreviewObjectURL = $state("");
  filePreviewObjectURLShouldRevoke = $state(true);
  filePreviewText = $state("");
  filePreviewTextTruncated = $state(false);
  filePreviewArchive = $state<ArchivePreview | null>(null);
  filePreviewDocument = $state<DocumentPreview | null>(null);
  filePreviewLoading = $state(false);
  filePreviewError = $state("");
  private filePreviewRequestId = 0;

  constructor(private hooks: ChannelFilesHooks) {}

  // ---- view lifecycle --------------------------------------------------------

  clearFileView(): void {
    this.hooks.setChannelContentMode("chat");
    this.fileEntries = [];
    this.fileParentId = "";
    this.fileBreadcrumbs = [];
    this.fileLoading = false;
    this.fileUploading = false;
    this.fileUploadProgress = 0;
    this.fileActionBusyId = "";
    this.clearFileSelection();
    this.clearFileDrag();
    this.closeFilePreview();
    const input = this.hooks.fileInputElement();
    if (input) input.value = "";
  }

  async openChannelFiles(): Promise<void> {
    if (!this.hooks.fileStorageAvailable() || !this.hooks.canViewFiles() || !this.hooks.selectedChannelId() || !this.hooks.sessionToken()) return;
    this.hooks.setChannelContentMode("files");
    this.fileParentId = "";
    this.fileBreadcrumbs = [];
    this.clearFileSelection();
    await this.loadChannelFiles("");
  }

  returnToChannelChat(): void {
    this.hooks.setChannelContentMode("chat");
    this.hooks.setError("");
  }

  async loadChannelFiles(parentId = this.fileParentId): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || !this.hooks.fileStorageAvailable() || !this.hooks.canViewFiles()) return;
    const channelId = this.hooks.selectedChannelId();
    this.fileLoading = true;
    this.hooks.setError("");
    try {
      const entries = await getChannelFiles(this.hooks.baseUrl(), channelId, this.hooks.sessionToken(), parentId);
      if (this.hooks.selectedChannelId() !== channelId || this.hooks.channelContentMode() !== "files") return;
      this.fileParentId = parentId;
      this.fileEntries = this.sortFileEntriesForUI(entries);
      const visibleIds = new Set(this.fileEntries.map((entry) => entry.entry_id));
      this.selectedFileEntryIds = new Set([...this.selectedFileEntryIds].filter((entryId) => visibleIds.has(entryId)));
      if (!visibleIds.has(this.fileSelectionAnchorId)) this.fileSelectionAnchorId = "";
    } catch (caught) {
      if (this.hooks.selectedChannelId() === channelId) {
        this.fileEntries = [];
        this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileListFailed"));
      }
    } finally {
      if (this.hooks.selectedChannelId() === channelId) this.fileLoading = false;
    }
  }

  async enterFileDirectory(entry: ChannelFileEntry): Promise<void> {
    if (entry.type !== "directory") return;
    this.clearFileSelection();
    this.fileBreadcrumbs = [...this.fileBreadcrumbs.filter((item) => item.entry_id !== entry.entry_id), entry];
    await this.loadChannelFiles(entry.entry_id);
  }

  async openFileBreadcrumb(index: number): Promise<void> {
    this.clearFileSelection();
    if (index < 0) {
      this.fileBreadcrumbs = [];
      await this.loadChannelFiles("");
      return;
    }
    const target = this.fileBreadcrumbs[index];
    this.fileBreadcrumbs = this.fileBreadcrumbs.slice(0, index + 1);
    await this.loadChannelFiles(target?.entry_id ?? "");
  }

  triggerFileUpload(): void {
    if (!this.hooks.fileStorageAvailable() || !this.hooks.canUploadFiles() || this.fileUploading) return;
    this.hooks.fileInputElement()?.click();
  }

  async handleFileInputChange(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length === 0 || !this.hooks.canUploadFiles() || !this.hooks.selectedChannelId() || !this.hooks.sessionToken() || this.fileUploading) return;
    const channelId = this.hooks.selectedChannelId();
    const parentId = this.hooks.canViewFiles() ? this.fileParentId : "";
    this.fileUploading = true;
    this.fileUploadProgress = 0;
    this.hooks.setError("");
    try {
      for (const [index, file] of files.entries()) {
        const entry = await uploadChannelFile(this.hooks.baseUrl(), channelId, this.hooks.sessionToken(), file, parentId, (percent) => {
          this.fileUploadProgress = Math.round(((index + percent / 100) / files.length) * 100);
        });
        if (this.hooks.selectedChannelId() === channelId && this.hooks.canViewFiles()) this.mergeFileEntry(entry);
      }
      this.hooks.setStatusKey("files.uploaded");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileUploadFailed"));
    } finally {
      this.fileUploading = false;
      this.fileUploadProgress = 0;
      input.value = "";
    }
  }

  async createDirectoryInCurrentFolder(): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || !this.hooks.canManageFiles() || this.fileActionBusyId) return;
    const name = await this.hooks.showAppPrompt(this.hooks.translate("files.newFolderPrompt"), "", { title: this.hooks.translate("files.newFolder") });
    if (!name?.trim()) return;
    this.fileActionBusyId = "new-directory";
    this.hooks.setError("");
    try {
      const entry = await createChannelDirectory(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), name.trim(), this.fileParentId);
      this.mergeFileEntry(entry);
      this.hooks.setStatusKey("files.folderCreated");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileCreateFolderFailed"));
    } finally {
      this.fileActionBusyId = "";
    }
  }

  async renameFileEntry(entry: ChannelFileEntry): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || !this.canManageFileEntry(entry) || this.fileActionBusyId) return;
    const name = await this.hooks.showAppPrompt(this.hooks.translate("files.renamePrompt"), entry.name, { title: this.hooks.translate("files.rename") });
    if (!name?.trim() || name.trim() === entry.name) return;
    this.fileActionBusyId = entry.entry_id;
    this.hooks.setError("");
    try {
      const updated = await updateChannelFileEntry(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), entry.entry_id, {
        name: name.trim(),
        parent_id: entry.parent_id ?? ""
      });
      this.mergeFileEntry(updated);
      this.hooks.setStatusKey("files.renamed");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileRenameFailed"));
    } finally {
      this.fileActionBusyId = "";
    }
  }

  async deleteFileEntryFromChannel(entry: ChannelFileEntry): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || !this.canManageFileEntry(entry) || this.fileActionBusyId) return;
    if (!(await this.hooks.showAppConfirm(this.hooks.translate("files.deleteConfirm", { name: entry.name }), {
      title: this.hooks.translate("files.delete"),
      confirmLabel: this.hooks.translate("files.delete"),
      danger: true
    }))) return;
    this.fileActionBusyId = entry.entry_id;
    this.hooks.setError("");
    try {
      const deleted = await deleteChannelFileEntry(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), entry.entry_id);
      this.removeFileEntry(deleted);
      this.hooks.setStatusKey("files.deleted");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileDeleteFailed"));
    } finally {
      this.fileActionBusyId = "";
    }
  }

  async downloadFileEntryFromChannel(entry: ChannelFileEntry): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || !this.hooks.canDownloadFiles() || entry.type !== "file" || this.fileActionBusyId) return;
    this.fileActionBusyId = entry.entry_id;
    this.hooks.setError("");
    try {
      if (this.hooks.nativeDesktopRuntime()) {
        if (!systemFileSaveAvailable()) throw new Error(this.hooks.translate("error.desktopFileSaveUnavailable"));
        await saveFileWithSystemPicker(
          () => fetchChannelFileBlob(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), entry.entry_id),
          entry.name,
          entry.mime_type || "application/octet-stream"
        );
      } else {
        await downloadChannelFile(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), entry);
      }
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileDownloadFailed"));
    } finally {
      this.fileActionBusyId = "";
    }
  }

  async downloadCurrentFilePreview(): Promise<void> {
    const entry = this.filePreviewEntry;
    if (!entry) return;
    if (!this.filePreviewMessageImageReference) {
      await this.downloadFileEntryFromChannel(entry);
      return;
    }
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken()) return;
    const reference = this.filePreviewMessageImageReference;
    this.hooks.setError("");
    try {
      const load = () => fetchMessageImageBlob(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), reference.assetSHA256);
      if (this.hooks.nativeDesktopRuntime()) {
        if (!systemFileSaveAvailable()) throw new Error(this.hooks.translate("error.desktopFileSaveUnavailable"));
        await saveFileWithSystemPicker(load, reference.name, reference.mimeType);
        return;
      }
      const blob = await load();
      const objectURL = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      try {
        anchor.href = objectURL;
        anchor.download = reference.name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
      }
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileDownloadFailed"));
    }
  }

  canManageFileEntry(entry: ChannelFileEntry): boolean {
    return this.hooks.canManageFiles() || (entry.type === "file" && entry.owner_member_id === this.hooks.memberId());
  }

  // ---- selection + drag ------------------------------------------------------

  clearFileSelection(): void {
    this.selectedFileEntryIds = new Set<string>();
    this.fileSelectionAnchorId = "";
  }

  selectedFileEntries(): ChannelFileEntry[] {
    return this.fileEntries.filter((entry) => this.selectedFileEntryIds.has(entry.entry_id));
  }

  selectedFilesAreManageable(): boolean {
    const selected = this.selectedFileEntries();
    return selected.length > 0 && selected.every((entry) => this.canManageFileEntry(entry));
  }

  updateFileEntrySelection(entry: ChannelFileEntry, event: MouseEvent | PointerEvent | KeyboardEvent): void {
    const selection = updateFileSelection(
      this.selectedFileEntryIds,
      this.fileEntries.map((item) => item.entry_id),
      entry.entry_id,
      this.fileSelectionAnchorId,
      { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }
    );
    this.selectedFileEntryIds = selection.selectedIds;
    this.fileSelectionAnchorId = selection.anchorId;
  }

  handleFileEntryPointerDown(entry: ChannelFileEntry, event: PointerEvent): void {
    if (event.button !== 0 || this.fileDragBusy) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".file-row-actions")) return;
    const preserveSelection = this.selectedFileEntryIds.size > 1 &&
      this.selectedFileEntryIds.has(entry.entry_id) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey;
    if (!preserveSelection) this.updateFileEntrySelection(entry, event);
    event.preventDefault();
    if (!this.selectedFilesAreManageable()) return;
    this.filePointerPress = {
      entryId: entry.entry_id,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      dragging: false,
      preserveSelection
    };
    this.fileDragX = event.clientX;
    this.fileDragY = event.clientY;
    this.attachFileDragListeners();
  }

  attachFileDragListeners(): void {
    if (this.fileDragListenersAttached) return;
    document.addEventListener("pointermove", this.handleFileDocumentPointerMove, true);
    document.addEventListener("pointerup", this.handleFileDocumentPointerUp, true);
    document.addEventListener("pointercancel", this.handleFileDocumentPointerCancel, true);
    window.addEventListener("blur", this.handleFileDocumentPointerCancel, true);
    this.fileDragListenersAttached = true;
  }

  detachFileDragListeners(): void {
    if (!this.fileDragListenersAttached) return;
    document.removeEventListener("pointermove", this.handleFileDocumentPointerMove, true);
    document.removeEventListener("pointerup", this.handleFileDocumentPointerUp, true);
    document.removeEventListener("pointercancel", this.handleFileDocumentPointerCancel, true);
    window.removeEventListener("blur", this.handleFileDocumentPointerCancel, true);
    this.fileDragListenersAttached = false;
  }

  handleFileDocumentPointerMove = (event: PointerEvent): void => {
    const press = this.filePointerPress;
    if (!press || press.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (!press.dragging && distance < 5) return;
    event.preventDefault();
    event.stopPropagation();
    if (!press.dragging) {
      this.filePointerPress = { ...press, dragging: true };
      document.body.classList.add("ev-file-entry-dragging");
    }
    this.fileDragX = event.clientX;
    this.fileDragY = event.clientY;
    this.updateFileDragTarget(event.clientX, event.clientY);
  };

  handleFileDocumentPointerUp = (event: PointerEvent): void => {
    const press = this.filePointerPress;
    if (!press || press.pointerId !== event.pointerId) return;
    const wasDragging = press.dragging;
    const targetId = this.fileDragTargetId;
    if (wasDragging) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.clearFileDrag();
    if (wasDragging && targetId !== null) {
      void this.moveSelectedFileEntries(targetId);
    } else if (!wasDragging && press.preserveSelection) {
      this.selectedFileEntryIds = new Set([press.entryId]);
      this.fileSelectionAnchorId = press.entryId;
    }
  };

  handleFileDocumentPointerCancel = (): void => {
    this.clearFileDrag();
  };

  clearFileDrag(): void {
    this.filePointerPress = null;
    this.fileDragTargetId = null;
    this.fileDragX = 0;
    this.fileDragY = 0;
    document.body.classList.remove("ev-file-entry-dragging");
    this.detachFileDragListeners();
  }

  updateFileDragTarget(clientX: number, clientY: number): void {
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-file-drop-parent-id]");
    if (!target || target.dataset.fileDropParentId === undefined) {
      this.fileDragTargetId = null;
      return;
    }
    const parentId = target.dataset.fileDropParentId;
    if (this.selectedFileEntryIds.has(parentId) || this.selectedFileEntries().every((entry) => (entry.parent_id ?? "") === parentId)) {
      this.fileDragTargetId = null;
      return;
    }
    this.fileDragTargetId = parentId;
  }

  async moveSelectedFileEntries(parentId: string): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || this.fileDragBusy || !this.selectedFilesAreManageable()) return;
    const entries = this.selectedFileEntries().filter((entry) => (entry.parent_id ?? "") !== parentId);
    if (entries.length === 0 || entries.some((entry) => entry.entry_id === parentId)) return;
    const channelId = this.hooks.selectedChannelId();
    this.fileDragBusy = true;
    this.fileActionBusyId = "batch-move";
    this.hooks.setError("");
    try {
      for (const entry of entries) {
        const updated = await updateChannelFileEntry(this.hooks.baseUrl(), channelId, this.hooks.sessionToken(), entry.entry_id, {
          name: entry.name,
          parent_id: parentId
        });
        if (this.hooks.selectedChannelId() === channelId) this.mergeFileEntry(updated);
      }
      this.clearFileSelection();
      this.hooks.setStatusKey(entries.length > 1 ? "files.movedMultiple" : "files.moved");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileMoveFailed"));
    } finally {
      this.fileDragBusy = false;
      this.fileActionBusyId = "";
      if (this.hooks.selectedChannelId() === channelId && this.hooks.channelContentMode() === "files") await this.loadChannelFiles(this.fileParentId);
    }
  }

  async deleteSelectedFileEntries(): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || this.fileActionBusyId || !this.selectedFilesAreManageable()) return;
    const entries = this.selectedFileEntries();
    if (!(await this.hooks.showAppConfirm(this.hooks.translate("files.deleteSelectedConfirm", { count: entries.length }), {
      title: this.hooks.translate("files.deleteSelected", { count: entries.length }),
      confirmLabel: this.hooks.translate("files.delete"),
      danger: true
    }))) return;
    const channelId = this.hooks.selectedChannelId();
    this.fileActionBusyId = "batch-delete";
    this.hooks.setError("");
    try {
      for (const entry of entries) {
        this.removeFileEntry(await deleteChannelFileEntry(this.hooks.baseUrl(), channelId, this.hooks.sessionToken(), entry.entry_id));
      }
      this.clearFileSelection();
      this.hooks.setStatusKey("files.deletedMultiple");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileDeleteFailed"));
    } finally {
      this.fileActionBusyId = "";
      if (this.hooks.selectedChannelId() === channelId && this.hooks.channelContentMode() === "files") await this.loadChannelFiles(this.fileParentId);
    }
  }

  handleFileEntryKeydown(entry: ChannelFileEntry, event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void this.activateFileEntry(entry);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      this.updateFileEntrySelection(entry, event);
    }
  }

  async activateFileEntry(entry: ChannelFileEntry): Promise<void> {
    if (entry.type === "directory") {
      await this.enterFileDirectory(entry);
      return;
    }
    if (this.hooks.canDownloadFiles()) await this.openFilePreview(entry);
  }

  // ---- preview ---------------------------------------------------------------

  async openFilePreview(entry: ChannelFileEntry): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || !this.hooks.canDownloadFiles() || entry.type !== "file") return;
    this.closeFilePreview();
    const requestId = ++this.filePreviewRequestId;
    this.filePreviewEntry = entry;
    this.filePreviewKind = classifyFilePreview(entry.name, entry.mime_type);
    this.filePreviewObjectURLShouldRevoke = true;
    this.filePreviewLoading = this.filePreviewKind !== "unknown";
    this.filePreviewError = "";
    try {
      if (this.filePreviewKind === "unknown") return;
      const blob = await fetchChannelFileBlob(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), entry.entry_id);
      if (requestId !== this.filePreviewRequestId) return;
      if (this.filePreviewKind === "image" || this.filePreviewKind === "video" || this.filePreviewKind === "audio" || this.filePreviewKind === "pdf") {
        this.filePreviewObjectURL = URL.createObjectURL(blob);
      } else if (this.filePreviewKind === "text") {
        const preview = await readTextPreview(blob);
        if (requestId !== this.filePreviewRequestId) return;
        this.filePreviewText = preview.text;
        this.filePreviewTextTruncated = preview.truncated;
      } else if (this.filePreviewKind === "archive") {
        const preview = await readArchivePreview(blob, entry.name);
        if (requestId === this.filePreviewRequestId) this.filePreviewArchive = preview;
      } else if (this.filePreviewKind === "document") {
        const [documentPreview, archivePreview] = await Promise.all([
          readDocumentPreview(blob, entry.name),
          readArchivePreview(blob, entry.name)
        ]);
        if (requestId !== this.filePreviewRequestId) return;
        this.filePreviewDocument = documentPreview;
        this.filePreviewArchive = archivePreview;
      }
    } catch (caught) {
      if (requestId === this.filePreviewRequestId) {
        this.filePreviewError = caught instanceof Error ? caught.message : this.hooks.translate("error.filePreviewFailed");
      }
    } finally {
      if (requestId === this.filePreviewRequestId) this.filePreviewLoading = false;
    }
  }

  closeFilePreview(): void {
    this.filePreviewRequestId += 1;
    if (this.filePreviewObjectURL && this.filePreviewObjectURLShouldRevoke) URL.revokeObjectURL(this.filePreviewObjectURL);
    this.filePreviewEntry = null;
    this.filePreviewMessageImageReference = null;
    this.filePreviewKind = "unknown";
    this.filePreviewObjectURL = "";
    this.filePreviewObjectURLShouldRevoke = true;
    this.filePreviewText = "";
    this.filePreviewTextTruncated = false;
    this.filePreviewArchive = null;
    this.filePreviewDocument = null;
    this.filePreviewLoading = false;
    this.filePreviewError = "";
  }

  /** Tracks the source message image while its cached preview is open. */
  setPreviewMessageImageReference(reference: MessageImageReference | null): void {
    this.filePreviewMessageImageReference = reference;
  }

  openCachedMediaFilePreview(entry: ChannelFileEntry, objectURL: string): boolean {
    const kind = classifyFilePreview(entry.name, entry.mime_type);
    if (!objectURL || (kind !== "image" && kind !== "video" && kind !== "audio")) return false;
    this.closeFilePreview();
    this.filePreviewEntry = entry;
    this.filePreviewKind = kind;
    this.filePreviewObjectURL = objectURL;
    this.filePreviewObjectURLShouldRevoke = false;
    this.filePreviewLoading = false;
    this.filePreviewError = "";
    return true;
  }

  async openComposerAttachmentPreview(entry: ChannelFileEntry): Promise<void> {
    const objectURL = this.hooks.composerAttachmentObjectURLs().get(entry.entry_id) ?? "";
    if (this.openCachedMediaFilePreview(entry, objectURL)) return;
    await this.openFilePreview(entry);
  }

  handleFilePreviewKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.closeFilePreview();
  }

  fileEntryIcon(entry: ChannelFileEntry): string {
    return filePreviewIcon(classifyFilePreview(entry.name, entry.mime_type), entry.type === "directory");
  }

  async refreshFileEntries(): Promise<void> {
    if (this.hooks.channelContentMode() !== "files") return;
    await this.loadChannelFiles(this.fileParentId);
  }

  // ---- registry mutations ----------------------------------------------------

  mergeFileEntry(entry: ChannelFileEntry): void {
    if (entry.channel_id !== this.hooks.selectedChannelId()) return;
    this.hooks.setMessageAttachmentEntries(new Map(this.hooks.messageAttachmentEntries()).set(entry.entry_id, entry));
    if ((entry.parent_id ?? "") !== this.fileParentId) {
      this.fileEntries = this.fileEntries.filter((item) => item.entry_id !== entry.entry_id);
      this.selectedFileEntryIds = new Set([...this.selectedFileEntryIds].filter((entryId) => entryId !== entry.entry_id));
      return;
    }
    const byId = new Map(this.fileEntries.map((item) => [item.entry_id, item]));
    byId.set(entry.entry_id, entry);
    this.fileEntries = this.sortFileEntriesForUI([...byId.values()]);
  }

  removeFileEntry(entry: ChannelFileEntry): void {
    if (entry.channel_id !== this.hooks.selectedChannelId()) return;
    const nextAttachmentEntries = new Map(this.hooks.messageAttachmentEntries());
    nextAttachmentEntries.delete(entry.entry_id);
    this.hooks.setMessageAttachmentEntries(nextAttachmentEntries);
    this.fileEntries = this.fileEntries.filter((item) => item.entry_id !== entry.entry_id);
    this.selectedFileEntryIds = new Set([...this.selectedFileEntryIds].filter((entryId) => entryId !== entry.entry_id));
    if (this.fileSelectionAnchorId === entry.entry_id) this.fileSelectionAnchorId = "";
  }

  sortFileEntriesForUI(entries: ChannelFileEntry[]): ChannelFileEntry[] {
    return [...entries].sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return this.hooks.translate("files.bytes", { size: bytes });
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }
}
