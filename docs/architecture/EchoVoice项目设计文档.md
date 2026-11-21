# EchoVoice 项目设计文档

版本：v0.3  
日期：2026-06-28  
来源：基于项目需求整理与工程设计

## 1. 项目定位

EchoVoice，简称 EV，是一个类似 Discord + TeamSpeak 的开源语音协作软件。核心目标是先在 Windows、macOS、Linux 上提供小巧、低内存、体验一致的桌面客户端，并允许任何用户自行部署服务器。Android、iOS、HarmonyOS 作为后续移动端平台规划。

EV 的产品方向不是做一个完全依赖中心平台的聊天应用，而是以“自建服务器”为基础，通过可选的 StarEcho 平台保存跨设备信息，实现轻度中心化体验。

## 2. 核心目标

1. 桌面优先：先完成一套 Windows、macOS、Linux 桌面客户端。
2. 可自建：用户可以自行部署 EV Server，其他用户通过 IP、端口、密码连接。
3. 轻度中心化：StarEcho 只保存用户愿意同步的资料，例如服务器列表、头像、昵称、简介。
4. Discord-like 信息架构：服务器列表、服务器文件夹、文字频道、语音频道、成员列表、权限组。
5. Material-like 风格 UI：默认黑色主题，内置白色主题，并支持用户自定义主题色。
6. 语音优先：语音频道、管理员拖拽成员、临时语音频道、静音、禁言、移动成员。
7. 可扩展媒体能力：屏幕共享、远程控制、播放音乐可由服务器 owner 开关控制，并受权限系统限制。
8. 内容扩展能力：支持声音板、表情包、频道文件存储，并使用内容寻址缓存减少跨服务器重复传输。
9. 语音内协作：语音频道右侧提供消息入口，允许在当前语音频道作用域内发送文字、表情和上传文件，不额外创建独立文字频道。
10. 私密通信：支持全局用户身份、好友、私聊、私下语音，以及去中心化离线消息投递。
11. 共享核心：协议、权限、缓存、服务器列表、好友关系、加密 envelope 等核心逻辑沉淀到 Rust core，减少未来移动端重复实现。
12. 移动端后置：Android、iOS、HarmonyOS 不进入 MVP 主线，但在架构上预留平台壳接入能力。
13. 开源友好：服务端单机可运行，后续可扩展到 Docker、NAS、小型 VPS、家庭服务器。

## 3. 非目标

第一阶段不追求以下能力：

1. 不做全球公共服务器大厅。
2. 不强制使用中心账号登录。
3. 不在 MVP 阶段实现端到端加密。
4. 不在 MVP 阶段支持超大规模群组或万人级语音房。
5. 不在 MVP 阶段实现完整的机器人生态与插件市场。
6. 不在 MVP 阶段实现跨服务器离线私聊、home relay 或多设备私聊同步。

这些能力可以作为后续路线规划，不应阻塞核心自建语音服务器的实现。

## 4. 总体技术框架

### 4.1 推荐技术栈

| 层级 | 推荐方案 | 选择原因 |
| --- | --- | --- |
| 桌面客户端壳 | Tauri 2 + Rust | 安装包小，不自带 Chromium，适合低内存桌面应用 |
| 桌面 UI | Svelte + TypeScript | 编译型 UI 框架，运行时负担较轻，适合构建 Discord-like 面板界面 |
| 共享核心 | Rust workspace | 协议、权限、缓存、状态机、本地存储逻辑可沉淀为跨平台核心库 |
| 客户端状态管理 | Svelte stores + Rust core state | UI 状态留在 Svelte，业务状态和复杂状态机放在 Rust core |
| 客户端本地存储 | SQLite + OS keyring | SQLite 保存服务器列表和缓存；系统 keyring 保存 uuid/key 等敏感凭证 |
| 实时媒体 | WebRTC + Opus，优先桌面验证 | 语音、屏幕共享、低延迟媒体传输的成熟方案；若 WebView 媒体能力不足，下沉到 Rust 原生层 |
| 服务端 | Go + Pion WebRTC | Go 适合分发单文件服务端，Pion 是成熟的 Go WebRTC 实现 |
| 服务端 API | REST + WebSocket | REST 处理资源读写；WebSocket 处理在线状态、频道事件、信令 |
| 服务端数据库 | SQLite MVP，后续 PostgreSQL 可选 | SQLite 方便自建部署；大型服务器可迁移到 PostgreSQL |
| 移动端后续 | Android Kotlin、iOS Swift、HarmonyOS ArkTS/ArkUI | 移动端后置，以平台壳复用 Rust core；HarmonyOS 使用 ArkTS/ArkUI 单独适配 |
| 配置与部署 | YAML/TOML + Docker | 本地二进制和容器部署同时支持 |
| StarEcho 平台 | 独立中心服务，复用 Go API 架构 | 后期提供账号、资料、服务器列表同步，不参与普通自建服务器的实时流量 |

### 4.2 技术依据

Tauri 2 适合作为小包体桌面客户端壳，但它使用系统 WebView，需要接受不同系统之间的渲染差异。Windows 使用 WebView2，macOS 使用 WKWebView，Linux 使用 WebKitGTK，因此 EV 的 UI 需要采用保守 CSS、固定设计 token、截图回归测试，并把语音、屏幕共享、远程控制等高风险能力尽量放到 Rust 原生层。

Svelte 是编译型 UI 框架，适合减少运行时负担。Pion 提供 Go 语言 WebRTC 能力，适合构建自托管语音与屏幕共享服务。HarmonyOS 后续客户端建议使用华为官方 ArkUI 应用框架和 ArkTS 开发。

参考：

1. Tauri WebView 版本说明：https://v2.tauri.app/reference/webview-versions/
2. Svelte 官方文档：https://svelte.dev/docs
3. Pion WebRTC 官方站点：https://pion.ly/
4. HarmonyOS ArkUI 官方文档：https://developer.huawei.com/consumer/en/doc/harmonyos-guides/arkui

## 5. 系统架构

### 5.1 架构概览

```text
+-------------------------+         +-------------------------+
| EchoVoice Desktop       |         | StarEcho Platform       |
| Windows/macOS/Linux     | <-----> | Account/Profile Sync    |
| Tauri + Svelte + Rust   |  HTTPS  | Server List Sync        |
+-----------+-------------+         +-------------------------+
            |
            | REST / WebSocket / WebRTC
            |
+-----------v-------------+
| EchoVoice Server        |
| Self-hosted             |
| API + Auth + Permission |
| Text + Presence         |
| WebRTC Signaling/SFU    |
| SQLite Storage          |
+-------------------------+
```

EV Server 是每个自建社区的核心。StarEcho 只是可选中心服务，不影响用户直接通过 IP + 端口连接自建服务器。

移动端不进入 MVP 主线。后续 Android、iOS、HarmonyOS 以平台壳方式接入，共享 Rust core 中的协议、权限、缓存和本地数据模型。

### 5.2 客户端职责

桌面客户端负责：

1. 管理本地服务器列表、登录凭证、用户偏好。
2. 连接 EV Server，完成身份注册、认证、资料同步。
3. 展示服务器、频道、成员、消息、语音状态。
4. 捕获麦克风、扬声器、屏幕、窗口、系统音频或本地音乐源。
5. 与 EV Server 进行 WebRTC 信令交换。
6. 在用户授权后发送远程控制输入事件，并在本地输入发生时暂停远程控制。
7. 管理本地声音板、本地表情包和 sha256 全局内容缓存。
8. 根据权限展示或禁用相关操作入口。
9. 与 StarEcho 同步可选资料。

### 5.3 共享核心职责

Rust core 负责承载跨客户端复用的业务逻辑，避免未来 Android、iOS、HarmonyOS 重复实现关键规则。

共享核心负责：

1. 协议 DTO、错误码、WebSocket 事件模型。
2. 权限计算和频道覆盖规则。
3. 服务器列表、本地成员身份、uuid/key 管理。
4. sha256 内容寻址缓存规则。
5. 声音板、表情、频道文件的本地元数据模型。
6. 连接状态、语音状态、媒体 session 状态机。
7. 全局用户身份、好友关系、私聊会话和加密 envelope 模型。
8. SQLite 数据访问封装和 migration。
9. 平台能力抽象接口，例如 keyring、通知、媒体设备、远程控制输入。

### 5.4 自建服务端职责

EV Server 负责：

1. 接收用户通过 IP、端口、密码连接。
2. 首个有效连接用户自动成为 owner。
3. 管理服务器资料、成员资料、角色、权限、频道、消息。
4. 签发并校验 server-scoped uuid + key。
5. 广播在线状态、频道事件、成员事件、文字消息事件。
6. 处理 WebRTC 信令，并在语音频道中承担 SFU/媒体转发角色。
7. 按服务器配置开启或关闭屏幕共享、远程控制、播放音乐等能力。
8. 管理服务器声音板、服务器表情、频道文件存储和内容资产传输。
9. 可选提供同服务器好友申请、同服务器私聊中继、私下语音信令。
10. 可选作为用户 home relay，加密暂存跨服务器离线消息 envelope。
11. 写入审计日志，便于 owner 排查管理操作。

### 5.5 StarEcho 平台职责

StarEcho 是后期模块，负责：

