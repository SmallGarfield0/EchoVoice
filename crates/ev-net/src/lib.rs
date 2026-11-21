use ev_protocol::{ConnectRequest, ConnectResponse};
use std::error::Error;
use std::fmt;

#[derive(Debug)]
pub enum NetError {
    RequestFailed(String),
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NetError::RequestFailed(message) => write!(f, "request failed: {message}"),
        }
    }
}

impl Error for NetError {}

pub trait EchoVoiceClient {
    fn connect(&self, request: ConnectRequest) -> Result<ConnectResponse, NetError>;
}
