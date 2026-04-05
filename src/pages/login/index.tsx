import {Button, Text, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {useEffect, useState} from 'react'
import {STORAGE_KEY_REDIRECT_PATH} from '@/components/RouteGuard'
import {useAuth} from '@/contexts/AuthContext'
import {safeRedirectTo, safeSwitchTab} from '@/utils/safeNavigation'

function getTabPagePrefixes() {
  const app = Taro.getApp()
  const tabBarList = app?.config?.tabBar?.list || []
  return tabBarList.map((item: {pagePath: string}) => `/${item.pagePath}`)
}

function isTabPage(path: string): boolean {
  return getTabPagePrefixes().some((tabPath) => path.startsWith(tabPath))
}

async function redirectAfterLogin() {
  const redirectPath = Taro.getStorageSync<string>(STORAGE_KEY_REDIRECT_PATH)
  if (redirectPath) {
    Taro.removeStorageSync(STORAGE_KEY_REDIRECT_PATH)
  }

  const targetPath = redirectPath || '/pages/history/index'
  if (isTabPage(targetPath)) {
    await safeSwitchTab(targetPath)
    return
  }
  await safeRedirectTo(targetPath, {fallback: 'reLaunch'})
}

export default function LoginPage() {
  const {user, signInWithWechat, loading} = useAuth()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!loading && user) {
      void redirectAfterLogin()
    }
  }, [loading, user])

  const onWechatLogin = async () => {
    if (submitting) {
      return
    }
    setSubmitting(true)
    try {
      const {error} = await signInWithWechat()
      if (error) {
        console.error('[login] signInWithWechat failed', {
          name: error.name,
          message: error.message,
          stack: error.stack,
          raw: error
        })
        Taro.showToast({
          title: error.message || '微信登录失败',
          icon: 'none',
          duration: 2500
        })
        return
      }
      await redirectAfterLogin()
    } finally {
      setSubmitting(false)
    }
  }

  const isBusy = loading || submitting

  return (
    <View className="app-page flex flex-col items-center justify-center p-6">
      <View className="ui-card-strong w-full max-w-md text-center fade-in-up">
        <View className="i-mdi-account-circle-outline text-6xl text-primary mb-4" />
        <Text className="block text-xl font-bold text-foreground mb-2">微信登录</Text>
        <Text className="block text-sm text-muted-foreground mb-6">
          登录后会同步微信昵称和头像，用于议程修改与投票操作审计。
        </Text>
        <Button
          className="ui-btn-primary w-full"
          loading={isBusy}
          disabled={isBusy}
          onClick={() => void onWechatLogin()}>
          {isBusy ? '登录中...' : '微信一键登录'}
        </Button>
      </View>
    </View>
  )
}
