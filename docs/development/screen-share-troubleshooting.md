# EchoVoice 屏幕共享故障排查记录

本文记录已经确认的屏幕共享故障、根因、修复约束和回归测试。新增排查结论应继续追加到本文，不在项目根目录创建临时方案文档。

## 2026-07-17：反复观看后服务端卡顿、偶尔出画面后冻结

### 现象

- Web 与桌面客户端观看公网共享时长时间黑屏。
- 偶尔能够显示约一秒，随后画面停止更新。
- 反复执行“观看 / 停止观看”后，信令请求明显增多，严重时影响语音频道操作。
- 服务端可能连续收到同一成员的观看和停止请求，客户端状态与服务端观看者列表不一致。

### 已排除

- EV Server 的单次观看接口不存在固定死锁。对部署实例执行临时成员的 20 轮顺序观看/停止测试，接口耗时约 404-507 ms，测试后已清理临时成员和共享会话。
- TURN 配置能够由服务器正常下发，问题不是“完全没有配置 TURN”。公网 UDP/TCP/TLS 的实际可达性仍应在目标部署网络单独监控。
- H.264 编码和浏览器解码链路可持续工作。原生发送端到 Chromium 的独立互操作测试能够稳定传输并解码视频。

### 根因

客户端原先在停止观看时立即清理本地状态，同时以不等待结果的方式发送 `DELETE /viewer`。用户马上重新观看时会发送新的 `POST /viewer`，较慢的旧 `DELETE` 可能在新 `POST` 之后抵达服务器，撤销刚创建的观看状态。

此外，同一共享的自动重试可以和手动停止交叉执行。服务端原先只保存成员级观看者列表，不知道请求属于哪台设备、哪一次观看会话，因此只能按抵达顺序盲目执行。结果是：

1. 共享端刚为新会话建立 PeerConnection，旧停止请求又要求关闭它。
2. 观看端仍保留一条 `live` 视频轨道，但 RTP 不再前进，表现为短暂出画面后冻结。
3. 恢复定时器不断创建新信令，反复操作会放大服务端和客户端负载。

### 修复

- 每次观看使用唯一 `watch_session_id`。
- EV Server 按 `server_id + share_id + member_id + device_id` 保存当前观看租约。
- 相同租约的重复 `POST` 幂等处理。
- 新租约替换同一设备的旧租约。
- 旧租约的迟到 `DELETE` 只返回当前共享状态，不删除新租约、不发送停止信令。
- 同一成员的另一台设备仍在观看时，不从成员级观看者列表移除该成员。
- 共享结束、成员退出语音或实时连接清理时同步删除租约。
- 客户端对同一共享的观看请求去重，并在停止期间保持入口禁用。
- 客户端等待在途观看请求结束后再发送停止请求；停止请求有六秒超时，不再无限占用 UI。
- 停止完成前不能启动恢复定时器；观看页与频道卡片使用相同的忙碌状态。
- 播放健康检查要求最近四秒内解码统计持续增长，不能仅凭历史上收到过一帧判定健康。

### 回归验证

- Go API 测试验证：新租约建立后，旧租约的停止请求不会移除观看者；当前租约停止后才移除。
- 双浏览器 E2E 连续执行五轮“观看 / 停止 / 重新观看”，每轮均建立新连接并收到可解码 RTP。
- E2E 将视频源暂停 5.5 秒后恢复，客户端关闭失速连接并建立新连接继续解码。
- E2E 验证共享启动被打断后可立即停止、退出语音并重新进入，未访问空 `sessionId`。
- 原生屏幕共享到 Chromium 互操作测试：1280x720，约 30.2 解码 FPS，持续收到视频 RTP。

### 部署要求

本次协议行为同时修改了 Web/桌面前端和 EV Server。部署验证时必须一起更新：

1. 重新构建并部署 `apps/desktop/dist/`。
2. 重新构建并替换 EV Server 可执行文件。
3. 桌面客户端重新构建或运行最新开发版本。
4. 清理浏览器旧静态资源缓存，确认加载的是新哈希资源。

仅更新客户端不能让旧服务端识别过期停止请求；仅更新服务端也不能阻止旧客户端并发发送观看和停止请求。

## 2026-07-17：第二轮，桌面原生发送端连接回收与信令背压

### 进一步确认的根因

服务端观看租约修复后，桌面原生发送端仍有一套独立的观看者生命周期，旧实现存在以下问题：

1. 原生发送端按成员保存 PeerConnection，但移除观看者时没有核对 `watch_session_id`。旧停止信令能够关闭同一成员刚建立的新连接。
2. 移除或替换观看者时，控制线程同步等待 `RTCPeerConnection.close()`。TURN 或 ICE 收尾较慢时，后续应答、候选、观看和停止命令全部积压。
3. 原生候选信令使用无界队列，前端取出后以不等待结果的方式同时发送所有 HTTP 请求。公网候选较多或重连频繁时会形成请求突发。
4. 为避免同步阻塞而直接取消超时的关闭操作，会留下尚未正常释放的 ICE/TURN 资源；反复观看后影响逐步放大。

这组问题不会在单次本地 Web-to-Web 观看中稳定出现，但符合桌面共享端在公网环境下“短暂出画面、随后停帧、反复停止后影响其他业务”的特征。

### 第二轮修复

- 原生发送端的待创建观看者和活动观看者都记录 `watch_session_id`。
- 旧观看会话的停止、应答和 ICE 候选只计为过期信令，不再改动当前连接。
- 替换观看者时立即从活动映射移除旧连接，PeerConnection 在 Tokio 运行时异步关闭，控制线程不再同步等待。
- 关闭任务可追踪；停止整个共享时等待已移除连接完成资源释放，避免通过取消关闭来遗留 TURN 分配。
- 原生信令队列增加全局和单观看者上限；新 offer 会清除该观看者的旧 offer/候选。
- 前端只转发当前观看会话的信令，offer 优先于候选，每批最多顺序发送四个请求，并使用单飞调度防止多个刷新任务并发。
- 原生控制循环每轮最多处理 64 条命令，状态刷新和停止检查不会被无限命令队列长期饿死。
- 观看端关闭后测试会确认活动视频 PeerConnection 数量归零；重新观看后必须恰好只有一条活动视频连接。

### 第二轮回归验证

- Rust 原生发送端 12 轮快速观看/停止测试通过，并验证旧会话停止不能移除新会话。
- Rust 原生发送端相关 7 项测试全部通过，包括刷新重连后持续收到合成视频 RTP。
- 1280x720@60 的 Media Foundation 硬件编码到 Chromium 互操作测试连续通过；实测约 57-60 显示 FPS，五秒窗口内 RTP 与解码帧持续增长。
- 真实 EV Server + 双 Chromium E2E 完成 12 轮停止和重新观看，每轮只有一条活动视频连接，旧连接全部进入关闭状态。
- 同一 E2E 在循环期间以 80 ms 间隔请求服务器公开接口；本轮采集 49 次，最大响应耗时约 2.74 ms、平均约 1.36 ms、无错误。测试门槛仍为最大耗时低于 1500 ms。
- 12 轮后继续验证人为停帧恢复、停止共享、退出语音、重新进入语音和文字/成员等后续业务，完整流程通过。
- 60 FPS 首轮回归曾出现一次 Media Foundation 测试进程释放异常；后续连续五轮及连接回收调整后的复测均未复现，保留为驱动兼容性观察项。

### 本轮部署范围

本轮新增修复位于桌面 Tauri/Rust 发送端和共享前端。生产验证至少需要重新构建 Web 静态资源和桌面客户端；EV Server 仍必须包含上一轮的观看租约修复，不能回退为旧版本。

