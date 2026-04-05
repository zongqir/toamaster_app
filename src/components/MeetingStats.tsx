import {Button, ScrollView, Text, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {type ReactNode, useEffect, useMemo, useState} from 'react'
import {VotingDatabaseService} from '../db/votingDatabase'
import type {ImpromptuSpeechRecord, MeetingItem} from '../types/meeting'
import type {VotingResult} from '../types/voting'
import {MIN_EFFECTIVE_STATS_DURATION_SECONDS, shouldCountItemInMeetingStats} from '../utils/meetingStats'
import {classifyTimingReport, type TimingReportCategory} from '../utils/timingReport'

interface MeetingStatsProps {
  items: MeetingItem[]
  impromptuRecords?: ImpromptuSpeechRecord[]
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
  showVotingSection?: boolean
}

interface TimelineReviewItem {
  itemId: string
  speaker: string
  title: string
  planned: number
  actual: number
  diff: number
  category: TimingReportCategory
}

interface OvertimeItem extends TimelineReviewItem {
  overtime: number
  severe: boolean
}

interface UndertimeItem extends TimelineReviewItem {
  undertime: number
}

export default function MeetingStats({
  items,
  impromptuRecords,
  metadata,
  meetingId,
  onCreateVoting,
  topContent,
  showVotingSection = true
}: MeetingStatsProps) {
  const [expandedSections, setExpandedSections] = useState({
    overall: true,
    impromptu: true,
    timeline: true,
    overtime: true,
    undertime: true,
    voting: true
  })
  const [votingResult, setVotingResult] = useState<VotingResult | null>(null)
  const [votingLoading, setVotingLoading] = useState(false)

  // 加载投票结果
  useEffect(() => {
    if (!showVotingSection) {
      setVotingResult(null)
      return
    }

    const loadVotingResult = async () => {
      // 优先使用 votingId，如果没有则尝试通过 meetingId 查找
      const hasVotingId = !!metadata?.votingId
      const hasMeetingId = !!meetingId

      if (!hasVotingId && !hasMeetingId) {
        return
      }

      setVotingLoading(true)
      try {
        let result: VotingResult | null = null

        if (hasVotingId && metadata?.votingId) {
          result = await VotingDatabaseService.getVotingResult(metadata.votingId)
        } else if (hasMeetingId && meetingId) {
          result = await VotingDatabaseService.getVotingResultByMeetingId(meetingId)
        }

        setVotingResult(result)
      } catch (error) {
        console.error('加载投票结果失败:', error)
      } finally {
        setVotingLoading(false)
      }
    }

    loadVotingResult()
  }, [meetingId, metadata, metadata?.votingId, showVotingSection])

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
    text += `严重超时：${severeOvertimeItems.length} 个\n`
    text += `准时环节：${ontimeItems.length} 个\n`
    text += `时间不足：${undertimeItems.length} 个\n`
    text += `未纳入统计条目：${items.filter((item) => !item.disabled).length - activeItems.length} 个（未计时或实际用时不超过 ${MIN_EFFECTIVE_STATS_DURATION_SECONDS} 秒）\n\n`
    text += '判定口径：\n'
    text += '- 准时：达到绿牌线后，到红牌结束时间内都算准时。\n'
    text += '- 时间不足：未达到绿牌线。\n'
    text += '- 超时：超过红牌结束时间；超过 30 秒计为严重超时。\n\n'
    text += `- 实际用时 ${MIN_EFFECTIVE_STATS_DURATION_SECONDS} 秒以内：视为未有效开始，不纳入统计。\n\n`

    if (impromptuSummary.totalCount > 0) {
      text += '━━━━━━━━━━━━━━━━━━━━\n'
      text += '🎤 即兴统计\n'
      text += '━━━━━━━━━━━━━━━━━━━━\n\n'
      text += `完成人数：${impromptuSummary.totalCount}\n`
      text += `演讲总时长：${formatDuration(impromptuSummary.totalDuration)}\n`
      text += `超时人数：${impromptuSummary.overtimeCount}\n`
      text += `低剩余开讲：${impromptuSummary.lowRemainingCount}\n\n`
    }

    if (timelineItems.length > 0) {
      text += '━━━━━━━━━━━━━━━━━━━━\n'
      text += '🕒 按时间顺序复盘\n'
      text += '━━━━━━━━━━━━━━━━━━━━\n\n'
      timelineItems.forEach((item, index) => {
        text += `${index + 1}. ${item.title}\n`
        text += `   👤 ${item.speaker}\n`
        text += `   计划：${formatDuration(item.planned)} | 实际：${formatDuration(item.actual)}\n`
        text += `   差额：${formatDiff(item.diff)} | 判定：${getCategoryLabel(item.category)}\n\n`
      })
    }

    if (sortedOvertimeItems.length > 0) {
      text += '━━━━━━━━━━━━━━━━━━━━\n'
      text += '⚠️ 超时最多\n'
      text += '━━━━━━━━━━━━━━━━━━━━\n\n'
      sortedOvertimeItems.forEach((item, index) => {
        text += `${index + 1}. ${item.title}\n`
        text += `   👤 ${item.speaker}\n`
        text += `   ⏱️  超时：${formatDuration(item.overtime)}\n\n`
      })
    }

    if (sortedUndertimeItems.length > 0) {
      text += '━━━━━━━━━━━━━━━━━━━━\n'
      text += '⏳ 时间不足最多\n'
      text += '━━━━━━━━━━━━━━━━━━━━\n\n'
      sortedUndertimeItems.forEach((item, index) => {
        text += `${index + 1}. ${item.title}\n`
        text += `   👤 ${item.speaker}\n`
        text += `   ⏱️  不足：${formatDuration(item.undertime)}\n\n`
      })
    }

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

  const activeItems = useMemo(() => items.filter(shouldCountItemInMeetingStats), [items])
  const completedImpromptuRecords = useMemo(
    () => (impromptuRecords || []).filter((record) => record.status === 'completed' && !record.deletedAt),
    [impromptuRecords]
  )
  const impromptuSummary = useMemo(() => {
    const totalCount = completedImpromptuRecords.length
    const totalDuration = completedImpromptuRecords.reduce(
      (sum, record) => sum + (record.speechDurationSeconds || 0),
      0
    )
    const overtimeCount = completedImpromptuRecords.filter((record) => record.isOvertime).length
    const lowRemainingCount = completedImpromptuRecords.filter((record) => record.startedWithLowRemaining).length

    return {
      totalCount,
      totalDuration,
      overtimeCount,
      lowRemainingCount
    }
  }, [completedImpromptuRecords])

  const {
    totalPlanned,
    totalActual,
    timelineItems,
    overtimeItems,
    severeOvertimeItems,
    ontimeItems,
    undertimeItems,
    sortedOvertimeItems,
    sortedUndertimeItems
  } = useMemo(() => {
    const timelineItemsAcc: TimelineReviewItem[] = []
    const overtimeItemsAcc: MeetingItem[] = []
    const severeOvertimeItemsAcc: MeetingItem[] = []
    const ontimeItemsAcc: MeetingItem[] = []
    const undertimeItemsAcc: MeetingItem[] = []
    const sortedOvertimeItemsAcc: OvertimeItem[] = []
    const sortedUndertimeItemsAcc: UndertimeItem[] = []

    let plannedSum = 0
    let actualSum = 0

    activeItems.forEach((item) => {
      const speaker = item.speaker || '未指定'
      const actual = item.actualDuration || 0
      const diff = actual - item.plannedDuration
      const category = classifyTimingReport(item.plannedDuration, actual)

      plannedSum += item.plannedDuration
      actualSum += actual

      timelineItemsAcc.push({
        itemId: item.id,
        title: item.title,
        speaker,
        planned: item.plannedDuration,
        actual,
        diff,
        category
      })

      if (category === 'severe_overtime') {
        severeOvertimeItemsAcc.push(item)
        overtimeItemsAcc.push(item)
        sortedOvertimeItemsAcc.push({
          itemId: item.id,
          title: item.title,
          speaker,
          planned: item.plannedDuration,
          actual,
          diff,
          category,
          overtime: diff,
          severe: true
        })
      } else if (category === 'overtime') {
        overtimeItemsAcc.push(item)
        sortedOvertimeItemsAcc.push({
          itemId: item.id,
          title: item.title,
          speaker,
          planned: item.plannedDuration,
          actual,
          diff,
          category,
          overtime: diff,
          severe: false
        })
      } else if (category === 'on_time') {
        ontimeItemsAcc.push(item)
      } else if (category === 'undertime') {
        undertimeItemsAcc.push(item)
        sortedUndertimeItemsAcc.push({
          itemId: item.id,
          title: item.title,
          speaker,
          planned: item.plannedDuration,
          actual,
          diff,
          category,
          undertime: Math.abs(diff)
        })
      }
    })

    sortedOvertimeItemsAcc.sort((a, b) => b.overtime - a.overtime || Number(b.severe) - Number(a.severe))
    sortedUndertimeItemsAcc.sort((a, b) => b.undertime - a.undertime)

    return {
      totalPlanned: plannedSum,
      totalActual: actualSum,
      timelineItems: timelineItemsAcc,
      overtimeItems: overtimeItemsAcc,
      severeOvertimeItems: severeOvertimeItemsAcc,
      ontimeItems: ontimeItemsAcc,
      undertimeItems: undertimeItemsAcc,
      sortedOvertimeItems: sortedOvertimeItemsAcc,
      sortedUndertimeItems: sortedUndertimeItemsAcc
    }
  }, [activeItems])

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
    if (diff < 0) return 'text-sky-300'
    return 'text-muted-foreground'
  }

  const getCategoryLabel = (category: TimingReportCategory) => {
    switch (category) {
      case 'severe_overtime':
        return '严重超时'
      case 'overtime':
        return '超时'
      case 'undertime':
        return '时间不足'
      case 'on_time':
        return '准时'
      default:
        return '未统计'
    }
  }

  const getCategoryChipClass = (category: TimingReportCategory) => {
    switch (category) {
      case 'severe_overtime':
        return 'bg-fuchsia-500/12 border-fuchsia-500/35 text-fuchsia-300'
      case 'overtime':
        return 'bg-red-500/12 border-red-500/35 text-red-400'
      case 'undertime':
        return 'bg-sky-500/12 border-sky-400/35 text-sky-300'
      case 'on_time':
        return 'bg-primary/15 border-primary/40 text-primary'
      default:
        return 'bg-secondary/30 border-border/40 text-foreground/70'
    }
  }

  const getCategoryTextClass = (category: TimingReportCategory) => {
    switch (category) {
      case 'severe_overtime':
        return 'text-fuchsia-300'
      case 'overtime':
        return 'text-red-400'
      case 'undertime':
        return 'text-sky-300'
      case 'on_time':
        return 'text-primary'
      default:
        return 'text-foreground/70'
    }
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

          {/* 1. 会议总览 - 可折叠 */}
          <View className="ui-card-sharp p-0 overflow-hidden border-primary/25">
            <View
              className="px-4 py-3.5 flex justify-between items-center active:bg-white/5"
              onClick={() => toggleSection('overall')}>
              <Text className="text-base font-bold text-foreground">📊 会议总览</Text>
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

                <View
                  className={`mt-4 pt-4 border-t border-border/30 grid ${isCompact ? 'grid-cols-2' : 'grid-cols-4'} gap-2`}>
                  <View className="text-center">
                    <Text className="text-2xl font-bold text-red-500 block">{overtimeItems.length}</Text>
                    <Text className="text-sm text-foreground/90">超时</Text>
                  </View>
                  <View className="text-center">
                    <Text className="text-2xl font-bold text-fuchsia-400 block">{severeOvertimeItems.length}</Text>
                    <Text className="text-sm text-foreground/90">严重超时</Text>
                  </View>
                  <View className="text-center">
                    <Text className="text-2xl font-bold text-primary block">{ontimeItems.length}</Text>
                    <Text className="text-sm text-foreground/90">准时</Text>
                  </View>
                  <View className="text-center">
                    <Text className="text-2xl font-bold text-sky-300 block">{undertimeItems.length}</Text>
                    <Text className="text-sm text-foreground/90">时间不足</Text>
                  </View>
                </View>
                <Text className="text-[11px] text-muted-foreground mt-3 block leading-5">
                  准时口径：达到绿牌线后，到红牌结束时间内都算准时。未达到绿牌线记为时间不足；未计时条目和实际用时不超过
                  {MIN_EFFECTIVE_STATS_DURATION_SECONDS}
                  秒的条目不纳入统计。
                </Text>
              </View>
            )}
          </View>

          {impromptuSummary.totalCount > 0 && (
            <View className="ui-card-sharp p-0 overflow-hidden border-amber-400/30">
              <View
                className="px-4 py-3.5 flex justify-between items-center active:bg-white/5"
                onClick={() => toggleSection('impromptu')}>
                <View className="flex items-center flex-wrap gap-2">
                  <Text className="text-base font-bold text-foreground">🎤 即兴统计</Text>
                  <View className="bg-amber-500/12 px-2 py-0.5 rounded-full">
                    <Text className="text-xs text-amber-200 font-bold">{impromptuSummary.totalCount} 人</Text>
                  </View>
                </View>
                <View
                  className={`i-mdi-chevron-${expandedSections.impromptu ? 'up' : 'down'} text-xl text-foreground`}
                />
              </View>

              {expandedSections.impromptu && (
                <View className="px-4 pb-4 space-y-3">
                  <View className={`grid ${isCompact ? 'grid-cols-2' : 'grid-cols-4'} gap-3`}>
                    <View className="ui-panel-sharp p-3">
                      <Text className="text-sm text-foreground/90 block mb-1">完成人数</Text>
                      <Text className="text-xl font-bold text-foreground">{impromptuSummary.totalCount}</Text>
                    </View>
                    <View className="ui-panel-sharp p-3">
                      <Text className="text-sm text-foreground/90 block mb-1">演讲总时长</Text>
                      <Text className="text-xl font-bold text-foreground">
                        {formatDuration(impromptuSummary.totalDuration)}
                      </Text>
                    </View>
                    <View className="ui-panel-sharp p-3">
                      <Text className="text-sm text-foreground/90 block mb-1">超时人数</Text>
                      <Text className="text-xl font-bold text-amber-200">{impromptuSummary.overtimeCount}</Text>
                    </View>
                    <View className="ui-panel-sharp p-3">
                      <Text className="text-sm text-foreground/90 block mb-1">低剩余开讲</Text>
                      <Text className="text-xl font-bold text-sky-300">{impromptuSummary.lowRemainingCount}</Text>
                    </View>
                  </View>

                  <View className="space-y-2">
                    {completedImpromptuRecords.map((record, index) => (
                      <View key={record.id} className="ui-panel-sharp p-3">
                        <View className="flex justify-between items-start gap-3">
                          <View className="min-w-0 flex-1">
                            <Text className="text-sm font-bold text-foreground block truncate">
                              {index + 1}. {record.speakerName}
                            </Text>
                            <Text className="text-xs text-muted-foreground block mt-1">
                              {record.startedWithLowRemaining ? '低剩余开讲' : '正常开讲'}
                            </Text>
                          </View>
                          <View className="text-right shrink-0">
                            <Text className="text-sm font-bold text-foreground block">
                              {formatDuration(record.speechDurationSeconds || 0)}
                            </Text>
                            <Text
                              className={`text-xs block mt-1 ${record.isOvertime ? 'text-amber-200' : 'text-primary'}`}>
                              {record.isOvertime ? '超时' : '准时'}
                            </Text>
                          </View>
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </View>
          )}

          {/* 2. 按时间顺序复盘 - 可折叠 */}
          {timelineItems.length > 0 && (
            <View className="ui-card-sharp p-0 overflow-hidden border-primary/25">
              <View
                className="px-4 py-3.5 flex justify-between items-center active:bg-white/5"
                onClick={() => toggleSection('timeline')}>
                <View className="flex items-center flex-wrap gap-2">
                  <Text className="text-base font-bold text-foreground">🕒 按时间顺序复盘</Text>
                  <View className="bg-primary/10 border border-primary/35 px-2 py-0.5 rounded-full">
                    <Text className="text-xs text-primary font-bold">{timelineItems.length} 项</Text>
                  </View>
                </View>
                <View
                  className={`i-mdi-chevron-${expandedSections.timeline ? 'up' : 'down'} text-xl text-foreground`}
                />
              </View>

              {expandedSections.timeline && (
                <View className="px-4 pb-4 space-y-2.5">
                  {timelineItems.map((item, index) => (
                    <View key={item.itemId} className="ui-panel-sharp p-3">
                      <View className="flex items-start justify-between gap-3">
                        <View className="min-w-0 flex-1">
                          <View className="flex items-center gap-2 flex-wrap">
                            <Text className="text-sm font-bold text-foreground truncate">
                              {index + 1}. {item.title}
                            </Text>
                            <View className={`rounded-full border px-2 py-0.5 ${getCategoryChipClass(item.category)}`}>
                              <Text className="text-[11px] font-semibold">{getCategoryLabel(item.category)}</Text>
                            </View>
                          </View>
                          <Text className="text-xs text-muted-foreground block mt-1">负责人：{item.speaker}</Text>
                        </View>
                        <Text className={`text-sm font-bold shrink-0 ${getDiffColor(item.diff)}`}>
                          {formatDiff(item.diff)}
                        </Text>
                      </View>
                      <View className={`grid ${isCompact ? 'grid-cols-2' : 'grid-cols-4'} gap-2 mt-3`}>
                        <View className="bg-background/50 p-2 rounded-lg">
                          <Text className="text-[11px] text-foreground/80 block">计划</Text>
                          <Text className="text-sm font-bold text-foreground">{formatDuration(item.planned)}</Text>
                        </View>
                        <View className="bg-background/50 p-2 rounded-lg">
                          <Text className="text-[11px] text-foreground/80 block">实际</Text>
                          <Text className="text-sm font-bold text-foreground">{formatDuration(item.actual)}</Text>
                        </View>
                        <View className="bg-background/50 p-2 rounded-lg">
                          <Text className="text-[11px] text-foreground/80 block">差额</Text>
                          <Text className={`text-sm font-bold ${getDiffColor(item.diff)}`}>{formatDiff(item.diff)}</Text>
                        </View>
                        <View className="bg-background/50 p-2 rounded-lg">
                          <Text className="text-[11px] text-foreground/80 block">判定</Text>
                          <Text className={`text-sm font-bold ${getCategoryTextClass(item.category)}`}>
                            {getCategoryLabel(item.category)}
                          </Text>
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* 3. 超时最多 - 可折叠 */}
          {sortedOvertimeItems.length > 0 && (
            <View className="ui-card-sharp p-0 overflow-hidden border-red-500/30">
              <View
                className="px-4 py-3.5 flex justify-between items-center active:bg-white/5"
                onClick={() => toggleSection('overtime')}>
                <View className="flex items-center flex-wrap gap-2">
                  <Text className="text-base font-bold text-foreground">⏱️ 超时最多</Text>
                  <View className="bg-red-500/10 px-2 py-0.5 rounded-full">
                    <Text className="text-xs text-red-500 font-bold">{sortedOvertimeItems.length} 项</Text>
                  </View>
                </View>
                <View
                  className={`i-mdi-chevron-${expandedSections.overtime ? 'up' : 'down'} text-xl text-foreground`}
                />
              </View>

              {expandedSections.overtime && (
                <View className="px-4 pb-4 space-y-3">
                  {sortedOvertimeItems.map((item, index) => (
                    <View key={item.itemId} className="ui-panel-sharp p-3 border-red-500/28 bg-red-500/8">
                      <View className="flex justify-between items-start gap-3">
                        <View className="min-w-0 flex-1">
                          <Text className="text-sm font-bold text-foreground block truncate">
                            {index + 1}. {item.title}
                          </Text>
                          <Text className="text-xs text-muted-foreground block mt-1">负责人：{item.speaker}</Text>
                        </View>
                        <Text className={`text-sm font-bold shrink-0 ${item.severe ? 'text-fuchsia-400' : 'text-red-500'}`}>
                          +{formatDuration(item.overtime)}
                        </Text>
                      </View>
                      <View className="flex items-center gap-2 mt-3 flex-wrap">
                        <View className="bg-background/40 px-2 py-1 rounded-lg">
                          <Text className="text-xs text-foreground/85">
                            计划 {formatDuration(item.planned)} / 实际 {formatDuration(item.actual)}
                          </Text>
                        </View>
                        {item.severe && (
                          <View className="bg-fuchsia-500/12 border border-fuchsia-500/35 px-2 py-1 rounded-lg">
                            <Text className="text-xs font-semibold text-fuchsia-300">严重超时</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* 4. 时间不足最多 - 可折叠 */}
          {sortedUndertimeItems.length > 0 && (
            <View className="ui-card-sharp p-0 overflow-hidden border-sky-400/30">
              <View
                className="px-4 py-3.5 flex justify-between items-center active:bg-white/5"
                onClick={() => toggleSection('undertime')}>
                <View className="flex items-center flex-wrap gap-2">
                  <Text className="text-base font-bold text-foreground">⏳ 时间不足最多</Text>
                  <View className="bg-sky-500/20 border border-sky-400/35 px-2 py-0.5 rounded-full">
                    <Text className="text-sm text-foreground font-bold">{sortedUndertimeItems.length} 项</Text>
                  </View>
                </View>
                <View
                  className={`i-mdi-chevron-${expandedSections.undertime ? 'up' : 'down'} text-xl text-foreground`}
                />
              </View>

              {expandedSections.undertime && (
                <View className="px-4 pb-4 space-y-3">
                  {sortedUndertimeItems.map((item, index) => (
                    <View key={item.itemId} className="ui-panel-sharp p-3 border-sky-400/28 bg-sky-400/8">
                      <View className="flex justify-between items-start gap-3">
                        <View className="min-w-0 flex-1">
                          <Text className="text-sm font-bold text-foreground block truncate">
                            {index + 1}. {item.title}
                          </Text>
                          <Text className="text-xs text-muted-foreground block mt-1">负责人：{item.speaker}</Text>
                        </View>
                        <Text className="text-sm font-bold text-sky-300 shrink-0">-{formatDuration(item.undertime)}</Text>
                      </View>
                      <View className="mt-3 bg-background/40 px-2 py-1 rounded-lg">
                        <Text className="text-xs text-foreground/85">
                          计划 {formatDuration(item.planned)} / 实际 {formatDuration(item.actual)}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {showVotingSection && (
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
          )}
        </View>
      </ScrollView>
    </View>
  )
}