1. 用户中心账号。
2. 跨设备同步用户昵称、头像、简介。
3. 同步服务器列表。
4. 保存每个服务器对应的 server uuid、用户 uuid、访问 key 的加密备份。
5. 可选保存用户公开身份资料、public key、home relay 地址。
6. 可选同步端到端加密后的好友列表和私聊索引。
7. 提供好友、公共发现、备份恢复等后续能力的基础。

StarEcho 不应成为加入自建服务器的必要条件。没有 StarEcho 账号时，EV 仍然必须能完整使用自建服务器。

## 6. 身份与连接模型

### 6.1 身份类型

EV 中至少存在三类身份：

| 身份 | 说明 |
| --- | --- |
| Local Profile | 客户端本地用户资料，包含昵称、头像、简介、本地全局 ID |
| Global User Identity | 跨服务器好友和私聊身份，由长期 public key 派生 |
| Server Member | 某个 EV Server 内的成员身份，由 server uuid + member uuid 标识 |
| StarEcho Account | 可选中心账号，用于跨设备同步资料和服务器列表 |

同一个用户在不同自建服务器中可以拥有不同的 Server Member 身份。这样可以保留去中心化服务器的自治能力。

好友、私聊、私下语音不应依赖 `member_uuid`。它们必须使用跨服务器稳定的 Global User Identity，否则用户换服务器或加入多个服务器后无法保持同一好友关系。

### 6.2 首次连接流程

1. 用户输入服务器地址：`ip:port`。
2. 用户输入密码，密码允许为空。
3. 客户端发送本地资料：昵称、头像、简介、本地全局 ID、客户端版本。
4. 服务端校验连接密码。
5. 如果服务端还没有 owner，则将该成员设为 owner。
6. 服务端创建成员记录，生成：
   - `server_id`
   - `member_uuid`
   - `access_key`
7. 服务端只保存 `access_key_hash`，不保存明文 key。
8. 客户端将 `server_id + member_uuid + access_key` 保存到本地 OS keyring。
9. 服务端返回服务器资料、频道列表、成员列表、当前权限、在线状态。

### 6.3 后续连接流程

1. 客户端读取本地保存的 `server_id + member_uuid + access_key`。
2. 客户端向服务端提交认证请求。
3. 服务端验证 key hash。
4. 服务端签发短期 `session_token`。
5. 客户端使用 `session_token` 建立 REST 与 WebSocket 会话。

### 6.4 重新绑定与丢失 key

如果用户丢失本地 key：

1. 无 StarEcho 备份时，需要 owner 或管理员重新邀请。
2. 有 StarEcho 加密备份时，可以在新设备登录 StarEcho 后恢复。
3. 管理员可在成员管理中重置某成员 key，旧 key 立即失效。

#### 6.4.1 多设备成员绑定与资料同步

同一个服务器成员可以绑定多个本地设备身份，但服务端只保存一份规范成员资料，不为每台设备分别保存昵称、头像和简介。数据关系如下：

```text
Server Member (member_uuid)
  ├─ canonical profile: display_name / avatar / bio / profile_updated_at
  ├─ roles / permissions / message history
  └─ device credentials
       ├─ device A: local_profile_id + access_key_hash
       └─ device B: local_profile_id + access_key_hash
```

规则：

1. `member_uuid` 是服务器内账号主体；角色、权限、消息历史和成员资料都归属于它。
2. `local_profile_id` 在当前阶段表示一台客户端安装的本地设备身份。每台设备拥有独立 `access_key`，服务端只保存 hash。
3. 管理员将新设备产生的临时成员关联到旧成员后，服务端迁移设备凭证、角色和历史引用，并删除重复成员记录。
4. 身份合并瞬间始终保留管理员明确选择的“原成员”资料，不能让新设备较晚生成的默认资料覆盖原账号。新设备收到合并事件后先将规范资料写入本地，再使用迁移后的设备凭证重连。
5. 身份合并完成后，客户端每次打开服务器都会比较本地资料和规范资料。若本地版本更新或同版本内容不一致，客户端自动上传；若服务端版本更新，客户端自动回写本地资料。
6. 资料同步失败不得阻止进入服务器。客户端保留较新的本地快照，并在下次打开服务器时自动重试。
7. 服务端不保存“设备 A 的昵称”和“设备 B 的昵称”这类分支版本，避免成员列表因登录设备不同而出现多份互相冲突的个人资料。
8. 设备绑定只代表服务器成员身份恢复，不等价于未来的 Global User Identity。跨服务器好友和私聊仍使用第 6.5 节定义的长期密钥身份。
9. 新设备在关联瞬间可以离线。其旧 `member_uuid` 下次刷新会话时，服务端会根据已迁移的设备 key 返回规范 `member_uuid`；客户端先用规范资料覆盖新设备的临时资料，再自动改写本地凭证并进入常规同步流程。

因此，换设备后的推荐路径是：新设备先正常连接，管理员在成员管理中将新成员关联到旧成员；关联完成后，新设备继续使用自己的凭证登录同一个 `member_uuid`，并自动参与上述资料同步。

### 6.5 全局用户身份

客户端首次启动时生成一组长期身份密钥：

```text
private_key = 本地安全保存
public_key = 可公开交换
ev_user_id = hash(public_key)
```

设计规则：

1. `ev_user_id` 是好友、私聊、私下语音使用的主身份。
2. `private_key` 只保存在本地 keyring 或用户主动启用的端侧加密备份中。
3. `public_key` 可以通过同服务器成员资料、好友邀请链接、二维码、StarEcho 公开资料或手动导入交换。
4. 同一个用户在不同 EV Server 中可以绑定同一个 `ev_user_id`，但服务器内的 `member_uuid` 仍然保持自治。
5. 服务器可以记录 `member_uuid -> ev_user_id` 的声明绑定，但必须由客户端签名证明，防止冒充。

### 6.6 好友关系

好友关系基于 `ev_user_id`，不基于某个服务器的成员 ID。

添加好友方式：

1. 同服务器添加：在成员列表中向某个成员发送好友申请，服务器只负责中继申请。
2. 邀请链接或二维码：链接包含 `ev_user_id`、`public_key`、展示名、头像 hash、可选 home relay。
3. StarEcho 辅助发现：后期可通过 StarEcho 查询公开资料和 home relay，但 StarEcho 不是必需。

好友数据默认保存在本地。启用 StarEcho 后，可以同步端到端加密后的好友列表，StarEcho 不应读取好友备注、分组和会话内容。

### 6.7 私聊消息

私聊消息必须按端到端加密 envelope 设计。服务器只负责转发或暂存密文，不读取正文。

传输模式：

| 模式 | 路径 | 说明 |
| --- | --- | --- |
| 同服务器在线 | A -> EV Server -> B | 服务端中继密文，适合 MVP |
| 跨服务器在线 | A -> P2P DataChannel 或信令 relay -> B | 需要双方在线和信令可达 |
| 跨服务器离线 | A -> B 的 home relay -> B | home relay 暂存密文 envelope |

私聊 envelope 至少包含：

1. envelope id。
2. sender `ev_user_id`。
3. recipient `ev_user_id`。
4. sender device id。
5. recipient device id，可为空。
6. message type。
7. created_at。
8. encrypted payload。
9. signature。

### 6.8 Home Relay 加密邮箱

Home relay 是用户自己指定的离线密文收件箱，用来解决去中心化环境下“收件人离线时消息放哪里”的问题。

设计规则：

1. 每个用户可以配置一个或多个 home relay 地址。
2. home relay 可以是用户自己的 EV Server、朋友的 EV Server、团队服务器或 StarEcho 提供的默认 relay。
3. 发送方使用收件人的 public key 在本地加密消息，再投递到收件人的 home relay。
4. home relay 只保存密文 envelope 和必要路由元数据，不能读取正文。
5. 收件人上线后从 home relay 拉取 envelope，在本地解密。
6. 收件人确认收取后，home relay 可以删除或标记 envelope 已取走。
7. home relay 需要设置单用户邮箱容量、单 envelope 大小、保留时间和投递速率限制。

home relay 不用于承载实时语音媒体。它主要用于离线私聊、好友申请、加密通知、设备同步信令。

### 6.9 私下语音

私下语音是好友之间的临时 call session，不依赖公开语音频道。

建立流程：

1. A 向 B 发起私密通话邀请。
2. 信令优先通过双方共同所在 EV Server；没有共同服务器时使用 home relay、StarEcho 或双方配置的 relay server 做信令。
3. B 接受后，双方交换 WebRTC SDP/ICE。
4. 优先尝试 P2P WebRTC。
5. NAT 失败时，使用双方认可的 relay server 或 EV Server SFU 转发。
6. 如果无法建立 P2P 或 relay，则提示通话不可达。

MVP 建议先实现同服务器私下语音。跨服务器私下语音放到好友系统第二阶段之后。

## 7. 权限系统设计

### 7.1 设计原则

权限组参考 Discord 的角色模型，但在实现上需要保持清晰、可测试、可解释。

核心原则：