## 2026-07-17：第三轮，观看端 HTTP 兜底信令破坏已建立连接

### 现象与定位

- 观看端偶尔能够显示一至两秒画面，随后停帧并进入自动重试。
- 浏览器网络面板中，停帧与持续请求 `GET /api/v1/screen-shares/{share_id}/signals` 同时出现。
- 刷新观看端后能够再次短暂出画面，说明捕获和编码并非本轮首要故障点。

代码检查确认，观看端过去只要处于观看状态，就会每 750 ms 请求一次 HTTP 信令队列，即使 WebSocket 正常且视频已经持续解码。该逻辑包含一条会破坏已建立连接的链路：

1. 停止轮询时只把 `inFlight` 标记改回空闲，没有取消已经发出的请求。
2. 快速停止、刷新或重新观看后，旧请求和新请求可以重叠；旧响应也没有观看代际校验。
3. EV Server 的 HTTP 队列只按共享和目标参与者过滤，没有按 `watch_session_id` 隔离。
4. WebSocket 和 HTTP 取回同一 offer 时，观看端会再次执行 rollback、设置远端 offer 并生成 answer。
5. 对一条已经稳定传输的 PeerConnection 重复协商，会使现有 RTP 短暂中断；恢复逻辑随后创建更多观看请求，形成停帧和重试循环。

### 第三轮修复

- HTTP `/signals` 只在 WebSocket 不可用、尚未完成协商或播放已经失速时启用；播放持续推进且 WebSocket 正常后立即停止轮询。
- 每轮 HTTP 排空任务使用 `AbortController` 和单调递增的轮询代际；停止观看、切换观看会话或恢复健康后会取消旧请求。
- HTTP 响应返回后再次核对轮询代际、共享仍在观看以及 `watch_session_id` 仍是当前值，旧响应不能回灌信令。
- 观看端所有 HTTP `/signals` 请求携带当前 `watch_session_id`。
- WebSocket 和 HTTP 信令进入同一个串行处理队列，并对 offer、answer、ICE candidate 做 30 秒有界去重。
- offer 处理增加 SDP 级幂等检查；当前 PeerConnection 已应用完全相同的远端 offer 时不再 rollback 或重新应答。
- EV Server 校验请求来自当前设备的当前观看租约，只排空对应 `watch_session_id` 的信令；旧会话请求返回空列表。
- 服务端在同一个观看租约锁区间内完成“校验当前租约 + 排空队列”，避免旧 GET 在会话替换的竞态窗口中拿走新会话信令。
- 同一共享中与当前观看代际不匹配的旧队列项会被丢弃，避免后续轮询再次收到。
- 屏幕共享信令请求现在保留调用方取消信号，同时仍有独立的四秒网络超时。

### 第三轮回归验证

- 前端生产构建通过。
- EV Server 全部 Go 测试通过；新增测试验证旧观看代际和当前代际同时入队时，当前观看端只收到当前 offer，旧代际无法继续排空信令。
- 双 Chromium 完整工作区 E2E 通过：首轮画面从 3 帧继续增长到 167 帧、约 900 KB，五秒以上持续播放没有停帧。
- E2E 在画面健康后监控 `fetch`，确认不再持续请求 HTTP `/signals`；协商阶段的兜底请求均携带 `watch_session_id`。
- 连续 12 轮停止观看和重新观看全部成功，每轮只有一条活动视频 PeerConnection 且均收到可解码 RTP。
- 模拟源停帧 5.5 秒后恢复，观看端重新建立连接并继续解码。
- 12 轮期间执行 49 次 EV Server 响应探针：无错误，最大约 2.57 ms，平均约 1.44 ms。
- 原生 1280x720@60 到 Chromium 的独立互操作测试通过：约 60.0 解码 FPS、57.3 显示 FPS，136 帧持续推进，最大显示帧间隔约 33.4 ms。

### 第三轮部署范围

本轮同时修改 Web/桌面共享前端和 EV Server 的信令队列协议。公网复测前必须同时更新 `apps/desktop/dist/`、桌面客户端和 EV Server；仅替换其中一端无法获得完整的观看代际隔离。

## 2026-07-18：第四轮，原生观看者身份误清理与固定高码率拥塞

### 现象复核

- 观看端成功出画面的概率较低；即使出画面，也会在约一秒后停止。
- 停帧后观看端恢复请求 `GET /api/v1/screen-shares/{share_id}/signals`，响应为 `{"signals":[]}`。
- 空信令响应不是停帧原因。已建立的 WebRTC 媒体不会依赖空队列轮询继续传输；该请求是播放健康检查已经发现 RTP 不再推进后才启用的恢复动作。

### 本轮确认的根因

第一处是身份层级混用。服务器共享会话中的 `viewer_member_ids` 是成员 ID，例如 `mem_xxx`；桌面原生发送端按设备级语音参与者 ID 登记 PeerConnection，例如 `vp_xxx`。前端每秒同步观看者时曾直接比较这两种 ID，因二者必然不同而删除刚建立的原生连接。这与“一秒后停帧”严格对应。

第二处是公网拥塞控制缺失。原生编码器曾把用户目标码率作为固定起始码率。强制通过生产 TURN 测试时，1280x720@60、22.1 Mbps 的固定发送连接能够进入 `connected`，但约 18 秒只解码 16 帧；相同 TURN 上的 2.5 Mbps 浏览器视频持续约 570 帧且零丢包。连接建立不代表发送速率适合中继路径。

### 第四轮修复

- 新增明确的成员 ID 到语音参与者 ID 映射，禁止直接比较两种身份。
- 拥有当前 `watch_session_id` 的设备级观看者以 watch/unwatch 信令为权威来源，不会被短暂过期的成员快照删除。
- 只有参与者能够解析到成员、没有活动观看会话且成员已不在观看者集合时，才清理残留原生连接。
- 原生编码器把用户选择的码率解释为上限，从不再以高上限直接冲击网络。
- 原生发送从最高 2.5 Mbps 安全起步；无积压时按间隔加性探测上调，观看者发送队列积压时立即乘性下调。
- 收到 RTCP REMB 时，所有活跃观看者中的最低估计值乘以安全余量成为当前硬上限；估计过期后才恢复主动探测。
- Media Foundation 编码器通过 `ICodecAPI` 动态调整平均码率；OpenH264 路径在码率变化时重建低延迟编码器。
- 原生状态区分 `targetBitrateBps`（用户上限）、`effectiveBitrateBps`（当前编码码率）和 `receiverEstimatedBitrateBps`（接收端估计）。

### 第四轮公网验证

- 公网服务器 `https://qm.starecho.net:17878` 的 TURN 强制中继基线通过：2.5 Mbps 与 8 Mbps 浏览器链路各持续 10 秒，约 567 帧增长、零丢包，RTT 约 82-106 ms。
- 原生 H.264 直连 Chromium 通过：1280x720@60，约 60.5 解码 FPS、57.2 显示 FPS，最大帧间隔约 33.4 ms。
- 原生发送端保留 22.1 Mbps 用户上限并强制双方使用生产 TURN，持续解码 619 帧，约 60.1 解码 FPS、59.6 显示 FPS，最大帧间隔约 33.4 ms；实际码率根据反馈稳定在约 3.88 Mbps，接收端估计约 4.78 Mbps。
- 使用真实 Windows Graphics Capture 捕获显示器并通过 NVIDIA Media Foundation 编码、生产 TURN 转发时，持续解码 635 帧，约 60.0 解码 FPS、57.0 显示 FPS，最大帧间隔约 33.4 ms；实际码率约 2.90 Mbps，接收端估计约 3.44 Mbps。
- 身份映射测试覆盖：成员/参与者 ID 不同仍保留连接、活动观看会话抵抗旧快照、停止观看后清理、语音状态暂缺时保守保留。
- 双 Chromium 应用 E2E 持续增长到 169 帧，并完成 12 轮观看/停止、停帧恢复和共享中断后的语音重连；48 次服务端探针最大约 2.75 ms，无错误。
- Rust workspace 全量测试通过：50 项有效测试成功，3 项真实音频设备测试按设计忽略。EV Server 全量 Go 测试通过，前端生产构建通过。

