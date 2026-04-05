# 即兴演讲运行器设计

日期：2026-04-04

## 背景

当前实现把即兴演讲建模成：

- 一个 25 分钟总池父节点
- 多个固定 2 分钟的即兴子项

这个模型的问题是，即兴主持人的开场、点人、等待、串场和结束确认没有被正确表达。真实业务中，这些时间同样消耗在即兴总时长内，但不应该被强行拆成正式 agenda item。

本次改造目标不是做完整主持状态机，而是把即兴环节改成一个轻量运行器：

- `agenda` 里只保留一个正式的即兴总环节
- 现场被点到的即兴演讲者记录到独立数据表
- 25 分钟总池持续运行
- 单人 2 分钟计时由时间官手动开始
- 超过 25 分钟或剩余不足 2 分钟时，只提示，不硬拦截

## 核心目标

1. 时间官可以在即兴总环节里连续登记和记录多位临时即兴演讲者。
2. 即兴总时长按一个 25 分钟总池运行，主持人口播时间自动包含在内。
3. 每位即兴演讲者的 2 分钟单独统计，开始时机由时间官手动确认。
4. 语法官和哼哈官只在真正开始本位演讲时切换焦点人。
5. 最佳即兴投票和会议统计优先读取即兴记录表，不再依赖 agenda item 猜测。

## 非目标

1. 不做 `host_opening / host_bridge / host_closing` 的完整主持阶段建模。
2. 不做 30 秒准备状态。
3. 不把每位随机即兴演讲者写回 agenda items。
4. 不做总池剩余不足 2 分钟的硬拦截。

## 数据模型

### 1. 会议会话扩展

`MeetingSession` 增加一个可选字段：

- `impromptuRecords?: ImpromptuSpeechRecord[]`

会议详情加载时，把 `impromptu_speeches_v2` 中属于当前会议的数据一并带回前端。

### 2. 页面运行态

前端不额外持久化一份独立的 runner state，而是按“当前 agenda item + 即兴记录”推导页面状态：

- `idle`：总池未开始，且没有活跃记录
- `hosting`：总池已开始，当前无人演讲
- `pending_speaker`：已经登记下一位，但还没开始本位
- `speaking`：当前有人在讲
- `completed`：总池 agenda item 已结束

这样可以避免额外维护一份状态机真相源，业务重点仍然落在“总池计时 + 单人记录”。

### 3. 即兴记录表

新增一张正式数据表，记录真实发生过的每位即兴演讲者：

- `id`
- `meeting_id`
- `agenda_item_id`
- `sort_order`
- `speaker_name`
- `speaker_key`
- `status`: `pending | speaking | completed | cancelled`
- `pool_duration_seconds`
- `pool_remaining_seconds_at_start`
- `started_with_low_remaining`
- `speech_planned_duration_seconds`
- `speech_started_at`
- `speech_ended_at`
- `speech_duration_seconds`
- `is_overtime`
- `notes`
- `created_at`
- `updated_at`
- `deleted_at`

设计原则：

- 输入名字后可以先生成一条 `pending` 记录，表示候场。
- 真正点击“开始本位演讲”时，再写 `speech_started_at` 和 `status=speaking`。
- 结束本位时，写 `speech_ended_at`、`speech_duration_seconds`、`is_overtime` 和 `status=completed`。

## 页面交互

只有当前环节是即兴总环节时，时间官页进入即兴运行器模式；普通环节计时交互保持不变。

### 页面状态

1. `idle`
- 页面显示总池 25:00
- 主按钮：`开始即兴`

2. `hosting`
- 总池已开始，当前无人演讲
- 主按钮：`下一位`
- 次按钮：`结束即兴`

3. `pending_speaker`
- 已输入姓名，但尚未开始此人的 2 分钟
- 主按钮：`开始本位演讲`
- 次按钮：`取消本位`

4. `speaking`
- 当前人 2 分钟计时进行中
- 主按钮：`结束本位`

5. `completed`
- 总池结束
- 只展示结果列表和复盘信息

