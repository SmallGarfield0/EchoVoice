# EchoVoice 网络传输层评审与优化建议

本文是对 `docs/development/EchoVoice_P2P打洞与媒体路径优化研究.md`（下称「原计划」）的评审，
以及对语音、屏幕共享、信令与中继实际实现的核对结果。目标与原计划一致：把 P2P 用到极致，
让语音与屏幕共享在公网、弱网、企业网下都足够流畅。

文中所有结论都标注了代码位置。未标注位置的是推断，已在句中说明。

## 0. 一句话结论

原计划的**方向和优先级是对的**，可以直接执行；但它把「打洞增强」当作主战场，而代码里
**最先咬人的是容量与生命周期**：默认 41 个中继端口的硬上限、2 小时就过期的 TURN 凭证、
以及 Web 屏幕共享「一个观看者一个编码器」的结构。建议在原计划前面插入两件事
（中继容量/凭证生命周期修复、Web 屏共享单编码器），否则 P1 提升的直连率会被这些硬边界吃回去。

## 1. 对原计划的评审

### 1.1 可以照做的部分

- 结论表 C1–C8 与代码一致。已逐条核对：C2（不读 candidate pair）、C3（`udp4`/`tcp4` + `resolveIPv4`）、
  C4（无 `iceCandidatePoolSize`、原生候选 35ms 轮询）、C5（语音与屏共享两条独立 PC）、
  C7（mesh + TURN 的 O(N²)）、C8（信令 O(N²)）全部成立。
- 「先可观测、再打洞、最后动拓扑」的顺序正确。没有 `pathKind` 之前，任何打洞优化都无法判断是否有效。
- 边界 5 条（权限不失效、加密不降级、不静默降级、跨平台一致、信令限流）都成立，尤其第 5 条现在是真实缺口（见 N5）。

### 1.2 需要修正的地方

| 原计划表述 | 核对结果 | 建议 |
| --- | --- | --- |
| P1.1「`turn.go` 加 `udp6`/`tcp6`、`resolveIPv4` 扩为 v4+v6」 | 方向对，但漏了一点：`relayGenerator` 只接受一个 `RelayAddress`（`services/ev-server/internal/mediarelay/turn.go:83-91`）。双栈必须**两套 generator + 两个 listener**，不能在同一 generator 里塞两个地址 | 拆成 `relayGeneratorV4`/`relayGeneratorV6`，各自带自己的 `PacketConnConfig` |
| C7「SFU 比 TURN 更省服务器流量」 | 成立，但口径要写清：mesh+TURN 的服务端进出各 N(N-1) 条流，SFU 是 ingress N + egress N(N-1)，约 2 倍差距，不是数量级 | 沟通时用「约 2×」而不是「大幅」 |
| P2.1「音视频合并单 PC」列为 P1.2 之后的第二步 | 合并的**真实收益**不是省两条 DTLS（那可以忽略），而是把中继 allocation 数量对半砍（见 N1）。它应该和容量问题绑在一起排期 | 放在「中继容量」之后立刻做，或者直接跳到屏共享 SFU |
| 「信令速率限制」列在边界条款里 | 代码里**完全没有**限流（全文 grep 无 `rateLimit`/`limiter`/`throttle`），且每个 `rtc.signal` 都会走一次全局锁 + 全客户端线性扫描 | 提升到 P0，和可观测性同批 |
| 原计划引用 `screen-share-transport` 的 `stopWebScreenShareSignalPolling` | 该轮询在当前代码里已不存在，只剩 `native-voice.svelte.ts` 的 35ms 定时器 | 执行阶段不要照文档删不存在的代码 |

### 1.3 计划未覆盖的缺口

原计划的 8 条结论都是「传输路径」视角，缺了「容量 / 生命周期 / 服务端扇出」三个视角，
正是 N1、N2、N4、N5 这四条。

## 2. 新发现（按影响排序）

