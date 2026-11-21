# EchoVoice 屏幕共享优化现状

记录截至 2026-11-12 已经落地、已实测、仍然缺失的部分，用于决定下一步投入。
范围是屏幕共享（不含语音），目标是清晰、流畅、即时，客户端（Tauri 原生发送端）与
Web（浏览器发送端）都要生效。

## 一句话结论

客户端侧能靠代码拿到的收益基本已经拿完：路径可见、抖动缓冲、码率双向控制、编码配置、
声音参数、重连恢复、凭证轮换都已落地并各自有回归测试。
**剩下唯一的大头是 mesh 的上行算术（N 个观看者 = N 倍上行），它只能由 SFU 解决，属于产品决策。**

## 实测基线

| 指标 | 数值 | 来源 |
|---|---|---|
| 原生发送端 → 真实 Chrome 首帧 | **184–759 ms，中位数 684 ms**（第 81 轮五次采样；第 77/80 轮修掉两个提名门槛前是 741–1366 ms） | `scripts/screen-share-browser-interop.mjs` |
| 720p60 连续解码 | 238 decoded / 238 encoded，46.8 fps，零丢帧 | 同上（`--web-only 42e020 1280 720 60`） |
| 1080p30 送达 | `1920x1080` 原分辨率，135 decoded / 137 encoded，26.9 fps，零丢帧 | 同上（`--web-only 42e020 1920 1080 30`） |
| 1080p60 送达 | `1920x1080` 原分辨率，232 decoded / 234 encoded，H.264 | 同上（`--web-only 42e020 1920 1080 60`） |
| 1080p30 经本机中继 | 140 decoded / 142 encoded，27.8 fps，零丢帧 | 同上 + `cmd/turndev` + `EV_SCREEN_SHARE_BROWSER_ICE_SERVERS` |
| 经中继的首帧 | **1263–1266 ms**（第 83 轮三次采样；残差就是 1 s 提名闸门 + ~160 ms 握手） | `test:screen-share-browser` + `cmd/turndev` |
| offer 从加入观看者到推出去 | 27.9 ms（改动前上限 250 ms） | Rust 单测 + 临时计时 |
| 首帧耗时构成 | 候选收集 ~50 ms + ICE 检查 200–800 ms（`DEFAULT_CHECK_INTERVAL = 200 ms` 的轮次）+ 提名门槛 0–1000 ms + DTLS 20–350 ms；与关键帧时机**无关** | A/B 实测（741 vs 761 ms） |

首帧里**曾经**有一块是我们自己（或者说依赖默认值）造成的：webrtc-ice 的 relay / prflx 提名门槛（2 s / 1 s）。把 relay 降到 1 s、prflx 降到 500 ms 之后，直连中位数 684 ms、中继 1.28 s。剩下的主要是 ICE 检查的 200 ms 轮询节奏（依赖内部常量，不可配），以及候选收集本身。
如果要继续压，只能让连接提前存在（复用语音 PC 或 SFU），那是架构改动。

## 已经落地的

### 清晰

- **码率天花板双向服从**（`apps/desktop/src-tauri/src/main.rs` `NativeScreenShareBitrateController`）：
  上探每秒一步、翻倍一步到位；天花板低于当前码率立刻下调；最后一个观看者离开时复位。
- **码率下调限速**：背压每秒最多降一次（原来每 117 ms 一次，0.8^8.5 ≈ 0.15，
  22 Mbps 一秒掉到 3.3 Mbps，12 帧见底）。
- **关键帧节流**：最少间隔 500 ms，且节流窗口内**不清除**请求位，真卡死的观看者窗口一开就拿到 IDR。
- **H.264 High profile**（原生）：CABAC + 8×8 变换，同码率下文字更锐；SDP `profile-level-id`
  用 `640c`（Chromium 也广告的形式），已在真实 Chrome 上验证协商成功。
- **编码器码率**: `Profile::High`、`ScreenContentRealTime`、`skip_frames(true)`、`adaptive_quantization(false)`。
- **码率排序按编码负载切换**（`screenShareWebRTC.ts`）：`w*h*fps*encoders ≥ 1920*1080*30` 时
  优先 H.264（硬编），否则保留 detail→VP9 的原有决策。
- **Web 共享端声音从单声道改为立体声 160 kbps**（`accompaniment.ts` `enhanceScreenShareOpusSDP`），
  与原生 fmtp 对齐；`screen-share-codec-parity.test.ts` 防止两端再次漂移。
- **`contentHint` 修正**：balanced 档原来返回空串（Chrome 按摄像头画面调优），
  与它自己的 `maintain-resolution` 自相矛盾；现在 detail/balanced 都是 `"detail"`。
- **auto 码率预算上调**（`screenShareSettings.ts`）：原来的每百万像素每帧预算（detail 9 万 /
  balanced 7 万 / motion 5.5 万）意味着 1080p30 balanced 只有 4.35 Mbps，动态画面必然糊。
  第 100 轮改为 12 万 / 9 万 / 7 万（1080p30 balanced ≈ 5.6 Mbps、detail ≈ 7.5 Mbps），
  1080p60 balanced ≈ 11.2 Mbps。这是「上限」不是「承诺」：发送端仍然按 REMB 往上/往下浮动。