### 第四轮部署范围

身份同步修复位于 Web/桌面共享前端，拥塞控制位于桌面 Tauri/Rust 发送端。生产复测至少需要重新部署 `apps/desktop/dist/` 并重新构建桌面客户端；EV Server 应继续使用包含前三轮观看租约和信令隔离修复的版本。

### 标准依据

- [RFC 8834：WebRTC 的 RTP 媒体传输](https://www.rfc-editor.org/rfc/rfc8834.html) 要求端点根据可用网络容量调整 RTP 流量，不能持续显著超过路径承载能力。
- [RFC 9392：交互式媒体的 RTCP 拥塞反馈](https://www.rfc-editor.org/rfc/rfc9392.html) 说明发送端应使用 RTCP 反馈调节媒体速率。
- [RFC 8888：RTCP 拥塞控制反馈格式](https://www.rfc-editor.org/rfc/rfc8888.html) 给出了丢包、到达时间等发送端拥塞控制输入。
- [W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/) 定义了接收字节、包、解码帧、候选对和质量限制等验证指标；回归测试不能只检查轨道是否为 `live`。

## 排查规则

- 黑屏时同时记录观看端 `connectionState`、`iceConnectionState`、`signalingState`、`bytesReceived`、`framesDecoded` 和最近解码推进时间。
- 共享端同时记录捕获、编码、写入、应答和 ICE 候选计数，区分采集故障、编码故障和传输故障。
- 判断“画面可用”必须验证统计持续增长至少五秒，不能以 `track.readyState === live` 或出现首帧作为通过标准。
- 观看和停止请求必须携带 `watch_session_id`；新增客户端代码不得恢复 WebSocket 与 HTTP 双重发送观看状态。
- 自动重连必须先关闭旧 PeerConnection，并为新连接创建新的观看会话 ID。
- 原生发送端关闭观看者必须验证 `watch_session_id`，不得仅按成员 ID 关闭。
- PeerConnection 关闭不得阻塞捕获/控制线程，也不得通过超时取消后直接丢弃；最终停止共享必须等待关闭任务回收资源。
- 原生候选信令必须有队列上限和发送并发上限，不得恢复为无界队列或 `fire-and-forget` 批量 HTTP 请求。
- HTTP 信令排空只能作为 WebSocket 协商失败或断线时的有界兜底；媒体健康时不得持续轮询。
- HTTP `/signals` 必须携带当前 `watch_session_id`，返回后必须再次校验本地观看代际。
- 对已应用的相同 SDP offer 必须幂等处理，不得重置正在传输的 PeerConnection。
- 服务端观看者成员 ID 与原生设备级参与者 ID 必须先映射后比较，禁止跨身份层级直接求差集。
- 用户选择的原生屏幕共享码率是允许上限；编码器必须安全起步并根据 RTCP 反馈和发送积压动态调整实际码率。

## 编码管线与码率控制器的不变式

这两条是排查时最容易误判的边界，改动相关代码前先确认不会破坏它们。

### 1. 管线必须持续编码，状态计数器才可信

原生共享端没有观看者时**仍然编码**。`captured_frames`、`forwarded_frames`、`encoded_frames`、`last_frame_at_ms` 是健康检查唯一的事实来源：诊断面板、harness 断言、重连判断都靠它们增长来证明管线还活着。

2026-11-12 曾尝试「无人观看时跳过编码」以降低 CPU，结果四个既有测试同时失败（`synthetic_capture_runtime_produces_frames`、`native_webrtc_sender_refresh_reconnect_receives_synthetic_rtp`、`synthetic_frame_processing_updates_status`、`synthetic_preview_pipeline_pauses_and_resumes_without_stopping_capture`），因为计数器停止增长后无法区分「空闲」和「卡死」。该改动已完整回滚。

如果要降低空闲开销，只能压缩单个帧的成本（分辨率、预览频率、编码器复杂度），不能停掉编码循环。

### 2. 码率天花板必须双向服从

`NativeScreenShareBitrateController` 的上限来自 `min(所有观看者的接收端估计) × 85%`，但**不能只看这一份**：

- 天花板高于当前码率：按每秒一步上涨（上限翻倍时一步到位），用于探测未知容量；
- 天花板**低于**当前码率：必须立刻下调，不能等下一份 REMB。否则复位、观看者离开、链路变差之后，会持续向一条刚说过「吃不下」的链路灌数据。
- 最后一个观看者离开时控制器复位到 `maximum_bitrate_bps`。否则逼出低码率的那个观看者离开后，下一位观看者要按每秒 25% 从 1.5 Mbps 爬回 22 Mbps，前十几秒全是糊的，而那条新链路的容量从来没被测量过。

2026-11-13 补的关键一条：**REMB 描述的是「现在送达多少」，不是「线路能送多少」**。
编码器被压低后，接收端估出来的值也跟着低，`min() × 85%` 就自己把自己钉在原地，
形成棘轮——用户看到的就是「远处的同事退出后，近处的人还是糊，必须彻底停止观看再重看」。

因此控制器还维护两个量：

- `peak_bitrate_bps`：本次共享期间已经证明跑通的最高码率。REMB 说 2 Mbps 时，只要曾经稳定
  跑过 8 Mbps，那条链路的能力就有 8 Mbps 的证据。
- `last_estimate_ceiling_bps`：上一轮的上报天花板，用来区分「天花板降了」和「天花板没变」。

语义变成：

- 观看者离开时，目标 = `max(剩余估计 × 85%, peak)`，立即生效并请求关键帧；
- 链路活着时每轮 `probe_upward` 以 `effective × 115%` 越过 ceiling 试探（上限是 ceiling 的 2 倍），
  成功就 `note_effective_bitrate` 抬高 peak；失败由 REMB/背压自然打回来；
- 只有「天花板确实下降」（比上一轮低出至少一个调整粒度）或「当前值已远高于 ceiling（2 倍）」
  时才退回保守，否则每秒回落到旧 ceiling 会把探测成果抹掉；
- `set_maximum_bitrate` 把 `peak` 夹到新上限，避免用户降上限后又被跳到已经不允许的速率。

### 3. 编码线程必须能被超时唤醒

`run_encoding_worker` 不能只 `while let Some(frame) = frame_slot.wait()`。静止桌面不产生采集帧，
但如果此时观看方丢了参考帧、发来 PLI，编码线程永远在等下一帧 ⇒ 画面永久冻结而音频继续
（实机表现为「1 秒后画面卡住，声音还在」）。所以主循环用
`frame_slot.wait_timeout(SCREEN_SHARE_IDLE_KEYFRAME_INTERVAL /* 120ms */)`，`Timeout` 分支里
若 `keyframe_requested` 为真且通过 500 ms 节流，就重编上一帧并强制 IDR。
重编同一帧的时间戳差值为 0，`sample_duration()` 会落回 nominal，帧序号照常前进。

### 4. 双档编码：一个差链路只能花自己的画质

同一个编码器喂所有人，意味着 `min(所有观看者 REMB) × 85%` 就是全场码率——远处的那个人一来，
近处的高清画面就跟着掉。第 98 轮起同一次采集编两档，每个观看者按自己的估计订阅其中一档：

- `High`：发布尺寸 + 共享码率（原来的唯一一档）；
- `Low`：尺寸取发布尺寸的一半（夹在 640×360–1280×720，取偶数），码率跟随低档观众里最弱的那个
  （`NATIVE_SCREEN_SHARE_LOW_TIER_MIN_BPS` 1.5 Mbps – `..._MAX_BPS` 4 Mbps）。

**第 100 轮把阈值从绝对改成相对**，这是第一版没解决问题的原因：远处观看者的 REMB 常常是 3–6 Mbps，
按「低于 2.5 Mbps 才降档」它稳稳留在高档，继续参与 `min()`，近处的人照样被拉低。

现在的判据是「够不够得着共享目标」，而不是「够不够绝对值」：

- 参考值 `high_tier_reference_bps()` = `min(最强观看者估计, maximum_bitrate_bps)`；
- 降档（`viewer_holds_the_shared_encode_back()`）：该观看者**不是**高档里最弱的那个，
  且 `estimate × 100 < reference × 85`（`NATIVE_SCREEN_SHARE_LOW_TIER_RELATIVE_PERCENT`）。
  最强的那位永远不满足「不是最弱」，所以**永远不会被降档**——这就是「第二个观看者不影响第一个」的充分条件；
- 升档：`estimate × 100 >= reference × 95`（`..._PROMOTE_PERCENT`）连续两次采样。

三条容易踩空的边界：

1. **升档要连续两次采样**（`NATIVE_SCREEN_SHARE_LOW_TIER_UPGRADE_SAMPLES`）。单份 REMB 的抖动幅度能有
   30%，一次达标就升档会来回抖。
2. **最后一个高档观众永不降档**（`high_tier_viewers() > 1`）。否则全场都进了低档，高档编码没人跑，
   而界面还宣称输出全画质。低档观众全走光时低档编码器立即回收（`low_tier_target_bitrate_bps()` 返回
   `None`），一个人观看时仍然只有一份编码、一份 CPU。
3. **切档必须清队列并请求关键帧**（`ViewerMediaQueue::require_keyframe()`）。否则那个观看者会拿到
   半截 GOP——P 帧引用了它从未收到的参考帧，表现为切档瞬间一次花屏。

第 100 轮同时把低档尺寸从「发布尺寸的一半」（1080p → 540p）改成「1280×720 上限」：屏幕共享里
540p 的文字已经不可读，低档应该降到「还能读」为止，剩下靠码率省。

观测面：`status.viewer_layers`（每人 `high`/`low`）与 `status.low_tier_viewers`，
共享面板在有人降档时显示「N/M 使用低画质编码」。注意 `target_bitrate_bps` / `effective_bitrate_bps`
描述的是**高档**编码，低档码率单独在 `low_tier_bitrate_bps`。

### 5. 连接线路：自动只选一次，之后归观看者

第 101 轮之前，观看端会「劣化 4 秒 → 切中继 → 中继没画面 → 8 秒后退回直连」，用户看到的是
direct → relay → direct 的来回跳。现在：

- 自动决策只在 `screenShareStartupProbeMS = 10_000` 的启动窗口内进行（`startedAtMS` 为原点），
  过窗即 `hold`，永不自动切换；
- 窗口内也要连续 3 个样本、持续 4 秒劣化才切一次，且每次观看只切一次
  （`screenShareRelaySwitchesPerShare`）；
- 观看者工具栏的「连接线路」菜单三档：`auto` / `direct` / `relay`，切换即重建连接并重置启动窗口
  （`setScreenSharePathPreference()` 会 `screenSharePathHistory.delete(shareId)`）；
- `relay` 用 `iceTransportPolicy: "relay"`（且必须先 `screenShareRelayIsConfigured()` 确认配了 TURN）；
- `direct` **没有对应的 ICE 策略**（W3C 没有「禁止中继」的选项），实现方式是
  `screenShareDirectIceServers()` 把 `turn:`/`turns:` 服务器摘掉，只留 STUN；
- `startScreenShareRelayWatch` 的兜底（relay-only 6 秒内一个 `typ relay` 候选都没有）把偏好设成
  `direct` 而不是 `auto`：那不是画质选择，而是「唯一能出画面的选择」。

踩过的坑：`auto` 分支必须保留完整的 `iceServers`，否则「自动」会退化成「直连，且再也用不上中继」。

### 6. 抓的是窗口时，分享必须跟着那个窗口走

WGC 给的是一个**窗口的句柄**，不是一块固定尺寸的画面，所以窗口自己变化时没人会来通知编码器：

- **resize**：帧池在开始共享时按 `item.Size()` 创建，窗口被拉大或缩小后，`CreateFreeThreaded` 出来的帧仍是旧尺寸，读回再缩放就是错的（表现为画面停在旧比例）。轮询线程每轮先 `recreate_frame_pool_for_source_size()`，只在 `item.Size()` 与记录不一致时 `frame_pool.Recreate(device, B8G8R8A8UIntNormalized, buffer_count, size)`；源尺寸变化后 `D3D11FrameReader` 的 staging 纹理本来就会按 `staging_desc` 重建，读回自动跟随。
- **窗口关闭**：`item.Closed` 只把 `phase` 置成 `failed` 并写 `capture source closed`，采集线程还在空转、前端也仍在「共享中」。现在关闭事件同时置 `closed_stop`，让采集线程退出；前端在 `applyNativeScreenShareSenderStatus` 里认出这个字符串后调用 `stopCurrentScreenShareSession()`——关闭的窗口不可能再出帧，继续挂着只会让观看端看着一张遗照。
- **最小化 / 完全被遮挡**：DWM 停止合成，WGC 不出帧但不报错。共享继续是**正确**的，错误的是一段时间后恢复时那一帧还带着几十秒前的 `capture_time_ns`：写进 RTP 就是一个超长帧时长（观看端表现为画面猛地往前跳），而且空闲期间接收端估计描述的是「没在发」的路径，恢复后只能从低码率慢慢爬。现在超过 `SCREEN_SHARE_CAPTURE_GAP_NS = 500 ms` 的空档按「重启」处理：把时间戳改写成 `上一帧 + 标称帧长`、两档都强制关键帧、并调 `resume_after_capture_gap()` 把码率恢复到 `peak.max(effective)`（清掉背压与低估计保持状态）。

这条顺序有讲究：`resume_after_capture_gap()` 必须放在 `probe_bitrate_upward()` **之后**。probe 的「服从天花板」分支会把码率压回接收端估计值，先恢复再 probe 等于白恢复（不变式里钉了这条顺序）。

预览缩略图的颜色也有一条单测：`a_preview_thumbnail_keeps_the_channel_order_it_was_given` 用 BGRA(10, 20, 30) 的纯色帧断言缩略图仍是 RGB(30, 20, 10)。`average_bgra_block` 的返回值顺序是 R,G,B，而预览曾经按 `(b, g, r)` 解构再写回，于是共享者看到红蓝互换的图、观看端（走编码流那条路径）一直是对的——只看观看端永远发现不了这个 bug。

### 7. 切中继的那一秒，与「远一点就多缓一点」

第 104 轮前，手动切到中继会黑屏约 1.3 秒。拆开看：candidate ~100 ms、ICE ~180 ms，然后是 webrtc-ice 的 relay 提名门槛——它按**候选类型**等，且 `is_nominatable(&p.local) && is_nominatable(&p.remote)`（`webrtc-ice-0.17.1/src/agent/agent_selector.rs:250`）要求**两端都够格**，所以 relay-only 的观看端会让发送端把整整 1 秒的 relay 等待吃满，而 DTLS 只能在提名之后开始。

现在观看端在重建之前先发一条 `screen-share-path-hint`（`{ share_id, path }`）给共享者，共享者按 `share_id + member` 记住它，下一次 `screen_share_sender_add_viewer` 带上 `relayOnly`，Rust 侧 `create_viewer` 用 `viewer_relay_acceptance_wait(relay_only)`：relay-only 观众 **120 ms**，其余仍 **1000 ms**。只对「用户自己选了中继」的观众放行，是因为那类连接上没有直连对需要保护；自动模式下这条等待必须保留，否则慢速直连对会输给中继并永久留在中继上。

延迟与距离的关系落在播放缓冲上（`screenSharePlayoutDelayCeilingMS(pathKind, rttMS)`）：ceil 由路径决定（直连 150 / 中继 250），再按选中 candidate pair 的 `currentRoundTripTime` 调整——≥150 ms 加 100 ms（远处抖动成串到达，宁可慢一点也不要冻结），≤50 ms 减 30 ms（近处多半在用远程控制，延迟立刻被感知），中间与「测不到」都保持原值。**它不提高码率**：码率是发送端档位控制器的事，这里只决定这个观看者愿意为已在路上的帧多等多久。

### 8. 空档之后必须「跳回」而不是「爬回」

`resume_after_idle()` 的正确性靠三条一起成立，缺一条就退化成「跳过去又被拉回来」：

1. 目标取 `peak.max(effective)` 并夹在 `[MIN, maximum]`：REMB 描述的是「刚才送达多少」，而刚才什么都没送；
2. 清掉 `low_estimate_hold` 与两个背压时间戳，否则 `probe_upward` 的 `backpressure_quiet` 为假，目标会被算成旧的 ceiling；
3. 过期估计（`NATIVE_SCREEN_SHARE_ESTIMATE_MAX_AGE`）必须真的被清掉——`update_receiver_estimate` 与 `probe_upward` 都会 `retain`，所以长时间空档之后 ceiling 回到 `maximum_bitrate_bps`，恢复的码率不会被一份描述空档的报告立刻压回去。

单测 `native_bitrate_controller_resumes_from_its_peak_after_an_idle_gap` 把这三条串起来：先让探测把码率抬到峰值，再让估计塌到 4 Mbps、把估计的时间戳推到报告窗口之外，断言 `resume_after_idle()` 回到峰值且紧接着的 `probe_upward()` 不会把它压回去。

## 设置只在某个时机被读一次的陷阱

屏幕共享的设置在两处被"读一次"：`configureScreenShareSender()`（Web，每个观看者加入/应答时）与原生会话启动时的 `StartCaptureRequest`。任何"用户改了设置但那条读取路径没有再次被触发"的地方，界面会显示新值而编码器仍在用旧值。

已修的四类：

- **码率/帧率/分辨率/内容模式**（Web）：`applyScreenShareSenderSettings()` 把当前设置重新灌给所有在跑的 sender。四个 setter 必须调用 `noteShareSettingsChange()`（`scripts/screen-share-setting-scope.test.ts` 逐个抽取函数体检查）。
- **原生端**：`NativeScreenShareControl` 只有 `AddViewer` / `RemoveViewer` / `HandleSignal`。分辨率/帧率/内容模式仍只在会话启动时被读一次，**只能下次共享生效**，面板因此在设置摘要后追加「下次共享生效」。
  例外是**码率**：`HandleSignal` 接受会话级命令 `screen-share-max-bitrate`（在查观看者之前拦截），落到 `NativeScreenShareBitrateController::set_maximum_bitrate()`，编码循环每帧比对后调用 `Encoder::set_target_bitrate_bps()`（OpenH264 走重建、Media Foundation 走 setter）。用户设的是**上限**，控制器仍在其内按接收端反馈浮动。
- **共享音频与光标**：`toggleAudio()` / `toggleCursorCapture()` 都走同一条 `noteShareSettingsChange()`。Web 端共享音频的中途**关闭**与（采集本来带音轨时的）**打开**会摘/挂 sender 后重新协商，见 `setOutgoingScreenShareAudioEnabled()`；无法打开时回落成「下次共享生效」提示。原生会话中两者仍标注下次生效。
- **播放缓冲**（`jitterBufferTarget`）：老 WebView2 会接受赋值却继续用自己的缓冲，所以 `applyScreenSharePlayoutDelay()` 写后读回比对，失败才回落到 `playoutDelayHint`。

排查手法：用户报告"改了没用"时，先找那条读取设置的代码路径在改动后是否真的会再执行一次，不要只看界面状态。

## 结构不变式测试（`test:screen-share-invariants`）

`apps/desktop/scripts/screen-share-invariants.test.ts` 不做行为断言，只读源码（共 24 条），要求若干**曾经被违反过**的调用关系仍然存在：

| 断言 | 曾经出过的事 |
|---|---|
| 屏共享音频延迟由视频目标推导 | 视频缓冲 250 ms、音频写死 60 ms 时差 190 ms |
| 播放缓冲上限按路径（中继 250 / 直连 150） | 中继路径丢帧只能靠更深的缓冲换取 |
| 卡死判定看传输层字节，不只看解码帧 | 静止桌面被误判卡死，每 4 秒重建一次 |
| 只发送的连接不跑接收侧逻辑 | 共享端对出向连接发 restart-ice，对端只能丢弃 |
| 观看无帧 20 秒后放弃 | 会话已消失时每 4 秒重建，每轮给共享端加一路编码器 |
| 设置变更抵达在跑的 sender | 改画质只改界面 |
| 原生 codec 注册必须早于 `register_default_codecs()` | 它按 mime + payload type 静默去重，晚注册等于没注册（Opus 与 H.264 各出过一次） |
| 原生 Opus fmtp 只来自一个常量 | 两处字面量漂移时测试仍绿 |
| 观看者离开必须立刻释放它占住的码率 | `min()` 棘轮：远处的人走了，近处的人还糊着（2026-11-13 实机反馈） |
| 切换路径前必须确认服务器配有 TURN | relay-only 在没有 TURN 时没有任何候选，比糊更糟（直接没画面） |
| 静止桌面也必须应答关键帧 | 编码线程只等采集帧，PLI 永远没人应答 → 画面冻结、声音继续 |
| 中继不可达必须立刻切回直连 | relay-only 收集失败是静默的：一个候选都没有，用户只是看到黑屏等到超时 |
| 弱观看者只能降低自己的档位 | 单编码器 + `min()`：远处的人一来，近处的人跟着糊（2026-11-13 实机反馈） |
| 分档按「够不够得着共享目标」判，最强的那位永不降档 | 第一版用绝对阈值 2.5 Mbps，而远处 REMB 常是 3–6 Mbps，等于没分档（2026-11-13 第二次实机反馈） |
| 最后一个高档观众不许降档、低档无人时编码器回收 | 全场进低档 = 高档编码为没人跑，界面却仍宣称全画质 |
| 每个观看者只收到自己档位的样本 | 分档只做了编码、没做路由，等于没分 |
| 早于 answer 的 ICE 候选要暂存而不是丢掉 | webrtc-rs 在 remote description 之前返回 `ErrNoRemoteDescription`，候选被静默吞掉 |
| 线路只在开始时自动选一次，之后只由观看者改 | 自动切换曾出现 direct → relay → direct 来回跳（2026-11-13 实机反馈） |
| 切到 `direct` 必须摘掉 TURN 服务器 | W3C 没有「禁止中继」的 ICE 策略，留着 TURN 等于「优先直连」而不是「只用直连」 |
| 选了中继的观看者必须提前告知共享者 | 两端都要过 relay 提名门槛，发送端白等 1 秒 → 切中继黑屏 1.3 秒 |
| 抓的是窗口就必须跟着窗口 resize / 关闭 | 帧池尺寸固定在开始共享那一刻；窗口关了采集还在空转 |
| 抓窗口的空档要重定时间戳 | 最小化后恢复的第一帧带几十秒前的时间戳 → 观看端画面猛跳 |

采集尺寸只在用户选的预设正好等于显示器分辨率时才与编码尺寸相同。其余情况由 `convert_scaled_bgra_to_i420` 负责缩放，它按 `axis_starts` / `axis_ends` 划出的**源矩形做面积平均**：把源像素全部计入，而不是取其中一个。点采样（旧实现）在 1080p 屏幕跑默认 720p 预设时会丢掉一半行列，正文小字会在画面里闪；面积平均把代价换成轻微柔化，文字不再跳动。

`first frame` 现在带分段（`candidate` / `relay` / `ICE connected` / `DTLS` / `play`），同一台机器上的实测：

| 路径 | candidate | ICE connected | DTLS | first frame |
| --- | --- | --- | --- | --- |
| 直连（修门槛前） | 45–56 ms | 56–220 ms | 387–1251 ms | 690–1377 ms |
| 直连（修门槛后） | 46–51 ms | 57–220 ms | 20–350 ms | **184–759 ms**（中位 684） |
| 中继（修门槛前） | 105–120 ms | 306–318 ms | 2140–2280 ms | 2258–2394 ms |
| 中继（修门槛后） | 118–119 ms | 182–243 ms | ~1100 ms | **1270–1291 ms** |

接收页现在**先回 answer、再逐个交候选**（`__evNativeMediaGathering`），与真实观看端的 trickle 顺序一致；最初那版是等 ICE 收集完成才回 answer，比生产慢。改成生产的顺序后直连首帧降到 690 ms，但**中继的 DTLS 仍然是 ~2.1 s**——所以那 1.75 s 不是脚手架artifact，是 relay 路径上真实存在的握手成本。把候选交付间隔从 100 ms 收到 10 ms 也不改变这个数字（2059–2261 ms），因此也不是「交付慢了」。**根因（第 77 轮定位）**：不是 DTLS 丢包，是 webrtc-ice 的 `DEFAULT_RELAY_ACCEPTANCE_MIN_WAIT = 2 s`——凡是候选类型为 relay 的对，必须等 agent 启动满 2 秒才允许提名。日志里 Pion 在 2305 ms 才 `Set selected candidate pair`，DTLS Flight 0 紧接着 2305.8 ms 才开始；浏览器那边的「DTLS 2.1 s」其实一直在重传 ClientHello，等的是 Pion 提名。改成 `setting_engine.set_relay_acceptance_min_wait(Some(1000ms))` 后，提名提前到 1320 ms，中继首帧 **2346–2394 ms → 1338–1387 ms**。同一族还有第二个门：`prflx` 的默认等待是 1000 ms。日志里能直接看到它的代价——某次直连在 1240.8 ms 才 `Set selected candidate pair`，而那一对是 `host <-> prflx`。把 `set_prflx_acceptance_min_wait` 降到 500 ms 后，直连首帧的慢分支从 ~1300 ms 落到 700–890 ms（四次采样：175 / 708 / 890 / 719 ms，提名 153 / 360 / 776 / 364 ms）。prflx 与 srflx 都是直连路径，谁先赢只影响走哪个本地接口，所以这里可以比 relay 更激进。

验收门现在对中继这一侧加了一条 `first frame < 2000 ms` 的断言：把这个设置弄丢会直接变红，而不是只表现为「感觉有点慢」。保留 1 s 而不是更短，是因为它还要让 srflx（500 ms）和 prflx（1000 ms）有机会先赢；再短就会让本来能直连的会话永久走中继。

复测（直连 5 次、中继 3 次，同一台机器）把这两个数字说清楚了：

| 路径 | 样本 | candidate | ICE connected | DTLS | first frame |
| --- | --- | --- | --- | --- | --- |
| 直连 | 5 | 44–49 ms | 59–68 ms | 70–279 ms | 177 / 213 / 683 / 685 / 719 ms |
| 中继 | 3 | 103–120 ms | 165–197 ms | 1160–1167 ms | 1263 / 1264 / 1266 ms |

中继的残差现在就是那道闸门本身：ICE 在 ~180 ms 就连上了，然后一直等到 1000 ms 才允许提名 relay 对，DTLS 只用 ~160 ms。也就是说**再往下只能动这个 1 s**，而它的代价是「本来 600–1000 ms 才成功的直连对会被中继抢先」，所以没有更小样本或真实 NAT 环境的证据前不再下调。直连的波动全在 DTLS：70 ms 与 279 ms 两支，ICE 与候选都很稳。

想再拆「单边中继 vs 双边中继」时发现验收门做不到：只要原生侧有 host 候选，ICE 就会选直连，哪怕浏览器侧配了 TURN——所以上面这组数字的准确前提是**两端都在中继上**（原生侧被 `EV_SCREEN_SHARE_BROWSER_FORCE_RELAY` 限制为 relay-only）。这台验收门里两侧都配置了同一个 TURN 服务器，这与生产里「只有走中继的共享」是同一形状。

结论与旧笔记相反：中继的额外 1.5 s **不在 allocation（117 ms）也不在 ICE（240 ms，与直连相同），而在 DTLS**。两次中继复测都稳定在 ~2.25 s，且恰好是直连 DTLS（427 ms）加上约 1.85 s——像是首个 DTLS 报文丢失后按 1 s 间隔重传。两边都在同一台 TURN 上时才有这条路径，所以这是本机拓扑的观察，不能直接断言生产同样如此，但至少排除了「TURN 分配慢」这个假设。

成本已测：本机 4K 源 → 1080p 预设每帧 **3.16 ms**（`native_scaled_bgra_conversion_timing_probe`，`--ignored` 手动跑）。60 fps 的预算是 16.6 ms，所以面积平均最坏情况占约 19%，仍未成为瓶颈；若以后要压，优先做行内 SIMD，而不是退回点采样。

预览缩略图走同一个箱式滤波（`scaled_preview_rgb` 复用 `axis_starts` / `axis_ends` / `average_bgra_block`）。共享者判断「清不清楚」靠的就是这张图，点采样会让预览出现编码流里并不存在的锯齿，把实际效果判断得比真实更差。

原生共享中能实时改的两项是**码率**（screen-share-max-bitrate，只动控制器上限）与**帧率**（screen-share-frame-rate，只改 ScreenShareFramePump 的目标，编码器与协商都不动）。分辨率与内容模式仍要新会话：前者要重建编码器，后者会改变 IntraFramePeriod 与复杂度档。帧率能这样改，是因为采集一直按源速率出帧，节流发生在泵里；泵收到新目标时会把 
ext_frame_at_ns 清掉，否则第一帧要等旧的截止时间（最多一个旧间隔）。

面板上「带宽受限 / 处理器受限」现在会跟一句可执行的建议（降码率 / 降帧率），由 `screenShareLimitationHint()` 从浏览器报的原因映射；「浏览器受限」不给建议，因为那时确实没有哪个旋钮能救。

**它证明不了行为正确**，只证明"意图还接在线上"。行为由同目录下的 `screen-share-playout` / `screen-share-liveness` / `screen-share-path` 等套件覆盖；两者要一起跑。

## 本机可跑的真实浏览器互操作测试

`npm --prefix apps/desktop run test:screen-share-browser` **不需要服务器，也不需要登录**。它启动本机 Chrome/Edge（找不到就 `skip`），让真实浏览器与真实的 Rust 原生共享端互通，覆盖：浏览器侧 `getDisplayMedia` 编码、浏览器回答原生 offer、H.264 协商、帧节奏（首帧耗时、解码/显示 FPS、p95 与最大帧间隔）、音视频是否真的到达。

`test:screen-share-web-quality` 是同一个脚本加 `--web-only 42e020 1280 720 60`，只跑浏览器→原生方向。参数是**追加**的，脚本里已固定 profile，所以换分辨率要直接调 `node scripts/screen-share-browser-interop.mjs --web-only 42e020 1920 1080 60`。

环境变量：

| 变量 | 作用 |
|---|---|
| `EV_SCREEN_SHARE_RELAY_DIAGNOSTIC_URL` | 设成 ev-server 地址时，额外连接真实服务器并用 TURN 强制中继（默认关闭，这是唯一需要服务器的分支） |
| `EV_SERVER_PASSWORD` | 上面那条分支的服务器密码 |
| `EV_SCREEN_SHARE_BROWSER_REAL_CAPTURE=1` | 用真实屏幕捕获替代合成画布 |

脚本现在会断言原生发送端的状态字段，而不只是打印：`viewerPaths` 必须与本次连接相符（loopback 为 `direct`、配了 TURN 为 `relay`）、`droppedFrames` 与 `sampleWriteErrorCount` 必须为 0、`nativePeerConnectionState` 必须是 `connected`、`lastError` 必须为空、`encodedFrames` 必须大于 0。

注意 harness 的 `viewerMemberIds` 为空是**脚手架特征**：它直接调用 `NativeWebRtcSender::add_viewer`，绕过了会填充该列表的 `NativeScreenShareControl::AddViewer`。产品路径下两个字段都由控制命令维护。

### 本机验证中继路径（不需要 ev-server）

`services/ev-server/cmd/turndev` 是一个只用于测试的 Pion TURN 服务，参数与生产一致（UDP 3478、relay 49160–49460）：

```powershell
cd services/ev-server
go run ./cmd/turndev          # 另一个终端里常驻
```

然后带着内联的 ICE 配置跑验收门：

```powershell
$env:EV_SCREEN_SHARE_BROWSER_ICE_SERVERS='[{"urls":["turn:127.0.0.1:3478?transport=udp"],"username":"ev","credential":"evpass"}]'
npm --prefix apps/desktop run test:screen-share-browser
```

浏览器侧看到 ICE 服务器就会用 `iceTransportPolicy: "relay"`，原生侧仍然双栈收集，于是选中的候选对是 relay↔relay——`viewerPaths` 应当是 `{"mem_browser":"relay"}`，断言会盯着这一点。

**不要同时设 `EV_SCREEN_SHARE_BROWSER_FORCE_RELAY=1`**：那个变量作用于整个测试二进制，会让 offer 导出步骤和其它回环单元测试一起按 relay-only 收集候选而超时。浏览器侧强制中继已经够用。

实测（本机 relaying，1280×720@30，2026-11-13 复测）：

| 指标 | 直连 | 中继 |
|---|---|---|
| 首帧 | ~711 ms | **1276 ms**（candidate 95 / relay 95 / ICE 158 / DTLS 1168 / play 1203 ms） |
| 解码帧率 | 28.4 | 30.0 |
| p95 帧间隔 | 50.1 ms | 50.1 ms |
| 丢帧 / 写错误 | 0 / 0 | 0 / 0 |
| `viewerPaths` | `direct` | `relay` |
| 码率控制器 | 保持上限 | 收敛到 `receiverEstimate × 0.85`（3.5 Mbps → 2.0 Mbps） |

对 ICE 提名门槛的修改把中继首帧从 2332 ms 压到 1276 ms；上表是 417 个解码帧、
0 丢帧、`sampleWriteErrorCount: 0` 的单次测量。

首帧多出的约 0.55 秒是 TURN allocation 与多几轮 ICE 检查的往返；一旦连上，帧节奏与直连无差别。

### harness 自己的上限：约 1080p60

`--web-only` 的帧源是页面里用 `setInterval` 绘制的 canvas。它足以喂满 1080p60（实测 43–52 fps、零丢帧），但**喂不满 4K60**：

```
--web-only 42e020 3840 2160 60
→ 面板正确应用 3840×2160 / 60 fps / 80 Mbps，
  但 averageEncodedFramesPerSecond = 9.6，qualityLimitationReason = "none"
```

`qualityLimitationReason` 是 `none` 说明**编码器没有被限制**，只是没有帧可编——瓶颈在测试页面的 canvas 绘制，不在 Chrome 的编码器，也不在产品代码。

所以：**不要用这个 harness 判断 4K 下的编码能力**。要测 4K 得先给页面一个便宜的帧源（例如复用一张 ImageBitmap），否则测到的是测试脚手架的性能。

### 改动屏幕共享后的最小验收

按这个顺序跑，前一步红了不要往下走：

```powershell
npm --prefix apps/desktop run test:screen-share-browser   # 真实浏览器 ↔ 原生，约 40 秒
npm --prefix apps/desktop run test:screen-share-path      # 以及其余 15 个 test:screen-share-* / test:remote-audio-*
npm --prefix apps/desktop run build
cargo fmt --all -- --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml   # 72 passed / 6 ignored
```

屏幕共享相关的 21 个套件合计 170 条断言，全绿。仓库里另有两条**与本功能无关**的套件当前是红的：`test:channels` 与 `test:desktop-shell`——它们按字符串匹配 `App.svelte` 里的行，而正在进行的组件拆分把这些行搬到了 `ChannelSidebar.svelte` 和 `realtime.svelte.ts`（第 84 轮核实：`handleChannelRowPointerDown` 现只在 `ChannelSidebar.svelte`，`handleWindowBlur` 只在 `realtime.svelte.ts`）。判断屏幕共享有没有回归请看上面这组，不要被这两条误导；反过来也不要用它们当「整体绿了」的证据。

多观看者的扇出由 `native_webrtc_sender_feeds_two_viewers_at_once` 覆盖：两个真实的 webrtc-rs 接收端各自应答自己的 offer，断言两条连接都收到视频 RTP、`viewer_paths` 记到两个人、`droppedFrames` 与 `sampleWriteErrorCount` 为 0。它跑在进程内、约 0.4 秒，所以「只喂了第一个观看者」这类改动会立刻变红——在此之前所有用例都只有一个观看者。

判定标准是**不变量**，不是机器相关的绝对数字：`--web-only` 模式下「请求的分辨率就是送达的分辨率」、全量模式下 `droppedFrames` / `sampleWriteErrorCount` 为 0、`viewerPaths` 与本次连接相符、`encodedFrames` 持续增长。首帧耗时、FPS、帧间隔这些会随机器负载变化，只用来对比同机改动前后。

## 2026-11-13：窗口共享的四条真实边界（宽高比、关闭、空档、延迟预算）

这一轮的四项都来自实机复测，且都不是「调参」能解决的，各自对应一个具体机制。

### 1. 缩放必须留黑边，不能拉伸

`convert_scaled_bgra_to_i420` 原先把 x/y **各自独立**映射到预设编码尺寸（`axis_starts(self.width, source_width)` 与 `axis_starts(self.height, source_height)`），所以窗口一变成非 16:9 就被压扁。现在先算 `letterbox_rect()`：按 `min(out_w/src_w, out_h/src_h)` 等比缩放到一个 fit 矩形，居中，其余像素写黑（Y=16、U=V=128）。两个偏移都 `& !1` 取偶，否则 2×2 亮度块会跨到相邻色度样本上，颜色平面会错半个像素。

黑边只需要在**源尺寸变化时**填一次：之后的每帧只写 fit 矩形内部，边上的字节再没人碰。

预览缩略图本来就用 `min(960/w, 960/h, 1)` 取比例，所以预览一直是正的——只有编码流被拉伸。这也是「预览正常、观看端变形」这类报告容易误导人的地方。

### 2. 窗口被关掉时，`Closed` 事件并不保证到达

`GraphicsCaptureItem::Closed` 由合成器投递；窗口被强制销毁时它可能根本不触发，于是采集线程继续等帧、发送端继续发最后一帧，共享看起来还活着。现在两条路都留着：

- 事件路径：`Closed` → `phase = "failed"` + `last_error = "capture source closed"` + `closed_stop.store(true)`。
- **不依赖事件**的看护：`spawn_capture_source_watchdog()` 每 400 ms 对 `window:<hwnd>` 源做一次 `IsWindow(hwnd)`，窗口没了就置同一个失败原因、置停止位，并 `readback_slot.stop()` 让读回线程退出。

前端 `applyNativeScreenShareSenderStatus` 见到这个原因就调 `stopCurrentScreenShareSession()`；因为「共享动作进行中」会让这次停止被拒绝，所以它最多重试 3 次（`nativeScreenShareClosedSourceRetries`）——被拒绝的停止会让共享继续对外发布一张冻结的画面，重试是必要的。

### 3. 空档必须**移动整条时间轴**，而不是只改一帧

最小化期间不出帧，恢复时第一帧带的是几十秒前的 capture 时间戳。上一版只把这一帧改写成 `previous + nominal`，但**下一帧的真实时间戳仍在空档之后**，于是它又被判成一次新空档，连续触发 `force_keyframe()` 与改写——观看端看到的是「时间变慢，十几秒后才恢复」。

正确的是维护一个累积偏移：`timeline_offset_ns`，每帧 `media = capture - offset`；检测到空档时 `offset += gap - nominal`，于是**这一帧**落在 `previous + nominal`，而后续所有帧共享同一条被平移的时钟。`last_media_ns` 记住上一条真正发出的媒体时间。

空档恢复还要同时做三件事，缺一不可：时间戳平移、两档都强关键帧、`resume_after_capture_gap()`（把码率跳回 `peak` 而不是从低处爬），且顺序必须是 `probe_bitrate_upward()` **之后**，否则探测的 obey-ceiling 分支会立刻把恢复的码率压回去。

### 4. 「允许延迟」是端到端延迟预算，不是抖动缓冲加量

用户要的是直播式落后：远端可以比分享端慢约一秒，这一秒用来吸收网络与处理抖动；近端则要尽可能快。此前把它实现成了「上限 +100 ms」，量级差了一个数量级。

现在的阶梯（`screenShareLatencyBudgetMS`，按选中候选对的 RTT）：`≤50 ms → 80`、`≤100 ms → 200`、`≤200 ms → 500`、`>200 ms → 1000`；未知 RTT 退回裸路径上限（直连 150 / 中继 250）。`screenSharePlayoutDelayCeilingMS` 取 `max(路径上限, 预算)`，而 `adaptScreenSharePlayoutDelay` 会**直接花掉**这个预算（`Math.max(target, min(ceiling, budget))`）——靠每秒 +20 ms 的爬升要半分钟才能到一秒，那等于没有这项功能。压缩方向仍走正常的 −10 ms 步进，所以近端不会突然被加回延迟。

音频继续共用同一个 ceiling（`video − 40`），否则一秒的视频缓冲会变成一秒的音画错位。

## 2026-11-13：确认「现在到底走没走中继」

「中继能不能用」不该靠体感判断。三条证据，从最快到最细：

### 1. 观看端状态行

观看者状态行带一个后缀：`正在接收画面 · 1280×720 · 30 fps · 直连`（或 `· 中继`）。

这个后缀**不等首帧**。线路属于连接而不属于画面：ICE 一旦选定候选对（`candidate-pair.state === "succeeded"` 或 `nominated`）就写进 `pathKind`，所以应答发出后的第一秒内就能读到；在那之前显示 `· 检测线路中`，而不是留空——「共享一直不出画面」恰恰是最需要看线路的时刻。画面卡住时后缀保留最后一次测量值（那是「它曾经从哪条路来」）。重建连接时旧线路立刻作废，回到 `检测线路中`，不会把上一个连接的中继/直连答案接着说一遍。

### 2. 控制台：`__evScreenSharePaths()`

任意构建（包括正式部署）都挂了：

```js
__evScreenSharePaths()
// [{
//   shareId: "share_...", preference: "auto",
//   pathKind: "relay",              // 真正在用的线路，来自选中的候选对
//   frameWidth: 1280, frameHeight: 720, frameRate: 30,
//   receivedBitrateBps: 2480000, framesDecoded: 512,
//   playoutDelayMS: 250,            // 当前缓冲（端到端延迟的主要部分）
//   relayCandidates: 3,             // 收集到的 relay 候选数
//   missingCandidatePairSamples: 0, watchStage: "track-received"
// }]
```

判读方式：

- `pathKind: "relay"` 而不是 `"direct"`，说明**媒体真的经过服务器**，不是「客户端要了中继但 ICE 仍选了直连」。
- `relayCandidates: 0` 且 `pathKind` 一直 `unknown`：TURN 分配根本没成功（见下面第 3 条）。
- `receivedBitrateBps` 远低于 `playoutDelayMS` 对应的预期：问题在带宽，不在线路。
- `missingCandidatePairSamples` 在涨：整条候选对消失，通常是 TURN 分配过期或路径被打断。

`window.__evScreenShareWatchLog` 是同一套决策的环形缓冲（上限 30 条），会记录 `relay-watch`、`relay-unavailable`、`path-preference` 等事件与耗时。

### 3. `chrome://webrtc-internals`

选对应 share 的 `RTCPeerConnection`，看 `candidate-pair` 里 `nominated: true` 的那条：

- `localCandidate.candidateType` / `remoteCandidate.candidateType` 出现 `relay` 即走中继（任一端是 relay 就算，因为中继的出口只有一条）。
- `requestsSent` / `responsesReceived` 停在 0 而 `state` 一直 `in-progress`：客户端的 TURN allocation 请求没被回应 —— 服务器没收到，或回应回不来。

### 服务端对应的两条证据

- 启动日志现在会打印解析后的中继地址：`Realtime relay: TURN UDP/TCP qm.starecho.net:3478 (203.0.113.10), media ports 49160-49460/UDP`。括号里必须是你希望客户端拨号的那个**公网 IPv4**；如果它是一个代理/CDN 的地址，或者私网地址，中继必然对公网用户不可用。
- 防火墙 / 安全组必须放行 **TCP+UDP 3478** 和 **整段 UDP 49160–49460**。只放行到 `49200`（旧文档的默认值）时会出现「部分用户能中继、部分不能」：每个 allocation 在端口段里随机取一个端口，落在未放行区间的那部分直接失败——这正是「有的用户中继连不上」最典型的形态。

### 「中继连上后卡很久才流畅」的既有成本

中继首帧本来就比直连贵（本机实测 1276 ms vs 711 ms）：DTLS 只能在提名之后开始（约 1.1 s），随后还要等一个关键帧。远端 RTT > 200 ms 时，`screenShareLatencyBudgetMS` 还会**主动**花掉最多 1 秒缓冲去吸收抖动——这是设计上的「直播式落后」，不是卡住；如果这段时间画面在动，只是慢，就不要当成故障。真正要区分的是 `framesDecoded` 是否在涨：涨 = 慢但活着，不涨 = 冻住。



