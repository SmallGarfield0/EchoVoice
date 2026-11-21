<script lang="ts">
  // ContentPanel: slim controller-based wiring. Remaining props are App-owned
  // state/helpers that are not yet backed by a reactive controller field.
  import ScreenShareDiagnostics from "./ScreenShareDiagnostics.svelte";
  import FileMediaPreview from "./FileMediaPreview.svelte";
  import { buildChannelTree, childChannels as getChildChannels } from "../lib/channelList";
  import { classifyFilePreview, filePreviewIcon } from "../lib/file-storage";
  import { messageAttachmentIsInlineMedia, parseMessageAttachmentReferences, parseMessageContentSegments } from "../lib/message-attachments";
  import type { MessageAttachmentReference, MessageImageReference } from "../lib/message-attachments";
  import type { ClientMessage } from "../lib/messages.svelte";
  import type { EmojiPickerEntry } from "../lib/emoji.svelte";
  import type { Channel, ChannelFileEntry, Message, RemoteControlSession, ScreenShareSession, VoiceState } from "../lib/types";
import type { ScreenSharePathPreference } from "../lib/screenShareAutoRelay";

  let { workspace, serverRail, serverSettingsController, channelsController, permissionsController, messagesController, channelFiles, composer, voiceState, voiceSession, voiceStage, screenShare, screenShareSetup, transport, realtime, remoteControl, accompaniment, soundboard, emoji, audio, nativeVoice, t, accompanimentMemberIds, canDownloadFiles, canManageFiles, canSendMessages, canUploadFiles, canViewFiles, channelContentMode, composerPlaceholder, currentMemberActiveScreenShare, downloadMessageAttachment, emojiAutocompleteSelectedIndex, ensureMessageAttachmentPreview, ensureMessageImagePreview, error, fileStorageAvailable, handleFileEntryPointerDown, handleMessageListKeydown, handleVoiceParticipantKeydown, handleVoiceParticipantMouseDown, handleVoiceParticipantPointerCancel, handleVoiceParticipantPointerDown, handleVoiceParticipantPointerMove, handleVoiceParticipantPointerUp, memberId, memberPanelMembers, members, messageSearchQuery = $bindable(), observeMessageAttachmentPreview, observeMessageImagePreview, openMessageAttachmentPreview, openMessageImagePreview, openVoiceParticipantContextMenu, screenShareActionBusy, screenSharePopoutMode, screenShareViewerCount, screenShareViewerIds, screenShareViewerPanelTitle, selectedChannelTitle, selectedVoiceParticipantIds, selectedVoiceScreenShares, selectedVoiceStates, server, set_composerAttachmentInputElement, set_composerEditorElement, set_composerInputShellElement, set_fileInputElement, set_focusedScreenShareVideoElement, set_localScreenShareVideoElement, set_messageEditEditorElement, set_messageListElement, set_screenShareFocusElement, setVoiceStageMemberDisplayMode, voiceActionBusy, voiceParticipantPointerPress, voiceStageMemberDisplayMode, canHostRemoteControl } = $props();

  // DOM refs owned here and written back to the owning controllers.
  let _fileInputElement = $state(undefined);
  $effect(() => { set_fileInputElement?.(_fileInputElement); });
  let _screenShareFocusElement = $state(undefined);
  $effect(() => { set_screenShareFocusElement?.(_screenShareFocusElement); });
  let _focusedScreenShareVideoElement = $state(undefined);
  $effect(() => { set_focusedScreenShareVideoElement?.(_focusedScreenShareVideoElement); });
  let _localScreenShareVideoElement = $state(undefined);
  $effect(() => { set_localScreenShareVideoElement?.(_localScreenShareVideoElement); });
  let _messageListElement = $state(undefined);
  $effect(() => { set_messageListElement?.(_messageListElement); });
  let _messageEditEditorElement = $state(undefined);
  $effect(() => { set_messageEditEditorElement?.(_messageEditEditorElement); });
  let _composerAttachmentInputElement = $state(undefined);
  $effect(() => { set_composerAttachmentInputElement?.(_composerAttachmentInputElement); });
  let _composerInputShellElement = $state(undefined);
  $effect(() => { set_composerInputShellElement?.(_composerInputShellElement); });
  let _composerEditorElement = $state(undefined);
  $effect(() => { set_composerEditorElement?.(_composerEditorElement); });



  const activateFileEntry = (entry: ChannelFileEntry) => channelFiles.activateFileEntry(entry);
  const activeRemoteControlForShare = (shareId: string, controls = remoteControl.sessions) => remoteControl.activeForShare(shareId, controls);
  const canManageFileEntry = (entry: ChannelFileEntry) => channelFiles.canManageFileEntry(entry);
  const canRequestScreenShareControl = (share: ScreenShareSession) => remoteControl.canRequestScreenShareControl(share);
  const cancelEditMessage = () => composer.cancelEditMessage();
  const channelTree = $derived(buildChannelTree(channelsController.channels));
  const categoryChildCount = (categoryId: string) => getChildChannels(channelTree, categoryId).length;
  const childChannels = (parentId: string) => getChildChannels(channelTree, parentId);
  const changeScreenShareVolume = (targetMemberId: string, event: Event) => audio.changeScreenShareVolume(targetMemberId, event);
  const channelIcon = (channel: Channel) => channelsController.channelIcon(channel);
  const channelNameForDisplay = (channel: Channel) => channelsController.channelNameForDisplay(channel);
  const clearMessageSearch = () => composer.clearMessageSearch();
  const clearReplyTarget = () => composer.clearReplyTarget();
  const closeFocusedScreenShare = () => transport.closeFocusedScreenShare();
  const composerAttachmentBusyId = $derived(composer.composerAttachmentBusyId);
  const composerAttachmentObjectURLs = $derived(composer.composerAttachmentObjectURLs);
  const composerAttachmentUploadProgress = $derived(composer.composerAttachmentUploadProgress);
  const composerAttachmentUploading = $derived(composer.composerAttachmentUploading);
  const composerAttachments = $derived(composer.composerAttachments);
  const composerInlineImageDragActive = $derived(composer.composerInlineImageDragActive);
  const composerInlineImageUploadProgress = $derived(composer.composerInlineImageUploadProgress);
  const composerInlineImageUploading = $derived(composer.composerInlineImageUploading);
  const composerPanelHeight = $derived(composer.composerPanelHeight);
  const composerScrollbarDragging = $derived(composer.composerScrollbarDragging);
  const composerScrollbarThumbHeight = $derived(composer.composerScrollbarThumbHeight);
  const composerScrollbarThumbTop = $derived(composer.composerScrollbarThumbTop);
  const composerScrollbarVisible = $derived(composer.composerScrollbarVisible);
  const createDirectoryInCurrentFolder = () => channelFiles.createDirectoryInCurrentFolder();
  const currentChannelNewMessageCount = $derived(messagesController.currentChannelNewMessageCount);
  const currentChannelNewMessageStartId = $derived(messagesController.currentChannelNewMessageStartId);
  const currentMemberRemoteControlForShare = (shareId: string, controls = remoteControl.sessions) => remoteControl.currentMemberForShare(shareId, controls);
  const decideRemoteControl = (control: RemoteControlSession, action: "approve" | "reject") => remoteControl.decide(control, action);
  const deleteFileEntryFromChannel = (entry: ChannelFileEntry) => channelFiles.deleteFileEntryFromChannel(entry);
  const deleteSelectedFileEntries = () => channelFiles.deleteSelectedFileEntries();
  const dismissLocalMessage = (message: ClientMessage) => messagesController.dismissLocalMessage(message);
  const downloadFileEntryFromChannel = (entry: ChannelFileEntry) => channelFiles.downloadFileEntryFromChannel(entry);
  const editingMessageDraft = $derived(messagesController.editingMessageDraft);
  const editingMessageId = $derived(messagesController.editingMessageId);
  const emojiAutocompleteEntries = $derived(emoji.autocompleteEntries);
  const emojiAutocompleteLeft = $derived(emoji.autocompleteLeft);
  const emojiAutocompleteState = $derived(emoji.autocompleteState);
  const emojiPickerOpen = $derived(emoji.pickerOpen);
  const fileActionBusyId = $derived(channelFiles.fileActionBusyId);
  const fileBreadcrumbs = $derived(channelFiles.fileBreadcrumbs);
  const fileDragTargetId = $derived(channelFiles.fileDragTargetId);
  const fileEntries = $derived(channelFiles.fileEntries);
  const fileEntryIcon = (entry: ChannelFileEntry) => channelFiles.fileEntryIcon(entry);
  const fileLoading = $derived(channelFiles.fileLoading);
  const fileParentId = $derived(channelFiles.fileParentId);
  const filePointerPress = $derived(channelFiles.filePointerPress);
  const fileUploadProgress = $derived(channelFiles.fileUploadProgress);
  const fileUploading = $derived(channelFiles.fileUploading);
  const focusedScreenShareStatusLabel = (share: ScreenShareSession | undefined) => transport.focusedScreenShareStatusLabel(share);
  const screenShareVideo = (node: HTMLVideoElement, stream: MediaStream) => transport.screenShareVideo(node, stream);
  const portal = (node: HTMLElement) => transport.portal(node);
  const focusedScreenShareId = $derived(screenShare.focusedScreenShareId);
  const focusedScreenShare = $derived(
    screenShare.focusedScreenShareId
      ? screenShare.sessions.find((share) => share.share_id === screenShare.focusedScreenShareId)
      : undefined
  );
  const focusedActiveRemoteControl = $derived(
    focusedScreenShare ? remoteControl.activeForShare(focusedScreenShare.share_id) : undefined
  );
  const focusedMemberRemoteControl = $derived(
    focusedScreenShare ? remoteControl.currentMemberForShare(focusedScreenShare.share_id) : undefined
  );
  const formatFileSize = (bytes: number) => channelFiles.formatFileSize(bytes);
  const handleChannelClick = (channel: Channel, event?: MouseEvent | KeyboardEvent) => channelsController.handleChannelClick(channel, event);
  const handleComposerAttachmentInput = (event: Event) => composer.handleComposerAttachmentInput(event);
  const handleComposerBeforeInput = (event: InputEvent) => composer.handleComposerBeforeInput(event);
  const handleComposerBlur = () => composer.handleComposerBlur();
  const handleComposerCompositionEnd = (event: CompositionEvent) => composer.handleComposerCompositionEnd(event);
  const handleComposerCompositionStart = () => composer.handleComposerCompositionStart();
  const handleComposerDragEnter = (event: DragEvent) => composer.handleComposerDragEnter(event);
  const handleComposerDragLeave = (event: DragEvent) => composer.handleComposerDragLeave(event);
  const handleComposerDragOver = (event: DragEvent) => composer.handleComposerDragOver(event);
  const handleComposerEditorClick = (event: MouseEvent) => composer.handleComposerEditorClick(event);
  const handleComposerImageDrop = (event: DragEvent) => composer.handleComposerImageDrop(event);
  const handleComposerInput = (event: InputEvent) => composer.handleComposerInput(event);
  const handleComposerKeydown = (event: KeyboardEvent) => composer.handleComposerKeydown(event);
  const handleComposerPaste = (event: ClipboardEvent) => composer.handleComposerPaste(event);
  const handleComposerScroll = () => composer.handleComposerScroll();
  const handleEditMessageKeydown = (event: KeyboardEvent, message: Message) => composer.handleEditMessageKeydown(event, message);
  const handleFileEntryKeydown = (entry: ChannelFileEntry, event: KeyboardEvent) => channelFiles.handleFileEntryKeydown(entry, event);
  const handleFileInputChange = (event: Event) => channelFiles.handleFileInputChange(event);
  const handleMessageEditEmbeddedMediaLoad = (event: Event) => composer.handleMessageEditEmbeddedMediaLoad(event);
  const handleMessageEditInput = (event: InputEvent) => composer.handleMessageEditInput(event);
  const handleMessageEditPaste = (event: ClipboardEvent) => composer.handleMessageEditPaste(event);
  const handleMessageListClick = (event: MouseEvent) => emoji.handleMessageListClick(event);
  const handleMessageListScroll = () => composer.handleMessageListScroll();
  const handleMessageSelection = (message: Message, event: MouseEvent | KeyboardEvent) => messagesController.handleMessageSelection(message, event);
  const handleRemoteControlKey = (event: KeyboardEvent, control: RemoteControlSession, pressed: boolean) => remoteControl.handleKey(event, control, pressed);
  const handleRemoteControlPointerButton = (event: PointerEvent, control: RemoteControlSession, pressed: boolean) => remoteControl.handlePointerButton(event, control, pressed);
  const handleRemoteControlPointerMove = (event: PointerEvent, control: RemoteControlSession) => remoteControl.handlePointerMove(event, control);
  const handleRemoteControlWheel = (event: WheelEvent, control: RemoteControlSession) => remoteControl.handleWheel(event, control);
  const handleScreenShareFocusControlsKeydown = (event: KeyboardEvent) => transport.handleScreenShareFocusControlsKeydown(event);
  const hasOlderMessages = $derived(messagesController.hasOlderMessages);
  const isCurrentVoiceChannel = (channelId: string) => voiceStage.isCurrentVoiceChannel(channelId);
  const isScreenShareWatchBusy = (share: ScreenShareSession) => screenShare.isScreenShareWatchBusy(share);
  const isVoiceStateSpeaking = (state: VoiceState | undefined) => audio.isVoiceStateSpeaking(state);
  const isWatchingScreenShare = (share: ScreenShareSession) => screenShare.isWatchingScreenShare(share);
  const joinVoiceRoom = (channelId: string, options: { silent?: boolean } = {}) => voiceStage.joinVoiceRoom(channelId, options);
  const jumpToLatestMessages = () => composer.jumpToLatestMessages();
  const jumpToMessage = (messageId: string | undefined) => composer.jumpToMessage(messageId);
  const loadOlderMessages = () => composer.loadOlderMessages();
  const localScreenSharePreviewRenderingEnabled = $derived(transport.localScreenSharePreviewRenderingEnabled);
  const localScreenShareStream = $derived(transport.localScreenShareStream);
  const memberAccessFilterLoading = $derived(voiceStage.memberAccessFilterLoading);
  const memberAvatarDataURL = (id: string) => permissionsController.memberAvatarDataURL(id);
  const memberAvatarStyle = (id: string) => permissionsController.memberAvatarStyle(id);
  const memberDisplayName = (id: string) => permissionsController.memberDisplayName(id);
  const memberInitials = (id: string) => permissionsController.memberInitials(id);
  const memberVolumeLimitPercent = $derived(audio.memberVolumeLimitPercent);
  const messageActionBusyId = $derived(messagesController.messageActionBusyId);
  const messageAttachmentErrorIds = $derived(composer.messageAttachmentErrorIds);
  const messageAttachmentLoadingIds = $derived(composer.messageAttachmentLoadingIds);
  const messageAttachmentObjectURLs = $derived(composer.messageAttachmentObjectURLs);
  const messageBeforeLoading = $derived(messagesController.messageBeforeLoading);
  const messageById = (messageId: string | undefined) => messagesController.messageById(messageId);
  const messageSearchLoading = $derived(messagesController.messageSearchLoading);
  const messageSearchOpen = $derived(messagesController.messageSearchOpen);
  const messageSearchResults = $derived(messagesController.messageSearchResults);
  const messageSubmitting = $derived(composer.messageSubmitting);
  const messageTime = (createdAtMS: number) => messagesController.messageTime(createdAtMS);
  const formatMessageContent = (content: string) => messagesController.formatMessageContent(content);
  const messages = $derived(messagesController.messages);
  const nativeLocalScreenSharePreviewError = $derived(transport.nativeLocalScreenSharePreviewError);
  const nativeLocalScreenSharePreviewStarting = $derived(transport.nativeLocalScreenSharePreviewStarting);
  const nativeLocalScreenSharePreviewStream = $derived(transport.nativeLocalScreenSharePreviewStream);
  const nativeScreenSharePreviewStatusLabel = () => transport.nativeScreenSharePreviewStatusLabel();
  const nativeScreenSharePreviewViewerLabel = () => transport.nativeScreenSharePreviewViewerLabel();
  const nativeScreenShareSenderSession = $derived(transport.nativeScreenShareSenderSession);
  const nativeScreenShareSenderStatus = $derived(transport.nativeScreenShareSenderStatus);
  const openChannelFiles = () => channelFiles.openChannelFiles();
  const openComposerAttachmentPreview = (entry: ChannelFileEntry) => channelFiles.openComposerAttachmentPreview(entry);
  const openFileBreadcrumb = (index: number) => channelFiles.openFileBreadcrumb(index);
  const openFilePreview = (entry: ChannelFileEntry) => channelFiles.openFilePreview(entry);
  const openFocusedScreenShare = (share: ScreenShareSession) => transport.openFocusedScreenShare(share);
  const openMessageContextMenu = (message: Message, event: MouseEvent) => messagesController.openMessageContextMenu(message, event);
  const openSearchResult = (message: Message) => composer.openSearchResult(message);
  const pendingRemoteControlsForShare = (shareId: string, controls = remoteControl.sessions) => remoteControl.pendingForShare(shareId, controls);
  const popOutScreenShare = async (share: ScreenShareSession) => { await transport.popOutScreenShare(share); };
  const refreshFileEntries = () => channelFiles.refreshFileEntries();
  const releaseRemoteControlInputs = (control: RemoteControlSession) => remoteControl.releaseInputs(control);
  const remoteControlBusyId = $derived(remoteControl.busyId);
  const remoteControlCaptureControlId = $derived(remoteControl.captureControlId);
  const remoteControlIsSuspended = (control: RemoteControlSession | undefined) => remoteControl.isSuspended(control);
  const remoteControlRequestError = (shareId: string) => remoteControl.requestError(shareId);
  const remoteControlRequestUnavailableReason = (share: ScreenShareSession) => remoteControl.requestUnavailableReason(share);
  const remoteControlRespectSeconds = (control: RemoteControlSession | undefined) => remoteControl.respectSeconds(control);
  const remoteScreenShareStreams = $derived(screenShare.remoteStreams);
  const removeComposerAttachment = (entry: ChannelFileEntry) => composer.removeComposerAttachment(entry);
  const renameFileEntry = (entry: ChannelFileEntry) => channelFiles.renameFileEntry(entry);
  const replyPreviewContent = (message: Message | undefined) => composer.replyPreviewContent(message);
  const replyingToMessageId = $derived(composer.replyingToMessageId);
  const replyingToMessage = $derived(composer.replyingToMessageId
    ? messagesController.messages.find((message) => message.message_id === composer.replyingToMessageId)
    : undefined);
  const requestFocusedScreenShareFullscreen = async () => { await transport.requestFocusedScreenShareFullscreen(); };
  const requestScreenShareControl = (share: ScreenShareSession) => remoteControl.requestScreenShareControl(share);
  const resetScreenShareVolume = (targetMemberId: string) => audio.resetScreenShareVolume(targetMemberId);
  const retryLocalMessage = (message: ClientMessage) => composer.retryLocalMessage(message);
  const returnToChannelChat = () => channelFiles.returnToChannelChat();
  const revokeRemoteControl = (control: RemoteControlSession) => remoteControl.revoke(control);
  const screenSharePreviewMetaLabelValue = $derived(screenShareSetup.previewMetaLabel);
  const screenShareViewerPanelShareId = $derived(transport.screenShareViewerPanelShareId);
  const screenShareViewerPanelStyle = $derived(transport.screenShareViewerPanelStyle);
  const screenSharePathIcon = (preference: ScreenSharePathPreference) =>
    preference === "relay" ? "dns" : preference === "direct" ? "link" : "alt_route";
  const screenSharePathLabelKey = (preference: ScreenSharePathPreference) => `screenShare.path.${preference}`;
  const screenSharePathMenuShareId = $derived(transport.screenSharePathMenuShareId);
  const screenSharePathOptions: ScreenSharePathPreference[] = ["auto", "direct", "relay"];
  const screenSharePathPreference = (shareId: string) => transport.screenSharePathPreference(shareId);
  const chooseScreenSharePath = (shareId: string, preference: ScreenSharePathPreference) => {
    transport.setScreenSharePathPreference(shareId, preference);
    transport.screenSharePathMenuShareId = "";
  };
  const toggleScreenSharePathMenu = (shareId: string, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    transport.toggleScreenSharePathMenu(shareId);
  };
  const screenShareVolumeIcon = (volume: number) => audio.screenShareVolumeIcon(volume);
  const screenShareVolumeMenuShareId = $derived(audio.screenShareVolumeMenuShareId);
  const screenShareVolumePercent = (targetMemberId: string, values = audio.screenShareVolumePercents) => audio.screenShareVolumePercent(targetMemberId, values);
  const screenShareVolumePercents = $derived(audio.screenShareVolumePercents);
  const screenShareWatchStatusLabel = (share: ScreenShareSession | undefined) => screenShare.watchStatusLabel(share);
  const screenSharingMemberIds = $derived(new Set(screenShare.sessions.map((share) => share.owner_member_id)));
  const selectChannel = (channelId: string, skipWarning = false) => channelsController.selectChannel(channelId, skipWarning);
  const selectEmojiAutocompleteEntry = (entry: EmojiPickerEntry) => composer.selectEmojiAutocompleteEntry(entry);
  const selectedChannel = $derived(channelsController.channels.find((channel) => channel.channel_id === channelsController.selectedChannelId));
  const selectedChannelId = $derived(channelsController.selectedChannelId);
  const selectedDesktopCaptureSource = $derived(screenShareSetup.selectedDesktopCaptureSource);
  const selectedFileEntryIds = $derived(channelFiles.selectedFileEntryIds);
  const selectedFilesAreManageable = () => channelFiles.selectedFilesAreManageable();
  const selectedMessageIds = $derived(messagesController.selectedMessageIds);
  const serverInitials = (name: string) => name.trim().slice(0, 2).toUpperCase() || "EV";
  const startComposerScrollbarDrag = (event: PointerEvent) => composer.startComposerScrollbarDrag(event);
  const stopCurrentScreenShareSession = async () => { await screenShareSetup.stopCurrentSession(); };
  const stopWatchingScreenShare = (share: ScreenShareSession) => screenShare.stopWatchingScreenShare(share);
  const submitEditedMessage = (message: Message) => composer.submitEditedMessage(message);
  const submitMessage = () => composer.submitMessage();
  const submitMessageSearch = () => composer.submitMessageSearch();
  const toggleEmojiPicker = (event: MouseEvent) => emoji.togglePicker(event);
  const toggleRemoteControlCapture = (control: RemoteControlSession) => remoteControl.toggleCapture(control);
  const toggleScreenShareViewerPanel = (share: ScreenShareSession, event: MouseEvent) => transport.toggleScreenShareViewerPanel(share, event);
  const toggleScreenShareVolumeMenu = (shareId: string, event: MouseEvent) => audio.toggleScreenShareVolumeMenu(shareId, event);
  const toggleWatchScreenShare = (share: ScreenShareSession) => screenShare.toggleWatchScreenShare(share);
  const watchFailed = (share: ScreenShareSession) => screenShare.watchFailed(share.share_id);
  const triggerComposerAttachmentUpload = () => composer.triggerComposerAttachmentUpload();
  const triggerFileUpload = () => channelFiles.triggerFileUpload();
  const updateComposerSelection = () => composer.updateComposerSelection();
  const voiceListenerCount = (memberIdToCount: string) => voiceStage.voiceListenerCount(memberIdToCount);
  const voiceRangeProgress = (value: number, maximum: number) => audio.voiceRangeProgress(value, maximum);
