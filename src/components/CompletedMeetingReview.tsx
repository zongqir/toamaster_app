import {Button, ScrollView, Text, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {AgendaV2DatabaseService} from '../db/agendaV2Database'
import type {AhCounterRecordV2, GrammarianNoteV2, MeetingParticipantV2, WordOfDayHitV2} from '../types/agendaV2'
import type {MeetingMetadata, MeetingSession} from '../types/meeting'
import {MIN_EFFECTIVE_STATS_DURATION_SECONDS, shouldCountItemInMeetingStats} from '../utils/meetingStats'
import {classifyTimingReport, type TimingReportCategory} from '../utils/timingReport'
import MeetingStats from './MeetingStats'

type ReviewTab = 'info' | 'timing' | 'agenda' | 'officers'

type CompletedMeetingReviewProps = {
  session: MeetingSession
  metadata: MeetingMetadata
  onOpenMeetingLink: () => void
  onOpenVoteResult: () => void
}

type AgendaReviewRow = {
  id: string
  title: string
  speaker: string
  planned: number
  actual: number | null
  diff: number | null
  category: TimingReportCategory | 'not_started'
  disabled: boolean
}

type OfficerParticipantSummary = {
  participantKey: string
  participantName: string
  grammarNoteCount: number
  grammarIssueCount: number
  wordOfDayHits: number
  fillerTotal: number
  fillerBreakdown: Array<{word: string; count: number}>
}

function formatDuration(sec: number) {
  const normalized = Math.max(0, sec)
  const minutes = Math.floor(normalized / 60)
  const seconds = normalized % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function formatDiff(diff: number) {
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : ''
  return `${sign}${formatDuration(Math.abs(diff))}`
}

function getCategoryLabel(category: TimingReportCategory | 'not_started') {
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
      return '未记录'
  }
}

function getCategoryTextClass(category: TimingReportCategory | 'not_started') {
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
      return 'text-muted-foreground'
  }
}

function buildAgendaReviewRows(session: MeetingSession): AgendaReviewRow[] {
  return session.items.map((item) => {
    const actual = typeof item.actualDuration === 'number' ? item.actualDuration : null
    const diff = actual === null ? null : actual - item.plannedDuration

    return {
      id: item.id,
      title: item.title,
      speaker: item.speaker || '未指定',
      planned: item.plannedDuration,
      actual,
      diff,
      category: actual === null ? 'not_started' : classifyTimingReport(item.plannedDuration, actual),
      disabled: Boolean(item.disabled)
    }
  })
}

function buildTimingReportText(session: MeetingSession) {
  const activeItems = session.items.filter(shouldCountItemInMeetingStats)
  const timelineRows = activeItems.map((item) => {
    const actual = item.actualDuration || 0
    const diff = actual - item.plannedDuration
    return {
      title: item.title,
      speaker: item.speaker || '未指定',
      planned: item.plannedDuration,
      actual,
      diff,
      category: classifyTimingReport(item.plannedDuration, actual)
    }
  })

  const totalPlanned = timelineRows.reduce((sum, row) => sum + row.planned, 0)
  const totalActual = timelineRows.reduce((sum, row) => sum + row.actual, 0)
  const overtimeRows = timelineRows.filter((row) => row.category === 'overtime' || row.category === 'severe_overtime')
  const undertimeRows = timelineRows.filter((row) => row.category === 'undertime')
  const severeOvertimeRows = timelineRows.filter((row) => row.category === 'severe_overtime')
  const ontimeRows = timelineRows.filter((row) => row.category === 'on_time')

  const lines = [
    '【时间复盘】',
    `总环节数：${activeItems.length}`,
    `计划总时长：${formatDuration(totalPlanned)}`,
    `实际总时长：${formatDuration(totalActual)}`,
    `总差额：${formatDiff(totalActual - totalPlanned)}`,
    `超时环节：${overtimeRows.length}`,
    `严重超时：${severeOvertimeRows.length}`,
    `准时环节：${ontimeRows.length}`,
    `时间不足：${undertimeRows.length}`,
    `未纳入统计：${session.items.filter((item) => !item.disabled).length - activeItems.length}（实际用时不超过 ${MIN_EFFECTIVE_STATS_DURATION_SECONDS} 秒）`,
    '',
    '按时间顺序：'
  ]

  timelineRows.forEach((row, index) => {
    lines.push(
      `${index + 1}. ${row.title}｜${row.speaker}`,
      `计划 ${formatDuration(row.planned)}，实际 ${formatDuration(row.actual)}，差额 ${formatDiff(row.diff)}，判定 ${getCategoryLabel(row.category)}`
    )
  })

  return lines.join('\n')
}

