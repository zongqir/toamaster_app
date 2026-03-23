# Agenda 重写设计（V1）

## 1. 结论（先定死）

1. **每个 agenda item 必须是一条独立记录**（`meeting_items` 一行对应一个环节）。
2. 云端写入改为 **item 级 patch**（新增/修改/删除/排序），禁止整份 agenda 覆盖写。
3. 计时状态需要入库，按你要求新增两类状态字段：
   - 语义状态（合格/预警/超时）
   - 颜色枚举（蓝/绿/黄/红/浅红/紫）
4. 状态计算规则分两档：`planned_duration > 300s` 和 `<= 300s`。

---

## 2. 数据模型（V2：新表方案）

> 本次直接采用新表，不在旧 `meeting_items` 上打补丁。旧表保留只读，待迁移完成后下线写入。

## 2.0 新增枚举类型

```sql
CREATE TYPE agenda_status_code AS ENUM (
  'initial',
  'qualified',
  'warning',
  'overtime',
  'severe_overtime'
);

CREATE TYPE agenda_status_color AS ENUM (
  'blue',
  'green',
  'yellow',
  'red',
  'red_soft',
  'purple'
);

CREATE TYPE agenda_rule_profile AS ENUM ('gt5m', 'lte5m');

CREATE TYPE agenda_node_kind AS ENUM ('segment', 'leaf');

CREATE TYPE agenda_budget_mode AS ENUM ('independent', 'hard_cap');

CREATE TYPE agenda_speaker_role AS ENUM ('host', 'speaker', 'guest', 'other');

CREATE TYPE agenda_op_type AS ENUM (
  'create_item',
  'update_item',
  'delete_item',
  'move_item',
  'timer_checkpoint',
  'status_change'
);

CREATE TYPE agenda_op_apply_status AS ENUM (
  'applied',
  'conflict',
  'rejected',
  'replayed'
);

CREATE TYPE agenda_live_phase AS ENUM (
  'host_opening',
  'prep',
  'speech',
  'host_bridge',
  'host_closing',
  'other'
);

CREATE TYPE actor_name_source AS ENUM (
  'wechat_profile',
  'manual_input',
  'unknown'
);

CREATE TYPE observer_role AS ENUM (
  'timer_officer',
  'grammarian',
  'ah_counter',
  'host',
  'other'
);

CREATE TYPE grammar_note_type AS ENUM (
  'good_word',
  'good_phrase',
  'great_sentence',
  'grammar_issue'
);
```

## 2.1 用户身份与展示名（新增）

```sql
CREATE TABLE IF NOT EXISTS user_identity_profiles (
  user_id UUID PRIMARY KEY,                      -- 对齐认证系统 user id（如 auth.users.id）
  app_id TEXT NOT NULL,                          -- 小程序 appid
  wechat_openid TEXT,                            -- 服务端通过 code2Session 获取
  wechat_unionid TEXT,
  display_name TEXT NOT NULL DEFAULT '微信用户',  -- 业务展示名（可改）
  avatar_url TEXT,
  name_source actor_name_source NOT NULL DEFAULT 'unknown',
  profile_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (app_id, wechat_openid)
);
```

说明：
- “谁填的”统一引用 `user_id`，展示名快照写入业务表，避免后续改名影响历史审计。
- `display_name` 的来源记录在 `name_source`，区分是微信资料还是手工输入。

## 2.1 meetings 表（新增）

- `agenda_version BIGINT NOT NULL DEFAULT 1`
用途：并发控制版本号，客户端提交 patch 时必须携带 `base_version`。

## 2.2 agenda_items_v2 表（核心新表）

