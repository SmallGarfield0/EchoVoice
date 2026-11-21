# EchoVoice P2P 打洞与媒体路径优化研究

研究时间：2026-07-29（Asia/Hong_Kong）
研究范围：语音、屏幕共享、伴奏等实时媒体的 NAT 穿透现状、降低延迟与减轻服务器流量的可行改造
结论定位：现状是「已 P2P 优先 + 自建 TURN 兜底」，服务器当前**不转发任何媒体**；真正待解决的瓶颈不是「要不要打洞」，而是**路径不可观测**、**打洞成功率未优化**、以及**mesh 拓扑在上行带宽与信令上的 O(N²) 放大**。

---

## 1. 结论摘要

| 编号 | 结论 | 影响 |
| --- | --- | --- |
| C1 | 媒体已经是 P2P 直连优先，TURN 只在直连失败时被动生效；EV Server 进程本身不承载媒体字节 | 「接入 P2P」不是从零开始，而是**优化既有 ICE 成功率与可观测性** |
| C2 | 客户端从未读取 ICE 选中的 candidate pair 类型，无法知道任何一条会话是直连还是中继 | 无法量化「服务器流量压力」，所有优化都无法验收 |
| C3 | 服务端 TURN 只监听 `udp4`/`tcp4`，`resolveIPv4` 明确拒绝 IPv6；`turn:`/`stun:` 只公布 IPv4 字面量地址 | 放弃了**最高性价比的打洞手段**：双栈 IPv6 直连 |
| C4 | 未设置 `iceCandidatePoolSize`，所有 PeerConnection 都是「用到了才开始收集候选」；原生端候选回传还额外有 35 ms 批量刷新间隔 | 每次首连多付 1 个 RTT 的候选收集与信令时间 |
| C5 | 语音与屏幕共享使用**两条独立 PeerConnection**（分别以 `participant_id` 与 `member_id` 为键） | 同一对端两套 ICE/DTLS/分配，信令与 allocation 数量翻倍 |
| C6 | 屏共享原生发送端已做到**单次编码、多观看者共享码流**（`media_queue` 扇出），Web 端由浏览器共享 track 编码 | 编码侧不是主要瓶颈，瓶颈在上行带宽与拓扑 |
| C7 | TURN 中继的服务器带宽成本随观看人数**线性增长且不可拆分**；SFU 是 O(发布者) 量级 | ≥4 人频道里 SFU 比 TURN 更省服务器流量，是「减压」的结构性答案 |
| C8 | mesh 下服务器仍需转发 O(N²) 量级的 WSS 信令（offer/answer/ICE），这是服务器 CPU/流量压力中**被忽视但真实**的一项 | 拓扑改造同时降低信令压力 |

一句话建议：**先做 C2 的可观测性（可度量），再做 C3/C4 的打洞增强（可提升直连率），最后用 C5/C7 动拓扑（真正减压）。**

---

## 2. 现状实测：媒体是怎么走的

### 2.1 信令面（服务器唯一真正承载的实时流量）

- 客户端加入语音后，通过事件 WebSocket 发送 `rtc.signal`；服务端在
  `services/ev-server/internal/api/router.go:5122` 的 `handleClientEvent` 中处理。
- 服务端**不解析 SDP**，只做定向转发（`router.go:5173`–`5225`）：有 `target_participant_id` /
  `target_member_id` 时投递给指定设备，否则向同频道所有其他参与者扇出。
- 转发前会校验发送方与目标方都在同一语音频道（`router.go:5156`、`5182`），并补齐
  `from_participant_id` / `target_participant_id`。这是一条重要的安全边界：
  **任意两名成员不能绕过频道关系直接对拉媒体**。
- `rtc.signal` 与 `voice.speaking.updated` 走独立优先队列（`services/ev-server/internal/ws/hub.go:145`），
  不会被在线状态、审计等普通事件阻塞。信令路径本身的设计是合理的。
- 未送达的屏幕共享信令会短暂入队（`router.go:5201`），用于观看者尚未上线的情况。

### 2.2 ICE / NAT 穿透面

