/**
 * @file Taro application entry file
 */

import type {PropsWithChildren} from 'react'
import {RouteGuard} from '@/components/RouteGuard'
import {AuthProvider} from '@/contexts/AuthContext'
import {useTabBarPageClass} from '@/hooks/useTabBarPageClass'

import './app.scss'

function App({children}: PropsWithChildren) {
  useTabBarPageClass()

  return (
    <AuthProvider>
      <RouteGuard>{children}</RouteGuard>
    </AuthProvider>
  )
}

export default App
