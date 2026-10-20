# dsh-hos-scrcpy

**DSH 的鸿蒙投屏 provider** —— 让 DSH 通过 `hdc` 连上鸿蒙设备：看画面、点/滑、按键、输入文字、给 AI 看。

界面、AI 工具、设备与焦点、路由、门槛**全在 core 里**；本包只负责"**这台设备怎么连、怎么点、怎么出画面**"。

## 这是什么

| | |
|---|---|
| 角色 | dsh-scrcpy 的 **provider**（鸿蒙平台） |
| 依赖 | 需要 **`dsh-scrcpy-core`**（不装它本包不激活）。本包**不声明**对 core 的包依赖 —— 两包**自由装**，互不自动拉取 |
| 传输 | `hdc`：USB 调试，或 `hdc tconn` 无线连接 |
| sidecar | 每台设备一个 **Java 进程**（`Dev/src/Main.java` 的编译产物随包发布），由本包 `spawn` 拉起：`java -cp <jar>;<out> Main --sn … --hdc … --port 0 --scale … --frame-rate … --bit-rate … --ifr … --idle-exit …` |
| 协议 | 浏览器半区**直连 sidecar 的 WebSocket**：二进制 H.264（annex-B）+ JSON 控制消息（`size` / `log` / `hid`）；触控与按键走同一条连接 |
| 不在流路径里 | provider 只负责起停 sidecar、报设备、报配置 —— 视频帧与触控**不经它**（这也是它与安卓 provider 最大的区别） |
| 没有 | 浏览器半区、AI 工具、AI 提示词、UI 注册、焦点逻辑（都归 core） |

## 特点

| 特点 | 说明 |
|---|---|
| **跨平台多设备** | 多台同时投屏，各自独立会话与独立标签页；**安卓和鸿蒙可以同时显示，互不冲突**。操作只作用于当前聚焦（面板可见）的那台，不会点错 |
| **华为零售机可用** | 走系统投屏服务那条通路，**不需要 root、不改系统分区、不需要白名单** |
| **转屏** | 转屏后画面跟着走，**不需要重连、不会黑屏**（重建只由流里的 SPS 驱动，平台无关） |
| **切页 / 暂停** | 切走时自动暂停：**不用常驻、也不用断开重连**，暂停期间**占资源很少**；切回来**立刻出画**（sidecar 侧缓存"配置 + 最近关键帧起到现在的帧"并补发）；**暂停期间转过屏，切回来也不崩** |
| **画质** | 有线 / 无线**分别**配缩放与帧率；两端都能到原画，帧率 120 封顶 |
| **AI 操作与权限** | 界面与全部 AI 工具在 core（截图识别 / 控件清单 / 点击 / 长按 / 按键 / 文字输入）；**权限四项各自"禁止使用 / 每次确认 / 无需确认"三态，后三项依赖截图**，关掉时工具直接报原因、不反复重试 |
| **自由装卸** | provider 不含界面、不含 AI、不写提示词；装 core + 装对应平台的 provider 即可，两个 provider 各装各的、互不拉依赖 |

## 安装

在 DSH 的**插件面板**里装上两个包：

| 顺序 | 装什么 | 地址 |
|---|---|---|
| 1 | **core** —— 界面与 AI 工具都在这里 | `@nszzj/dsh-scrcpy-core` |
| 2 | **本包** `@nszzj/dsh-hos-scrcpy` —— 鸿蒙 provider | `@nszzj/dsh-hos-scrcpy` |

- 两包各装一次，别只装 provider（core 缺了本包不会激活）
- 装完 **完全退出 DSH 再打开**（宿主半区改动只有重启才生效；浏览器半区刷新即可）
- 只装 provider 不装 core：本包因注入不满足而静默不激活（设计如此，不是 bug）

## 快速开始

1. 设备开启**开发者模式 + USB 调试**（或 `hdc tconn <ip:port>` 连上；`hdc list targets` 能看到它）
2. DSH 菜单里出现这台设备 → 点那行的「投屏」→ 右侧栏展开成该设备的投屏标签页（首次部署约 5~10 秒）
3. 多设备：每台一张标签页，点哪行跳哪张；某台要收工，点它那行的「断开」（只断这台）
4. 画质（缩放 / 帧率）在菜单里那组 provider 的「**连接设置**」里调；面板里的「设置」管的是 AI 权限（截图 / 控件 / 点击 / 按键 / 输入，后三项依赖"允许截图"）
5. AI 工具作用于**当前聚焦（面板可见）的那台设备**；没有聚焦设备会直接报错，不猜设备

## 环境要求

| 依赖 | 说明 |
|---|---|
| DSH | 电脑端 DeepSeek Harness（Windows / macOS / Linux） |
| **Java 8+** | sidecar 的运行环境（`JAVA_HOME` / DevEco SDK 优先，也可在「连接设置」里手动指定） |
| **hdc** | DevEco Studio 自带：`<DevEco>/sdk/default/openharmony/toolchains/hdc.exe` |
| 鸿蒙设备 | 开发者模式 + USB 调试（或 `hdc tconn` 无线连接） |

