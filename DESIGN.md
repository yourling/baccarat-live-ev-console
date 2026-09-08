# 百家乐实时 EV 中控台 Design System

## 当前实现与发布状态

本文记录当前桌面端 UI 的实际行为与视觉约束，不代表真实资金功能已获产品或安全批准。真人厅平台对接 Pragmatic Play 与 Dafabet BG；Dafabet 启动器为 Jeju Speed Baccarat 与 `live-baccarat-bg`，两个扩展互斥。四市场手动 `OperationalWager`、庄/闲保活和对子 EV 自动策略现在共用 actor、reservation、全局风控、回执审计与结算链路；运行监督器会在桥接、数据新鲜度、连续性或资金状态异常时失败关闭。保活与对子自动投注是互相独立的页头开关。真实资金发布仍待独立非资金长稳验收和外部授权。

## 1. Atmosphere & Identity

这是一个低干扰、深色的实时运营中控台：信息密度高，但以清晰的层级、稳定的表格节奏和克制的青绿状态色来建立可信感。识别特征是“暗色控制台 + 薄边界 + 状态点”，操作层始终服从实时牌桌状态，不使用装饰性图形干扰判断。

## 2. Color

### Palette

| Role | Token | Dark value | Usage |
|---|---|---:|---|
| Canvas | `--surface-canvas` | `#0b1118` | 页面背景 |
| Panel | `--surface-panel` | `#101923` | 摘要、筛选器、卡片 |
| Raised panel | `--surface-raised` | `#111c26` | 设置区与强调面板 |
| Field | `--surface-field` | `#0c141d` | 输入与选择器 |
| Overlay | `--surface-overlay` | `rgb(3 8 12 / 82%)` | 全屏模态遮罩 |
| Text primary | `--text-primary` | `#e6edf3` | 正文与数据 |
| Text strong | `--text-strong` | `#f4f7fa` | 标题与关键数值 |
| Text muted | `--text-muted` | `#8ea3b3` | 说明与元数据 |
| Border | `--border-default` | `#263846` | 卡片、分隔线 |
| Border strong | `--border-strong` | `#334657` | 输入与可交互边框 |
| Accent | `--accent-primary` | `#14856b` | 主操作 |
| Accent hover | `--accent-hover` | `#1a9c7c` | 主操作悬停 |
| Confirmation accent | `--confirmation-primary` | `#11745f` | 确认弹窗普通确认操作 |
| Confirmation accent hover | `--confirmation-primary-hover` | `#147d66` | 确认弹窗普通确认悬停 |
| Focus | `--focus-ring` | `#51b99d` | 输入与拖拽目标 |
| Success | `--status-success` | `#3bc49b` | 连接、健康状态 |
| Warning | `--status-warning` | `#d9a441` | 风险、同步与注意项 |
| Danger | `--status-danger` | `#df6262` | 错误与破坏性操作 |

### Rules
- 青绿色只表达连接、可用或主要提交动作；金色只表达需要注意的状态；红色只表达错误或破坏性动作。
- 新控件沿用现有深色层级和边界色，不引入额外品牌色。

## 3. Typography

- Primary: `"Segoe UI", "Microsoft YaHei", system-ui, sans-serif`
- Mono: `ui-monospace, SFMono-Regular, Consolas, monospace`

| Level | Size | Weight | Usage |
|---|---:|---|---|
| Page title | 24–34px | 700 | 主标题 |
| Section title | 18px | 700 | 设置与记录区标题 |
| Card title | 14–17px | 700–800 | 桌台名称与区块标题 |
| Body | 12–13px | 400–700 | 标签、设置说明、操作 |
| Caption | 11px | 700 | 元数据、局号、字段标签 |

游戏局号、牌靴 ID、连接细节使用 Mono 字体，避免字形歧义。

## 4. Spacing & Layout

- Base unit: 4px。
- `--space-1` 4px：图标与标签。
- `--space-2` 8px：行内控件与状态标签。
- `--space-3` 12px：字段间距。
- `--space-4` 16px：卡片和设置区内边距。
- `--space-6` 24px：页面区块间距。
- `--space-8` 32px：页面外边距。

桌面内容宽度不超过 1480px；监控表在宽屏上横向展开，在窄屏上按单元格 `data-label` 折叠。拖放反馈不能改变行高或列宽，只用边框和背景层级表达目标位置。

## 5. Components

### Header actions
- **Structure**: 页头从左到右为「开启/停止保活」「开启/停止自动投注」「开始/停止持续模拟」「刷新」。
- **Independence**: 保活只调度庄/闲 `OperationalWager`；自动投注只武装对子策略。两者互不影响。存在实盘牌桌时，开启自动投注必须二次确认。
- **Accessibility**: 按钮文字包含当前动作与进行中状态，不以颜色单独表达开关。