1. owner 拥有不可移除的最高权限。
2. 每个服务器有默认角色 `@everyone`。
3. owner 不是角色，不能作为权限组编辑对象；owner 是服务器成员上的特殊所有者标记。
4. 除 `@everyone` 外，不预制 Admin、Member、Moderator 等权限身份；这些名称都应由服务器 owner 自己创建为自定义角色。
5. 用户可以拥有多个角色。
6. 角色有优先级，优先级高的角色可管理低优先级角色。
7. 频道可以覆盖服务器级权限。
8. 明确拒绝优先于允许。
9. 客户端只负责展示限制，服务端必须进行最终权限校验。

### 7.2 权限计算顺序

1. 如果成员是 owner，直接允许。
2. 合并 `@everyone` 权限。
3. 合并成员拥有的所有角色权限。
4. 应用频道级覆盖：
   - `@everyone` 频道覆盖
   - 角色频道覆盖
   - 成员频道覆盖
5. 如果存在明确 deny，则 deny。
6. 如果存在 allow，则 allow。
7. 否则使用默认 deny。

### 7.3 权限列表

服务器管理：

| 权限 | 说明 |
| --- | --- |
| Administrator | 管理员，绕过大多数权限检查，但不能高于 owner |
| ManageServer | 修改服务器名称、图标、连接密码、功能开关 |
| ManageRoles | 创建、编辑、删除低于自身等级的角色 |
| ManageChannels | 创建、编辑、删除频道和分类 |
| ManageMembers | 踢出、封禁、重置成员 key |
| ViewAuditLog | 查看审计日志 |

文字频道：

| 权限 | 说明 |
| --- | --- |
| ViewChannel | 查看频道 |
| SendMessages | 发送消息 |
| ManageMessages | 删除或置顶消息 |
| UploadFiles | 上传消息附件或频道文件，详细语义见内容扩展 |
| MentionEveryone | 提及全体成员 |

语音频道：

| 权限 | 说明 |
| --- | --- |
| ConnectVoice | 加入语音频道 |
| Speak | 发送语音 |
| MuteMembers | 管理员静音成员 |
| DeafenMembers | 管理员禁听成员 |
| MoveMembers | 拖拽成员到其他语音频道 |
| CreateTemporaryVoice | 创建临时语音频道 |
| PrioritySpeaker | 优先发言 |

媒体扩展：

| 权限 | 说明 |
| --- | --- |
| ShareScreen | 屏幕共享 |
| RequestRemoteControl | 申请控制他人的屏幕共享 |
| AcceptRemoteControl | 允许他人控制自己的屏幕共享 |
| PlayAccompaniment | 播放音乐 |
| PlaySoundboard | 播放服务器声音板或本地声音板 |
| ManageServerSoundboard | 管理服务器声音板 |
| ManageMediaSessions | 结束他人的屏幕共享、远程控制、音乐播放或声音板 session |

内容扩展：

| 权限 | 说明 |
| --- | --- |
| SendEmoji | 发送服务器表情或本地表情 |
| ManageServerEmoji | 管理服务器表情 |
| ViewFiles | 查看频道文件和文件夹列表，但不能预览或下载 |
| UploadFiles | 上传文件；没有 ViewFiles 时只能上传到频道根目录 |
| DownloadFiles | 预览和下载频道文件，并隐含 ViewFiles |
| ManageFiles | 创建文件夹，并移动、重命名或删除任意文件条目；隐含全部文件权限 |

私密通信与中继：

| 权限 | 说明 |
| --- | --- |
| UseServerDMRelay | 使用当前服务器中继同服务器私聊密文 |
| UsePrivateVoiceRelay | 使用当前服务器中继私下语音信令或媒体 |
| UseHomeMailbox | 使用当前服务器作为 home relay 加密邮箱 |
| ManageRelayService | 管理私聊中继、私下语音 relay、home relay 配额和策略 |

### 7.4 审计日志

需要记录以下操作：

1. 修改服务器设置。
2. 修改权限、角色、频道。
3. 踢出、封禁、重置成员 key。
4. 强制移动、静音、禁听用户。
5. 开启或关闭屏幕共享、远程控制、播放音乐、声音板、表情、文件存储服务。
6. 批准、拒绝、转交、撤销远程控制。
7. 上传、删除服务器声音板和服务器表情。
8. 上传、删除、移动频道文件。
9. 修改私聊中继、私下语音 relay、home relay 开关和配额。

审计日志至少包含：操作人、目标对象、操作类型、变更前后摘要、时间、IP 摘要。

## 8. 频道与消息模型

### 8.1 频道类型

| 类型 | 说明 |
| --- | --- |
| Category | 分类，只承载子频道 |
| TextChannel | 文字频道 |
| VoiceChannel | 语音频道，频道行右侧提供消息入口，消息归属该语音频道 |
| TemporaryVoiceChannel | 临时语音频道，可自动销毁，消息同样归属该临时语音频道 |
| AnnouncementChannel | 后续可选，公告频道 |

### 8.2 文字消息

基础消息能力：

1. 纯文本消息。
2. 编辑与删除。
3. 基础 Markdown。
4. 支持表情与文本混排。
5. 消息历史分页加载。
6. WebSocket 实时推送新消息。

后续能力：

1. 文件附件和频道文件存储联动。
2. 回复、引用、反应。
3. 搜索。
4. 附件缩略图。
5. 机器人消息。

### 8.3 语音频道状态

服务端维护语音频道中的成员状态：

1. 当前频道。
2. 是否自我静音。
3. 是否自我禁听。
4. 是否被管理员静音。
5. 是否被管理员禁听。
6. 是否正在说话。
7. 是否正在屏幕共享。
8. 是否允许他人申请远程控制。
9. 当前远程控制者。
10. 是否处于远程控制尊重窗口。
11. 是否正在播放音乐。
12. 是否正在播放声音板。

客户端根据 WebSocket 事件更新成员列表与语音频道 UI。

### 8.4 语音频道聊天入口

每个语音频道在频道行右侧提供一个消息入口，用于打开当前语音频道的聊天。该聊天不是额外创建的文字频道，也不在频道树中产生隐藏子频道；消息、表情和文件都直接归属到该语音频道的 `channel_uuid`。

规则：

1. 有权限查看语音频道的用户可以看到该语音频道的消息入口。
2. 是否可发送消息仍受 `SendMessages` 和频道覆盖权限控制。
3. 语音频道聊天可以发送文字、表情和上传文件。
4. 删除语音频道时，同步删除该语音频道聊天中的消息和文件根路径。
5. 临时语音频道销毁时，同步清理该临时语音频道作用域内的聊天和文件。

### 8.5 频道文件存储

EV Server 可以提供类似 QQ 群文件系统但更接近网盘的频道文件存储。该服务默认关闭，由 owner 在服务器设置中启用，启用后仍受 `ViewFiles`、`UploadFiles`、`DownloadFiles` 和 `ManageFiles` 权限控制。

设计原则：

1. 每个文字频道和语音频道聊天入口都有独立文件根路径，语音频道文件根路径直接绑定该语音频道 `channel_uuid`。
2. 频道是文件根路径的所有权边界，删除频道时同步删除该频道下的文件记录和文件对象引用。
3. 文件操作应接近网盘体验，文件和文件夹通过拖拽移动，支持 `Ctrl`/`Shift` 多选、批量移动和批量删除。
4. 文件条目记录上传成员作为 owner；owner 即使没有 `ManageFiles`，也可以移动、重命名和删除自己上传的文件，但不能创建文件夹或管理他人的条目。
5. 客户端上传前计算 sha256 并先请求建立引用；服务端已有同哈希对象时跳过文件传输。全服务器共用内容寻址对象池，多个频道文件条目可以引用同一个对象。
6. `ViewFiles` 响应不向没有 `DownloadFiles` 的成员暴露内容哈希，文件内容接口仍必须独立校验下载权限。
7. 预览能力覆盖图片、视频、音频、PDF、文本、常见文档元数据及 ZIP/TAR 等压缩包目录；未知或不能安全渲染的格式只展示元数据并提供下载。
8. 是否清理物理文件由引用计数或定期垃圾回收决定，避免删除一个频道时误删仍被其他频道引用的相同文件对象。
9. 服务端需要提供容量限制、单文件大小限制、文件类型限制和上传速率限制。

## 9. 媒体系统设计

### 9.1 语音

语音使用 WebRTC + Opus。MVP 阶段建议由 EV Server 承担轻量 SFU 职责：

1. 客户端只向服务器发送一路音频。
2. 服务器根据同一语音频道内的订阅关系转发音频。
3. 客户端接收同频道其他成员音频。
4. 服务器默认不录音、不保存音频。

这样可以避免客户端之间建立复杂 mesh 连接，并且更利于权限控制、管理员静音、移动频道等功能。

### 9.2 WebRTC 信令

信令走 WebSocket：

| 事件 | 方向 | 说明 |
| --- | --- | --- |
| voice.join | Client -> Server | 请求加入语音频道 |
| voice.leave | Client -> Server | 离开语音频道 |
| rtc.offer | Client -> Server | 发送 SDP offer |
| rtc.answer | Server -> Client | 返回 SDP answer |
| rtc.ice | 双向 | ICE candidate |
| voice.state.updated | Server -> Client | 成员语音状态变化 |

### 9.3 屏幕共享

屏幕共享默认关闭，由 owner 在服务器设置中启用。启用后还要检查用户是否拥有 `ShareScreen` 权限。

