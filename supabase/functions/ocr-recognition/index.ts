const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  console.log('[OCR Function] 收到请求:', req.method, req.url)

  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // 1. 解析请求参数
    const body = await req.json()
    const { imageBase64 } = body
    console.log('[OCR Function] 接收到图片 base64 长度:', imageBase64?.length)

    // 2. 参数验证
    if (!imageBase64) {
      return new Response(
        JSON.stringify({ error: '缺少必需参数: imageBase64' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // 3. 调用硅基流动 Qwen2-VL OCR API
    const apiUrl = 'https://api.siliconflow.cn/v1/chat/completions'
    const apiKey = Deno.env.get('SILICONFLOW_API_KEY')

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: '服务端未配置 SILICONFLOW_API_KEY' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log('[OCR Function] 调用硅基流动 API')

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'Qwen/Qwen2-VL-72B-Instruct',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: imageBase64
                }
              },
              {
                type: 'text',
                text: '请识别图片中的所有文字内容，包括表格中的文字。直接输出识别到的文字，不要使用 HTML 标签，不要使用 Markdown 格式，只输出纯文本内容。'
              }
            ]
          }
        ],
        max_tokens: 8000,
        temperature: 0.0
      })
    })

    console.log('[OCR Function] API 响应状态:', response.status)

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[OCR Function] API 错误:', errorText)
      return new Response(
        JSON.stringify({ error: `OCR API 失败: ${response.status}`, details: errorText }),
        {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // 4. 解析响应
    const data = await response.json()
    console.log('[OCR Function] API 返回数据')

    if (data.choices && data.choices.length > 0) {
      const ocrText = data.choices[0].message.content
      console.log('[OCR Function] OCR 识别文字长度:', ocrText.length)

      return new Response(
        JSON.stringify({ text: ocrText }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    } else {
      return new Response(
        JSON.stringify({ error: 'OCR 返回数据格式错误' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }
  } catch (error) {
    console.error('[OCR Function Error]:', error instanceof Error ? error.message : 'Unknown error', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})