### N1 中继并发上限是 41 个 PeerConnection，不是 41 个人

> **状态（2026-11-13）**：已修。默认端口范围改为 `49160-49460`（301 个），
> 实测单连接吞吐 565 Mbit/s、16 端口范围可接受 14 条分配后报 508。下面的分析保留作背景。

- 证据：默认 `relay_min_port: 49160` / `relay_max_port: 49200`（`services/ev-server/internal/config/config.go:119-120`），
  即 41 个端口；`RelayAddressGeneratorPortRange` 每分配一条中继就绑定一个端口（`turn.go:84-90`）。
- 关键点：**allocation 是按 PeerConnection 计的，不是按人计的**。Pion 对每个 ICE agent 的 Allocate 请求单独建 relay socket。
- 加倍因素：客户端同时拿到 `?transport=udp` 与 `?transport=tcp` 两个 TURN URL 时，
  会在两种传输上各建一条 allocation（表现为同时出现 relay/udp 与 relay/tcp 两个候选），
  所以实际端口压力约为 **PC 数 × 1~2**。这个倍数建议用阶段 0 的计量实测确认，不要按假设做容量规划。
- 于是满 mesh + 全员对称 NAT 时的数量（全客户端合计，按 1 倍计，2 倍时直接翻倍）：

  | 场景 | PeerConnection 总数 | 若全部走中继 |
  | --- | --- | --- |
  | 3 人纯语音 | 6 | 6 |
  | 6 人纯语音 | 30 | 30 |
  | 6 人 + 1 人屏共享（5 人观看） | 30 + 10 | **40（几乎打满 41）** |
  | 8 人 + 1 人屏共享 | 56 + 14 | 70（超出，后到的 allocation 失败） |

- 影响：`MaxRetries: 16` 之后 allocation 直接失败，该对端没有 relay 候选，表现为「能看见人、听不到声音」，
  和部署文档 §7.2 描述的故障现象完全一致。而且端口池按进程共享，**多频道互相挤占**。
- 建议（按成本排序）：
  1. 把默认池放大到 200+（`49160-49360`），并在 `config.go:296` 的校验里加「池小于 N 时 warn」；
  2. 部署文档 §7.2 把「范围越大承载越多」换成上面这张数量表；
  3. 真正的解药是 §3.C 的屏共享专用 SFU，以及原计划 P2.1 的合并单 PC——前者把中继 allocation 压到 1，
     后者能直接砍半。

### N2 TURN 凭证 2 小时过期，而配置只在进入工作区时取一次

- 证据：`turn.GenerateLongTermTURNRESTCredentials(..., 2*time.Hour)`（`services/ev-server/internal/api/router.go:875-879`）；
  客户端只在 `loadWorkspace` 里取一次（`apps/desktop/src/lib/workspace.svelte.ts:466`），此后不再刷新。
- 影响：超过 2 小时后**新建**的 PeerConnection 拿着过期凭证去 Allocate，被 401 拒绝，
  该对端拿不到 relay 候选。已在通话里的老连接不受影响（allocation 已建立），
  所以现象是「通话 2 小时后新进来的人永远听不到」，而且日志里什么也看不到。
  对 AGENTS.md 里「适合长时间运行」的产品方向是硬伤。
- 建议：
  1. TTL 改成可配置，默认 24h（短期凭证的价值是限权，不是限时）；
  2. 客户端在 `ensurePeerConnection` 前检查凭证年龄，超过 60 分钟先刷新 `/api/v1/rtc-config`；
  3. 监听 `icecandidateerror`（`errorCode 701` / `errorText` 含 401）→ 立即刷新凭证并重试一次。
     这条同时解决「TURN 密码错了 / 防火墙拦了」的诊断问题，比日志有效。

### N3 只有 3478/udp + 3478/tcp，没有 443 或 TLS 中继

