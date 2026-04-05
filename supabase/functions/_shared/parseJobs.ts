import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import {parseMeetingTable, type ParseMeetingResult} from './parseMeetingTable.ts'

export type ParseJobStatus = 'queued' | 'processing' | 'succeeded' | 'failed'

export type ParseJobRecord = {
  id: string
  status: ParseJobStatus
  input_text: string
  input_length: number
  result_json: ParseMeetingResult | null
  error_message: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

type CreateParseJobInput = {
  tableText: string
}

const parseJobTable = 'parse_jobs'

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
  if (!text) {
    return null
  }

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

function normalizeTableText(input: unknown) {
  if (typeof input !== 'string') {
    return ''
  }
  return input.replace(/\r\n/g, '\n').trim()
}

export async function createParseJob({tableText}: CreateParseJobInput) {
  const normalizedText = normalizeTableText(tableText)
  if (!normalizedText) {
    throw new Error('请输入表格文本')
  }

  const payload = (await restRequest(parseJobTable, {
    method: 'POST',
    headers: {
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      status: 'queued',
      input_text: normalizedText,
      input_length: normalizedText.length,
    }),
  })) as ParseJobRecord[]

  const job = payload?.[0]
  if (!job?.id) {
    throw new Error('创建解析任务失败')
  }

  return job
}

export async function getParseJob(jobId: string) {
  const payload = (await restRequest(
    parseJobTable,
    {
      method: 'GET',
    },
    {
      id: `eq.${jobId}`,
      select:
        'id,status,input_length,result_json,error_message,created_at,updated_at,started_at,finished_at',
      limit: '1',
    },
  )) as Array<Omit<ParseJobRecord, 'input_text'>>

  return payload?.[0] || null
}

async function getParseJobWithInput(jobId: string) {
  const payload = (await restRequest(
    parseJobTable,
    {
      method: 'GET',
    },
    {
      id: `eq.${jobId}`,
      select:
        'id,status,input_text,input_length,result_json,error_message,created_at,updated_at,started_at,finished_at',
      limit: '1',
    },
  )) as ParseJobRecord[]

  return payload?.[0] || null
}

async function claimQueuedParseJob(jobId: string) {
  const payload = (await restRequest(
    parseJobTable,
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
        'id,status,input_text,input_length,result_json,error_message,created_at,updated_at,started_at,finished_at',
    },
  )) as ParseJobRecord[]

  return payload?.[0] || null
}

async function updateParseJob(jobId: string, payload: Record<string, unknown>) {
  await restRequest(
    parseJobTable,
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

export async function processParseJob(jobId: string) {
  const claimedJob = await claimQueuedParseJob(jobId)
  if (!claimedJob) {
    return
  }

  try {
    const result = await parseMeetingTable({
      tableText: claimedJob.input_text,
    })

    await updateParseJob(jobId, {
      status: 'succeeded',
      result_json: result,
      error_message: null,
      finished_at: nowIsoString(),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '解析任务失败'
    console.error('[parse-jobs] process error:', {jobId, error})

    await updateParseJob(jobId, {
      status: 'failed',
      error_message: errorMessage,
      finished_at: nowIsoString(),
    })
  }
}

export async function kickQueuedParseJob(jobId: string) {
  const job = await getParseJobWithInput(jobId)
  if (!job || job.status !== 'queued') {
    return job
  }

  const edgeRuntime = globalThis.EdgeRuntime as {waitUntil(promise: Promise<unknown>): void} | undefined
  if (!edgeRuntime?.waitUntil) {
    console.warn('[parse-jobs] EdgeRuntime.waitUntil unavailable, job stays queued until next trigger', {jobId})
    return job
  }

  edgeRuntime.waitUntil(processParseJob(jobId))
  return job
}