```sql
CREATE TABLE IF NOT EXISTS agenda_items_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,                        -- 客户端稳定 id（替代旧 item.id）
  parent_item_key TEXT,                          -- 父节点 item_key，顶层为空
  node_kind agenda_node_kind NOT NULL DEFAULT 'leaf',
  depth SMALLINT NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  speaker TEXT,
  speaker_role agenda_speaker_role NOT NULL DEFAULT 'speaker',
  slot_group_key TEXT,                           -- 用于把“准备+演讲+串场”归为一组
  planned_duration INTEGER NOT NULL,             -- 秒
  budget_mode agenda_budget_mode NOT NULL DEFAULT 'independent',
  budget_limit_seconds INTEGER,                  -- 仅 segment 使用，例：25分钟=1500
  consume_parent_budget BOOLEAN NOT NULL DEFAULT TRUE, -- 子项是否消耗父预算
  actual_duration INTEGER,
  actual_start_time BIGINT,
  actual_end_time BIGINT,
  start_time TEXT,
  item_type TEXT NOT NULL DEFAULT 'other',
  rule_id TEXT NOT NULL DEFAULT 'short',
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  parent_title TEXT,
  status_code agenda_status_code NOT NULL DEFAULT 'initial',
  status_color agenda_status_color NOT NULL DEFAULT 'blue',
  status_rule_profile agenda_rule_profile NOT NULL DEFAULT 'lte5m',
  status_updated_at BIGINT,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  created_by_name TEXT NOT NULL DEFAULT '未知用户',
  updated_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  updated_by_name TEXT NOT NULL DEFAULT '未知用户',
  updated_by_name_source actor_name_source NOT NULL DEFAULT 'unknown',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  UNIQUE (meeting_id, item_key),
  CONSTRAINT fk_agenda_items_v2_parent
    FOREIGN KEY (meeting_id, parent_item_key)
    REFERENCES agenda_items_v2(meeting_id, item_key)
    ON DELETE CASCADE,
  CONSTRAINT chk_agenda_items_v2_parent_not_self
    CHECK (parent_item_key IS NULL OR parent_item_key <> item_key),
  CONSTRAINT chk_agenda_items_v2_item_key_reserved
    CHECK (item_key <> '__root__'),
  CONSTRAINT chk_agenda_items_v2_depth
    CHECK (depth >= 1),
  CONSTRAINT chk_agenda_items_v2_segment_budget
    CHECK (
      (node_kind = 'segment' AND budget_mode = 'hard_cap' AND budget_limit_seconds IS NOT NULL)
      OR (node_kind = 'leaf' AND budget_mode = 'independent')
    )
);

CREATE INDEX IF NOT EXISTS idx_agenda_items_v2_meeting_order
  ON agenda_items_v2(meeting_id, order_index)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_items_v2_meeting_parent_order
  ON agenda_items_v2(meeting_id, parent_item_key, order_index)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agenda_items_v2_sibling_order
  ON agenda_items_v2(meeting_id, COALESCE(parent_item_key, '__root__'), order_index)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_items_v2_meeting_status
  ON agenda_items_v2(meeting_id, status_code, status_color)
  WHERE deleted_at IS NULL;
```

说明：
- `item_key`：业务稳定键，避免 UUID 改变导致并发对齐失败。
- `parent_item_key`：建立父子层级（大环节 -> 小环节）。
- `node_kind`：`segment` 表示容器环节，`leaf` 表示原子执行项。
- `budget_limit_seconds`：容器环节预算上限（如即兴 25 分钟）。
- `consume_parent_budget`：子项是否计入父环节预算（默认计入）。
- `slot_group_key`：把“准备+演讲+串场+结尾”归为一个语义小组，便于批量调整。
- `row_version`：单行乐观锁，可用于 item 级冲突检测。
- `created_by_* / updated_by_*`：直接满足“谁填的”追踪需求。

## 2.2.1 Item 与 Item 的连接规则（你问的核心）

1. 纵向连接（层级）：`child.parent_item_key -> parent.item_key`。
2. 横向连接（顺序）：同一个 `parent_item_key` 下使用 `order_index` 排序。
3. 预算连接（约束）：子项 `consume_parent_budget = true` 时，占用父 `segment` 预算池。
4. 语义连接（组装）：同一 `slot_group_key` 的项视为同一演讲组（准备/演讲/主持串场）。

---

## 2.4 即兴环节（25 分钟）建模示例

大环节（容器）：
- `node_kind = segment`
- `title = 即兴环节`
- `budget_mode = hard_cap`
- `budget_limit_seconds = 1500`

子环节（原子项）示例：
1. 主持开场（`leaf`, host, 计入预算）
2. 演讲者A准备 30s（`leaf`, speaker, 计入预算）
3. 演讲者A演讲 120s（`leaf`, speaker, 计入预算）
4. 主持串场（`leaf`, host, 计入预算）
5. 演讲者B准备 30s（`leaf`, speaker, 计入预算）
6. 演讲者B演讲 120s（`leaf`, speaker, 计入预算）
7. 主持结尾（`leaf`, host, 计入预算）

预算校验规则（必须执行）：
- 新增/修改任何 `leaf` 前，先计算同父 segment 的 `sum(planned_duration)`。
- 若新值使总和 `> budget_limit_seconds`，直接拒绝写入（返回业务错误）。
- 允许管理员强制超配时，必须带 `override=true` 并写入 `agenda_ops_v2` 审计。
- 并发下必须在单事务中执行，并对父 `segment` 行做 `SELECT ... FOR UPDATE` 后再校验与写入。

