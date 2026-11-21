use crate::{MemberId, ServerId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalProfilePayload {
    pub display_name: String,
    pub avatar_sha256: Option<String>,
    pub avatar_color: Option<String>,
    pub bio: String,
    pub local_profile_id: String,
    pub client_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectRequest {
    pub server_password: Option<String>,
    pub profile: LocalProfilePayload,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectResponse {
    pub server_id: ServerId,
    pub member_id: MemberId,
    pub access_key: Option<String>,
    pub session_token: String,
    pub is_owner: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionLoginRequest {
    pub server_id: ServerId,
    pub member_id: MemberId,
    pub access_key: String,
}
