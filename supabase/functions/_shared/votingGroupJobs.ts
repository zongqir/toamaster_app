import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import {generateVotingGroups, type VotingGroupGenerationResult} from './generateVotingGroups.ts'

export type VotingGroupJobStatus = 'queued' | 'processing' | 'succeeded' | 'failed'

export type VotingGroupJobRecord = {
  id: string
  meeting_id: string
  status: VotingGroupJobStatus
  input_json: Record<string, unknown>
  result_json: VotingGroupGenerationResult | null
  error_message: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

type CreateVotingGroupJobInput = {
  meetingSession: Record<string, unknown>
}

const votingGroupJobTable = 'voting_group_jobs'

function getSupabaseAdminConfig() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('服务端未配置 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY')
  }

  return {supabaseUrl, serviceRoleKey}
}

function buildRestUrl(path: string, params?: Record<string, string>) {
  const {supabaseUrl} = getSupabaseAdminConfig()
  const url = new URL(`/rest/v1/${path}`, supabaseUrl)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim()
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const candidates = [record.message, record.error, record.details, record.hint]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim()
      }
    }
  }

  return fallback
}

async function restRequest(path: string, init: RequestInit, params?: Record<string, string>) {
  const {serviceRoleKey} = getSupabaseAdminConfig()
  const response = await fetch(buildRestUrl(path, params), {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })

  const payload = await parseResponsePayload(response)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `数据库请求失败: HTTP ${response.status}`))
  }

  return payload
}

function nowIsoString() {
  return new Date().toISOString()
}

function normalizeMeetingSession(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('缺少必需参数: meetingSession')
  }

  const meetingSession = input as Record<string, unknown>
  const meetingId = typeof meetingSession.id === 'string' ? meetingSession.id.trim() : ''
  if (!meetingId) {
    throw new Error('meetingSession.id 缺失')
  }

  return {meetingSession, meetingId}
}

export async function createVotingGroupJob({meetingSession}: CreateVotingGroupJobInput) {
  const normalized = normalizeMeetingSession(meetingSession)
  const payload = (await restRequest(votingGroupJobTable, {
    method: 'POST',
    headers: {
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      meeting_id: normalized.meetingId,
      status: 'queued',
      input_json: normalized.meetingSession,
    }),
  })) as VotingGroupJobRecord[]

  const job = payload?.[0]
  if (!job?.id) {
    throw new Error('创建投票分组任务失败')
  }

  return job
}

export async function getVotingGroupJob(jobId: string) {
  const payload = (await restRequest(
    votingGroupJobTable,
    {
      method: 'GET',
    },
    {
      id: `eq.${jobId}`,
      select:
        'id,meeting_id,status,result_json,error_message,created_at,updated_at,started_at,finished_at',
      limit: '1',
    },
  )) as Array<Omit<VotingGroupJobRecord, 'input_json'>>

  return payload?.[0] || null
}

async function getVotingGroupJobWithInput(jobId: string) {
  const payload = (await restRequest(
    votingGroupJobTable,
    {
      method: 'GET',
    },
    {
      id: `eq.${jobId}`,
      select:
        'id,meeting_id,status,input_json,result_json,error_message,created_at,updated_at,started_at,finished_at',
      limit: '1',
    },
  )) as VotingGroupJobRecord[]

  return payload?.[0] || null
}

async function claimQueuedVotingGroupJob(jobId: string) {
  const payload = (await restRequest(
    votingGroupJobTable,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        status: 'processing',
        started_at: nowIsoString(),
        updated_at: nowIsoString(),
        error_message: null,
      }),
    },
    {
      id: `eq.${jobId}`,
      status: 'eq.queued',
      select:
        'id,meeting_id,status,input_json,result_json,error_message,created_at,updated_at,started_at,finished_at',
    },
  )) as VotingGroupJobRecord[]

  return payload?.[0] || null
}

async function updateVotingGroupJob(jobId: string, payload: Record<string, unknown>) {
  await restRequest(
    votingGroupJobTable,
    {
      method: 'PATCH',
      body: JSON.stringify({
        ...payload,
        updated_at: nowIsoString(),
      }),
    },
    {
      id: `eq.${jobId}`,
    },
  )
}

export async function processVotingGroupJob(jobId: string) {
  const claimedJob = await claimQueuedVotingGroupJob(jobId)
  if (!claimedJob) {
    return
  }

  try {
    const result = await generateVotingGroups(claimedJob.input_json)

    await updateVotingGroupJob(jobId, {
      status: 'succeeded',
      result_json: result,
      error_message: null,
      finished_at: nowIsoString(),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '投票分组任务失败'
    console.error('[voting-group-jobs] process error:', {jobId, error})

    await updateVotingGroupJob(jobId, {
      status: 'failed',
      error_message: errorMessage,
      finished_at: nowIsoString(),
    })
  }
}

export async function kickQueuedVotingGroupJob(jobId: string) {
  const job = await getVotingGroupJobWithInput(jobId)
  if (!job || job.status !== 'queued') {
    return job
  }

  const edgeRuntime = globalThis.EdgeRuntime as {waitUntil(promise: Promise<unknown>): void} | undefined
  if (!edgeRuntime?.waitUntil) {
    console.warn('[voting-group-jobs] EdgeRuntime.waitUntil unavailable, job stays queued until next trigger', {jobId})
    return job
  }

  edgeRuntime.waitUntil(processVotingGroupJob(jobId))
  return job
}