## 2.5 动态加删（你关心的行为）

1. **允许动态新增**：`create_item` patch 可在任意父节点下插入子项。
2. **允许动态删除**：`delete_item` 默认软删除（`deleted_at` 赋值），避免误删不可恢复。
3. **防覆盖规则**：新增/删除都必须带 `base_agenda_version`，服务端版本不一致直接 `409`，不做隐式覆盖。
4. **并发删除保护**：删除前若 item 已被他人改过（`row_version` 变化），返回冲突让用户确认。

---

## 2.6 人员与观察记录（独立于计时）

> 语法官、哼哈官记录属于“观察数据”，和计时/agenda 解耦；按“会议 + 人”建模，不强绑定时间线。

## 2.6.1 参会人表

```sql
CREATE TABLE IF NOT EXISTS meeting_participants_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_key TEXT NOT NULL,                  -- 会议内稳定键
  display_name TEXT NOT NULL,
  linked_user_id UUID REFERENCES user_identity_profiles(user_id),
  role_tags TEXT[] NOT NULL DEFAULT '{}',
  created_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  UNIQUE (meeting_id, participant_key)
);

CREATE INDEX IF NOT EXISTS idx_meeting_participants_v2_meeting
  ON meeting_participants_v2(meeting_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_meeting_participants_v2_meeting_updated
  ON meeting_participants_v2(meeting_id, updated_at DESC)
  WHERE deleted_at IS NULL;
```

## 2.6.2 语法官记录表（好词好句/语病）

```sql
CREATE TABLE IF NOT EXISTS grammarian_notes_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_key TEXT NOT NULL,
  note_type grammar_note_type NOT NULL,
  content TEXT NOT NULL,                          -- 好词/好句/问题描述
  related_item_key TEXT,                          -- 可选：关联到某个环节
  observer_user_id UUID REFERENCES user_identity_profiles(user_id),
  observer_name TEXT NOT NULL DEFAULT '未知用户',
  observer_role observer_role NOT NULL DEFAULT 'grammarian',
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT fk_grammarian_notes_v2_participant
    FOREIGN KEY (meeting_id, participant_key)
    REFERENCES meeting_participants_v2(meeting_id, participant_key)
);

CREATE INDEX IF NOT EXISTS idx_grammarian_notes_v2_meeting
  ON grammarian_notes_v2(meeting_id, created_at DESC)
  WHERE deleted_at IS NULL;
```

## 2.6.3 哼哈官记录表（口头禅统计）

```sql
CREATE TABLE IF NOT EXISTS ah_counter_records_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_key TEXT NOT NULL,
  filler_word TEXT NOT NULL,                      -- 如：嗯、啊、you know
  hit_count INTEGER NOT NULL DEFAULT 1 CHECK (hit_count > 0),
  sample_quote TEXT,                              -- 可选：示例原句
  related_item_key TEXT,                          -- 可选：关联到某个环节
  observer_user_id UUID REFERENCES user_identity_profiles(user_id),
  observer_name TEXT NOT NULL DEFAULT '未知用户',
  observer_role observer_role NOT NULL DEFAULT 'ah_counter',
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  CONSTRAINT fk_ah_counter_records_v2_participant
    FOREIGN KEY (meeting_id, participant_key)
    REFERENCES meeting_participants_v2(meeting_id, participant_key)
);

CREATE INDEX IF NOT EXISTS idx_ah_counter_records_v2_meeting
  ON ah_counter_records_v2(meeting_id, created_at DESC)
  WHERE deleted_at IS NULL;
```

说明：
- 这两张记录表优先按 `(meeting_id, participant_key)` 关联，不依赖计时状态。
- `related_item_key` 是可选辅助，不应成为必填约束。
- 即便 agenda 动态增删，观察记录仍可保留，不会被日程覆盖写影响。
- 哼哈记录采用追加事件模型（新增一条记录代表一次命中），默认不做原地累加更新，避免并发丢计数。

## 2.7 跨角色实时同步（时间官 -> 语法官/哼哈官）

> 目标：时间官在“即兴演讲人”处新增/删除/改名后，语法官和哼哈官端**同步拿到**，无需手动刷新。

### 2.7.0 焦点游标（谁正在进行）

> 语法官/哼哈官“感知谁在说话”以 `meeting_live_cursor_v2` 为唯一真相源。