桌面端：

1. 支持选择整个屏幕。
2. 支持选择窗口。
3. 可配置分辨率、帧率、码率。
4. 默认不共享音频；Windows 用户可在共享前显式开启共享音频。
5. 共享单个窗口时，使用 Windows process loopback 只捕获目标进程及其子进程的输出音频。
6. 共享整个屏幕时，捕获系统输出但排除 EchoVoice 当前进程树，避免把语音通话播放重新送回频道。
7. 视频使用 H.264，音频使用 48 kHz 双声道 Opus，并在同一屏幕共享 WebRTC session 中发送。

Web 端：

1. 使用 `getDisplayMedia({ audio: true })` 请求浏览器提供的标签页、窗口或系统音频轨道。
2. 浏览器可能因所选来源、操作系统或用户未勾选音频而不返回音轨，客户端必须检测并明确提示。
3. 浏览器沙箱不能按进程从共享音频中剔除 EchoVoice；启用 Web 共享音频时必须提示可能产生回声。
4. Web 端不得声称具有桌面端的 EchoVoice 音频过滤能力。

移动端：

1. Android 可使用系统屏幕录制能力。
2. iOS 需要遵守系统 ReplayKit 限制。
3. MVP 可以先支持桌面端，移动端后续完善。

远程控制：

1. 使用受支持原生输入宿主的桌面客户端开始屏幕共享时，可以选择“允许其他用户申请控制”。
2. 该选项需要服务器开启远程控制服务，且共享者拥有 `AcceptRemoteControl` 权限。
3. 观看者申请控制时，需要拥有 `RequestRemoteControl` 权限。
4. 共享者必须显式批准申请，远程控制才会生效。
5. 同一屏幕共享 session 默认只允许一个远程控制者。
6. 共享者可以随时撤销控制权，管理员可以结束远程控制 session。
7. 如果共享的是整个屏幕，远程控制事件可以作用于整个屏幕。
8. 如果共享的是单个窗口，控制事件必须限制在该窗口区域内；客户端需要根据窗口句柄、边界和焦点状态裁剪或拒绝越界输入。
9. 被控用户只要移动鼠标或产生任意键盘输入，就立即进入 3 秒“尊重窗口”。
10. 尊重窗口期间控制端输入事件不执行，客户端 UI 显示远程控制已暂停。
11. 尊重窗口结束后，如果共享者没有撤销授权，控制端可继续控制。
12. 远程控制授权、租约、权限复核和撤销必须由服务端控制；输入可经事件 WebSocket 中继，或在授权代次握手后通过现有屏幕共享 PeerConnection 的 WebRTC DataChannel 传输。被控原生端必须再次校验授权代次、参与设备、序列号、租约、坐标边界和尊重窗口。
13. Web 客户端可以作为控制端，但不能作为操作系统级被控端；Web 发起共享时必须固定提交 `remote_control_allowed=false`。
14. 浏览器对被捕获标签页提供的滚动、缩放等有限控制能力不视为 EchoVoice 远程控制，也不得静默降级为该能力。

### 9.4 播放音乐

播放音乐服务默认关闭，由 owner 启用。启用后还要检查 `PlayAccompaniment` 权限。

MVP 采用客户端推流方案：

1. 有权限且已加入语音频道的 Windows 用户选择一个带可见窗口的本地进程。
2. 客户端使用 process loopback 只捕获该进程树，不包含麦克风输入或 EchoVoice 自身语音播放。
3. 音乐使用 48 kHz Opus 独立音频 track；麦克风与音乐在接收端按不同音轨解码后混音，不能串接到同一个解码队列。
4. WebRTC 连接预留第二条音频媒体线，使音乐播放开始和停止不需要重建语音连接。
5. EV Server 负责权限、会话、审计和事件同步，媒体仍沿现有语音 WebRTC 拓扑传输；服务器不保存本地进程 PID。
6. 客户端成员列表和语音舞台使用音符图标显示正在播放音乐的成员，并提供开始/停止入口。
7. 同一成员同时只允许一个音乐播放 session；离开、换频道、被移动或退出服务器时自动结束。

后续可实现 server-side music bot，由服务器直接拉取音源并混音。但该方案涉及版权、稳定性与资源占用，不适合作为 MVP。

### 9.5 声音板

声音板功能类似 Discord Soundboard，分为服务器声音板和用户声音板。

服务器声音板：

1. 文件存储在 EV Server。
2. 由拥有 `ManageServerSoundboard` 权限的用户上传、重命名、删除、排序。
3. 播放时需要服务器开启声音板服务，且播放者拥有 `PlaySoundboard` 权限。
4. 服务端负责向同语音频道成员广播播放事件和必要的文件下载信息。

用户声音板：

1. 文件存储在用户本地。
2. 用户可以跨服务器复用自己的声音板。
3. 播放时，客户端将声音板文件通过当前 EV Server 作为传输介质分发给同语音频道成员。
4. 服务器不需要永久保存用户声音板，但可以做短期中转缓存和速率限制。

缓存规则：

1. 声音板文件使用 sha256 作为全局内容 ID。
2. 接收端播放前先检查本地全局缓存。
3. 如果缓存命中，只接收播放事件，不重复下载文件。
4. 如果缓存未命中，先通过当前服务器获取文件并保存到本地缓存，再播放。
5. 同一个 sha256 的声音板文件可以跨服务器复用缓存。
6. 客户端必须校验下载文件的 sha256，校验失败不播放、不入库。

### 9.6 表情系统

表情功能类似 Discord emoji，并扩展本地表情包能力，支持静态图片和 gif。

服务器表情：

1. 表情文件上传到 EV Server。
2. 拥有 `ManageServerEmoji` 权限的用户可以管理服务器表情。
3. 服务器管理员可以决定是否开启表情服务。
4. 开启后，管理员可以配置允许发送的最大表情文件大小，单位为 KB。
5. 发送表情仍受 `SendEmoji` 权限控制。

本地表情与表情包：

1. 用户可以将表情保存到本地。
2. 用户可以自己设计表情包，类似 Telegram 的表情包组织方式。
3. 用户可以保存其他人发送的表情。
4. 本地表情发送时，当前服务器作为传输介质。

缓存与接收规则：

1. 表情文件使用 sha256 作为全局内容 ID。
2. 即使其他用户保存了某个表情，也必须保持原文件 sha256 不变，才能命中缓存。
3. 接收端先检查本地全局缓存，命中时不重复下载。
4. 大于 1 MB 的表情，其他用户默认不自动接收。
5. 大于 1 MB 的表情需要用户点开表情并确认接收后才下载。
6. 下载后必须校验 sha256，校验失败不展示、不入库。
7. gif 表情需要保留原始动图文件，同时可以生成静态预览图用于列表显示。

### 9.7 内容寻址缓存

声音板、表情和后续可扩展的小型媒体资源统一使用内容寻址缓存。

客户端缓存键：

```text
sha256:<hex>
```

缓存元数据至少包含：

1. sha256。
2. MIME 类型。
3. 文件大小。
4. 原始文件名，可为空。
5. 首次来源服务器。
6. 最近使用时间。
7. 引用类型，例如 soundboard、emoji、file-preview。

缓存策略：

1. 缓存是全局的，不绑定单个服务器。
2. 不同服务器发送相同 sha256 内容时直接复用本地缓存。
3. 客户端可设置最大缓存容量，并按最近使用时间清理。
4. 服务端不能要求客户端信任文件名或 MIME，客户端必须以 sha256 和实际内容校验为准。

## 10. API 与事件设计

### 10.1 REST API

