import type {TabBarItem} from '@tarojs/taro'
import Taro, {useDidShow} from '@tarojs/taro'
import {useCallback, useEffect, useState} from 'react'
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
  const [shouldRender, setShouldRender] = useState(false)

  const checkAuth = useCallback(() => {
    if (loading) {
      setShouldRender(false)
      return
    }

    const currentPath: string = Taro.getCurrentInstance()?.router?.path || ''

    // Allow access if user is authenticated or page is public
    const isPublic = PUBLIC_PAGE_PATHS.some((publicPath) => currentPath?.includes(publicPath))
    if (user || isPublic) {
      setShouldRender(true)
      return
    }
    if (currentPath && !currentPath?.includes(LOGIN_PAGE_PATH)) {
      navigateToLogin(currentPath)
      setShouldRender(false)
      return
    }
    setShouldRender(false)
  }, [user, loading])

  // Check auth when page is shown (handles tab switching)
  useDidShow(() => {
    checkAuth()
  })

  // Check auth when component mounts or auth state changes
  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  if (!shouldRender) {
    return null
  }

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