- **双档编码：弱观看者只花自己的画质**（原生发送端）。一路编码喂所有人的结构决定了
  `min(所有观看者估计) × 85%` 就是全场码率——远处那个人一来，近处的高清画面就跟着掉。
  现在同一次采集编两档：高档是原来的全尺寸/全码率，低档尺寸取发布尺寸与 1280×720 的较小者
  （取偶数），码率跟随低档观众里最弱的那个（1.5–4 Mbps），每个观看者按自己的 REMB 订阅其中一档
  （`write_h264_sample(layer, …)` 只发给对应档的观看者）。
  分档依据是**相对速率**而不是绝对阈值：参考值是「配置上限」与「最强观看者估计」的较小者，
  某个观看者只有在够不着这个参考值的 85% 时才降档，所以**最强的那位永远不会被降档**，
  连续两次达到参考值的 95% 才升回高档（10% 迟滞防抖）。新人一律先给高档、再按第一份 REMB 决定，
  到达顺序不影响任何人的画质。**最后一个高档观众永远不许降档**（否则全画质编码为没人跑），
  低档观众全走光时编码器立即回收，只有一人观看时仍然是一份编码。
  切换档位会给该观看者清队列并请求关键帧，避免他拿半截 GOP 花屏。
- **候选早于 offer 不再被丢掉**（原生观看者）：观看端一拿到候选就 trickle，经常比它自己的
  answer 更早到达信令；webrtc-rs 在 remote description 之前 `add_ice_candidate` 直接返回
  `ErrNoRemoteDescription`，于是这些候选被静默丢弃，连接只能吃 answer 里内联的那几个。
  现在按连接的真实状态判断，早到的候选挂在观看者身上，answer 落地后再补应用并计数。

### 流畅

- **观看端自适应播放缓冲**（`screenSharePlayout.ts`）：60 / 100 / 150 ms，
  丢包或解码丢帧 +20 ms、网络干净 −10 ms、12–30 ms 抖动迟滞区间保持不动；
  1 秒节流（启动时有 80/260/700/1500 ms 补采突发，不节流会一次顶到上限）。
- **音画对齐**：音频跟随视频目标，固定领先 40 ms（`max(40, video−40)`），
  避免视频缓冲涨到 150 ms 时唇音错位 90 ms。
- **静止画面不再被判为卡死**（`screenShareLiveness.ts`）：原来用「4 秒内要有新解码帧」
  判断播放健康，静止桌面不产生帧 → 每约 4.2 秒重建一次连接 → 越静止越糊且周期性闪烁。
  现在用候选对的 `bytesReceived` 判断链路活性，阈值 15 秒；后台标签页不误判。
- **ICE 失败先重启再重建**（`screenShareIceRestart.ts`）：请求共享端对已有连接 `restartIce()`，
  2.5 秒无果才整条重建；4 秒冷却防止坏链路反复重协商；同一个故障的双重上报用 `hold` 去重。
- **扇出是引用计数**：`QueuedH264Sample.data` 为 `Bytes`，每个观看者只 +1 引用，
  不是每帧拷贝 N 份；`viewer_fan_out_shares_the_encoded_buffer` 钉住这条。
- **丢帧计数不再把「刚加入」算成「丢帧」**：`had_keyframe` 之前不计入 `dropped_frames`。
- **中继路径允许更深的播放缓冲**：直连 150 ms、中继 250 ms（`screenSharePlayoutDelayCeilingMS`）。
  中继多一跳共享队列，抖动是突发式的；屏幕共享是「看」的，多 100 ms 比卡顿可接受。
  **音频必须共用同一个上限**，否则视频 250 / 音频 110 会造出 140 ms 音画错位。
  重连瞬间没有选中候选对时沿用上次已知路径，避免在最需要缓冲时被降回 150。
- **解码冻结进入控制信号**：`inbound-rtp` 的 `freezeCount` 增量与丢包同级触发加宽，
  冻结可以在零丢包时发生。隐藏标签页不做自适应（停止渲染是故意的）。
- **整条候选对消失立即判卡死**：连续 3 个采样没有选中候选对（约 3 秒）即判死，
  不必等字节超时 15 秒；差一个采样视为重协商。
- **观看端无帧会放弃而不是无限重建**：20 秒收不到画面即停止重建并提示
  （原来每约 4 秒重建一次、无限循环，且每次都让共享端新建一路编码器）。
- **永不完成 ICE 的连接会被关闭**：`connecting` 超过 20 秒即清理
  （原来只清 `failed`，一个永远连不上的观看者能占着编码资源活到共享结束）。
- **离开的观看者不再产生关键帧风暴**：写失败只在连续错误序列的**第一次**请求关键帧；
  原来每帧都请求，等于每秒 2 个无效 IDR，全部混在同一条码流里由所有活着的观看者买单。
- **共享端出向连接不再跑接收侧逻辑**：恢复流程与卡死判定只对「有入向视频轨」的连接生效
  （互相共享时两条方向落在同一个 PC 上，判据是 `getReceivers()` 而不是「我加过 sender」）。
