import type {TabBarItem} from '@tarojs/taro'
import Taro from '@tarojs/taro'
import {useEffect, useState} from 'react'
import {useAuth} from '@/contexts/AuthContext'

// Public pages that don't require authentication
const PUBLIC_PAGE_PATHS = ['/pages/login/index']

const LOGIN_PAGE_PATH = '/pages/login/index'

// Storage key for saving redirect path after login
export const STORAGE_KEY_REDIRECT_PATH = 'loginRedirectPath'

function getTabBarPages(): string[] {
  const app = Taro.getApp()
  const tabBarList = app?.config?.tabBar?.list || []
  return tabBarList.map((item: TabBarItem) => `/${item.pagePath}`)
}

function isTabBarPage(path: string): boolean {
  const tabBarPages = getTabBarPages()
  return tabBarPages.some((tabBarPath) => path?.includes(tabBarPath))
}

function normalizePath(path: string): string {
  if (!path) return ''
  return path.startsWith('/') ? path : `/${path}`
}

function getCurrentPath(): string {
  const getPages = (
    globalThis as typeof globalThis & {
      getCurrentPages?: () => Array<{route?: string}>
    }
  ).getCurrentPages
  const pages = getPages?.() || []
  const currentPage = pages[pages.length - 1]
  return normalizePath(currentPage?.route || '')
}

// Throttled navigation to prevent duplicate redirects
let isNavigating = false
function navigateToLogin(currentPath: string): void {
  if (isNavigating) {
    return
  }

  isNavigating = true

  // Save current path for redirect after login
  Taro.setStorageSync(STORAGE_KEY_REDIRECT_PATH, currentPath)
  const navigateMethod = isTabBarPage(currentPath) ? Taro.navigateTo : Taro.redirectTo
  navigateMethod({url: LOGIN_PAGE_PATH})

  // Reset flag after 100ms
  setTimeout(() => {
    isNavigating = false
  }, 100)
}

/**
 * Route guard component that protects pages requiring authentication
 * Automatically redirects unauthenticated users to login page
 */
export function RouteGuard({children}: {children: React.ReactNode}) {
  const {user, loading} = useAuth()
  const [currentPath, setCurrentPath] = useState(() => getCurrentPath())

  useEffect(() => {
    const handleRouteChange = ({toLocation}: {toLocation?: {path?: string}} = {}) => {
      const nextPath = normalizePath(toLocation?.path || getCurrentPath())
      setCurrentPath((prevPath) => (prevPath === nextPath ? prevPath : nextPath))
    }

    Taro.eventCenter.on('__taroRouterChange', handleRouteChange)

    return () => {
      Taro.eventCenter.off('__taroRouterChange', handleRouteChange)
    }
  }, [])

  useEffect(() => {
    const path = normalizePath(currentPath || getCurrentPath())
    let redirectTimer: ReturnType<typeof setTimeout> | null = null

    if (loading) {
      return
    }

    const isPublic = PUBLIC_PAGE_PATHS.some((publicPath) => path.includes(publicPath))
    if (user || isPublic) {
      return
    }

    if (path && !path.includes(LOGIN_PAGE_PATH)) {
      redirectTimer = setTimeout(() => {
        navigateToLogin(path)
      }, 0)
    }

    return () => {
      if (redirectTimer) {
        clearTimeout(redirectTimer)
      }
    }
  }, [currentPath, loading, user])

  return <>{children}</>
}

/**
 * HOC to wrap a component with route guard
 * Usage: export default withRouteGuard(MyComponent)
 */
export function withRouteGuard<P extends object>(Component: React.ComponentType<P>) {
  return function GuardedComponent(props: P) {
    return (
      <RouteGuard>
        <Component {...props} />
      </RouteGuard>
    )
  }
}