```sql
CREATE TABLE IF NOT EXISTS meeting_live_cursor_v2 (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  current_item_key TEXT,
  current_participant_key TEXT,
  current_phase agenda_live_phase NOT NULL DEFAULT 'other',
  remaining_seconds INTEGER,
  agenda_version BIGINT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  updated_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  updated_by_name TEXT NOT NULL DEFAULT '未知用户',
  updated_at BIGINT NOT NULL,
  CONSTRAINT fk_meeting_live_cursor_v2_item
    FOREIGN KEY (meeting_id, current_item_key)
    REFERENCES agenda_items_v2(meeting_id, item_key),
  CONSTRAINT fk_meeting_live_cursor_v2_participant
    FOREIGN KEY (meeting_id, current_participant_key)
    REFERENCES meeting_participants_v2(meeting_id, participant_key)
);

CREATE INDEX IF NOT EXISTS idx_meeting_live_cursor_v2_updated_at
  ON meeting_live_cursor_v2(updated_at DESC);
```

### 2.7.1 触发规则

1. 时间官新增演讲者（agenda 子项）时，服务端同时 upsert `meeting_participants_v2`。
2. 时间官删除演讲者时，不硬删 participant，标记 `deleted_at`，保留历史记录可追溯。
3. 时间官改名时，同步更新 `meeting_participants_v2.display_name`，并写一条 `agenda_ops_v2` 审计。
4. 时间官切换当前人/下一位/跳转环节时，必须更新 `meeting_live_cursor_v2`。
5. `meeting_participants_v2` 仅允许时间官端与服务端函数创建/更新；语法官、哼哈官客户端不允许创建主数据。
6. 当当前 participant 或 item 被软删除时，服务端需将游标自动切到下一个有效对象，若不存在则置空。

### 2.7.2 同步通道

1. 客户端按 `meeting_id` 订阅 Realtime 频道：
   - `agenda_items_v2`
   - `meeting_live_cursor_v2`
   - `meeting_participants_v2`
   - `agenda_ops_v2`
2. 语法官/哼哈官页面以 `meeting_live_cursor_v2.current_participant_key` 作为当前焦点。
3. 收到游标事件后执行：
   - 本地无该 participant：标记“待同步”并立即触发一次 participants 增量拉取。
   - 本地已有该 participant：直接切换当前记录对象。
4. 收到实时事件后按 `updated_at + row_version` 去重并应用，确保幂等。

### 2.7.3 最终一致性兜底

1. 页面每 20~30 秒轻量拉取一次 participant 增量（`updated_at > lastSeenTs`），防止弱网漏事件。
2. 若 Realtime 断开，UI 显示“同步中断”状态，并自动重连。
3. 重连成功后先执行一次增量拉取，再恢复事件消费。

### 2.7.4 记录联动体验（业务要求）

1. 新演讲者出现后，语法官页和哼哈官页列表立即出现该人。
2. 点击该人可直接新增：
   - `grammarian_notes_v2`（好词好句/语病）
   - `ah_counter_records_v2`（哼哈词及次数）
3. 可选关联当前环节 `related_item_key`，但默认仅按人记录，不强制绑环节。
4. 自动切换策略（防误操作）：
   - 表单无未保存修改：自动切到游标指向的人。
   - 表单有未保存修改：弹窗“保存并切换 / 暂存并切换 / 保持当前”。

## 2.3 agenda_ops_v2 表（审计与幂等）

```sql
CREATE TABLE IF NOT EXISTS agenda_ops_v2 (
  op_id UUID PRIMARY KEY,                        -- 客户端生成，保证幂等
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  item_key TEXT,
  op_type agenda_op_type NOT NULL,
  base_agenda_version BIGINT NOT NULL,
  applied_agenda_version BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID REFERENCES user_identity_profiles(user_id),
  actor_name TEXT NOT NULL DEFAULT '未知用户',
  actor_name_source actor_name_source NOT NULL DEFAULT 'unknown',
  client_ts BIGINT,
  server_ts BIGINT NOT NULL,
  apply_status agenda_op_apply_status NOT NULL DEFAULT 'applied',
  conflict_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_agenda_ops_v2_meeting
  ON agenda_ops_v2(meeting_id, server_ts DESC);
```

说明：
- 每一次增删改查都落一条 op，支持追责、回放、问题排查。
- `op_id` 唯一保证重复重放不重复生效。

兼容旧字段迁移建议（如需在旧表过渡）：

```sql
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS agenda_version BIGINT NOT NULL DEFAULT 1;
```

