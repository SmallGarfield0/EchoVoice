use crate::ChannelId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelType {
    Category,
    Text,
    Voice,
    TemporaryVoice,
    Announcement,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Channel {
    pub channel_id: ChannelId,
    pub parent_id: Option<ChannelId>,
    pub kind: ChannelType,
    pub name: String,
    pub topic: Option<String>,
    pub position: i32,
}

impl Channel {
    pub fn text(channel_id: ChannelId, name: impl Into<String>, position: i32) -> Self {
        Self {
            channel_id,
            parent_id: None,
            kind: ChannelType::Text,
            name: name.into(),
            topic: None,
            position,
        }
    }
}