- **观看者关页面后的残留编码器**：`failed` 10 秒后关闭；Web 端每个被遗弃观看者原来会占一路编码器。
- **静止桌面也能应答关键帧请求**（原生发送端）：编码线程原本只由采集事件驱动，静止桌面不产新帧，
  观看方丢参考帧后发的 PLI 永远没人应答 → 画面永久冻结、声音继续（用户实机反馈「1 秒后卡住」）。
  现在 `run_encoding_worker` 用 `wait_timeout(120ms)` 等待，空闲时若 `keyframe_requested` 为真且
  距上次关键帧超过 500 ms，就重编上一帧并强制 IDR。重复帧的时间戳差值为 0，`sample_duration`
  会落回 nominal，帧序号照常前进，不会被对端当重复帧丢掉。
- **码率能自己爬起来**（原生发送端）：一个远距离观看者的低 REMB 会把全场压到地板，而他离开后
  `min(estimates) × 85%` 仍然卡在低值（REMB 描述「现在送达多少」，不是「能送多少」），
  必须彻底停止再观看才恢复。现在控制器记住 `peak_bitrate_bps`（已证明能跑到的速率），
  观看者离开时立刻按「剩余估计与峰值的较大者」抬升并请求关键帧；存活期间每轮
  `probe_upward` 也以 +15% 越过上报 ceiling 试探（上限为 ceiling 的 2 倍），
  只有 ceiling 真的下降或当前值远高于 ceiling 时才退回保守。
- **线路只在开始观看时自动选一次，之后归用户**（`screenShareAutoRelay.ts` + 观看者工具栏的「连接线路」菜单）：
  每次换路都要重建 PC（约 1 秒黑屏）并让接收侧估计从冷启动，两次自动切换就会让画面「直连→中继→直连」地抖。
  现在每秒取一个诚实样本（收到的 bitrate / 丢包率 / 丢帧 / 抖动）换算 `bitsPerPixel`，只在开播后
  `screenShareStartupProbeMS`（10 秒）窗口内、连续 3 个样本且持续 4 秒劣化（1080p30 低于 0.05 bpp
  时文字必糊，6 Mbps ≈ 0.096 为健康）才从**直连切到中继一次**；越过窗口或用户已手动选择就再不动。
  菜单三档「自动 / 直连 / 中继」由用户随时切换（`setScreenSharePathPreference`，重建连接并重置启动窗口）；
  `direct` 没有对应的 ICE 策略，所以是把 TURN 服务器从配置里摘掉（`screenShareDirectIceServers`），
  没有配置 TURN 时绝不 relay-only（否则从「糊」变成「没有画面」）。
- **中继不可达时不再静默等待**：relay-only 的候选收集只有一条成功路径——TURN allocation。
  服务器 3478 或中继端口段没放行时，收集会「正常结束但一个候选都没有」，观看者只能对着黑屏
  等到 20 秒放弃。现在 `startScreenShareRelayWatch` 会盯 6 秒内是否真的拿到 `typ relay` 候选，
  没有就立刻把路径交回 ICE 并提示「中继线路不可达」，而不是让用户以为是自己网络的问题。
- **远一点就多缓一点，近一点就少缓一点**（`screenSharePlayoutDelayCeilingMS(pathKind, rttMS)`）：
  缓冲上限先按路径定（直连 150 ms / 中继 250 ms），再按选中 candidate pair 的
  `currentRoundTripTime` 调整——RTT ≥150 ms 加 100 ms，≤50 ms 减 30 ms，中间与测不到保持原值。
  远处链路的问题是帧成串到达，宁可晚 100 ms 也不要冻结；近处多半同时在用远程控制，延迟立刻被感知。
  它只改「愿意等多久」，**不改码率**——远处画面糊是档位控制器的事。

### 即时

- **共享端不再等 ICE 收集**：`set_local_description` 之后立刻发 offer（27.9 ms），候选走 trickle；
  观看端把早到的候选排队（上限 64，保留最新的 srflx/relay）。
- **切中继不再白等一秒**：webrtc-ice 的 relay 提名门槛按两端候选类型判定
  （`is_nominatable(&p.local) && is_nominatable(&p.remote)`），relay-only 观看者会让共享端吃满 1 秒，
  而 DTLS 只能在提名之后开始——这就是「切中继要等一秒多」里最先的那一秒。
  现在观看端重建前先发 `screen-share-path-hint`，共享端对 relay-only 观众把等待降到 120 ms
  （其余仍是 1000 ms：自动模式下慢速直连对还要靠它先赢）。
- **抓窗口就跟着窗口走**：窗口 resize 后按 `item.Size()` 重建 WGC 帧池；窗口关闭时置
  `closed_stop` 并结束共享（不再只写一条 `failed` 让人对着遗照）；最小化回来时超过 500 ms 的空档
  重定时间戳并恢复码率，而不是把几十秒的时间差压进一帧。
- **reconnect 期间的看门狗**：offer 到达后 9 秒协商看门狗，250 ms 补采统计。

