import type {User} from '@supabase/supabase-js'
import Taro from '@tarojs/taro'
import {createContext, type ReactNode, useContext, useEffect, useState} from 'react'
import {AgendaV2DatabaseService} from '@/db/agendaV2Database'
import {supabase} from '@/client/supabase'

export interface Profile {
  [key: string]: unknown
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const {data, error} = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()

  if (error) {
    console.error('Failed to fetch user profile:', error)
    return null
  }
  return data
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
    const appId = (process.env.TARO_APP_WECHAT_APP_ID || process.env.TARO_APP_APP_ID || 'toamaster_app') as string

    const result = await AgendaV2DatabaseService.upsertUserIdentityProfile({
      user_id: user.id,
      app_id: appId,
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

    const profileData = await getProfile(user.id)
    setProfile(profileData)
  }

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({data: {session}}) => {
        setUser(session?.user ?? null)
        if (session?.user) {
          void syncAgendaIdentityProfile(session.user)
          getProfile(session.user.id).then(setProfile)
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
        void syncAgendaIdentityProfile(session.user)
        getProfile(session.user.id).then(setProfile)
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
      // Check if running in WeChat Mini Program environment
      if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) {
        throw new Error('仅支持微信小程序登录，网页端请使用用户名密码登录')
      }

      // Get WeChat login code
      const loginResult = await Taro.login()
      if (!loginResult?.code) {
        throw new Error('微信登录失败：未获取到 code')
      }

      // 显式拉取微信昵称/头像，用于“谁修改了议程”的可追溯展示
      let profilePayload: {nickname?: string; avatarUrl?: string} | null = null
      try {
        const profileResult = await Taro.getUserProfile({
          desc: '用于记录会议操作人昵称与头像'
        })
        profilePayload = {
          nickname: profileResult?.userInfo?.nickName || undefined,
          avatarUrl: profileResult?.userInfo?.avatarUrl || undefined
        }
      } catch (profileError) {
        throw new Error(
          `需要授权微信昵称后才能登录：${
            profileError instanceof Error ? profileError.message : '未授权获取昵称头像'
          }`
        )
      }

      // Call backend Edge Function for login
      const {data, error} = await supabase.functions.invoke('wechat-miniprogram-login', {
        body: {
          code: loginResult.code,
          profile: profilePayload
        }
      })

      if (error) {
        const errorMsg = (await error?.context?.text?.()) || error.message
        throw new Error(errorMsg)
      }
      if (!data?.token) {
        throw new Error('微信登录失败：后端未返回 token')
      }

      // Verify OTP token
      const {error: verifyError} = await supabase.auth.verifyOtp({
        token_hash: data.token,
        type: 'email'
      })

      if (verifyError) throw verifyError
      return {error: null}
    } catch (error) {
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