---

## 3. 状态枚举定义

## 3.1 `status_code`（语义）

- `initial`：初始阶段（未进入达标窗口）
- `qualified`：达标（绿卡阶段）
- `warning`：时间不足预警（黄卡）
- `overtime`：已到目标时间/超时中（红卡或浅红）
- `severe_overtime`：严重超时（紫卡）

## 3.2 `status_color`（颜色）

- `blue`
- `green`
- `yellow`
- `red`
- `red_soft`（浅红）
- `purple`

---

## 4. 计时状态规则（按你给的阈值）

设：
- `planned = planned_duration`（秒）
- `elapsed = actual_duration`（秒）
- `remaining = planned - elapsed`

说明：
- `leaf` 节点按自身 `planned_duration` 计算状态。
- `segment` 节点按预算池计算：`planned = budget_limit_seconds`，`elapsed = 子节点actual_duration汇总`。

## 4.1 档位 A：`planned > 300`（5 分钟以上）

- `remaining > 120`：`initial / blue`
- `120 >= remaining > 60`：`qualified / green`
- `60 >= remaining > 0`：`warning / yellow`
- `0 >= remaining > -30`：`overtime / red`
- `remaining <= -30`：`severe_overtime / purple`

边界解释：
- `remaining = 120` 进入绿卡
- `remaining = 60` 进入黄卡
- `remaining = 0` 进入红卡
- 超过目标 30 秒（`remaining <= -30`）进入紫卡

## 4.2 档位 B：`planned <= 300`（5 分钟及以下）

- `remaining > 60`：`initial / blue`
- `60 >= remaining > 30`：`qualified / green`
- `30 >= remaining > 0`：`warning / yellow`
- `0 >= remaining > -30`：`overtime / red_soft`
- `remaining <= -30`：`severe_overtime / purple`

边界解释：
- `remaining = 60` 进入绿卡
- `remaining = 30` 进入黄卡
- `remaining = 0` 进入浅红
- 超过 30 秒进入紫卡

---

## 5. 状态落盘时机（V1）

不做“每 10 秒固定落盘”，改为**事件 + 阈值跨越**：

1. 用户操作事件：开始/暂停/下一节/上一节/跳转/调时/编辑/新增/删除。
2. 页面生命周期：`hide/unload`。
3. 阈值跨越事件：颜色从一种变到另一种时立即落盘（避免状态丢失）。

说明：
- 高频 tick（500ms）不直接写库。
- 只有命中以上事件才写，避免写放大与抖动。

---

## 6. 写入协议（重写核心）

客户端提交：

```json
{
  "meetingId": "xxx",
  "baseVersion": 12,
  "ops": [
    {"opId": "uuid-1", "type": "update_item", "itemId": "item-1", "patch": {"title": "..."}} ,
    {"opId": "uuid-2", "type": "move_item", "itemId": "item-3", "toIndex": 5},
    {
      "opId": "uuid-3",
      "type": "create_item",
      "item": {
        "parentItemKey": "seg-table-topics",
        "slotGroupKey": "slot-7",
        "title": "演讲者C演讲",
        "plannedDuration": 120,
        "consumeParentBudget": true
      }
    }
  ]
}
```

服务端处理：
1. 检查 `baseVersion == meetings.agenda_version`
2. 事务内应用 ops（含父预算校验 + 父 segment 行锁）
3. 每次更新命中的业务行必须执行 `row_version = row_version + 1`
4. `agenda_version = agenda_version + 1`
5. 返回 `newVersion`

冲突返回：
- `409 CONFLICT` + 当前版本 + 冲突项摘要

幂等与并发约束：
- `op_id` 已存在时直接返回 `replayed`，不重复执行。
- `update_item/delete_item/move_item` 必须携带 `expected_row_version`，不匹配即冲突。
- 所有写入必须走同一个服务端入口（禁止客户端直写多表）。

---

## 6.1 权限矩阵（必须落 RLS）

1. 时间官：
- 可写 `agenda_items_v2`、`meeting_live_cursor_v2`、`meeting_participants_v2`
- 可读全部会议数据

2. 语法官：
- 只可写 `grammarian_notes_v2`
- 只读 `agenda_items_v2`、`meeting_live_cursor_v2`、`meeting_participants_v2`

3. 哼哈官：
- 只可写 `ah_counter_records_v2`
- 只读 `agenda_items_v2`、`meeting_live_cursor_v2`、`meeting_participants_v2`

