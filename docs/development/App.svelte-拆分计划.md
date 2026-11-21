# App.svelte 拆分计划

> 目标：把 `apps/desktop/src/App.svelte` 从“单一巨型组件”收敛为“薄壳组件 + 领域控制器
> + 视图组件”，使每个文件都能在半小时内完成阅读与单点修改。
>
> 状态：**已达标**。App.svelte 已从约 24,000 行降至 **4,473 行**（script 3,479 / 主壳 294 / 剩余悬浮层 656，含可读性空行）。
> 领域控制器与视图组件已全部抽出，剩余的 legacy alias 主要是
> `(realtimeSyncTick, controller.x)` 模板别名，用于 App 顶层 legacy 模板的 100ms 刷新语义。

## 1. 现状测量

文件：`apps/desktop/src/App.svelte`

| 指标 | 数值 |
| --- | --- |
| 物理行数 | **4,346**（起始 24,083，缩减约 82%） |
| `<script>` 行数 | 1–3,376 |
| 标记行数 | 3,377–4,346（约 970 行） |
| `<main>` 壳 | 约 298 行（其余面板均在 components/） |
| 根级悬浮层剩余 | 约 752 行（上下文菜单、appDialog、crop 块等） |
| 组件数 | src/components 41 个 |
| .svelte.ts 控制器 | src/lib 21 个 |
| 剩余函数 / `$:` alias | 99 / 245 |

> 剩余 245 个 alias 大多是 App legacy 模板必需的 `(realtimeSyncTick, controller.x)`
> 刷新别名；继续下降需要把 App 顶层模板也迁到 runes 子组件，属可选优化。

> 说明：下文“剩余逻辑簇”与“阶段 F 组件表”里的行号是拆分早期基线的近似值，
> 已随各阶段偏移；当前文件优先按函数名、组件名或文件内分区注释定位。

## 2. 当前架构与既定模式

仓库已经在使用 `lib/*.svelte.ts` 控制器模式，这是后续拆分的唯一标准做法：

- `.svelte.ts` 扩展名使 Svelte 5 rune 编译器在类字段上启用 `$state`；
- 控制器拥有**领域状态**与**领域操作**（API 调用、定时器、状态机）；
- 组件通过 **hooks 对象**注入跨领域副作用（惰性箭头函数，避免 TDZ 与循环导入）；
- `App.svelte` 保留同名的 `$:` alias，供现有模板继续读取；
- 热路径（事件、WebRTC 信令）直接读控制器字段，不读 100ms 刷新的 alias。

已完成迁移（当前未提交的控制器）：

| 控制器 | 文件 | 行数 |
| --- | --- | --- |
| VoiceStateController | `lib/voice-state.svelte.ts` | 477 |
| VoiceSessionController | `lib/voice-session.svelte.ts` | 1,047 |
| ChannelsController | `lib/channels.svelte.ts` | 909 |
| ChannelFilesController | `lib/channel-files.svelte.ts` | 624 |
| MessagesController | `lib/messages.svelte.ts` | 502 |
| PermissionsController | `lib/permissions.svelte.ts` | 817 |
| ServerSettingsController | `lib/server-settings.svelte.ts` | 502 |
| ScreenShareController | `lib/screen-share.svelte.ts` | 727 |
| RemoteControlController | `lib/remote-control.svelte.ts` | 789 |
| SoundboardController | `lib/soundboard.svelte.ts` | 905 |
| EmojiController | `lib/emoji.svelte.ts` | 1,508 |
| ServerRailController | `lib/server-rail.svelte.ts` | 669 |
| AccompanimentController | `lib/accompaniment.svelte.ts` | 887 |
| ChatComposerController | `lib/composer.svelte.ts` | 1,779 |
| ScreenShareSetupController | `lib/screen-share-setup.svelte.ts` | 1,093 |
| ScreenShareTransportController | `lib/screen-share-transport.svelte.ts` | 2,193 |
| AudioDevicesController | `lib/audio-devices.svelte.ts` | 1,480 |
| NativeVoiceController | `lib/native-voice.svelte.ts` | 748 |

这些迁移已经移除约 9,500 行，证明该模式可以继续推进。

## 3. 拆分原则