- 证据：`turn.go:28`（`udp4`）、`turn.go:35`（`tcp4`），`router.go:884-888` 只拼 `stun:`/`turn:` 两组 IPv4 URL。
- 影响：大量企业网/校园网只放行 443 出站，`3478/tcp` 一样会被拦。这类网络下当前**唯一**的出路是用户自己开热点。
  这是「打洞率」之外的第二类失败，靠 ICE 参数调不出来。
- 建议：`rtc.turn` 增加 `tls_port` + 复用 `server.tls` 证书，起 `tls.NewListener` 并作为 `ListenerConfig` 交给 Pion；
  客户端 URL 追加 `turns:host:tls_port?transport=tcp`。
  注意 TURN/TLS 不能被普通的 HTTPS 反向代理接管（代理不转发 TURN 帧），必须单独端口或独立 IP，
  部署文档的防火墙表要同步加一行。

### N4 服务端扇出：全局锁 + 全量线性扫描 + 每 15 秒一次全服务器广播

- 证据：
  - `Hub.SendToDevice` 遍历 `h.clients` 全表，且持 `h.mu` 写锁（`services/ev-server/internal/ws/hub.go:191-202`）；
  - `Hub.Broadcast` 同样持写锁遍历全表，且**不按 `ServerID` 过滤**（`hub.go:156-163`），一台 EV Server 上多租户会互相收包；
  - `presence.heartbeat` 每次都 `TouchMember`（落库）**无条件** `Broadcast` 一次 `member.presence.updated`（`router.go:5126-5132`）；
  - 客户端主事件 socket 与语音专用 socket **各发一次** 15 秒心跳（`apps/desktop/src/lib/realtime.svelte.ts:647`、`:556`）。
- 影响：N 个在线用户时，presence 广播量约 2N²/15 条每秒，每个包都是完整 Member 对象；
  同时每个 `rtc.signal` 都要在写锁下扫一遍全表。clients 上百之后，信令延迟会被这类无关流量拉高，
  而这正是「语音卡一下」的典型来源。
- 建议：
  1. `Hub` 改成 `map[serverID]map[memberID]map[deviceID]*client` 二级索引，`SendToDevice` 变 O(1)，锁换成 `RWMutex`；
  2. `Broadcast(serverID, event)` 必须带租户；
  3. presence 只在 `Online` 真正翻转时广播（`TouchMember` 返回旧值比较）；
  4. 语音 socket 的心跳改成独立的轻量 `session.keepalive` 类型，不触发 presence 广播。

### N5 `rtc.signal` 没有任何限流，且未指定 target 时每包遍历全部语音状态

- 证据：`router.go:5122-5226` 全文无令牌桶/计数；无 target 时 `for _, state := range r.store.VoiceStates()`（`router.go:5218`）。
- 影响：一个失控客户端（重连风暴、`ice-candidate` 循环）就能把 CPU 打满，并且因为 `enqueueClientEvent`
  在队列满时**静默丢弃**（`hub.go:143-153`），受害的是同频道其他人的信令。
- 建议：按设备做令牌桶（如 120/s，burst 240），超限计数并写进 P0 的诊断面板；
  同时保证正常 ICE 抖动（一包一候选，单次协商约 20–40 包）不会被误伤。

### N6 Web 屏幕共享：N 个观看者 = N 条 PeerConnection = N 个独立编码器

- 证据：每个观看者一条连接（`screen-share-transport.svelte.ts:1531`），同一个 `track` 被逐条 `addTrack`
  （`:1327`、`:1367`），每条连接各自 `setParameters({ maxBitrate })`（`:1397`）。
- 影响：浏览器会为每条连接跑一个独立编码器。1080p60 + `auto` 码率时目标约 8.7 Mbps
  （`screenShareSettings.ts:122-128`：2.07 MP × 60 × 70000）。5 个观看者就是 **5 个 1080p60 编码器**，
  必然触发 `qualityLimitationReason: "cpu"`，表现为「所有人都掉帧」。
  这块比 TURN 带宽更致命，而且是 Web 独有的——原生是 1 次编码 + N 个 `ViewerMediaQueue` 扇出（`main.rs:2246-2265`）。
