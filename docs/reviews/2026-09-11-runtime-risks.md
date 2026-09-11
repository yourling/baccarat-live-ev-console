# 三个运行时风险的根源分析

针对三个具体问题，逐层追到判定逻辑本身，而不是只看注释怎么写：
1. 重复开多个游戏 iframe
2. 漏记牌面
3. 新牌靴已开却仍在旧牌靴中记录导致 EV 被打爆

---

## 结论速览

| 问题 | 还会发生吗 | 真正的缺口 |
|---|---|---|
| 1. 重复 iframe / 重复采集 | **不会重复记录**，但有一个重置窗口 | 解析器重建会导致同一手产生新 eventId |
| 2. 漏记牌面 | **会**，且其中一条完全静默 | `handHasInventory` 让整手补录被跳过 |
| 3. 新靴漂移打爆 EV | **不会永久卡死**，但窗口期内仍在下注 | hold 期间不暂停下注，且出口依赖 DOM 路子 |

---

## 问题 1：重复开多个游戏 iframe

**先澄清一件事**：三个扩展**都不会自己创建 iframe**。全仓库只有
`apps/browser-extension/content.js:595` 一处 `appendChild`，那是校准横幅（UI），不是游戏页。

真正的风险源是 manifest 全部声明 `all_frames: true`：
content script 与网络 hook 会注入页面内**每一个** frame，而
`frameKind()`（`content.js:35`）产出的 `frame` 字段在桥接侧只用于诊断
（`server.ts:757`），**不参与过滤**。也就是说多 frame 的重复上报是真实存在的。

**为什么最终没有重复记录**：靠两件事
1. **解析器是服务端单例**（`server.ts:1100-1102`，三个 parser 各一个）。所有 frame/tab
   的上报都汇入同一个 parser，同一手牌算出**相同 eventId**
   （`pragmatic-runtime.ts:505`，含随机 `runId` + 稳定 handKey）
2. **ledger 按 eventId 去重**（`ledger.ts:1184-1188`）

多 tab 同理：桥虽然允许多个 extension socket（`server.ts:2577`），但解析器单例 +
eventId 去重仍然挡住重复记录。代价是可能**数据交错**，不是重复。

### 唯一确认的缺口：解析器重置窗口

`server.ts:1400-1402` 会重建 parser（Pragmatic/BG 换新 `runId`）。
**重置后同一手若再次上报，新 eventId 与旧的不碰撞、ledger 里也没有这个新 id
→ 重复记录一次。**

触发：扩展 session 重启 / `extension-session-restarted`（`server.ts:2582`）后的重放；
另外 `resetTable`（取消选择后重新选择，`server.ts:1652`）递增 generation 也会产生
新 eventId，同样绕过两级去重。

**第五轮实证结论（问题 1 就此关闭）**：

- **库存/下注正确性本来就有防线**：投影层 `cardInventoryKeys`
  （`projection.ts:343-345`）按 `${handId}:${position}:${copyId}` 去重，
  重复投递的牌不重复扣减。实测重报同一手后 `remainingTotal` 与 `seenCards` 不变。
  ledger 层的重复事件行是审计噪音，回放幂等，无害。
- **但发现并修复了一个连带缺陷**：ledger 去重命中的重复事件走 `recoverSideEffects`
  → 再次调用 `applyHandSettlement`，而"手内漏采"计数（`table-actor.ts`）没有按手
  去重 —— 实测手内漏采 4 张、重报一次后 missing 翻倍到 8，重复几次就跨过
  缺牌 >10 移出监控的阈值，**桌被误移出监控**。修复：新增
  `missingCountedHands`（`${shoeId}:${handId}` 集合）计数前查重，随 newShoeSignal 重置。
  顺带确认 `riskManager.settleHand` 幂等（只匹配 RESERVED/可结算 UNKNOWN），
  重复投递不会双重结算。
- 回归测试 › "duplicate hand settlement must not double-count missing unobserved
  cards"：覆盖新 eventId 重报与同 eventId 走 recoverSideEffects 两条路径。

