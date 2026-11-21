import type { Member, Permission, ServerRole } from "./types";

export function hasEffectivePermission(
  permission: Permission,
  owner: boolean,
  member: Member | undefined,
  roles: ServerRole[],
  previewRoleId = ""
): boolean {
  if (previewRoleId) {
    const previewRole = roles.find((role) => role.role_id === previewRoleId);
    if (previewRole) {
      const everyone = everyoneRole(roles);
      return roleAllowsPermission(everyone, permission) || roleAllowsPermission(previewRole, permission);
    }
  }

  if (owner || member?.is_owner) return true;
  if (roleAllowsPermission(everyoneRole(roles), permission)) return true;
  return (member?.role_ids ?? []).some((roleId) =>
    roleAllowsPermission(roles.find((role) => role.role_id === roleId), permission)
  );
}

export function roleAllowsPermission(role: ServerRole | undefined, permission: Permission): boolean {
  if (!role) return false;
  if (role.permissions?.administrator || role.permissions?.[permission]) return true;
  if (permission === "view_files") {
    return Boolean(role.permissions?.download_files || role.permissions?.manage_files);
  }
  if (permission === "upload_files" || permission === "download_files") {
    return Boolean(role.permissions?.manage_files);
  }
  return false;
}

function everyoneRole(roles: ServerRole[]): ServerRole | undefined {
  return roles.find((role) => role.is_everyone || role.role_id === "everyone");
}