### 可观测

- **观看端显示路径**（`screenSharePath.ts`）：`direct` / `relay` / `unknown`，
  缺数据如实显示 `unknown`，不把「测不到」显示成「直连成功」。
- **路径后缀不等首帧**：ICE 选定候选对即写入 `pathKind`，所以「已发送应答」阶段就能看到
  `· 直连` / `· 中继`；未测到时显示 `· 检测线路中`（`screenSharePathStatusSuffix`），
  重建连接会把旧答案作废。共享一直不出画面时，这是唯一能在界面上看到线路的地方；
  控制台另有 `__evScreenSharePaths()` 给出同源字段（带宽、缓冲、候选数、丢包）。
- **观看端显示实际送达分辨率**：`正在接收视频 · 1280×720 · 直连`。
  「糊」有兩種成因——编码器降了分辨率，还是共享者本来只发 720p——没有这个数字分不开。
- **共享端显示最差观看者的受限原因**（`screen-share-setup.svelte.ts`）：带宽 / CPU / 其他。
- **共享端只显示「几个人在看」**：第 105 轮起面板只留观看人数与降档人数——`N 人在观看`
  与 `N/M 使用低画质编码`。路径（`viewer_paths`）与上行估算仍留在状态接口里供诊断，
  但不再占据共享者视野：那是观看端自己的事，共享者看到也改不了。
- **共享端显示有多少观看者被降档**：原生 `viewer_layers` 统计 `low` 档人数，
  只在有人降档时显示 `N/M 使用低画质编码`——这是「远处的人进来会不会拖累我」的现场答案。
- **原生状态字段**：捕获、转发、编码、丢弃、编码器背压、观看者背压、写样本错误、ICE/DTLS 状态。
- **原生预览缩略图不再重复编码静止画面**：缩放后与上一帧逐字节比较，相同则跳过
  JPEG / base64 / IPC / 组件更新（读文档时原来每秒 8 次编码同一张图）。

### 凭证与中继

- **凭证刷新**（`rtcIceServerFreshness.ts`）：2 小时有效期，90 分钟主动刷新，
  一次共享 in-flight 请求，失败保留旧列表（过期凭证对直连仍有效）。
- **中继连接主动换血**（`screenShareRelayRotation.ts`）：凭证过期前 15 分钟重建中继连接，
  每个 peer 用稳定哈希分散到 60 秒窗口，15 分钟冷却下限。
  依据：Pion 的 Refresh **同样校验凭证**，2 小时后分配不再续约，约 10 分钟后无声冻结。

## 已知代价（有意接受）

| 代价 | 原因 | 替代方案 |
|---|---|---|
| 中继观看者每约 2 小时一次约 1 秒的重连 | TURN 没有就地重认证，凭证过期后分配必然死亡 | 静默冻结（更糟） |
| 第二档编码的 CPU（仅在有低档观看者时） | 双档是 2× 编码；Web 共享端仍是每观看者一路 | 真 simulcast（三档，webrtc-rs 发送侧不完整）、SFU |
| 低档观众的画面仍是 720p 级 | 低档只有两档可选，档间是硬切换 | simulcast / SVC 的连续分层 |

缓解（第 92/95 轮）：弱观看者自己会切到中继（`screenShareAutoRelay.ts`，只在开始观看时决策一次），
不再让整条直连陪它降质；他离开后控制器按已证明的峰值立刻回血，不必等下一次「彻底停止再观看」。
第 98 轮起再加一层：他的低估计只作用于低档编码（`viewer_layers`），近处观看者的高档码率不再跟着掉。
第 100 轮把分档依据从「绝对 2.5 Mbps」改成「相对最强观看者」：远处那个人即使报 3–6 Mbps，
只要够不着近处那个人能吃的速率，就由他自己降档，近处的码率完全不动。
| 首帧 0.18–0.76 s（直连）/ 1.27–1.29 s（中继） | ICE 检查轮次 + DTLS 协议成本 | 复用已有连接 / SFU |
| 三人以上 mesh 上行吃紧 | 上行 = N × 码率 | SFU |

## 还剩什么

### A. 代码还能做的（收益递减，风险可控）

0. **真 simulcast / 三档以上**：第 98 轮已把「一个弱观看者拖低全场」变成「他只花自己的档位」
   （双档编码，见「清晰」段），剩下的是更细的分层。真 simulcast 需要原生端在 `addTrack` 时
   声明多档 RID、由对端选层，webrtc-rs 0.17 的发送侧支持不完整；三档硬切也可以直接沿用现有
   结构（多一个编码器 + 一条阈值），代价是 CPU × 3。
1. **中继轮换改成 make-before-break**：先建新连接、等到首帧再拆旧连接，把 1 秒黑屏变成
   无缝切换。复杂度中等，需要处理两路同时解码与音频重复。
2. **语音路径的凭证刷新**：`voice-session.svelte.ts` 仍用 `voiceConnectionContext.iceServers`
   这份进频道时的拷贝；屏幕共享已经修好，语音没修。属顺手统一。
