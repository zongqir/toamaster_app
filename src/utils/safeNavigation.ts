import Taro from '@tarojs/taro'

const DEFAULT_LOCK_MS = 900
let routeLockedUntil = 0

const isRouteLocked = () => Date.now() < routeLockedUntil
const lockRoute = (lockMs: number) => {
  routeLockedUntil = Date.now() + lockMs
}

export const safeNavigateTo = async (
  url: string,
  options?: {
    lockMs?: number
    fallback?: 'redirectTo' | 'reLaunch' | false
  }
) => {
  const lockMs = options?.lockMs ?? DEFAULT_LOCK_MS
  const fallback = options?.fallback ?? 'redirectTo'
  if (isRouteLocked()) return false

  lockRoute(lockMs)
  try {
    await Taro.navigateTo({url})
    return true
  } catch (error) {
    console.error('safeNavigateTo failed:', url, error)
    if (fallback === 'redirectTo') {
      try {
        await Taro.redirectTo({url})
        return true
      } catch (fallbackError) {
        console.error('safeNavigateTo redirect fallback failed:', url, fallbackError)
      }
    } else if (fallback === 'reLaunch') {
      try {
        await Taro.reLaunch({url})
        return true
      } catch (fallbackError) {
        console.error('safeNavigateTo relaunch fallback failed:', url, fallbackError)
      }
    }
    return false
  }
}

export const safeRedirectTo = async (
  url: string,
  options?: {
    lockMs?: number
    fallback?: 'reLaunch' | false
  }
) => {
  const lockMs = options?.lockMs ?? DEFAULT_LOCK_MS
  const fallback = options?.fallback ?? 'reLaunch'
  if (isRouteLocked()) return false

  lockRoute(lockMs)
  try {
    await Taro.redirectTo({url})
    return true
  } catch (error) {
    console.error('safeRedirectTo failed:', url, error)
    if (fallback === 'reLaunch') {
      try {
        await Taro.reLaunch({url})
        return true
      } catch (fallbackError) {
        console.error('safeRedirectTo relaunch fallback failed:', url, fallbackError)
      }
    }
    return false
  }
}

export const safeSwitchTab = async (
  url: string,
  options?: {
    lockMs?: number
    fallbackToReLaunch?: boolean
  }
) => {
  const lockMs = options?.lockMs ?? DEFAULT_LOCK_MS
  const fallbackToReLaunch = options?.fallbackToReLaunch ?? true
  if (isRouteLocked()) return false

  lockRoute(lockMs)
  try {
    await Taro.switchTab({url})
    return true
  } catch (error) {
    console.error('safeSwitchTab failed:', url, error)
    if (fallbackToReLaunch) {
      try {
        await Taro.reLaunch({url})
        return true
      } catch (fallbackError) {
        console.error('safeSwitchTab relaunch fallback failed:', url, fallbackError)
      }
    }
    return false
  }
}
