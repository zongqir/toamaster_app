export type ParseMeetingItem = {
  title: string
  speaker: string
  durationSec: number
  startTime: string
  type: string
  parentTitle: string
}

export type ParseMeetingMetadata = {
  clubName: string
  meetingNo: number
  theme: string
  date: string
  wordOfTheDay: string
  location: string
  timeRange: string
  startTime: string
  endTime: string
}

export type ParseMeetingResult = {
  metadata: ParseMeetingMetadata
  items: ParseMeetingItem[]
}

type ParseMeetingOptions = {
  tableText: string
  aiConfig?: {
    apiUrl?: string
    apiKey?: string
    model?: string
    provider?: string
  }
  aiTimeoutMs?: number
}

const defaultAiTimeoutMs = 300_000

const systemPrompt = `你是一个专业的【头马/培训会议议程】解析助手。用户会粘贴从 Excel 复制出的"表格文本"，其中混有：时间、活动、限时、参与者，以及大量备注/规则/官员名单等噪声。你的任务是：抽取结构化议程信息，并【只返回严格 JSON】。

====================
一、只抽取两类结果
====================
A) metadata：会议元信息
B) items：可计时、可执行的"具体环节"（必须是会被主持/计时的动作）

重要：像"备稿演讲上半场/下半场/备稿点评环节/会议促进者报告"等通常是【章节标题/父级容器】，用于组织结构，不是具体可执行动作 默认不进 items、不参与计时推算。

====================
二、输出 JSON 结构（严格）
====================
{
  "metadata": {
    "clubName": "",
    "meetingNo": 0,
    "theme": "",
    "date": "",
    "wordOfTheDay": "",
    "location": "",
    "timeRange": "",
    "startTime": "",
    "endTime": ""
  },
  "items": [
    {
      "title": "",
      "speaker": "",
      "durationSec": 0,
      "startTime": "",
      "type": "other",
      "parentTitle": ""
    }
  ]
}

只允许输出 JSON；不要输出解释、Markdown、注释、前后缀。

====================
三、你必须适配的输入特性
====================
- 文本可能包含表头、合并单元格导致的空列、引号、制表符、连续空格。
- 第一列"时间"通常是 HH:MM。子活动行可能没有时间（空白）。
- "限时"可能是：00:10:00 / 10分钟 / 20秒 / 1:30 / 00:00:30 等。
- 大量备注/规则/官员名单/入会条件/头马是什么/宣传语是噪声。

====================
四、核心判定：Section 行 vs Item 行
====================

4.1 Section（章节标题/父级容器）定义：
满足以下任一特征的行，优先判定为 Section（不输出到 items）：
- 标题含：上半场/下半场/环节/报告/部分/阶段/Session/Part/Section
- 标题以"备稿演讲/备稿点评/会议促进者报告"等总括词出现，且其后紧跟多条更具体子行（介绍/演讲题目/点评/目标说明/静默写反馈等）
- 该行"参与者/负责人"为空或明显不是具体执行人（如空、神秘嘉宾用于总括、或仅作栏目名）
- 该行即使带了时间/时长，也默认视为结构性标题，不参与计时（除非它明显是具体动作，例如"拍照和休息""投票&宾客分享"等）

处理方式：
- 记录 currentSectionTitle = 该行 title（用于后续子项的 parentTitle）
- 不要把该行写入 items
- 不把该行 durationSec 纳入时间推算

4.2 Item（可计时具体环节）定义：
一行要作为 items 输出，必须满足：
- title 是一个"会发生的动作/环节"（如：入场签到/暖场游戏/会议开场白/即兴主持/《演讲题目》/静默写反馈/拍照和休息/投票/颁奖/Happy Ending 等）
并且满足至少一条：
- 该行有 HH:MM 时间且 title 非空
- 或该行无时间但明显是 currentSectionTitle 下的子活动（紧随 Section 之后，title 非空）

并且：该行不是噪声（见第六部分）。

对每条 item：
- parentTitle：若存在 currentSectionTitle 且该 item 属于其子活动，则填 currentSectionTitle，否则空字符串
- speaker：优先取"参与者"列；若为空但标题包含"主持/总主持/点评/介绍"等且有可推断人名则取；否则空字符串
- durationSec：按第五部分解析；解析失败为 0
- startTime：按 4.3 推算规则

4.3 startTime 推算规则（只针对 items）
- 若 item 行显式给出 HH:MM：以显式时间为准
- 若 item 行没有时间：
  - 用"上一条已输出 item 的结束时间"作为该 item 的 startTime
- 结束时间 = startTime + durationSec
注意：Section 行不参与推算链；推算只在 items 之间进行。

====================
五、时长解析（统一 durationSec）
====================
- HH:MM:SS => 秒
- MM:SS => 秒
- X分钟 => X*60
- X秒 => X
- 混合中英文符号与空格要能解析
- 若"限时"为空，尝试在 title/附近备注里找"X分钟/X秒"，仍失败则 0

====================
六、必须忽略的噪声（绝不进 items）
====================
- 表头行：包含"时间/活动/限时/参与者"等列名
- 礼仪/禁忌/计时规则说明文字（若不是具体环节）
- 宣传/口号：加入我们/最佳投票/荣誉时刻/321茄子/邀约下次等（除非它同时也是一个明确环节且有时间与时长，比如"投票&宾客分享"这种算环节）
- 官员团队名单（主席/VPE/VPM/VPPR/秘书长/财务官/SAA 等）整段忽略
- 头马是什么/入会条件 等介绍性段落整段忽略

====================
七、type 分类（尽量准确）
====================
- opening：开场白/会议开场
- intro：头马介绍/嘉宾介绍/会议介绍
- role：时间官/语法官/哼哈官/总点评 等角色项（"介绍即兴主持"也可归 role/intro，优先 intro）
- tableTopics：即兴主持/即兴点评/即兴
- preparedSpeech：演讲目标说明/备稿演讲子项/具体演讲题目《...》
- evaluation：备稿点评子项/会议总体点评/总点评
- break：休息/拍照和休息
- qa：Q&A/问答
- voting：投票/宾客分享
- award：颁奖/最佳
- closing：Happy Ending/会议结束/结束语
- other：无法归类

====================
八、排序与字段完整性
====================
- items 按 startTime 升序；startTime 相同按原文出现顺序
- metadata 字段缺失用 ""；meetingNo 缺失用 0；durationSec 缺失用 0
- startTime/endTime：优先使用 timeRange 的起止；否则用 items 推算最早/最晚

====================
九、元信息提取要点
====================
- meetingNo：从"第333次会议/第 333 次会议/第333次"提取数字
- clubName：紧挨"欢迎来到/欢迎参加/欢迎"后面的俱乐部名，或包含"头马俱乐部"的整段名称
- theme：从"本期主题/主题："后提取
- wordOfTheDay：从"每日一词："后提取
- date：提取最完整日期（如"2026年2月1日"）
- location：优先"线下：..."或包含楼/室/教室/大厦/Room/号等地址信息
- timeRange：从"15:00-17:30"或"时间：...15:00-17:30"提取

只返回 JSON。`