基础接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/v1/connect | 首次连接或登录 |
| POST | /api/v1/session/refresh | 刷新 session token |
| GET | /api/v1/profile | 获取当前成员的规范资料 |
| PATCH | /api/v1/profile | 由当前成员同步自己的本地资料 |
| DELETE | /api/v1/membership | 主动退出服务器 |
| GET | /api/v1/server | 获取服务器资料 |
| PATCH | /api/v1/server | 修改服务器资料 |
| GET | /api/v1/channels | 获取频道树 |
| POST | /api/v1/channels | 创建频道 |
| PATCH | /api/v1/channels/{id} | 修改频道 |
| DELETE | /api/v1/channels/{id} | 删除频道 |
| PUT | /api/v1/channels/order | 原子更新频道树顺序 |
| GET | /api/v1/members | 获取成员列表 |
| PATCH | /api/v1/members/{id} | 管理成员封禁状态 |
| PATCH | /api/v1/members/{id}/roles | 更新成员角色 |
| POST | /api/v1/members/{id}/link | 将重复设备成员关联到保留成员 |
| GET | /api/v1/roles | 获取角色 |
| POST | /api/v1/roles | 创建角色 |
| PATCH | /api/v1/roles/{id} | 修改角色 |
| DELETE | /api/v1/roles/{id} | 删除角色 |
| PUT | /api/v1/roles/order | 原子更新角色层级顺序 |
| GET | /api/v1/channels/{id}/messages | 分页获取消息 |
| POST | /api/v1/channels/{id}/messages | 发送消息 |
| PATCH | /api/v1/messages/{id} | 编辑消息 |
| DELETE | /api/v1/messages/{id} | 删除消息 |
| GET | /api/v1/accompaniments | 获取当前可见音乐播放会话 |
| POST | /api/v1/channels/{id}/accompaniment | 在当前语音频道开始播放音乐 |
| DELETE | /api/v1/accompaniments/{id} | 停止播放音乐 |
| GET | /api/v1/soundboard | 获取服务器声音板 |
| POST | /api/v1/soundboard | 上传服务器声音板 |
| DELETE | /api/v1/soundboard/{id} | 删除服务器声音板 |
| POST | /api/v1/soundboard/play | 播放声音板 |
| GET | /api/v1/emojis | 获取服务器表情 |
| POST | /api/v1/emojis | 上传服务器表情 |
| DELETE | /api/v1/emojis/{id} | 删除服务器表情 |
| GET | /api/v1/assets/{sha256} | 下载内容资产 |
| HEAD | /api/v1/assets/{sha256} | 检查内容资产是否存在 |
| GET | /api/v1/channels/{id}/files | 获取频道文件列表 |
| POST | /api/v1/channels/{id}/files | 上传频道文件 |
| PATCH | /api/v1/files/{id} | 重命名、移动或更新文件 |
| DELETE | /api/v1/files/{id} | 删除频道文件 |
| POST | /api/v1/identity/bind | 绑定当前 member 与 ev_user_id |
| POST | /api/v1/friend-requests | 发送同服务器好友申请 |
| PATCH | /api/v1/friend-requests/{id} | 接受或拒绝好友申请 |
| POST | /api/v1/dm/relay | 中继同服务器私聊密文 envelope |
| POST | /api/v1/private-calls | 发起私下语音邀请 |
| PATCH | /api/v1/private-calls/{id} | 接受、拒绝或结束私下语音 |
| POST | /api/v1/private-calls/{id}/signal | 私下语音 WebRTC 信令 |
| GET | /api/v1/mailbox/envelopes | 从 home relay 拉取密文 envelope |
| POST | /api/v1/mailbox/envelopes | 向 home relay 投递密文 envelope |
| DELETE | /api/v1/mailbox/envelopes/{id} | 确认收取后删除 envelope |

### 10.2 WebSocket 事件

基础事件：

| 事件 | 说明 |
| --- | --- |
| server.updated | 服务器资料变化 |
| channel.created | 创建频道 |
| channel.updated | 更新频道 |
| channel.deleted | 删除频道 |
| member.joined | 成员加入 |
| member.updated | 成员资料或角色变化 |
| member.presence.updated | 成员在线状态变化 |
| member.identity_linked | 当前设备已关联到保留成员，需要迁移本地凭证 |
| member.left | 成员退出、被移除或重复身份被合并 |
| message.created | 新消息 |
| message.updated | 消息编辑 |
| message.deleted | 消息删除 |
| voice.state.updated | 语音状态变化 |
| permission.updated | 权限变化 |
| rtc.signal | WebRTC 信令 |
| control.requested | 远程控制申请 |
| control.approved | 远程控制批准 |
| control.rejected | 远程控制拒绝 |
| control.revoked | 远程控制撤销 |
| control.suspended | 远程控制尊重窗口开始或结束 |
| control.input | 远程控制输入事件 |
| accompaniment.started | 音乐播放会话开始 |
| accompaniment.ended | 音乐播放会话结束 |
| soundboard.played | 声音板播放事件 |
| emoji.updated | 服务器表情变化 |
| file.updated | 频道文件变化 |
| friend.requested | 好友申请 |
| friend.accepted | 好友申请通过 |
| friend.rejected | 好友申请拒绝 |
| dm.envelope.received | 收到私聊密文 envelope |
| mailbox.envelope.available | home relay 有新 envelope 可拉取 |
| private_call.invited | 私下语音邀请 |
| private_call.accepted | 私下语音接受 |
| private_call.rejected | 私下语音拒绝 |
| private_call.ended | 私下语音结束 |
| private_call.signal | 私下语音 WebRTC 信令 |

### 10.3 错误码

错误码需要稳定，客户端依赖错误码展示 UI：

| 错误码 | 说明 |
| --- | --- |
| EV_AUTH_INVALID_KEY | uuid/key 无效 |
| EV_AUTH_SERVER_PASSWORD_REQUIRED | 需要服务器密码 |
| EV_AUTH_SERVER_PASSWORD_INVALID | 服务器密码错误 |
| EV_PERMISSION_DENIED | 权限不足 |
| EV_CHANNEL_NOT_FOUND | 频道不存在 |
| EV_MEMBER_NOT_FOUND | 成员不存在 |
| EV_MEDIA_DISABLED | 服务器未开启该媒体能力 |
| EV_MEDIA_DEVICE_UNAVAILABLE | 客户端媒体设备不可用 |
| EV_REMOTE_CONTROL_DISABLED | 远程控制未开启或该 session 未允许申请控制 |
| EV_REMOTE_CONTROL_SUSPENDED | 当前处于尊重窗口，控制端输入被暂停 |
| EV_ACCOMPANIMENT_DISABLED | 服务器未开启播放音乐服务 |
| EV_ACCOMPANIMENT_ACTIVE | 当前成员已有活动音乐播放会话 |
| EV_CONTENT_TOO_LARGE | 内容文件超过服务器或客户端限制 |
| EV_ASSET_HASH_MISMATCH | 内容 sha256 校验失败 |
| EV_FILE_STORAGE_DISABLED | 文件存储服务未开启 |
| EV_GLOBAL_ID_INVALID | 全局用户身份或签名无效 |
| EV_FRIEND_REQUEST_BLOCKED | 好友申请被隐私设置或服务器策略阻止 |
| EV_DM_RELAY_DISABLED | 当前服务器未开启私聊中继 |
| EV_MAILBOX_DISABLED | 当前服务器未开启 home relay 邮箱 |
| EV_ENVELOPE_TOO_LARGE | 加密 envelope 超过限制 |
| EV_CRYPTO_VERIFY_FAILED | 签名或密文校验失败 |
| EV_PRIVATE_CALL_UNAVAILABLE | 私下语音无法建立 |
| EV_RATE_LIMITED | 请求过于频繁 |

## 11. 数据模型

### 11.1 服务端核心表

| 表 | 说明 |
| --- | --- |
| server_settings | 服务器名称、图标、密码 hash、功能开关 |
| members | 服务器成员资料 |
| member_credentials | member uuid 与 access key hash |
| roles | 角色定义 |
| member_roles | 成员与角色关系 |
| channels | 频道与分类 |
| channel_permission_overrides | 频道权限覆盖 |
| messages | 文字消息 |
| voice_sessions | 当前或历史语音会话 |
| media_sessions | 屏幕共享、远程控制、音乐播放、声音板 session |
| content_assets | 服务器保存或中转的内容资产，按 sha256 去重 |
| soundboard_items | 服务器声音板条目 |
| custom_emojis | 服务器表情条目 |
| file_entries | 频道文件系统条目 |
| file_object_refs | 文件条目与 content_assets 的引用关系 |
| global_identity_bindings | member_uuid 与 ev_user_id 的签名绑定 |
| friend_request_relays | 同服务器好友申请中继记录 |
| dm_relay_envelopes | 同服务器私聊密文中继记录 |
| mailbox_envelopes | home relay 加密邮箱 envelope |
| private_call_sessions | 私下语音信令和 relay session |
| bans | 封禁列表 |
| invites | 邀请码，后续能力 |
| audit_logs | 审计日志 |

### 11.2 members 表字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部自增 ID |
| member_uuid | text | 对外成员 UUID |
| display_name | text | 昵称 |
| avatar_url | text | 头像资源地址或本地资源 ID |
| bio | text | 简介 |
| local_profile_id | text | 客户端上报的本地全局 ID，可为空 |
| is_owner | boolean | 是否 owner |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |
| last_seen_at | datetime | 最近在线时间 |

### 11.3 roles 表字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部 ID |
| role_uuid | text | 对外角色 UUID |
| name | text | 角色名 |
| color | text | 角色颜色 |
| priority | integer | 角色优先级 |
| permissions_allow | integer/text | 允许权限 bitset |
| permissions_deny | integer/text | 拒绝权限 bitset |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

### 11.4 channels 表字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部 ID |
| channel_uuid | text | 对外频道 UUID |
| parent_uuid | text | 父分类 UUID |
| type | text | category/text/voice/temp_voice |
| name | text | 频道名称 |
| topic | text | 频道说明 |
| position | integer | 排序 |
| bitrate | integer | 语音码率 |
| user_limit | integer | 语音人数上限 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

### 11.5 content_assets 表字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部 ID |
| sha256 | text | 内容哈希，全局缓存键 |
| size_bytes | integer | 文件大小 |
| mime_type | text | MIME 类型 |
| storage_path | text | 服务端物理路径或对象存储 key |
| ref_count | integer | 引用计数 |
| created_at | datetime | 创建时间 |
| last_used_at | datetime | 最近使用时间 |

### 11.6 soundboard_items 表字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部 ID |
| item_uuid | text | 对外声音板条目 UUID |
| name | text | 声音名称 |
| asset_sha256 | text | 对应 content_assets.sha256 |
| duration_ms | integer | 音频时长 |
| created_by | text | 创建者 member uuid |
| created_at | datetime | 创建时间 |

