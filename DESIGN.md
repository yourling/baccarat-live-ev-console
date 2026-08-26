# 百家乐实时 EV 中控台 Design System

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
| Text primary | `--text-primary` | `#e6edf3` | 正文与数据 |
| Text strong | `--text-strong` | `#f4f7fa` | 标题与关键数值 |
| Text muted | `--text-muted` | `#8ea3b3` | 说明与元数据 |
| Border | `--border-default` | `#263846` | 卡片、分隔线 |
| Border strong | `--border-strong` | `#334657` | 输入与可交互边框 |
| Accent | `--accent-primary` | `#14856b` | 主操作 |
| Accent hover | `--accent-hover` | `#1a9c7c` | 主操作悬停 |
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
|---|---:|---:|---|
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

桌面内容宽度不超过 1480px；监控行在宽屏上采用多列摘要，在窄屏上折叠为单列。新的拖放反馈不能改变布局尺寸，只用边框和背景层级表达目标位置。

## 5. Components

### Monitor card
- **Structure**: 可投放的 `article`、无文字排序手柄、桌台身份/局号、状态、闲庄牌面、对子 EV、连接与自动下注摘要，以及独立的手动测试下注区。
- **Manual test wager**: 金额输入默认 `20`，紧邻四个稳定宽度操作按钮：庄、闲、庄对、闲对；按钮均显示进行中、已接受、已拒绝、结果未知和当前不可下注状态，避免在执行中改变卡片尺寸。
- **States**: 默认、告警、拖拽中、可投放目标、无当前局号、无牌面、手动下注执行中、已接受、已拒绝、结果未知、当前不可下注。
- **Accessibility**: 拖拽手柄有明确标题和 `aria-label`；当前局号以文本方式呈现；非视觉状态不得只依赖颜色。
- **Interaction**: 手动下注控件阻止卡片打开行为；每个下注按钮使用可见文字、禁用态和明确的结果反馈。
- **Motion**: 仅 120ms 的颜色/边框过渡。

### Monitor table configuration
- **Structure**: 一行受控文本输入、当前已保存桌号摘要、保存按钮与格式提示。
- **States**: 默认、保存中、格式错误、空数据、已保存。
- **Accessibility**: 使用明确标签、帮助文本和错误文字；不以占位符代替标签。

### Unified betting settings
- **Structure**: 一组全局最低 EV、基础金额、EV 阶梯与一次保存操作；保存时同步全部受监控牌桌。
- **States**: 默认、编辑、保存中、格式错误、无受监控牌桌。
- **Accessibility**: 每个输入均有明确标签；删除阶梯使用带 `aria-label` 的图标按钮；所有焦点态使用 `--focus-ring`。

### Record actions
- **Structure**: 筛选器、查询、分页和危险性清除记录操作。
- **Interaction**: 首次切换到决策、事件或账本视图时自动加载当前页；筛选项变更不自动查库，点击查询或切换分页后才加载对应记录页。
- **Safety**: 清除记录必须二次确认，并通过 SQLite `VACUUM` 回收已删除记录占用的空间；牌桌和下注配置保留。

### Global automated wagering
- **Structure**: 页头的全局开启/停止按钮，以及间隔分钟数、庄/闲分段选择、金额输入和上次尝试/成功状态。
- **States**: 关闭、已启用且等待、执行中、已在某张牌桌下注、所有牌桌不可下注、桥接不可用。
- **Interaction**: 开启后立即进入保活周期，按监控牌桌的显示顺序依次尝试；不等待人工确认牌靴。可信的新牌靴或连接恢复后，自动重臂对子 EV 策略。仅收到平台“已接受”回执才重置成功计时。结果未知时停止本轮，避免跨桌重复下注。
- **Manual recovery**: 牌桌设置中的人工重置牌靴和人工恢复对子策略只用于异常恢复，不是常规开局步骤。
- **Accessibility**: 开关、数字输入和方向选择都有可见标签；状态以文字和颜色共同表达；减少动态偏好下状态变化不使用位移动画。

### Decision hand row
- **Structure**: 每个 `tableId + shoeId + handId` 只显示一行，包含决策时概率/EV、资格、策略选择和实际牌局结果。
- **States**: 达到条件、未达到条件、待结算、已结算（庄对/闲对分别命中或未中）、结算结果未知。
- **Accessibility**: 实际结果必须使用完整文字“命中 / 未中 / 待结算 / 结果未知”，不得只依赖徽标颜色；牌靴和牌局 ID 保留完整 `title`。
- **Data rule**: 分页、总数和资格筛选必须在按局聚合后计算；底层逐市场审计记录不在 UI 层改写或删除。
- **Filter rule**: 选择单一市场时，概率、EV 与资格只聚合该市场的决策，不能先筛选牌局后再混回另一市场。
- **Settlement rule**: 结算按 `tableId + shoeId + handId` 精确关联，不以决策/结算墙钟先后作为前提；同键存在更正事件时，以最后写入事件账本的一条为准。

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|---|---:|---|---|
| Micro | 120ms | ease-out | 按钮、边框、拖放目标 |
| Standard | 200ms | ease-in-out | 展开详情、筛选变更 |

拖动桌台时，源项降低不透明度，目标项仅以 `--focus-ring` 边框和轻微背景变化提示；不使用位移动画造成实时数据误读。减少动态偏好下保持无动画或仅保留不透明度变化。

## 7. Depth & Surface

采用 **borders-only + tonal-shift**：使用 `#0b1118 → #101923 → #111c26` 的表面层级与 1px 边界区分区域，不使用大阴影。可投放目标不增加阴影，只使用边框和背景色。

## 8. Accessibility Constraints & Accepted Debt

- 目标：WCAG 2.2 AA；正文对比度至少 4.5:1；每个输入和按钮都有可见焦点状态。
- 牌桌当前局号必须提供文字，不得只通过颜色或图标表达。
- 拖放排序为鼠标增强操作；将提供稳定的保存顺序，必要时可通过重载保持；键盘完整重排不在本轮范围。

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| 键盘逐项移动桌台 | 监控行排序 | 当前请求明确为拖拽排序，先保证鼠标与触控板可靠 | 需要无障碍排序需求时补齐上移/下移按钮 |
