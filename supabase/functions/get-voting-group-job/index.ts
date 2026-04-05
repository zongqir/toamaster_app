import {getVotingGroupJob, kickQueuedVotingGroupJob} from '../_shared/votingGroupJobs.ts'

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

    await kickQueuedVotingGroupJob(jobId)
    const job = await getVotingGroupJob(jobId)
    if (!job) {
      return jsonResponse({error: '任务不存在'}, 404)
    }

    return jsonResponse({
      jobId: job.id,
      meetingId: job.meeting_id,
      status: job.status,
      result: job.result_json,
      errorMessage: job.error_message,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
    })
  } catch (error) {
    console.error('[get-voting-group-job] error:', error)
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : '查询投票分组任务失败',
      },
      500,
    )
  }
})
