import type {User} from '@supabase/supabase-js'
import Taro from '@tarojs/taro'
import {createContext, type ReactNode, useContext, useEffect, useState} from 'react'
import {supabase} from '@/client/supabase'
import {AgendaV2DatabaseService} from '@/db/agendaV2Database'

export interface Profile {
  [key: string]: unknown
}

function getAgendaIdentityAppId() {
  try {
    const accountInfo = Taro.getAccountInfoSync?.()
    const miniProgramAppId = accountInfo?.miniProgram?.appId
    if (miniProgramAppId) {
      return miniProgramAppId
    }
  } catch {
    // Fall through to the stable local fallback.
  }

  return 'toamaster_app'
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const {data, error} = await supabase.from('user_identity_profiles').select('*').eq('user_id', userId).maybeSingle()

  if (error) {
    console.error('Failed to fetch user profile:', error)
    return null
  }

  if (!data) {
    return null
  }

  // Preserve a few common profile-shaped aliases so existing UI does not care
  // whether the source is the legacy `profiles` table or Agenda V2 identity data.
  return {
    ...data,
    id: data.user_id,
    name: data.display_name,
    nickname: data.display_name
  }
}

async function syncAgendaIdentityProfile(user: User) {
  try {
    const metadata = (user.user_metadata || {}) as Record<string, unknown>

    const nicknameFromWechat =
      (typeof metadata.nickname === 'string' && metadata.nickname) ||
      (typeof metadata.wechat_nickname === 'string' && metadata.wechat_nickname) ||
      null
    const displayName =
      nicknameFromWechat ||
      (typeof metadata.name === 'string' && metadata.name) ||
      (typeof metadata.full_name === 'string' && metadata.full_name) ||
      (user.email ? user.email.split('@')[0] : null) ||
      '微信用户'

    const avatarUrl =
      (typeof metadata.avatar_url === 'string' && metadata.avatar_url) ||
      (typeof metadata.picture === 'string' && metadata.picture) ||
      null

    const wechatOpenId =
      (typeof metadata.wechat_openid === 'string' && metadata.wechat_openid) ||
      (typeof metadata.openid === 'string' && metadata.openid) ||
      null
    const wechatUnionId =
      (typeof metadata.wechat_unionid === 'string' && metadata.wechat_unionid) ||
      (typeof metadata.unionid === 'string' && metadata.unionid) ||
      null

    const nameSource = nicknameFromWechat ? 'wechat_profile' : 'unknown'

    const result = await AgendaV2DatabaseService.upsertUserIdentityProfile({
      user_id: user.id,
      app_id: getAgendaIdentityAppId(),
      wechat_openid: wechatOpenId,
      wechat_unionid: wechatUnionId,
      display_name: displayName,
      avatar_url: avatarUrl,
      name_source: nameSource,
      profile_completed: Boolean(displayName && displayName !== '微信用户')
    })

    if (!result.success) {
      console.warn('同步用户身份资料失败:', result.error)
    }
  } catch (error) {
    console.warn('同步用户身份资料异常:', error)
  }
}

async function loadIdentityProfile(user: User): Promise<Profile | null> {
  await syncAgendaIdentityProfile(user)
  return getProfile(user.id)
}