1. **领域优先，UI 后置**：先抽逻辑控制器，再抽视图组件。逻辑边界稳定后，组件拆分只是搬运模板。
2. **一次一个领域，禁止混入行为修改**：每个阶段只做机械搬迁 + 最小适配，不顺手改 bug、不改文案、不改交互。
3. **控制器不反向导入 App.svelte**：跨领域影响通过 hooks 注入；纯工具逻辑放到 `lib/`。
4. **过渡期保留同名 wrapper**：`function x() { return controller.x(); }` 形式的薄封装先保留，等模板也抽走后删除。
5. **样式暂不搬迁**：组件先继续使用 `app.css` 中的全局 class，避免视觉回归；待组件稳定后再逐段把专属 CSS 挪进 `<style>`。
6. **每个文件目标行数**：控制器 ≤ 1,000 行；视图组件 ≤ 500 行；`App.svelte` 最终 ≤ 5,000 行。
7. **不引入新的浏览器原生控件**，继续遵守 `AGENTS.md`（EchoVoice 对话框、NumericInput、自定义菜单、i18n 双语言等）。

## 4. 剩余逻辑簇（按行号）

这些范围是后续阶段的工作清单；函数与状态在文件内基本连续成簇。

| 行号 | 内容 | 建议去向 |
| --- | --- | --- |
| 2–367 | import（API、存储、各 lib） | 随各领域迁入对应控制器 |
| 369–421 | 常量与运行时标志 | 拆入各自领域模块；仅 shell 级常量保留 |
| 422–562 | 组件本地类型与静态 UI 配置 | 随所属功能迁出（emoji、soundboard、dialog 等） |
| 563–617 | 身份、连接、服务端、基础状态 | `WorkspaceController` |
| 618–1,680 | 控制器组合与 `$:` alias | 保留在 App.svelte，作为装配层 |
| 682–720, 2,613–4,480 | 富文本输入框、附件、撤销栈、消息编辑 | `ComposerController` / `ChatController` |
| 727–753, 16,179–16,656 | 服务器栏状态、拖拽、右键菜单、布局持久化 | `ServerRailController` |
| 845–849, 2,613–3,530 相关 | 未读数、消息发送、跳转、搜索 | `MessagesController`（继续扩充） |
| 859–865, 1,681–1,699, 9,665–10,149 | 伴奏（Web/桌面） | `AccompanimentController` |
| 866–900, 10,152–10,876 | Soundboard：库、编辑器、播放、音量 | `SoundboardController` |
| 901–949, 10,878–12,039 | Emoji：库、选择器、自动补全、管理、资产缓存 | `EmojiController` |
| 950–1,123, 12,041–12,624 | 屏幕共享设置/源选择/会话启动 UI | `ScreenShareSetupController` 或并入 ScreenShare 域 |
| 1,914–1,933, 7,990–9,250, 14,219–14,960 | 屏幕共享 WebRTC 网格、原生 sender、信号轮询、统计 | `ScreenShareTransportController` |
| 1,010–1,081, 13,125–14,218, 15,684–16,112 | 音频设备、音量、麦克风/耳机测试、远端播放 | `AudioDevicesController` + `AudioTestController` |
| 1,069–1,081, 14,987–15,682 | 原生语音会话、状态轮询、恢复 | `NativeVoiceController` |
| 1,702–1,728, 6,472–7,623 | 事件 socket、心跳、重连、会话恢复、事件分发 | `RealtimeController` |
| 1,729–1,744, 2,122–2,459 | 权限缓存与 `$:` 派生视图状态 | 随模板迁移到视图组件；权限数据继续留在 PermissionsController |
| 1,745–1,933 | 剩余类型、权限常量、传输 Map | 拆入对应 `types.ts` / 控制器 |
| 1,935–2,466 | 对话框、i18n 包装、连接、基础消息/文件操作 | `WorkspaceController` / `AppDialogController` |
| 2,467–3,534 | connectToServer、消息发送、频道文件 | `WorkspaceController` / `MessagesController` / `ChannelFilesController` |
| 3,535–4,480 | composer、消息列表滚动、消息编辑 | `ComposerController` / `ChatController` |
| 4,480–5,338 | loadWorkspace、profile、server settings、invite | `WorkspaceController` / 扩充 ServerSettingsController |
| 5,339–6,471 | 频道列表交互、拖拽、右键菜单 | `ChannelsController`（继续扩充） |
| 7,624–7,989 | 语音状态 mutation、远程控制薄封装 | `VoiceStateController` / `RemoteControlController` |
| 9,247–10,149 | 语音台视图、加入/离开频道、伴奏 | `VoiceStageController` / `AccompanimentController` |
| 12,623–13,124 | 成员、角色、权限 UI 动作 | `MembersController` / 扩充 PermissionsController |
| 16,114–17,021 | 存储迁移、服务器栏、布局、语言、诊断 | `ServerRailController` / `LayoutController` / `StorageController` |
| 17,023–17,163 | DEV 诊断与生命周期 | 保留在 App.svelte，最终只做装配 |

## 5. 执行阶段

### 阶段 A：标注与守护（当前已完成部分）

