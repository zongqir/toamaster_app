import {Button, ScrollView, Text, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {type ReactNode, useEffect, useState} from 'react'
import {VotingDatabaseService} from '../db/votingDatabase'
import type {MeetingItem} from '../types/meeting'
import type {VotingResult} from '../types/voting'

interface MeetingStatsProps {
  items: MeetingItem[]
  metadata?: {
    theme?: string
    date?: string
    startTime?: string
    location?: string
    votingId?: string
  }
  meetingId?: string // 会议ID，用于查找关联的投票
  onCreateVoting?: () => void // 创建投票的回调
  topContent?: ReactNode
}

interface SpeakerStats {
  speaker: string
  totalPlanned: number
  totalActual: number
  itemCount: number
  overtimeCount: number
  ontimeCount: number
  undertimeCount: number
  items: Array<{
    title: string
    planned: number
    actual: number
    diff: number
  }>
}

interface OvertimeItem {
  speaker: string
  title: string
  overtime: number
}

interface UndertimeItem {
  speaker: string
  title: string
  undertime: number
}

export default function MeetingStats({items, metadata, meetingId, onCreateVoting, topContent}: MeetingStatsProps) {
  const [expandedSections, setExpandedSections] = useState({
    overall: true,
    overtime: true,
    undertime: true,
    speaker: true,
    voting: true
  })
  const [votingResult, setVotingResult] = useState<VotingResult | null>(null)
  const [votingLoading, setVotingLoading] = useState(false)

  // 加载投票结果
  useEffect(() => {
    const loadVotingResult = async () => {
      console.log('MeetingStats - metadata:', metadata)
      console.log('MeetingStats - votingId:', metadata?.votingId)
      console.log('MeetingStats - meetingId:', meetingId)

      // 优先使用 votingId，如果没有则尝试通过 meetingId 查找
      const hasVotingId = !!metadata?.votingId
      const hasMeetingId = !!meetingId

      if (!hasVotingId && !hasMeetingId) {
        console.log('MeetingStats - 没有 votingId 也没有 meetingId，不加载投票结果')
        return
      }

      console.log('MeetingStats - 开始加载投票结果')
      setVotingLoading(true)
      try {
        let result: VotingResult | null = null

        if (hasVotingId && metadata?.votingId) {
          console.log('MeetingStats - 使用 votingId 加载:', metadata.votingId)
          result = await VotingDatabaseService.getVotingResult(metadata.votingId)
        } else if (hasMeetingId && meetingId) {
          console.log('MeetingStats - 使用 meetingId 加载:', meetingId)
          result = await VotingDatabaseService.getVotingResultByMeetingId(meetingId)
        }

        console.log('MeetingStats - 投票结果加载成功:', result)
        setVotingResult(result)
      } catch (error) {
        console.error('加载投票结果失败:', error)
      } finally {
        setVotingLoading(false)
      }
    }

    loadVotingResult()
  }, [metadata?.votingId, meetingId, metadata])

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({...prev, [section]: !prev[section]}))
  }

  // 创建投票
  const handleCreateVoting = () => {
    if (onCreateVoting) {
      onCreateVoting()
    }
  }

  // 导出报表函数
  const handleExportReport = () => {
    const formatDuration = (seconds: number) => {
      const mins = Math.floor(seconds / 60)
      const secs = seconds % 60
      return `${mins}:${secs.toString().padStart(2, '0')}`
    }

    const formatDiff = (diff: number) => {
      const sign = diff > 0 ? '+' : ''
      return `${sign}${formatDuration(Math.abs(diff))}`
    }

    let text = '━━━━━━━━━━━━━━━━━━━━\n'
    text += '📊 会议复盘统计报表\n'
    text += '━━━━━━━━━━━━━━━━━━━━\n\n'

    // 会议基本信息
    if (metadata?.theme) text += `📌 主题：${metadata.theme}\n`
    if (metadata?.date) text += `📅 日期：${metadata.date}\n`
    if (metadata?.startTime) text += `⏰ 开始时间：${metadata.startTime}\n`
    if (metadata?.location) text += `📍 地点：${metadata.location}\n`
    text += '\n'

    // 整体统计
    text += '━━━━━━━━━━━━━━━━━━━━\n'
    text += '📈 整体统计\n'
    text += '━━━━━━━━━━━━━━━━━━━━\n\n'
    text += `总环节数：${activeItems.length}\n`
    text += `计划总时长：${formatDuration(totalPlanned)}\n`
    text += `实际总时长：${formatDuration(totalActual)}\n`
    text += `时间差异：${formatDiff(totalActual - totalPlanned)}\n`
    text += `超时环节：${overtimeItems.length} 个\n`
    text += `准时环节：${ontimeItems.length} 个\n`
    text += `提前环节：${undertimeItems.length} 个\n\n`

    // 超时统计
    const overtimeItemsList: OvertimeItem[] = []
    overtimeBySpeaker.forEach((items) => {
      overtimeItemsList.push(...items)
    })

    if (overtimeItemsList.length > 0) {
      text += '━━━━━━━━━━━━━━━━━━━━\n'
      text += '⚠️ 超时统计\n'
      text += '━━━━━━━━━━━━━━━━━━━━\n\n'
      overtimeItemsList.forEach((item, index) => {
        text += `${index + 1}. ${item.title}\n`
        text += `   👤 ${item.speaker}\n`
        text += `   ⏱️  超时：${formatDuration(item.overtime)}\n\n`
      })
    }

    // 提前统计
    const undertimeItemsList: UndertimeItem[] = []
    undertimeBySpeaker.forEach((items) => {
      undertimeItemsList.push(...items)
    })

    if (undertimeItemsList.length > 0) {
      text += '━━━━━━━━━━━━━━━━━━━━\n'
      text += '✅ 提前统计\n'
      text += '━━━━━━━━━━━━━━━━━━━━\n\n'
      undertimeItemsList.forEach((item, index) => {
        text += `${index + 1}. ${item.title}\n`
        text += `   👤 ${item.speaker}\n`
        text += `   ⏱️  提前：${formatDuration(item.undertime)}\n\n`
      })
    }

    // 按负责人统计
    text += '━━━━━━━━━━━━━━━━━━━━\n'
    text += '👥 按负责人统计\n'
    text += '━━━━━━━━━━━━━━━━━━━━\n\n'
    speakerStats.forEach((stats, index) => {
      text += `${index + 1}. ${stats.speaker}\n`
      text += `   环节数：${stats.itemCount}\n`
      text += `   计划时长：${formatDuration(stats.totalPlanned)}\n`
      text += `   实际时长：${formatDuration(stats.totalActual)}\n`
      text += `   时间差异：${formatDiff(stats.totalActual - stats.totalPlanned)}\n`
      text += `   超时：${stats.overtimeCount} | 准时：${stats.ontimeCount} | 提前：${stats.undertimeCount}\n\n`
    })

    text += '━━━━━━━━━━━━━━━━━━━━\n'
    text += '© 启航AACTP 时间官'

    // 复制到剪贴板
    Taro.setClipboardData({
      data: text,
      success: () => {
        Taro.showToast({
          title: '报表已复制到剪贴板',
          icon: 'success',
          duration: 2000
        })
      }
    })
  }

  const activeItems = items.filter((i) => !i.disabled && i.actualDuration !== undefined)

  // 计算整体统计
  const totalPlanned = activeItems.reduce((sum, i) => sum + i.plannedDuration, 0)
  const totalActual = activeItems.reduce((sum, i) => sum + (i.actualDuration || 0), 0)
  const overtimeItems = activeItems.filter((i) => (i.actualDuration || 0) > i.plannedDuration)
  const ontimeItems = activeItems.filter((i) => (i.actualDuration || 0) === i.plannedDuration)
  const undertimeItems = activeItems.filter((i) => (i.actualDuration || 0) < i.plannedDuration)

  // 按负责人分组统计
  const speakerStatsMap = new Map<string, SpeakerStats>()
  activeItems.forEach((item) => {
    const speaker = item.speaker || '未指定'
    if (!speakerStatsMap.has(speaker)) {
      speakerStatsMap.set(speaker, {
        speaker,
        totalPlanned: 0,
        totalActual: 0,
        itemCount: 0,
        overtimeCount: 0,
        ontimeCount: 0,
        undertimeCount: 0,
        items: []
      })
    }
    const stats = speakerStatsMap.get(speaker)!
    const actual = item.actualDuration || 0
    const diff = actual - item.plannedDuration

    stats.totalPlanned += item.plannedDuration
    stats.totalActual += actual
    stats.itemCount += 1
    if (diff > 0) stats.overtimeCount += 1
    else if (diff === 0) stats.ontimeCount += 1
    else stats.undertimeCount += 1

    stats.items.push({
      title: item.title,
      planned: item.plannedDuration,
      actual,
      diff
    })
  })

  const speakerStats = Array.from(speakerStatsMap.values())

  // 超时统计：按负责人分组
  const overtimeBySpeaker = new Map<string, OvertimeItem[]>()
  activeItems.forEach((item) => {
    const actual = item.actualDuration || 0
    const diff = actual - item.plannedDuration
    if (diff > 0) {
      const speaker = item.speaker || '未指定'
      if (!overtimeBySpeaker.has(speaker)) {
        overtimeBySpeaker.set(speaker, [])
      }
      overtimeBySpeaker.get(speaker)?.push({
        speaker,
        title: item.title,
        overtime: diff
      })
    }
  })

  // 提前统计：按负责人分组
  const undertimeBySpeaker = new Map<string, UndertimeItem[]>()
  activeItems.forEach((item) => {
    const actual = item.actualDuration || 0
    const diff = item.plannedDuration - actual
    if (diff > 0) {
      const speaker = item.speaker || '未指定'
      if (!undertimeBySpeaker.has(speaker)) {
        undertimeBySpeaker.set(speaker, [])
      }
      undertimeBySpeaker.get(speaker)?.push({
        speaker,
        title: item.title,
        undertime: diff
      })
    }
  })

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const formatDiff = (diff: number) => {
    const sign = diff > 0 ? '+' : ''
    return `${sign}${formatDuration(Math.abs(diff))}`
  }

  const getDiffColor = (diff: number) => {
    if (diff > 0) return 'text-red-500'
    if (diff < 0) return 'text-green-500'
    return 'text-muted-foreground'
  }

  const isCompact = (() => {
    try {
      return (Taro.getSystemInfoSync().windowWidth || 375) < 380
    } catch {
      return false
    }
  })()

  return (
    <View className="flex-1 flex flex-col">
      <ScrollView className="flex-1 min-h-0 pt-3" scrollY>
        <View className="space-y-3 pl-4 pr-5 pb-24 max-w-full overflow-x-hidden">
          {topContent}

          <Button className="ui-btn-primary h-12 font-semibold border-none" onClick={handleExportReport}>
            <View className="i-mdi-file-export text-base mr-2" />
            导出统计报表
          </Button>

          {/* 1. 整体统计卡片 - 可折叠 */}
          <View className="ui-card-sharp p-0 overflow-hidden border-primary/25">
            <View
              className="px-4 py-3.5 flex justify-between items-center active:bg-white/5"
              onClick={() => toggleSection('overall')}>
              <Text className="text-base font-bold text-foreground">📊 整体统计</Text>
              <View className={`i-mdi-chevron-${expandedSections.overall ? 'up' : 'down'} text-xl text-foreground`} />
            </View>

            {expandedSections.overall && (
              <View className="px-4 pb-4">
                <View className={`grid ${isCompact ? 'grid-cols-1' : 'grid-cols-2'} gap-3`}>
                  <View className="ui-panel-sharp p-3">
                    <Text className="text-sm text-foreground/90 block mb-1">计划时长</Text>
                    <Text className="text-xl font-bold text-foreground">{formatDuration(totalPlanned)}</Text>
                  </View>
                  <View className="ui-panel-sharp p-3">
                    <Text className="text-sm text-foreground/90 block mb-1">实际时长</Text>
                    <Text className="text-xl font-bold text-foreground">{formatDuration(totalActual)}</Text>
                  </View>
                  <View className="ui-panel-sharp p-3">
                    <Text className="text-sm text-foreground/90 block mb-1">总环节数</Text>
                    <Text className="text-xl font-bold text-foreground">{activeItems.length}</Text>
                  </View>
                  <View className="ui-panel-sharp p-3">
                    <Text className="text-sm text-foreground/90 block mb-1">时间差异</Text>
                    <Text className={`text-xl font-bold ${getDiffColor(totalActual - totalPlanned)}`}>
                      {formatDiff(totalActual - totalPlanned)}
                    </Text>
                  </View>
                </View>

                <View className="mt-4 pt-4 border-t border-border/30 flex justify-around">
                  <View className="text-center">
                    <Text className="text-2xl font-bold text-red-500 block">{overtimeItems.length}</Text>
                    <Text className="text-sm text-foreground/90">超时</Text>
                  </View>
                  <View className="text-center">
                    <Text className="text-2xl font-bold text-primary block">{ontimeItems.length}</Text>
                    <Text className="text-sm text-foreground/90">准时</Text>
                  </View>
                  <View className="text-center">
                    <Text className="text-2xl font-bold text-green-500 block">{undertimeItems.length}</Text>
                    <Text className="text-sm text-foreground/90">提前</Text>
                  </View>
                </View>
              </View>
            )}
          </View>

          {/* 2. 超时统计 - 可折叠 */}
          {overtimeBySpeaker.size > 0 && (
            <View className="ui-card-sharp p-0 overflow-hidden border-red-500/30">
              <View
                className="px-4 py-3.5 flex justify-between items-center active:bg-white/5"
                onClick={() => toggleSection('overtime')}>
                <View className="flex items-center flex-wrap gap-2">
                  <Text className="text-base font-bold text-foreground">⏱️ 超时统计</Text>
                  <View className="bg-red-500/10 px-2 py-0.5 rounded-full">
                    <Text className="text-xs text-red-500 font-bold">{overtimeBySpeaker.size} 人</Text>
                  </View>
                </View>
                <View
                  className={`i-mdi-chevron-${expandedSections.overtime ? 'up' : 'down'} text-xl text-foreground`}
                />
              </View>

              {expandedSections.overtime && (
                <View className="px-4 pb-4 space-y-3">
                  {Array.from(overtimeBySpeaker.entries()).map(([speaker, items]) => {
                    const totalOvertime = items.reduce((sum, item) => sum + item.overtime, 0)
                    return (
                      <View key={speaker} className="ui-panel-sharp p-3 border-red-500/28 bg-red-500/8">
                        <View className="flex justify-between items-center mb-2">
                          <Text className="text-sm font-bold text-foreground">{speaker}</Text>
                          <View className="bg-red-500/20 px-3 py-1 rounded-lg">
                            <Text className="text-sm font-bold text-red-500">超时 {formatDuration(totalOvertime)}</Text>
                          </View>
                        </View>
                        <View className="space-y-1.5">
                          {items.map((item, idx) => (
                            <View key={idx} className="flex justify-between items-center pl-2">
                              <Text className="text-sm text-foreground/88 flex-1 truncate">• {item.title}</Text>
                              <Text className="text-sm font-bold text-red-500">+{formatDuration(item.overtime)}</Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    )
                  })}
                </View>
              )}
            </View>
          )}

          {/* 3. 提前统计 - 可折叠 */}
          {undertimeBySpeaker.size > 0 && (
            <View className="ui-card-sharp p-0 overflow-hidden border-green-500/30">
              <View
                className="px-4 py-3.5 flex justify-between items-center active:bg-white/5"
                onClick={() => toggleSection('undertime')}>
                <View className="flex items-center flex-wrap gap-2">
                  <Text className="text-base font-bold text-foreground">⚡ 提前统计</Text>
                  <View className="bg-green-600/30 border border-green-500/35 px-2 py-0.5 rounded-full">
                    <Text className="text-sm text-foreground font-bold">{undertimeBySpeaker.size} 人</Text>
                  </View>
                </View>
                <View
                  className={`i-mdi-chevron-${expandedSections.undertime ? 'up' : 'down'} text-xl text-foreground`}
                />
              </View>

              {expandedSections.undertime && (
                <View className="px-4 pb-4 space-y-3">
                  {Array.from(undertimeBySpeaker.entries()).map(([speaker, items]) => {
                    const totalUndertime = items.reduce((sum, item) => sum + item.undertime, 0)
                    return (
                      <View key={speaker} className="ui-panel-sharp p-3 border-green-500/28 bg-green-500/8">
                        <View className="flex justify-between items-center mb-2">
                          <Text className="text-sm font-bold text-foreground">{speaker}</Text>
                          <View className="bg-green-600/30 border border-green-500/35 px-3 py-1 rounded-lg">
                            <Text className="text-sm font-bold text-foreground">
                              提前 {formatDuration(totalUndertime)}
                            </Text>
                          </View>
                        </View>
                        <View className="space-y-1.5">
                          {items.map((item, idx) => (
                            <View key={idx} className="flex justify-between items-center pl-2">
                              <Text className="text-sm text-foreground/88 flex-1 truncate">• {item.title}</Text>
                              <Text className="text-sm font-bold text-green-500">
                                -{formatDuration(item.undertime)}
                              </Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    )
                  })}
                </View>
              )}
            </View>
          )}

          {/* 4. 按负责人统计 - 可折叠 */}
          <View className="ui-card-sharp p-0 overflow-hidden">
            <View
              className="px-4 py-3.5 flex justify-between items-center active:bg-white/5"
              onClick={() => toggleSection('speaker')}>
              <View className="flex items-center flex-wrap gap-2">
                <Text className="text-base font-bold text-foreground">👥 按负责人统计</Text>
                <View className="bg-primary/10 border-2 border-primary/50 px-2 py-0.5 rounded-full">
                  <Text className="text-sm text-foreground font-bold">{speakerStats.length} 人</Text>
                </View>
              </View>
              <View className={`i-mdi-chevron-${expandedSections.speaker ? 'up' : 'down'} text-xl text-foreground`} />
            </View>

            {expandedSections.speaker && (
              <View className="px-4 pb-4 space-y-3">
                {speakerStats.map((stats) => (
                  <View key={stats.speaker} className="ui-panel-sharp p-4">
                    <View className="flex justify-between items-center mb-3">
                      <Text className="text-sm font-bold text-foreground">{stats.speaker}</Text>
                      <View className="flex items-center flex-wrap gap-2">
                        <View className="bg-background px-2 py-1 rounded-lg">
                          <Text className="text-sm text-foreground/88">{stats.itemCount} 个环节</Text>
                        </View>
                      </View>
                    </View>

                    <View className={`grid ${isCompact ? 'grid-cols-1' : 'grid-cols-3'} gap-2 mb-3`}>
                      <View className="bg-background/50 p-2 rounded-lg text-center">
                        <Text className="text-sm text-foreground/90 block">计划</Text>
                        <Text className="text-sm font-bold text-foreground">{formatDuration(stats.totalPlanned)}</Text>
                      </View>
                      <View className="bg-background/50 p-2 rounded-lg text-center">
                        <Text className="text-sm text-foreground/90 block">实际</Text>
                        <Text className="text-sm font-bold text-foreground">{formatDuration(stats.totalActual)}</Text>
                      </View>
                      <View className="bg-background/50 p-2 rounded-lg text-center">
                        <Text className="text-sm text-foreground/90 block">差异</Text>
                        <Text className={`text-sm font-bold ${getDiffColor(stats.totalActual - stats.totalPlanned)}`}>
                          {formatDiff(stats.totalActual - stats.totalPlanned)}
                        </Text>
                      </View>
                    </View>

                    <View className={`grid ${isCompact ? 'grid-cols-1' : 'grid-cols-3'} gap-2 mb-3`}>
                      <View
                        className={`rounded-full border px-2 py-1 text-center ${
                          stats.overtimeCount > 0
                            ? 'bg-red-500/12 border-red-500/35'
                            : 'bg-secondary/30 border-border/40'
                        }`}>
                        <Text
                          className={`text-xs font-semibold ${stats.overtimeCount > 0 ? 'text-red-400' : 'text-foreground/70'}`}>
                          超时 {stats.overtimeCount}
                        </Text>
                      </View>
                      <View
                        className={`rounded-full border px-2 py-1 text-center ${
                          stats.ontimeCount > 0 ? 'bg-primary border-primary/65' : 'bg-secondary/30 border-border/40'
                        }`}>
                        <Text
                          className={`text-xs font-semibold ${stats.ontimeCount > 0 ? 'text-white' : 'text-foreground/70'}`}>
                          准时 {stats.ontimeCount}
                        </Text>
                      </View>
                      <View
                        className={`rounded-full border px-2 py-1 text-center ${
                          stats.undertimeCount > 0
                            ? 'bg-green-500/12 border-green-500/35'
                            : 'bg-secondary/30 border-border/40'
                        }`}>
                        <Text
                          className={`text-xs font-semibold ${stats.undertimeCount > 0 ? 'text-green-400' : 'text-foreground/70'}`}>
                          提前 {stats.undertimeCount}
                        </Text>
                      </View>
                    </View>

                    {/* 详细环节列表 */}
                    <View className="pt-3 border-t border-border/30 space-y-2">
                      {stats.items.map((item, idx) => (
                        <View key={idx} className="flex justify-between items-center">
                          <Text className="text-sm text-foreground/88 flex-1 truncate">{item.title}</Text>
                          <View className="flex items-center gap-2">
                            <Text className="text-sm text-foreground/82">{formatDuration(item.actual)}</Text>
                            <Text className={`text-xs font-bold ${getDiffColor(item.diff)} min-w-[50px] text-right`}>
                              {formatDiff(item.diff)}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* 5. 投票结果卡片 */}
          <View className="ui-card-sharp p-0 overflow-hidden border-primary/25">
            <View
              className="px-4 py-3.5 flex justify-between items-center active:bg-white/5"
              onClick={() => toggleSection('voting')}>
              <Text className="text-base font-bold text-foreground">🗳️ 投票结果</Text>
              <View className={`i-mdi-chevron-${expandedSections.voting ? 'up' : 'down'} text-xl text-foreground`} />
            </View>

            {expandedSections.voting && (
              <View className="px-4 pb-4">
                {votingLoading ? (
                  <View className="py-8 flex items-center justify-center">
                    <Text className="text-sm text-muted-foreground">加载中...</Text>
                  </View>
                ) : !votingResult ? (
                  <View className="py-8 flex flex-col items-center justify-center">
                    <View className="i-mdi-vote-outline text-5xl text-muted-foreground mb-3" />
                    <Text className="text-sm text-muted-foreground mb-4">暂无投票</Text>
                    <Button className="ui-btn-primary px-6 break-keep" onClick={handleCreateVoting}>
                      创建投票
                    </Button>
                  </View>
                ) : (
                  <View className="space-y-4">
                    {/* 投票统计信息 */}
                    <View className="flex flex-wrap gap-2 mb-2">
                      <View className="flex-1 bg-primary/20 p-2 rounded-lg border border-primary/30">
                        <Text className="text-sm text-foreground/90 block mb-0.5">总投票人数</Text>
                        <Text className="text-lg font-bold text-foreground">{votingResult.totalVoters}</Text>
                      </View>
                      <View className="flex-1 bg-green-600/30 p-2 rounded-lg border border-green-500/30">
                        <Text className="text-sm text-foreground/90 block mb-0.5">分组数</Text>
                        <Text className="text-lg font-bold text-foreground">{votingResult.groups.length}</Text>
                      </View>
                    </View>

                    {/* 各分组投票结果 */}
                    {votingResult.groups.map((groupResult) => (
                      <View key={groupResult.group.id} className="bg-background/50 p-3 rounded-xl">
                        <Text className="text-sm font-bold text-foreground mb-2">{groupResult.group.groupName}</Text>
                        <View className="space-y-2">
                          {groupResult.candidates.slice(0, 3).map((candidateResult, index) => {
                            const rank = index + 1
                            const isTop3 = rank <= 3
                            const maxVotes = groupResult.candidates[0]?.voteCount || 1
                            const percentage = Math.round((candidateResult.voteCount / maxVotes) * 100)

                            return (
                              <View key={candidateResult.candidate.id} className="space-y-1">
                                <View className="flex justify-between items-center gap-2">
                                  <View className="flex items-center gap-2 flex-1 min-w-0">
                                    <Text
                                      className={`text-sm font-bold min-w-[24px] text-center ${
                                        rank === 1
                                          ? 'text-amber-500'
                                          : rank === 2
                                            ? 'text-gray-400'
                                            : rank === 3
                                              ? 'text-orange-600'
                                              : 'text-muted-foreground'
                                      }`}>
                                      {rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`}
                                    </Text>
                                    <Text className={`text-sm ${isTop3 ? 'font-medium' : ''} text-foreground truncate`}>
                                      {candidateResult.candidate.name}
                                    </Text>
                                  </View>
                                  <Text className={`text-sm font-bold ${isTop3 ? 'text-cyan-300' : 'text-foreground'}`}>
                                    {candidateResult.voteCount} 票
                                  </Text>
                                </View>

                                {/* 进度条 */}
                                <View className="w-full h-1 bg-secondary/30 rounded-full overflow-hidden">
                                  <View
                                    className={`h-full rounded-full ${
                                      rank === 1
                                        ? 'bg-amber-500'
                                        : rank === 2
                                          ? 'bg-gray-400'
                                          : rank === 3
                                            ? 'bg-orange-600'
                                            : 'bg-primary'
                                    }`}
                                    style={{width: `${percentage}%`}}
                                  />
                                </View>
                              </View>
                            )
                          })}
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  )
}
