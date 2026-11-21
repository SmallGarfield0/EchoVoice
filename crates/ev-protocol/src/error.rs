use std::error::Error;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorCode {
    AuthInvalidKey,
    AuthServerPasswordRequired,
    AuthServerPasswordInvalid,
    PermissionDenied,
    ChannelNotFound,
    MemberNotFound,
    MediaDisabled,
    MediaDeviceUnavailable,
    RemoteControlDisabled,
    RemoteControlSuspended,
    ContentTooLarge,
    AssetHashMismatch,
    FileStorageDisabled,
    GlobalIdInvalid,
    FriendRequestBlocked,
    DmRelayDisabled,
    MailboxDisabled,
    EnvelopeTooLarge,
    CryptoVerifyFailed,
    PrivateCallUnavailable,
    RateLimited,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug)]
pub enum ProtocolError {
    InvalidId(String),
    PermissionDenied,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtocolError::InvalidId(id) => write!(f, "invalid identifier: {id}"),
            ProtocolError::PermissionDenied => write!(f, "permission denied"),
        }
    }
}

impl Error for ProtocolError {}