- ICE 配置由 `GET /api/v1/rtc-config` 下发（`services/ev-server/internal/api/router.go:863`）：
  - `rtc.stun_urls`（默认空）逐条下发为无凭证的 STUN；
  - `rtc.turn.enabled` 时追加**一个** `RTCIceServer`，其 `urls` 同时包含
    `stun:<host:port>`、`turn:<host:port>?transport=udp`，以及可选的 `?transport=tcp`；
  - 凭证是 Pion 的长期凭证 REST 形式，TTL **2 小时**，身份取 `memberId.shortDeviceId`
    （`router.go:875`），`AuthSecret` 仅存内存（`config.go` 中 `yaml:"-"`）。
- 客户端把这份配置原样交给 `RTCPeerConnection`：`apps/desktop/src/App.svelte:2911`
  的 `browserRTCConfiguration()` **只设置 `iceServers`**，其余字段全部走默认值。
- 原生（Rust）路径同源：`apps/desktop/src-tauri/src/rtc_config.rs:15` 把同一份 ICE 列表
  映射成 Pion 风格的 `RTCConfiguration`，并 `..Default::default()`。
- 结论：**没有 `iceTransportPolicy: "relay"` 之类的强制中继设置**，浏览器/Pion 都会先用
  host/srflx 候选尝试直连，TURN 只是最后手段。也就是说，当前架构已经是「P2P 优先」。

### 2.3 媒体面拓扑

- 语音：`apps/desktop/src/lib/voice-session.svelte.ts:840` 以 `participant_id` 为键，
  为**每一个其他参与者**建立一个 `RTCPeerConnection` —— 标准 full mesh。候选人发送见 `:846`，
  音频接收与抖动缓冲调参见 `:849`（`jitterBufferTarget = 60`、`playoutDelayHint = 0.06`）。
- 屏幕共享：`apps/desktop/src/lib/screen-share-transport.svelte.ts:1531` 以 `member_id` 为键
  **另建**一套 `RTCPeerConnection`，并单独做码率/帧率/降级偏好协商（`:1376`–`:1432`）。
- 原生屏共享发送端：`apps/desktop/src-tauri/src/main.rs` 的 `viewers` map（`:1283`）为每个观看者
  建 PeerConnection，但 `:2246`–`:2252` 把**同一份已编码 H.264 sample 推给所有观看者的
  `media_queue`**，即单编码器 + 多路发送，编码侧不存在 O(N²)。
- 原生语音：`apps/desktop/src-tauri/src/native_voice.rs:2163` 同样是对端级 PeerConnection，
  候选经 `on_ice_candidate`（`:2213`）推入出站队列，再由前端每 35 ms 批量
  `drainNativeVoiceSignals` 刷出（`native-voice.svelte.ts:276`）。

### 2.4 服务器媒体中继现状

- `services/ev-server/internal/mediarelay/turn.go` 启动的是**纯 TURN 服务器**：
  `net.ListenPacket("udp4", ...)`、`net.Listen("tcp4", ...)`，relay 地址由
  `RelayAddressGeneratorPortRange` 限定在 `relay_min_port`–`relay_max_port`（默认 49160–49200）。
- 服务器进程既不解析 RTP，也不做 SFU/混流。`services/ev-server/go.mod` 里有 Pion 的
  `turn`、`stun`、`transport`，**但没有引入 `pion/webrtc` 或 `pion/sfu`**，所以「加 SFU」需要新增依赖。
- 因此「服务器流量压力」目前**只可能**来自两个地方：
  1. WSS 信令（O(N²) 条 offer/answer/ICE）；
  2. 被 TURN 中继的媒体字节（每个被中继的对端 = 服务器上行 + 下行各一份码流）。

---