- 影响补充：原生虽是单编码，但用「所有观看者的 min(接收端估计)」定码率（`main.rs:1345-1357`），
  一个弱网观看者会把整个房间的画质拖下来，且无法针对单观看者降级。
- 建议：见 N7 的「屏共享专用 SFU」；短期至少做两件事：
  1. Web 端在 `mesh`（观看者 > 2）时把 `auto` 系数下调（例如 `bitsPerMegapixelFrame` 乘 0.6），
     并给 `maxFramerate` 加一档「观看者多时降到 30」；
  2. 原生把 min() 改成「按观看者分档」：只对低于阈值的观看者降级（后续可配合 SFU 分层）。

### N7 原生每对端一套 `MediaEngine` + `API` + 独立本地端口，且无 UDP mux

- 证据：`native_voice.rs:2152-2166` 每对端 `MediaEngine::default()` + `register_default_codecs` +
  `register_default_interceptors` + `APIBuilder::new()`；全仓无 `SettingEngine`/`ice_udp_mux`/`NetworkTypes` 引用（grep 无命中）；
  `rtc_config.rs` 只填 `ice_servers`。
- 影响：每个 PeerConnection 各自绑定本地 UDP 端口、各自做一次 STUN/TURN 探测。
  5 人频道 = 5 个本地端口 + 5 个 NAT 映射 + 5 个 TURN allocation。
  **NAT 映射不共享**意味着打洞成功率被逐条连接独立掷骰子，且 N1 的端口压力被放大 N 倍。
- 建议：
  1. 会话级共享一个 `Arc<SettingEngine>` + `Arc<API>`（顺带省掉每对端的编解码器注册开销）；
  2. 用 `SettingEngine::set_ice_udp_mux(UDPMuxDefault::new(UDPMuxParams::new(socket)))` 让所有连接共用一个本地端口，
     配合 `set_nat_1to1_ips` 在 UPnP 映射成功时把 host 候选改写成公网地址（原计划 P1.4 的正确落点）；
  3. 这条改动同时会显著缩短 `connectivity checking` 时间（候选对数量不变，但本地侧不再等待 N 个 socket 就绪）。

### N8 接收端抖动缓冲被写死 60ms，直连与中继用同一个值

- 证据：`voice-session.svelte.ts` 的 `ontrack` 与 `screen-share-transport.svelte.ts:484-498` 都设
  `jitterBufferTarget = 60`（否则 `playoutDelayHint = 0.06`）。
- 影响：`jitterBufferTarget` 是**目标延迟上限**，中继路径实测 RTT 82–106ms
  （`screen-share-troubleshooting.md:172`），丢包呈突发状，60ms 会把迟到包直接丢掉，听感是「断续/发闷」。
- 建议：拿到 pathKind 之后按路径分档——直连保持 60ms，中继给 120–150ms；
  屏共享视频可以更激进地留到 100ms。这条是纯收益、零架构改动，做完 P0 就能上。

### N9 连接失败后 1.2 秒整条 PC 重建，而不是 ICE restart

- 证据：`voice-session.svelte.ts:907-919`，`closePeerConnection` + `ensurePeerConnection`；
  全库无 `restartIce` / `iceRestart` 调用。
- 影响：整条重建意味着丢掉已建好的 DTLS、重新协商、重新挂接收端、抖动缓冲清零，
  用户听到的是一次明显的「咔哒 + 静音」，而且重建期间的要约与对端状态机容易撞车（现有 `participant_id`
  字典序裁决只是补丁）。
