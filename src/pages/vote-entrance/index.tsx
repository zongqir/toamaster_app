import {Text, View} from '@tarojs/components'
import {useDidShow} from '@tarojs/taro'
import {useCallback, useRef, useState} from 'react'
import {VotingDatabaseService} from '../../db/votingDatabase'
import type {VotingSession} from '../../types/voting'
import {safeNavigateTo} from '../../utils/safeNavigation'

export default function VoteEntrancePage() {
  const [loading, setLoading] = useState(true)
  const [_activeVoting, setActiveVoting] = useState<VotingSession | null>(null)
  const hasAutoNavigated = useRef(false)

  const loadActiveVoting = useCallback(async () => {
    setLoading(true)
    const voting = await VotingDatabaseService.getActiveVoting()
    setLoading(false)
    setActiveVoting(voting)

    if (voting && !hasAutoNavigated.current) {
      hasAutoNavigated.current = true
      void safeNavigateTo(`/pages/vote/index?id=${voting.id}`)
    }
  }, [])

  useDidShow(() => {
    loadActiveVoting()
  })

  if (loading) {
    return (
      <View className="app-page flex flex-col items-center justify-center p-6">
        <View className="w-20 h-20 rounded-full flex items-center justify-center mb-4 bg-gradient-primary shadow-lg shadow-cyan-600/30">
          <View className="i-mdi-loading text-5xl text-white animate-spin" />
        </View>
        <Text className="text-muted-foreground">加载中...</Text>
      </View>
    )
  }

  return (
    <View className="app-page flex flex-col items-center justify-center p-6">
      <View className="w-full max-w-md fade-in-up">
        <View className="app-hero text-center">
          <View className="flex justify-center mb-5">
            <View className="w-20 h-20 rounded-full border border-cyan-300/30 bg-cyan-400/10 flex items-center justify-center">
              <View className="i-mdi-vote-outline text-5xl text-cyan-200" />
            </View>
          </View>

          <Text className="text-2xl font-bold text-foreground mb-2 block">暂无投票</Text>
          <Text className="text-sm text-muted-foreground mb-6 block">当前没有进行中的投票活动</Text>

          <View className="ui-card text-left mb-4">
            <View className="flex items-start gap-3 mb-4">
              <View className="i-mdi-information text-primary text-xl flex-shrink-0 mt-0.5" />
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground mb-1 block">如何参与投票</Text>
                <Text className="text-xs text-muted-foreground leading-relaxed">
                  投票由会议时间官创建。当有新的投票活动时，你可以在此页面直接进入投票。
                </Text>
              </View>
            </View>

            <View className="flex items-start gap-3">
              <View className="i-mdi-clock-outline text-accent text-xl flex-shrink-0 mt-0.5" />
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground mb-1 block">投票有效期</Text>
                <Text className="text-xs text-muted-foreground leading-relaxed">
                  每个投票活动有效期为 24 小时，过期后会自动关闭。
                </Text>
              </View>
            </View>
          </View>

          <View className="ui-btn-primary mt-2" onClick={loadActiveVoting}>
            <View className="i-mdi-refresh text-white text-lg mr-2" />
            <Text className="text-white font-semibold">刷新查看</Text>
          </View>
        </View>
      </View>
    </View>
  )
}