## 3. 差距分析

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| P2P 直连优先 | 已有（默认 ICE 策略） | 无 |
| STUN 提供 srflx 候选 | 借用内置 TURN 同端口的 STUN | 端口被单独封禁时连 srflx 都拿不到 |
| IPv6 直连 | **完全缺失**（服务端只 v4，公告也只 v4） | C3 |
| UPnP / NAT-PMP 端口映射 | 无 | C3 备选 |
| 候选预热 / 提前收集 | 无 `iceCandidatePoolSize` | C4 |
| 候选交换延迟 | 浏览器即时；原生 35 ms 批 | C4 |
| 直连 vs 中继可见性 | 无（只统计 RTT/码率丢包，`voice-session.svelte.ts:233`） | **C2，最优先** |
| 中继流量服务端计量 | 无任何 TURN 计量 | C2 |
| ICE 重启 / 网络切换恢复 | 只做「失败后 1.2 s 重建 PeerConnection」（`:907`） | 缺 `restartIce()` 与网络变化监听 |
| 单一 PeerConnection 承载音视频 | 无（语音、屏共享各一条） | C5 |
| 大频道带宽模型 | full mesh + TURN | C7 |

---

## 4. 改进项：优先级从高到低

### P0 观测性：先把「打洞成功率」变成可测量的数

没有这一层，后面所有优化都无法证明有效，也无法回答「服务器流量降了多少」。

1. 客户端路径可见性
   - 在 `voice-session.svelte.ts:229` 的 `measureRTCStats` 里，除现有 `candidate-pair` 的
     `currentRoundTripTime` 外，同时解析 `localCandidateId` / `remoteCandidateId`，
     再在 `local-candidate` / `remote-candidate` 报告中取 `candidateType`。
   - 增加字段（例如 `pathKind: "direct" | "relay" | "unknown"`、`localCandidateType`、
     `remoteCandidateType`、`protocol`、`relayProtocol`）到现有网络诊断状态与
     `voice-peer-health.ts` 的健康判定，并在语音频道网络诊断区展示「直连 / 中继」标签。
   - 屏幕共享复用同一套解析：`screen-share-transport.svelte.ts:1669` 附近已经在遍历
     `candidate-pair` 取 `bytesSent`，顺带取候选类型即可，成本几乎为零。
   - 原生端可用 `webrtc::stats::StatsReportType`（`native_voice.rs:33` 已导入）取同样信息，
     通过现有 `native_voice_status` 返回新增字段，保持 Web 与桌面语义一致。
2. 服务端中继计量
   - 在 `mediarelay.Start` 中为每个 allocation 包装 `net.PacketConn` 统计中继字节，
     或在 Pion TURN 的事件回调上统计 allocation 数、创建/销毁时间、来源 IP 归属。
   - 暴露只读诊断（建议挂到管理控制台 `services/ev-server/internal/adminconsole/console.go`
     的既有只读面，或新增 `GET /api/v1/admin/media-diagnostics`，权限沿用现有管理权限），
     输出：当前 allocation 数、中继上下行字节速率、按频道聚合的中继会话数（若可将来源 IP
     关联到语音状态则更佳；至少提供总量）。
   - 客户端路径可见性 + 服务端 allocation 计量两者结合，才能给出「直连率」这个北极星指标。
3. 验收标准
   - 局域网双机：应稳定报告 `direct`（host 候选）；
   - 双 NAT：应报告实际结论，并在中继时明确显示；
   - 在部署文档（`docs/deployment/EchoVoice部署文档.md` 第 379 行起）补充：如何用诊断面板
     判断「听不到声音」是打洞失败还是 TURN 未放行。

### P1 打洞成功率增强（不改拓扑、可增量上线）

### P1.1 双栈 IPv6：最高性价比

大量家宽已具备公网 IPv6，此时双方**无需 TURN、无需中继**即可直连，且路径最短。

- 服务端：`mediarelay/turn.go` 中增加 `udp6`/`tcp6` 监听；`resolveIPv4`（`turn.go:93`）
  扩展为可返回 v4+v6 列表，`RelayAddressGeneratorPortRange` 的 `RelayAddress` 需按监听族分别设置。
- 配置：`rtc.turn` 增加可选的 `public_host_v6`（无则退回仅 v4），`config.go` 的
  `TURNConfig` 增字段并在校验中保持「不配置即不启用」的安全默认。
- `router.go:884` 的 `hostPort` 拼接改为分别公告 `stun:`/`turn:` 的 v4 与 v6 URL
  （IPv6 必须写成 `turn:[2001:db8::1]:3478?transport=udp`）。
- 客户端无需改动：`browserRTCConfiguration` 原样下发即可，浏览器会自行尝试 v6 候选；
  原生端 Pion 默认 `network_types` 已包含 UDP4/UDP6/TCP4/TCP6。
