import {Button, Input, Picker, ScrollView, Text, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {supabase} from '@/client/supabase'
import {useAuth} from '@/contexts/AuthContext'
import {AgendaV2DatabaseService} from '@/db/agendaV2Database'
import {useMeetingStore} from '@/store/meetingStore'
import type {
  AgendaMutationActor,
  AhCounterRecordV2,
  GrammarianNoteV2,
  GrammarNoteType,
  MeetingLiveCursorV2
} from '@/types/agendaV2'
import {safeSwitchTab} from '@/utils/safeNavigation'

type OfficerTab = 'selector' | 'grammarian' | 'ah_counter'

type ParticipantOption = {
  key: string
  name: string
}

const GRAMMAR_NOTE_TYPE_LABELS: Record<GrammarNoteType, string> = {
  good_word: '好词',
  good_phrase: '好句',
  great_sentence: '金句',
  grammar_issue: '语法问题'
}

const GRAMMAR_NOTE_TYPES: GrammarNoteType[] = ['good_word', 'good_phrase', 'great_sentence', 'grammar_issue']
const COMMON_FILLER_WORDS = ['嗯', '啊', '然后', '就是', '那个', '长停顿']

function normalizeParticipantKey(name: string) {
  return name.trim()
}

function formatTimeLabel(timestamp?: number | null) {
  if (!timestamp) return '--'
  const date = new Date(timestamp)
  const hh = date.getHours().toString().padStart(2, '0')
  const mm = date.getMinutes().toString().padStart(2, '0')
  const ss = date.getSeconds().toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function resolveActorName(
  userMetadata: Record<string, unknown>,
  profile: Record<string, unknown> | null | undefined,
  fallback = '会议官员'
) {
  const fromMetadata =
    (typeof userMetadata.nickname === 'string' && userMetadata.nickname) ||
    (typeof userMetadata.wechat_nickname === 'string' && userMetadata.wechat_nickname) ||
    (typeof userMetadata.name === 'string' && userMetadata.name) ||
    (typeof userMetadata.full_name === 'string' && userMetadata.full_name) ||
    null
  if (fromMetadata) return fromMetadata

  const fromProfile =
    (profile && typeof profile.display_name === 'string' && profile.display_name) ||
    (profile && typeof profile.nickname === 'string' && profile.nickname) ||
    (profile && typeof profile.name === 'string' && profile.name) ||
    null
  if (fromProfile) return fromProfile

  return fallback
}

export default function OfficerNotesPage() {
  const {currentSession} = useMeetingStore()
  const {user, profile} = useAuth()

  const [activeTab, setActiveTab] = useState<OfficerTab>('selector')
  const [participantOptions, setParticipantOptions] = useState<ParticipantOption[]>([])
  const [syncedParticipantKeys, setSyncedParticipantKeys] = useState<string[]>([])
  const [selectedParticipantKey, setSelectedParticipantKey] = useState('')
  const [liveCursor, setLiveCursor] = useState<MeetingLiveCursorV2 | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [roleError, setRoleError] = useState('')

  const [grammarNoteType, setGrammarNoteType] = useState<GrammarNoteType>('good_word')
  const [grammarContent, setGrammarContent] = useState('')
  const [grammarNotes, setGrammarNotes] = useState<GrammarianNoteV2[]>([])

  const [fillerWord, setFillerWord] = useState('')
  const [hitCountText, setHitCountText] = useState('1')
  const [sampleQuote, setSampleQuote] = useState('')
  const [ahRecords, setAhRecords] = useState<AhCounterRecordV2[]>([])

  const meetingId = currentSession?.id || ''
  const meetingTitle = currentSession?.metadata?.theme || '当前会议'
  const observerRoleText = useMemo(() => {
    if (activeTab === 'selector') return '现场激励模式：先选记录官，再开始记录'
    return activeTab === 'grammarian' ? '记录好词好句与语法问题' : '记录口头禅与长停顿'
  }, [activeTab])
  const syncedParticipantKeySet = useMemo(() => new Set(syncedParticipantKeys), [syncedParticipantKeys])

  const actor = useMemo<AgendaMutationActor>(() => {
    const metadata = (user?.user_metadata || {}) as Record<string, unknown>
    return {
      userId: user?.id || null,
      name: resolveActorName(metadata, (profile || null) as Record<string, unknown> | null),
      nameSource:
        typeof metadata.nickname === 'string' || typeof metadata.wechat_nickname === 'string'
          ? 'wechat_profile'
          : 'unknown'
    }
  }, [profile, user?.id, user?.user_metadata])

  const participantNameMap = useMemo(() => {
    const map = new Map<string, string>()
    participantOptions.forEach((option) => {
      map.set(option.key, option.name)
    })
    return map
  }, [participantOptions])

  const currentItem = useMemo(() => {
    if (!currentSession || !liveCursor?.current_item_key) return null
    return currentSession.items.find((item) => item.id === liveCursor.current_item_key) || null
  }, [currentSession, liveCursor?.current_item_key])

  const currentSpeakerLabel = useMemo(() => {
    if (!currentItem) return '未检测到当前发言人'
    if (currentItem.speaker?.trim()) return currentItem.speaker.trim()
    return currentItem.title || '未命名环节'
  }, [currentItem])

  const participantNames = useMemo(() => participantOptions.map((option) => option.name), [participantOptions])

  const selectedParticipantIndex = useMemo(() => {
    const index = participantOptions.findIndex((option) => option.key === selectedParticipantKey)
    return index >= 0 ? index : 0
  }, [participantOptions, selectedParticipantKey])

  const selectedParticipantName = useMemo(() => {
    if (!selectedParticipantKey) return ''
    return participantNameMap.get(selectedParticipantKey) || selectedParticipantKey
  }, [participantNameMap, selectedParticipantKey])
  const selectedParticipantSynced = useMemo(() => {
    if (!selectedParticipantKey) return false
    return syncedParticipantKeySet.has(selectedParticipantKey)
  }, [selectedParticipantKey, syncedParticipantKeySet])

  const grammarSummary = useMemo(() => {
    const summaryMap = new Map<string, number>()
    grammarNotes.forEach((note) => {
      const key = note.participant_key
      summaryMap.set(key, (summaryMap.get(key) || 0) + 1)
    })
    return Array.from(summaryMap.entries())
      .map(([participantKey, count]) => ({
        participantKey,
        participantName: participantNameMap.get(participantKey) || participantKey,
        count
      }))
      .sort((a, b) => b.count - a.count)
  }, [grammarNotes, participantNameMap])

  const ahSummary = useMemo(() => {
    const summaryMap = new Map<string, number>()
    ahRecords.forEach((record) => {
      const key = record.participant_key
      summaryMap.set(key, (summaryMap.get(key) || 0) + Number(record.hit_count || 1))
    })
    return Array.from(summaryMap.entries())
      .map(([participantKey, totalHit]) => ({
        participantKey,
        participantName: participantNameMap.get(participantKey) || participantKey,
        totalHit
      }))
      .sort((a, b) => b.totalHit - a.totalHit)
  }, [ahRecords, participantNameMap])

  const ensureParticipantReady = useCallback(
    async (participantKey: string, displayName: string): Promise<{success: boolean; error?: string}> => {
      if (syncedParticipantKeySet.has(participantKey)) {
        return {success: true}
      }

      const result = await AgendaV2DatabaseService.upsertParticipant({
        meetingId,
        participantKey,
        displayName,
        roleTags: ['speaker'],
        actor
      })

      if (!result.success) {
        return {success: false, error: result.error || '写入参会人失败'}
      }

      setSyncedParticipantKeys((prev) => {
        if (prev.includes(participantKey)) return prev
        return [...prev, participantKey]
      })

      return {success: true}
    },
    [actor, meetingId, syncedParticipantKeySet]
  )

  const loadData = useCallback(async () => {
    if (!meetingId || !currentSession) return

    setLoading(true)
    try {
      const [participantsRes, cursorRes, grammarRes, ahRes] = await Promise.all([
        AgendaV2DatabaseService.listParticipants(meetingId),
        AgendaV2DatabaseService.getLiveCursor(meetingId),
        AgendaV2DatabaseService.listGrammarianNotes(meetingId),
        AgendaV2DatabaseService.listAhCounterRecords(meetingId)
      ])

      const dedup = new Map<string, ParticipantOption>()
      const syncedKeys = new Set<string>()
      currentSession.items.forEach((item) => {
        const speaker = item.speaker?.trim()
        if (!speaker) return
        const key = normalizeParticipantKey(speaker)
        if (!key) return
        dedup.set(key, {key, name: speaker})
      })

      if (participantsRes.success) {
        participantsRes.data?.forEach((participant) => {
          const key = participant.participant_key
          if (!key) return
          syncedKeys.add(key)
          dedup.set(key, {key, name: participant.display_name || participant.participant_key})
        })
      }

      if (cursorRes.success) {
        setLiveCursor(cursorRes.data || null)
      }
      if (grammarRes.success) {
        setGrammarNotes(grammarRes.data || [])
      }
      if (ahRes.success) {
        setAhRecords(ahRes.data || [])
      }

      const nextOptions = Array.from(dedup.values())
      setParticipantOptions(nextOptions)
      setSyncedParticipantKeys(Array.from(syncedKeys))

      const liveParticipantKey = cursorRes.data?.current_participant_key || ''
      const currentSpeaker = (() => {
        if (!cursorRes.data?.current_item_key) return ''
        const matched = currentSession.items.find((item) => item.id === cursorRes.data?.current_item_key)
        return matched?.speaker?.trim() || ''
      })()
      const fallbackKey = normalizeParticipantKey(currentSpeaker)

      if (liveParticipantKey && nextOptions.some((option) => option.key === liveParticipantKey)) {
        setSelectedParticipantKey(liveParticipantKey)
      } else if (fallbackKey && nextOptions.some((option) => option.key === fallbackKey)) {
        setSelectedParticipantKey(fallbackKey)
      } else if (nextOptions.length > 0) {
        setSelectedParticipantKey((prev) => {
          if (prev && nextOptions.some((option) => option.key === prev)) return prev
          return nextOptions[0].key
        })
      }
    } finally {
      setLoading(false)
    }
  }, [currentSession, meetingId])

  useEffect(() => {
    if (currentSession) return
    const timer = setTimeout(() => {
      void safeSwitchTab('/pages/history/index')
    }, 300)
    return () => clearTimeout(timer)
  }, [currentSession])

  useEffect(() => {
    if (!meetingId) return
    void loadData()
  }, [loadData, meetingId])

  useEffect(() => {
    if (!meetingId) return
    const channel = supabase
      .channel(`officer-notes-live-${meetingId}`)
      .on(
        'postgres_changes',
        {event: '*', schema: 'public', table: 'meeting_live_cursor_v2', filter: `meeting_id=eq.${meetingId}`},
        () => {
          void loadData()
        }
      )
      .on(
        'postgres_changes',
        {event: '*', schema: 'public', table: 'meeting_participants_v2', filter: `meeting_id=eq.${meetingId}`},
        () => {
          void loadData()
        }
      )
      .on(
        'postgres_changes',
        {event: '*', schema: 'public', table: 'grammarian_notes_v2', filter: `meeting_id=eq.${meetingId}`},
        () => {
          void loadData()
        }
      )
      .on(
        'postgres_changes',
        {event: '*', schema: 'public', table: 'ah_counter_records_v2', filter: `meeting_id=eq.${meetingId}`},
        () => {
          void loadData()
        }
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [loadData, meetingId])

  const handleParticipantChange = (index: number) => {
    if (!participantOptions[index]) return
    setSelectedParticipantKey(participantOptions[index].key)
  }

  const handleSubmitGrammarianNote = async () => {
    if (!meetingId) return
    if (!selectedParticipantKey) {
      Taro.showToast({title: '请先选择记录对象', icon: 'none'})
      return
    }
    if (!grammarContent.trim()) {
      Taro.showToast({title: '请输入记录内容', icon: 'none'})
      return
    }

    setSubmitting(true)
    try {
      const participantResult = await ensureParticipantReady(
        selectedParticipantKey,
        selectedParticipantName || selectedParticipantKey
      )
      if (!participantResult.success) {
        const message = participantResult.error || '记录对象未同步'
        setRoleError(message)
        Taro.showToast({title: message, icon: 'none'})
        return
      }

      const createResult = await AgendaV2DatabaseService.createGrammarianNote({
        meetingId,
        participantKey: selectedParticipantKey,
        noteType: grammarNoteType,
        content: grammarContent.trim(),
        relatedItemKey: currentItem?.id || null,
        actor
      })

      if (!createResult.success) {
        const message = createResult.error || '保存语法记录失败'
        setRoleError(message)
        Taro.showToast({title: message, icon: 'none'})
        return
      }

      setRoleError('')
      setGrammarContent('')
      Taro.showToast({title: '语法记录已保存', icon: 'success'})
      await loadData()
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmitAhRecord = async () => {
    if (!meetingId) return
    if (!selectedParticipantKey) {
      Taro.showToast({title: '请先选择记录对象', icon: 'none'})
      return
    }
    if (!fillerWord.trim()) {
      Taro.showToast({title: '请输入哼哈词或长停顿', icon: 'none'})
      return
    }

    const hitCount = Number(hitCountText || '1')
    if (!Number.isFinite(hitCount) || hitCount < 1) {
      Taro.showToast({title: '次数必须大于等于 1', icon: 'none'})
      return
    }

    setSubmitting(true)
    try {
      const participantResult = await ensureParticipantReady(
        selectedParticipantKey,
        selectedParticipantName || selectedParticipantKey
      )
      if (!participantResult.success) {
        const message = participantResult.error || '记录对象未同步'
        setRoleError(message)
        Taro.showToast({title: message, icon: 'none'})
        return
      }

      const createResult = await AgendaV2DatabaseService.createAhCounterRecord({
        meetingId,
        participantKey: selectedParticipantKey,
        fillerWord: fillerWord.trim(),
        hitCount,
        sampleQuote: sampleQuote.trim() || null,
        relatedItemKey: currentItem?.id || null,
        actor
      })

      if (!createResult.success) {
        const message = createResult.error || '保存哼哈记录失败'
        setRoleError(message)
        Taro.showToast({title: message, icon: 'none'})
        return
      }

      setRoleError('')
      setFillerWord('')
      setHitCountText('1')
      setSampleQuote('')
      Taro.showToast({title: '哼哈记录已保存', icon: 'success'})
      await loadData()
    } finally {
      setSubmitting(false)
    }
  }

  if (!currentSession) {
    return (
      <View className="h-screen bg-gradient-page flex items-center justify-center">
        <Text className="text-sm text-white/80">未找到会议，正在返回会议列表...</Text>
      </View>
    )
  }

  return (
    <View className="h-screen bg-gradient-page flex flex-col">
      <View className="p-4 pt-8 bg-background/90 border-b border-border/70 backdrop-blur-sm shrink-0">
        <View className="flex justify-between items-center gap-2">
          <View className="min-w-0 flex-1">
            <Text className="text-xl font-black text-foreground block">官员记录台</Text>
            <Text className="text-xs text-muted-foreground block mt-1 truncate">{meetingTitle}</Text>
          </View>
          <View
            className="ui-btn-secondary h-10 px-3 rounded-lg flex items-center gap-1.5"
            onClick={() => Taro.navigateBack()}>
            <View className="i-mdi-arrow-left text-base text-foreground" />
            <Text className="text-xs font-semibold text-foreground">返回</Text>
          </View>
        </View>

        <View className="mt-3 ui-card p-3">
          <Text className="text-[11px] text-muted-foreground block mb-1 uppercase tracking-wider">当前跟踪对象</Text>
          <Text className="text-sm text-foreground font-semibold block truncate">{currentSpeakerLabel}</Text>
          <Text className="text-[11px] text-muted-foreground block mt-1">来源：时间官实时游标（当前环节自动感知）</Text>
        </View>

        <View className="mt-3 grid grid-cols-3 gap-2">
          <View
            className={`h-10 rounded-lg flex items-center justify-center border ${
              activeTab === 'selector'
                ? 'bg-primary border-primary/60'
                : 'bg-secondary/70 border-border/70 active:bg-secondary/85'
            }`}
            onClick={() => setActiveTab('selector')}>
            <Text className={`text-sm font-semibold ${activeTab === 'selector' ? 'text-white' : 'text-foreground'}`}>
              角色选择
            </Text>
          </View>
          <View
            className={`h-10 rounded-lg flex items-center justify-center border ${
              activeTab === 'grammarian'
                ? 'bg-primary border-primary/60'
                : 'bg-secondary/70 border-border/70 active:bg-secondary/85'
            }`}
            onClick={() => setActiveTab('grammarian')}>
            <Text className={`text-sm font-semibold ${activeTab === 'grammarian' ? 'text-white' : 'text-foreground'}`}>
              语法官
            </Text>
          </View>
          <View
            className={`h-10 rounded-lg flex items-center justify-center border ${
              activeTab === 'ah_counter'
                ? 'bg-primary border-primary/60'
                : 'bg-secondary/70 border-border/70 active:bg-secondary/85'
            }`}
            onClick={() => setActiveTab('ah_counter')}>
            <Text className={`text-sm font-semibold ${activeTab === 'ah_counter' ? 'text-white' : 'text-foreground'}`}>
              哼哈官
            </Text>
          </View>
        </View>

        <Text className="text-xs text-white/80 mt-2">{observerRoleText}</Text>
        {roleError && <Text className="text-xs text-red-300 mt-1">权限提示：{roleError}</Text>}
      </View>

      <ScrollView className="flex-1 min-h-0" scrollY enableBackToTop>
        <View className="px-4 py-3 space-y-3">
          <View className="ui-card-sharp p-3">
            <Text className="text-xs text-muted-foreground block mb-1 uppercase tracking-wider">记录对象</Text>
            {participantOptions.length > 0 ? (
              <Picker
                mode="selector"
                range={participantNames}
                value={selectedParticipantIndex}
                onChange={(e) => handleParticipantChange(Number(e.detail.value))}>
                <View className="ui-input rounded-lg px-3 py-2">
                  <Text className="text-sm text-foreground">
                    {participantOptions[selectedParticipantIndex]?.name || '请选择记录对象'}
                  </Text>
                </View>
              </Picker>
            ) : (
              <View className="ui-muted-panel">
                <Text className="text-xs text-muted-foreground">暂无可选发言人，请先在议程里配置发言人。</Text>
              </View>
            )}
            {!selectedParticipantSynced && selectedParticipantKey && (
              <Text className="text-[11px] text-amber-300 mt-2">
                当前对象来自议程但尚未同步到参会人主表，首次提交可能失败，可先让时间官同步后再记录。
              </Text>
            )}
          </View>

          {activeTab === 'selector' ? (
            <View className="space-y-3">
              <View className="ui-card-sharp p-4">
                <Text className="text-sm text-foreground font-semibold block">现场激励模式</Text>
                <Text className="text-xs text-muted-foreground block mt-1 leading-5">
                  不区分权限，现场直接选择记录官开始记。若出现提交失败，再由时间官同步发言人后继续。
                </Text>
              </View>
              <View
                className="ui-card-sharp p-4 border border-primary/35 active:border-primary/60"
                onClick={() => setActiveTab('grammarian')}>
                <Text className="text-base text-foreground font-bold block">进入语法官记录</Text>
                <Text className="text-xs text-muted-foreground block mt-1">记录好词、好句、金句、语法问题</Text>
              </View>
              <View
                className="ui-card-sharp p-4 border border-primary/35 active:border-primary/60"
                onClick={() => setActiveTab('ah_counter')}>
                <Text className="text-base text-foreground font-bold block">进入哼哈官记录</Text>
                <Text className="text-xs text-muted-foreground block mt-1">记录口头禅、停顿和示例句</Text>
              </View>
            </View>
          ) : activeTab === 'grammarian' ? (
            <View className="space-y-3">
              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">记录类型</Text>
                <View className="grid grid-cols-2 gap-2">
                  {GRAMMAR_NOTE_TYPES.map((noteType) => (
                    <View
                      key={noteType}
                      className={`h-9 rounded-lg flex items-center justify-center border ${
                        grammarNoteType === noteType
                          ? 'bg-primary border-primary/60'
                          : 'bg-secondary/70 border-border/70 active:bg-secondary/85'
                      }`}
                      onClick={() => setGrammarNoteType(noteType)}>
                      <Text
                        className={`text-xs font-semibold ${grammarNoteType === noteType ? 'text-white' : 'text-foreground'}`}>
                        {GRAMMAR_NOTE_TYPE_LABELS[noteType]}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>

              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-1 uppercase tracking-wider">记录内容</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm"
                  value={grammarContent}
                  onInput={(e) => setGrammarContent(e.detail.value)}
                  placeholder="请输入好词好句或语法问题"
                  adjustPosition={false}
                />
                <View className="flex items-center gap-2 mt-3">
                  <Button
                    className="flex-1 ui-btn-primary h-10 text-sm font-bold"
                    loading={submitting || loading}
                    disabled={submitting || loading}
                    onClick={handleSubmitGrammarianNote}>
                    记录语法观察
                  </Button>
                </View>
              </View>

              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">语法官汇总</Text>
                {grammarSummary.length > 0 ? (
                  <View className="space-y-1.5">
                    {grammarSummary.slice(0, 6).map((row) => (
                      <View key={row.participantKey} className="flex items-center justify-between">
                        <Text className="text-sm text-foreground truncate pr-2">{row.participantName}</Text>
                        <Text className="text-xs text-primary font-semibold">{row.count} 条</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text className="text-xs text-muted-foreground">暂无语法官记录。</Text>
                )}
              </View>

              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">最近记录</Text>
                {grammarNotes.length > 0 ? (
                  <View className="space-y-2">
                    {grammarNotes.slice(0, 20).map((note) => (
                      <View key={note.id} className="ui-panel-sharp p-2.5">
                        <View className="flex items-center justify-between gap-2">
                          <Text className="text-xs text-primary font-semibold">
                            {GRAMMAR_NOTE_TYPE_LABELS[note.note_type]} ·{' '}
                            {participantNameMap.get(note.participant_key) || note.participant_key}
                          </Text>
                          <Text className="text-[11px] text-muted-foreground">{formatTimeLabel(note.created_at)}</Text>
                        </View>
                        <Text className="text-sm text-foreground mt-1 break-all">{note.content}</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text className="text-xs text-muted-foreground">暂无记录。</Text>
                )}
              </View>
            </View>
          ) : (
            <View className="space-y-3">
              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">常用哼哈词</Text>
                <View className="flex flex-wrap gap-2">
                  {COMMON_FILLER_WORDS.map((word) => (
                    <View
                      key={word}
                      className="h-8 px-3 rounded-full bg-secondary/70 border border-border/70 flex items-center justify-center active:bg-secondary/85"
                      onClick={() => setFillerWord(word)}>
                      <Text className="text-xs text-foreground font-semibold">{word}</Text>
                    </View>
                  ))}
                </View>
                <Text className="text-[11px] text-muted-foreground mt-2">
                  说明：当前版本把“长停顿”作为一种记录词；后续可升级为独立类型字段。
                </Text>
              </View>

              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-1 uppercase tracking-wider">
                  哼哈词 / 停顿标签
                </Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm"
                  value={fillerWord}
                  onInput={(e) => setFillerWord(e.detail.value)}
                  placeholder="例如：嗯 / 然后 / 长停顿"
                  adjustPosition={false}
                />

                <Text className="text-xs text-muted-foreground block mt-3 mb-1 uppercase tracking-wider">次数</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm"
                  type="number"
                  value={hitCountText}
                  onInput={(e) => setHitCountText(e.detail.value)}
                  placeholder="请输入次数"
                  adjustPosition={false}
                />

                <Text className="text-xs text-muted-foreground block mt-3 mb-1 uppercase tracking-wider">
                  示例句（可选）
                </Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm"
                  value={sampleQuote}
                  onInput={(e) => setSampleQuote(e.detail.value)}
                  placeholder="可记录触发片段，便于会后反馈"
                  adjustPosition={false}
                />

                <Button
                  className="w-full ui-btn-primary h-10 text-sm font-bold mt-3"
                  loading={submitting || loading}
                  disabled={submitting || loading}
                  onClick={handleSubmitAhRecord}>
                  记录哼哈观察
                </Button>
              </View>

              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">哼哈官汇总</Text>
                {ahSummary.length > 0 ? (
                  <View className="space-y-1.5">
                    {ahSummary.slice(0, 6).map((row) => (
                      <View key={row.participantKey} className="flex items-center justify-between">
                        <Text className="text-sm text-foreground truncate pr-2">{row.participantName}</Text>
                        <Text className="text-xs text-primary font-semibold">{row.totalHit} 次</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text className="text-xs text-muted-foreground">暂无哼哈记录。</Text>
                )}
              </View>

              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">最近记录</Text>
                {ahRecords.length > 0 ? (
                  <View className="space-y-2">
                    {ahRecords.slice(0, 20).map((record) => (
                      <View key={record.id} className="ui-panel-sharp p-2.5">
                        <View className="flex items-center justify-between gap-2">
                          <Text className="text-xs text-primary font-semibold">
                            {participantNameMap.get(record.participant_key) || record.participant_key}
                          </Text>
                          <Text className="text-[11px] text-muted-foreground">
                            {formatTimeLabel(record.created_at)}
                          </Text>
                        </View>
                        <Text className="text-sm text-foreground mt-1">
                          {record.filler_word} × {record.hit_count}
                        </Text>
                        {record.sample_quote && (
                          <Text className="text-xs text-muted-foreground mt-1 break-all">
                            示例：{record.sample_quote}
                          </Text>
                        )}
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text className="text-xs text-muted-foreground">暂无记录。</Text>
                )}
              </View>
            </View>
          )}
        </View>
      </ScrollView>

      <View className="shrink-0 px-4 pt-2 pb-[max(env(safe-area-inset-bottom),12px)] bg-gradient-to-t from-background via-background/95 to-transparent border-t border-border/60">
        <Button
          className="ui-btn-secondary h-11 text-sm font-semibold"
          onClick={() => {
            Taro.navigateBack().catch(() => {
              void safeSwitchTab('/pages/history/index')
            })
          }}>
          返回计时页
        </Button>
      </View>
    </View>
  )
}