### Monitor row
- **Structure**: 可拖放的表格行，含无文字排序手柄、桌台身份/局号、状态、开盘、连接、自动、剩余张数、庄对/闲对 EV、闲庄牌面、紧凑手动下注区和移除按钮。点击行打开本桌设置对话框。
- **Pair EV**: 仅在有效 `physical-shoe`（snapshot overlay 后的基线，证据为协议洗牌/路子回绕/人工确认）时计算并分别显示「庄对」「闲对」；否则显示「待牌靴」，剩余张数显示「未知」。不得用假库存或入桌 #55/407 张推 EV。
- **Manual operational wager**: 使用页面当前默认筹码（代码默认 `20`），不再提供金额输入或点选筹码。四个稳定宽度按钮：庄、闲、庄对、闲对。按钮显示进行中、已接受、已拒绝、结果未知和当前不可下注状态，避免改变行高。每次请求由 `TableActor` 串行化并先进入风控/reservation；受控路径要求 `live`，还必须通过实体牌靴、连接、下注窗口、桥接身份和运行授权门禁。
- **States**: 默认、开盘、告警、拖拽中、可投放目标、无当前局号、无牌面、待牌靴、手动下注执行中、已接受、已拒绝、结果未知、当前不可下注、无人值守已阻断。
- **Accessibility**: 拖拽手柄有明确标题和 `aria-label`；当前局号以文本方式呈现；非视觉状态不得只依赖颜色。
- **Interaction**: 手动下注控件阻止行点击打开设置；移除按钮同样 `stopPropagation`。每个下注按钮使用可见文字、禁用态和明确的结果反馈。
- **Motion**: 仅 120ms 的颜色/边框过渡。

### Pending join tables
- **Structure**: 监控表下方的「待加入牌桌」列表，展示已发现但尚未晋升为监控桌的 Dafabet Pragmatic / BG 桌。
- **States**: 空、等待换靴回绕、可手动加入、已达 64 桌上限。
- **Rule**: 不会把整个大厅目录一次灌入监控。自动晋升只发生在本进程见过协议 shoeReset token 变化、路子明显回绕，或人工确认重置牌靴之后；第一次见到 token 不得晋升。因缺牌过多被移出监控的桌回到待加入，同一靴不得自动加回，下一靴或人工加入后才可再晋升。操作者也可手动加入。

### Monitor table configuration
- **Structure**: 设置页中的受控文本输入、当前已保存桌号摘要、保存按钮、「加入全部已发现桌」批量和格式提示。
- **States**: 默认、保存中、格式错误、空数据、已保存。桌号接受遗留大写短号（如 `D055`）或 Pragmatic 小写 id（8–32 位字母数字）。
- **Accessibility**: 使用明确标签、帮助文本和错误文字；不以占位符代替标签。

### Unified betting settings
- **Structure**: 一组全局最低 EV、基础金额、EV 阶梯、风险上限与一次保存操作；保存策略时同步全部受监控牌桌。新晋升或新注册的监控桌强制继承这套设置，不得沿用出厂 `minEV=0` / 默认注 100。
- **States**: 默认、编辑、保存中、格式错误、无受监控牌桌。
- **Accessibility**: 每个输入均有明确标签；删除阶梯使用带 `aria-label` 的图标按钮；所有焦点态使用 `--focus-ring`。

### Monitor table settings dialog
- **Structure**: 本桌对话框，含自动下注状态、人工重置牌靴、人工恢复/暂停对子策略、删除监控、执行模式（固定展示「真实下注」）和副数修正。
- **Rule**: 无有效物理牌靴（含 overlay 后的待牌靴）时禁用「人工恢复对子策略」；「人工重置牌靴」只在平台未自动识别新靴时使用。设置弹窗与监控行使用同一套有效基线/证据，不得读 actor 内存里未 overlay 的 physical 标签。

### Record actions
- **Structure**: 筛选器、查询、分页和危险性清除记录操作。视图为总览、监控、决策、事件、账本、设置。
- **Interaction**: 首次切换到决策、事件或账本视图时自动加载当前页；筛选项变更不自动查库，点击查询或切换分页后才加载对应记录页。
- **Safety**: 清除记录必须二次确认，并通过 SQLite `VACUUM` 回收已删除记录占用的空间；牌桌和下注配置保留。

### Confirmation dialog
- **Structure**: 通过 `document.body` Portal 渲染的全屏遮罩与单一确认面板，包含标题、说明、可选详情、取消和确认操作。
- **States**: 普通确认、危险确认和当前 `OperationalWager` 的真实资金警告确认。
- **Layering**: 使用独立顶层 stacking context，不受牌桌表格 `overflow`、页面滚动区或设置弹窗层级影响。
- **Interaction**: 打开后锁定背景滚动和焦点；`Escape`、遮罩与取消按钮返回取消；关闭后恢复触发控件焦点。
- **Accessibility**: `role="dialog"`、`aria-modal="true"`、明确标题与说明；默认焦点落在取消按钮，避免误触实盘或破坏性操作。当前 `OperationalWager` 模态仅要求点击确认，没有逐字输入的确认字段；逐字确认只适用于庄对/闲对 `BetIntent` 的单次下注 API。
- **Motion**: 仅使用 120ms 不透明度反馈；减少动态偏好下无位移动画。