3. **空闲 CPU**：只能压缩单帧成本（预览频率 125 ms/960×540、编码复杂度），
   **不能停编码循环**（见 `screen-share-troubleshooting.md` 的不变式）。
4. **原生端真正可改画质**：现在只能提示「下次共享生效」。真做需要重建编码器 +
   对每个观看者 `replaceTrack` + 重新协商，并且失败时必须回到旧编码器而不是结束共享。
5. **Web 端共享中打开系统音频**：平台限制——已授权的 `getDisplayMedia` 无法事后附加系统音频。
   只有在采集时已带音频轨的情况下才能重新挂回（已实现）。

### A′. 已经查过、确认不用改的（避免重复劳动）

| 怀疑点 | 结论 |
|---|---|
| 扇出是否每帧拷贝 N 份 | 不是，`Bytes` 引用计数；有回归测试钉住 |
| `audio-devices` 的音量是否有跨作用域副作用 | 没有，三个作用域各写各的键 |
| HTTP 中继通道在 offer 不带候选后是否断裂 | 不断，候选作为独立信号单独 POST，服务端入队、观看端排队 |
| webrtc-rs 能否收集 ICE-TCP / UDP mux | 不能，`agent_gather` 直接过滤非 UDP，`ice_udp_mux` 无 setter |
| `ice_candidate_pool_size` 能否预热候选 | 0.17.1 里是空字段，仅存储不收集 |
| 首帧是否被「等周期性关键帧」拖慢 | 不是，Chrome 的 PLI 会自愈；~750 ms 全是 ICE+DTLS |
| 改画质是否作用到正在看的连接（Web） | 现在是（`applyScreenShareSenderSettings`）；改之前是「界面变了、编码没变」 |
| 关闭共享音频能否中途生效（Web） | 可以，摘掉 sender + 重新协商（第 54 轮）；打开则受平台限制 |
| 原生端能否中途改画质 | 码率**能**（`screen-share-max-bitrate`）、帧率**能**（`screen-share-frame-rate`，只改帧泵不重建编码器）；分辨率与内容模式不能，面板标注「下次共享生效」 |
| 预览缩略图是否随窗口焦点持续编码 | 是，但画面未变时已跳过（见「可观测」） |
| `screenShareSenders` 是否因观看者离开而残留 | 不会，close 时 `delete`、closeAll 时 `clear`；codec 负载判据读的是实时数量 |
| harness 能否当 4K 编码能力的依据 | 不能，测试页 canvas 帧源在 4K 只出 ~9.6 fps（`qualityLimitationReason: none` 说明瓶颈不在编码器） |

### B. 需要产品决策

**是否上 SFU。** 这是唯一能同时解决「大房间上行」和「首帧延迟」的结构性方案。

- 收益：上行从 N× 变成 1×，可支撑 10 人以上；新观看者不再需要独立编码；首帧可复用已有传输。
- 代价：服务器要承载媒体带宽（原来只转发信令）；需要新增媒体服务与部署形态；
  服务器可见明文（除非做不可行于 SFU 的端到端加密），需要隐私说明与开关；
  现有 TURN 中继成本从 O(观看者) 变成 O(发布者 + 观看者)。
- 参考：vdo.ninja 的「稳定多人」正是用服务端转发而不是纯 mesh。

### C. 平台 / 协议天花板

- ICE + DTLS 握手 ≈ 750 ms（本机回环，公网更高），无法在协议内消除。
- TURN 中继端口池按 PeerConnection 计：默认 49160–49460 共 **301 个**并发分配（旧默认 41 个，
  约 20 个中继参与者就耗尽）。带宽不是瓶颈（单连接实测 565 Mbit/s），端口才是容量。
  多实例部署必须端口不重叠。
- Chrome 每个 `RTCPeerConnection` 独立编码，Web 共享端 N 个观看者 = N 个编码器。
- 原生 webrtc-rs 0.17 不收集 TCP 候选、无 UDP mux、`ice_candidate_pool_size` 是空字段。

## 未验证 / 未实测

诚实清单，避免把这些当成已验证结论：

- Web 共享端立体声的**端到端听感**：只验证到 SDP 文本层，需要两个对端 + 服务器。
- HTTP 中继信号通道在「offer 不带候选」之后的行为：需要服务器环境。
- 多人 mesh 的**真实上行退化曲线**：loopback harness 测的是 CPU，不是带宽。
- Pion 分配在凭证过期后的确切死亡时刻：按协议推断约 10 分钟，未实测。
- A/V 对齐的听感：40 ms 领先是设计值，未做主观评测。
- **双档编码的双人实机效果**：`viewer_layers` 路由、相对降/升档与低档回收都有单测与不变式覆盖，
  但「近处的人画面不再跟着掉」只能在两个真实观看者（一近一远）的实机上验证；
  本机 harness 只有一个观看者，因此它只证明了单档路径没有回归。
- **「连接线路」菜单的真实切换**：三档偏好、摘 TURN 与重建连接都有单测与不变式覆盖，
  但「点完菜单后画面确实换了路」需要一次真实会话（尤其要确认 relay → direct 之后不再偷偷回到中继）。
