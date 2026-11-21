use crate::{ChannelId, EvUserId, MessageId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub message_id: MessageId,
    pub channel_id: ChannelId,
    pub author_id: EvUserId,
    pub content: String,
    pub created_at_ms: i64,
    pub edited_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedEnvelope {
    pub envelope_id: String,
    pub sender_ev_user_id: EvUserId,
    pub recipient_ev_user_id: EvUserId,
    pub sender_device_id: String,
    pub recipient_device_id: Option<String>,
    pub message_type: String,
    pub created_at_ms: i64,
    pub ciphertext: Vec<u8>,
    pub signature: String,
}
