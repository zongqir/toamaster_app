// @ts-nocheck

import {createClient} from '@supabase/supabase-js'
import Taro, {showToast} from '@tarojs/taro'

const supabaseUrl: string = process.env.TARO_APP_SUPABASE_URL!
const supabaseAnonKey: string = process.env.TARO_APP_SUPABASE_ANON_KEY || 'TOKEN'
const appId: string = process.env.TARO_APP_APP_ID!
const projectRef = (() => {
  try {
    return new URL(supabaseUrl).hostname.split('.')[0] || 'default'
  } catch {
    return 'default'
  }
})()
const legacyStorageKey = `${appId}-auth-token`
const scopedStorageKey = `${appId}-${projectRef}-auth-token`
const publicFunctionAllowlist = new Set([
  'wechat-miniprogram-login',
  'parse-meeting-table',
  'submit-parse-job',
  'get-parse-job',
  'submit-voting-group-job',
  'get-voting-group-job',
  'ocr-recognition',
  'ai-voting-groups',
  'test-connection'
])

function getPublicFunctionName(url: string): string | null {
  const match = url.match(/\/functions\/v1\/([^/?#]+)/)
  if (!match?.[1]) {
    return null
  }
  return decodeURIComponent(match[1])
}

function normalizeHeaders(input?: HeadersInit): Record<string, string> {
  if (!input) {
    return {}
  }

  if (typeof Headers !== 'undefined' && input instanceof Headers) {
    return Object.fromEntries(Array.from(input.entries()).map(([key, value]) => [key, String(value)]))
  }

  if (Array.isArray(input)) {
    return Object.fromEntries(input.map(([key, value]) => [key, String(value)]))
  }

  if (input instanceof Map) {
    return Object.fromEntries(Array.from(input.entries()).map(([key, value]) => [key, String(value)]))
  }

  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, String(value)])
  )
}

function hasHeader(headers: Record<string, string>, name: string) {
  const normalized = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized)
}

function safeCloseRealtimeSocketTask(
  socketTask: {readyState?: number; close?: (options?: Record<string, unknown>) => void} | null | undefined,
  code?: number,
  reason?: string
) {
  if (!socketTask || typeof socketTask.close !== 'function') {
    return false
  }

  const readyState = socketTask.readyState
  if (typeof readyState === 'number' && readyState !== 0 && readyState !== 1) {
    return false
  }

  try {
    socketTask.close({
      code,
      reason: reason || '',
      fail: (error) => {
        console.warn('[supabase-realtime] closeSocket ignored', {
          readyState,
          code,
          reason,
          error
        })
      }
    })
    return true
  } catch (error) {
    console.warn('[supabase-realtime] closeSocket threw', {
      readyState,
      code,
      reason,
      error
    })
    return false
  }
}

function patchWechatRealtimeClient(client: unknown) {
  const realtime = (client as {
    realtime?: {
      __wechatClosePatchApplied?: boolean
      conn?: {readyState?: number; close?: (options?: Record<string, unknown>) => void} | null
      accessToken?: string | null
      heartbeatTimer?: ReturnType<typeof setInterval> | null
      reconnectTimer?: {reset?: () => void; scheduleTimeout?: () => void}
      pendingHeartbeatRef?: string | null
      log?: (kind: string, message: string, data?: unknown) => void
      isConnected?: () => boolean
      _makeRef?: () => string
      push?: (payload: Record<string, unknown>) => void
      setAuth?: (token?: string | null) => void
      disconnect?: (code?: number, reason?: string) => void
      _onConnClose?: (event: unknown) => void
      _sendHeartbeat?: () => void
    }
  }).realtime

  if (!realtime || realtime.__wechatClosePatchApplied) {
    return
  }

  const originalOnConnClose = realtime._onConnClose?.bind(realtime)

  realtime.disconnect = function patchedDisconnect(code?: number, reason?: string) {
    const currentConn = this.conn
    if (currentConn) {
      safeCloseRealtimeSocketTask(currentConn, code, reason)
    }

    this.conn = null

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    this.reconnectTimer?.reset?.()
  }

  realtime._onConnClose = function patchedOnConnClose(event: unknown) {
    this.conn = null
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    return originalOnConnClose?.(event)
  }

  realtime._sendHeartbeat = function patchedSendHeartbeat() {
    if (!this.isConnected?.()) {
      return
    }

    if (this.pendingHeartbeatRef) {
      const currentConn = this.conn
      this.pendingHeartbeatRef = null
      this.conn = null
      this.log?.('transport', 'heartbeat timeout. Attempting to re-establish connection')

      const closed = safeCloseRealtimeSocketTask(currentConn, 1000, 'heartbeat timeout')
      if (!closed) {
        this.reconnectTimer?.scheduleTimeout?.()
      }
      return
    }

    this.pendingHeartbeatRef = this._makeRef?.() || null
    this.push?.({
      topic: 'phoenix',
      event: 'heartbeat',
      payload: {},
      ref: this.pendingHeartbeatRef
    })
    this.setAuth?.(this.accessToken)
  }

  realtime.__wechatClosePatchApplied = true
}