function buildInfoReportText(session: MeetingSession, metadata: MeetingMetadata) {
  const lines = [
    '【会议信息】',
    `主题：${metadata.theme || '未设置'}`,
    `日期：${metadata.date || '未设置'}`,
    `会议次数：${metadata.meetingNo || '未设置'}`,
    `开始时间：${metadata.startTime || '未设置'}`,
    `结束时间：${metadata.endTime || '未设置'}`,
    `地点：${metadata.location || '未设置'}`,
    `会议链接：${metadata.meetingLink || '未设置'}`,
    `投票ID：${metadata.votingId || '未设置'}`,
    `议程环节数：${session.items.length}`,
    `已完成即兴人数：${(session.impromptuRecords || []).filter((record) => record.status === 'completed' && !record.deletedAt).length}`
  ]

  return lines.join('\n')
}

function buildAgendaReportText(rows: AgendaReviewRow[]) {
  const lines = ['【真实日程】']

  rows.forEach((row, index) => {
    lines.push(
      `${index + 1}. ${row.title}｜${row.speaker}`,
      `计划 ${formatDuration(row.planned)}｜实际 ${row.actual === null ? '未记录' : formatDuration(row.actual)}｜${getCategoryLabel(row.category)}${row.diff === null ? '' : `｜差额 ${formatDiff(row.diff)}`}${row.disabled ? '｜已禁用' : ''}`
    )
  })

  return lines.join('\n')
}

function buildOfficerReportText(params: {
  metadata: MeetingMetadata
  participantSummaries: OfficerParticipantSummary[]
  grammarNotes: GrammarianNoteV2[]
  ahRecords: AhCounterRecordV2[]
}) {
  const {metadata, participantSummaries, grammarNotes, ahRecords} = params
  const lines = ['【三官记录】', `每日一词：${metadata.wordOfTheDay || '未设置'}`, '']

  if (participantSummaries.length === 0 && grammarNotes.length === 0 && ahRecords.length === 0) {
    lines.push('暂无三官记录。')
    return lines.join('\n')
  }

  if (participantSummaries.length > 0) {
    lines.push('按成员汇总：')
    participantSummaries.forEach((row, index) => {
      const fillerText =
        row.fillerBreakdown.length > 0
          ? row.fillerBreakdown.map((item) => `${item.word} ${item.count}`).join('，')
          : '无'
      lines.push(
        `${index + 1}. ${row.participantName}`,
        `语法记录 ${row.grammarNoteCount} 条，语法问题 ${row.grammarIssueCount} 条，每日一词 ${row.wordOfDayHits} 次，哼哈词 ${row.fillerTotal} 次`,
        `哼哈词明细：${fillerText}`
      )
    })
  }

  if (grammarNotes.length > 0) {
    lines.push('', '最近语法记录：')
    grammarNotes.slice(0, 12).forEach((note, index) => {
      lines.push(`${index + 1}. ${note.participant_key}｜${note.note_type}｜${note.content}`)
    })
  }

  return lines.join('\n')
}

