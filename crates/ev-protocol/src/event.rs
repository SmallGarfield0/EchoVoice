use crate::{Channel, ChannelId, EncryptedEnvelope, MemberId, Message};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerEvent {
    ServerUpdated,
    ChannelCreated(Channel),
    ChannelUpdated(Channel),
    ChannelDeleted(ChannelId),
    MemberJoined(MemberId),
    MemberUpdated(MemberId),
    MemberLeft(MemberId),
    MessageCreated(Message),
    MessageUpdated(Message),
    MessageDeleted(String),
    VoiceStateUpdated,
    PermissionUpdated,
    RtcSignal(String),
    FriendRequested(String),
    FriendAccepted(String),
    FriendRejected(String),
    DmEnvelopeReceived(EncryptedEnvelope),
    MailboxEnvelopeAvailable,
    PrivateCallInvited(String),
    PrivateCallAccepted(String),
    PrivateCallRejected(String),
    PrivateCallEnded(String),
    PrivateCallSignal(String),
}
