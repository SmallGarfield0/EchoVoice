<script lang="ts">
  // Empty-workspace placeholder. The visibility condition stays in App.svelte
  // (legacy reactivity); this component is presentation-only.
  let { appContentIconURL } = $props();
</script>

<section class="no-server-content" aria-label="EchoVoice">
  <img src={appContentIconURL} alt="EchoVoice" />
</section>
