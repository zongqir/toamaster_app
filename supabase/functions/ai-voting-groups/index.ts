const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    return new Response(null, {headers: corsHeaders})
  }

  try {
    // 1. 解析请求参数
    const body = await req.json()
    const {meetingSession} = body

    // 2. 参数验证
    if (!meetingSession) {
      return new Response(JSON.stringify({error: '缺少必需参数: meetingSession'}), {
        status: 400,
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      })
    }

    // 3. 构建提示词
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
   - 只包含：即兴演讲者（环节类型 type: tableTopics）
   - 判断依据：环节标题包含"即兴演讲"、"Table Topics"，且是演讲者不是主持人
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
     * SAA：标题包含"SAA"、"Sergeant at Arms"
     * 其他角色：其他未分类的角色

重要规则：
- 每个候选人只能出现在一个分组中
- 如果某个分组没有候选人，不要生成该分组（允许空分组）
- 不要强行把人员分配到不合适的组
- 只包含有明确参与者姓名的环节
- 根据环节标题和类型综合判断，优先使用标题关键词判断
- 只要标题包含"总点评"两个字，就是总点评角色，属于"最佳角色"组
- 总主持是介绍会议和主持的角色，与总点评在同一个"最佳角色"组

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
6. 总点评官、即兴主持、即兴点评、总主持都属于"最佳角色"组`

    const userPrompt = `会议流程数据：
${JSON.stringify(meetingSession, null, 2)}

请分析以上会议流程，生成投票分组的 JSON 数据。`

    // 4. 调用文心一言 API
    const apiKey = Deno.env.get('INTEGRATIONS_API_KEY')
    const upstreamApiUrl =
      'https://app-9br3x1tvwn41-api-zYkZz8qovQ1L-gateway.appmiaoda.com/v2/chat/completions'

    const response = await fetch(upstreamApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        messages: [
          {role: 'system', content: systemPrompt},
          {role: 'user', content: userPrompt},
        ],
      }),
    })

    // 5. 检查响应状态
    if (!response.ok) {
      const errorText = await response.text()
      console.error('[AI API Error]:', errorText)
      return new Response(JSON.stringify({error: `AI API 请求失败: ${response.status}`}), {
        status: response.status,
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      })
    }

    // 6. 读取流式响应并组装完整内容
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let fullContent = ''

    if (!reader) {
      return new Response(JSON.stringify({error: '无法读取响应流'}), {
        status: 500,
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      })
    }

    while (true) {
      const {done, value} = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, {stream: true})
      const lines = chunk.split('\n')

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            const content = parsed.choices?.[0]?.delta?.content || ''
            fullContent += content
          } catch (e) {
            console.error('[Parse Error]:', e)
          }
        }
      }
    }

    console.log('[AI Response]:', fullContent.slice(0, 200))

    // 7. 清理并解析 JSON
    let jsonStr = fullContent.trim()
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '')
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```\n?/g, '')
    }

    try {
      const result = JSON.parse(jsonStr)
      // 返回解析后的 JSON
      return new Response(JSON.stringify(result), {
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      })
    } catch (e) {
      console.error('[JSON Parse Error]:', e, jsonStr.slice(0, 200))
      return new Response(JSON.stringify({error: 'AI 返回格式错误', raw: fullContent.slice(0, 500)}), {
        status: 500,
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      })
    }
  } catch (error) {
    console.error('[Edge Function Error]:', error instanceof Error ? error.message : 'Unknown error', error)
    return new Response(JSON.stringify({error: error instanceof Error ? error.message : 'Unknown error'}), {
      status: 500,
      headers: {...corsHeaders, 'Content-Type': 'application/json'},
    })
  }
})