## 目录结构

```
lib/index.js                          provider 实现（起停 sidecar / 环境检测 / 连接配置 / 上报设备 + 画面四件套）
resources/hosScrcpy-1.0.18-beta.jar   HOScrcpy SDK（第三方，见 THIRD_PARTY_NOTICES.md）
resources/out/                        sidecar 编译产物（Main 及内部类），随包发布
cordis.patch.yml                      DSH 插件清单
Dev/src/Main.java                     sidecar 源码（DSH ⇄ 设备的 Java 桥）
Dev/demo/                             独立测试件（不依赖 DSH，也不进 npm 包）
Dev/doc.md                            开发资料：架构图 / 开发约定 / 各 demo 用途
Dev/doc-sidecar.md                    sidecar 协议、编译（必须 --release 8）、踩坑
```

## 已知限制

- **连接中途不能改缩放 / 帧率**：要换就断开重连（改设置只对下次连接生效）
- **不做设备日志流**（hilog）：面板里的「日志」是插件诊断日志
- `requestIDRFrame()` 在 SDK 1.0.18 里是**空方法**，不能用来"要一个关键帧"；画面重建靠 sidecar 的 **GOP 缓存补发**（暂停期间转屏 → 恢复时补发配置 + 关键帧）
- 零售设备上可用的镜像通路就是 HOScrcpy 访问的那条系统服务；root / 改系统分区 / 白名单那几类方案在零售机上不可用
- 改宿主半区后必须**完全退出 DSH 再打开**

## 二次开发