### 11.7 custom_emojis 表字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部 ID |
| emoji_uuid | text | 对外表情 UUID |
| shortcode | text | 文本短码，例如 :echo: |
| asset_sha256 | text | 原始表情文件 sha256 |
| preview_sha256 | text | 静态预览图 sha256，可为空 |
| is_gif | boolean | 是否 gif |
| size_bytes | integer | 文件大小 |
| created_by | text | 创建者 member uuid |
| created_at | datetime | 创建时间 |

### 11.8 file_entries 表字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部 ID |
| entry_uuid | text | 对外文件条目 UUID |
| channel_uuid | text | 所属频道；语音频道聊天文件直接绑定语音频道 UUID |
| parent_entry_uuid | text | 父目录 UUID |
| type | text | directory/file |
| name | text | 文件或目录名 |
| asset_sha256 | text | 文件对象 sha256，目录为空 |
| size_bytes | integer | 文件大小 |
| created_by | text | 上传者 member uuid |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

### 11.9 global_identity_bindings 表字段

该表用于 EV Server 记录服务器成员与全局用户身份的声明绑定。绑定必须由客户端使用全局身份私钥签名。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部 ID |
| member_uuid | text | 服务器成员 UUID |
| ev_user_id | text | 全局用户 ID |
| public_key | text | 全局身份 public key |
| signature | text | 对绑定声明的签名 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

### 11.10 mailbox_envelopes 表字段

该表用于 home relay 加密邮箱。服务端只保存密文和必要路由元数据。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部 ID |
| envelope_uuid | text | envelope UUID |
| recipient_ev_user_id | text | 收件人全局用户 ID |
| sender_ev_user_id | text | 发件人全局用户 ID |
| sender_device_id | text | 发件设备 ID |
| recipient_device_id | text | 收件设备 ID，可为空 |
| message_type | text | 消息类型 |
| ciphertext | blob/text | 加密内容 |
| signature | text | envelope 签名 |
| size_bytes | integer | envelope 大小 |
| expires_at | datetime | 过期时间 |
| created_at | datetime | 创建时间 |
| delivered_at | datetime | 被收件人拉取时间，可为空 |

### 11.11 dm_relay_envelopes 表字段

该表用于同服务器在线或短期私聊中继。字段结构可复用 `mailbox_envelopes`，但 TTL 应更短，默认不承担长期离线邮箱职责。

差异规则：

1. 只在双方同服务器或服务器被选为临时 relay 时使用。
2. 默认不长期保存，投递成功或 TTL 到期后清理。
3. 不进入频道消息历史。
4. 服务端不能读取 envelope 明文。

### 11.12 friend_request_relays 表字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部 ID |
| request_uuid | text | 好友申请 UUID |
| sender_ev_user_id | text | 申请人全局用户 ID |
| recipient_ev_user_id | text | 接收人全局用户 ID |
| server_uuid | text | 中继服务器 ID |
| encrypted_payload | blob/text | 加密申请内容 |
| status | text | pending/accepted/rejected/expired |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

### 11.13 private_call_sessions 表字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | integer | 内部 ID |
| call_uuid | text | 私下语音 session UUID |
| caller_ev_user_id | text | 发起者全局用户 ID |
| callee_ev_user_id | text | 接收者全局用户 ID |
| relay_mode | text | p2p/server_sfu/turn |
| status | text | invited/accepted/rejected/ended |
| created_at | datetime | 创建时间 |
| ended_at | datetime | 结束时间，可为空 |

### 11.14 客户端本地私密通信表

客户端本地需要保存好友和私聊索引。除用户主动启用端侧加密同步外，这些数据默认不上传服务器。

| 表 | 说明 |
| --- | --- |
| local_global_identity | 当前设备的 ev_user_id、公钥、加密私钥引用 |
| local_friend_profiles | 好友 ev_user_id、公钥、备注、分组、home relay |
| local_conversations | 私聊会话索引、最后消息摘要、未读数 |
| local_private_messages | 本地解密后的私聊消息，或仅保存密文与索引 |
| local_device_keys | 多设备身份和设备公钥 |

## 12. 客户端 UI 设计

### 12.1 桌面端布局

桌面端采用 Discord-like 四栏结构：

```text
+----------+----------------+--------------------------+----------------+
| Server   | Channel Tree   | Main Content             | Member List    |
| Rail     |                | Text / Voice / Settings  |                |
+----------+----------------+--------------------------+----------------+
|          Bottom Voice / Account Bar                              |
+------------------------------------------------------------------+
```

区域说明：

1. Server Rail：服务器图标、服务器文件夹、添加服务器、StarEcho 入口。
2. Channel Tree：分类、文字频道、语音频道、临时语音频道；用户可自由组合分类与频道，语音频道行右侧提供消息入口。
3. Main Content：文字聊天、语音频道详情、屏幕共享画面、文件管理、设置页。
4. Member List：在线成员、离线成员、角色分组。
5. Bottom Bar：当前账号、麦克风、耳机、设置、当前语音连接状态。
6. Soundboard Panel：语音频道内打开声音板，展示服务器声音板和用户本地声音板。
7. Emoji Picker：文字输入框内打开表情选择器，展示服务器表情、本地表情包和最近使用。

### 12.2 移动端布局

移动端后置实现。Android、iOS、HarmonyOS 都复用 Rust core，但 UI 和系统能力由各自平台壳实现。移动端布局建议使用分层导航：

1. 第一层：服务器列表。
2. 第二层：频道列表。
3. 第三层：聊天或语音频道主界面。
4. 成员列表使用侧滑面板。
5. 语音控制使用底部常驻控制条。

平台建议：

| 平台 | 后续方案 | 说明 |
| --- | --- | --- |
| Android | Kotlin + Jetpack Compose + Rust core | 适配前台服务、音频权限、通知、屏幕录制 |
| iOS | Swift + SwiftUI + Rust core | 适配 ReplayKit、后台音频、系统权限 |
| HarmonyOS | ArkTS + ArkUI + Rust core 可行性验证 | 优先遵守 HarmonyOS 原生 UI、权限和后台规则 |

### 12.3 主题系统

内置主题：

1. Dark：默认纯黑、灰色、淡蓝主题。
2. Light：白色主题。
3. Custom：用户自定义主色、背景色、强调色、危险色、成功色。

主题 token：

| Token | 用途 |
| --- | --- |
| color.black | 纯黑底色 |
| color.background | 页面背景，默认接近纯黑 |
| color.surface | 面板背景，默认深灰 |
| color.surfaceVariant | 二级面板，默认中性灰 |
| color.primary | 主色，默认淡蓝 |
| color.secondary | 次级强调，默认灰蓝 |
| color.danger | 危险操作 |
| color.success | 成功状态 |
| color.textPrimary | 主文字 |
| color.textSecondary | 次级文字 |
| radius.small | 小组件圆角 |
| radius.medium | 弹窗、菜单圆角 |

### 12.4 语言系统

EV 客户端需要支持多语言，并允许社区翻译。

设计要求：

1. 客户端内置至少 `zh-CN` 和 `en-US`。
2. 用户可以导入语言 JSON 文件。
3. 用户可以导出语言模板 JSON，用于社区翻译。
4. 导入的语言包保存在本地，不需要上传服务器。
5. 语言包缺失的 key 使用英文 fallback。
6. 语言包格式需要稳定，便于后续社区维护。

语言文件格式：

```json
{
  "id": "community-locale",
  "name": "Community Locale",
  "strings": {
    "form.connect": "Connect"
  }
}
```

### 12.5 关键界面

完整产品需要完成：

1. 连接服务器页。
2. 服务器主界面。
3. 文字频道界面。
4. 语音频道界面。
5. 服务器设置页。
6. 成员管理页。
7. 角色与权限页。
8. 主题设置页。
9. 本地个人资料页。
10. 屏幕共享观看页。
11. 声音板面板。
12. 表情选择器。
13. 频道文件管理页。
14. 好友列表与好友申请页。
15. 私聊会话页。
16. 私下语音通话页。
17. Home relay 设置页。

### 12.6 WebView 一致性约束

Tauri 不自带 Chromium，因此不同桌面系统会使用不同 WebView。为了控制渲染差异，桌面 UI 必须遵守以下约束：

1. 使用保守、成熟的 CSS 能力，避免依赖过新的浏览器特性。
2. 统一字体栈、字号、行高、间距、圆角和颜色 token。
3. 频道树、成员列表、工具栏、语音控制条等固定格式组件必须设置稳定尺寸。
4. 不把复杂音视频能力绑定在 WebView 行为上，优先通过 Rust 原生层封装。
5. Windows、macOS、Linux 都需要做截图回归测试。
6. 如果某个 WebView 行为差异影响核心体验，应在 Rust 层或 UI 组件层做平台适配。

## 13. 安全设计

### 13.1 凭证安全

1. 客户端使用系统安全存储保存 access key。
2. 服务端只保存 key hash，不保存明文 key。
3. access key 至少使用 256-bit 随机数。
4. session token 使用短期有效期。
5. 支持管理员重置成员 key。

### 13.2 服务器密码

1. 允许空密码。
2. 非空密码在服务端只保存 hash。
3. 支持修改密码。
4. 修改密码不应影响已有成员 key，除非 owner 选择“要求所有成员重新验证”。