- 建议：`failed` 时先走 `createOffer({ iceRestart: true })`，对端正常 answer，保留 transceiver 与 `<audio>` 元素；
  连续 2 次 restart 仍失败再重建。`disconnected` 超过 6 秒（`voice-peer-health.ts` 已有阈值）也直接触发 restart，
  不要等 `failed`（Chrome 到 `failed` 可能十几秒）。

### N10 两处 `browserRTCConfiguration` 重复实现

- 证据：`voice-session.svelte.ts:1057-1065` 与 `App.svelte:2911-2919`。
- 影响：现在两者都只有 `iceServers`，没影响；一旦按 P1 加 `iceCandidatePoolSize`/`bundlePolicy`，
  漏改一处就会出现「语音走一套参数、屏共享走另一套」，是最难查的一类故障。
- 建议：动 P1 参数之前先合并成单一导出。

## 3. 优化方案

### A. P0——先让路径可见（1–2 天量级）

1. **客户端 pathKind**：`measureRTCStats()`（`voice-session.svelte.ts:219`）已经拿到了全量 stats，
   只需两段改动——先建 `id → report` 索引，再对 `nominated && state === "succeeded"` 的 pair
   读 `localCandidateId`/`remoteCandidateId`，取出两侧 `candidateType`、`protocol`、`relayProtocol`、`address`。
   归一成：

   ```
   "direct-host" | "direct-srflx" | "direct-prflx" | "relay-udp" | "relay-tcp" | "unknown"
   ```

   规则：任一侧是 `relay` → `relay-*`；否则取两侧里较弱的一档（host > srflx > prflx）。
   顺手记 `ipFamily`（地址含 `:` 即 v6）与 `bytesSent/bytesReceived`。

2. **原生对齐**：`refresh_network_stats`（`native_voice.rs:2546-2570`）现在只看 `current_round_trip_time`。
   对 nominated pair 再查一次 `StatsReportType::LocalCandidate`/`RemoteCandidate`，取 `candidate_type`
   与 `protocol` 填进 `NativeVoiceStatus`，字段名与 Web 端保持一致。

3. **UI 落点**：`UserStatusPanel.svelte:492-532` 的延迟详情块里加一行「路径：直连 / 中继(UDP)」+「本地候选：srflx」。
   注意该文件 `:239` 现在用的是原生 `title` 属性，新增内容不要跟着用 `title`（违反 AGENTS.md 的界面条款），
   应复用已有 popover 结构；文案走 i18n，`en-US` 与 `zh-CN` 同时加。

4. **服务端 TURN 计量**：Pion 没有现成计数器，但钩子很干净——包一层 `RelayAddressGenerator`：

   ```go
   func (g *countingGenerator) AllocatePacketConn(network string, requestedPort int) (net.PacketConn, net.Addr, error) {
       conn, addr, err := g.inner.AllocatePacketConn(network, requestedPort)
       if err == nil {
           g.stats.opened(network, addr)              // +1，记 peak
           conn = &countingPacketConn{PacketConn: conn, onClose: g.stats.closed}
       }
       return conn, addr, err
   }
   ```

   `AllocateConn` 同理。暴露 `Stats()` 为 `{udp, tcp, inUse, total, peak}`，接到
   `api.NewRouter` 或直接给 `adminconsole.New`（`cmd/ev-server/main.go:83`）加一个 `media` 命令。
   这一项直接把 N1 从「猜」变成「看」：`inUse / total` 就是中继容量的水位线。

5. **`icecandidateerror` 诊断**：在两条 PC 的构造处加监听，收集 `errorCode`/`errorText`/`address`，
   在诊断面板体现为「TURN 认证失败 / TURN 不可达 / STUN 无响应」。N2、N3 的现场排查全靠它。

### B. P1——把直连率做上去

按性价比排序，前三条建议一起做，因为它们共用同一次回归：

1. **移动端/企业网的命门：TURNS on 443**（N3）。收益最高、风险最低（只是多一个监听端口）。
2. **双栈 IPv6**（原计划 P1.1，按 1.2 的修正拆成两套 generator）。同城双栈家宽可以直接 host/srflx 直连，
   延迟比任何中继都低。
