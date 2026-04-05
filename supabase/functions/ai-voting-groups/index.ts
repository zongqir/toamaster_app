import {generateVotingGroups} from '../_shared/generateVotingGroups.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
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
  if (req.method === 'OPTIONS') {
    return new Response(null, {headers: corsHeaders})
  }

  if (req.method !== 'POST') {
    return jsonResponse({error: '仅支持 POST 请求'}, 405)
  }

  try {
    const body = (await req.json()) as {meetingSession?: Record<string, unknown>}
    const result = await generateVotingGroups(body?.meetingSession)
    return jsonResponse(result)
  } catch (error) {
    console.error('[ai-voting-groups] error:', error)
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : 'AI 投票分组失败',
      },
      500,
    )
  }
})
