<script lang="ts">
  // Native screen-share popout resize handles. The handle layout is static
  // chrome; resize behavior lives in ScreenShareTransportController.
  import type { ScreenShareTransportController } from "../lib/screen-share-transport.svelte";

  let {
    transport
  }: {
    transport: ScreenShareTransportController;
  } = $props();

  type ScreenSharePopoutResizeDirection =
    | "North"
    | "NorthEast"
    | "East"
    | "SouthEast"
    | "South"
    | "SouthWest"
    | "West"
    | "NorthWest";
  const screenSharePopoutResizeHandles: Array<{ direction: ScreenSharePopoutResizeDirection; className: string }> = [
    { direction: "North", className: "north" },
    { direction: "NorthEast", className: "north-east" },
    { direction: "East", className: "east" },
    { direction: "SouthEast", className: "south-east" },
    { direction: "South", className: "south" },
    { direction: "SouthWest", className: "south-west" },
    { direction: "West", className: "west" },
    { direction: "NorthWest", className: "north-west" }
  ];
</script>

{#each screenSharePopoutResizeHandles as handle}
  <div
    class={`screen-share-popout-resize-handle ${handle.className}`}
    aria-hidden="true"
    onmousedown={(event) => transport.startScreenSharePopoutWindowResize(handle.direction, event)}
  ></div>
{/each}
