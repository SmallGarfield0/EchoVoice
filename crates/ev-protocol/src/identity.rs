#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EvUserId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ServerId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MemberId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ChannelId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MessageId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DeviceId(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalIdentity {
    pub ev_user_id: EvUserId,
    pub public_key: String,
    pub display_name: String,
    pub avatar_sha256: Option<String>,
    pub avatar_color: Option<String>,
    pub home_relays: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityBinding {
    pub server_id: ServerId,
    pub member_id: MemberId,
    pub ev_user_id: EvUserId,
    pub public_key: String,
    pub signature: String,
}
