use ev_protocol::{MemberId, ServerId};
use std::error::Error;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredServerCredential {
    pub server_id: ServerId,
    pub member_id: MemberId,
    pub address: String,
    pub display_name: String,
}

#[derive(Debug)]
pub enum StoreError {
    Unavailable(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Unavailable(message) => write!(f, "store unavailable: {message}"),
        }
    }
}

impl Error for StoreError {}

pub trait CredentialStore {
    fn list_servers(&self) -> Result<Vec<StoredServerCredential>, StoreError>;
    fn save_server(&mut self, credential: StoredServerCredential) -> Result<(), StoreError>;
}

#[derive(Default)]
pub struct MemoryCredentialStore {
    servers: Vec<StoredServerCredential>,
}

impl CredentialStore for MemoryCredentialStore {
    fn list_servers(&self) -> Result<Vec<StoredServerCredential>, StoreError> {
        Ok(self.servers.clone())
    }

    fn save_server(&mut self, credential: StoredServerCredential) -> Result<(), StoreError> {
        self.servers
            .retain(|existing| existing.server_id != credential.server_id);
        self.servers.push(credential);
        Ok(())
    }
}
