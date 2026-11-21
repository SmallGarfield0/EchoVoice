use ev_protocol::{Channel, MemberId, ServerSummary};

#[derive(Debug, Clone)]
pub struct ServerSessionState {
    pub server: ServerSummary,
    pub self_member_id: MemberId,
    pub channels: Vec<Channel>,
    pub connected: bool,
}

impl ServerSessionState {
    pub fn new(server: ServerSummary, self_member_id: MemberId) -> Self {
        Self {
            server,
            self_member_id,
            channels: Vec::new(),
            connected: false,
        }
    }
}
