<script lang="ts">
  import { emojiAlias } from "../lib/emoji";
  import { type EmojiController, type EmojiPickerEntry } from "../lib/emoji.svelte";
  import type { SoundboardEditorTarget } from "../lib/soundboard.svelte";
  import type { ServerSummary, StoredServer } from "../lib/types";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    emoji: EmojiController;
    server: ServerSummary | null;
    savedServers: StoredServer[];
    canSendEmoji: boolean;
    soundboardEditorTarget: SoundboardEditorTarget | null;
    searchQuery: string;
    onSearchQueryChange: (query: string) => void;
    hoveredEntry: EmojiPickerEntry | null;
    onHoveredEntryChange: (entry: EmojiPickerEntry | null) => void;
    setPickerElement: (element: HTMLDivElement | null) => void;
    setPickerSearchInputElement: (element: HTMLInputElement | null) => void;
    onKeydown: (event: KeyboardEvent) => void;
    onCreatePack: () => void;
    onOpenAddDialog: () => void;
    onSelectSection: (sectionID: string) => void;
    onSelectEntry: (entry: EmojiPickerEntry) => void;
    onDeleteLocalEntry: (entry: EmojiPickerEntry) => void;
  };

  let {
    t,
    emoji,
    server,
    savedServers,
    canSendEmoji,
    soundboardEditorTarget,
    searchQuery,
    onSearchQueryChange,
    hoveredEntry,
    onHoveredEntryChange,
    setPickerElement,
    setPickerSearchInputElement,
    onKeydown,
    onCreatePack,
    onOpenAddDialog,
    onSelectSection,
    onSelectEntry,
    onDeleteLocalEntry
  }: Props = $props();

  let pickerElement = $state<HTMLDivElement | null>(null);
  let searchInputElement = $state<HTMLInputElement | null>(null);

  $effect(() => {
    setPickerElement(pickerElement);
    return () => setPickerElement(null);
  });
  $effect(() => {
    setPickerSearchInputElement(searchInputElement);
    return () => setPickerSearchInputElement(null);
  });

  let sections = $derived.by(() => {
    // Track the same dependencies the old App-side `$:` block tracked.
    t;
    server;
    savedServers;
    canSendEmoji;
    soundboardEditorTarget;
    return emoji.buildPickerSections();
  });
  let visibleSections = $derived(emoji.visiblePickerSections(
    sections,
    emoji.pickerActiveSectionID,
    searchQuery
  ));

  // Keep the active section valid after the picker sections rebuild.
  $effect(() => {
    if (sections.length > 0 && !sections.some((section) => section.id === emoji.pickerActiveSectionID)) {
      emoji.setPickerActiveSection(sections[0].id);
    }
  });
</script>

{#if emoji.pickerOpen}
<div
  bind:this={pickerElement}
  class="emoji-picker-popover"
  class:soundboard-icon-picker={emoji.pickerPurpose === "soundboard"}
  style={emoji.pickerStyle}
  role="dialog"
  aria-modal="false"
  aria-label={t("emoji.title")}
  tabindex="-1"
  onkeydown={(event) => onKeydown(event)}
>
  <header class="emoji-picker-header">
    <label class="emoji-picker-search">
      <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
      <input
        bind:this={searchInputElement}
        value={searchQuery}
        maxlength="40"
        autocomplete="off"
        spellcheck="false"
        placeholder={t("emoji.search")}
        aria-label={t("emoji.search")}
        oninput={(event) => {
          onSearchQueryChange((event.currentTarget as HTMLInputElement).value);
          onHoveredEntryChange(null);
        }}
      />
    </label>
    {#if emoji.pickerPurpose === "composer"}
      <div class="emoji-picker-header-actions">
        <button type="button" data-label={t("emoji.createPack")} aria-label={t("emoji.createPack")} onclick={onCreatePack}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">create_new_folder</span>
        </button>
        <button type="button" disabled={Boolean(emoji.actionBusyId)} data-label={t("emoji.add")} aria-label={t("emoji.add")} onclick={onOpenAddDialog}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">add_photo_alternate</span>
        </button>
      </div>
    {/if}
  </header>

  <div class="emoji-picker-body">
    <nav class="emoji-picker-category-rail" aria-label={t("emoji.categories")}>
      {#each sections as section (section.id)}
        <button
          type="button"
          class:active={emoji.pickerActiveSectionID === section.id && !searchQuery.trim()}
          class:server={section.kind === "server"}
          data-label={section.label}
          aria-label={section.label}
          aria-pressed={emoji.pickerActiveSectionID === section.id && !searchQuery.trim()}
          onclick={() => onSelectSection(section.id)}
        >
          {#if section.iconDataURL}
            <img src={section.iconDataURL} alt="" />
          {:else}
            <span class="material-symbols-rounded app-icon" aria-hidden="true">{section.icon}</span>
          {/if}
        </button>
      {/each}
    </nav>

    <div class="emoji-picker-content">
      {#if visibleSections.length === 0}
        <div class="emoji-picker-empty"><span class="material-symbols-rounded app-icon" aria-hidden="true">search_off</span><span>{t("emoji.noResults")}</span></div>
      {:else}
        {#each visibleSections as section (section.id)}
          <section class="emoji-picker-section" aria-label={section.label}>
            <h3>{section.label}</h3>
            {#if section.entries.length === 0}
              <div class="emoji-picker-section-empty">{t("emoji.noRecent")}</div>
            {:else}
              <div class="emoji-picker-grid" role="listbox" aria-label={section.label}>
                {#each section.entries as entry (entry.key)}
                  <button
                    class="emoji-picker-item"
                    type="button"
                    role="option"
                    aria-selected="false"
                    aria-label={emojiAlias(entry.id)}
                    disabled={Boolean(emoji.actionBusyId)}
                    onpointerenter={() => onHoveredEntryChange(entry)}
                    onfocus={() => onHoveredEntryChange(entry)}
                    onclick={() => void onSelectEntry(entry)}
                  >
                    {#if entry.imageURL}
                      <img src={entry.imageURL} alt="" />
                    {:else if entry.kind === "default"}
                      <span class="emoji-picker-unicode" aria-hidden="true">{entry.value}</span>
                    {:else}
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">{entry.sizeBytes > 1024 * 1024 ? "cloud_download" : "hourglass_empty"}</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      {/if}
    </div>
  </div>

  <footer class="emoji-picker-hover-card" aria-live="polite">
    {#if hoveredEntry}
      <span class="emoji-picker-hover-preview" aria-hidden="true">
        {#if hoveredEntry.imageURL}
          <img src={hoveredEntry.imageURL} alt="" />
        {:else if hoveredEntry.kind === "default"}
          {hoveredEntry.value}
        {:else}
          <span class="material-symbols-rounded app-icon">add_reaction</span>
        {/if}
      </span>
      <strong>{emojiAlias(hoveredEntry.id)}</strong>
      {#if hoveredEntry.kind === "local"}
        <button type="button" aria-label={t("emoji.removeLocal")} onclick={() => void onDeleteLocalEntry(hoveredEntry!)}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
        </button>
      {/if}
    {:else}
      <span class="material-symbols-rounded app-icon" aria-hidden="true">touch_app</span>
      <span>{t("emoji.hoverForID")}</span>
    {/if}
  </footer>
</div>
{/if}