- **`auto` 码率预算上调后的实际观感**：5.6 Mbps @1080p30 是计算值，动态画面是否够清晰依赖内容，
  需要实机对比一次（这也是唯一会推高上行占用的改动）。
- **抓窗口的三个生命周期行为**（resize 重建帧池、关闭即停共享、最小化空档重定时间戳）只有
  Rust 单测与结构不变式覆盖，`item.Size()` 在缩放过程中的真实时序、以及 DWM 恢复后第一帧的
  观感（是否还有轻微跳动）都需要实机确认。
- **切中继的实际耗时**：120 ms 的 relay 等待是按 webrtc-ice 源码推导的下限，本机验收门只覆盖
  「一开始就走中继」，没有覆盖「直连 → 手动切中继」这条重建路径，切换后到首帧的真实毫秒数未测。
- **按 RTT 调缓冲的观感**：远端「更稳」、近端「更跟手」是设计目标，未做主观对比。

## 如何验证

```powershell
# 前端单元套件（27 个屏共享相关 node 套件，含 remote-audio / rtc 两组）
npm --prefix apps/desktop run test:screen-share-playout
npm --prefix apps/desktop run test:screen-share-liveness
npm --prefix apps/desktop run test:screen-share-ice-restart
npm --prefix apps/desktop run test:screen-share-relay-rotation
npm --prefix apps/desktop run test:screen-share-codec-parity
npm --prefix apps/desktop run test:screen-share-setting-scope
npm --prefix apps/desktop run test:screen-share-auto-relay       # 自动择优决策（13 条）
npm --prefix apps/desktop run test:screen-share-path-hint        # 线路提示的暂存与消费（4 条）
npm --prefix apps/desktop run test:screen-share-invariants   # 结构不变式，读源码不跑行为（26 条）
# …以及 path / stream-label / viewer-paths / peer-direction / audio-scope / audio-sdp /
#     settings / webrtc / viewers / remote-audio-channels / rtc-ice-server-freshness /
#     browser-rtc-configuration / uplink / identities

# Rust
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml   # 83 passed
cargo fmt --all -- --check

# 服务器（信令上限、中继端口池、中继吞吐/容量实测）
cd services/ev-server; go test ./...; go test ./internal/mediarelay -run TestEmbeddedTURNRelayThroughputAndCapacity -v

# 验收门：真实 Chrome ↔ 原生发送端（不需要服务器）
npm --prefix apps/desktop run test:screen-share-browser
node apps/desktop/scripts/screen-share-browser-interop.mjs --web-only 42e020 1920 1080 60

# 中继路径（本机 TURN，不需要 ev-server）
go run ./cmd/turndev            # 在 services/ev-server 下，监听 udp 3478
$env:EV_SCREEN_SHARE_BROWSER_ICE_SERVERS = '[{"urls":["turn:127.0.0.1:3478?transport=udp"],"username":"ev","credential":"evpass"}]'
npm --prefix apps/desktop run test:screen-share-browser   # 断言 viewerPaths 必须是 relay
```

## 变更简表

