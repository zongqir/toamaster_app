import {parseMeetingTable} from '../_shared/parseMeetingTable.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}

Deno.serve(async (req) => {
  console.log('[parse-meeting-table] request:', req.method, req.url)

  if (req.method === 'OPTIONS') {
    return new Response(null, {headers: corsHeaders})
  }

  try {
    const body = (await req.json()) as {
      tableText?: string
      aiConfig?: {
        apiUrl?: string
        apiKey?: string
        model?: string
        provider?: string
      }
    }

    const parsedData = await parseMeetingTable({
      tableText: body?.tableText || '',
      aiConfig: body?.aiConfig,
    })

    return jsonResponse(parsedData)
  } catch (error) {
    console.error('[parse-meeting-table] error:', error)
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      500,
    )
  }
})