- 服务器不一定具备 IPv6：即使 EV Server 只有 v4，只要**两个客户端**都有公网 v6，
  host 候选即可直连——所以也可以完全不动服务端，只依赖客户端的 v6 host 候选，
  但这要求客户端不处于「浏览器 mDNS 混淆」状态；桌面原生端不受 mDNS 限制。
- 防火墙文档需同步补充 `3478/tcp+udp` 的 v6 放行。

### P1.2 候选预热与候选交换延迟

- `browserRTCConfiguration()`（`App.svelte:2911`）增加 `iceCandidatePoolSize: 2`。
  注意该参数必须在**创建** PeerConnection 时设置才生效，因此还要在加入语音频道前
  预热一个空闲连接以触发收集。
- 浏览器侧候选已即时发出（`voice-session.svelte.ts:846`），无需改动。
- 原生侧把 `flushNativeVoiceSignals` 的固定 35 ms 轮询（`native-voice.svelte.ts:276`）
  改为事件驱动：`on_ice_candidate` 拿到 host/srflx 候选时立即刷新，仅对高产生速率的候选做批量。
  该项改动落在 Tauri 侧，需遵守本仓库 Rust 质量门（`cargo fmt --all -- --check` + 相关测试）。
- 更激进但收益明确的选项：先在无 TURN 凭证的情况下直接 `createOffer`（预热收集），
  待 srflx/relay 候选到达后通过 ICE restart 或新增候选补齐，可把首连时间再压一个 RTT。
  代价是信令次数上升，属于可选优化。

### P1.3 网络切换与 ICE 重启

现状是连接 `failed` 后 1.2 s 重建整个 PeerConnection（`voice-session.svelte.ts:907`），
这会重建 DTLS、重建 transceiver、重新协商码率，表现为明显卡顿。

- 改为优先 `connection.restartIce()`（或 `createOffer({ iceRestart: true })`），
  保留同一 PC 与 DTLS 会话，切换 Wi-Fi/4G、VPN 上下线场景的恢复时间与抖动都会更好。
- 通过 `navigator.connection` 的 `change` 事件与（桌面端）网络状态变化触发；
  切换前先判定当前选中候选对是否失效，避免无谓重协商。
- 原生端对应 Pion 的 `restartIce` 路径。

### P1.4 NAT 端口映射

- 为客户端引入 UPnP/NAT-PMP（桌面端）：在对称 NAT 之外，这是少数能**从根上**把
  「必须中继」变成直连的手段。
- 浏览器端受沙箱限制无法实现，因此该能力只能改善桌面客户端之间，以及桌面↔浏览器（桌面侧映射）的通话。

### P1.5 独立 STUN 公告

- 目前只公布内置 TURN 同端口的 `stun:`。若运维出于安全考虑只放行 TURN TCP 回退而封禁
  UDP/TCP 3478，客户端会**连 srflx 候选都collect不到**，直连率归零。
- 配置层已支持 `rtc.stun_urls`，建议在示例配置（`services/ev-server/configs/ev-server.example.yaml`）
  中补充说明与自建/公共 STUN 二选一建议，并明确「公网部署至少要有一个可达的 STUN 或 TURN 端口」。

### P2 结构性减压（真正降低服务器流量）

### P2.1 音视频合并到单条 PeerConnection

- 现在语音一条、屏共享一条（`voice-session.svelte.ts:840` 与
  `screen-share-transport.svelte.ts:1531`）。合并为每对端一条 bundled 连接后：
  - ICE 分配、DTLS 握手、候选收集数量减半；
  - 屏幕共享开始时不再新增 allocation，也不再需要一整套 `screen-share-*` 信令往返；
  - 服务器 WSS 信令量同步下降。
- 主要风险是「按需订阅」语义：观看者才应收到视频轨。需要把观看者集合映射到
  transceiver 方向（`sendonly`/`recvonly` 切换）而不是靠独立连接隔离。
  建议保留现有独立连接路径作为回滚开关，先在新版本中做灰度和浏览器回归
  （`npm --prefix apps/desktop run test:screen-share-browser`）。