- [x] 在 App.svelte 顶部与关键分区加入维护注释；
- [x] 产出本拆分计划；
- [ ] 可选：写 `scripts/app-size-guard.mjs`，在 CI 中校验 App.svelte ≤ 当前值，
      每次合并前必须下降或持平，防止回潮。

### 阶段 B：独立功能控制器（低风险，收益高）

按依赖关系依次执行，预计可减 4,000–5,000 行：

1. **SoundboardController**（`lib/soundboard.svelte.ts`）✅ 已完成
   搬迁 866–900 状态 + 10,152–10,876 函数；保留音频元素注册与播放 hooks。
2. **EmojiController**（`lib/emoji.svelte.ts`）✅ 已完成
   搬迁 901–949 状态 + 10,878–12,039 函数；与 `lib/emoji.ts` 纯工具分开，
   控制器管状态/API，纯工具管解析与目录。
3. **AccompanimentController**（`lib/accompaniment.svelte.ts`）✅ 已完成
   搬迁 859–865、1,681–1,699 状态 + 9,665–10,149 函数；WebAudio 图保持为控制器内部字段。
4. **ServerRailController**（`lib/server-rail.svelte.ts`）✅ 已完成
   搬迁 727–753 状态 + 16,179–16,656 函数；`lib/serverRail.ts` 继续只放纯布局算法。
5. **AppDialogController**（`lib/app-dialog.svelte.ts`，可选）
   搬迁 528–562 类型 + 768–772 状态 + 1,955–2,058 函数，供各控制器统一调用
   `showAppConfirm / showAppPrompt / showAppAlert`。

验收：`npm run build` + `test:workspace-browser`（基础路径）；
相关领域测试：`test:soundboard-browser`、`test:emoji-browser`、
`test:web-accompaniment-browser`、`test:server-rail-browser`。

### 阶段 C：实时连接层

1. **RealtimeController**（`lib/realtime.svelte.ts`）
   搬迁 1,702–1,728 状态 + 6,472–7,623 函数：
   - workspace event socket：连接、重连、心跳、会话失效恢复；
   - voice event socket：连接、心跳、speaking 状态队列；
   - `handleServerEvent` 中与 socket 无关的领域合并函数仍留在各控制器，
     通过 hooks 回调。
2. **WorkspaceController**（`lib/workspace.svelte.ts`）
   搬迁 563–617 基础状态 + 2,467–5,338 中的连接/加载/profile/settings 部分。
   依赖 RealtimeController，但只通过 hooks 组装。

验收：`test:session-reconnect-browser`、`test:background-recovery-browser`、
`test:api-compat`、`build`。必须同时验证浏览器与 Tauri 两条路径。

### 阶段 D：媒体传输层（最高风险，单独小步提交）

这部分涉及 WebRTC 与原生 Tauri，按“状态机 → 统计/信令 → 采集/渲染”拆：

1. **ScreenShareTransportController**（`lib/screen-share-transport.svelte.ts`）
   先迁 1,914–1,933 的传输注册表与 7,990–9,250 的 viewer/native-sender/信令轮询；
   再迁 14,219–14,960 的 WebRTC offer/answer/ICE、统计与重协商。
2. **NativeVoiceController**（`lib/native-voice.svelte.ts`）
   迁 1,069–1,081 状态 + 14,987–15,682 原生语音函数。
3. **AudioDevicesController** 与 **AudioTestController**
   迁 1,010–1,081 + 13,125–14,218 + 15,684–16,112；
   把 `lib/remote-audio.ts` 的 RemoteVoiceMixer 作为注入依赖。

验收（每步都跑）：
`test:screen-share-browser`、`test:remote-control-browser`、
`test:native-voice-session`、`test:web-voice-audio-browser`、
`test:screen-share-audio-browser`、`build`；
并在 Tauri 实际运行一次“原生屏幕共享 + 原生语音”。

### 阶段 E：聊天与输入框

1. **ComposerController**（`lib/composer.svelte.ts`）
   迁 682–720 状态 + 3,535–4,480 中 composer/消息编辑函数；
   DOM 元素引用通过 `bind:this` 在组件里回写 hooks。
2. **MessageMediaController** 或并入 MessagesController
   迁消息附件/图片预览、objectURL 生命周期（约 3,182–3,530）。
3. 未读数持久化迁入 MessagesController。

验收：`test:workspace-browser`、`test:file-storage-browser`、
`test:message-attachments`、`test:channels`、`build`。

### 阶段 F：标记组件化

先拆**根级悬浮层**（最独立，改动最安全），再拆**主面板**：

第一批（20,026–23,933 悬浮层，约 3,900 行）：

