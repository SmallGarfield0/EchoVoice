#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Permission {
    Administrator,
    ManageServer,
    ManageRoles,
    ManageChannels,
    ManageMembers,
    ViewAuditLog,
    ViewChannel,
    SendMessages,
    ManageMessages,
    MentionEveryone,
    ConnectVoice,
    Speak,
    MuteMembers,
    DeafenMembers,
    MoveMembers,
    CreateTemporaryVoice,
    PrioritySpeaker,
    ShareScreen,
    RequestRemoteControl,
    AcceptRemoteControl,
    PlayAccompaniment,
    PlaySoundboard,
    ManageServerSoundboard,
    ManageMediaSessions,
    SendEmoji,
    ManageServerEmoji,
    ViewFiles,
    UploadFiles,
    DownloadFiles,
    ManageFiles,
    UseServerDmRelay,
    UsePrivateVoiceRelay,
    UseHomeMailbox,
    ManageRelayService,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PermissionSet {
    permissions: Vec<Permission>,
}

impl PermissionSet {
    pub fn new(permissions: Vec<Permission>) -> Self {
        Self { permissions }
    }

    pub fn contains(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }

    pub fn insert(&mut self, permission: Permission) {
        if !self.contains(permission) {
            self.permissions.push(permission);
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = Permission> + '_ {
        self.permissions.iter().copied()
    }
}
