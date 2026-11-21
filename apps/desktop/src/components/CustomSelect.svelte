<script lang="ts">
  import { onDestroy, tick } from "svelte";

  export type CustomSelectOption = {
    value: string;
    label: string;
  };

  export let value = "";
  export let options: CustomSelectOption[] = [];
  export let ariaLabel = "";
  export let disabled = false;
  export let onValueChange: (value: string) => void = () => {};

  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let open = false;
  let openAbove = false;
  let menuMaxHeight = 240;

  $: selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  function updatePlacement() {
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const gap = 5;
    const padding = 8;
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap - padding);
    const spaceAbove = Math.max(0, rect.top - gap - padding);
    openAbove = spaceBelow < Math.min(180, spaceAbove) && spaceAbove > spaceBelow;
    menuMaxHeight = Math.max(96, Math.min(240, openAbove ? spaceAbove : spaceBelow));
  }

  async function setOpen(next: boolean, focusSelected = false) {
    if (disabled) return;
    open = next;
    if (!open) return;
    updatePlacement();
    if (!focusSelected) return;
    await tick();
    const buttons = optionButtons();
    const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
    buttons[selectedIndex]?.focus();
  }

  function optionButtons() {
    return [...(root?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
  }

  function choose(next: string) {
    value = next;
    onValueChange(next);
    open = false;
    void tick().then(() => trigger?.focus());
  }

  function handleTriggerKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      void setOpen(true, true);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      open = false;
    }
  }

  function handleOptionsKeydown(event: KeyboardEvent) {
    const buttons = optionButtons();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = Math.min(buttons.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      open = false;
      void tick().then(() => trigger?.focus());
      return;
    } else return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  function handleDocumentPointerDown(event: PointerEvent) {
    if (open && !root?.contains(event.target as Node)) open = false;
  }

  function handleWindowResize() {
    if (open) updatePlacement();
  }

  document.addEventListener("pointerdown", handleDocumentPointerDown);
  window.addEventListener("resize", handleWindowResize);
  onDestroy(() => {
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
    window.removeEventListener("resize", handleWindowResize);
  });
</script>

<div class="custom-select" class:open class:open-above={openAbove} bind:this={root}>
  <button
    class="custom-select-trigger"
    type="button"
    bind:this={trigger}
    {disabled}
    aria-label={ariaLabel}
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={() => void setOpen(!open)}
    onkeydown={handleTriggerKeydown}
  >
    <span>{selectedLabel}</span>
    <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
  </button>
  {#if open}
    <div
      class="custom-select-options"
      role="listbox"
      tabindex="-1"
      aria-label={ariaLabel}
      style={`max-height: ${menuMaxHeight}px`}
      onkeydown={handleOptionsKeydown}
    >
      {#each options as option (option.value)}
        <button
          type="button"
          role="option"
          class:active={option.value === value}
          aria-selected={option.value === value}
          onclick={() => choose(option.value)}
        >
          <span>{option.label}</span>
          {#if option.value === value}
            <span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .custom-select {
    position: relative;
    min-width: 0;
  }

  .custom-select-trigger {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20px;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 38px;
    padding: 0 10px;
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
    color: var(--color-text);
    background: var(--color-black);
    text-align: left;
  }

  .custom-select-trigger > span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .custom-select-trigger :global(.app-icon) {
    color: var(--color-text-dim);
    font-size: 19px;
    transition: transform 100ms ease;
  }

  .open .custom-select-trigger {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px rgba(142, 203, 255, 0.18);
  }

  .open .custom-select-trigger :global(.app-icon) {
    transform: rotate(180deg);
  }

  .custom-select-trigger:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .custom-select-options {
    position: absolute;
    z-index: 120;
    top: calc(100% + 5px);
    right: 0;
    left: 0;
    display: grid;
    gap: 2px;
    min-width: 100%;
    padding: 5px;
    overflow-x: hidden;
    overflow-y: auto;
    border: 1px solid var(--color-border-strong);
    border-radius: 7px;
    background: #111315;
    box-shadow: 0 16px 34px rgba(0, 0, 0, 0.48);
  }

  .open-above .custom-select-options {
    top: auto;
    bottom: calc(100% + 5px);
  }

  .custom-select-options button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 18px;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 6px 8px;
    border-radius: 5px;
    color: var(--color-text-muted);
    background: transparent;
    text-align: left;
  }

  .custom-select-options button > span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .custom-select-options button:hover,
  .custom-select-options button:focus-visible,
  .custom-select-options button.active {
    color: var(--color-text);
    background: var(--color-surface-3);
    outline: none;
  }

  .custom-select-options button.active :global(.app-icon) {
    color: var(--color-accent);
    font-size: 17px;
  }
</style>