---

## 问题 2：漏记牌面

**会。** 有三条路径，其中第 1 条最隐蔽。

### 2.1 `handHasInventory` 让整手补录被跳过（最危险）

`packages/ledger-state/src/projection.ts:245`

```ts
if (handHasInventory(projection, handId)) return;   // 整手直接返回
```

`handHasInventory`（`:216`）只检查该手是否有**任意一张**牌进过库存。

于是：某手 live 只采到 5/6 张、第 6 张漏采，随后该手的 `handSettled` 到达 ——
**整手的补录被跳过**，第 6 张永远不扣减。

- 库存**偏多** → 对子概率偏高 → EV 偏高 → **更易越过 `minEV` 而多下注**
- 注释解释原意是防重启后"cardObserved 是内存数据、handSettled 才是持久数据"导致的重复扣减。
  副作用是**手内漏采无法自愈**

### 2.2 检测机制看不见单张漏记

唯一的缺牌计数在 `packages/orchestrator/src/table-actor.ts:486-490`：

```ts
if (this.lastSettledHandSeq !== undefined && seq > this.lastSettledHandSeq + 1) {
  this.missingUnobservedCards += (seq - this.lastSettledHandSeq - 1) * 6;
}
```

它只认**手序跳号**（整手丢失），**不认手内少牌**。
而 `demoteIfGameCountAnomaly`（`service.ts:823`）的移出监控门槛是缺牌 > 10 张。

`effectiveShoeBaseline` 的 `inventory-contradiction`（`shoe-baseline.ts:182-222`）只抓
"库存偏低/局数对不上"，对"库存偏高 1 张"没有上界检查。

**净结果：单张漏记既不检测也不阻断。**

### 2.3 其它两条

- `bindIncomingShoe` 守旧靴时丢弃新靴的牌（见问题 3）
- Winfinity 没有全量状态帧回补（Pragmatic 有 `server.ts:1823-1832`），网络帧漏采无法补

### 2.4 可控的部分

传输层的连续性问题（`sourceSeq` 断点、`TABLE_EXPORT_PENDING_LIMIT` 溢出）会
**fail-closed**：自动 DISCONNECTED / DISARMED，`demoteAnomalousMonitorTable` 还会移出监控
并停掉 feed。这类"大漏"是可靠的。危险的是"手内静默少一张"。

---

## 问题 3：新靴已开却仍在旧靴记录

这是三个里最接近真金损失的。机制链条如下。

### 3.1 守旧靴逻辑

`packages/orchestrator/src/table-actor.ts:341` 的 `bindIncomingShoe`，
对**所有带 shoeId 的事件**（含新靴的 cardObserved / handSettled）：

```ts
if (current.shoeBaseline === 'physical-shoe' && current.seenCards.length > 0) {
  if (current.sealed || current.remainingTotal < 26) return event;
  return null;          // 丢弃
}
```

对 `newShoeSignal` 还多一层：新靴是 physical-shoe 时，
若 `shouldHoldCurrentPhysicalShoe` 为真且**无法比较代数**（Pragmatic / Winfinity 的
shoeId 没有代数，`bgShoeGeneration` 返回 undefined）→ 直接 `return null`。

判定在 `shouldHoldCurrentPhysicalShoe`（`:334`）→ `isPrematurePhysicalShoeReset`
（`shoe-baseline.ts:59-72`）：

- `handNumber >= 10`
- `handNumber < 45`
- `remainingTotal >= 26`
- **`remainingTotal > 180`**

设计意图（AGENTS.md 明写）：**禁止用滞后 DOM 路子号降级刚洗完的实体靴**。
"刚洗完还剩 180+ 张"时收到换靴信号，大概率是滞后误报 —— 所以先按住。

### 3.2 关键：按住的代价

hold 生效期间，新靴的 `newShoeSignal`、`cardObserved`、`handSettled` **全部被丢弃**
（`:385-389` 的 `if (bound === null) return;`，事件连落库都不会）。