- 架构图、开发约定、每个 demo 是干嘛的 → [`Dev/doc.md`](Dev/doc.md)
- sidecar 的协议 / 编译 / 排障 → [`Dev/doc-sidecar.md`](Dev/doc-sidecar.md)
- **基于 core 开发一个 provider** → [core/Dev/doc.md](https://github.com/ns-zzj/dsh-scrcpy-core/blob/main/Dev/doc.md)

## 电脑键盘与文本粘贴（3.0.5）

新增手动电脑输入通道。界面仍由 core 渲染；本仓库附带 `client/computer-input.js` 作为显式 core 配套补丁的源文件，不单独注册另一套投屏界面。仅安装 provider 不会出现新输入区，需应用下方补丁。现有 AI 工具权限不变，面板输入由用户主动操作，目标固定为该面板已连接的设备。

1. 在投屏画面中点击手机的目标输入框。
2. 在下方电脑输入区使用电脑输入法打字，或按 **Ctrl+V** 粘贴电脑中的纯文本。
3. 默认先编辑，再点 **输入到手机**，也可按 **Ctrl+Enter**。这只输入文字，不额外按手机回车。
4. 开启 **实时输入** 后，在这个输入区打字或 Ctrl+V 会直接提交到手机。中文输入法的拼音和候选词留在电脑，只提交已确认的文字。实时模式支持退格、删除、方向键、Home/End、Tab、Ctrl+A 和 Shift 组合键；**Enter 会发送手机回车，聊天应用可能因此发送消息**。Esc 退出实时模式并取消尚未发出的队列。
5. **粘贴电脑文本** 按钮读取电脑剪贴板中的纯文本并直接输入到手机。若浏览器不允许读取，请使用输入区 Ctrl+V，再点输入按钮。暂不传输图片、文件或富文本。

这条通道通过 HDC 和 `uitest`/`uinput` 工作，不是 UHID 虚拟键盘；焦点须留在目标手机输入框中，电脑按键只在电脑输入区中转发。逐键有延迟，文本按顺序排队并合并尚未执行的相邻文本；切走面板停止后续排队输入。失败或结果不明时停止，不自动重放；输入区保留待核对文本，当前失败项可能已经进入手机，需检查后再决定是否输入。单次最多 **4096 个 UTF-8 字节**，超长文本明确拒绝，不会静默截断。

### 应用 core 面板补丁

仅支持经过源码哈希校验的 `@nszzj/dsh-scrcpy-core` **1.0.2**，不兼容未知修改或新版本。脚本不在 provider 安装时自动运行：

```powershell
node scripts/patch-core-input.mjs "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@nszzj\dsh-scrcpy-core" --check
node scripts/patch-core-input.mjs "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@nszzj\dsh-scrcpy-core"
```

修改前备份 core 的 `client/client.js` 为 `client/client.js.before-computer-input`，再次运行同一补丁为幂等检查。应用后完全重启 DSH 并重新打开/刷新投屏面板。回滚时恢复这个备份并重启；core 升级可能覆盖补丁，不要强制套用到未知源码。

### 手机复制到电脑

**当前不支持读取手机系统剪贴板或双向自动同步。** 现有 HOScrcpy SDK 没有剪贴板 API，已检查设备的普通 HDC/uitest 命令也没有获取剪贴板文本的接口。`PasteboardService` 的 `hidumper --data` 在上游实现中只返回来源、时间、MIME 类型等元数据，不返回文本内容，不能代替剪贴板读取。不能把控件树文字或 OCR 结果当成用户复制的内容。

反向复制需要额外的手机端组件，在用户手势与设备权限允许时读取剪贴板，再通过受限通道回传；这尚未实现和验收。当前可以由用户主动将文本分享/导出到电脑可打开的位置，再在电脑中复制。

### 验证范围

自动测试覆盖 IME 候选输入不转发、确认词提交一次、Ctrl+V 多行 Unicode 原文传输、设备级顺序、编辑键映射、失败停止、断连复查及 core 补丁语法/幂等。HDC 字节验证使用伪 `uitest`，不操作手机界面。实际应用输入、回车语义和输入法事件顺序仍需在安装后通过真实投屏面板验收。

## 中文输入修复（3.0.4）

Windows 版 `hdc.exe` 可能在接收命令行参数时把中文变成 `?`。文本现在先编码为纯 ASCII 的 UTF-8 八进制序列，再在设备 shell 中还原后交给 `uitest uiInput text`。中文、emoji、引号、shell 特殊字符和首尾空白均保留；不会把用户内容当成 shell 代码执行。

输入只执行一次，使用随机完成标记检查设备端退出码；HDC 本机退出码为零不足以证明远端输入成功。移除了错误的 `uinput -T` 回退（该选项是触摸操作），不在失败或结果未知时自动重试。一次输入最多 4096 个 UTF-8 字节，拒绝 NUL 和无效 Unicode。工具返回成功表示设备输入命令已完成，最终画面仍应通过控件或截图核对后再发送。

可选的真机只读验证：设置 `DSH_HDC_TEST_PATH` 为 HDC 可执行文件、`DSH_HDC_TEST_SN` 为设备序列号，再运行 `node --test --test-isolation=none`。测试用 shell 函数覆写 `uitest`，只检查字节及远端退出码，**不会向设备输入文本**。在限制子进程管道的沙箱中运行此项测试需要允许 HDC 子进程。

## 桌面版兼容修复（3.0.3）

- 控件坐标改用 `DisplayManagerService` 的当前逻辑显示尺寸，支持横竖屏，并排除投屏虚拟屏尺寸。不再把控件最大边界当成屏幕大小。
- 即使仅能读到状态栏，也使用真实屏幕尺寸归一化坐标，避免把 `1600×137` 的状态栏当成整个屏幕。无法查询真实尺寸时返回明确错误。此修复不会让兼容层或自绘应用凭空提供控件树；这类界面仍需截图识别。
- 当前 `scrcpy_screenshot` 的版本检查属于 **core**。本包旧版 `hos_scrcpy_screenshot` 中遗留的检测函数不是 3.x 的执行入口，单改它无法修复截图工具。

### core 1.0.x 的显式配套修复

桌面安装包中的 DSH 可能位于 `resources/app.asar`，旧版 core 只检查 CLI 安装目录，从而误报“无法读取 DSH 版本”。仓库附带 `scripts/patch-core-version.mjs`，读取归档内真实的 `@deepseek-ai/dsh/package.json`；同时保留旧 CLI 和自定义 profile 布局支持。它不伪造版本，不改变最低版本限制、设备权限或每次确认流程。

此脚本**不会在安装本插件时自动运行**，需要明确指定 core 的包目录。先检查，再应用：

```powershell
node scripts/patch-core-version.mjs "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@nszzj\dsh-scrcpy-core" --check
node scripts/patch-core-version.mjs "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@nszzj\dsh-scrcpy-core"
```

脚本仅接受已知的 core 1.0.x 检测实现，遇到未知代码会停止；修改前保存 `lib/index.js.before-dsh-version-fix`。自定义安装位置若无法自动发现，可将 `DSH_ASAR_PATH` 设置为真实的桌面 `app.asar` 路径，再完全重启 DSH。归档读取有大小限制，不会把整个桌面应用读入内存。

应用补丁后，**完全退出并重启 DSH**。只刷新网页不会重载宿主插件。回滚时将备份恢复为 core 的 `lib/index.js`，删除本脚本添加的 core `lib/dsh-version.js`，然后重启。core 更新可能覆盖补丁，需重新运行 `--check`；不应对未知的新版本强制应用。

### 开发验证

```sh
node --test
# 沙箱禁止测试进程管道时（需支持此参数的 Node 版本）：
node --test --test-isolation=none
```

可选：将 `DSH_CORE_TEST_ROOT` 设置为已安装的 core 包目录后运行测试，会对它的真实截图工具入口做模拟集成验证，检查版本、权限和确认仍有效；不修改安装文件、不实际截图或发送设备操作。

## 许可与第三方

- 本包：**MIT**（见 `LICENSE`）
- `resources/hosScrcpy-1.0.18-beta.jar`（HOScrcpy SDK）的出处、签名情况与再分发风险，见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
- `jmuxer.min.js` 只存在于 `Dev/demo/`（开发件，不随 npm 包发布）；它仍随 Git 仓库分发，所以那边单独有一份声明 → [`Dev/demo/THIRD_PARTY_NOTICES.md`](Dev/demo/THIRD_PARTY_NOTICES.md)