4. 通用约束：
- 所有表按 `meeting_id` 做行级隔离。
- 非管理员禁止硬删除，统一软删除。
- 观察记录表默认追加写，禁止普通角色覆盖他人记录。

---

## 7. 本轮要先确认的设计问题

1. `status_color` 是否保留 `red_soft`，还是统一 `red` 仅靠文案区分。
2. 紫色阈值是否固定 30 秒，是否需要可配置。
3. `status` 是否只记录当前值，还是追加一张状态历史表（用于复盘时间线）。
4. `move_item` 是否允许跨已完成环节（建议默认允许，但需要二次确认）。
5. 用户展示名是否允许会议内“临时改名”（仅影响当前会议写入快照）。

---

## 8. 下一步实施顺序（严格逐条）

1. 先做数据库迁移（`agenda_version + status 字段`）。
2. 再改服务层写入协议（patch + 乐观锁）。
3. 再改 timer/timeline 前端调用。
4. 最后补冲突提示与重试交互。

---

## 9. “谁填的”与微信昵称获取方案（必须明确）

## 9.1 结论

1. 没有“静默免费 API”可以在未交互情况下直接拿到真实昵称并长期使用。
2. 首登应走“微信登录拿身份 + 用户主动完善资料”两步。
3. 业务字段写入时要保存“操作者 id + 操作者昵称快照”，不能只存当前昵称引用。

## 9.2 首次登录流程

1. 小程序端 `wx.login` 获取 `code`。
2. 服务端用 `code` 换 `openid/unionid/session_key`（已有登录链路可复用）。
3. 创建/更新 `user_identity_profiles` 基础身份行（先默认名 `微信用户`）。
4. 首次进入业务页时，弹“完善资料”：
   - 头像：`button open-type="chooseAvatar"`
   - 昵称：`input type="nickname"`（用户主动填写）
5. 提交后更新 `display_name/avatar_url/name_source/profile_completed`。
6. 后续所有 agenda 写操作都从登录态带 `actor_user_id + actor_name快照`。

## 9.3 官方规则依据（用于设计约束）

- `open-data` 的 `userNickName/userAvatarUrl` 已不再返回真实值（展示“微信用户”/灰头像）。
- `wx.getUserProfile` 需用户点击触发，且用户信息规则已调整。
- 微信提供“头像昵称填写”能力（`chooseAvatar` + `input type="nickname"`）用于资料完善。

---

## 10. 角色旅程演练（端到端）

> 示例会议：即兴环节总预算 25 分钟（1500 秒），含主持串场、准备、演讲、结尾。

### 10.1 时间官旅程（主控）

1. 会前建模
- 创建父节点 `segment(即兴环节, budget_limit_seconds=1500)` 到 `agenda_items_v2`。
- 预置首批子项（主持开场、A准备、A演讲、主持串场...）。
- 若新增了“人”，同步 upsert 到 `meeting_participants_v2`。
- 写审计 `agenda_ops_v2`。

2. 开始计时
- 点击开始后，写 `meeting_live_cursor_v2`：
  `current_item_key=主持开场`，`current_participant_key=主持人`，`current_phase=host_opening`。
- 更新时间 checkpoint 到 `agenda_items_v2`（当前子项 `actual_start_time/actual_duration`）。

3. 中途动态加人（关键场景）
- 时间官新增“演讲者C”时，提交 ops：
  `create_item(C准备30s)` + `create_item(C演讲120s)` + 可选 `create_item(主持串场)`。
- 服务端事务内先锁父 segment，再做预算校验；超 1500 秒则拒绝。
- 通过后写入 `agenda_items_v2`、`meeting_participants_v2`、`agenda_ops_v2`，并推 realtime。

4. 切人/切阶段
- 每次“下一位/跳转”都更新 `meeting_live_cursor_v2` 的 `current_participant_key/current_phase`。
- 例如进入 C 演讲时：`current_participant_key=C`，`current_phase=speech`。

5. 会后
- 时间官结束会议，写最终 checkpoint 与状态。
- 所有操作在 `agenda_ops_v2` 可追溯。

### 10.2 语法官旅程

1. 进入页面后订阅 `meeting_live_cursor_v2 + meeting_participants_v2`。
2. 页面当前焦点人始终跟随 `meeting_live_cursor_v2.current_participant_key`。
3. 记录“好词好句/语病”写入 `grammarian_notes_v2`，默认绑定当前焦点人。
4. 可选填 `related_item_key` 关联环节，不强制。
5. 如时间官新增演讲者，列表实时出现；本端不创建 participant 主数据。
6. 若本端有未保存内容且游标切换，按策略提示“保存并切换/暂存并切换/保持当前”。