| 轮次 | 改动 |
|---|---|
| 1 | 观看端自适应播放缓冲；`contentHint` 修正 |
| 2 | 原生 H.264 Baseline → High（CABAC） |
| 3 | 码率下调 1.2 秒确认窗口；静止画面不再误判卡死 |
| 4 | 背压下调限速；关键帧请求节流 |
| 5 | 音画播放延迟对齐（音频领先 40 ms） |
| 6 | 观看端路径显示（直连 / 中继） |
| 7 | `bundlePolicy: max-bundle`；单一 RTC 配置实现 |
| 8 | 首帧读数更正；限制解除后码率立即回满 |
| 9 | ICE restart 代替整条重建（Web 共享端） |
| 10 | 原生共享端接入 ICE restart |
| 11 | 首帧指标进 harness；RTCP 读取错误不再永久退出循环 |
| 12 | offer 不再等 ICE 收集（250 ms → 27.9 ms） |
| 13 | TURN 凭证刷新（90 分钟窗口） |
| 14 | 凭证过期前主动换中继连接 |
| 15 | 扇出引用计数验证；丢帧计数语义修正 |
| 16 | Web 共享端声音改立体声 160 kbps |
| 17 | 码率天花板双向服从；最后观看者离开时复位 |
| 18 | 两条不变式进文档；跨端 Opus 参数一致性测试 |
| 19 | 现状清单文档（本文件） |
| 20 | 原生共享端每观看者路径（`viewer_paths`） |
| 21 | Web 共享端每观看者路径 |
| 22 | 出向连接不再跑接收侧逻辑；`viewer_paths` 随 RemoveViewer 清理 |
| 23 | 混音器立体声降混修复；WebAudio 路径成员枚举修复 |
| 24 | 结束共享不再误杀该成员语音（scope 丢失） |
| 25 | 播放链审计（两处否证）；`Map`/`Set` 类型修正；转发 scope 源码级防线 |
| 26 | 中继路径 250 ms 播放缓冲（音频同上限）；`freezeCount` 进控制信号 |
| 27 | 同上验证与汇报 |
| 28 | 整条候选对消失 3 采样即判死 |
| 29 | 观看者关页面后共享端清理残留连接（10 秒） |
| 30 | 写失败只在错误序列首次请求关键帧（消除全场 IDR 风暴） |
| 31 | 发现 `test:screen-share-browser` 不需要服务器 |
| 32 | 原生状态不变量进 harness 断言；验收文档化 |
| 33 | 回归清扫；「最小验收」写入 troubleshooting |
| 34 | 观看端无帧 20 秒放弃重建（消除无限重连） |
| 35 | 永不完成 ICE 的连接 20 秒后关闭 |
| 36 | 预览缩略图对静止画面跳过编码/IPC |
| 37 | 观看端显示实际送达分辨率 |
| 38 | 本文档补到第 37 轮 |
| 39 | 本机 TURN 验证中继路径（`cmd/turndev` + `EV_SCREEN_SHARE_BROWSER_ICE_SERVERS`） |
| 40 | 核查 `screenShareSenders` 无残留；发现 harness 4K 上限 |
| 41 | 原生共享音频 fmtp 从未进 SDP（一直单声道）→ 注册进 MediaEngine |
| 42 | H.264 profile 同样从未进 SDP → 注册进 MediaEngine；顺带修复 `cfg(test)` 掩盖的 release 构建错误 |
| 43 | RTCP feedback（nack/pli/remb）进 wire 断言 |
| 44 | SFU 决策材料（A/B/C 三选项） |
| 45 | 共享端显示上行总和（每位观看者码率之和） |
| 46 | 播放缓冲「写后读回确认」 |
| 47 | 上行估算补判断（超 20 Mbps 提示可能打满上行） |
| 48 | 观看端显示实际送达帧率 |
| 49 | 中继路径重新验证（只慢在建连） |
| 50 | harness 补上候选 trickle（`appliedIceCandidateCount` 从 0 变真） |
| 51 | 改画质实时作用到在跑的 sender（Web） |
| 52 | 原生端改画质只能下次生效，面板如实标注 |
| 53 | 共享音频与光标开关同属一类；防线扩到 6 个入口 |
| 54 | Web 中途关共享音频（摘 sender + 重协商）；开则受平台限制 |
| 55 | 全量回归：直连与中继两条路径 |
| 56 | 文档补齐第 38–55 轮；修掉 A′ 表里已过期的一条结论 |
| 57 | 共享中改分辨率现在真的改采集（此前只改码率） |
| 58 | 「下次生效」提示不再跨会话残留 |
| 59 | 更正：码率在原生端本来就可以实时改 |
| 60 | 原生共享中改码率立即生效（`screen-share-max-bitrate`） |
| 61 | 真实浏览器上验证中途降码率后观看者继续解码 |
| 62 | 共享前显示「每位观看者 X Mbps」 |
| 63 | 结构不变式测试：6 条 |
| 64 | 不变式扩到 8 条（含 codec 注册顺序与 fmtp 单一来源） |
| 65 | 身份解析规则集中到 `screenShareIdentities.ts`（10 条断言） |
| 66 | 六连跑确认偶发失败未复现；证伪「预览空转」假设 |
| 67 | 测量矩阵补齐（720p60 直连、1080p30 直连、1080p30 中继） |
| 68 | 两观看者扇出端到端（进程内 0.4 秒） |
| 69 | 受限原因附一条可执行建议（降码率 / 降帧率） |
| 70 | 原生缩放从点采样改面积平均（默认 720p 预设下文字不再闪） |
| 71 | 预览缩略图改用同一箱式滤波（预览不再出现编码流里没有的锯齿） |
| 72 | 实测面积平均成本（4K→1080p 每帧 3.16 ms），留下 `--ignored` 计时探针 |
| 73 | 首帧分段测量：中继的额外 1.5 s 全在 DTLS（allocation 117 ms、ICE 与直连相同），推翻「分配慢」的旧判断 |
| 74 | 验收门改成「先回 answer、再交候选」（与生产同序）；确认中继 DTLS 的 1.75 s 不是脚手架假象 |
| 75 | 候选交付收到 10 ms 仍不改变中继 DTLS（2059–2261 ms）→ 排除「交付慢」这一解释 |
| 76 | 试拆「单边中继」失败：有 host 候选时 ICE 总选直连；确认上述中继数字的前提是两端都在中继上 |
| 77 | 中继首帧慢的根因是 webrtc-ice 的 relay 提名等待 2 s → 改 1 s，中继首帧 2.35 s → 1.34 s |
| 78 | 给这条设置加结构不变式（第 9 条），并重新实测套件与断言数 |
| 79 | 验收门加 `first frame < 2000 ms`（中继侧）断言，把这次修复钉在端到端路径上 |
| 80 | `prflx` 提名等待 1000 → 500 ms：直连首帧慢分支 1300 → 700–890 ms（日志证明慢在那 1 秒门槛） |
| 81 | 重测基线：直连 184–759 ms（中位 684）、中继 1270–1291 ms；文档里的旧数字全部替换 |
| 82 | 设置面板显示屏幕实际尺寸（仅当预设确实在缩小画面时） |
| 83 | 复测直连 5 次 / 中继 3 次，把中继残差锁定为 1 s 提名闸门 |
| 84 | 全量验证（41 个脚本），并记下两条与本功能无关的红套件 |
| 85 | 原生共享中改帧率立即生效（只改帧泵，不重建编码器、不重协商） |
| 86 | 放弃重试后可直接重试，不必先按「停止观看」 |
| 87 | 实机：Web 共享端在 `setLocalDescription` 前应用编码参数 → 抛错被空 catch 吞掉、永不出 offer |
| 88 | 实机根因：`ScreenShareTransportController` 少接线两个 hook（`rtcIceConfigFetchedAtMS` / `ensureFreshRTCConfig`），共享端建 PC 第一步就抛 TypeError |
| 89 | 全量 hook 接线复核（7 个控制器）；`watchDecisions` 在正式构建也挂；凭证失败不再中断应答 |
| 90 | 测试台补 TURN 开启形态（`EV_E2E_TURN_ENABLED`）；Web 观看失败的提示不再只写日志 |
| 91 | 服务端：信令 `SetReadLimit` 1 MiB（库默认 32 KiB 会在协商中途 1009 断连）、队列 1024/2048、中继端口池 41 → 301 |
| 92 | 原生码率控制器记住峰值：观看者离开立即抬升、存活期间 +15% 越过 REMB 探测 |
| 93 | 原生编码器空闲 120 ms 唤醒应答关键帧（静止桌面冻结但声音继续） |
| 94 | 屏共享重协商失败不再把整条语音标 failed（并删掉那个 hook） |
| 95 | 观看端自动择优：bpp/丢包判劣化 → 4 秒后切中继，8 秒无帧回退，两向各一次 |
| 96 | 中继不可达不再静默等 20 秒：6 秒内没有 `typ relay` 候选就交回 ICE 并提示，同时记进 `watchDecisions` |
| 97 | 复测中继路径首帧 **1276 ms**（417 解码帧、0 丢帧、`viewerPaths: relay`），确认门槛修复与空闲关键帧都没回退 |
| — | 服务器带宽说明与压测（单中继 565 Mbit/s、端口池即容量；只写文档与测试，未改运行时） |
| 98 | 双档编码：弱观看者只订阅低档（720p 级 / 1.5–2.5 Mbps），不再拉低全场码率；最后一个高档观众不许降档、低档无人时编码器回收；共享端显示 `N/M 使用低画质编码` |
| 99 | 早于 answer 的 ICE 候选不再被 `ErrNoRemoteDescription` 丢掉：按连接真实状态暂存，answer 落地后补应用（顺带修掉一个既有集成测试的竞态） |
| 100 | 双档改「相对速率」：参考值 = min(配置上限, 最强观看者估计)，够不着它的 85% 才降档、连续两次到 95% 才升档，**最强的那位永不降档**；低档尺寸改为 1280×720 上限（不再砍到半尺寸）；`auto` 码率预算上调 33%（1080p30 balanced 4.35 → 5.6 Mbps） |
| 101 | 自动择优改成「只在开始观看时决策一次」：10 秒启动窗口内、连续 3 样本 × 4 秒劣化才直连→中继，越过窗口即不再自动切换；观看者工具栏新增「连接线路」菜单（自动 / 直连 / 中继），`direct` 通过摘掉 TURN 服务器实现，`startScreenShareRelayWatch` 的兜底改为设 `direct` |
| 102 | 切中继不再黑屏 1.3 秒：观看端先发 `screen-share-path-hint`，共享端对 relay-only 观众把 webrtc-ice 的 relay 提名等待从 1000 ms 降到 120 ms（两端都要过门槛，省下的是 DTLS 之前那一秒） |
| 103 | 按距离调播放缓冲：选中 candidate pair 的 `currentRoundTripTime` ≥150 ms 时上限 +100 ms、≤50 ms 时 −30 ms，中间与测不到都保持原值（只改观看端愿意等多久，不动码率） |
| 104 | 抓窗口的生命周期修好：窗口 resize 后按 `item.Size()` 重建 WGC 帧池（此前画面停在旧比例）、窗口关闭真的停止采集并结束共享（此前只置 `failed`）、最小化恢复的空档重定时间戳并恢复码率（此前观看端画面猛跳 + 长时间低码率） |
| 105 | 共享端面板只回「N 人在观看」+ 低画质人数，不再显示路径与上行估算；预览缩略图修掉红蓝互换（`average_bgra_block` 返回 R,G,B 却按 B,G,R 写出） |
| 106 | 窗口共享的宽高比与生命周期：缩放改为 letterbox（等比 + 黑边，不再拉伸）、`IsWindow` 看护兜住不投递的 `Closed` 事件（前端最多重试 3 次停止）、最小化空档改为累积 `timeline_offset_ns` 平移整条时间轴（不再逐帧重定）、延迟预算改为端到端阶梯（RTT ≤50 ms → 80 ms，>200 ms → 1000 ms，直接花掉而不是慢慢爬） |