### P2.2 大频道引入 SFU（服务器带宽的解药）

带宽模型对比（`n` 为发布者数，`v` 为观看者数，`b` 为单路码率）：

- full mesh：每客户端上行 O(n·b)，服务器流量 0；
- 纯 TURN 中继：**服务器**上下行 ≈ O(v·b) 且**无法拆分/选择**（中继是字节级转发）；
- SFU：服务器≈ O(n·b) 下行 + 少量上行，且可按观看者做层选择、丢包重传与带宽自适应。

因此在「1 个共享者 + 4 个观看者」这种常见场景里，**SFU 比 TURN 中继更省服务器流量**，
而且延迟可控（单跳转发）。这也是设计文档 `docs/architecture/EchoVoice项目设计文档.md:517`–`524`
原本设想的「轻量 SFU」，实现阶段被 mesh 取代但没有留下决策记录。

落点建议：

- 服务端：`go.mod` 增加 `github.com/pion/webrtc/v4` 与 `github.com/pion/sfu`（或自研精简转发），
  在 `internal` 下新增 `internal/mcurelay` 或 `internal/sfu` 包，与 `mediarelay` 并列启动。
- 协议：`domain.RTCSignal` 增加会话/拓扑字段（如 `peer_scope: "peer" | "server"`，
  `session_id`），使目标从「某成员」扩展为「服务器媒体节点」；`router.go:5174` 的定向分支
  增加对应路由。设计文档 `:1012` 已有 `relay_mode: p2p/server_sfu/turn` 的字段构想，可直接落地。
- 客户端：`ensurePeerConnection` 支持「对端 = 服务器」模式；`browserRTCConfiguration` 同一份 ICE 配置可用。
- 切换策略建议：≤3 人保持全 mesh（延迟最低、服务器零媒体流量）；≥4 人自动切 SFU，
  并在设置中暴露可手动覆盖的开关与 Tooltip 说明（遵守 AGENTS.md 的 i18n 与控件规范）。
- 注意：SFU 一旦承载媒体，服务器带宽就从「按需中继」变成「常态转发」，
  因此**必须与 P0 的计量一起上线**，否则容量规划无从谈起。

### P3 更长远（仅记录，不建议现在做）

- 跨 EV Server 的私下语音 P2P 与去中心化信令（`项目设计文档` 第 6 章、第 315 行起的路线）：
  依赖 home relay / StarEcho 做信令发现，属于 Phase 6 之后的范围。
- 客户端互助中继（借用户闲置上行代转发）：能进一步省服务器流量，但需要信任模型、
  计费/配额和滥用防护，收益/复杂度比不划算，明确列为**不建议**。
- 完全零服务器的纯 DHT 信令：与「自托管轻中心化」的产品定位冲突，不作为方向。

---

## 5. 必须同时守住的边界

1. **权限与审计不能因 P2P 而失效**：服务器静音、服务器禁听、踢出语音、频道权限复核、
   语音时长统计等都必须继续走服务端权威路径。当前这些能力都建立在「加入语音频道后才允许
   交换信令」（`router.go:5156`/`5182`）之上，任何新增的媒体节点路由都必须复用同一套校验，
   不能出现「已离开频道仍能直连媒体」的旁路。
2. **媒体加密不降级**：直连与 TURN 中继都使用 DTLS-SRTP。若引入 SFU，服务器将能看到明文媒体，
   这属于**隐私边界的实质变化**，必须写入部署与产品说明，并提供「仅 P2P/中继、不用 SFU」的
   服务器级开关。
3. **不引入静默降级**：AGENTS.md 明确禁止「静默改变请求的媒体质量或用户权限」。
   SFU 切换、码率下调、路径从直连退化为中继，都应在网络诊断里可见，必要时提示用户。
4. **跨平台一致**：Web 端无法做 UPnP/mDNS 之外的能力，且 Web 必须继续可用（除非明确标记
   desktop-only）。新增的直连能力在 Web 上不可用时，必须显示为「不可用 + 原因」而不是隐藏。
5. **信令速率限制**：候选与重协商会产生额外信令，需沿用/新增服务端限流，
   避免新的打洞策略被滥用为信令放大攻击面。

---

## 6. 建议的执行顺序与验收