### 10.3 哼哈官旅程

1. 同样订阅 `meeting_live_cursor_v2 + meeting_participants_v2`。
2. 焦点人随时间官游标变化自动切换。
3. 每次记录口头禅命中时，追加写入 `ah_counter_records_v2`（事件式，不做覆盖累加）。
4. 会后按 `meeting_id + participant_key + filler_word` 聚合出统计结果。

### 10.4 覆盖与冲突如何被拦住

1. 时间官改 agenda：必须带 `base_agenda_version + expected_row_version`，不匹配返回 `409`。
2. 语法官/哼哈官不具备 agenda 写权限，无法误覆盖时间官排程。
3. `meeting_live_cursor_v2` 有外键约束，禁止指向不存在的人或环节。
4. 观察记录独立表，agenda 调整不会覆盖语法/哼哈历史记录。

### 10.5 本轮验收脚本（手工）

1. 时间官开始即兴，语法官/哼哈官看到当前人=主持人。
2. 时间官新增演讲者C，其他两端 1 秒内出现 C。
3. 时间官切到 C 演讲，其他两端自动切焦点到 C。
4. 语法官写一条好句、哼哈官记两次“嗯”，会后都能按 C 查到记录。
5. 并发测试：两端同时改同一 item，后提交者收到冲突，不发生静默覆盖。
6. 失败路径：两端同时新增演讲者导致预算逼近上限，仅一方成功；另一方收到预算冲突提示。
7. 失败路径：语法官输入未保存时游标切换，必须出现“保存并切换/暂存并切换/保持当前”弹窗。
8. 恢复路径：断网 30 秒后恢复，语法官/哼哈官端能自动追平 participant 与游标。
9. 恢复路径：当前 participant 被软删除后，游标自动切到下一个有效对象或置空并提示。

### 10.6 上线前硬约束（必须实现）

1. 游标相位约束：
- `current_phase in ('prep','speech','host_opening','host_bridge','host_closing')` 时，`current_participant_key` 必须非空。
- 若不满足，写入直接拒绝。

2. 游标写入节流：
- `remaining_seconds` 不做秒级持久化。
- 仅在“相位切换/手动调时/暂停恢复/跳转”时写 `meeting_live_cursor_v2`。
- 前端倒计时由本地时钟推算，避免写放大。

3. 新增演讲者原子事务：
- `upsert participant + create agenda 子项 + 父预算校验 + op日志` 必须单事务。
- 任一步失败整体回滚，禁止半成功状态。

4. slot 组键约束：
- `slot_group_key` 在同一父节点内唯一（建议服务端生成）。
- 禁止客户端自定义重复组键。

5. 焦点缺失降级：
- 观察端收到无效游标时，自动回退到“最近有效 participant”。
- 若无有效对象，进入只读待同步态并显式提示，不可静默失败。

6. 主持人常驻：
- 会议创建时默认写入主持人 participant。
- 游标指向主持阶段时，必须能映射到主持人记录对象。

7. 审计一致性：
- 所有关键状态切换（新增/删除/改名/游标切换/冲突）都写 `agenda_ops_v2`。
- 审计日志必须可按 `meeting_id + server_ts` 完整回放。

---

## 11. 登录与身份审计设计（Agenda + Voting）

> 目标：后续“谁修改了什么、谁发起了投票管理动作、谁参与了投票”都可追踪；同时兼容匿名投票展示。

### 11.1 是否必须加登录

结论：**必须加**。  
原因：无登录态就无法可信绑定 `actor_user_id`，审计会退化为设备猜测，无法用于责任追踪。

强制要求：
1. 时间官/语法官/哼哈官/投票管理员所有写操作必须在登录态下执行。
2. 未登录用户仅允许只读；投票参与可按会议策略允许匿名。

### 11.2 首登资料流程（“免费昵称”落地方式）

1. 客户端调用 `wx.login` 获取 `code`。
2. 服务端完成微信身份兑换（`openid/unionid`）并建立会话（现有 `signInWithWechat` 链路可复用）。
3. 创建/更新 `user_identity_profiles`（默认 `display_name='微信用户'`）。
4. 首次进入业务前执行资料完善页：
   - 头像：`button open-type="chooseAvatar"`
   - 昵称：`input type="nickname"`
5. 提交后写 `user_identity_profiles.display_name/avatar_url/name_source/profile_completed`。
6. 后续所有写操作都携带：
   - `actor_user_id`
   - `actor_name_snapshot`（写时快照，不依赖后续昵称变更）

