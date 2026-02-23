import {Button, Text, View} from '@tarojs/components'
import {safeSwitchTab} from '../../utils/safeNavigation'

export default function LoginPage() {
  return (
    <View className="app-page flex flex-col items-center justify-center p-6">
      <View className="ui-card-strong w-full max-w-md text-center fade-in-up">
        <View className="i-mdi-account-circle-outline text-6xl text-primary mb-4" />
        <Text className="block text-xl font-bold text-foreground mb-2">登录页面尚未接入</Text>
        <Text className="block text-sm text-muted-foreground mb-6">
          当前项目尚未启用完整登录流程，返回后可继续使用已开放页面。
        </Text>
        <Button className="ui-btn-primary w-full" onClick={() => void safeSwitchTab('/pages/history/index')}>
          返回会议列表
        </Button>
      </View>
    </View>
  )
}