3. **Web 配置统一 + `bundlePolicy: "max-bundle"` + `iceCandidatePoolSize: 2`**（N10 + 原计划 P1.2）。
   `max-bundle` 的收益主要在屏共享那条 PC（视频 + 音频两条 m-line 合成一组连通性检查）；
   语音 PC 只有音频，收益有限，但两者共用同一份配置，一起改成本最低。
   pool 让首次 offer 少等一个 STUN RTT。改完必须跑 `test:screen-share-browser` 与 `test:workspace-browser`。
4. **原生共享 UDP mux + `set_nat_1to1_ips`**（N7），并接 UPnP/NAT-PMP（原计划 P1.4）。
   这是「极致 P2P」里唯一能救对称 NAT 的手段：端口映射成功即等价于公网主机。
   桌面独有能力，Web 端按边界条款显示「不可用 + 原因」。
5. **restartIce 代替重建**（N9），`disconnected > 6s` 即触发。
6. **凭证刷新**（N2）：TTL 24h + 客户端 60 分钟滚动刷新。
7. **抖动缓冲按路径分档**（N8），依赖 P0 的 pathKind。

### C. P2——把拓扑成本降下来：先做「屏共享专用 SFU」，不要一上来做全量 SFU

这是本文与原计划最大的不同建议。原计划 P2.2 是「≥4 人整房切 SFU」，工程量大、动到语音权限与房间模型；
而**屏共享是最适合先切 SFU 的负载**：

- 天然单发布者、多观看者，不需要混音、不需要订阅关系推导；
- 已有 `share_id` + `watch_session_id` + `screen-share-watch/unwatch` 协议（`router.go:5263-5299`），
  SFU 可以直接复用这套订阅语义，`watch` 变成「订阅这条转发流」；
- 收益是三条同时兑现：

  | 指标 | 现状（1 人共享 + 5 人观看，4 Mbps） | 屏共享 SFU |
  | --- | --- | --- |
  | 发布者上行 | 20 Mbps（5 份） | 4 Mbps（1 份） |
  | Web 发布者编码器 | 5 个 | 1 个 |
  | 服务端 ingress | 20 Mbps | 4 Mbps |
  | 每观看者一条 PeerConnection | 是 | 是（但只到 SFU，且可 mux 到单端口） |

  编码器从 5 降到 1 才是 Web 端「流畅」的关键，带宽只是顺带。
- 服务器侧可以只开**一个** ICE 端口（UDP mux），彻底摆脱 N1 的端口池限制；
  每观看者的码率可以独立用 REMB 控制，原生那个「min() 拖累所有人」的问题（见 N6）自动消失。

风险与边界：SFU 必须解密媒体（DTLS-SRTP 终结在服务器），这与原计划边界第 2 条一致——
需要服务器级开关 + 明确的隐私说明，默认关闭时不改变任何现状。
语音在 ≤8 人内保持 mesh，等屏共享 SFU 跑稳、有了 P0 的双向计量数据之后再评估语音 SFU。

如果短期内不想碰 SFU，退而求其次的最小改动是：Web 端观看者 > 2 时把 `auto` 码率系数下调、
`maxFramerate` 降到 30，并给发布者一个「观看者较多」的提示。这能缓解 CPU 掉帧，但治不了 N 倍上行。

### D. P3——服务端信令与容量（与 P0 同批，不占独立排期）

1. `Hub` 加租户/成员/设备三级索引 + `RWMutex`（N4）；
2. presence 只在状态翻转时广播，语音 socket 心跳改轻量类型（N4）；
3. `rtc.signal` 按设备令牌桶限流 + 超限计数（N5）；
4. 无 target 的广播路径用「每频道参与者快照缓存」，替换 `r.store.VoiceStates()` 全量遍历（N5）；
5. TURN 端口池默认放大 + 文档数量表（N1）。

