<script lang="ts">
  import type { PermissionsController } from "../lib/permissions.svelte";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    permissions: PermissionsController;
    memberAvatarStyle: (memberIdValue: string) => string;
    setMenuElement: (element: HTMLDivElement | null) => void;
    onFlushAliases: () => void;
  };

  let {
    t,
    permissions,
    memberAvatarStyle,
    setMenuElement,
    onFlushAliases
  }: Props = $props();

  let menuElement = $state<HTMLDivElement | null>(null);

  $effect(() => {
    setMenuElement(menuElement);
    return () => setMenuElement(null);
  });

  function addTarget(type: "role" | "member", id: string) {
    permissions.addChannelPermissionTarget(type, id);
    onFlushAliases();
  }
</script>

{#if permissions.channelPermissionTargetPickerOpen}
<div
  bind:this={menuElement}
  class="channel-permission-target-menu"
  style={permissions.channelPermissionTargetMenuStyle}
  role="dialog"
  aria-label={t("channel.addPermissionTarget")}
>
  <label class="settings-search-field">
    <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
    <input
      value={permissions.channelPermissionSearch}
      placeholder={t("channel.searchRoleOrMember")}
      oninput={(event) => (permissions.channelPermissionSearch = (event.currentTarget as HTMLInputElement).value)}
    />
  </label>
  <div class="channel-permission-target-options">
    {#if permissions.filteredChannelPermissionRoles().length > 0}<p>{t("settings.tabRoles")}</p>{/if}
    {#each permissions.filteredChannelPermissionRoles() as role}
      <button type="button" onclick={() => addTarget("role", role.role_id)}>
        <span class="role-color-dot" style={`--role-color: ${role.color || "#9bdcff"}`}></span>
        <span>{role.name}</span>
      </button>
    {/each}
    {#if permissions.filteredChannelPermissionMembers().length > 0}<p>{t("members.title")}</p>{/if}
    {#each permissions.filteredChannelPermissionMembers() as member}
      <button type="button" onclick={() => addTarget("member", member.member_id)}>
        <span class="avatar member-avatar" style={memberAvatarStyle(member.member_id)}>{#if member.avatar_data_url}<img src={member.avatar_data_url} alt="" />{:else}{member.display_name.slice(0, 2).toUpperCase()}{/if}</span>
        <span>{member.display_name}</span>
      </button>
    {/each}
  </div>
</div>
{/if}