### 13.3 传输安全

1. 推荐 HTTPS/WSS。
2. 局域网或测试环境允许 HTTP/WS，但客户端应显示安全提示。
3. WebRTC 媒体使用 DTLS-SRTP。
4. 后续支持自动证书或反向代理部署文档。

### 13.4 滥用防护

1. 连接速率限制。
2. 登录失败速率限制。
3. 消息发送频率限制。
4. 媒体 session 数量限制。
5. 附件大小限制。
6. IP 封禁与成员封禁。
7. 声音板播放频率限制。
8. 表情和文件上传大小限制。
9. 内容资产 sha256 校验，防止缓存投毒。
10. 远程控制输入频率限制和审计。

### 13.5 远程控制安全

远程控制是高风险能力，必须默认关闭，并要求多层授权：

1. 服务器必须开启远程控制服务。
2. 屏幕共享者必须在本次共享中允许他人申请控制。
3. 申请者必须拥有 `RequestRemoteControl` 权限。
4. 屏幕共享者必须显式批准申请。
5. 远程控制期间必须显示明显状态。
6. 共享者本地鼠标或键盘输入会触发 3 秒尊重窗口。
7. 共享窗口时，输入事件不得越过窗口范围。
8. 服务端记录远程控制申请、批准、撤销和异常终止。
9. 授权必须绑定共享者和控制者的具体设备参与者，关联到同一成员的其他设备不得批准、继承或发送控制输入。
10. Web 共享始终不允许成为被控端，服务端必须再次拒绝伪造的 Web 远程控制能力声明。

### 13.6 私聊加密与身份安全

私聊和好友关系必须默认以客户端为信任边界。

1. 全局身份 private key 只保存在本地 OS keyring 或端侧加密备份中。
2. 服务端不能保存私聊明文。
3. home relay 只能保存密文 envelope 和必要路由元数据。
4. 好友申请、私聊消息、私下语音信令都需要签名，接收端必须验证 sender public key。
5. 收件人 public key 变更必须作为高风险事件提示用户确认。
6. 多设备支持需要独立 device key，不能让服务器直接获得主身份私钥。
7. StarEcho 同步好友列表时只能同步端到端加密后的数据。

## 14. 配置设计

EV Server 配置示例：

```yaml
server:
  name: EchoVoice Server
  host: 0.0.0.0
  port: 17878
  public_url: ""
  password_required: false

storage:
  driver: sqlite
  sqlite_path: ./data/echovoice.db
  content_path: ./data/content
  max_storage_bytes: 10737418240

media:
  enabled: true
  voice_enabled: true
  screen_share_enabled: false
  remote_control_enabled: false
  accompaniment_enabled: false
  soundboard_enabled: false
  max_voice_bitrate: 64000
  max_screen_bitrate: 2500000
  max_soundboard_file_kb: 512

content:
  emoji_enabled: false
  file_storage_enabled: false
  max_emoji_file_kb: 1024
  auto_receive_emoji_max_kb: 1024
  max_channel_file_mb: 512

relay:
  dm_relay_enabled: false
  private_voice_relay_enabled: false
  home_mailbox_enabled: false
  max_mailbox_bytes_per_user: 104857600
  max_envelope_kb: 512
  envelope_ttl_days: 30

security:
  allow_insecure_http: true
  session_ttl_minutes: 60
  rate_limit_per_minute: 120

log:
  level: info
  audit_enabled: true
```

## 15. 推荐仓库结构

```text
EchoVoice/
  apps/
    desktop/
      ui/
        src/
        public/
      src-tauri/
        src/
        tauri.conf.json
    mobile_android/
      README.md
    mobile_ios/
      README.md
    mobile_harmonyos/
      README.md
  crates/
    ev-core/
    ev-crypto/
    ev-net/
    ev-store/
    ev-media/
    ev-protocol/
  services/
    ev-server/
      cmd/
      internal/
        api/
        auth/
        config/
        content/
        media/
        permission/
        storage/
        websocket/
      migrations/
      tests/
    starecho/
      cmd/
      internal/
  packages/
    ev_protocol/
      openapi/
      events/
      schemas/
  docs/
    architecture/
    api/
    deployment/
  infra/
    docker/
    compose/
  README.md
```

## 16. 实现路径

### Phase 0：项目基础与技术验证

目标：验证核心技术选型，不急于做完整 UI。

任务：

1. 初始化仓库结构。
2. 创建 Tauri 2 + Svelte + TypeScript 桌面客户端工程。
3. 创建 Go 服务端工程。
4. 创建 Rust workspace 和 `ev-core` 基础模块。
5. 建立 OpenAPI 或共享协议定义。
6. 验证客户端与服务端 WebSocket 通信。
7. 验证桌面端麦克风采集与 WebRTC 音频连接。
8. 验证 Windows、macOS、Linux 的 WebView 渲染差异。
9. 验证 Rust 原生层调用系统 keyring、SQLite、通知和托盘。
10. 验证 SQLite migration。

交付标准：

1. 服务端可启动。
2. 客户端可连接本地服务端。
3. WebSocket 能收发测试事件。
4. 两个桌面客户端能进入同一测试语音房并听到音频。
5. Windows、macOS、Linux 基础 UI 截图无明显布局差异。
6. 如果 WebView 媒体能力不稳定，需要确认 Rust 原生媒体层回退方案。

### Phase 1：自建服务器与基础客户端

目标：完成“通过 IP + 端口 + 密码连接服务器”的主流程。

任务：

1. 实现 `/connect` 首次连接。
2. 实现首个连接用户成为 owner。
3. 实现 uuid + key 签发、hash 保存、本地安全存储。
4. 实现服务器资料、成员资料、频道树获取。
5. 实现基础桌面端 UI：
   - 服务器列表
   - 连接服务器页
   - 频道栏
   - 成员列表
6. 实现文字频道基础消息。

交付标准：

1. 用户可以输入地址和密码连接服务器。
2. 首个用户自动成为 owner。
3. 关闭客户端后再次打开仍能登录同一服务器。
4. 多个客户端能看到彼此成员资料。
5. 文字频道可发送和接收消息。

### Phase 2：权限组、角色与频道管理

目标：建立 Discord-like 的权限框架。

任务：

1. 实现 `@everyone` 默认角色。
2. 实现角色创建、排序、权限配置。
3. 实现成员绑定多个角色。
4. 实现频道创建、编辑、删除、排序。
5. 实现频道级权限覆盖。
6. 实现服务端权限中间件。
7. 实现审计日志。

交付标准：

1. owner 可以创建角色并分配权限。
2. 权限变化能实时影响客户端 UI。
3. 无权限用户无法通过 API 绕过限制。
4. 管理操作写入审计日志。

### Phase 3：语音频道 MVP

目标：让 EV 具备核心语音软件能力。

任务：

1. 实现语音频道加入、离开。
2. 实现 WebRTC 信令协议。
3. 实现服务器端 SFU 音频转发。
4. 实现说话状态检测。
5. 实现自我静音、自我禁听。
6. 实现管理员静音、禁听、移动成员。
7. 实现语音连接状态 UI。

交付标准：

1. 多人可在同一语音频道通话。
2. 管理员可拖拽成员到其他语音频道。
3. 静音、禁听状态在所有客户端同步。
4. 断线重连后状态恢复合理。

### Phase 4：屏幕共享、远程控制与播放音乐

目标：补齐计划中的扩展媒体能力。

任务：

1. 在服务器设置中加入屏幕共享开关。
2. 在权限系统中加入 `ShareScreen`。
3. 实现桌面端屏幕/窗口选择。
4. 实现屏幕共享视频 track 转发。
5. 在屏幕共享开始时加入“允许其他用户申请控制”选项。
6. 实现远程控制申请、批准、拒绝、撤销。
7. 实现窗口共享时的窗口范围控制限制。
8. 实现被控端本地输入触发 3 秒尊重窗口。
9. 在服务器设置中加入播放音乐服务开关。
10. 在权限系统中加入 `PlayAccompaniment`。
11. 实现 Windows 进程音频作为独立 Opus track 推流。
12. 实现管理员结束媒体 session。
13. 实现 Windows 窗口定向音频与全屏排除 EchoVoice 的共享音频。
14. 实现 Web 共享音频并展示无法过滤 EchoVoice 的回声风险。

交付标准：

1. 未开启服务时，客户端不展示或禁用入口。
2. 无权限用户无法发起屏幕共享、远程控制或播放音乐。
3. 同频道成员可观看屏幕共享。
4. 共享者批准后，观看者可以远程控制共享内容。
5. 被控端本地输入会立即暂停控制端 3 秒。
6. 同频道成员可听到播放的音乐。

### Phase 5：声音板、表情与文件存储

目标：完成语音社区常用内容扩展能力。

任务：

1. 实现服务器声音板上传、管理、播放。
2. 实现用户本地声音板。
3. 实现声音板 sha256 全局缓存。
4. 实现服务器表情上传、管理、发送。
5. 实现用户本地表情包和保存他人表情。
6. 实现 gif 表情展示和静态预览。
7. 实现大于 1 MB 表情的手动确认接收。
8. 实现频道文件根路径、目录、上传、下载、删除、重命名。
9. 实现语音频道聊天入口的文件上传。
10. 实现内容资产 sha256 校验、引用计数和缓存清理。