说明：
- 该路径的 API 使用本身不收费，但需要用户交互授权与合规处理。

### 11.3 角色与会议授权（新增）

```sql
CREATE TYPE meeting_role AS ENUM (
  'timer_officer',
  'grammarian',
  'ah_counter',
  'voting_admin',
  'viewer'
);

CREATE TABLE IF NOT EXISTS meeting_user_roles_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_identity_profiles(user_id),
  role meeting_role NOT NULL,
  assigned_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  assigned_at BIGINT NOT NULL,
  UNIQUE (meeting_id, user_id, role)
);
```

用途：
- RLS 直接按此表判定写权限（谁能改 agenda，谁能写语法/哼哈记录，谁能管理投票）。

### 11.4 Voting 审计改造（必须）

#### 11.4.1 投票管理动作（创建会话/改分组/改候选人）

对以下表补充审计字段：
- `voting_sessions`
- `voting_groups`
- `voting_candidates`

建议新增字段（示例）：

```sql
ALTER TABLE voting_sessions
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  ADD COLUMN IF NOT EXISTS created_by_name TEXT,
  ADD COLUMN IF NOT EXISTS updated_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  ADD COLUMN IF NOT EXISTS updated_by_name TEXT;

ALTER TABLE voting_groups
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at BIGINT,
  ADD COLUMN IF NOT EXISTS updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  ADD COLUMN IF NOT EXISTS updated_by_user_id UUID REFERENCES user_identity_profiles(user_id);

ALTER TABLE voting_candidates
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at BIGINT,
  ADD COLUMN IF NOT EXISTS updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES user_identity_profiles(user_id),
  ADD COLUMN IF NOT EXISTS updated_by_user_id UUID REFERENCES user_identity_profiles(user_id);
```

并新增管理审计日志：

```sql
CREATE TYPE voting_admin_op_type AS ENUM (
  'create_session',
  'close_session',
  'delete_session',
  'update_group',
  'update_candidate',
  'reorder_group',
  'reorder_candidate'
);

CREATE TABLE IF NOT EXISTS voting_admin_ops_v2 (
  op_id UUID PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  voting_session_id TEXT REFERENCES voting_sessions(id) ON DELETE CASCADE,
  op_type voting_admin_op_type NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID NOT NULL REFERENCES user_identity_profiles(user_id),
  actor_name TEXT NOT NULL,
  server_ts BIGINT NOT NULL
);
```

#### 11.4.2 投票行为（谁投了票）

为了兼顾匿名展示与后台审计，增加“投票追踪模式”：

```sql
CREATE TYPE vote_trace_mode AS ENUM (
  'anonymous',          -- 对内对外都不展示身份，仅设备键
  'auditable_private',  -- 对外匿名，后台可追踪 user_id
  'named'               -- 显示实名/昵称
);

ALTER TABLE voting_sessions
  ADD COLUMN IF NOT EXISTS vote_trace_mode vote_trace_mode NOT NULL DEFAULT 'anonymous';
```

对 `votes` 表新增可选身份字段：

```sql
ALTER TABLE votes
  ADD COLUMN IF NOT EXISTS voter_user_id UUID REFERENCES user_identity_profiles(user_id),
  ADD COLUMN IF NOT EXISTS voter_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS voter_fingerprint_hash TEXT;
```

策略：
1. `anonymous`：前台和报表仅显示匿名，不暴露 `voter_user_id`。
2. `auditable_private`：前台匿名，后台审计可查 `voter_user_id`。
3. `named`：按会议规则展示昵称快照。

### 11.5 端到端写入约束

1. 所有写 API 入参必须带会话 token，服务端解出 `actor_user_id`。
2. 业务表均写入 `*_by_user_id + *_by_name(snapshot)`。
3. 行版本控制：`expected_row_version` 不匹配直接冲突。
4. 每次写操作都必须落 `agenda_ops_v2` 或 `voting_admin_ops_v2`。
5. 禁止客户端绕过服务端直写关键表（RLS + 仅 RPC 写入）。

### 11.6 最小上线清单

1. 登录页接入微信登录（替换当前占位页）。
2. 增加“首次资料完善”页面（头像+昵称）。
3. `user_identity_profiles` 与会话打通。
4. Agenda 与 Voting 写接口统一加 `actor` 审计字段。
5. 验证：能准确追溯“谁改了议程、谁改了投票配置、谁投了票（按 trace mode）”。
