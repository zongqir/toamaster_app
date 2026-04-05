import {createParseJob, kickQueuedParseJob} from '../_shared/parseJobs.ts'

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
    const body = (await req.json()) as {tableText?: string}
    const job = await createParseJob({tableText: body?.tableText || ''})
    await kickQueuedParseJob(job.id)

    return jsonResponse({
      jobId: job.id,
      status: job.status,
    })
  } catch (error) {
    console.error('[submit-parse-job] error:', error)
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : '创建解析任务失败',
      },
      500,
    )
  }
})
