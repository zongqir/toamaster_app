import {Button, Text, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {useEffect, useMemo, useState} from 'react'
import MeetingStats from '../../components/MeetingStats'
import {useMeetingStore} from '../../store/meetingStore'

export default function TimerStatsPage() {
  const {currentSession} = useMeetingStore()
  const [now, setNow] = useState(() => Date.now())

  const hasLiveItem = useMemo(
    () => currentSession?.items.some((item) => item.actualStartTime && !item.actualEndTime) ?? false,
    [currentSession]
  )

  useEffect(() => {
    if (!hasLiveItem) return

    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => {
      clearInterval(timer)
    }
  }, [hasLiveItem])

  const snapshotItems = useMemo(() => {
    if (!currentSession) return []

    return currentSession.items.map((item) => {
      if (!item.actualStartTime || item.actualEndTime) {
        return item
      }

      const baseDuration = item.actualDuration || 0
      const liveDuration = baseDuration + Math.max(0, Math.floor((now - item.actualStartTime) / 1000))

      return {
        ...item,
        actualDuration: liveDuration
      }
    })
  }, [currentSession, now])

  const snapshotImpromptuRecords = useMemo(() => {
    if (!currentSession?.impromptuRecords) return []

    return currentSession.impromptuRecords.map((record) => {
      if (record.status !== 'speaking' || !record.speechStartedAt) {
        return record
      }

      const baseDuration = record.speechDurationSeconds || 0
      const liveDuration = baseDuration + Math.max(0, Math.floor((now - record.speechStartedAt) / 1000))

      return {
        ...record,
        speechDurationSeconds: liveDuration
      }
    })
  }, [currentSession?.impromptuRecords, now])

  if (!currentSession) {
    return (
      <View className="h-screen bg-gradient-page px-4 flex items-center justify-center">
        <View className="ui-card-strong w-full max-w-[420px] p-6">
          <Text className="text-xl font-bold text-foreground block text-center">暂无可查看的统计</Text>
          <Text className="text-sm text-muted-foreground block text-center mt-3 leading-6">
            当前没有进行中的会议。返回计时页后重新进入，这里会展示完整的实时统计。
          </Text>
          <Button className="ui-btn-secondary h-11 mt-5 text-sm font-semibold" onClick={() => Taro.navigateBack()}>
            返回
          </Button>
        </View>
      </View>
    )
  }

  return (
    <View className="h-screen bg-gradient-page flex flex-col">
      <View className="flex-1 min-h-0">
        <MeetingStats
          items={snapshotItems}
          impromptuRecords={snapshotImpromptuRecords}
          metadata={currentSession.metadata}
          meetingId={currentSession.id}
          topContent={
            <View className="space-y-2">
              <View className="ui-card border-primary/30">
                <Text className="text-sm font-medium text-foreground block text-center">
                  {hasLiveItem ? '会议进行中：这里展示完整实时统计' : '查看会议完整统计与超时分析'}
                </Text>
              </View>
              <View className="ui-muted-panel">
                <Text className="text-sm text-muted-foreground text-center">
                  返回后会回到计时页，当前会议进度会继续保留。
                </Text>
              </View>
            </View>
          }
        />
      </View>
    </View>
  )
}
