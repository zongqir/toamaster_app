/**
 * @file Taro application entry file
 */

import type {PropsWithChildren} from 'react'
import {useTabBarPageClass} from '@/hooks/useTabBarPageClass'

import './app.scss'

function App({children}: PropsWithChildren) {
  useTabBarPageClass()

  return children
}

export default App
