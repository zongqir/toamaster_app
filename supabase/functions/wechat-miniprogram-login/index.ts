const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
}

type WechatLoginBody = {
  code?: string
  profile?: {
    nickname?: string
    avatarUrl?: string
  }
}

type WechatSessionResponse = {
  openid?: string
  unionid?: string
  session_key?: string
  errcode?: number
  errmsg?: string
}

type SupabaseAdminUser = {
  id?: string
  user_metadata?: Record<string, unknown>
}

type AdminApiResult<T> = {
  data: T | null
  error: string | null
  status: number
}

type GenerateLinkResponse = SupabaseAdminUser & {
  hashed_token?: string
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

function normalizeNickname(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.slice(0, 32)
}

function normalizeAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 2048) {
    return null
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
}

function getSupabaseAuthAdminUrl(supabaseUrl: string, path: string) {
  return `${supabaseUrl.replace(/\/$/, '')}/auth/v1/admin/${path.replace(/^\//, '')}`
}

async function parseJsonSafely(response: Response): Promise<unknown> {
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
    return payload
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const candidates = [record.msg, record.message, record.error_description, record.error]
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) {
        return value
      }
    }
  }

  return fallback
}

async function callSupabaseAdmin<T>(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
  init: RequestInit,
): Promise<AdminApiResult<T>> {
  const response = await fetch(getSupabaseAuthAdminUrl(supabaseUrl, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })

  const payload = await parseJsonSafely(response)
  if (!response.ok) {
    return {
      data: null,
      error: extractErrorMessage(payload, `Supabase Auth Admin 请求失败: HTTP ${response.status}`),
      status: response.status,
    }
  }

  return {
    data: (payload as T) ?? null,
    error: null,
    status: response.status,
  }
}

async function fetchWechatSession(code: string, appId: string, appSecret: string): Promise<WechatSessionResponse> {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
  url.searchParams.set('appid', appId)
  url.searchParams.set('secret', appSecret)
  url.searchParams.set('js_code', code)
  url.searchParams.set('grant_type', 'authorization_code')

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {'Content-Type': 'application/json'},
  })

  if (!response.ok) {
    throw new Error(`微信登录接口请求失败: HTTP ${response.status}`)
  }

  return (await response.json()) as WechatSessionResponse
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {headers: corsHeaders})
  }

  if (req.method !== 'POST') {
    return jsonResponse({error: '仅支持 POST 请求'}, 405)
  }

  try {
    const body = (await req.json()) as WechatLoginBody
    const code = body?.code?.trim()
    if (!code) {
      return jsonResponse({error: '缺少 code 参数'}, 400)
    }

    const appId = Deno.env.get('WECHAT_APP_ID')
    const appSecret = Deno.env.get('WECHAT_APP_SECRET')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!appId || !appSecret) {
      return jsonResponse({error: '服务端未配置 WECHAT_APP_ID 或 WECHAT_APP_SECRET'}, 500)
    }
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({error: '服务端未配置 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY'}, 500)
    }

    const wechatSession = await fetchWechatSession(code, appId, appSecret)
    if (wechatSession.errcode) {
      return jsonResponse(
        {
          error: `微信登录失败: ${wechatSession.errmsg || '未知错误'}`,
          code: wechatSession.errcode,
        },
        400,
      )
    }

    const openid = wechatSession.openid
    if (!openid) {
      return jsonResponse({error: '微信登录失败：未获取到 openid'}, 400)
    }

    const unionid = wechatSession.unionid || null
    const nickname = normalizeNickname(body?.profile?.nickname)
    const avatarUrl = normalizeAvatarUrl(body?.profile?.avatarUrl)
    const email = `wechat_${openid}@wechat.toamaster.local`

    const metadata: Record<string, unknown> = {
      auth_provider: 'wechat_miniprogram',
      wechat_openid: openid,
      openid,
    }
    if (unionid) {
      metadata.wechat_unionid = unionid
      metadata.unionid = unionid
    }
    if (nickname) {
      metadata.nickname = nickname
      metadata.wechat_nickname = nickname
      metadata.name = nickname
    }
    if (avatarUrl) {
      metadata.avatar_url = avatarUrl
      metadata.picture = avatarUrl
    }

    let userId: string | null = null
    let isNewUser = false

    const createUserResult = await callSupabaseAdmin<SupabaseAdminUser>(
      supabaseUrl,
      serviceRoleKey,
      'users',
      {
        method: 'POST',
        body: JSON.stringify({
          email,
          email_confirm: true,
          user_metadata: metadata,
          app_metadata: {
            provider: 'wechat_miniprogram',
          },
        }),
      },
    )

    if (createUserResult.error) {
      const message = createUserResult.error
      const isAlreadyExists = /already registered|already been registered|already exists/i.test(message)
      if (!isAlreadyExists) {
        throw new Error(`创建用户失败: ${message}`)
      }
    } else {
      userId = createUserResult.data?.id || null
      isNewUser = Boolean(userId)
    }

    const generateLinkResult = await callSupabaseAdmin<GenerateLinkResponse>(
      supabaseUrl,
      serviceRoleKey,
      'generate_link',
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'magiclink',
          email,
        }),
      },
    )
    if (generateLinkResult.error) {
      throw new Error(`生成登录链接失败: ${generateLinkResult.error}`)
    }

    const tokenHash = generateLinkResult.data?.hashed_token
    if (!tokenHash) {
      throw new Error('生成登录 token 失败')
    }

    const linkUserId = generateLinkResult.data?.id || null
    const targetUserId = linkUserId || userId

    if (targetUserId) {
      const existingMetadata = (generateLinkResult.data?.user_metadata || {}) as Record<string, unknown>
      const mergedMetadata = {...existingMetadata, ...metadata}

      const updateUserResult = await callSupabaseAdmin<SupabaseAdminUser>(
        supabaseUrl,
        serviceRoleKey,
        `user/${targetUserId}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            user_metadata: mergedMetadata,
          }),
        },
      )

      if (updateUserResult.error) {
        console.warn('[wechat-miniprogram-login] 更新用户 metadata 失败:', updateUserResult.error)
      }
    }

    return jsonResponse({
      token: tokenHash,
      openid,
      unionid,
      nickname,
      isNewUser,
    })
  } catch (error) {
    console.error('[wechat-miniprogram-login] error:', error)
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : '微信登录异常',
      },
      500,
    )
  }
})