### 典型流程

1. 时间官进入“即兴演讲”总环节。
2. 点击 `开始即兴`，总池开始运行。
3. 主持人点到某人后，时间官点击 `下一位`，输入姓名。
4. 页面进入 `pending_speaker`，但此人 2 分钟尚未开始。
5. 现场真正开始演讲时，时间官点击 `开始本位演讲`。
6. 页面进入 `speaking`，单人计时开始。
7. 该人结束后，时间官点击 `结束本位`，记录写入结果列表。
8. 页面回到 `hosting`，等待下一位。

## 计时规则

### 总池

- 总池仍复用当前即兴总环节本身的 `plannedDuration` 和实际计时。
- 主持人口播、等待、串场、输入姓名等全部自然计入总池。
- 总池到点后不强停，只进入超时显示。

### 单人

- 单人默认目标时长 120 秒。
- 输入名字不会开始 2 分钟计时。
- 只有点击 `开始本位演讲` 才开始单人计时。
- `is_overtime` 由 `speech_duration_seconds > 120` 决定。

### 软提醒

- 若总池剩余不足 120 秒，点击 `开始本位演讲` 时给出风险提示，但仍允许继续。
- 若总池已经超时，页面持续显示超时状态，但不阻止时间官收尾。

## 实时联动

### live cursor

即兴运行器与 `meeting_live_cursor_v2` 的关系：

- `hosting` 和 `pending_speaker`：
  - `current_phase = other`
  - `current_participant_key = null`
- `speaking`：
  - `current_phase = speech`
  - `current_participant_key = 当前演讲者 speaker_key`

这样语法官和哼哈官只在真正开讲时才切换焦点。

### timer officer events

继续复用 `timer_officer_events_v2`，但增加即兴相关 payload：

- `start_item` / `pause_item`：仍记录即兴总环节总池的开始和暂停
- `adjust_time`：仍记录总池快调
- `next_item` / `prev_item`：保留现有 agenda 跳转
- 即兴运行器额外复用现有事件类型写 payload：
  - 登记下一位：`event_type='adjust_time'` 或新增表自身日志，payload 写 `impromptuAction='queue_speaker'`
  - 开始本位：payload 写 `impromptuAction='start_speech'`
  - 结束本位：payload 写 `impromptuAction='finish_speech'`

优先方案是：即兴明细以新表为主真相源，`timer_officer_events_v2` 只作为审计补充。

## 投票与统计

### 投票

“最佳即兴”候选人改为优先读取即兴记录表：

- 只取 `status=completed`
- `speech_started_at` 非空
- 以 `speaker_name` 去重或按最新规则聚合

旧的 agenda `tableTopics` 解析逻辑保留为兜底，但不再作为主路径。

### 统计

会议统计新增即兴专栏，展示：

- 即兴总人数
- 即兴总实际演讲时长
- 每位即兴演讲者时长
- 超时人数
- 总池是否超时

普通 agenda 统计继续按既有 item 逻辑运行，但不再依赖“即兴子项”。

## 实施顺序

### 第一期

1. 新增即兴记录表和读写服务。
2. 扩展 `MeetingSession` 结构承载 `impromptuRecords`。
3. 时间官页切换到即兴运行器交互。
4. 语法官/哼哈官跟随真正开讲的人。
5. 最佳即兴投票改为优先读取即兴记录表。

### 第二期

1. 细化即兴复盘统计。
2. 增加更完整的总池超时分析。
3. 如后续确有必要，再考虑更细主持阶段。

## 验收标准

1. agenda 中只保留一个即兴总环节，不再新增即兴子项。
2. 时间官可以在总池运行中连续登记多位即兴演讲者。
3. 输入姓名不会自动启动该人的 2 分钟计时。
4. 点击“开始本位演讲”后，语法官和哼哈官才切换到该人。
5. 总池剩余不足 2 分钟时，只提醒不拦截。
6. 最佳即兴候选人来源于即兴记录表。
7. 会议统计可单独展示即兴记录结果。