### Global operational wager keepalive
- **Structure**: 页头的全局开启/停止按钮，以及设置页中的间隔分钟数、庄/闲选择、金额输入和上次尝试/成功状态。保存策略不会自动开启保活。
- **States**: 关闭、已启用且等待、执行中、已在刚开盘的一桌尝试、该桌当前不可下注、桥接不可用、运行时阻断、事故降级。
- **Interaction**: 开启后并不按监控列表扫桌。只有某张已监控桌刚打开下注窗口时，才对该桌尝试一笔庄或闲。窗口剩余不足 5 秒或没有 `closesAt` 则跳过，并进入约 10 秒冷却后再试下一窗，不更新间隔/成功计时。每次真正发出的请求要求 `live`、`physical-shoe`、连接正常、下注窗口、未封靴、运行授权和无本桌 `UNKNOWN`/本桌结算缺口，并使用 reservation、全局限额、牌局结算和按来源复合去重。只在收到 `ACCEPTED` 时更新成功计时。单桌 `UNKNOWN` 占该桌限额并阻断该桌后续执行，不关闭全局保活开关。
- **Recovery**: 新实体牌靴、严格 `cursor-v1` 连续性恢复或人工确认牌靴可触发庄对/闲对策略重新评估。进程重启后的持久批准不会直接恢复执行，必须先由当前进程观察到新鲜牌桌数据并通过全部运行门禁。
- **Accessibility**: 开关、数字输入和方向选择都有可见标签；状态以文字和颜色共同表达；减少动态偏好下状态变化不使用位移动画。

### Runtime supervision
- **Structure**: 页面级健康状态、桥接连接摘要、每桌批准/活动状态、阻断原因和持久事故列表（告警中心）。
- **States**: 健康、降级、阻断；桥接认证失败/断开、连续性失效、数据过期、会话恢复耗尽、结果未知、结算缺口、缺牌过多已移出监控、调度或监控失败。
- **Interaction**: 阻断状态禁用对应真实操作。关闭窗口即退出应用并关闭监控与桥接。再次启动会开新进程；重启会关掉执行器与无人值守授权，牌桌仍为真实下注模式，不会沿用旧连接，也不会先降成 `shadow`。
- **Data rule**: live 批准和事故记录持久化；默认裁剪到 200 条，但仍生效的阻断事故不可被历史上限淘汰。事故消息限制长度并脱敏 URL 与常见凭据字段。

### Decision hand row
- **Structure**: 每个 `tableId + shoeId + handId` 只显示一行，包含决策时概率/EV、资格、策略选择和实际牌局结果。
- **States**: 达到条件、未达到条件、待结算、已结算（庄对/闲对分别命中或未中）、结算结果未知。
- **Accessibility**: 实际结果必须使用完整文字“命中 / 未中 / 待结算 / 结果未知”，不得只依赖徽标颜色；牌靴和牌局 ID 保留完整 `title`。
- **Data rule**: 分页、总数和资格筛选必须在按局聚合后计算；底层逐市场审计记录不在 UI 层改写或删除。
- **Filter rule**: 选择单一市场时，概率、EV 与资格只聚合该市场的决策，不能先筛选牌局后再混回另一市场。
- **Settlement rule**: 结算按 `tableId + shoeId + handId` 精确关联，不以决策/结算墙钟先后作为前提；同键存在更正事件时，以最后写入事件账本的一条为准。换靴后仍保留近期 `handSettled`，以便决策行继续显示实际结果。

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|---|---:|---|---|
| Micro | 120ms | ease-out | 按钮、边框、拖放目标 |
| Standard | 200ms | ease-in-out | 展开详情、筛选变更 |

拖动桌台时，源行降低不透明度，目标行仅以 `--focus-ring` 边框和轻微背景变化提示；不使用位移动画造成实时数据误读。减少动态偏好下保持无动画或仅保留不透明度变化。

## 7. Depth & Surface

采用 **borders-only + tonal-shift**：使用 `#0b1118 → #101923 → #111c26` 的表面层级与 1px 边界区分区域，不使用大阴影。可投放目标不增加阴影，只使用边框和背景色。

## 8. Accessibility Constraints & Accepted Debt

- 目标：WCAG 2.2 AA；正文对比度至少 4.5:1；每个输入和按钮都有可见焦点状态。
- 牌桌当前局号必须提供文字，不得只通过颜色或图标表达。
- 无物理牌靴时不得用颜色或占位 EV 暗示可下注。
- 拖放排序为鼠标增强操作；将提供稳定的保存顺序，必要时可通过重载保持；键盘完整重排不在本轮范围。

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| 键盘逐项移动桌台 | 监控行排序 | 当前请求明确为拖拽排序，先保证鼠标与触控板可靠 | 需要无障碍排序需求时补齐上移/下移按钮 |
| 真实资金发布授权 | 打包应用与真实站点运行 | 工程链路和失败关闭已实现，但尚无独立真实站点非资金长稳报告、产品/安全审批和资金授权 | 完成外部验收、合规确认和正式发布审批 |