| 阶段 | 内容 | 主要落点文件 | 验收 |
| --- | --- | --- | --- |
| 1 | 路径可见性 + 中继计量（P0） | `voice-session.svelte.ts`、`screen-share-transport.svelte.ts`、`voice-peer-health.ts`、`mediarelay/turn.go`、`adminconsole/console.go` | 双机在局域网/双 NAT/TURN 三种网络下都能正确显示 direct/relay；服务端能给出中继字节数 |
| 2 | IPv6 双栈公告（P1.1） | `mediarelay/turn.go`、`api/router.go`、`config/config.go`、示例配置与部署文档 | 双 v6 客户端不产生 allocation；v4-only 部署行为不变 |
| 3 | 候选预热 + 原生候选即时刷新 + ICE 重启（P1.2/P1.3） | `App.svelte`、`native-voice.svelte.ts`、`native_voice.rs` | 首连时间下降；Wi-Fi 切换不再重建 PeerConnection；`cargo fmt --all -- --check` 与相关 Rust 测试通过 |
| 4 | 音视频合并单连接（P2.1） | `voice-session.svelte.ts`、`screen-share-transport.svelte.ts`、`main.rs` | 屏共享期间 allocation 数不再翻倍；`test:screen-share-browser`、`test:workspace-browser` 通过 |
| 5 | 大频道 SFU 与自动切换（P2.2） | `internal/sfu/*`、`domain`、`api/router.go`、客户端协商 | ≥4 人场景服务器媒体流量与端到端延迟对比 TURN 中继有量化改善；≤3 人保持 mesh |

回归要求（遵循 AGENTS.md 质量门）：

```powershell
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:workspace-browser
npm --prefix apps/desktop run test:screen-share-browser
cd services/ev-server; go test ./...
cd ../..; cargo test
```

媒体路径属于「共享语音、屏幕共享、实时状态」范畴，任何一项改动都必须同时验证桌面（原生 Tauri）
与 Web 两条路径。

---

## 7. 关键代码索引

| 主题 | 位置 |
| --- | --- |
| ICE 配置下发 | `services/ev-server/internal/api/router.go:863`–`896` |
| 信令转发与频道校验 | `services/ev-server/internal/api/router.go:5122`–`5226` |
| 信令优先队列 | `services/ev-server/internal/ws/hub.go:95`–`154` |
| 内置 TURN / UDP4-only | `services/ev-server/internal/mediarelay/turn.go:19`–`113` |
| TURN 配置结构 | `services/ev-server/internal/config/config.go`（`RTCConfig` / `TURNConfig`） |
| 浏览器 ICE 配置（唯一入口） | `apps/desktop/src/App.svelte:2911`–`2919` |
| 语音 mesh 与统计 | `apps/desktop/src/lib/voice-session.svelte.ts:219`–`266`、`825`–`935` |
| 屏幕共享独立 PeerConnection | `apps/desktop/src/lib/screen-share-transport.svelte.ts:1521`–`1571` |
| 原生语音 ICE | `apps/desktop/src-tauri/src/native_voice.rs:2163`、`2213`、`2384` |
| 原生 ICE 配置映射 | `apps/desktop/src-tauri/src/rtc_config.rs:15`–`27` |
| 原生屏共享单编码多观看者 | `apps/desktop/src-tauri/src/main.rs:1283`、`2246`–`2252` |
| 原生候选 35 ms 批刷 | `apps/desktop/src/lib/native-voice.svelte.ts:250`–`276` |

---

## 8. 本次研究未验证的事项

以下内容为代码与文档层面的推断，**尚未做真实网络实验**，实施前需要实测确认：

1. 各种 NAT 组合下的实际直连率（尤其国内运营商 CGNAT 与对称 NAT 占比），
   这决定 P1 各项优化的收益上限；
2. 内置 TURN 同端口 STUN 在真实公网下的 srflx 采集成功率；
3. 原生 Pion 客户端在双栈环境下的候选收集行为；
4. SFU 与 TURN 中继在真实带宽受限场景下的服务器流量与延迟对比数据；
5. 现网部署中 TURN 端口的实际放行情况（多数「听不到声音」案例的根因）。