于是：
- 旧靴 `remainingTotal` **冻结**在 > 180（不再有牌消耗它）
- 旧靴**永远不会 sealed**
- `isPhysicalShoeBettable` 保持 true（`projection.ts:263`）
- **系统继续在旧靴库存模型上评估对子 EV 并下真金注**，而真实牌桌已经换靴

### 3.3 出口是存在的 —— 但依赖 DOM 路子

`shouldHoldCurrentPhysicalShoe` 里有一句：

```ts
const road = this.observedGameCount?.(this.tableId);
if (typeof road === 'number' && isWrapShapedRoadCount(current.handNumber, road)) return false;
```

`isWrapShapedRoadCount`（`shoe-baseline.ts:43`）= `handNumber >= 10 && gameCount ∈ [1,8]
&& handNumber - gameCount >= 8`。

路子计数**允许回绕下降**（`pragmatic-runtime.ts:80` → `isRoadWrapToNewShoe`），
所以 `gameCount` 从 30 掉到 1 会被接受 → 判定回绕 → **不 hold → 新靴放行**。

**所以不是永久死锁。** 另外 handNumber 涨到 45、或 remaining 掉到 180 以下，也会自动放行。

### 3.4 残余风险（真正的答案）

出口**完全押在 `observedGameCount` 上**。如果换靴瞬间路子号也一起滞后
（同一个 DOM 渲染周期，AGENTS.md 自己承认 DOM 会滞后），那么：

- `road` 仍是旧值 → 不判定回绕 → 继续 hold
- 这段时间里系统**在错误的库存模型上评估并下注**

窗口长度 = DOM 路子更新到显示回绕的时间（通常几秒到几十秒）。但若路子采集
**彻底失效**（选择器变更、frame 未注入），则永久卡住 —— 而且因为新靴事件全被丢弃，
`missingUnobservedCards` 也不会增长，**缺牌移出监控的兜底同时失效**。

### 3.5 最该改的一点

hold 期间既然"靴状态不确定"，就**不该继续下注**。
现在的表现是 hold 期间 `isPhysicalShoeBettable` 仍为 true，等于"不确定却照下"。
更安全的是 hold 生效即进入暂停下注状态（fail-closed），等出口触发后再恢复。

---

## 建议优先级

| 优先级 | 问题 | 建议 |
|---|---|---|
| P0 | 3.5 | hold 生效期间暂停该桌下注，而不是用旧靴库存继续评估 |
| P0 | 2.1 | `handHasInventory` 改为逐张补齐，而不是整手跳过 |
| P1 | 2.2 | 缺牌检测增加"手内少牌"维度（比对 handSettled 的牌数 vs 已采张数） |
| P1 | 1 | 解析器重建时保留已见 eventId 前缀，避免重置后重复记录 |
| P2 | 2.3 | 给 Winfinity 补等价的全量状态回补 |
| P2 | 3.4 | 路子采集失效要能被检测（当前静默降级为"不判定回绕"） |

---

## 九、实证确认与修复（2026-09-11 下半场）

上面是读代码得出的结论。为了让判断落地，逐条写了**可执行的最小复现**，确认后再改。

### 9.1 实证结果

**问题 2 —— 确认，库存确实少扣**

用 `replayEvents` 跑同一手牌的三种采法：

| 场景 | remainingTotal | 结论 |
|---|---|---|
| 4 张全部经 `cardObserved` 采到 | 412 | 正确 |
| **只采到 1 张 + `handSettled` 带完整 4 张** | **415** | ✗ 少扣 3 张 |
| 一张都没采到，仅靠 `handSettled` | 412 | 正确 |

库存偏多 → 对子 EV 偏高 → 方向就是"不该下却下"。

**问题 3 —— 确认，而且比预想严重**

构造实体靴（handNumber=10、remaining=356）后让平台换靴：