</script>


  <section class="content-panel" style={`--composer-panel-height: ${composerPanelHeight + (replyingToMessageId ? 50 : 0) + (composerAttachments.length ? 64 : 0)}px;`}>
    {#if selectedChannelId}
      <header class="content-header">
        <div>
          {#if channelContentMode !== "voice"}
            <p class="eyebrow">{server?.name ?? "EchoVoice"}</p>
          {/if}
          <h1>{selectedChannelTitle}</h1>
        </div>
        <div class="content-header-meta">
          {#if channelContentMode === "chat"}
            <form class="message-search-form" role="search" onsubmit={(event) => { event.preventDefault(); const handler = (submitMessageSearch); if (handler) return handler(event); }}>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
              <input
                bind:value={messageSearchQuery}
                placeholder={t("messages.searchPlaceholder")}
                oninput={() => {
                  if (!messageSearchQuery.trim()) {
                    messagesController.messageSearchResults = [];
                    messagesController.messageSearchOpen = false;
                  }
                }}
              />
              {#if messageSearchQuery}
                <button type="button" aria-label={t("messages.clearSearch")} title={t("messages.clearSearch")} onclick={clearMessageSearch}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
                </button>
              {/if}
            </form>
          {/if}
          {#if fileStorageAvailable && channelContentMode !== "voice" && (canViewFiles || canUploadFiles)}
            <input
              bind:this={_fileInputElement}
              class="visually-hidden"
              type="file"
              multiple
              onchange={handleFileInputChange}
            />
            {#if channelContentMode === "files"}
              <button class="content-header-button" type="button" onclick={returnToChannelChat}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">forum</span>
                <span>{t("files.backToChat")}</span>
              </button>
            {:else if canViewFiles}
              <button class="content-header-button" type="button" onclick={openChannelFiles}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">folder</span>
                <span>{t("files.open")}</span>
              </button>
            {:else if canUploadFiles}
              <button class="content-header-button" type="button" disabled={fileUploading} onclick={triggerFileUpload}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">upload_file</span>
                <span>{fileUploading ? t("files.uploading") : t("files.upload")}</span>
              </button>
            {/if}
          {/if}
          {#if channelContentMode !== "voice"}
            <span>{t("content.membersCount", { count: members.length })}</span>
          {/if}
          {#if channelContentMode === "chat" && messageSearchOpen}
            <div class="message-search-popover">
              <header>
                <strong>{t("messages.searchResults")}</strong>
                {#if messageSearchLoading}
                  <span>{t("messages.searching")}</span>
                {:else}
                  <span>{t("messages.searchCount", { count: messageSearchResults.length })}</span>
                {/if}
              </header>
              {#if !messageSearchLoading && messageSearchResults.length === 0}
                <p>{t("messages.searchEmpty")}</p>
              {/if}
              {#each messageSearchResults as result}
                <button type="button" onclick={() => openSearchResult(result)}>
                  <span>{memberDisplayName(result.author_id)}</span>
                  <small>{messageTime(result.created_at_ms)}</small>
                  <strong>{replyPreviewContent(result)}</strong>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </header>

      {#if channelContentMode === "category" && selectedChannel}
        <div class="category-workspace">
          <div class="category-workspace-identity">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">folder_open</span>
            <div>
              <p class="eyebrow">{t("channel.category")}</p>
              <h2>{channelNameForDisplay(selectedChannel)}</h2>
              <p>{t("channel.categoryWorkspaceDescription")}</p>
            </div>
          </div>
          <div class="category-workspace-stats">
            <div>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">tag</span>
              <strong>{categoryChildCount(selectedChannel.channel_id)}</strong>
              <span>{t("channel.categoryChannelCount")}</span>
            </div>
            <div>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">group</span>
              <strong>{memberAccessFilterLoading ? "-" : memberPanelMembers.length}</strong>
              <span>{t("channel.categoryAccessibleMemberCount")}</span>
            </div>
          </div>
          <section class="category-workspace-channels">
            <header>
              <strong>{t("channel.categoryChannels")}</strong>
            </header>
            {#if childChannels(selectedChannel.channel_id).length === 0}
              <p>{t("channel.emptyCategory")}</p>
            {:else}
              <div>
                {#each childChannels(selectedChannel.channel_id) as channel (channel.channel_id)}
                  <button type="button" onclick={(event) => handleChannelClick(channel, event)}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">{channelIcon(channel)}</span>
                    <span>{channelNameForDisplay(channel)}</span>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">chevron_right</span>
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        </div>
      {:else if channelContentMode === "voice" && selectedChannel}
        {#if focusedScreenShare}
          <div class="screen-share-focus-panel" bind:this={_screenShareFocusElement}>
            <div
              class="screen-share-focus-media"
              class:remote-control-active={!screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && remoteControlCaptureControlId === focusedMemberRemoteControl.control_id}
              data-control-id={focusedMemberRemoteControl?.status === "active" ? focusedMemberRemoteControl.control_id : undefined}
              tabindex={!screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" ? 0 : -1}
              role="button"
              aria-pressed={!screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && remoteControlCaptureControlId === focusedMemberRemoteControl.control_id}
              aria-label={focusedMemberRemoteControl?.status === "active" ? t("remoteControl.viewerArea") : t("screenShare.viewerTitle")}
              onpointermove={(event) => !screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && handleRemoteControlPointerMove(event, focusedMemberRemoteControl)}
              onpointerdown={(event) => !screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && handleRemoteControlPointerButton(event, focusedMemberRemoteControl, true)}
              onpointerup={(event) => !screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && handleRemoteControlPointerButton(event, focusedMemberRemoteControl, false)}
              onpointercancel={() => !screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && releaseRemoteControlInputs(focusedMemberRemoteControl)}
              onwheel={(event) => !screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && handleRemoteControlWheel(event, focusedMemberRemoteControl)}
              onkeydown={(event) => !screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && handleRemoteControlKey(event, focusedMemberRemoteControl, true)}
              onkeyup={(event) => !screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && handleRemoteControlKey(event, focusedMemberRemoteControl, false)}
              onblur={() => !screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && releaseRemoteControlInputs(focusedMemberRemoteControl)}
              oncontextmenu={(event) => {
                if (!screenSharePopoutMode && focusedMemberRemoteControl?.status === "active" && remoteControlCaptureControlId === focusedMemberRemoteControl.control_id) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
            >
              {#if focusedScreenShare.owner_member_id === memberId && !localScreenSharePreviewRenderingEnabled}
                <div class="screen-share-viewer-waiting local-screen-share-preview-paused" data-local-screen-share-preview-paused>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">visibility_off</span>
                  <span>{t("screenShare.previewPausedUnfocused")}</span>
                </div>
              {:else if focusedScreenShare.owner_member_id === memberId && localScreenShareStream}
                <video
                  bind:this={_focusedScreenShareVideoElement}
                  use:screenShareVideo={localScreenShareStream}
                  draggable="false"
                  muted
                  autoplay
                  playsinline
                  onclick={() => void requestFocusedScreenShareFullscreen()}
                ></video>
              {:else if focusedScreenShare.owner_member_id === memberId && nativeScreenShareSenderSession && nativeLocalScreenSharePreviewStream}
                <video
                  bind:this={_focusedScreenShareVideoElement}
                  use:screenShareVideo={nativeLocalScreenSharePreviewStream}
                  data-native-local-screen-share-preview
                  draggable="false"
                  muted
                  autoplay
                  playsinline
                  onclick={() => void requestFocusedScreenShareFullscreen()}
                ></video>
              {:else if focusedScreenShare.owner_member_id === memberId && nativeScreenShareSenderSession}
                <div class="screen-share-viewer-waiting native-local-screen-share-preview-waiting" data-native-local-screen-share-preview-waiting>
                  <span class="material-symbols-rounded app-icon" class:spinning={nativeLocalScreenSharePreviewStarting && !nativeLocalScreenSharePreviewError} aria-hidden="true">
                    {nativeLocalScreenSharePreviewError ? "error" : "sync"}
                  </span>
                  <span>{focusedScreenShareStatusLabel(focusedScreenShare)}</span>
                </div>
              {:else if remoteScreenShareStreams.has(focusedScreenShare.owner_member_id)}
                <video
                  bind:this={_focusedScreenShareVideoElement}
                  use:screenShareVideo={remoteScreenShareStreams.get(focusedScreenShare.owner_member_id)}
                  draggable="false"
                  autoplay
                  playsinline
                  onclick={() => {
                    if (!screenSharePopoutMode && (focusedMemberRemoteControl?.status !== "active" || remoteControlCaptureControlId !== focusedMemberRemoteControl.control_id)) {
                      void requestFocusedScreenShareFullscreen();
                    }
                  }}
                ></video>
              {:else}
                <div class="screen-share-viewer-waiting">
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">sync</span>
                  <span>{focusedScreenShareStatusLabel(focusedScreenShare)}</span>
                </div>
              {/if}
            </div>
            {#if transport.diagnosticsOpen}
              <ScreenShareDiagnostics
                video={_focusedScreenShareVideoElement}
                stream={remoteScreenShareStreams.get(focusedScreenShare.owner_member_id)}
                status={screenShare.watchStatuses.get(focusedScreenShare.share_id)}
                publishing={focusedScreenShare.owner_member_id === memberId ? (nativeScreenShareSenderSession ? "native" : "web") : undefined}
                nativeStatus={nativeScreenShareSenderStatus}
                senders={transport.webScreenShareSenderTelemetry}
                senderPaths={transport.webScreenShareViewerPaths}
                viewerName={(id) => memberDisplayName(transport.viewerMemberId(id))}
                {t}
              />
            {/if}
            {#if !screenSharePopoutMode}
              <div
                class="screen-share-focus-control-dock"
                data-screen-share-focus-dock
                role="toolbar"
                tabindex="0"
                aria-label={t("screenShare.controls")}
                onkeydown={handleScreenShareFocusControlsKeydown}
              >
                <div class="screen-share-focus-identity">
                  <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(focusedScreenShare.owner_member_id)}>
                    {#if memberAvatarDataURL(focusedScreenShare.owner_member_id)}
                      <img src={memberAvatarDataURL(focusedScreenShare.owner_member_id)} alt="" />
                    {:else}
                      {memberInitials(focusedScreenShare.owner_member_id)}
                    {/if}
                  </span>
                  <div>
                    <strong>{memberDisplayName(focusedScreenShare.owner_member_id)}</strong>
                    <span><span class="screen-share-focus-live-dot" aria-hidden="true"></span>{focusedScreenShareStatusLabel(focusedScreenShare)}</span>
                  </div>
                </div>

                <div
                  class="screen-share-focus-remote-actions"
                  class:empty={!focusedMemberRemoteControl && focusedScreenShare.owner_member_id === memberId}
                  aria-live="polite"
                >
                  {#if focusedMemberRemoteControl?.status === "pending"}
                    <span class="remote-control-action-status" data-remote-control-request-state="pending">
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">hourglass_top</span>
                      <span>{t("remoteControl.pending")}</span>
                    </span>
                    <button
                      class="screen-share-focus-control-button"
                      type="button"
                      data-tooltip={t("remoteControl.cancel")}
                      aria-label={t("remoteControl.cancel")}
                      disabled={Boolean(remoteControlBusyId)}
                      onclick={() => void revokeRemoteControl(focusedMemberRemoteControl)}
                    >
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
                    </button>
                  {:else if focusedMemberRemoteControl?.status === "active"}
                    <button
                      class="screen-share-focus-remote-button"
                      class:active={remoteControlCaptureControlId === focusedMemberRemoteControl.control_id}
                      type="button"
                      data-remote-control-capture
                      onclick={() => toggleRemoteControlCapture(focusedMemberRemoteControl)}
                    >
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">
                        {remoteControlCaptureControlId === focusedMemberRemoteControl.control_id ? "keyboard_hide" : "keyboard_external_input"}
                      </span>
                      <span>{t(remoteControlCaptureControlId === focusedMemberRemoteControl.control_id ? "remoteControl.exitControl" : "remoteControl.enterControl")}</span>
                    </button>
                    {#if remoteControlIsSuspended(focusedMemberRemoteControl)}
                      <span class="remote-control-action-status respect-window">
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">front_hand</span>
                        <span>{t("remoteControl.suspendedSeconds", { seconds: remoteControlRespectSeconds(focusedMemberRemoteControl) })}</span>
                      </span>
                    {/if}
                    <button
                      class="screen-share-focus-control-button danger"
                      type="button"
                      data-remote-control-revoke
                      data-tooltip={t("remoteControl.revoke")}
                      aria-label={t("remoteControl.revoke")}
                      disabled={Boolean(remoteControlBusyId)}
                      onclick={() => void revokeRemoteControl(focusedMemberRemoteControl)}
                    >
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">link_off</span>
                    </button>
                  {:else if focusedActiveRemoteControl}
                    <button
                      class="screen-share-focus-remote-button"
                      type="button"
                      data-remote-control-request-state="occupied"
                      disabled
                    >
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">hourglass_top</span>
                      <span>{t("remoteControl.waitingForController")}</span>
                    </button>
                  {:else if focusedScreenShare.owner_member_id !== memberId}
                    <div class="remote-control-request-entry">
                      <button
                        class="screen-share-focus-remote-button"
                        type="button"
                        data-remote-control-request
                        data-remote-control-request-state={remoteControlBusyId === focusedScreenShare.share_id ? "requesting" : "idle"}
                        aria-describedby={remoteControlRequestUnavailableReason(focusedScreenShare) ? "focused-remote-control-request-tooltip" : undefined}
                        disabled={Boolean(remoteControlBusyId) || !canRequestScreenShareControl(focusedScreenShare)}
                        onclick={() => void requestScreenShareControl(focusedScreenShare)}
                      >
                        <span class="material-symbols-rounded app-icon" class:spinning={remoteControlBusyId === focusedScreenShare.share_id} aria-hidden="true">
                          {remoteControlBusyId === focusedScreenShare.share_id ? "progress_activity" : "keyboard_external_input"}
                        </span>
                        <span>{t(remoteControlBusyId === focusedScreenShare.share_id ? "remoteControl.requestSubmitting" : "remoteControl.request")}</span>
                      </button>
                      {#if remoteControlRequestError(focusedScreenShare.share_id)}
                        <span class="remote-control-request-error" data-remote-control-request-state="error" role="alert">
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">error</span>
                          <span>{remoteControlRequestError(focusedScreenShare.share_id)}</span>
                        </span>
                      {/if}
                      {#if remoteControlRequestUnavailableReason(focusedScreenShare)}
                        <span id="focused-remote-control-request-tooltip" class="remote-control-request-tooltip" role="tooltip">
                          {remoteControlRequestUnavailableReason(focusedScreenShare)}
                        </span>
                      {/if}
                    </div>
                  {/if}
                </div>

                <div class="screen-share-focus-utility-actions">
                  <div class="screen-share-focus-control-group">
                    <div class="screen-share-focus-viewers-control">
                      <button
                        class="screen-share-focus-control-button viewer-count"
                        class:active={screenShareViewerPanelShareId === focusedScreenShare.share_id}
                        type="button"
                        data-screen-share-viewers
                        data-tooltip={t("screenShare.viewers")}
                        aria-label={t("screenShare.viewers")}
                        aria-controls="screen-share-viewer-popover"
                        aria-expanded={screenShareViewerPanelShareId === focusedScreenShare.share_id}
                        onclick={(event) => toggleScreenShareViewerPanel(focusedScreenShare, event)}
                      >
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">group</span>
                        <span>{screenShareViewerCount(focusedScreenShare)}</span>
                      </button>
                      {#if screenShareViewerPanelShareId === focusedScreenShare.share_id}
                        <div
                          id="screen-share-viewer-popover"
                          class="screen-share-viewer-popover"
                          data-screen-share-viewer-popover
                          role="region"
                          aria-label={screenShareViewerPanelTitle(focusedScreenShare)}
                          aria-live="polite"
                          style={screenShareViewerPanelStyle}
                          use:portal
                        >
                          <header>
                            <strong>{screenShareViewerPanelTitle(focusedScreenShare)}</strong>
                            <span>{t("screenShare.viewerCountDetailed", { count: screenShareViewerCount(focusedScreenShare) })}</span>
                          </header>
                          {#if screenShareViewerIds(focusedScreenShare).length === 0}
                            <div class="screen-share-viewer-empty">
                              <span class="material-symbols-rounded app-icon" aria-hidden="true">visibility_off</span>
                              <span>{t("screenShare.noViewers")}</span>
                            </div>
                          {:else}
                            <div class="screen-share-viewer-list">
                              {#each screenShareViewerIds(focusedScreenShare) as viewerId (viewerId)}
                                <div class="screen-share-viewer-row">
                                  <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(viewerId)}>{#if memberAvatarDataURL(viewerId)}<img src={memberAvatarDataURL(viewerId)} alt="" />{:else}{memberInitials(viewerId)}{/if}</span>
                                  <div>
                                    <strong>{memberDisplayName(viewerId)}</strong>
                                    <span>{viewerId === memberId ? t("screenShare.viewerSelf") : t("screenShare.viewerWatching")}</span>
                                  </div>
                                </div>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      {/if}
                    </div>
                    {#if focusedScreenShare.owner_member_id !== memberId}
                    <div class="screen-share-path-control">
                      <button
                        class="screen-share-focus-control-button"
                        class:active={screenSharePathMenuShareId === focusedScreenShare.share_id}
                        type="button"
                        data-screen-share-path
                        data-tooltip={t("screenShare.path.title")}
                        aria-label={t("screenShare.path.title")}
                        aria-haspopup="menu"
                        aria-expanded={screenSharePathMenuShareId === focusedScreenShare.share_id}
                        onclick={(event) => toggleScreenSharePathMenu(focusedScreenShare.share_id, event)}
                      >
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">
                          {screenSharePathIcon(screenSharePathPreference(focusedScreenShare.share_id))}
                        </span>
                      </button>
                      {#if screenSharePathMenuShareId === focusedScreenShare.share_id}
                        <div class="screen-share-path-popover" role="menu">
                          {#each screenSharePathOptions as option}
                            <button
                              class:active={screenSharePathPreference(focusedScreenShare.share_id) === option}
                              type="button"
                              role="menuitemradio"
                              aria-checked={screenSharePathPreference(focusedScreenShare.share_id) === option}
                              onclick={() => chooseScreenSharePath(focusedScreenShare.share_id, option)}
                            >
                              <span class="material-symbols-rounded app-icon" aria-hidden="true">
                                {screenSharePathIcon(option)}
                              </span>
                              <span>{t(screenSharePathLabelKey(option))}</span>
                            </button>
                          {/each}
                          <p>{t("screenShare.path.hint")}</p>
                        </div>
                      {/if}
                    </div>
                    <div class="screen-share-volume-control">
                      <button
                        class="screen-share-focus-control-button"
                        class:active={screenShareVolumeMenuShareId === focusedScreenShare.share_id}
                        type="button"
                        data-screen-share-volume
                        data-tooltip={t("screenShare.volume")}
                        aria-label={t("screenShare.volume")}
                        aria-expanded={screenShareVolumeMenuShareId === focusedScreenShare.share_id}
                        onclick={(event) => toggleScreenShareVolumeMenu(focusedScreenShare.share_id, event)}
                      >
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">
                          {screenShareVolumeIcon(screenShareVolumePercent(focusedScreenShare.owner_member_id, screenShareVolumePercents))}
                        </span>
                      </button>
                      {#if screenShareVolumeMenuShareId === focusedScreenShare.share_id}
                        <div class="screen-share-volume-popover">
                          <header>
                            <span>{t("screenShare.volume")}</span>
                            <strong>{screenShareVolumePercent(focusedScreenShare.owner_member_id, screenShareVolumePercents)}%</strong>
                            <button
                              type="button"
                              data-tooltip={t("voice.resetVolume")}
                              aria-label={t("voice.resetVolume")}
                              onclick={() => resetScreenShareVolume(focusedScreenShare.owner_member_id)}
                            >
                              <span class="material-symbols-rounded app-icon" aria-hidden="true">refresh</span>
                            </button>
                          </header>
                          <input
                            type="range"
                            min="0"
                            max={memberVolumeLimitPercent}
                            step="5"
                            value={screenShareVolumePercent(focusedScreenShare.owner_member_id, screenShareVolumePercents)}
                            style={`--voice-range-progress: ${voiceRangeProgress(screenShareVolumePercent(focusedScreenShare.owner_member_id, screenShareVolumePercents), memberVolumeLimitPercent)};`}
                            aria-label={t("screenShare.volume")}
                            oninput={(event) => changeScreenShareVolume(focusedScreenShare.owner_member_id, event)}
                          />
                        </div>
                      {/if}
                    </div>
                    {/if}
                  </div>
                  <span class="screen-share-focus-control-divider" aria-hidden="true"></span>
                  <div class="screen-share-focus-control-group">
                      <button class="screen-share-focus-control-button" class:active={transport.diagnosticsOpen}
                        type="button" data-screen-share-diagnostics-toggle data-tooltip={t("screenShare.diagnostics")}
                        aria-label={t("screenShare.diagnostics")} aria-pressed={transport.diagnosticsOpen} onclick={() => transport.toggleDiagnostics()}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">monitoring</span>
                      </button>
                    {#if focusedScreenShare.owner_member_id !== memberId}
                      <button class="screen-share-focus-control-button" type="button" data-tooltip={t("screenShare.popOut")} aria-label={t("screenShare.popOut")} onclick={() => popOutScreenShare(focusedScreenShare)}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">picture_in_picture_alt</span>
                      </button>
                    {/if}
                    <button class="screen-share-focus-control-button" type="button" data-tooltip={t("screenShare.fullscreen")} aria-label={t("screenShare.fullscreen")} onclick={() => void requestFocusedScreenShareFullscreen()}>
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">fullscreen</span>
                    </button>
                    <button class="screen-share-focus-control-button" type="button" data-tooltip={t("channel.openChat")} aria-label={t("channel.openChat")} onclick={() => void selectChannel(focusedScreenShare.channel_id)}>
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">forum</span>
                    </button>
                  </div>
                  <span class="screen-share-focus-control-divider" aria-hidden="true"></span>
                  <div class="screen-share-focus-control-group">
                    <button class="screen-share-focus-control-button" type="button" data-tooltip={t("screenShare.minimizeViewer")} aria-label={t("screenShare.minimizeViewer")} onclick={closeFocusedScreenShare}>
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">close_fullscreen</span>
                    </button>
                    {#if focusedScreenShare.owner_member_id === memberId}
                      <button
                        class="screen-share-focus-control-button danger"
                        type="button"
                        data-screen-share-stop-sharing
                        data-tooltip={t("screenShare.stop")}
                        aria-label={t("screenShare.stop")}
                        disabled={screenShareActionBusy}
                        onclick={() => void stopCurrentScreenShareSession()}
                      >
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">stop_screen_share</span>
                      </button>
                    {:else}
                      <button
                        class="screen-share-focus-control-button danger"
                        type="button"
                        data-screen-share-stop-watching
                        data-tooltip={t("screenShare.stopWatching")}
                        aria-label={t("screenShare.stopWatching")}
                        disabled={isScreenShareWatchBusy(focusedScreenShare)}
                        onclick={() => void stopWatchingScreenShare(focusedScreenShare)}
                      >
                        <span class="material-symbols-rounded app-icon" class:spinning={isScreenShareWatchBusy(focusedScreenShare)} aria-hidden="true">
                          {isScreenShareWatchBusy(focusedScreenShare) ? "progress_activity" : "visibility_off"}
                        </span>
                      </button>
                    {/if}
                  </div>
                </div>
              </div>
            {/if}
          </div>
        {:else}
        <div class="voice-stage-panel">
          <section class="voice-stage-hero">
            <div>
              <p class="eyebrow">{t("voice.stage")}</p>
              <h2>{channelNameForDisplay(selectedChannel)}</h2>
              <span>
                {t("voice.stageSummary", {
                  members: selectedVoiceStates.length,
                  shares: selectedVoiceScreenShares.length
                })}
              </span>
            </div>
            <div class="voice-stage-actions">
              {#if !isCurrentVoiceChannel(selectedChannel.channel_id)}
                <button
                  type="button"
                  disabled={voiceActionBusy}
                  onclick={() => joinVoiceRoom(selectedChannel.channel_id)}
                >
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">call</span>
                  <span>{t("voice.join")}</span>
                </button>
              {/if}
              <button type="button" onclick={() => void selectChannel(selectedChannel.channel_id)}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">forum</span>
                <span>{t("channel.openChat")}</span>
              </button>
            </div>
          </section>

          <section class="voice-stage-section">
            <header>
              <p class="section-label">{t("screenShare.title")}</p>
              <span>{t("screenShare.activeCount", { count: selectedVoiceScreenShares.length })}</span>
            </header>
            {#if selectedVoiceScreenShares.length === 0}
              <div class="voice-stage-empty">
                <span class="material-symbols-rounded app-icon" aria-hidden="true">screen_share</span>
                <span>{t("screenShare.empty")}</span>
              </div>
            {:else}
                <div class="voice-stage-share-grid">
                  {#each selectedVoiceScreenShares as share (share.share_id)}
                  {@const activeControl = activeRemoteControlForShare(share.share_id)}
                  {@const memberControl = currentMemberRemoteControlForShare(share.share_id)}
                  <article class="voice-stage-share-card" class:owned={share.owner_member_id === memberId}>
                    <div class="voice-stage-share-main">
                      <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(share.owner_member_id)}>{#if memberAvatarDataURL(share.owner_member_id)}<img src={memberAvatarDataURL(share.owner_member_id)} alt="" />{:else}{memberInitials(share.owner_member_id)}{/if}</span>
                      <div>
                        <strong>{memberDisplayName(share.owner_member_id)}</strong>
                        <span>
                          {#if share.owner_member_id === memberId}
                            {t("screenShare.localPreview")}
                          {:else if isWatchingScreenShare(share)}
                            {screenShareWatchStatusLabel(share)}
                          {:else}
                            {t("screenShare.available")}
                          {/if}
                        </span>
                      </div>
                    </div>
                    {#if share.owner_member_id === memberId}
                      <div class="voice-stage-share-actions">
                        <button
                          class="screen-share-viewer-toggle"
                          type="button"
                          data-tooltip={t("screenShare.viewers")}
                          aria-label={t("screenShare.viewers")}
                          aria-controls="screen-share-viewer-popover"
                          aria-expanded={screenShareViewerPanelShareId === share.share_id}
                          onclick={(event) => toggleScreenShareViewerPanel(share, event)}
                        >
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">group</span>
                          <span>{screenShareViewerCount(share)}</span>
                        </button>
                        <button type="button" disabled={screenShareActionBusy} onclick={() => void stopCurrentScreenShareSession()}>
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">stop_screen_share</span>
                          <span>{t("screenShare.stop")}</span>
                        </button>
                        {#if screenShareViewerPanelShareId === share.share_id && focusedScreenShareId !== share.share_id}
                          <div
                            id="screen-share-viewer-popover"
                            class="screen-share-viewer-popover compact"
                            data-screen-share-viewer-popover
                            role="region"
                            aria-label={screenShareViewerPanelTitle(share)}
                            aria-live="polite"
                            style={screenShareViewerPanelStyle}
                            use:portal
                          >
                            <header>
                              <strong>{screenShareViewerPanelTitle(share)}</strong>
                              <span>{t("screenShare.viewerCountDetailed", { count: screenShareViewerCount(share) })}</span>
                            </header>
                            {#if screenShareViewerIds(share).length === 0}
                              <div class="screen-share-viewer-empty">
                                <span class="material-symbols-rounded app-icon" aria-hidden="true">visibility_off</span>
                                <span>{t("screenShare.noViewers")}</span>
                              </div>
                            {:else}
                              <div class="screen-share-viewer-list">
                                {#each screenShareViewerIds(share) as viewerId (viewerId)}
                                  <div class="screen-share-viewer-row">
                                    <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(viewerId)}>{#if memberAvatarDataURL(viewerId)}<img src={memberAvatarDataURL(viewerId)} alt="" />{:else}{memberInitials(viewerId)}{/if}</span>
                                    <div>
                                      <strong>{memberDisplayName(viewerId)}</strong>
                                      <span>{t("screenShare.viewerWatching")}</span>
                                    </div>
                                  </div>
                                {/each}
                              </div>
                            {/if}
                          </div>
                        {/if}
                      </div>
                      {#each pendingRemoteControlsForShare(share.share_id) as control (control.control_id)}
                        <div class="remote-control-request-row">
                          <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(control.controller_member_id)}>{#if memberAvatarDataURL(control.controller_member_id)}<img src={memberAvatarDataURL(control.controller_member_id)} alt="" />{:else}{memberInitials(control.controller_member_id)}{/if}</span>
                          <div class="remote-control-request-copy">
                            <strong>{memberDisplayName(control.controller_member_id)}</strong>
                            <span>{t("remoteControl.requestedAccess")}</span>
                          </div>
                          <div class="remote-control-request-actions">
                            <button
                              class="primary"
                              type="button"
                              data-remote-control-approve
                              data-tooltip={t("remoteControl.approve")}
                              aria-label={t("remoteControl.approve")}
                              disabled={
                                Boolean(remoteControlBusyId) ||
                                !canHostRemoteControl ||
                                Boolean(activeControl && activeControl.control_id !== control.control_id)
                              }
                              onclick={() => void decideRemoteControl(control, "approve")}
                            >
                              <span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>
                            </button>
                            <button
                              type="button"
                              data-tooltip={t("remoteControl.reject")}
                              aria-label={t("remoteControl.reject")}
                              disabled={Boolean(remoteControlBusyId)}
                              onclick={() => void decideRemoteControl(control, "reject")}
                            >
                              <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
                            </button>
                          </div>
                        </div>
                      {/each}
                      {#if activeControl}
                        <div class="remote-control-active-row">
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">keyboard_external_input</span>
                          <div>
                            <strong>{memberDisplayName(activeControl.controller_member_id)}</strong>
                            <span>
                              {remoteControlIsSuspended(activeControl)
                                ? t("remoteControl.suspendedSeconds", { seconds: remoteControlRespectSeconds(activeControl) })
                                : t("remoteControl.controlling")}
                            </span>
                          </div>
                          <button
                            type="button"
                            data-tooltip={t("remoteControl.revoke")}
                            aria-label={t("remoteControl.revoke")}
                            disabled={Boolean(remoteControlBusyId)}
                            onclick={() => void revokeRemoteControl(activeControl)}
                          >
                            <span class="material-symbols-rounded app-icon" aria-hidden="true">link_off</span>
                          </button>
                        </div>
                      {/if}
                      {#if currentMemberActiveScreenShare}
                        <button
                          type="button"
                          class="screen-share-preview voice-stage-owned-preview"
                          class:native-screen-share-preview={Boolean(nativeScreenShareSenderSession && !localScreenShareStream)}
                          class:has-error={Boolean(nativeScreenShareSenderStatus?.lastError)}
                          aria-label={t("screenShare.localPreview")}
                          data-screen-share-open-preview
                          onclick={() => openFocusedScreenShare(share)}
                        >
                          {#if !localScreenSharePreviewRenderingEnabled}
                            <div class="native-screen-share-preview-empty local-screen-share-preview-paused" data-local-screen-share-preview-paused>
                              <span class="material-symbols-rounded app-icon" aria-hidden="true">visibility_off</span>
                            </div>
                          {:else if localScreenShareStream}
                            <video bind:this={_localScreenShareVideoElement} muted autoplay playsinline></video>
                          {:else if nativeScreenShareSenderSession}
                            {#if nativeScreenShareSenderStatus?.previewDataUrl}
                              <img src={nativeScreenShareSenderStatus.previewDataUrl} alt="" />
                            {:else if selectedDesktopCaptureSource?.thumbnailDataUrl}
                              <img src={selectedDesktopCaptureSource.thumbnailDataUrl} alt="" />
                            {:else}
                              <div class="native-screen-share-preview-empty">
                                <span class="material-symbols-rounded app-icon" aria-hidden="true">screen_share</span>
                              </div>
                            {/if}
                            <div class="native-screen-share-preview-overlay">
                              <div class="native-screen-share-preview-title">
                                <strong>{t("screenShare.nativePreviewTitle")}</strong>
                                <span>{nativeScreenSharePreviewViewerLabel()}</span>
                              </div>
                              <span class="native-screen-share-preview-status">{nativeScreenSharePreviewStatusLabel()}</span>
                            </div>
                          {/if}
                          <span class="screen-share-preview-meta">{screenSharePreviewMetaLabelValue}</span>
                        </button>
                      {/if}
                    {:else}
                      <div class="voice-stage-share-actions remote">
                        {#if isWatchingScreenShare(share)}
                          <div class="screen-share-volume-control">
                            <button
                              class="screen-share-volume-button"
                              class:active={screenShareVolumeMenuShareId === share.share_id}
                              type="button"
                              data-tooltip={t("screenShare.volume")}
                              aria-label={t("screenShare.volume")}
                              aria-expanded={screenShareVolumeMenuShareId === share.share_id}
                              onclick={(event) => toggleScreenShareVolumeMenu(share.share_id, event)}
                            >
                              <span class="material-symbols-rounded app-icon" aria-hidden="true">
                                {screenShareVolumeIcon(screenShareVolumePercent(share.owner_member_id, screenShareVolumePercents))}
                              </span>
                            </button>
                            {#if screenShareVolumeMenuShareId === share.share_id}
                              <div class="screen-share-volume-popover compact">
                                <header>
                                  <span>{t("screenShare.volume")}</span>
                                  <strong>{screenShareVolumePercent(share.owner_member_id, screenShareVolumePercents)}%</strong>
                                  <button
                                    type="button"
                                    aria-label={t("voice.resetVolume")}
                                    onclick={() => resetScreenShareVolume(share.owner_member_id)}
                                  >
                                    <span class="material-symbols-rounded app-icon" aria-hidden="true">refresh</span>
                                  </button>
                                </header>
                                <input
                                  type="range"
                                  min="0"
                                  max={memberVolumeLimitPercent}
                                  step="5"
                                  value={screenShareVolumePercent(share.owner_member_id, screenShareVolumePercents)}
                                  style={`--voice-range-progress: ${voiceRangeProgress(screenShareVolumePercent(share.owner_member_id, screenShareVolumePercents), memberVolumeLimitPercent)};`}
                                  aria-label={t("screenShare.volume")}
                                  oninput={(event) => changeScreenShareVolume(share.owner_member_id, event)}
                                />
                              </div>
                            {/if}
                          </div>
                        {/if}
                        <button
                          type="button"
                          data-screen-share-watch
                          disabled={isScreenShareWatchBusy(share)}
                          onclick={() => void toggleWatchScreenShare(share)}
                        >
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">
                            {watchFailed(share) ? "refresh" : isWatchingScreenShare(share) ? "visibility_off" : "visibility"}
                          </span>
                          <span>{watchFailed(share) ? t("screenShare.retry") : isWatchingScreenShare(share) ? t("screenShare.stopWatching") : t("screenShare.watch")}</span>
                        </button>
                      </div>
                    {/if}
                    {#if share.owner_member_id !== memberId}
                      <div class="remote-control-viewer-actions">
                        {#if memberControl?.status === "pending"}
                          <span class="remote-control-inline-status" data-remote-control-request-state="pending">
                            <span class="material-symbols-rounded app-icon" aria-hidden="true">hourglass_top</span>
                            <span>{t("remoteControl.pending")}</span>
                          </span>
                          <button
                            type="button"
                            data-remote-control-revoke
                            disabled={Boolean(remoteControlBusyId)}
                            onclick={() => void revokeRemoteControl(memberControl)}
                          >
                            <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
                            <span>{t("remoteControl.cancel")}</span>
                          </button>
                        {:else if memberControl?.status === "active"}
                          <button type="button" onclick={() => openFocusedScreenShare(share)}>
                            <span class="material-symbols-rounded app-icon" aria-hidden="true">keyboard_external_input</span>
                            <span>{t("remoteControl.openControlView")}</span>
                          </button>
                          <button
                            type="button"
                            data-remote-control-revoke
                            disabled={Boolean(remoteControlBusyId)}
                            onclick={() => void revokeRemoteControl(memberControl)}
                          >
                            <span class="material-symbols-rounded app-icon" aria-hidden="true">link_off</span>
                            <span>{t("remoteControl.revoke")}</span>
                          </button>
                        {:else if activeControl}
                          <button
                            type="button"
                            data-remote-control-request-state="occupied"
                            disabled
                          >
                            <span class="material-symbols-rounded app-icon" aria-hidden="true">hourglass_top</span>
                            <span>{t("remoteControl.waitingForController")}</span>
                          </button>
                        {:else}
                          <div class="remote-control-request-entry">
                            <button
                              type="button"
                              data-remote-control-request
                              data-remote-control-request-state={remoteControlBusyId === share.share_id ? "requesting" : "idle"}
                              aria-describedby={`remote-control-request-tooltip-${share.share_id}`}
                              disabled={Boolean(remoteControlBusyId) || !canRequestScreenShareControl(share)}
                              onclick={() => void requestScreenShareControl(share)}
                            >
                              <span class="material-symbols-rounded app-icon" class:spinning={remoteControlBusyId === share.share_id} aria-hidden="true">
                                {remoteControlBusyId === share.share_id ? "progress_activity" : "keyboard_external_input"}
                              </span>
                              <span>{t(remoteControlBusyId === share.share_id ? "remoteControl.requestSubmitting" : "remoteControl.request")}</span>
                            </button>
                            {#if remoteControlRequestError(share.share_id)}
                              <span class="remote-control-request-error" data-remote-control-request-state="error" role="alert">
                                <span class="material-symbols-rounded app-icon" aria-hidden="true">error</span>
                                <span>{remoteControlRequestError(share.share_id)}</span>
                              </span>
                            {/if}
                            {#if remoteControlRequestUnavailableReason(share)}
                              <span id={`remote-control-request-tooltip-${share.share_id}`} class="remote-control-request-tooltip" role="tooltip">
                                {remoteControlRequestUnavailableReason(share)}
                              </span>
                            {/if}
                          </div>
                        {/if}
                      </div>
                    {/if}
                    {#if share.owner_member_id !== memberId && isWatchingScreenShare(share)}
                      <button
                        class="voice-stage-share-preview"
                        type="button"
                        data-tooltip={t("screenShare.openViewer")}
                        aria-label={t("screenShare.openViewer")}
                        onclick={() => openFocusedScreenShare(share)}
                      >
                        {#if remoteScreenShareStreams.has(share.owner_member_id)}
                          <video
                            use:screenShareVideo={remoteScreenShareStreams.get(share.owner_member_id)}
                            draggable="false"
                            autoplay
                            playsinline
                          ></video>
                        {:else}
                          <span class="voice-stage-share-waiting">
                            <span class="material-symbols-rounded app-icon" aria-hidden="true">sync</span>
                            <span>{screenShareWatchStatusLabel(share)}</span>
                          </span>
                        {/if}
                      </button>
                    {/if}
                  </article>
                {/each}
              </div>
            {/if}
          </section>

          <section class="voice-stage-section">
            <header>
              <p class="section-label">{t("members.inVoice")}</p>
              <div class="voice-stage-member-header-actions">
                <span>{selectedVoiceStates.length}</span>
                <div class="voice-stage-member-view-switch" role="group" aria-label={t("voice.memberViewMode")}>
                  <button
                    type="button"
                    class:active={voiceStageMemberDisplayMode === "cards"}
                    aria-label={t("voice.memberViewCards")}
                    aria-pressed={voiceStageMemberDisplayMode === "cards"}
                    data-tooltip={t("voice.memberViewCards")}
                    onclick={() => setVoiceStageMemberDisplayMode("cards")}
                  >
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">view_agenda</span>
                  </button>
                  <button
                    type="button"
                    class:active={voiceStageMemberDisplayMode === "avatars"}
                    aria-label={t("voice.memberViewAvatars")}
                    aria-pressed={voiceStageMemberDisplayMode === "avatars"}
                    data-tooltip={t("voice.memberViewAvatars")}
                    onclick={() => setVoiceStageMemberDisplayMode("avatars")}
                  >
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">grid_view</span>
                  </button>
                </div>
              </div>
            </header>
            <div class="voice-stage-member-grid" class:avatar-mode={voiceStageMemberDisplayMode === "avatars"}>
              {#each selectedVoiceStates as state (state.participant_id)}
                <div
                  class="voice-stage-member"
                  class:speaking={isVoiceStateSpeaking(state)}
                  class:selected={selectedVoiceParticipantIds.has(state.participant_id)}
                  class:dragging={Boolean(voiceParticipantPointerPress?.dragging) && selectedVoiceParticipantIds.has(state.participant_id)}
                  role="button"
                  tabindex="0"
                  data-voice-member-id={state.member_id}
                  data-voice-participant-id={state.participant_id}
                  title={voiceStageMemberDisplayMode === "avatars" ? memberDisplayName(state.member_id) : undefined}
                  onpointerdown={(event) => handleVoiceParticipantPointerDown(state, event)}
                  onpointermove={(event) => handleVoiceParticipantPointerMove(state, event)}
                  onpointerup={(event) => handleVoiceParticipantPointerUp(state, event)}
                  onpointercancel={(event) => handleVoiceParticipantPointerCancel(state, event)}
                  onmousedown={(event) => handleVoiceParticipantMouseDown(state, event)}
                  oncontextmenu={(event) => openVoiceParticipantContextMenu(state, event)}
                  onkeydown={(event) => handleVoiceParticipantKeydown(state, event)}
                >
                  <div class="voice-stage-member-avatar">
                    <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(state.member_id)}>
                      {#if memberAvatarDataURL(state.member_id)}
                        <img src={memberAvatarDataURL(state.member_id)} alt="" />
                      {:else}
                        {memberInitials(state.member_id)}
                      {/if}
                    </span>
                    {#if state.mic_muted || state.server_muted}
                      <span
                        class="material-symbols-rounded app-icon voice-stage-member-mute-badge"
                        aria-label={state.server_muted ? t("voice.serverMuted") : t("voice.muted")}
                      >mic_off</span>
                    {/if}
                  </div>
                  <div>
                    <strong>{memberDisplayName(state.member_id)}</strong>
                    {#if voiceListenerCount(state.member_id) > 0}
                      <span class="voice-stage-listener-summary">
                        {t("voice.extraListeningDevices", { count: voiceListenerCount(state.member_id) })}
                      </span>
                    {/if}
                  </div>
                  {#if state.audio_deafened || state.server_deafened || screenSharingMemberIds.has(state.member_id) || accompanimentMemberIds.has(state.member_id)}
                    <span class="voice-stage-member-icons">
                      {#if state.audio_deafened || state.server_deafened}
                        <span
                          class="material-symbols-rounded app-icon"
                          aria-label={state.server_deafened ? t("voice.serverDeafened") : t("voice.deafened")}
                        >headset_off</span>
                      {/if}
                      {#if screenSharingMemberIds.has(state.member_id)}
                        <span class="material-symbols-rounded app-icon screen-share-member-indicator" aria-label={t("screenShare.title")}>screen_share</span>
                      {/if}
                      {#if accompanimentMemberIds.has(state.member_id)}
                        <span class="material-symbols-rounded app-icon accompaniment-indicator" aria-label={t("accompaniment.title")}>music_note</span>
                      {/if}
                    </span>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        </div>
        {/if}
      {:else if channelContentMode === "files"}
        <div class="file-panel">
          <div class="file-toolbar">
            <nav class="file-breadcrumbs" aria-label={t("files.breadcrumbs")}>
              <button
                type="button"
                data-file-drop-parent-id=""
                class:file-drop-target={fileDragTargetId === ""}
                onclick={() => openFileBreadcrumb(-1)}
              >
                <span class="material-symbols-rounded app-icon" aria-hidden="true">home_storage</span>
                <span>{t("files.root")}</span>
              </button>
              {#each fileBreadcrumbs as crumb, index}
                <span class="material-symbols-rounded app-icon breadcrumb-chevron" aria-hidden="true">chevron_right</span>
                <button
                  type="button"
                  data-file-drop-parent-id={crumb.entry_id}
                  class:file-drop-target={fileDragTargetId === crumb.entry_id}
                  onclick={() => openFileBreadcrumb(index)}
                >{crumb.name}</button>
              {/each}
            </nav>
            <div class="file-toolbar-actions">
              {#if selectedFileEntryIds.size > 0}
                <span class="file-selection-count">{t("files.selectedCount", { count: selectedFileEntryIds.size })}</span>
                <button
                  class="file-batch-delete"
                  type="button"
                  disabled={!selectedFilesAreManageable() || fileActionBusyId !== ""}
                  data-tooltip={selectedFilesAreManageable() ? t("files.deleteSelectedAction") : t("files.selectionNotManageable")}
                  aria-label={t("files.deleteSelectedAction")}
                  onclick={deleteSelectedFileEntries}
                >
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
                </button>
              {/if}
              <button type="button" disabled={fileLoading} onclick={refreshFileEntries}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">refresh</span>
                <span>{t("files.refresh")}</span>
              </button>
              {#if canUploadFiles}
                <button type="button" disabled={fileUploading || fileLoading} onclick={triggerFileUpload}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">upload_file</span>
                  <span>{fileUploading ? t("files.uploading") : t("files.upload")}</span>
                </button>
              {/if}
              {#if fileUploading}
                <span class="file-upload-progress">{fileUploadProgress}%</span>
              {/if}
              {#if canManageFiles}
                <button type="button" disabled={fileActionBusyId !== "" || fileLoading} onclick={createDirectoryInCurrentFolder}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">create_new_folder</span>
                  <span>{t("files.newFolder")}</span>
                </button>
              {/if}
            </div>
          </div>

          {#if error}
            <p class="error content-error">{error}</p>
          {/if}
          {#if fileLoading}
            <p class="empty-state">{t("files.loading")}</p>
          {:else if fileEntries.length === 0}
            <div
              class="file-empty-state"
              class:file-drop-target={fileDragTargetId === fileParentId}
              data-file-drop-parent-id={fileParentId}
            >
              <span class="material-symbols-rounded app-icon" aria-hidden="true">folder_open</span>
              <p>{t("files.empty")}</p>
            </div>
          {:else}
            <div
              class="file-list"
              class:file-drop-target={fileDragTargetId === fileParentId}
              role="listbox"
              aria-multiselectable="true"
              data-file-drop-parent-id={fileParentId}
            >
              {#each fileEntries as entry}
                <div
                  class="file-row"
                  class:selected={selectedFileEntryIds.has(entry.entry_id)}
                  class:dragging={Boolean(filePointerPress?.dragging && selectedFileEntryIds.has(entry.entry_id))}
                  class:file-drop-target={entry.type === "directory" && fileDragTargetId === entry.entry_id}
                  role="option"
                  tabindex="0"
                  aria-selected={selectedFileEntryIds.has(entry.entry_id)}
                  data-file-entry-id={entry.entry_id}
                  data-file-drop-parent-id={entry.type === "directory" ? entry.entry_id : undefined}
                  onpointerdown={(event) => handleFileEntryPointerDown(entry, event)}
                  ondblclick={(event) => !(event.target as HTMLElement | null)?.closest(".file-row-actions") && void activateFileEntry(entry)}
                  onkeydown={(event) => handleFileEntryKeydown(entry, event)}
                >
                  <div
                    class="file-main"
                  >
                    <span class="material-symbols-rounded app-icon file-type-icon" aria-hidden="true">
                      {fileEntryIcon(entry)}
                    </span>
                    <span>
                      <strong>{entry.name}</strong>
                      <small>
                        {entry.type === "directory" ? t("files.folder") : formatFileSize(entry.size_bytes)}
                        {#if entry.mime_type}
                          - {entry.mime_type}
                        {/if}
                        {#if entry.owner_member_id}
                          - {t("files.owner", { name: memberDisplayName(entry.owner_member_id) })}
                        {/if}
                      </small>
                    </span>
                  </div>
                  <div class="file-row-actions">
                    {#if entry.type === "file" && canDownloadFiles}
                      <button
                        type="button"
                        data-tooltip={t("files.preview")}
                        aria-label={t("files.preview")}
                        disabled={fileActionBusyId === entry.entry_id}
                        onclick={() => openFilePreview(entry)}
                      >
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">visibility</span>
                      </button>
                      <button
                        type="button"
                        data-tooltip={t("files.download")}
                        aria-label={t("files.download")}
                        disabled={fileActionBusyId === entry.entry_id}
                        onclick={() => downloadFileEntryFromChannel(entry)}
                      >
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">download</span>
                      </button>
                    {/if}
                    {#if canManageFileEntry(entry)}
                      <button
                        type="button"
                        data-tooltip={t("files.rename")}
                        aria-label={t("files.rename")}
                        disabled={fileActionBusyId === entry.entry_id}
                        onclick={() => renameFileEntry(entry)}
                      >
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">drive_file_rename_outline</span>
                      </button>
                      <button
                        class="danger"
                        type="button"
                        data-tooltip={t("files.delete")}
                        aria-label={t("files.delete")}
                        disabled={fileActionBusyId === entry.entry_id}
                        onclick={() => deleteFileEntryFromChannel(entry)}
                      >
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <!-- Event delegation is required for verified emoji buttons rendered from sanitized message markup. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="message-list" role="log" aria-live="polite" bind:this={_messageListElement} onscroll={handleMessageListScroll} onclick={handleMessageListClick} onkeydown={handleMessageListKeydown}>
        {#if error}
          <p class="error content-error">{error}</p>
        {/if}
        {#if hasOlderMessages}
          <button class="load-older-button" type="button" disabled={messageBeforeLoading} onclick={loadOlderMessages}>
            {messageBeforeLoading ? t("messages.loadingOlder") : t("messages.loadOlder")}
          </button>
        {/if}
        {#if messages.length === 0}
          <p class="empty-state">{t("messages.empty")}</p>
        {/if}
        {#each messages as message}
          {#if currentChannelNewMessageStartId === message.message_id}
            <div class="new-message-separator">
              <span>{t("messages.newSeparator")}</span>
            </div>
          {/if}
          <!-- Ctrl/Shift selection is an optional pointer shortcut; message actions remain keyboard-accessible. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <article
            class="message-row"
            class:message-local-sending={message.local_status === "sending"}
            class:message-local-failed={message.local_status === "failed"}
            class:selected={selectedMessageIds.has(message.message_id)}
            data-message-id={message.message_id}
            onclick={(event) => handleMessageSelection(message, event)}
            oncontextmenu={(event) => openMessageContextMenu(message, event)}
          >
            <div class="avatar member-avatar" style={memberAvatarStyle(message.author_id)}>
              {#if memberAvatarDataURL(message.author_id)}
                <img src={memberAvatarDataURL(message.author_id)} alt="" />
              {:else}
                {memberInitials(message.author_id)}
              {/if}
            </div>
            <div class="message-body">
              <p class="message-author">
                <span>{memberDisplayName(message.author_id)}</span>
                <time datetime={new Date(message.created_at_ms).toISOString()}>{messageTime(message.created_at_ms)}</time>
                {#if message.edited_at_ms}
                  <span>{t("messages.edited")}</span>
                {/if}
                {#if message.local_status === "sending"}
                  <span class="message-delivery-state">{t("messages.sending")}</span>
                {:else if message.local_status === "failed"}
                  <span class="message-delivery-state failed">{t("messages.failed")}</span>
                {/if}
              </p>
              {#if message.reply_to_message_id}
                {@const repliedMessage = messageById(message.reply_to_message_id)}
                <button
                  class="message-reply-reference"
                  type="button"
                  onclick={() => jumpToMessage(message.reply_to_message_id)}
                >
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">reply</span>
                  <strong>{repliedMessage ? memberDisplayName(repliedMessage.author_id) : t("messages.replyUnknownAuthor")}</strong>
                  <span>{replyPreviewContent(repliedMessage)}</span>
                </button>
              {/if}
              {#if editingMessageId === message.message_id}
                <form class="message-edit-form" onsubmit={(event) => { event.preventDefault(); const handler = (() => submitEditedMessage(message)); if (handler) return handler(event); }}>
                  <div
                    bind:this={_messageEditEditorElement}
                    class="message-edit-editor"
                    contenteditable={messageActionBusyId === message.message_id ? "false" : "true"}
                    role="textbox"
                    tabindex="0"
                    aria-multiline="true"
                    aria-label={t("messages.edit")}
                    spellcheck="true"
                    oninput={handleMessageEditInput}
                    onloadcapture={(event) => {  const handler = (handleMessageEditEmbeddedMediaLoad); if (handler) return handler(event); }}
                    onpaste={handleMessageEditPaste}
                    onkeydown={(event) => handleEditMessageKeydown(event, message)}
                  ></div>
                  <div class="message-edit-footer">
                    <span>{t("messages.editHint")}</span>
                    <div class="message-edit-actions">
                      <button class="secondary" type="button" onclick={cancelEditMessage}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
                        <span>{t("messages.cancelEdit")}</span>
                      </button>
                      <button
                        class="primary"
                        type="submit"
                        disabled={messageActionBusyId === message.message_id || !editingMessageDraft.trim()}
                      >
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>
                        <span>{t("messages.saveEdit")}</span>
                      </button>
                    </div>
                  </div>
                </form>
              {:else}
                {@const contentSegments = parseMessageContentSegments(message.content)}
                <div class="message-content message-mixed-content">
                  {#each contentSegments as segment, index}
                    {#if segment.type === "text"}
                      <span class="message-text-segment">{@html formatMessageContent(segment.content)}</span>
                    {:else}
                      <article
                        class="message-inline-image"
                        class:loading={messageAttachmentLoadingIds.has(segment.image.assetSHA256)}
                        class:error={messageAttachmentErrorIds.has(segment.image.assetSHA256)}
                        use:observeMessageImagePreview={segment.image}
                        data-message-image-sha={segment.image.assetSHA256}
                        data-message-image-index={index}
                      >
                        {#if messageAttachmentObjectURLs.get(segment.image.assetSHA256)}
                          <button
                            type="button"
                            aria-label={t("messages.previewImage", { name: segment.image.name })}
                            onclick={() => void openMessageImagePreview(segment.image, message.author_id)}
                          >
                            <img
                              src={messageAttachmentObjectURLs.get(segment.image.assetSHA256)}
                              alt={segment.image.name}
                              loading="lazy"
                            />
                          </button>
                        {:else}
                          <button
                            class="message-inline-image-placeholder"
                            type="button"
                            disabled={messageAttachmentLoadingIds.has(segment.image.assetSHA256)}
                            aria-label={messageAttachmentErrorIds.has(segment.image.assetSHA256)
                              ? t("messages.retryImage", { name: segment.image.name })
                              : t("messages.loadImage", { name: segment.image.name })}
                            onclick={() => void ensureMessageImagePreview(segment.image)}
                          >
                            <span class="material-symbols-rounded app-icon" aria-hidden="true">
                              {messageAttachmentLoadingIds.has(segment.image.assetSHA256)
                                ? "progress_activity"
                                : messageAttachmentErrorIds.has(segment.image.assetSHA256)
                                  ? "broken_image"
                                  : "image"}
                            </span>
                            <span>{messageAttachmentErrorIds.has(segment.image.assetSHA256) ? t("messages.imageLoadFailed") : t("messages.imageLoading")}</span>
                          </button>
                        {/if}
                      </article>
                    {/if}
                  {/each}
                </div>
                {#if parseMessageAttachmentReferences(message.content).length > 0}
                  <div class="message-attachment-list">
                    {#each parseMessageAttachmentReferences(message.content) as attachment (attachment.entryId)}
                      <article
                        class="message-media-attachment"
                        class:image={attachment.previewKind === "image"}
                        class:video={attachment.previewKind === "video"}
                        class:audio={attachment.previewKind === "audio"}
                        use:observeMessageAttachmentPreview={attachment}
                        data-message-attachment-id={attachment.entryId}
                      >
                        {#if attachment.previewKind === "image" && messageAttachmentObjectURLs.get(attachment.entryId)}
                          <button
                            class="message-attachment-image-button"
                            type="button"
                            aria-label={t("files.previewNamed", { name: attachment.name })}
                            onclick={() => void openMessageAttachmentPreview(attachment)}
                          >
                            <img
                              src={messageAttachmentObjectURLs.get(attachment.entryId)}
                              alt={attachment.name}
                              loading="lazy"
                            />
                          </button>
                        {:else if attachment.previewKind === "video" && messageAttachmentObjectURLs.get(attachment.entryId)}
                          <div class="message-attachment-player">
                            <FileMediaPreview
                              src={messageAttachmentObjectURLs.get(attachment.entryId) ?? ""}
                              kind="video"
                              compact
                              playLabel={t("files.play")}
                              pauseLabel={t("files.pause")}
                              volumeLabel={t("files.volume")}
                            />
                          </div>
                        {:else if attachment.previewKind === "audio" && messageAttachmentObjectURLs.get(attachment.entryId)}
                          <div class="message-attachment-player audio">
                            <FileMediaPreview
                              src={messageAttachmentObjectURLs.get(attachment.entryId) ?? ""}
                              kind="audio"
                              compact
                              playLabel={t("files.play")}
                              pauseLabel={t("files.pause")}
                              volumeLabel={t("files.volume")}
                            />
                          </div>
                        {:else}
                          <button
                            class="message-attachment-placeholder"
                            type="button"
                            disabled={!canDownloadFiles || messageAttachmentLoadingIds.has(attachment.entryId)}
                            onclick={() => messageAttachmentIsInlineMedia(attachment)
                              ? void ensureMessageAttachmentPreview(attachment)
                              : void downloadMessageAttachment(attachment)}
                          >
                            <span class="material-symbols-rounded app-icon" class:loading={messageAttachmentLoadingIds.has(attachment.entryId)} aria-hidden="true">
                              {messageAttachmentLoadingIds.has(attachment.entryId)
                                ? "progress_activity"
                                : messageAttachmentErrorIds.has(attachment.entryId)
                                  ? "broken_image"
                                  : filePreviewIcon(attachment.previewKind)}
                            </span>
                            <span>
                              <strong>{attachment.name}</strong>
                              <small>
                                {messageAttachmentErrorIds.has(attachment.entryId)
                                  ? t("files.previewLoadFailed")
                                  : messageAttachmentLoadingIds.has(attachment.entryId)
                                    ? t("files.previewLoading")
                                    : t("files.openAttachment")}
                              </small>
                            </span>
                          </button>
                        {/if}
                        <footer class="message-attachment-meta">
                          <span>
                            <strong>{attachment.name}</strong>
                            <small>{formatFileSize(attachment.sizeBytes)}{attachment.mimeType ? ` · ${attachment.mimeType}` : ""}</small>
                          </span>
                          {#if attachment.previewKind !== "unknown"}
                            <button
                              type="button"
                              disabled={!canDownloadFiles}
                              data-tooltip={t("files.preview")}
                              aria-label={t("files.previewNamed", { name: attachment.name })}
                              onclick={() => void openMessageAttachmentPreview(attachment)}
                            >
                              <span class="material-symbols-rounded app-icon" aria-hidden="true">open_in_full</span>
                            </button>
                          {/if}
                          <button
                            type="button"
                            disabled={!canDownloadFiles || fileActionBusyId === attachment.entryId}
                            data-tooltip={t("composer.downloadAttachment", { name: attachment.name })}
                            aria-label={t("composer.downloadAttachment", { name: attachment.name })}
                            onclick={() => void downloadMessageAttachment(attachment)}
                          >
                            <span class="material-symbols-rounded app-icon" aria-hidden="true">download</span>
                          </button>
                        </footer>
                      </article>
                    {/each}
                  </div>
                {/if}
              {/if}
              {#if message.local_status === "failed"}
                <div class="message-delivery-actions">
                  <span>{message.local_error || t("error.messageSendFailed")}</span>
                  <button type="button" onclick={() => retryLocalMessage(message)}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">refresh</span>
                    <span>{t("messages.retry")}</span>
                  </button>
                  <button type="button" onclick={() => dismissLocalMessage(message)}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
                    <span>{t("messages.dismiss")}</span>
                  </button>
                </div>
              {/if}
            </div>
          </article>
        {/each}
      </div>

      {#if currentChannelNewMessageCount > 0}
        <button class="new-message-jump" type="button" onclick={jumpToLatestMessages}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">south</span>
          <span>{t("messages.newMessages", { count: currentChannelNewMessageCount })}</span>
        </button>
      {/if}

      <div class="composer-panel">
        {#if replyingToMessageId}
          <div class="composer-reply-preview">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">reply</span>
            <div>
              <strong>
                {replyingToMessage ? t("messages.replyingTo", { name: memberDisplayName(replyingToMessage.author_id) }) : t("messages.replying")}
              </strong>
              <span>{replyPreviewContent(replyingToMessage)}</span>
            </div>
            <button type="button" aria-label={t("messages.cancelReply")} title={t("messages.cancelReply")} onclick={clearReplyTarget}>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
            </button>
          </div>
        {/if}

        <form
          class="composer"
          class:image-drag-active={composerInlineImageDragActive}
          onsubmit={(event) => { event.preventDefault(); const handler = (submitMessage); if (handler) return handler(event); }}
          ondragenter={handleComposerDragEnter}
          ondragover={handleComposerDragOver}
          ondragleave={handleComposerDragLeave}
          ondrop={handleComposerImageDrop}
        >
          <input
            bind:this={_composerAttachmentInputElement}
            class="visually-hidden composer-attachment-input"
            type="file"
            multiple
            onchange={handleComposerAttachmentInput}
          />
          {#if composerInlineImageDragActive}
            <div class="composer-image-drop-overlay" aria-hidden="true">
              <span class="material-symbols-rounded app-icon">add_photo_alternate</span>
              <span>{t("composer.dropImages")}</span>
            </div>
          {/if}
          {#if composerAttachments.length > 0}
            <div class="composer-attachment-queue" aria-label={t("composer.attachments")}>
              {#each composerAttachments as attachment}
                <div class="composer-attachment-item">
                  <button
                    class="composer-attachment-preview"
                    type="button"
                    aria-label={t("files.previewNamed", { name: attachment.name })}
                    onclick={() => void openComposerAttachmentPreview(attachment)}
                  >
                    {#if classifyFilePreview(attachment.name, attachment.mime_type) === "image" && composerAttachmentObjectURLs.get(attachment.entry_id)}
                      <img src={composerAttachmentObjectURLs.get(attachment.entry_id)} alt={attachment.name} />
                    {:else}
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">
                        {filePreviewIcon(classifyFilePreview(attachment.name, attachment.mime_type))}
                      </span>
                    {/if}
                    <span>
                      <strong>{attachment.name}</strong>
                      <small>{formatFileSize(attachment.size_bytes)}</small>
                    </span>
                  </button>
                  <button
                    class="composer-attachment-remove"
                    type="button"
                    aria-label={t("composer.removeAttachment", { name: attachment.name })}
                    disabled={Boolean(composerAttachmentBusyId)}
                    onclick={() => void removeComposerAttachment(attachment)}
                  >
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
                  </button>
                </div>
              {/each}
            </div>
          {/if}
          <div
            bind:this={_composerInputShellElement}
            class="composer-input-shell"
            class:scrollable={composerScrollbarVisible}
          >
            {#if emojiAutocompleteState && emojiAutocompleteEntries.length > 0}
              <div
                class="emoji-autocomplete-menu"
                role="listbox"
                aria-label={t("emoji.suggestions")}
                style={`left: ${Math.round(emojiAutocompleteLeft)}px;`}
              >
                <header>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
                  <span>{emojiAutocompleteState.query ? t("emoji.resultsFor", { query: emojiAutocompleteState.query }) : t("emoji.suggestions")}</span>
                </header>
                <div class="emoji-autocomplete-results">
                  {#each emojiAutocompleteEntries as entry, index (entry.key)}
                    <button
                      type="button"
                      role="option"
                      class:active={index === emojiAutocompleteSelectedIndex}
                      aria-selected={index === emojiAutocompleteSelectedIndex}
                      onmousedown={(event) => { event.preventDefault(); }}
                      onpointerenter={() => (emojiAutocompleteSelectedIndex = index)}
                      onclick={() => selectEmojiAutocompleteEntry(entry)}
                    >
                      <span class="emoji-autocomplete-preview" aria-hidden="true">
                        {#if entry.imageURL}
                          <img src={entry.imageURL} alt="" />
                        {:else if entry.kind === "default"}
                          <span>{entry.value}</span>
                        {:else}
                          <span class="material-symbols-rounded app-icon">add_reaction</span>
                        {/if}
                      </span>
                      <span>:{entry.id}:</span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
            <div
              bind:this={_composerEditorElement}
              class="composer-editor"
              class:disabled={!selectedChannelId || messageSubmitting}
              contenteditable={selectedChannelId && !messageSubmitting ? "true" : "false"}
              role="textbox"
              tabindex={selectedChannelId && !messageSubmitting ? 0 : -1}
              aria-label={composerPlaceholder}
              aria-multiline="true"
              aria-disabled={!selectedChannelId || messageSubmitting}
              data-placeholder={composerPlaceholder}
              spellcheck="true"
              onbeforeinput={handleComposerBeforeInput}
              oninput={handleComposerInput}
              onscroll={handleComposerScroll}
              onkeydown={handleComposerKeydown}
              onkeyup={updateComposerSelection}
              onpointerup={updateComposerSelection}
              onclick={handleComposerEditorClick}
              onfocus={updateComposerSelection}
              onblur={handleComposerBlur}
              onpaste={handleComposerPaste}
              oncompositionstart={handleComposerCompositionStart}
              oncompositionend={handleComposerCompositionEnd}
            ></div>
            {#if composerInlineImageUploading}
              <div class="composer-inline-image-upload-state" aria-live="polite">
                <span class="material-symbols-rounded app-icon" aria-hidden="true">progress_activity</span>
                <span>{t("composer.inlineImageUploading", { progress: composerInlineImageUploadProgress })}</span>
              </div>
            {/if}
            <button
              class="composer-attachment-button"
              type="button"
              disabled={!fileStorageAvailable || !canUploadFiles || !canSendMessages || composerAttachmentUploading || messageSubmitting}
              data-tooltip={!fileStorageAvailable
                ? t("composer.attachmentsUnavailable")
                : composerAttachmentUploading
                  ? t("composer.attachmentUploading", { progress: composerAttachmentUploadProgress })
                  : t("composer.uploadAttachment")}
              aria-label={t("composer.uploadAttachment")}
              onclick={triggerComposerAttachmentUpload}
            >
              <span class="material-symbols-rounded app-icon" class:uploading={composerAttachmentUploading} aria-hidden="true">
                {composerAttachmentUploading ? "progress_activity" : "add_circle"}
              </span>
            </button>
            <button
              class="composer-emoji-button"
              class:active={emojiPickerOpen}
              type="button"
              disabled={!selectedChannelId || !canSendMessages || messageSubmitting}
              data-tooltip={t("emoji.open")}
              aria-label={t("emoji.open")}
              aria-expanded={emojiPickerOpen}
              onpointerdown={(event) => { event.preventDefault(); }}
              onclick={(event) => void toggleEmojiPicker(event)}
            >
              <span class="material-symbols-rounded app-icon" aria-hidden="true">add_reaction</span>
            </button>
            {#if composerScrollbarVisible}
              <div class="composer-custom-scrollbar">
                <button
                  type="button"
                  class="composer-custom-scrollbar-thumb"
                  class:active={composerScrollbarDragging}
                  aria-label={t("composer.scrollbar")}
                  title={t("composer.scrollbar")}
                  tabindex="-1"
                  style={`height: ${composerScrollbarThumbHeight}px; transform: translateY(${composerScrollbarThumbTop}px);`}
                  onpointerdown={startComposerScrollbarDrag}
                ></button>
              </div>
            {/if}
          </div>
        </form>
      </div>
      {/if}
    {:else}
      <div class="welcome-panel">
        <div class="welcome-server-mark">
          {#if server?.icon_data_url}
            <img src={server.icon_data_url} alt="" />
          {:else}
            {serverInitials(server?.name ?? "EchoVoice")}
          {/if}
        </div>
        <div>
          <p class="eyebrow">EchoVoice</p>
          <h1>{server?.name ?? "EchoVoice"}</h1>
          <p>{t("content.membersCount", { count: members.length })}</p>
          {#if server?.description}
            <p class="welcome-server-description">{server.description}</p>
          {/if}
        </div>
      </div>
    {/if}
  </section>
