import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

export type VotingGroupGenerationResult = {
  groups: Array<Record<string, unknown>>
}

function buildVotingGroupPrompts(meetingSession: unknown) {
  const systemPrompt = `你是一个头马会议投票分组助手。请根据以下会议流程，智能地将参与者分组用于投票。

分组规则（严格按照以下规则分类）：

1. 最佳备稿：
   - 只包含：备稿演讲者（环节类型 type: preparedSpeech）
   - 判断依据：环节标题包含"备稿演讲"或类型为preparedSpeech

2. 最佳备稿点评：
   - 只包含：针对备稿演讲的点评者（环节类型 type: evaluation）
   - 判断依据：环节标题包含"备稿点评"或"点评备稿"，且类型为evaluation
   - 注意：只要标题中包含"总点评"两个字，就是总点评角色，属于"最佳角色"组，不是备稿点评

3. 最佳即兴：
   - 优先包含：meetingSession.impromptuRecords 中 status=completed 的真实即兴演讲者
   - 如果 impromptuRecords 为空，才回退到旧规则：从环节类型 type: tableTopics 中判断
   - 注意：不包含"即兴主持"、"即兴点评"

4. 最佳促进官：
   - 包含：时间官、语法官、哼哈官、计时官等会议官员
   - 判断依据：环节标题包含"时间官"、"语法官"、"哼哈官"、"Ah Counter"、"Timer"、"Grammarian"等

5. 最佳角色：
   - 包含：总主持、即兴主持、即兴点评、总点评、SAA等其他角色
   - 判断依据：
     * 总主持：标题包含"主持人"、"Toastmaster"、"主持会议"、"介绍会议"、"介绍"等，负责介绍会议和主持的角色
     * 总点评：只要标题中包含"总点评"两个字，就是总点评角色（如：会议总点评、总点评、会议中点评等都是总点评角色）
     * 即兴主持：标题包含"即兴主持"、"Table Topics Master"
     * 即兴点评：标题包含"即兴点评"
     * SAA：标题包含"SAA"、"Sergeant at Arms"、"司仪"时，优先识别为 SAA，并归入"最佳角色"
     * 其他角色：其他未分类的角色

重要规则：
- 每个候选人只能出现在一个分组中
- 如果某个分组没有候选人，不要生成该分组（允许空分组）
- 不要强行把人员分配到不合适的组
- 只包含有明确参与者姓名的环节或即兴记录
- 根据环节标题和类型综合判断，优先使用标题关键词判断
- 如果 meetingSession.impromptuRecords 存在并且有已完成记录，最佳即兴必须优先使用这些记录，不要再从 agenda 猜测
- 只要标题包含"总点评"两个字，就是总点评角色，属于"最佳角色"组
- 总主持是介绍会议和主持的角色，与总点评在同一个"最佳角色"组
- 标题或描述包含"入会邀请"、"全场颁奖"时，视为流程环节而不是投票角色，必须排除，不要放入任何分组，尤其不要放入"最佳角色"
- SAA 是明确的投票角色，只要识别到 SAA / Sergeant at Arms / 司仪，就必须优先放入"最佳角色"，不要遗漏

每组的最大可选数规则：
- 候选人数 <= 3：maxSelections = 1
- 候选人数 4-6：maxSelections = 2
- 候选人数 >= 7：maxSelections = 3

请返回以下 JSON 格式（不要包含任何其他文字说明）：
{
  "groups": [
    {
      "id": "临时ID（使用 temp_group_0, temp_group_1 等格式）",
      "groupName": "分组名称（必须使用：最佳备稿、最佳备稿点评、最佳即兴、最佳促进官、最佳角色）",
      "groupType": "preparedSpeech|evaluation|tableTopics|officials|others",
      "maxSelections": 1,
      "orderIndex": 0,
      "candidates": [
        {
          "id": "临时ID（使用 temp_candidate_0_0, temp_candidate_0_1 等格式）",
          "name": "候选人姓名",
          "itemId": "对应的会议环节ID",
          "description": "环节描述（如：备稿演讲1、总点评官）",
          "orderIndex": 0
        }
      ]
    }
  ]
}

注意事项：
1. 分组名称必须使用：最佳备稿、最佳备稿点评、最佳即兴、最佳促进官、最佳角色
2. 按照重要性排序分组（最佳备稿 > 最佳备稿点评 > 最佳即兴 > 最佳促进官 > 最佳角色）
3. 确保返回的是纯 JSON 格式，不要包含任何 markdown 标记或其他文字
4. ID 必须使用 temp_group_X 和 temp_candidate_X_Y 格式
5. 如果无法确定某个角色的分组，优先放入"最佳角色"组
6. 总点评官、即兴主持、即兴点评、总主持、SAA 都属于"最佳角色"组
7. "入会邀请"、"全场颁奖"不是候选角色，必须排除，不得出现在任何分组中`

  const userPrompt = `会议流程数据：
${JSON.stringify(meetingSession, null, 2)}

请分析以上会议流程，生成投票分组的 JSON 数据。`

  return {systemPrompt, userPrompt}
}

function normalizeJsonFromModelOutput(rawText: string) {
  let jsonStr = rawText.trim()
  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '')
  } else if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/```\n?/g, '')
  }
  return jsonStr.trim()
}

export async function generateVotingGroups(meetingSession: unknown): Promise<VotingGroupGenerationResult> {
  if (!meetingSession || typeof meetingSession !== 'object') {
    throw new Error('缺少必需参数: meetingSession')
  }

  const apiKey = Deno.env.get('SILICONFLOW_API_KEY')
  if (!apiKey) {
    throw new Error('服务端未配置 SILICONFLOW_API_KEY')
  }

  const {systemPrompt, userPrompt} = buildVotingGroupPrompts(meetingSession)
  const upstreamApiUrl = 'https://api.siliconflow.cn/v1/chat/completions'

  const response = await fetch(upstreamApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'Qwen/Qwen2.5-72B-Instruct',
      stream: false,
      messages: [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: userPrompt},
      ],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('[AI voting groups API error]:', errorText)
    throw new Error(`AI API 请求失败: ${response.status}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string
      }
    }>
  }
  const fullContent = payload.choices?.[0]?.message?.content || ''

  if (!fullContent.trim()) {
    throw new Error('AI 返回内容为空')
  }

  console.log('[AI voting groups response]:', fullContent.slice(0, 200))
  const normalizedJson = normalizeJsonFromModelOutput(fullContent)

  try {
    const result = JSON.parse(normalizedJson) as VotingGroupGenerationResult
    if (!Array.isArray(result.groups)) {
      throw new Error('AI 返回格式错误')
    }
    return result
  } catch (error) {
    console.error('[AI voting groups JSON parse error]:', error, normalizedJson.slice(0, 200))
    throw new Error('AI 返回格式错误')
  }
}