```
换靴前            : shoe-1, status=BETTING_WINDOW
平台换靴后        : shoeId 仍是 shoe-1  ← 新靴事件被丢弃
                    status   仍是 BETTING_WINDOW
对子真金下注尝试   : ACCEPTED          ← 注真的发出去了
新靴再开窗         : currentHandId 没变 ← 新靴窗口同样被丢弃
```

这条比先前判断的更严重：不只是"库存模型过时"，而是**窗口一直开着、下注照发**。

### 9.2 已修复

**问题 2：把"手内漏采"接入既有检测链路，但**不**自动修正库存**

第一次尝试改 `applySettledHandCards` 为"逐张补齐"，**当场被测试证伪**：
去重 key 是 `${handId}:${position}:${copyId}`，而 `cardObserved` 的 `position` 与
这里的 `'player'/'banker'` **不是同一套语义** —— `winfinity-runtime.ts:580` 可能给出
`player:left`，甚至完全不带 position（contracts 里 `position` 是可选字段）。
key 对不上就会**重复扣减**。3 个既有测试立刻变红（411 vs 414），证明这条路不安全。

最终改为：保持"整手跳过"（不重复扣的原则不变），新增 `countHandInventory`，
在 `TableActor.applyHandSettlement` 里比对**结算牌数 vs 已计入张数**，
差额累加进 `missingUnobservedCards` —— 于是它接上了 `service.ts:823`
`demoteIfGameCountAnomaly` 的"缺牌 > 10 张移出监控"。

实测：
- 手内漏采 3 张 → 缺牌计数 **3** ✓
- 整手都没采到（重启/回放场景）→ 缺牌计数 **0** ✓（不误报）

代价说明：库存偏差本身**不自动修正**（那需要安全的"退回重算"，风险高于收益），
但漏采不再静默 —— 它会触发该桌移出监控、停止下注。

**问题 3：hold 期间 fail-closed + 给 hold 加上界（第二轮修复：信号缓存 + 到期补投）**

- 新增 `TableActor.isShoeHoldPending()`：收到换靴信号但按规则先按住旧靴时进入该状态
- 三条下注路径全部检查（`one-shot-bet.ts` 新增拒绝原因 `shoe-hold-pending`、
  `controlled-wager.ts`、以及自动对子的 `evaluateWindow`）
- `shouldHoldCurrentPhysicalShoe` 增加时间出口 `SHOE_HOLD_MAX_MS = 90_000`：
  超时即按真换靴处理。这条出口**不依赖 DOM 路子**，所以路子采集失效时它是唯一兜底

**第二轮深挖发现第一轮修复不完整**：新靴信号是**一次性**的 ——
runtime 的 `beginNewShoe` 只在检测到协议洗牌 / 路子回绕时触发，且触发后
`clearShoeTracking` 会清掉路子计数，同一个换靴**不会发第二次**。所以
"hold 超时出口"只有在收到新靴信号的那一刻才会被求值，而那一刻之后信号就没了：

实测（hold 超时后恢复下注，但靴僵在旧模型）：
```
超时后 isShoeHoldPending : false（允许下注了）
投影 shoeId              : shoe-1（新靴事件已被丢弃，再无信号）
remainingTotal           : 356（冻结在旧靴）
```
等于超时后恢复了**在错误模型上下注** —— 比不修更糟。

修复：**把"丢弃"改成"缓存 + 到期补投"**：
- `TableActor.deferShoeSignal()` 缓存被 hold 掉的新靴信号
- `handleEvent` 入口检查：hold 已解除且存在缓存信号 → 先补投该信号再处理当前事件。
  这样新靴的牌不会被 `isCurrentShoe` 忽略，remainingTotal 不会永远追不上
- `clearShoeHold` 同步清缓存

实测（同一复现脚本，超时后推一个 shoe-2 的牌事件）：
```
投影 shoeId    : shoe-2   ← 自愈成功
remainingTotal : 415      ← 新靴 416 张 − 已计入 1 张，不再冻结
```

