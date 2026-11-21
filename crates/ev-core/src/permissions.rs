use ev_protocol::{Permission, PermissionSet};

#[derive(Debug, Clone, Default)]
pub struct PermissionInput {
    pub is_owner: bool,
    pub base_allow: PermissionSet,
    pub role_allow: PermissionSet,
    pub channel_allow: PermissionSet,
    pub channel_deny: PermissionSet,
}

pub fn can(input: &PermissionInput, permission: Permission) -> bool {
    if input.is_owner {
        return true;
    }

    if input.channel_deny.contains(permission) {
        return false;
    }

    input.channel_allow.contains(permission)
        || input.role_allow.contains(permission)
        || input.base_allow.contains(permission)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_bypasses_denies() {
        let input = PermissionInput {
            is_owner: true,
            channel_deny: PermissionSet::new(vec![Permission::SendMessages]),
            ..PermissionInput::default()
        };

        assert!(can(&input, Permission::SendMessages));
    }

    #[test]
    fn channel_deny_wins_for_non_owner() {
        let input = PermissionInput {
            role_allow: PermissionSet::new(vec![Permission::SendMessages]),
            channel_deny: PermissionSet::new(vec![Permission::SendMessages]),
            ..PermissionInput::default()
        };

        assert!(!can(&input, Permission::SendMessages));
    }
}
