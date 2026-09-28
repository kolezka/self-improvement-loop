<!-- Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first. -->
<!-- Single line text input. -->
<script lang="ts">
  import { onMount } from "svelte";

  interface Props {
    value?: string;
    id?: string;
    type?: "text" | "search" | "password" | "url" | "email";
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    /** Monospace face, for paths, refs and ids. */
    mono?: boolean;
    /** Accessible name when no label wraps this input. */
    ariaLabel?: string;
    describedBy?: string;
    autocomplete?: "on" | "off";
    spellcheck?: boolean;
    /** Claim the focus once mounted. */
    autofocus?: boolean;
    /** The input itself, for a caller that has to reach the DOM node. */
    element?: HTMLInputElement | null;
    oninput?: (event: Event) => void;
    onchange?: (event: Event) => void;
    onkeydown?: (event: KeyboardEvent) => void;
  }

  let {
    value = $bindable(""),
    id,
    type = "text",
    placeholder,
    disabled = false,
    readonly = false,
    invalid = false,
    mono = false,
    ariaLabel,
    describedBy,
    autocomplete = "off",
    spellcheck = false,
    autofocus = false,
    element = $bindable(null),
    oninput,
    onchange,
    onkeydown,
  }: Props = $props();

  // No SvelteKit navigation hook here, so mount is the only time this needs to run.
  onMount(() => {
    if (autofocus) element?.focus();
  });
</script>

<input
  class="input"
  class:mono
  class:invalid
  {id}
  {type}
  {placeholder}
  {disabled}
  {readonly}
  {autocomplete}
  {spellcheck}
  aria-label={ariaLabel}
  aria-describedby={describedBy}
  aria-invalid={invalid ? "true" : undefined}
  bind:this={element}
  bind:value
  {oninput}
  {onchange}
  {onkeydown}
/>

<style>
  .input {
    width: 100%;
    height: 30px;
    padding: 0 var(--lv-space-2);
    border: 1px solid var(--lv-border-strong);
    border-radius: var(--lv-radius-md);
    background: var(--lv-surface-page);
    color: var(--lv-text-primary);
    font-size: var(--lv-text-13);
  }

  .input::placeholder {
    color: var(--lv-text-muted);
  }

  .input:hover:not(:disabled) {
    border-color: var(--lv-text-muted);
  }

  .input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .mono {
    font-family: var(--lv-font-mono);
    font-size: var(--lv-text-12);
  }

  .invalid {
    border-color: var(--lv-danger);
  }
</style>
