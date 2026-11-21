use ev_protocol::{EvUserId, GlobalIdentity};

pub fn ev_user_id_from_public_key_hash(hex_sha256: impl Into<String>) -> EvUserId {
    EvUserId(format!("ev_{}", hex_sha256.into()))
}

pub fn build_global_identity(
    public_key_sha256: impl Into<String>,
    public_key: impl Into<String>,
    display_name: impl Into<String>,
) -> GlobalIdentity {
    GlobalIdentity {
        ev_user_id: ev_user_id_from_public_key_hash(public_key_sha256),
        public_key: public_key.into(),
        display_name: display_name.into(),
        avatar_sha256: None,
        avatar_color: None,
        home_relays: Vec::new(),
    }
}
