use serde::Deserialize;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRTCIceServer {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential: String,
}

pub fn rtc_configuration(servers: &[NativeRTCIceServer]) -> RTCConfiguration {
    RTCConfiguration {
        ice_servers: servers
            .iter()
            .filter(|server| !server.urls.is_empty())
            .map(|server| RTCIceServer {
                urls: server.urls.clone(),
                username: server.username.clone(),
                credential: server.credential.clone(),
            })
            .collect(),
        ..Default::default()
    }
}