function parseJsonText(value: string) {
  const jsonMatch = value.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0])
  }
  return JSON.parse(value)
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim()
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const candidates = [record.message, record.error, record.details]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim()
      }
    }
  }

  return fallback
}

export async function parseMeetingTable({
  tableText,
  aiConfig,
  aiTimeoutMs = defaultAiTimeoutMs,
}: ParseMeetingOptions): Promise<ParseMeetingResult> {
  const normalizedText = typeof tableText === 'string' ? tableText.trim() : ''
  if (!normalizedText) {
    throw new Error('缺少必需参数: tableText')
  }

  const useCustomAI = Boolean(aiConfig?.apiUrl && aiConfig?.apiKey)
  const apiUrl = useCustomAI ? aiConfig?.apiUrl?.trim() : 'https://api.siliconflow.cn/v1/chat/completions'
  const apiKey = useCustomAI ? aiConfig?.apiKey?.trim() : Deno.env.get('SILICONFLOW_API_KEY')
  const model = aiConfig?.model || 'Qwen/Qwen2.5-72B-Instruct'

  if (!apiUrl) {
    throw new Error('AI API 地址未配置')
  }
  if (!apiKey) {
    throw new Error('API 密钥未配置')
  }

  const userPrompt = `请解析以下会议议程表：\n\n${normalizedText}`
  const requestBody: Record<string, unknown> = {
    model,
    stream: false,
    messages: [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: userPrompt},
    ],
  }

  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort('AI_TIMEOUT'), aiTimeoutMs)

  let response: Response
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    })
  } catch (error) {
    if (
      error === 'AI_TIMEOUT' ||
      (typeof error === 'string' && error.includes('AI_TIMEOUT')) ||
      (error instanceof Error && (error.name === 'AbortError' || error.message.includes('AI_TIMEOUT')))
    ) {
      throw new Error('AI 解析超时，请精简表格内容后重试')
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }

  if (!response.ok) {
    const payload = await response.text()
    throw new Error(extractErrorMessage(payload, `AI API 请求失败: ${response.status}`))
  }

  const jsonResponse = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string
      }
    }>
  }
  const fullContent = jsonResponse.choices?.[0]?.message?.content || ''
  if (!fullContent.trim()) {
    throw new Error('AI 返回内容为空')
  }

  try {
    return parseJsonText(fullContent) as ParseMeetingResult
  } catch (error) {
    console.error('[parseMeetingTable] invalid json:', error, fullContent)
    throw new Error('解析失败，AI 返回的数据格式不正确')
  }
}
