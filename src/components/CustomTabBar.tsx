import {Text, View} from '@tarojs/components'
import {safeSwitchTab} from '../utils/safeNavigation'

interface CustomTabBarProps {
  current?: string // 当前激活的页面：'history' | 'vote' | 'settings'
}

export default function CustomTabBar({current = ''}: CustomTabBarProps) {
  const tabs = [
    {
      key: 'history',
      text: '会议列表',
      icon: 'i-mdi-history',
      path: '/pages/history/index'
    },
    {
      key: 'vote',
      text: '投票入口',
      icon: 'i-mdi-vote',
      path: '/pages/vote-entrance/index'
    },
    {
      key: 'settings',
      text: '设置',
      icon: 'i-mdi-cog',
      path: '/pages/settings/index'
    }
  ]

  const handleTabClick = (tab: (typeof tabs)[0]) => {
    // 使用 switchTab 跳转到 tabBar 页面
    void safeSwitchTab(tab.path)
  }

  return (
    <View className="fixed bottom-0 left-0 right-0 bg-slate-900 border-t border-slate-800 safe-area-bottom z-50">
      <View className="flex justify-around items-center min-h-14 py-1">
        {tabs.map((tab) => {
          const isActive = current === tab.key
          return (
            <View
              key={tab.key}
              className="flex-1 min-w-0 flex flex-col items-center justify-center py-1"
              onClick={() => handleTabClick(tab)}>
              <View className={`${tab.icon} text-2xl mb-0.5 ${isActive ? 'text-primary' : 'text-gray-400'}`} />
              <Text className={`text-xs max-w-full truncate px-1 ${isActive ? 'text-primary' : 'text-gray-400'}`}>
                {tab.text}
              </Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}