interface AuthContextType {
  user: User | null
  profile: Profile | null
  loading: boolean
  signInWithUsername: (username: string, password: string) => Promise<{error: Error | null}>
  signUpWithUsername: (username: string, password: string) => Promise<{error: Error | null}>
  signUpWithPhone: (phone: string, password: string) => Promise<{error: Error | null}>
  signInWithPhone: (phone: string) => Promise<{error: Error | null}>
  verifyPhoneOtp: (phone: string, code: string) => Promise<{error: Error | null}>
  signInWithWechat: () => Promise<{error: Error | null}>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({children}: {children: ReactNode}) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshProfile = async () => {
    if (!user) {
      setProfile(null)
      return
    }

    const profileData = await loadIdentityProfile(user)
    setProfile(profileData)
  }

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({data: {session}}) => {
        setUser(session?.user ?? null)
        if (session?.user) {
          loadIdentityProfile(session.user).then(setProfile)
        }
        setLoading(false)
      })
      .catch((error) => {
        console.warn('Failed to get session:', error)
        setUser(null)
        setProfile(null)
        setLoading(false)
      })

    // In this function, do NOT use any await calls. Use `.then()` instead to avoid deadlocks.
    const {
      data: {subscription}
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        loadIdentityProfile(session.user).then(setProfile)
      } else {
        setProfile(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const signInWithUsername = async (username: string, password: string) => {
    try {
      const email = `${username}@miaoda.com`
      const {error} = await supabase.auth.signInWithPassword({
        email,
        password
      })

      if (error) throw error
      return {error: null}
    } catch (error) {
      return {error: error as Error}
    }
  }

  const signUpWithUsername = async (username: string, password: string) => {
    try {
      const email = `${username}@miaoda.com`
      const {error} = await supabase.auth.signUp({
        email,
        password
      })

      if (error) throw error
      return {error: null}
    } catch (error) {
      return {error: error as Error}
    }
  }

  const signUpWithPhone = async (phone: string, password: string) => {
    try {
      const {error} = await supabase.auth.signUp({
        phone,
        password
      })

      if (error) throw error
      return {error: null}
    } catch (error) {
      return {error: error as Error}
    }
  }

  const signInWithPhone = async (phone: string) => {
    try {
      const {error} = await supabase.auth.signInWithOtp({phone})

      if (error) throw error
      return {error: null}
    } catch (error) {
      return {error: error as Error}
    }
  }

  const verifyPhoneOtp = async (phone: string, code: string) => {
    try {
      const {error} = await supabase.auth.verifyOtp({
        phone,
        token: code,
        type: 'sms'
      })
      if (error) throw error
      return {error: null}
    } catch (error) {
      return {error: error as Error}
    }
  }

  const signInWithWechat = async () => {
    try {
      console.log('[wechat-login] signInWithWechat:start', {
        env: Taro.getEnv()
      })

      // Check if running in WeChat Mini Program environment
      if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) {
        throw new Error('仅支持微信小程序登录，网页端请使用用户名密码登录')
      }

      // 必须在用户点击手势上下文中直接调用，否则微信会拒绝弹出授权。
      let profilePayload: {nickname?: string; avatarUrl?: string} | null = null
      try {
        console.log('[wechat-login] calling Taro.getUserProfile')
        const profileResult = await Taro.getUserProfile({
          desc: '用于记录会议操作人昵称与头像'
        })
        console.log('[wechat-login] Taro.getUserProfile:success', {
          hasNickName: Boolean(profileResult?.userInfo?.nickName),
          hasAvatarUrl: Boolean(profileResult?.userInfo?.avatarUrl),
          errMsg: (profileResult as {errMsg?: string} | undefined)?.errMsg
        })
        profilePayload = {
          nickname: profileResult?.userInfo?.nickName || undefined,
          avatarUrl: profileResult?.userInfo?.avatarUrl || undefined
        }
      } catch (profileError) {
        console.error('[wechat-login] Taro.getUserProfile:failed', profileError)
        throw new Error(
          `需要授权微信昵称后才能登录：${profileError instanceof Error ? profileError.message : '未授权获取昵称头像'}`
        )
      }

      // Get WeChat login code
      console.log('[wechat-login] calling Taro.login')
      const loginResult = await Taro.login()
      console.log('[wechat-login] Taro.login:result', {
        hasCode: Boolean(loginResult?.code),
        errMsg: (loginResult as {errMsg?: string} | undefined)?.errMsg
      })
      if (!loginResult?.code) {
        throw new Error('微信登录失败：未获取到 code')
      }

      // Call backend Edge Function for login
      console.log('[wechat-login] calling wechat-miniprogram-login', {
        hasCode: Boolean(loginResult.code),
        hasProfile: Boolean(profilePayload),
        hasNickname: Boolean(profilePayload?.nickname),
        hasAvatarUrl: Boolean(profilePayload?.avatarUrl)
      })
      const {data, error} = await supabase.functions.invoke('wechat-miniprogram-login', {
        body: {
          code: loginResult.code,
          profile: profilePayload
        }
      })
      console.log('[wechat-login] wechat-miniprogram-login:result', {
        hasData: Boolean(data),
        hasError: Boolean(error),
        tokenPresent: Boolean(data?.token)
      })

      if (error) {
        const errorMsg = (await error?.context?.text?.()) || error.message
        console.error('[wechat-login] wechat-miniprogram-login:error', errorMsg)
        throw new Error(errorMsg)
      }
      if (!data?.token) {
        throw new Error('微信登录失败：后端未返回 token')
      }

      // Verify OTP token
      console.log('[wechat-login] calling supabase.auth.verifyOtp')
      const {error: verifyError} = await supabase.auth.verifyOtp({
        token_hash: data.token,
        type: 'email'
      })
      console.log('[wechat-login] supabase.auth.verifyOtp:result', {
        hasError: Boolean(verifyError)
      })

      if (verifyError) throw verifyError
      console.log('[wechat-login] signInWithWechat:success')
      return {error: null}
    } catch (error) {
      console.error('[wechat-login] signInWithWechat:failed', error)
      return {error: error as Error}
    }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setProfile(null)
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        signInWithUsername,
        signUpWithUsername,
        signUpWithPhone,
        signInWithPhone,
        verifyPhoneOtp,
        signInWithWechat,
        signOut,
        refreshProfile
      }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