## 4. 合并后的执行顺序

| 阶段 | 内容 | 主要文件 | 验收 |
| --- | --- | --- | --- |
| 0 | 合并 `browserRTCConfiguration`；`pathKind`（Web + 原生）；`icecandidateerror` 采集；TURN allocation 计量 + `media` 命令 | `voice-session.svelte.ts`、`App.svelte`、`native_voice.rs`、`rtc_config.rs`、`mediarelay/turn.go`、`adminconsole/console.go` | 局域网 / 双 NAT / 强制中继三种网络下 UI 正确显示 direct/relay；`media` 命令能报 `inUse/total` |
| 1 | TURNS/443；双栈 IPv6；`max-bundle` + `iceCandidatePoolSize`；凭证 TTL 与滚动刷新 | `turn.go`、`config.go`、`router.go`、`voice-session.svelte.ts` | 企业网（仅 443 出站）可通话；>2 小时通话后新加入者仍有中继候选 |
| 2 | 原生 UDP mux + UPnP/NAT-PMP；`restartIce`；抖动缓冲分档 | `native_voice.rs`、`main.rs`、`rtc_config.rs`、`voice-session.svelte.ts`、`screen-share-transport.svelte.ts` | 拔网 3 秒恢复不断音；对称 NAT 组合下直连率有提升（用阶段 0 的数据量化） |
| 3 | 信令限流、Hub 索引、presence 收敛、TURN 池扩容 | `ws/hub.go`、`api/router.go`、`config.go` | 压测：200 个在线客户端时 `rtc.signal` 端到端延迟不随人数线性上升 |
| 4 | 屏共享专用 SFU（watch 订阅语义不变，语音仍 mesh） | 新增 `internal/sfu/*`、`api/router.go`、`screen-share-transport.svelte.ts`、`main.rs` | 1 发布 + 5 观看：发布者上行降到 1 份、Web 只用 1 个编码器、观看端帧率与 RTT 不劣于 TURN 基线 |

## 5. 回归命令

```powershell
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:workspace-browser
npm --prefix apps/desktop run test:screen-share-browser
cd services/ev-server; go test ./...
cd apps/desktop/src-tauri; cargo fmt --all -- --check; cargo test
```

媒体相关改动必须同时验证 Tauri 原生与 Web 两条路径（AGENTS.md）。
阶段 1 的双栈改动还需要在真实双栈公网环境各测一次 v4-only / v6-only / 双栈三种客户端。

## 6. 风险与回滚

- `max-bundle` 与 `iceCandidatePoolSize` 属于行为级改动，先加本地开关，出问题可单独回退到旧配置。
- 双栈公告后若服务器 IPv6 不可达，客户端会多一轮失败的 ICE，**必须**在未配置 `public_host_v6` 时不公告。
- TURN/TLS 与 N4 的 Hub 索引都是纯增量，可独立回滚。
- SFU 是唯一不可「开关回滚」的改动（涉及新进程内组件），因此必须保留 mesh 路径作为并存的第二种模式，
  由服务器级开关决定，而不是删掉 mesh。

## 7. 仍需实测（补充原计划第 8 节）

1. 默认 41 端口池在真实双 NAT 房间里的实际 allocation 峰值（先用阶段 0 的 `inUse/total` 量一次）。
2. TURN 凭证过期后的失败形态：确认是 `icecandidateerror 701` 还是静默丢候选。
3. Web 端 5 个观看者时 `qualityLimitationReason` 是否稳定为 `cpu`（决定 N6 的修复优先级）。
4. 原生共享 UDP mux 之后，同一 NAT 下多个对端的直连率变化。
5. 屏共享 SFU 在 1 发布 + 5 观看下的发布者上行与观看端 RTT，对比 TURN 基线（`screen-share-troubleshooting.md:172-175` 的 2.5/8 Mbps 数据可直接复用为对照）。