交付标准：

1. 未开启服务时，客户端不展示或禁用入口。
2. 无权限用户无法播放声音板、发送表情或使用频道文件。
3. 相同 sha256 的声音板和表情可以跨服务器命中本地缓存。
4. 删除频道会删除对应频道文件根路径和文件条目。
5. 大文件表情不会在未确认时自动下载。

### Phase 6：好友、私聊、私下语音与 Home Relay

目标：在不破坏去中心化架构的前提下，实现好友与私密通信。

任务：

1. 实现客户端全局用户身份密钥生成与 OS keyring 保存。
2. 实现 `ev_user_id = hash(public_key)`。
3. 实现 member 与 ev_user_id 的签名绑定。
4. 实现同服务器好友申请中继。
5. 实现本地好友列表、备注、分组和隐私设置。
6. 实现同服务器私聊密文 envelope 中继。
7. 实现同服务器私下语音邀请和 WebRTC 信令。
8. 实现 home relay 加密邮箱投递、拉取、删除。
9. 实现 mailbox 配额、TTL、单 envelope 大小和速率限制。
10. 实现跨服务器在线私聊信令预留接口。

交付标准：

1. 好友关系使用 ev_user_id，不依赖 member_uuid。
2. 同服务器成员可以发送和接受好友申请。
3. 私聊内容在服务端只以密文 envelope 形式存在。
4. B 离线时，A 可以把密文投递到 B 的 home relay。
5. B 上线后可以拉取并本地解密 envelope。
6. 同服务器好友可以发起私下语音。

### Phase 7：StarEcho 平台

目标：实现轻度中心化同步。

任务：

1. 实现 StarEcho 账号注册与登录。
2. 实现用户资料云同步。
3. 实现服务器列表同步。
4. 实现 server credential 加密备份。
5. 实现新设备恢复服务器列表。
6. 实现公开 ev_user_id、public key、home relay 地址查询。
7. 实现端到端加密好友列表同步。
8. 在客户端加入 StarEcho 登录入口。

交付标准：

1. 未登录 StarEcho 时 EV 可正常使用。
2. 登录 StarEcho 后可同步昵称、头像、简介。
3. 新设备登录后可恢复服务器列表。
4. 新设备可以恢复端侧加密后的好友索引。
5. 服务器 access key 不以明文形式存储在 StarEcho。
6. StarEcho 不保存私聊明文。

### Phase 8：发布与运维完善

目标：让普通用户可以安装客户端并部署服务器。

任务：

1. 桌面端安装包。
2. Windows、macOS、Linux 自动更新机制。
3. EV Server 单文件二进制发布。
4. Docker 镜像与 docker-compose。
5. 配置文档、反向代理文档、备份恢复文档。
6. 崩溃日志与诊断导出。
7. Android、iOS、HarmonyOS 移动端可行性评估文档。

交付标准：

1. 普通用户可根据文档启动服务器。
2. 客户端可连接远程服务器。
3. 数据库可备份和恢复。
4. 发布包版本号、更新日志、校验文件完整。

## 17. MVP 范围建议

第一版 MVP 建议只包含：

1. 桌面端优先，只做 Windows、macOS、Linux。
2. 自建 EV Server。
3. IP + 端口 + 密码连接。
4. 首个用户成为 owner。
5. uuid + key 持久登录。
6. 服务器列表。
7. 文字频道。
8. 语音频道。
9. 基础权限组。
10. 管理员移动成员、静音、禁听。

屏幕共享、远程控制、播放音乐、声音板、表情、文件存储、好友、私聊、私下语音、home relay、StarEcho、Android、iOS、HarmonyOS 放在 MVP 后，可以降低第一阶段风险。

## 18. 测试策略

### 18.1 服务端测试

1. 权限计算单元测试。
2. 认证与 key 校验测试。
3. REST API 集成测试。
4. WebSocket 事件测试。
5. 数据库 migration 测试。
6. 多用户语音频道状态测试。
7. 权限控制下的声音板、表情、文件接口测试。
8. 内容资产 sha256 校验与引用计数测试。
9. home relay envelope 投递、拉取、TTL、配额测试。
10. member 与 ev_user_id 签名绑定测试。

### 18.2 客户端测试

1. 状态管理单元测试。
2. 权限展示逻辑测试。
3. 登录与服务器列表测试。
4. 主题切换测试。
5. 关键页面 widget 测试。
6. Windows、macOS、Linux 桌面布局快照测试。
7. 声音板、表情选择器、文件管理器交互测试。
8. 内容缓存命中、未命中、清理测试。
9. 好友申请、私聊会话、离线 envelope 拉取测试。
10. OS keyring 中全局身份密钥保存与恢复测试。

### 18.3 媒体测试

1. 双人语音通话测试。
2. 多人语音通话测试。
3. 弱网与断线重连测试。
4. 麦克风权限拒绝测试。
5. 屏幕共享权限拒绝测试。
6. 长时间语音稳定性测试。
7. 远程控制申请、批准、撤销测试。
8. 尊重窗口输入暂停测试。
9. 声音板多用户同步播放测试。
10. 同服务器私下语音测试。
11. P2P 失败后的 relay fallback 测试。

## 19. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| WebRTC 跨平台行为差异 | 语音、屏幕共享不稳定 | Phase 0 先做技术验证；桌面优先 |
| Tauri WebView 渲染差异 | Windows、macOS、Linux UI 细节不一致 | 使用保守 CSS、设计 token、截图回归测试；复杂媒体能力下沉到 Rust |
| NAT 与公网连接复杂 | 自建服务器连接失败 | MVP 先要求服务端有公网 IP 或端口映射；后续加入 STUN/TURN 文档 |
| iOS/HarmonyOS 后台音频限制 | 移动端体验受限 | 移动端后置，单独规划后台音频与系统权限 |
| 权限系统复杂 | 容易出现越权漏洞 | 权限计算集中在服务端，配套单元测试 |
| 屏幕共享实现难度高 | 延误核心语音功能 | 放在语音 MVP 后 |
| 远程控制安全风险 | 误操作或越权控制用户设备 | 默认关闭，必须多层授权，窗口控制限制和 3 秒尊重窗口 |
| 播放音乐涉及版权与滥用 | 产生合规风险 | 只实现本地推流，不提供公共曲库 |
| 声音板滥用 | 语音频道刷屏或骚扰 | 权限控制、播放冷却、管理员结束 session |
| 表情与文件占用存储 | 自建服务器磁盘膨胀 | 配额、大小限制、引用计数、清理任务 |
| 内容缓存投毒 | 恶意文件伪装成已有内容 | 客户端和服务端都校验 sha256 |
| 全局身份私钥丢失 | 用户失去好友身份和私聊解密能力 | OS keyring 保存，提供端侧加密备份和恢复码 |
| Home relay 被滥用 | 邮箱占满磁盘或被刷 envelope | 单用户配额、TTL、速率限制、封禁策略 |
| 私聊元数据泄露 | 中继服务器仍可看到投递时间和收件人 | 正文端到端加密，后续减少元数据暴露 |
| 跨服务器私下语音不可达 | NAT 或 relay 缺失导致通话失败 | 优先同服务器实现，后续提供 TURN/relay 配置 |
| StarEcho 凭证备份安全 | 泄露服务器访问 key | 使用端侧加密，StarEcho 不保存明文 key |

## 20. 开发优先级

推荐优先级：

1. 服务端认证、成员、频道、权限。
2. 客户端连接服务器与基础 UI。
3. WebSocket 实时事件。
4. 文字频道。
5. 语音频道。
6. 语音频道聊天入口。
7. 管理员语音管理能力。
8. 屏幕共享。
9. 远程控制。
10. 播放音乐。
11. 声音板。
12. 表情系统。
13. 频道文件存储。
14. 全局用户身份。
15. 同服务器好友、私聊、私下语音。
16. Home relay 加密邮箱。
17. StarEcho。
18. 插件、机器人、公共发现。

## 21. 后续扩展方向

1. 邀请链接。
2. 跨服务器好友发现。
3. 跨服务器离线私聊多 relay 冗余。
4. 公共服务器发现。
5. 机器人 API。
6. 插件系统。
7. 文件版本历史。
8. 端到端加密语音频道。
9. 服务器集群部署。
10. 管理后台 Web 控制台。
11. 可视化主题编辑器。

## 22. 结论

EchoVoice 的工程路线应优先保证“用户能自建服务器，并稳定进行语音沟通”。技术上建议采用 Tauri 2 + Svelte + Rust core 桌面客户端、Go/Pion 服务端和 SQLite 的组合，先形成小巧可运行的桌面自建语音软件，再逐步加入屏幕共享、远程控制、播放音乐、声音板、表情、频道文件存储、好友私聊、home relay 加密邮箱、StarEcho 同步平台，以及 Android、iOS、HarmonyOS 移动端。

项目实施时应避免一开始就追求完整 Discord 规模能力。正确路径是先把服务器身份、权限、频道、语音四个核心模型做稳，再扩展全局用户身份、好友私聊、媒体能力与轻度中心化同步。
