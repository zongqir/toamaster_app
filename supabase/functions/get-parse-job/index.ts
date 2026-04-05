import {getParseJob, kickQueuedParseJob} from '../_shared/parseJobs.ts'

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
    const body = (await req.json()) as {jobId?: string}
    const jobId = body?.jobId?.trim()
    if (!jobId) {
      return jsonResponse({error: '缺少 jobId'}, 400)
    }

    await kickQueuedParseJob(jobId)
    const job = await getParseJob(jobId)
    if (!job) {
      return jsonResponse({error: '任务不存在'}, 404)
    }

    return jsonResponse({
      jobId: job.id,
      status: job.status,
      inputLength: job.input_length,
      result: job.result_json,
      errorMessage: job.error_message,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
    })
  } catch (error) {
    console.error('[get-parse-job] error:', error)
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : '查询解析任务失败',
      },
      500,
    )
  }
})