**第三轮深挖发现第二轮修复仍有洞**：补投条件用的是 `!isShoeHoldPending()`
（**纯时间判**，90 秒），但 `bindIncomingShoe` 的 branch 2/3 在放行事件时会调
`clearShoeHold()` —— 它连缓存信号一起清。而路子回绕出口
（`isWrapShapedRoadCount(10, road≤2)`）会在 90 秒内提前解除 hold：真回绕发生时
DOM 路子约 45 秒后显示局 1 → branch 3 放行 → `clearShoeHold` → **缓存被销毁** →
信号是一次性的、再也不会有 → 桌永久僵在旧靴，直到下一次自然洗牌（约一小时）。

时间线：
```
T0        换靴信号被 hold、缓存
T0+45s    新靴第一手完成，DOM 路子显示局 1 → 路子回绕出口满足
T0+45s+ε  下一个 shoe-2 事件到达：入口补投条件不满足（才 45 秒）
          → branch 3 放行该事件并 clearShoeHold → 缓存销毁
之后      永久僵死在旧靴（下注被僵尸窗口过期挡住，无资金风险，但桌废了）
```
讽刺的是：假警报（路子不回绕）走 90 秒超时正常自愈；**真回绕**（最需要自愈的）反而坏。

修复（两处）：
1. **补投条件与 hold 判据同源**：改为 `!shouldHoldCurrentPhysicalShoe(this.projection)`
   （路子回绕确认或超时，与 `bindIncomingShoe` 的判断完全一致）。branch 2/3 放行的
   前提就是该判据为 false，而入口补投先于放行执行 —— 缓存不可能在补投前被清。
   副作用是正面的：真回绕时自愈从"等 90 秒"提前到"下一个事件"（毫秒级）
2. **`deferShoeSignal` 留最新**：hold 期间平台又切一靴（shoe-3、shoe-4 连续信号），
   只留第一个会在补投后僵在中间靴。runtime shoeId 只递增，替换安全

实测：
```
场景1（路子回绕提前解除）: hold → 路子=1 → 推 shoe-2 事件 → shoeId=shoe-2、
                          remaining=415，全程未动 90 秒超时 ✓
场景2（hold 内双切换）    : shoe-3 信号被 hold 后 shoe-4 又到 → 缓存替换为 shoe-4
                          → 超时补投直达 shoe-4、remaining=415 ✓
```

顺带确认（无需改动）：
- branch 2/3 丢弃的普通事件（新靴的牌/结算）不能打开下注口子：僵尸窗口被
  `isPairBettingWindowReady` 的实时 `closesAt` 比较挡住；auto 路径有 shoeId 匹配守卫；
  one-shot 有 `command.shoeId !== projection.shoeId` 校验
- 「新靴信号一次性」三个 runtime 都成立：BG `beginNewShoe` 同样递增 sequence；
  Winfinity eventId 幂等派生（重发被 ledger 去重挡）
- 补投路径触发 `expireOpenForShoe` 清旧靴敞口
- 桌被移出监控后残留的缓存信号，补投的是真实未处理的信号，方向正确，无害

**第四轮深挖：hold 期间被丢弃的结算造成库存缺口**。branch 2/3 丢弃的新靴事件里，
被丢弃的 `cardObserved` 会被后续结算补齐（整手逻辑加全 6 张），窗口事件自过期，
但 **`handSettled` 每手只发一次、永远不会再来了** —— 那几手的牌永远不从新靴库存里扣：

实测（hold 期间新靴打 2 手 → 超时自愈 → 推 1 张牌）：
```
remainingTotal : 415   ← 理论正确值 403，缺口 12 张（2 手 × 6 张）
handNumber     : 1     ← 整段历史丢失
```
hold 典型持续 45-90 秒 ≈ 1-3 手 ≈ 6-18 张（416 的 1.5-4.3%），EV 估算系统性偏高，
且对 `missingUnobservedCards` 完全不可见（`lastSettledHandSeq` 在信号处重置，跳号检测失效）。

