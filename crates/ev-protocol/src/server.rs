use crate::ServerId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSummary {
    pub server_id: ServerId,
    pub name: String,
    pub icon_sha256: Option<String>,
    pub screen_share_enabled: bool,
    pub remote_control_enabled: bool,
    pub accompaniment_enabled: bool,
    pub soundboard_enabled: bool,
    pub emoji_enabled: bool,
    pub file_storage_enabled: bool,
}

impl ServerSummary {
    pub fn local_default(server_id: ServerId) -> Self {
        Self {
            server_id,
            name: "EchoVoice Server".to_string(),
            icon_sha256: None,
            screen_share_enabled: false,
            remote_control_enabled: false,
            accompaniment_enabled: false,
            soundboard_enabled: false,
            emoji_enabled: false,
            file_storage_enabled: false,
        }
    }
}