| 组件 | 原行号 |
| --- | --- |
| `ServerContextMenu.svelte` / `ServerFolderContextMenu.svelte` | 20,026–20,051 |
| `AppDialog.svelte` | 20,053–20,149 |
| `AccompanimentDialog.svelte` | 20,151–20,278 |
| `SoundboardPopover.svelte` / `SoundboardEditorDialog.svelte` | 20,280–20,581 |
| `EmojiPickerPopover.svelte` / `EmojiDetailDialog.svelte` | 20,583–20,734 |
| `ScreenShareSetupDialog.svelte` / `ScreenShareSourceDialog.svelte` + 菜单 | 20,736–21,046 |
| `FilePreviewDialog.svelte` / 拖拽预览 | 21,090–21,229 |
| `VoiceParticipantContextMenu.svelte` / 拖拽预览 | 21,231–21,467 |
| `ServerProfileDialog.svelte` / `ServerDetailsDialog.svelte` / `ServerSettingsDialog.svelte` | 21,469–22,610 |
| `ChannelSettingsDialog.svelte` / `ChannelPermissionTargetPicker.svelte` | 22,612–22,934 |
| `AppSettingsDialog.svelte` / `OnboardingDialog.svelte` | 22,936–23,509 |
| `EmojiAddDialog.svelte` / `InviteDialog.svelte` / `GeneratedInviteDialog.svelte` / `ConnectDialog.svelte` / `PendingChannelWarningDialog.svelte` / `ChannelDialog.svelte` | 23,511–23,933 |

第二批（主 shell，17,274–20,024）：

| 组件 | 原行号 |
| --- | --- |
| `DesktopTitleBar.svelte` | 17,174–17,211 |
| `RemoteControlHostBanner.svelte` | 17,213–17,262 |
| `ServerRail.svelte` | 17,332–17,570 |
| `HomeEmptyState.svelte` / `WorkspaceReconnectState.svelte` | 17,572–17,616 |
| `ChannelSidebar.svelte` | 17,618–17,984 |
| `UserPanel.svelte` | 17,986–18,300 |
| `MemberPanel.svelte` | 19,932–20,023 |
| `ChatPanel.svelte`（最后拆，内部再分 header/list/composer/files/voice-stage） | 18,302–19,881 |

组件通信约定：
- 控制器实例继续由 App.svelte 创建，通过 props 传入组件；
- 或使用模块级单例（仅限真正全局的控制器）并直接 import；
- 禁止组件回调里重新实现业务逻辑；组件只翻译事件到控制器方法。
- 弹出层必须继续遵守 AGENTS.md：锚定触发器、不增加页面滚动、Escape 关闭、
  点击外部关闭、保持全局滚动条主题。

验收：每拆一个组件运行 `test:workspace-browser` 对应路径 + `build`；
交互变更使用真实浏览器自动化测试覆盖；Tauri 路径抽查桌面窗口/弹出窗口行为。

### 阶段 G：收尾

1. 删除已无调用方的 legacy `$:` alias 与薄 wrapper；
2. 把 `app.css` 中专属段落逐步搬进组件 `<style>`；
3. 重估每个控制器是否应拆成“数据层（ts）+ 状态层（svelte.ts）+ 视图（svelte）”；
4. 全面回归：`test:workspace-browser` 全量、Tauri 手工清单（语音、屏幕共享、
   远程控制、文件、Soundboard、Emoji、设置）；
5. 更新本文档的最终测量值。

## 6. 目标结果

| 阶段 | App.svelte 预计行数 |
| --- | --- |
| 起始 | 24,083 |
| 控制器抽取完成 | ≈ 8,250 |
| 悬浮层/主壳组件化 + wrapper/alias 清理后（实际最终值） | **4,346** |

每个新模块的验收标准：

- 有 5–10 行文件头注释：职责、依赖方向、生命周期；
- 纯函数可单测；涉及浏览器/Tauri 的行为有对应自动化脚本；
- 不直接 import App.svelte；跨域副作用走 hooks；
- 用户可见字符串全部走 i18n；
- 通过 `npm run build` 与相关测试后再提交。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| legacy `$:` alias 只按 100ms 刷新 | 拆分时明确区分“模板读取”与“热路径读取”；注释必须保留 |
| WebRTC/原生 Tauri 回归 | 阶段 D 每步小提交，先跑现有 browser/unit 测试，再手工 Tauri 冒烟 |
| 悬浮层被组件化后定位/层级变化 | 保持原 class 名与 DOM 结构；不引入新包裹元素；先只抽结构不抽样式 |
| 大批移动导致合并冲突 | 一个阶段一个提交；避免与其他功能分支并行改 App.svelte |
| 模板与状态高度耦合（bind:this、DOM 编辑） | composer/文件/信令 DOM 引用全部经 hooks 回写，组件只当宿主 |
| 全局 CSS 与组件 `<style>` 双源冲突 | 阶段 G 之前样式不搬迁 |