// The app used to key auth state only by appId. After switching Supabase projects,
// that reused stale tokens from the previous backend and caused "Invalid JWT".
if (legacyStorageKey !== scopedStorageKey) {
  try {
    Taro.removeStorageSync(legacyStorageKey)
  } catch {
    // Ignore cleanup failures and continue with the scoped key.
  }
}

let noticed = false
export const customFetch: typeof fetch = async (url: string, options: RequestInit) => {
  const headers = normalizeHeaders(options.headers)
  const {method = 'GET', body} = options

  // H5 + Taro.request 下，supabase-js 透传到 custom fetch 的 apikey / Authorization
  // 在部分请求里并不稳定。这里统一兜底补上匿名访问所需的默认头，
  // 如果上层已经传了用户 token，则保持原值不覆盖。
  if (!hasHeader(headers, 'apikey')) {
    headers.apikey = supabaseAnonKey
  }
  if (!hasHeader(headers, 'Authorization')) {
    headers.Authorization = `Bearer ${supabaseAnonKey}`
  }

  const functionName = getPublicFunctionName(url)
  if (functionName && publicFunctionAllowlist.has(functionName)) {
    headers.apikey = supabaseAnonKey
    if (!hasHeader(headers, 'Authorization')) {
      headers.Authorization = `Bearer ${supabaseAnonKey}`
    }
  }

  // 设置超时时间：Edge Functions 使用 5 分钟超时
  const timeout = url.includes('/functions/v1/') ? 300000 : 60000

  let res: Taro.request.SuccessCallbackResult<any>
  try {
    res = await Taro.request({
      url,
      method: method as keyof Taro.request.Method,
      header: headers,
      data: body,
      responseType: 'text',
      timeout
    })
  } catch (requestError) {
    console.error('[supabase-customFetch] request failed', {
      url,
      method,
      functionName,
      timeout,
      hasBody: body !== undefined && body !== null,
      headerKeys:
        headers && typeof headers === 'object' && !Array.isArray(headers) ? Object.keys(headers) : [],
      error: requestError
    })
    throw requestError
  }

  // 全局启停提示
  if (res.statusCode > 300 && res.data?.code === 'SupabaseNotReady' && !noticed) {
    const tip = res.data.message || res.data.msg || '服务端报错'
    noticed = true
    showToast({
      title: tip,
      icon: 'error',
      duration: 5000
    })
  }

  if (!(res.statusCode >= 200 && res.statusCode < 300)) {
    console.error('[supabase-customFetch] non-2xx response', {
      url,
      method,
      functionName,
      statusCode: res.statusCode,
      response: res.data,
      headerKeys: res.header ? Object.keys(res.header) : []
    })
  }

  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    json: async () => res.data,
    text: async () => JSON.stringify(res.data),
    data: res.data, // 兼容小程序的返回格式
    headers: {
      get: (key: string) => res.header?.[key] || res.header?.[key?.toLowerCase()]
    }
  } as unknown as Response
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    fetch: customFetch
  },
  auth: {
    storageKey: scopedStorageKey
  }
})

patchWechatRealtimeClient(supabase)