修复：**按靴缓存 + 信号补投后回放**：
- `TableActor.heldShoeSettlements: Map<shoeId, handSettled[]>`，branch 2/3 丢弃
  handSettled 时入缓（上界 30 条，异常洪泛丢最旧）
- 信号补投切到该靴后，把该靴被丢弃的结算**原样重过 `handleEvent`** —— 走正常
  `applyHandSettlement` 路径，seq 连续性、整手补齐、去重逻辑全部复用，零手写库存数学
- 回放先于触发补投的当前事件，保持时序；Map 按 shoeId 分组，hold 内双切换时各靴各回各的

实测（修复后同脚本）：`remainingTotal=403` 精确吻合、`seenCards=13`（12 回放 + 1 新）、
`handNumber=3` ✓

实测（同一条复现脚本）：
```
旧靴对子下注尝试 : REJECTED reason=shoe-hold-pending   ← 由 ACCEPTED 变为拒绝
```

### 9.3 验证

- `npm run build` exit 0；`vitest` **59 文件 / 820 用例全过**（含 9.5 补充的问题 1 回归）
- 回归测试 `orchestrator.test.ts` › "shoe handoff hold must fail closed"：
  覆盖 hold 期间拒绝、以及 90 秒后释放
- 回归测试 › "must flush the deferred new-shoe signal once the hold expires (self-heal)"：
  覆盖一次性信号被 hold 后、超时到期由后续事件触发补投自愈
  （断言 shoeId 切到新靴、remainingTotal = 415、seenCards = 1）
- 回归测试 › "must flush the deferred signal as soon as the road-wrap exit lifts the
  hold, not only at timeout"：覆盖路子回绕出口提前解除 hold 时的立即补投
- 回归测试 › "must replace the deferred signal with a newer one when the platform
  switches twice during one hold"：覆盖 hold 内双切换时缓存替换为最新信号
- 回归测试 › "must replay settlements dropped during the hold so their cards leave
  the new-shoe inventory"：覆盖被丢弃结算的回放（断言 remainingTotal = 403 而非 415）
- 修复过程中被证伪的方案（逐张补齐；hold 超时后不补投；补投只看时间判；
  丢弃结算不回放）均已回退/取代

### 9.4 收尾状态

**问题 1（解析器重置窗口）已在第五轮实证关闭**：库存/下注正确性有
`cardInventoryKeys` 防线，重复记录仅是 ledger 审计噪音；唯一真实危害
（缺牌计数对重复投递不幂等导致误移出监控）已修复，连带发现路径
（`recoverSideEffects` 对 ledger 去重命中的事件重放副作用）一并覆盖。

**第六轮：修复 `resetLiveShoeTracking` 的 hold 状态残留**。人工重置原本只重置投影
与计数，不清 `shoeHoldSince` / `deferredShoeSignal` / `heldShoeSettlements` ——
空投影下 `shouldHoldCurrentPhysicalShoe` 恒为 false，下一个事件会把陈旧的缓存信号
补投到重置后的状态上：系统以「全新 416 张」的模型重建一个实际已打了一半的靴，
看似合法实则 fail-open。修复：重置时同步清 hold 标志、缓存信号、丢弃结算缓存
与缺牌去重集 —— 重置语义与进程重启一致（等下一条洗牌证据）。
回归测试 › "resetLiveShoeTracking must discard held shoe state"。

**已知限制（记录，不修）**：人工确认（`openPhysicalShoe`，manual-confirm）的换靴
信号与自动信号形状相同（`NewShoeSignalEvent` 契约无 evidence/reason 字段），
在 premature-reset 形态下同样被 hold 压住最多 90 秒。方向是 fail-closed（安全侧），
要修需扩冻结契约 + 三 runtime + actor 同步改，留待真实操作反馈再定。

仍未处理的 P1/P2 项：Winfinity 补全量回补、路子采集失效可检测 —— 保持原样，
需要真实环境的触发频率数据再决定是否投入。

### 9.5 验证数字（第六轮后）

- `npm run build` exit 0；`vitest` **59 文件 / 821 用例全过**
