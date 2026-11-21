<script lang="ts">
  export let value: number;
  export let min = 0;
  export let max = 100;
  export let step = 1;
  export let unit = "";
  export let disabled = false;
  export let ariaLabel = "";
  export let decreaseLabel = "Decrease value";
  export let increaseLabel = "Increase value";
  export let onValueChange: (value: number) => void = () => {};

  let editing = false;
  let draft = String(value);

  $: if (!editing) draft = String(value);

  function normalize(next: number) {
    const bounded = Math.max(min, Math.min(max, Number.isFinite(next) ? next : value));
    const precision = String(step).split(".")[1]?.length ?? 0;
    const stepped = min + Math.round((bounded - min) / step) * step;
    return Number(Math.max(min, Math.min(max, stepped)).toFixed(precision));
  }

  function applyValue(next: number) {
    const normalized = normalize(next);
    value = normalized;
    draft = String(normalized);
    onValueChange(normalized);
  }

  function updateDraft(event: Event) {
    draft = (event.currentTarget as HTMLInputElement).value;
    if (!draft.trim()) return;
    const next = Number(draft);
    if (Number.isFinite(next) && next >= min && next <= max) {
      value = next;
      onValueChange(next);
    }
  }

  function commitDraft() {
    editing = false;
    applyValue(Number(draft));
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      (event.currentTarget as HTMLInputElement).blur();
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      applyValue(value + (event.key === "ArrowUp" ? step : -step));
    }
  }
</script>

<div class="numeric-input" class:disabled>
  <button
    type="button"
    disabled={disabled || value <= min}
    aria-label={decreaseLabel}
    onclick={() => applyValue(value - step)}
  >
    <span class="material-symbols-rounded app-icon" aria-hidden="true">remove</span>
  </button>
  <input
    type="text"
    inputmode="numeric"
    role="spinbutton"
    value={draft}
    disabled={disabled}
    aria-label={ariaLabel}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    onfocus={() => editing = true}
    oninput={updateDraft}
    onblur={commitDraft}
    onkeydown={handleKeydown}
  />
  {#if unit}<span class="numeric-input-unit">{unit}</span>{/if}
  <button
    type="button"
    disabled={disabled || value >= max}
    aria-label={increaseLabel}
    onclick={() => applyValue(value + step)}
  >
    <span class="material-symbols-rounded app-icon" aria-hidden="true">add</span>
  </button>
</div>

<style>
  .numeric-input {
    display: grid;
    grid-template-columns: 30px minmax(52px, 1fr) auto 30px;
    align-items: stretch;
    width: max-content;
    min-width: 118px;
    height: 34px;
    overflow: hidden;
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
    color: var(--color-text);
    background: var(--color-black);
    transition: border-color 100ms ease, box-shadow 100ms ease, opacity 100ms ease;
  }

  .numeric-input:focus-within {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px rgba(142, 203, 255, 0.18);
  }

  .numeric-input.disabled {
    opacity: 0.48;
  }

  button {
    display: grid;
    place-items: center;
    width: 30px;
    min-width: 0;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 0;
    color: var(--color-text-muted);
    background: var(--color-surface-2);
  }

  button:first-child {
    border-right: 1px solid var(--color-border);
  }

  button:last-child {
    border-left: 1px solid var(--color-border);
  }

  button:hover:not(:disabled),
  button:focus-visible {
    color: var(--color-accent);
    background: var(--color-surface-3);
    outline: none;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.36;
  }

  button :global(.app-icon) {
    font-size: 16px;
  }

  input {
    width: 62px;
    min-width: 0;
    height: 32px;
    padding: 0 5px 0 8px;
    border: 0;
    color: var(--color-text);
    background: transparent;
    text-align: right;
    outline: none;
  }

  .numeric-input-unit {
    display: grid;
    place-items: center;
    min-width: 20px;
    padding-right: 6px;
    color: var(--color-text-dim);
    font-size: 11px;
    pointer-events: none;
  }
</style>