export default function CompletedMeetingReview({
  session,
  metadata,
  onOpenMeetingLink,
  onOpenVoteResult
}: CompletedMeetingReviewProps) {
  const [activeTab, setActiveTab] = useState<ReviewTab>('info')
  const [loadingOfficerData, setLoadingOfficerData] = useState(false)
  const [participants, setParticipants] = useState<MeetingParticipantV2[]>([])
  const [grammarNotes, setGrammarNotes] = useState<GrammarianNoteV2[]>([])
  const [ahRecords, setAhRecords] = useState<AhCounterRecordV2[]>([])
  const [wordOfDayHits, setWordOfDayHits] = useState<WordOfDayHitV2[]>([])

  useEffect(() => {
    let active = true

    const loadOfficerData = async () => {
      if (!session.id) return

      setLoadingOfficerData(true)
      try {
        const [participantsResult, grammarResult, ahResult, wordResult] = await Promise.all([
          AgendaV2DatabaseService.listParticipants(session.id),
          AgendaV2DatabaseService.listGrammarianNotes(session.id),
          AgendaV2DatabaseService.listAhCounterRecords(session.id),
          AgendaV2DatabaseService.listWordOfDayHits(session.id)
        ])

        if (!active) return

        setParticipants(participantsResult.success ? participantsResult.data || [] : [])
        setGrammarNotes(grammarResult.success ? grammarResult.data || [] : [])
        setAhRecords(ahResult.success ? ahResult.data || [] : [])
        setWordOfDayHits(wordResult.success ? wordResult.data || [] : [])
      } finally {
        if (active) {
          setLoadingOfficerData(false)
        }
      }
    }

    void loadOfficerData()

    return () => {
      active = false
    }
  }, [session.id])

  const agendaRows = useMemo(() => buildAgendaReviewRows(session), [session])

  const participantNameMap = useMemo(() => {
    const map = new Map<string, string>()

    participants.forEach((participant) => {
      map.set(participant.participant_key, participant.display_name || participant.participant_key)
    })

    session.items.forEach((item) => {
      const speaker = item.speaker?.trim()
      if (speaker && !map.has(speaker)) {
        map.set(speaker, speaker)
      }
    })

    ;(session.impromptuRecords || []).forEach((record) => {
      if (record.speakerKey && !map.has(record.speakerKey)) {
        map.set(record.speakerKey, record.speakerName || record.speakerKey)
      }
    })

    return map
  }, [participants, session.impromptuRecords, session.items])

  const normalizedWordOfDay = useMemo(() => metadata.wordOfTheDay?.trim().toLowerCase() || '', [metadata.wordOfTheDay])

  const participantSummaries = useMemo(() => {
    const summaryMap = new Map<string, OfficerParticipantSummary>()

    const ensureSummary = (participantKey: string) => {
      const existing = summaryMap.get(participantKey)
      if (existing) return existing

      const created: OfficerParticipantSummary = {
        participantKey,
        participantName: participantNameMap.get(participantKey) || participantKey,
        grammarNoteCount: 0,
        grammarIssueCount: 0,
        wordOfDayHits: 0,
        fillerTotal: 0,
        fillerBreakdown: []
      }
      summaryMap.set(participantKey, created)
      return created
    }

    grammarNotes.forEach((note) => {
      const summary = ensureSummary(note.participant_key)
      summary.grammarNoteCount += 1
      if (note.note_type === 'grammar_issue') {
        summary.grammarIssueCount += 1
      }
    })

    ahRecords.forEach((record) => {
      const summary = ensureSummary(record.participant_key)
      summary.fillerTotal += Number(record.hit_count || 0)
      summary.fillerBreakdown.push({
        word: record.filler_word,
        count: Number(record.hit_count || 0)
      })
    })

    wordOfDayHits.forEach((hit) => {
      if (!normalizedWordOfDay || hit.word_text.trim().toLowerCase() !== normalizedWordOfDay) return
      const summary = ensureSummary(hit.participant_key)
      summary.wordOfDayHits += Number(hit.hit_count || 0)
    })

    return Array.from(summaryMap.values())
      .map((summary) => ({
        ...summary,
        fillerBreakdown: summary.fillerBreakdown.sort(
          (left, right) => right.count - left.count || left.word.localeCompare(right.word)
        )
      }))
      .sort((left, right) => {
        const scoreLeft = left.grammarNoteCount + left.wordOfDayHits + left.fillerTotal
        const scoreRight = right.grammarNoteCount + right.wordOfDayHits + right.fillerTotal
        if (scoreRight !== scoreLeft) return scoreRight - scoreLeft
        return left.participantName.localeCompare(right.participantName)
      })
  }, [ahRecords, grammarNotes, normalizedWordOfDay, participantNameMap, wordOfDayHits])

  const totalPanelText = useMemo(() => {
    return [
      buildInfoReportText(session, metadata),
      '',
      buildTimingReportText(session),
      '',
      buildAgendaReportText(agendaRows),
      '',
      buildOfficerReportText({
        metadata,
        participantSummaries,
        grammarNotes,
        ahRecords
      })
    ].join('\n')
  }, [agendaRows, ahRecords, grammarNotes, metadata, participantSummaries, session])

  const currentPanelText = useMemo(() => {
    switch (activeTab) {
      case 'timing':
        return buildTimingReportText(session)
      case 'agenda':
        return buildAgendaReportText(agendaRows)
      case 'officers':
        return buildOfficerReportText({
          metadata,
          participantSummaries,
          grammarNotes,
          ahRecords
        })
      default:
        return buildInfoReportText(session, metadata)
    }
  }, [activeTab, agendaRows, ahRecords, grammarNotes, metadata, participantSummaries, session])

  const handleCopy = useCallback((text: string, title: string) => {
    Taro.setClipboardData({
      data: text,
      success: () => {
        Taro.showToast({
          title,
          icon: 'success'
        })
      }
    })
  }, [])

  const renderInfoPanel = () => (
    <ScrollView className="flex-1 min-h-0" scrollY enableBackToTop>
      <View className="px-4 pb-6 space-y-3">
        <View className="ui-card-sharp p-4">
          <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">会议概览</Text>
          <View className="grid grid-cols-2 gap-3">
            <View className="ui-panel-sharp p-3">
              <Text className="text-[11px] text-muted-foreground block">主题</Text>
              <Text className="text-sm font-bold text-foreground mt-1">{metadata.theme || '未设置'}</Text>
            </View>
            <View className="ui-panel-sharp p-3">
              <Text className="text-[11px] text-muted-foreground block">日期</Text>
              <Text className="text-sm font-bold text-foreground mt-1">{metadata.date || '未设置'}</Text>
            </View>
            <View className="ui-panel-sharp p-3">
              <Text className="text-[11px] text-muted-foreground block">开始时间</Text>
              <Text className="text-sm font-bold text-foreground mt-1">{metadata.startTime || '未设置'}</Text>
            </View>
            <View className="ui-panel-sharp p-3">
              <Text className="text-[11px] text-muted-foreground block">地点</Text>
              <Text className="text-sm font-bold text-foreground mt-1">{metadata.location || '未设置'}</Text>
            </View>
          </View>
        </View>

        <View className="ui-card-sharp p-4">
          <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">会议链接</Text>
          <Text className="text-sm text-foreground break-all">{metadata.meetingLink || '暂未设置会议链接'}</Text>
          <View className="grid grid-cols-2 gap-2 mt-3">
            <Button className="ui-btn-secondary h-10 text-sm" onClick={onOpenMeetingLink}>
              查看链接
            </Button>
            <Button
              className="ui-btn-primary h-10 text-sm font-bold"
              onClick={() => handleCopy(metadata.meetingLink || '未设置会议链接', '链接已复制')}>
              复制链接
            </Button>
          </View>
        </View>

        <View className="ui-card-sharp p-4">
          <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">投票信息</Text>
          <Text className="text-lg font-black text-foreground break-all">{metadata.votingId || '尚未创建投票'}</Text>
          <View className="grid grid-cols-2 gap-2 mt-3">
            <Button
              className="ui-btn-secondary h-10 text-sm"
              disabled={!metadata.votingId}
              onClick={() => handleCopy(metadata.votingId || '未设置投票 ID', '投票ID已复制')}>
              复制投票ID
            </Button>
            <Button
              className="ui-btn-primary h-10 text-sm font-bold"
              disabled={!metadata.votingId}
              onClick={onOpenVoteResult}>
              查看投票结果
            </Button>
          </View>
        </View>
      </View>
    </ScrollView>
  )

  const renderAgendaPanel = () => (
    <ScrollView className="flex-1 min-h-0" scrollY enableBackToTop>
      <View className="px-4 pb-6 space-y-3">
        {agendaRows.map((row, index) => (
          <View key={row.id} className={`ui-card-sharp p-4 ${row.disabled ? 'opacity-60' : ''}`}>
            <View className="flex items-start justify-between gap-3">
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-bold text-foreground block truncate">
                  {index + 1}. {row.title}
                </Text>
                <Text className="text-xs text-muted-foreground block mt-1">负责人：{row.speaker}</Text>
              </View>
              <Text className={`text-xs font-semibold shrink-0 ${getCategoryTextClass(row.category)}`}>
                {getCategoryLabel(row.category)}
              </Text>
            </View>

            <View className="grid grid-cols-3 gap-2 mt-3">
              <View className="ui-panel-sharp p-2">
                <Text className="text-[11px] text-muted-foreground block">计划</Text>
                <Text className="text-sm font-bold text-foreground mt-1">{formatDuration(row.planned)}</Text>
              </View>
              <View className="ui-panel-sharp p-2">
                <Text className="text-[11px] text-muted-foreground block">实际</Text>
                <Text className="text-sm font-bold text-foreground mt-1">
                  {row.actual === null ? '未记录' : formatDuration(row.actual)}
                </Text>
              </View>
              <View className="ui-panel-sharp p-2">
                <Text className="text-[11px] text-muted-foreground block">差额</Text>
                <Text
                  className={`text-sm font-bold mt-1 ${row.diff === null ? 'text-muted-foreground' : getCategoryTextClass(row.category)}`}>
                  {row.diff === null ? '--' : formatDiff(row.diff)}
                </Text>
              </View>
            </View>

            {row.disabled && (
              <Text className="text-[11px] text-amber-300 block mt-3">该环节已被禁用，不参与正式流程。</Text>
            )}
          </View>
        ))}
      </View>
    </ScrollView>
  )

  const renderOfficerPanel = () => (
    <ScrollView className="flex-1 min-h-0" scrollY enableBackToTop>
      <View className="px-4 pb-6 space-y-3">
        <View className="ui-card-sharp p-4">
          <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">记录概览</Text>
          <View className="grid grid-cols-3 gap-2">
            <View className="ui-panel-sharp p-3">
              <Text className="text-[11px] text-muted-foreground block">语法记录</Text>
              <Text className="text-lg font-black text-foreground mt-1">{grammarNotes.length}</Text>
            </View>
            <View className="ui-panel-sharp p-3">
              <Text className="text-[11px] text-muted-foreground block">哼哈词总数</Text>
              <Text className="text-lg font-black text-foreground mt-1">
                {ahRecords.reduce((sum, record) => sum + Number(record.hit_count || 0), 0)}
              </Text>
            </View>
            <View className="ui-panel-sharp p-3">
              <Text className="text-[11px] text-muted-foreground block">每日一词</Text>
              <Text className="text-lg font-black text-foreground mt-1">
                {wordOfDayHits
                  .filter((hit) => !normalizedWordOfDay || hit.word_text.trim().toLowerCase() === normalizedWordOfDay)
                  .reduce((sum, hit) => sum + Number(hit.hit_count || 0), 0)}
              </Text>
            </View>
          </View>
          <Text className="text-xs text-muted-foreground block mt-3">
            每日一词：{metadata.wordOfTheDay || '未设置'}
          </Text>
        </View>

        {loadingOfficerData ? (
          <View className="ui-card-sharp p-5 flex items-center justify-center">
            <Text className="text-sm text-muted-foreground">三官记录加载中...</Text>
          </View>
        ) : participantSummaries.length > 0 ? (
          participantSummaries.map((summary) => (
            <View key={summary.participantKey} className="ui-card-sharp p-4">
              <View className="flex items-center justify-between gap-3">
                <Text className="text-sm font-bold text-foreground truncate">{summary.participantName}</Text>
                <Text className="text-xs text-muted-foreground shrink-0">
                  语法 {summary.grammarNoteCount}｜哼哈 {summary.fillerTotal}
                </Text>
              </View>
              <View className="grid grid-cols-3 gap-2 mt-3">
                <View className="ui-panel-sharp p-2">
                  <Text className="text-[11px] text-muted-foreground block">语法问题</Text>
                  <Text className="text-sm font-bold text-foreground mt-1">{summary.grammarIssueCount}</Text>
                </View>
                <View className="ui-panel-sharp p-2">
                  <Text className="text-[11px] text-muted-foreground block">每日一词</Text>
                  <Text className="text-sm font-bold text-foreground mt-1">{summary.wordOfDayHits}</Text>
                </View>
                <View className="ui-panel-sharp p-2">
                  <Text className="text-[11px] text-muted-foreground block">哼哈总数</Text>
                  <Text className="text-sm font-bold text-foreground mt-1">{summary.fillerTotal}</Text>
                </View>
              </View>
              <Text className="text-xs text-muted-foreground block mt-3">
                哼哈词：
                {summary.fillerBreakdown.length > 0
                  ? summary.fillerBreakdown.map((item) => `${item.word} ${item.count}`).join('，')
                  : '暂无'}
              </Text>
            </View>
          ))
        ) : (
          <View className="ui-card-sharp p-5 flex items-center justify-center">
            <Text className="text-sm text-muted-foreground">暂无三官记录</Text>
          </View>
        )}

        {grammarNotes.length > 0 && (
          <View className="ui-card-sharp p-4">
            <Text className="text-xs text-muted-foreground block mb-3 uppercase tracking-wider">最近语法记录</Text>
            <View className="space-y-2">
              {grammarNotes.slice(0, 12).map((note) => (
                <View key={note.id} className="ui-panel-sharp p-3">
                  <Text className="text-xs text-primary font-semibold">
                    {`${participantNameMap.get(note.participant_key) || note.participant_key}｜${note.note_type}`}
                  </Text>
                  <Text className="text-sm text-foreground mt-1 break-all">{note.content}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  )

  return (
    <View className="flex-1 min-h-0 flex flex-col">
      <View className="px-4 pt-3 pb-3 border-b border-border/60 bg-background/70">
        <View className="grid grid-cols-4 gap-2">
          {[
            {key: 'info', label: '会议信息'},
            {key: 'timing', label: '时间情况'},
            {key: 'agenda', label: '真实日程'},
            {key: 'officers', label: '三官记录'}
          ].map((tab) => (
            <View
              key={tab.key}
              className={`h-10 rounded-xl border flex items-center justify-center ${
                activeTab === tab.key ? 'bg-primary border-primary/60' : 'bg-secondary/70 border-border/70'
              }`}
              onClick={() => setActiveTab(tab.key as ReviewTab)}>
              <Text className={`text-xs font-semibold ${activeTab === tab.key ? 'text-white' : 'text-foreground'}`}>
                {tab.label}
              </Text>
            </View>
          ))}
        </View>

        <View className="grid grid-cols-2 gap-2 mt-3">
          <Button className="ui-btn-secondary h-10 text-sm" onClick={() => handleCopy(currentPanelText, '本页已复制')}>
            复制本页
          </Button>
          <Button
            className="ui-btn-primary h-10 text-sm font-bold"
            onClick={() => handleCopy(totalPanelText, '总复盘已复制')}>
            复制总复盘
          </Button>
        </View>
      </View>

      {activeTab === 'info' && renderInfoPanel()}
      {activeTab === 'timing' && (
        <View className="flex-1 min-h-0">
          <MeetingStats
            items={session.items}
            impromptuRecords={session.impromptuRecords}
            metadata={metadata}
            meetingId={session.id}
            showVotingSection={false}
          />
        </View>
      )}
      {activeTab === 'agenda' && renderAgendaPanel()}
      {activeTab === 'officers' && renderOfficerPanel()}
    </View>
  )
}
