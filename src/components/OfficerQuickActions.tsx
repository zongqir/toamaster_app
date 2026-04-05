import {Button, Input, ScrollView, Text, View} from '@tarojs/components'
import Taro, {useDidHide} from '@tarojs/taro'
import type {ReactNode} from 'react'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {supabase} from '@/client/supabase'
import {useAuth} from '@/contexts/AuthContext'
import {AgendaV2DatabaseService} from '@/db/agendaV2Database'
import type {
  AgendaMutationActor,
  AhCounterRecordV2,
  GrammarianNoteV2,
  GrammarNoteType,
  MeetingLiveCursorV2,
  MeetingParticipantV2,
  WordOfDayHitV2
} from '@/types/agendaV2'
import type {MeetingItem} from '@/types/meeting'
import {safeRemoveRealtimeChannel} from '@/utils/realtime'

const COMMON_FILLER_WORDS = ['嗯', '啊', '然后', '就是', '那个', '重复', '其实', '这个', '所以']
const GRAMMAR_NOTE_TYPE_LABELS: Record<GrammarNoteType, string> = {
  good_word: '好词',
  good_phrase: '好句',
  great_sentence: '金句',
  humorous_sentence: '幽默句',
  other_sentence: '其他句子',
  grammar_issue: '语法问题'
}
const GRAMMAR_NOTE_TYPES: GrammarNoteType[] = [
  'good_word',
  'good_phrase',
  'great_sentence',
  'humorous_sentence',
  'other_sentence',
  'grammar_issue'
]
const PENDING_KEY_PREFIX = 'AACTP_OFFICER_NOTES_PENDING:'
const SYNC_INTERVAL_MS = 5000

type PendingParticipantUpsertOp = {
  id: string
  kind: 'participant_upsert'
  participantKey: string
  displayName: string
  clientTs: number
}

type PendingGrammarNoteOp = {
  id: string
  kind: 'grammar_note'
  participantKey: string
  noteType: GrammarNoteType
  content: string
  relatedItemKey: string | null
  clientTs: number
}

type PendingAhDeltaOp = {
  id: string
  kind: 'ah_delta'
  participantKey: string
  fillerWord: string
  delta: number
  sampleQuote: string | null
  relatedItemKey: string | null
  clientTs: number
}

type PendingWordDeltaOp = {
  id: string
  kind: 'word_delta'
  participantKey: string
  wordText: string
  delta: number
  relatedItemKey: string | null
  clientTs: number
}

type PendingOfficerOp = PendingParticipantUpsertOp | PendingGrammarNoteOp | PendingAhDeltaOp | PendingWordDeltaOp

type OfficerQuickActionsProps = {
  meetingId: string
  items: MeetingItem[]
  wordOfTheDay?: string
  onUpdateWordOfDay?: (nextWordOfDay: string) => void | Promise<void>
  onStartTimer: () => void
}

type ParticipantOption = {
  key: string
  name: string
}

type SuggestedParticipantOption = ParticipantOption & {
  label: string
}

function createPendingOpId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeParticipantKey(name: string) {
  return name.trim()
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase()
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

function getStorageKey(meetingId: string) {
  return `${PENDING_KEY_PREFIX}${meetingId}`
}

function readPendingOps(meetingId: string): PendingOfficerOp[] {
  if (!meetingId) return []
  try {
    const value = Taro.getStorageSync(getStorageKey(meetingId))
    return Array.isArray(value) ? (value as PendingOfficerOp[]) : []
  } catch {
    return []
  }
}

function applyPendingGrammarNotes(
  remoteNotes: GrammarianNoteV2[],
  pendingOps: PendingOfficerOp[],
  observerName: string
) {
  const pendingNotes = pendingOps
    .filter((op): op is PendingGrammarNoteOp => op.kind === 'grammar_note')
    .map((op) => ({
      id: `pending-${op.id}`,
      meeting_id: '',
      participant_key: op.participantKey,
      note_type: op.noteType,
      content: op.content,
      related_item_key: op.relatedItemKey,
      observer_user_id: null,
      observer_name: observerName,
      observer_role: 'grammarian' as const,
      row_version: 0,
      created_at: op.clientTs,
      updated_at: op.clientTs,
      deleted_at: null
    }))

  return [...pendingNotes, ...remoteNotes].sort(
    (left, right) => Number(right.created_at || 0) - Number(left.created_at || 0)
  )
}

function applyPendingWordHits(remoteHits: WordOfDayHitV2[], pendingOps: PendingOfficerOp[]) {
  const map = new Map<string, WordOfDayHitV2>()
  remoteHits.forEach((hit) => {
    map.set(`${hit.participant_key}::${hit.word_text}`, {...hit})
  })

  pendingOps.forEach((op) => {
    if (op.kind !== 'word_delta') return
    const key = `${op.participantKey}::${op.wordText}`
    const existing = map.get(key)
    const nextHitCount = Math.max(0, Number(existing?.hit_count || 0) + Number(op.delta || 0))
    if (nextHitCount <= 0) {
      map.delete(key)
      return
    }

    if (existing) {
      map.set(key, {...existing, hit_count: nextHitCount, updated_at: op.clientTs})
      return
    }

    map.set(key, {
      id: `pending-${op.id}`,
      meeting_id: '',
      participant_key: op.participantKey,
      word_text: op.wordText,
      hit_count: nextHitCount,
      related_item_key: op.relatedItemKey,
      observer_user_id: null,
      observer_name: '会议官员',
      observer_role: 'grammarian',
      row_version: 0,
      created_at: op.clientTs,
      updated_at: op.clientTs,
      deleted_at: null
    })
  })

  return Array.from(map.values())
}

function applyPendingAhRecords(remoteRecords: AhCounterRecordV2[], pendingOps: PendingOfficerOp[]) {
  const map = new Map<string, AhCounterRecordV2>()
  remoteRecords.forEach((record) => {
    map.set(`${record.participant_key}::${record.filler_word}`, {...record})
  })

  pendingOps.forEach((op) => {
    if (op.kind !== 'ah_delta') return
    const key = `${op.participantKey}::${op.fillerWord}`
    const existing = map.get(key)
    const nextHitCount = Number(existing?.hit_count || 0) + Number(op.delta || 0)
    if (nextHitCount <= 0) {
      map.delete(key)
      return
    }

    if (existing) {
      map.set(key, {
        ...existing,
        hit_count: nextHitCount,
        sample_quote: op.sampleQuote?.trim() ? op.sampleQuote.trim() : (existing.sample_quote ?? null),
        related_item_key: op.relatedItemKey ?? existing.related_item_key ?? null,
        updated_at: op.clientTs
      })
      return
    }

    map.set(key, {
      id: `pending-${op.id}`,
      meeting_id: '',
      participant_key: op.participantKey,
      filler_word: op.fillerWord,
      hit_count: nextHitCount,
      sample_quote: op.sampleQuote?.trim() ? op.sampleQuote.trim() : null,
      related_item_key: op.relatedItemKey,
      observer_user_id: null,
      observer_name: '会议官员',
      observer_role: 'ah_counter',
      row_version: 0,
      created_at: op.clientTs,
      updated_at: op.clientTs,
      deleted_at: null
    })
  })

  return Array.from(map.values()).sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0))
}

function formatTimeLabel(ts?: number | null) {
  if (!ts) return '刚刚'
  const diffMs = Date.now() - Number(ts)
  const diffSec = Math.max(0, Math.round(diffMs / 1000))
  if (diffSec < 60) return `${diffSec || 1} 秒前`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 小时前`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay} 天前`
}

function findTopRow<T extends {total: number}>(rows: T[]) {
  if (rows.length === 0) return null
  return rows.reduce((best, current) => {
    if (!best) return current
    return current.total > best.total ? current : best
  }, rows[0] || null)
}

function FullscreenPanel({
  visible,
  title,
  subtitle,
  actionLabel,
  onAction,
  closeLabel = '关闭',
  onClose,
  children
}: {
  visible: boolean
  title: string
  subtitle?: string
  actionLabel?: string
  onAction?: () => void
  closeLabel?: string
  onClose: () => void
  children: ReactNode
}) {
  if (!visible) return null

  return (
    <View className="fixed inset-0 z-50 bg-black/65" onClick={onClose}>
      <View className="absolute inset-0 bg-background flex flex-col" onClick={(e) => e.stopPropagation()}>
        <View className="px-4 pt-8 pb-3 border-b border-border/60 bg-background/95">
          <View className="flex items-center justify-between gap-3">
            <View className="min-w-0 flex-1">
              <Text className="text-lg font-black text-foreground block">{title}</Text>
              {subtitle ? <Text className="text-xs text-muted-foreground block mt-1">{subtitle}</Text> : null}
            </View>
            <View className="flex items-center gap-2 shrink-0">
              {actionLabel && onAction ? (
                <Button className="ui-btn-secondary h-10 px-4 text-sm font-semibold" onClick={onAction}>
                  {actionLabel}
                </Button>
              ) : null}
              <Button className="ui-btn-secondary h-10 px-4 text-sm font-semibold" onClick={onClose}>
                {closeLabel}
              </Button>
            </View>
          </View>
        </View>
        <ScrollView className="flex-1 min-h-0" scrollY enableBackToTop>
          <View className="px-4 py-4 space-y-3">{children}</View>
        </ScrollView>
      </View>
    </View>
  )
}

function upsertParticipantOption(
  map: Map<string, string>,
  participantKey: string | null | undefined,
  displayName: string | null | undefined
) {
  const key = normalizeParticipantKey(participantKey || '')
  const name = (displayName || '').trim() || key
  if (!key) return
  if (!map.has(key)) {
    map.set(key, name)
  }
}

function findPreviousSuggestedParticipantKey(
  items: MeetingItem[],
  currentItemKey: string | null | undefined,
  currentParticipantKey: string
) {
  if (!currentItemKey) return ''
  const currentIndex = items.findIndex((item) => item.id === currentItemKey)
  if (currentIndex < 0) return ''

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const previousSpeaker = normalizeParticipantKey(items[index]?.speaker || '')
    if (!previousSpeaker || previousSpeaker === currentParticipantKey) continue
    return previousSpeaker
  }

  return ''
}

export default function OfficerQuickActions({
  meetingId,
  items,
  wordOfTheDay = '',
  onUpdateWordOfDay,
  onStartTimer
}: OfficerQuickActionsProps) {
  const {user, profile} = useAuth()
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

  const [showGrammarDrawer, setShowGrammarDrawer] = useState(false)
  const [showAhDrawer, setShowAhDrawer] = useState(false)
  const [grammarViewMode, setGrammarViewMode] = useState<'record' | 'global'>('record')
  const [ahViewMode, setAhViewMode] = useState<'record' | 'global'>('record')
  const [participantSearchText, setParticipantSearchText] = useState('')
  const [selectedParticipantKey, setSelectedParticipantKey] = useState('')
  const [grammarNoteType, setGrammarNoteType] = useState<GrammarNoteType>('good_word')
  const [grammarContent, setGrammarContent] = useState('')
  const [fillerWord, setFillerWord] = useState('')
  const [sampleQuote, setSampleQuote] = useState('')
  const [showWordOfDayEditor, setShowWordOfDayEditor] = useState(false)
  const [wordOfDayDraft, setWordOfDayDraft] = useState(wordOfTheDay)
  const [selectedAhWord, setSelectedAhWord] = useState('')
  const [pendingOps, setPendingOps] = useState<PendingOfficerOp[]>([])
  const [remoteParticipants, setRemoteParticipants] = useState<MeetingParticipantV2[]>([])
  const [remoteGrammarNotes, setRemoteGrammarNotes] = useState<GrammarianNoteV2[]>([])
  const [remoteAhRecords, setRemoteAhRecords] = useState<AhCounterRecordV2[]>([])
  const [remoteWordHits, setRemoteWordHits] = useState<WordOfDayHitV2[]>([])
  const [liveCursor, setLiveCursor] = useState<MeetingLiveCursorV2 | null>(null)
  const [syncMessage, setSyncMessage] = useState('')
  const pendingOpsRef = useRef<PendingOfficerOp[]>([])
  const flushBusyRef = useRef(false)

  const participantOptions = useMemo(() => {
    const map = new Map<string, string>()

    items.forEach((item) => {
      upsertParticipantOption(map, item.speaker, item.speaker)
    })

    remoteParticipants.forEach((participant) => {
      upsertParticipantOption(map, participant.participant_key, participant.display_name)
    })

    pendingOps.forEach((op) => {
      if (op.kind !== 'participant_upsert') return
      upsertParticipantOption(map, op.participantKey, op.displayName)
    })

    return Array.from(map.entries()).map(([key, name]) => ({key, name}))
  }, [items, pendingOps, remoteParticipants])

  const participantNameMap = useMemo(
    () => new Map(participantOptions.map((option) => [option.key, option.name])),
    [participantOptions]
  )
  const syncedParticipantKeySet = useMemo(
    () => new Set(remoteParticipants.map((participant) => participant.participant_key)),
    [remoteParticipants]
  )
  const filteredParticipantOptions = useMemo(() => {
    const keyword = normalizeSearchText(participantSearchText)
    if (!keyword) return participantOptions
    return participantOptions.filter((option) => normalizeSearchText(option.name).includes(keyword))
  }, [participantOptions, participantSearchText])
  const searchResultOptions = useMemo(() => filteredParticipantOptions.slice(0, 8), [filteredParticipantOptions])
  const trimmedParticipantSearchText = useMemo(() => participantSearchText.trim(), [participantSearchText])
  const canCreateParticipantFromSearch = useMemo(() => {
    if (!trimmedParticipantSearchText) return false
    return !participantOptions.some(
      (option) => normalizeParticipantKey(option.name).toLowerCase() === trimmedParticipantSearchText.toLowerCase()
    )
  }, [participantOptions, trimmedParticipantSearchText])
  const selectedParticipantName = useMemo(
    () => participantNameMap.get(selectedParticipantKey) || selectedParticipantKey,
    [participantNameMap, selectedParticipantKey]
  )
  const suggestedParticipantOptions = useMemo(() => {
    const currentItem = liveCursor?.current_item_key
      ? items.find((item) => item.id === liveCursor.current_item_key) || null
      : null
    const currentParticipantKey = normalizeParticipantKey(
      liveCursor?.current_participant_key || currentItem?.speaker || ''
    )
    const previousParticipantKey = findPreviousSuggestedParticipantKey(
      items,
      liveCursor?.current_item_key,
      currentParticipantKey
    )
    const suggestions: SuggestedParticipantOption[] = []
    const appendedKeys = new Set<string>()

    const appendSuggestion = (participantKey: string, label: string) => {
      const normalizedKey = normalizeParticipantKey(participantKey)
      if (!normalizedKey || appendedKeys.has(normalizedKey)) return
      suggestions.push({
        key: normalizedKey,
        name: participantNameMap.get(normalizedKey) || normalizedKey,
        label
      })
      appendedKeys.add(normalizedKey)
    }

    appendSuggestion(currentParticipantKey, '当前')
    appendSuggestion(previousParticipantKey, '上一位')
    return suggestions
  }, [items, liveCursor?.current_item_key, liveCursor?.current_participant_key, participantNameMap])
  const suggestedParticipantKeySet = useMemo(
    () => new Set(suggestedParticipantOptions.map((option) => option.key)),
    [suggestedParticipantOptions]
  )
  const quickPickOptions = useMemo(
    () => participantOptions.filter((option) => !suggestedParticipantKeySet.has(option.key)).slice(0, 8),
    [participantOptions, suggestedParticipantKeySet]
  )
  const mergedGrammarNotes = useMemo(
    () => applyPendingGrammarNotes(remoteGrammarNotes, pendingOps, actor.name || '会议官员'),
    [actor.name, pendingOps, remoteGrammarNotes]
  )
  const mergedAhRecords = useMemo(
    () => applyPendingAhRecords(remoteAhRecords, pendingOps),
    [pendingOps, remoteAhRecords]
  )
  const mergedWordHits = useMemo(() => applyPendingWordHits(remoteWordHits, pendingOps), [pendingOps, remoteWordHits])
  const normalizedWordOfTheDay = useMemo(() => normalizeSearchText(wordOfTheDay), [wordOfTheDay])
  const wordOfDaySummary = useMemo(() => {
    if (!normalizedWordOfTheDay) return [] as Array<{participantKey: string; participantName: string; total: number}>

    const summaryMap = new Map<string, number>()
    mergedWordHits.forEach((hit) => {
      if (normalizeSearchText(hit.word_text) !== normalizedWordOfTheDay) return
      summaryMap.set(hit.participant_key, (summaryMap.get(hit.participant_key) || 0) + Number(hit.hit_count || 0))
    })

    return Array.from(summaryMap.entries())
      .map(([participantKey, total]) => ({
        participantKey,
        participantName: participantNameMap.get(participantKey) || participantKey,
        total
      }))
      .sort((left, right) => {
        if (right.total !== left.total) return right.total - left.total
        return left.participantName.localeCompare(right.participantName)
      })
  }, [mergedWordHits, normalizedWordOfTheDay, participantNameMap])
  const selectedParticipantWordUsage = useMemo(() => {
    if (!normalizedWordOfTheDay || !selectedParticipantKey) return 0
    return wordOfDaySummary.find((row) => row.participantKey === selectedParticipantKey)?.total || 0
  }, [normalizedWordOfTheDay, selectedParticipantKey, wordOfDaySummary])
  const meetingWordUsageTotal = useMemo(() => {
    if (!normalizedWordOfTheDay) return 0
    return mergedWordHits
      .filter((hit) => normalizeSearchText(hit.word_text) === normalizedWordOfTheDay)
      .reduce((sum, hit) => sum + Number(hit.hit_count || 0), 0)
  }, [mergedWordHits, normalizedWordOfTheDay])
  const grammarSummaryRows = useMemo(() => {
    const summaryMap = new Map<
      string,
      {
        participantKey: string
        participantName: string
        total: number
        goodWord: number
        goodPhrase: number
        greatSentence: number
        humorousSentence: number
        otherSentence: number
        grammarIssue: number
        wordOfDayTotal: number
      }
    >()

    const ensureRow = (participantKey: string) => {
      const existing = summaryMap.get(participantKey)
      if (existing) return existing
      const created = {
        participantKey,
        participantName: participantNameMap.get(participantKey) || participantKey,
        total: 0,
        goodWord: 0,
        goodPhrase: 0,
        greatSentence: 0,
        humorousSentence: 0,
        otherSentence: 0,
        grammarIssue: 0,
        wordOfDayTotal: 0
      }
      summaryMap.set(participantKey, created)
      return created
    }

    mergedGrammarNotes.forEach((note) => {
      const row = ensureRow(note.participant_key)
      row.total += 1
      switch (note.note_type) {
        case 'good_word':
          row.goodWord += 1
          break
        case 'good_phrase':
          row.goodPhrase += 1
          break
        case 'great_sentence':
          row.greatSentence += 1
          break
        case 'humorous_sentence':
          row.humorousSentence += 1
          break
        case 'other_sentence':
          row.otherSentence += 1
          break
        case 'grammar_issue':
          row.grammarIssue += 1
          break
        default:
          break
      }
    })

    wordOfDaySummary.forEach((row) => {
      const current = ensureRow(row.participantKey)
      current.wordOfDayTotal = row.total
    })

    return Array.from(summaryMap.values()).sort((left, right) => {
      if (right.total !== left.total) return right.total - left.total
      if (right.grammarIssue !== left.grammarIssue) return right.grammarIssue - left.grammarIssue
      return left.participantName.localeCompare(right.participantName)
    })
  }, [mergedGrammarNotes, participantNameMap, wordOfDaySummary])
  const grammarLeaders = useMemo(
    () => ({
      wordOfDay: findTopRow(wordOfDaySummary),
      greatSentence: findTopRow(
        grammarSummaryRows.map((row) => ({...row, total: row.greatSentence})).filter((row) => row.total > 0)
      ),
      humorousSentence: findTopRow(
        grammarSummaryRows.map((row) => ({...row, total: row.humorousSentence})).filter((row) => row.total > 0)
      ),
      grammarIssue: findTopRow(
        grammarSummaryRows.map((row) => ({...row, total: row.grammarIssue})).filter((row) => row.total > 0)
      )
    }),
    [grammarSummaryRows, wordOfDaySummary]
  )
  const selectedParticipantAhRecords = useMemo(() => {
    if (!selectedParticipantKey) return [] as AhCounterRecordV2[]
    return mergedAhRecords.filter((record) => record.participant_key === selectedParticipantKey)
  }, [mergedAhRecords, selectedParticipantKey])
  const ahWordSummary = useMemo(() => {
    const summaryMap = new Map<
      string,
      {
        fillerWord: string
        total: number
        participantCount: number
        lastUpdatedAt: number
      }
    >()
    const participantWordSet = new Map<string, Set<string>>()

    mergedAhRecords.forEach((record) => {
      const key = record.filler_word
      const existing = summaryMap.get(key)
      const nextTotal = Number(record.hit_count || 0)
      if (existing) {
        existing.total += nextTotal
        existing.lastUpdatedAt = Math.max(existing.lastUpdatedAt, Number(record.updated_at || record.created_at || 0))
      } else {
        summaryMap.set(key, {
          fillerWord: key,
          total: nextTotal,
          participantCount: 0,
          lastUpdatedAt: Number(record.updated_at || record.created_at || 0)
        })
      }

      const wordSet = participantWordSet.get(key) || new Set<string>()
      wordSet.add(record.participant_key)
      participantWordSet.set(key, wordSet)
    })

    return Array.from(summaryMap.values())
      .map((row) => ({
        ...row,
        participantCount: participantWordSet.get(row.fillerWord)?.size || 0
      }))
      .sort((left, right) => {
        if (right.total !== left.total) return right.total - left.total
        return left.fillerWord.localeCompare(right.fillerWord)
      })
  }, [mergedAhRecords])
  const ahSummaryRows = useMemo(() => {
    const summaryMap = new Map<
      string,
      {
        participantKey: string
        participantName: string
        total: number
        commonWordCounts: Record<string, number>
        otherCount: number
        topWord: string
        topWordCount: number
        words: Array<{word: string; count: number; sampleQuote: string | null; updatedAt: number}>
      }
    >()

    mergedAhRecords.forEach((record) => {
      const key = record.participant_key
      const existing = summaryMap.get(key) || {
        participantKey: key,
        participantName: participantNameMap.get(key) || key,
        total: 0,
        commonWordCounts: COMMON_FILLER_WORDS.reduce(
          (counts, word) => ({...counts, [word]: 0}),
          {} as Record<string, number>
        ),
        otherCount: 0,
        topWord: '',
        topWordCount: 0,
        words: [] as Array<{word: string; count: number; sampleQuote: string | null; updatedAt: number}>
      }

      const hitCount = Number(record.hit_count || 0)
      existing.total += hitCount
      if (COMMON_FILLER_WORDS.includes(record.filler_word)) {
        existing.commonWordCounts[record.filler_word] = (existing.commonWordCounts[record.filler_word] || 0) + hitCount
      } else {
        existing.otherCount += hitCount
      }

      existing.words.push({
        word: record.filler_word,
        count: hitCount,
        sampleQuote: record.sample_quote?.trim() ? record.sample_quote.trim() : null,
        updatedAt: Number(record.updated_at || record.created_at || 0)
      })

      if (hitCount > existing.topWordCount) {
        existing.topWord = record.filler_word
        existing.topWordCount = hitCount
      }

      summaryMap.set(key, existing)
    })

    return Array.from(summaryMap.values())
      .map((row) => ({
        ...row,
        words: [...row.words].sort((left, right) => {
          if (right.count !== left.count) return right.count - left.count
          return left.word.localeCompare(right.word)
        })
      }))
      .sort((left, right) => {
        if (right.total !== left.total) return right.total - left.total
        return left.participantName.localeCompare(right.participantName)
      })
  }, [mergedAhRecords, participantNameMap])
  const ahLeaders = useMemo(
    () => ({
      participant: findTopRow(ahSummaryRows),
      fillerWord: findTopRow(ahWordSummary)
    }),
    [ahSummaryRows, ahWordSummary]
  )
  const selectedParticipantGrammarNotes = useMemo(
    () => mergedGrammarNotes.filter((note) => note.participant_key === selectedParticipantKey),
    [mergedGrammarNotes, selectedParticipantKey]
  )

  useEffect(() => {
    pendingOpsRef.current = pendingOps
  }, [pendingOps])

  useEffect(() => {
    if (showWordOfDayEditor) return
    setWordOfDayDraft(wordOfTheDay)
  }, [showWordOfDayEditor, wordOfTheDay])

  useEffect(() => {
    if (!meetingId) return
    const restored = readPendingOps(meetingId)
    setPendingOps(restored)
    pendingOpsRef.current = restored
  }, [meetingId])

  useEffect(() => {
    if (!meetingId) return
    if (pendingOps.length > 0) {
      Taro.setStorageSync(getStorageKey(meetingId), pendingOps)
    } else {
      Taro.removeStorageSync(getStorageKey(meetingId))
    }
  }, [meetingId, pendingOps])

  useEffect(() => {
    if (selectedParticipantKey) return
    if (suggestedParticipantOptions.length > 0) {
      setSelectedParticipantKey(suggestedParticipantOptions[0].key)
      return
    }
    if (participantOptions.length > 0) {
      setSelectedParticipantKey(participantOptions[0].key)
    }
  }, [participantOptions, selectedParticipantKey, suggestedParticipantOptions])

  useEffect(() => {
    if (showGrammarDrawer) return
    setShowWordOfDayEditor(false)
    setGrammarViewMode('record')
  }, [showGrammarDrawer])

  useEffect(() => {
    if (showAhDrawer) return
    setAhViewMode('record')
  }, [showAhDrawer])

  useEffect(() => {
    if (!selectedParticipantAhRecords.length) {
      setSelectedAhWord('')
      return
    }
    if (!selectedAhWord || !selectedParticipantAhRecords.some((record) => record.filler_word === selectedAhWord)) {
      setSelectedAhWord(selectedParticipantAhRecords[0].filler_word)
    }
  }, [selectedAhWord, selectedParticipantAhRecords])

  useEffect(() => {
    let active = true
    if (!meetingId) return
    void AgendaV2DatabaseService.getLiveCursor(meetingId).then((result) => {
      if (!active || !result.success) return
      setLiveCursor(result.data || null)
    })
    void AgendaV2DatabaseService.listParticipants(meetingId).then((result) => {
      if (!active || !result.success) return
      setRemoteParticipants(result.data || [])
    })
    void AgendaV2DatabaseService.listGrammarianNotes(meetingId).then((result) => {
      if (!active || !result.success) return
      setRemoteGrammarNotes(result.data || [])
    })
    void AgendaV2DatabaseService.listAhCounterRecords(meetingId).then((result) => {
      if (!active || !result.success) return
      setRemoteAhRecords(result.data || [])
    })
    void AgendaV2DatabaseService.listWordOfDayHits(meetingId).then((result) => {
      if (!active || !result.success) return
      setRemoteWordHits(result.data || [])
    })
    return () => {
      active = false
    }
  }, [meetingId])

  const queuePendingOp = useCallback((op: PendingOfficerOp) => {
    setPendingOps((prev) => {
      const next = [...prev, op]
      pendingOpsRef.current = next
      return next
    })
  }, [])

  const ensureParticipantQueued = useCallback(
    (participantKey: string, displayName: string) => {
      if (!participantKey || syncedParticipantKeySet.has(participantKey)) return
      queuePendingOp({
        id: createPendingOpId('participant'),
        kind: 'participant_upsert',
        participantKey,
        displayName,
        clientTs: Date.now()
      })
    },
    [queuePendingOp, syncedParticipantKeySet]
  )

  const refreshRemoteMeetingData = useCallback(() => {
    if (!meetingId) return
    void AgendaV2DatabaseService.getLiveCursor(meetingId).then((result) => {
      if (result.success) {
        setLiveCursor(result.data || null)
      }
    })
    void AgendaV2DatabaseService.listParticipants(meetingId).then((result) => {
      if (result.success) {
        setRemoteParticipants(result.data || [])
      }
    })
    void AgendaV2DatabaseService.listGrammarianNotes(meetingId).then((result) => {
      if (result.success) {
        setRemoteGrammarNotes(result.data || [])
      }
    })
    void AgendaV2DatabaseService.listAhCounterRecords(meetingId).then((result) => {
      if (result.success) {
        setRemoteAhRecords(result.data || [])
      }
    })
    void AgendaV2DatabaseService.listWordOfDayHits(meetingId).then((result) => {
      if (result.success) {
        setRemoteWordHits(result.data || [])
      }
    })
  }, [meetingId])

  const flushPendingOps = useCallback(async () => {
    if (!meetingId || flushBusyRef.current) return
    const snapshot = pendingOpsRef.current
    if (snapshot.length === 0) return

    const successfulIds = new Set<string>()
    let shouldStop = false
    flushBusyRef.current = true

    try {
      const participantGroups = new Map<string, {ids: string[]; participantKey: string; displayName: string}>()
      const ahGroups = new Map<
        string,
        {
          ids: string[]
          participantKey: string
          fillerWord: string
          delta: number
          sampleQuote: string | null
          relatedItemKey: string | null
        }
      >()
      const wordGroups = new Map<
        string,
        {
          ids: string[]
          participantKey: string
          wordText: string
          delta: number
          relatedItemKey: string | null
        }
      >()
      const grammarQueue: PendingGrammarNoteOp[] = []

      snapshot.forEach((op) => {
        if (op.kind === 'participant_upsert') {
          const existing = participantGroups.get(op.participantKey)
          if (existing) {
            existing.ids.push(op.id)
            existing.displayName = op.displayName || existing.displayName
          } else {
            participantGroups.set(op.participantKey, {
              ids: [op.id],
              participantKey: op.participantKey,
              displayName: op.displayName
            })
          }
          return
        }

        if (op.kind === 'ah_delta') {
          const key = `${op.participantKey}::${op.fillerWord}`
          const existing = ahGroups.get(key)
          if (existing) {
            existing.ids.push(op.id)
            existing.delta += op.delta
            existing.sampleQuote = op.sampleQuote?.trim() ? op.sampleQuote.trim() : existing.sampleQuote
            existing.relatedItemKey = op.relatedItemKey ?? existing.relatedItemKey
          } else {
            ahGroups.set(key, {
              ids: [op.id],
              participantKey: op.participantKey,
              fillerWord: op.fillerWord,
              delta: op.delta,
              sampleQuote: op.sampleQuote?.trim() ? op.sampleQuote.trim() : null,
              relatedItemKey: op.relatedItemKey
            })
          }
          return
        }

        if (op.kind === 'word_delta') {
          const key = `${op.participantKey}::${op.wordText}`
          const existing = wordGroups.get(key)
          if (existing) {
            existing.ids.push(op.id)
            existing.delta += op.delta
            existing.relatedItemKey = op.relatedItemKey ?? existing.relatedItemKey
          } else {
            wordGroups.set(key, {
              ids: [op.id],
              participantKey: op.participantKey,
              wordText: op.wordText,
              delta: op.delta,
              relatedItemKey: op.relatedItemKey
            })
          }
          return
        }

        grammarQueue.push(op)
      })

      const execute = async (task: () => Promise<{success: boolean; error?: string}>, ids: string[]) => {
        const result = await task()
        if (!result.success) {
          setSyncMessage(result.error || '后台同步失败')
          shouldStop = true
          return false
        }
        ids.forEach((id) => {
          successfulIds.add(id)
        })
        return true
      }

      for (const group of participantGroups.values()) {
        const ok = await execute(async () => {
          const result = await AgendaV2DatabaseService.upsertParticipant({
            meetingId,
            participantKey: group.participantKey,
            displayName: group.displayName,
            roleTags: ['speaker'],
            actor
          })
          return {success: result.success, error: result.error}
        }, group.ids)
        if (!ok) break
      }

      if (!shouldStop) {
        for (const group of ahGroups.values()) {
          const ok = await execute(async () => {
            const result = await AgendaV2DatabaseService.adjustAhCounterRecordByWord({
              meetingId,
              participantKey: group.participantKey,
              fillerWord: group.fillerWord,
              delta: group.delta,
              sampleQuote: group.sampleQuote,
              relatedItemKey: group.relatedItemKey,
              actor
            })
            return {success: result.success, error: result.error}
          }, group.ids)
          if (!ok) break
        }
      }

      if (!shouldStop) {
        for (const group of wordGroups.values()) {
          const ok = await execute(async () => {
            const result = await AgendaV2DatabaseService.adjustWordOfDayHit({
              meetingId,
              participantKey: group.participantKey,
              wordText: group.wordText,
              delta: group.delta,
              relatedItemKey: group.relatedItemKey,
              actor
            })
            return {success: result.success, error: result.error}
          }, group.ids)
          if (!ok) break
        }
      }

      if (!shouldStop) {
        for (const op of grammarQueue) {
          const ok = await execute(async () => {
            const result = await AgendaV2DatabaseService.createGrammarianNote({
              meetingId,
              participantKey: op.participantKey,
              noteType: op.noteType,
              content: op.content,
              relatedItemKey: op.relatedItemKey,
              actor
            })
            return {success: result.success, error: result.error}
          }, [op.id])
          if (!ok) break
        }
      }

      if (successfulIds.size > 0) {
        setPendingOps((current) => {
          const next = current.filter((op) => !successfulIds.has(op.id))
          pendingOpsRef.current = next
          return next
        })
        setSyncMessage('')
        refreshRemoteMeetingData()
      }
    } finally {
      flushBusyRef.current = false
    }
  }, [actor, meetingId, refreshRemoteMeetingData])

  useEffect(() => {
    if (!meetingId) return
    const timer = setInterval(() => {
      void flushPendingOps()
    }, SYNC_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [flushPendingOps, meetingId])

  useEffect(() => {
    if (!meetingId) return
    const channel = supabase
      .channel(`officer-quick-actions-live-${meetingId}`)
      .on(
        'postgres_changes',
        {event: '*', schema: 'public', table: 'meeting_live_cursor_v2', filter: `meeting_id=eq.${meetingId}`},
        () => {
          void AgendaV2DatabaseService.getLiveCursor(meetingId).then((result) => {
            if (result.success) {
              setLiveCursor(result.data || null)
            }
          })
        }
      )
      .subscribe()

    return () => {
      void safeRemoveRealtimeChannel(channel)
    }
  }, [meetingId])

  useEffect(() => {
    return () => {
      void flushPendingOps()
    }
  }, [flushPendingOps])

  useDidHide(() => {
    void flushPendingOps()
  })

  const handleCreateParticipantFromSearch = useCallback(() => {
    const displayName = trimmedParticipantSearchText
    const participantKey = normalizeParticipantKey(displayName)
    if (!participantKey) {
      Taro.showToast({title: '请输入人名', icon: 'none'})
      return
    }

    setSelectedParticipantKey(participantKey)
    setParticipantSearchText('')
    ensureParticipantQueued(participantKey, displayName)
    Taro.showToast({title: '已添加人名', icon: 'success'})
  }, [ensureParticipantQueued, trimmedParticipantSearchText])

  const handleSaveWordOfDay = useCallback(async () => {
    const nextWordOfDay = wordOfDayDraft.trim()
    if (!nextWordOfDay) {
      Taro.showToast({title: '请输入每日一词', icon: 'none'})
      return
    }

    await Promise.resolve(onUpdateWordOfDay?.(nextWordOfDay))
    setShowWordOfDayEditor(false)
    Taro.showToast({title: '每日一词已更新', icon: 'success'})
  }, [onUpdateWordOfDay, wordOfDayDraft])

  const handleQueueGrammar = useCallback(() => {
    if (!selectedParticipantKey) {
      Taro.showToast({title: '请先选择人名', icon: 'none'})
      return
    }
    if (!grammarContent.trim()) {
      Taro.showToast({title: '请输入记录内容', icon: 'none'})
      return
    }

    ensureParticipantQueued(selectedParticipantKey, selectedParticipantName || selectedParticipantKey)
    queuePendingOp({
      id: createPendingOpId('grammar'),
      kind: 'grammar_note',
      participantKey: selectedParticipantKey,
      noteType: grammarNoteType,
      content: grammarContent.trim(),
      relatedItemKey: null,
      clientTs: Date.now()
    })
    setGrammarContent('')
    Taro.showToast({title: '已记录', icon: 'success'})
  }, [
    ensureParticipantQueued,
    grammarContent,
    grammarNoteType,
    queuePendingOp,
    selectedParticipantKey,
    selectedParticipantName
  ])

  const handleQueueAh = useCallback(
    (word: string, nextSampleQuote?: string) => {
      const normalizedWord = word.trim()
      if (!selectedParticipantKey) {
        Taro.showToast({title: '请先选择人名', icon: 'none'})
        return
      }
      if (!normalizedWord) {
        Taro.showToast({title: '请输入哼哈词', icon: 'none'})
        return
      }

      ensureParticipantQueued(selectedParticipantKey, selectedParticipantName || selectedParticipantKey)
      setSelectedAhWord(normalizedWord)
      queuePendingOp({
        id: createPendingOpId('ah'),
        kind: 'ah_delta',
        participantKey: selectedParticipantKey,
        fillerWord: normalizedWord,
        delta: 1,
        sampleQuote: nextSampleQuote?.trim() ? nextSampleQuote.trim() : null,
        relatedItemKey: null,
        clientTs: Date.now()
      })
      setFillerWord('')
      setSampleQuote('')
      Taro.showToast({title: `${normalizedWord} +1`, icon: 'success'})
    },
    [ensureParticipantQueued, queuePendingOp, selectedParticipantKey, selectedParticipantName]
  )

  const handleDecrementAhRecord = useCallback(
    (record: AhCounterRecordV2) => {
      if (!record?.participant_key || !record?.filler_word) return
      ensureParticipantQueued(record.participant_key, selectedParticipantName || record.participant_key)
      setSelectedAhWord(record.filler_word)
      queuePendingOp({
        id: createPendingOpId('ah'),
        kind: 'ah_delta',
        participantKey: record.participant_key,
        fillerWord: record.filler_word,
        delta: -1,
        sampleQuote: null,
        relatedItemKey: record.related_item_key ?? null,
        clientTs: Date.now()
      })
      Taro.showToast({title: `${record.filler_word} -1`, icon: 'success'})
    },
    [ensureParticipantQueued, queuePendingOp, selectedParticipantName]
  )

  const handleQueueWordDelta = useCallback(
    (delta: 1 | -1) => {
      if (!wordOfTheDay.trim()) {
        Taro.showToast({title: '请先设置每日一词', icon: 'none'})
        return
      }
      if (!selectedParticipantKey) {
        Taro.showToast({title: '请先选择人名', icon: 'none'})
        return
      }
      if (delta < 0 && selectedParticipantWordUsage <= 0) {
        Taro.showToast({title: '当前人名暂无可回退次数', icon: 'none'})
        return
      }

      ensureParticipantQueued(selectedParticipantKey, selectedParticipantName || selectedParticipantKey)
      queuePendingOp({
        id: createPendingOpId('word'),
        kind: 'word_delta',
        participantKey: selectedParticipantKey,
        wordText: wordOfTheDay.trim(),
        delta,
        relatedItemKey: null,
        clientTs: Date.now()
      })
      Taro.showToast({title: delta > 0 ? '每日一词 +1' : '每日一词 -1', icon: 'success'})
    },
    [
      ensureParticipantQueued,
      queuePendingOp,
      selectedParticipantKey,
      selectedParticipantName,
      selectedParticipantWordUsage,
      wordOfTheDay
    ]
  )

  const renderParticipantSelector = useCallback(
    (hint?: string) => (
      <View className="ui-panel-sharp px-3 py-3">
        <View className="flex items-center justify-between gap-2">
          <Text className="text-[10px] uppercase tracking-wider text-muted-foreground">人名</Text>
          {selectedParticipantName ? (
            <Text className="text-[11px] text-foreground truncate">{selectedParticipantName}</Text>
          ) : null}
        </View>

        {!trimmedParticipantSearchText && suggestedParticipantOptions.length > 0 ? (
          <View className="mt-3">
            <Text className="text-[10px] uppercase tracking-widest text-muted-foreground block">建议</Text>
            <View className="grid grid-cols-2 gap-2 mt-2">
              {suggestedParticipantOptions.map((option) => (
                <Button
                  key={`suggested-${option.key}`}
                  className={`h-auto min-h-[58px] rounded-2xl px-3 py-2 ${
                    selectedParticipantKey === option.key ? 'ui-btn-primary' : 'ui-btn-secondary'
                  }`}
                  onClick={() => setSelectedParticipantKey(option.key)}>
                  <View className="flex flex-col items-start text-left">
                    <Text
                      className={`text-[10px] uppercase tracking-widest ${
                        selectedParticipantKey === option.key ? 'text-white/75' : 'text-muted-foreground'
                      }`}>
                      {option.label}
                    </Text>
                    <Text
                      className={`text-sm font-semibold mt-1 break-all ${
                        selectedParticipantKey === option.key ? 'text-white' : 'text-foreground'
                      }`}>
                      {option.name}
                    </Text>
                  </View>
                </Button>
              ))}
            </View>
          </View>
        ) : null}

        {trimmedParticipantSearchText ? (
          searchResultOptions.length > 0 ? (
            <View className="grid grid-cols-3 gap-2 mt-3">
              {searchResultOptions.map((option: ParticipantOption) => (
                <Button
                  key={option.key}
                  className={`h-10 rounded-xl text-xs font-semibold ${
                    selectedParticipantKey === option.key
                      ? 'ui-btn-primary text-white'
                      : 'ui-btn-secondary text-foreground'
                  }`}
                  onClick={() => setSelectedParticipantKey(option.key)}>
                  {option.name}
                </Button>
              ))}
            </View>
          ) : (
            <View className="rounded-xl bg-secondary/50 px-3 py-2 mt-3">
              <Text className="text-xs text-muted-foreground">
                {canCreateParticipantFromSearch ? '未找到匹配人名，可直接添加' : '未找到匹配人名'}
              </Text>
            </View>
          )
        ) : quickPickOptions.length > 0 ? (
          <View className="grid grid-cols-3 gap-2 mt-3">
            {quickPickOptions.map((option: ParticipantOption) => (
              <Button
                key={option.key}
                className={`h-10 rounded-xl text-xs font-semibold ${
                  selectedParticipantKey === option.key
                    ? 'ui-btn-primary text-white'
                    : 'ui-btn-secondary text-foreground'
                }`}
                onClick={() => setSelectedParticipantKey(option.key)}>
                {option.name}
              </Button>
            ))}
          </View>
        ) : suggestedParticipantOptions.length === 0 ? (
          <View className="rounded-xl bg-secondary/50 px-3 py-2 mt-3">
            <Text className="text-xs text-muted-foreground">暂无可选人名</Text>
          </View>
        ) : null}

        <Input
          className="ui-input rounded-xl px-3 py-2 text-sm mt-3"
          value={participantSearchText}
          onInput={(e) => setParticipantSearchText(e.detail.value)}
          placeholder="搜索或直接输入人名"
          adjustPosition={false}
        />

        {trimmedParticipantSearchText && canCreateParticipantFromSearch ? (
          <Button
            className="ui-btn-primary h-10 text-sm font-bold w-full mt-2"
            onClick={handleCreateParticipantFromSearch}>
            {`添加“${trimmedParticipantSearchText}”`}
          </Button>
        ) : null}

        {hint ? <Text className="text-xs text-muted-foreground block mt-2">{hint}</Text> : null}
      </View>
    ),
    [
      canCreateParticipantFromSearch,
      handleCreateParticipantFromSearch,
      participantSearchText,
      quickPickOptions,
      searchResultOptions,
      selectedParticipantKey,
      selectedParticipantName,
      suggestedParticipantOptions,
      trimmedParticipantSearchText
    ]
  )

  const actionButtonClass =
    'h-11 rounded-2xl border border-border/70 bg-secondary/70 flex items-center justify-center gap-2 active:bg-secondary/85'
  const panelHint = syncMessage || undefined
  const renderGrammarRecordView = () => (
    <>
      {renderParticipantSelector('可直接输入新的人名，添加后继续记录。')}

      <View className="ui-panel-sharp px-3 py-3">
        <View className="flex items-start justify-between gap-2">
          <View className="min-w-0 flex-1">
            <Text className="text-[10px] uppercase tracking-widest text-muted-foreground">每日一词</Text>
            <View className="flex items-center gap-2 mt-2 flex-wrap">
              <View className="rounded-full border border-primary/45 bg-primary/10 px-3 py-1.5">
                <Text className="text-sm font-black text-primary">{wordOfTheDay || '点击改词'}</Text>
              </View>
              <View className="rounded-full border border-border/50 bg-background/45 px-2.5 py-1">
                <Text className="text-[11px] font-medium text-muted-foreground">
                  {selectedParticipantName ? `当前：${selectedParticipantName}` : '未选人名'}
                </Text>
              </View>
            </View>
          </View>
          <Button
            className="ui-btn-secondary h-8 px-3 text-xs font-semibold shrink-0"
            onClick={() => {
              setWordOfDayDraft(wordOfTheDay || '')
              setShowWordOfDayEditor(true)
            }}>
            改词
          </Button>
        </View>

        <View className="rounded-2xl border border-border/60 bg-background/45 px-3 py-3 mt-3">
          <View className="flex items-center justify-between gap-3">
            <View className="grid grid-cols-2 gap-2 min-w-0 flex-1">
              <View className="rounded-2xl border border-border/50 bg-background/45 px-3 py-2.5 min-w-0">
                <Text className="text-[10px] uppercase tracking-widest text-muted-foreground block">本人</Text>
                <Text className="text-2xl font-black text-foreground block leading-none mt-1">
                  {selectedParticipantWordUsage}
                </Text>
              </View>
              <View className="rounded-2xl border border-border/50 bg-background/45 px-3 py-2.5 min-w-0">
                <Text className="text-[10px] uppercase tracking-widest text-muted-foreground block">全场</Text>
                <Text className="text-2xl font-black text-foreground block leading-none mt-1">
                  {meetingWordUsageTotal}
                </Text>
              </View>
            </View>
            <View className="flex items-center gap-2 shrink-0">
              <Button
                className="ui-btn-secondary h-11 px-4 text-sm font-bold rounded-full"
                onClick={() => handleQueueWordDelta(-1)}>
                -1
              </Button>
              <Button
                className="ui-btn-primary h-12 px-5 text-base font-black rounded-full shadow-xl"
                onClick={() => handleQueueWordDelta(1)}>
                +1
              </Button>
            </View>
          </View>
        </View>
      </View>

      <View className="ui-panel-sharp px-3 py-3">
        <Text className="text-[10px] uppercase tracking-wider text-muted-foreground block">记录类型</Text>
        <View className="grid grid-cols-2 gap-2 mt-3">
          {GRAMMAR_NOTE_TYPES.map((noteType) => (
            <Button
              key={noteType}
              className={`h-10 rounded-xl text-xs font-semibold ${
                grammarNoteType === noteType ? 'ui-btn-primary text-white' : 'ui-btn-secondary text-foreground'
              }`}
              onClick={() => setGrammarNoteType(noteType)}>
              {GRAMMAR_NOTE_TYPE_LABELS[noteType]}
            </Button>
          ))}
        </View>
        <Input
          className="ui-input rounded-xl px-3 py-2 text-sm mt-3"
          value={grammarContent}
          onInput={(e) => setGrammarContent(e.detail.value)}
          placeholder="输入好词好句、幽默句或语法问题"
          adjustPosition={false}
        />
        <Button className="ui-btn-primary h-11 text-sm font-bold w-full mt-3" onClick={handleQueueGrammar}>
          记录即可
        </Button>
      </View>
    </>
  )
  const renderGrammarGlobalView = () => (
    <>
      <View className="ui-panel-sharp px-3 py-3">
        <Text className="text-[10px] uppercase tracking-widest text-muted-foreground block">统计摘要</Text>
        <View className="grid grid-cols-2 gap-2 mt-3">
          <View className="rounded-2xl border border-border/60 bg-background/50 px-3 py-3">
            <Text className="text-[10px] uppercase tracking-wider text-muted-foreground block">每日一词最多</Text>
            <Text className="text-base font-black text-foreground block mt-1">
              {grammarLeaders.wordOfDay ? grammarLeaders.wordOfDay.participantName : '暂无'}
            </Text>
            <Text className="text-xs text-primary block mt-1">
              {grammarLeaders.wordOfDay ? `${grammarLeaders.wordOfDay.total} 次` : '等待记录'}
            </Text>
          </View>
          <View className="rounded-2xl border border-border/60 bg-background/50 px-3 py-3">
            <Text className="text-[10px] uppercase tracking-wider text-muted-foreground block">金句最多</Text>
            <Text className="text-base font-black text-foreground block mt-1">
              {grammarLeaders.greatSentence ? grammarLeaders.greatSentence.participantName : '暂无'}
            </Text>
            <Text className="text-xs text-primary block mt-1">
              {grammarLeaders.greatSentence ? `${grammarLeaders.greatSentence.total} 条` : '等待记录'}
            </Text>
          </View>
          <View className="rounded-2xl border border-border/60 bg-background/50 px-3 py-3">
            <Text className="text-[10px] uppercase tracking-wider text-muted-foreground block">幽默句最多</Text>
            <Text className="text-base font-black text-foreground block mt-1">
              {grammarLeaders.humorousSentence ? grammarLeaders.humorousSentence.participantName : '暂无'}
            </Text>
            <Text className="text-xs text-primary block mt-1">
              {grammarLeaders.humorousSentence ? `${grammarLeaders.humorousSentence.total} 条` : '等待记录'}
            </Text>
          </View>
          <View className="rounded-2xl border border-border/60 bg-background/50 px-3 py-3">
            <Text className="text-[10px] uppercase tracking-wider text-muted-foreground block">语病最多</Text>
            <Text className="text-base font-black text-foreground block mt-1">
              {grammarLeaders.grammarIssue ? grammarLeaders.grammarIssue.participantName : '暂无'}
            </Text>
            <Text className="text-xs text-primary block mt-1">
              {grammarLeaders.grammarIssue ? `${grammarLeaders.grammarIssue.total} 条` : '等待记录'}
            </Text>
          </View>
        </View>
      </View>

      <View className="ui-panel-sharp px-3 py-3">
        <View className="flex items-center justify-between gap-2 mb-3">
          <Text className="text-[10px] uppercase tracking-widest text-muted-foreground">按人汇总</Text>
          <Text className="text-[11px] text-muted-foreground">点某人可切换下方明细</Text>
        </View>
        {grammarSummaryRows.length > 0 ? (
          <View className="space-y-2">
            {grammarSummaryRows.map((row) => (
              <View
                key={row.participantKey}
                className={`rounded-2xl border px-3 py-3 ${
                  selectedParticipantKey === row.participantKey
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border/60 bg-background/55'
                }`}
                onClick={() => setSelectedParticipantKey(row.participantKey)}>
                <View className="flex items-center justify-between gap-3">
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-black text-foreground block truncate">{row.participantName}</Text>
                    <Text className="text-[11px] text-muted-foreground block mt-1">
                      总记录 {row.total} · 每日一词 {row.wordOfDayTotal}
                    </Text>
                  </View>
                  <View className="rounded-full border border-border/60 bg-background/65 px-3 py-1.5">
                    <Text className="text-sm font-black text-primary">{row.total}</Text>
                  </View>
                </View>
                <View className="grid grid-cols-3 gap-2 mt-3">
                  <View className="rounded-xl bg-background/45 px-2 py-2">
                    <Text className="text-[10px] text-muted-foreground block">好词</Text>
                    <Text className="text-sm font-bold text-foreground block mt-1">{row.goodWord}</Text>
                  </View>
                  <View className="rounded-xl bg-background/45 px-2 py-2">
                    <Text className="text-[10px] text-muted-foreground block">好句</Text>
                    <Text className="text-sm font-bold text-foreground block mt-1">{row.goodPhrase}</Text>
                  </View>
                  <View className="rounded-xl bg-background/45 px-2 py-2">
                    <Text className="text-[10px] text-muted-foreground block">金句</Text>
                    <Text className="text-sm font-bold text-foreground block mt-1">{row.greatSentence}</Text>
                  </View>
                  <View className="rounded-xl bg-background/45 px-2 py-2">
                    <Text className="text-[10px] text-muted-foreground block">幽默句</Text>
                    <Text className="text-sm font-bold text-foreground block mt-1">{row.humorousSentence}</Text>
                  </View>
                  <View className="rounded-xl bg-background/45 px-2 py-2">
                    <Text className="text-[10px] text-muted-foreground block">其他句</Text>
                    <Text className="text-sm font-bold text-foreground block mt-1">{row.otherSentence}</Text>
                  </View>
                  <View className="rounded-xl bg-background/45 px-2 py-2">
                    <Text className="text-[10px] text-muted-foreground block">语法问题</Text>
                    <Text className="text-sm font-bold text-foreground block mt-1">{row.grammarIssue}</Text>
                  </View>
                </View>
                {selectedParticipantKey === row.participantKey ? (
                  <View className="mt-3 pt-3 border-t border-border/40 space-y-2">
                    <Text className="text-[10px] uppercase tracking-widest text-muted-foreground block">
                      句子与记录
                    </Text>
                    {selectedParticipantGrammarNotes.length > 0 ? (
                      selectedParticipantGrammarNotes.slice(0, 12).map((note) => (
                        <View
                          key={note.id}
                          className="rounded-2xl border border-border/60 bg-background/55 px-3 py-2.5">
                          <View className="flex items-center justify-between gap-2">
                            <Text className="text-xs font-semibold text-primary">
                              {GRAMMAR_NOTE_TYPE_LABELS[note.note_type]}
                            </Text>
                            <Text className="text-[11px] text-muted-foreground">
                              {formatTimeLabel(note.created_at)}
                            </Text>
                          </View>
                          <Text className="text-sm text-foreground block mt-1 break-all">{note.content}</Text>
                        </View>
                      ))
                    ) : (
                      <Text className="text-xs text-muted-foreground">这个人还没有具体句子记录。</Text>
                    )}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : (
          <Text className="text-xs text-muted-foreground">还没有语法官记录。</Text>
        )}
      </View>
    </>
  )
  const renderAhRecordView = () => (
    <>
      {renderParticipantSelector()}

      <View className="ui-panel-sharp px-3 py-3">
        <View className="flex items-center justify-between gap-2 mb-3">
          <Text className="text-[10px] uppercase tracking-wider text-muted-foreground">常用哼哈词</Text>
          <Text className="text-[11px] text-muted-foreground">点击直接 +1</Text>
        </View>
        <View className="grid grid-cols-3 gap-2">
          {COMMON_FILLER_WORDS.map((word) => (
            <Button
              key={word}
              className="ui-btn-secondary h-10 text-xs font-bold text-foreground"
              onClick={() => handleQueueAh(word)}>
              {`${word} +1`}
            </Button>
          ))}
        </View>
      </View>

      <View className="ui-panel-sharp px-3 py-3">
        <Text className="text-[10px] uppercase tracking-wider text-muted-foreground block">其他哼哈词</Text>
        <Input
          className="ui-input rounded-xl px-3 py-2 text-sm mt-3"
          value={fillerWord}
          onInput={(e) => setFillerWord(e.detail.value)}
          placeholder="输入其他哼哈词"
          adjustPosition={false}
        />
        <Text className="text-[10px] uppercase tracking-wider text-muted-foreground block mt-3">示例句</Text>
        <Input
          className="ui-input rounded-xl px-3 py-2 text-sm mt-2"
          value={sampleQuote}
          onInput={(e) => setSampleQuote(e.detail.value)}
          placeholder="可选，记录触发片段"
          adjustPosition={false}
        />
        <Button
          className="ui-btn-primary h-11 text-sm font-bold w-full mt-3"
          onClick={() => handleQueueAh(fillerWord, sampleQuote)}>
          记录即可
        </Button>
      </View>

      <View className="ui-panel-sharp px-3 py-3">
        <View className="flex items-center justify-between gap-2 mb-2">
          <Text className="text-[10px] uppercase tracking-wider text-muted-foreground">最近记录</Text>
          <Text className="text-[11px] text-muted-foreground">{selectedParticipantName || '未选择人名'}</Text>
        </View>
        {selectedParticipantAhRecords.length > 0 ? (
          <View className="space-y-2">
            {selectedParticipantAhRecords.slice(0, 6).map((record) => (
              <View
                key={record.id}
                className={`rounded-2xl border px-3 py-2.5 ${
                  selectedAhWord === record.filler_word
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border/60 bg-background/55'
                }`}
                onClick={() => setSelectedAhWord(record.filler_word)}>
                <View className="flex items-center justify-between gap-2">
                  <View className="min-w-0 flex-1">
                    <View className="flex items-center gap-2 flex-wrap">
                      <View className="rounded-full border border-border/50 bg-background/60 px-2.5 py-1">
                        <Text className="text-sm font-bold text-foreground break-all">{record.filler_word}</Text>
                      </View>
                      <Text className="text-[11px] text-muted-foreground">
                        最近更新 {formatTimeLabel(record.updated_at || record.created_at)}
                      </Text>
                    </View>
                    <Text className="text-[11px] text-muted-foreground block mt-1">次数 {record.hit_count}</Text>
                  </View>
                  <View className="flex items-center gap-2 shrink-0">
                    <Button
                      className="ui-btn-secondary h-8 px-3 text-xs font-bold"
                      onClick={() => handleDecrementAhRecord(record)}>
                      -1
                    </Button>
                  </View>
                </View>
                {record.sample_quote ? (
                  <Text className="text-xs text-muted-foreground block mt-1 break-all">
                    示例：{record.sample_quote}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : (
          <Text className="text-xs text-muted-foreground">
            {selectedParticipantKey ? '当前人名还没有哼哈记录。' : '请先选择人名。'}
          </Text>
        )}
      </View>
    </>
  )

  const renderAhGlobalView = () => (
    <>
      <View className="ui-panel-sharp px-3 py-3">
        <Text className="text-[10px] uppercase tracking-widest text-muted-foreground block">统计摘要</Text>
        <View className="grid grid-cols-2 gap-2 mt-3">
          <View className="rounded-2xl border border-border/60 bg-background/50 px-3 py-3">
            <Text className="text-[10px] uppercase tracking-wider text-muted-foreground block">全场哼哈最多</Text>
            <Text className="text-base font-black text-foreground block mt-1">
              {ahLeaders.participant ? ahLeaders.participant.participantName : '暂无'}
            </Text>
            <Text className="text-xs text-primary block mt-1">
              {ahLeaders.participant ? `${ahLeaders.participant.total} 次` : '等待记录'}
            </Text>
          </View>
          <View className="rounded-2xl border border-border/60 bg-background/50 px-3 py-3">
            <Text className="text-[10px] uppercase tracking-wider text-muted-foreground block">高频词第一</Text>
            <Text className="text-base font-black text-foreground block mt-1">
              {ahLeaders.fillerWord ? ahLeaders.fillerWord.fillerWord : '暂无'}
            </Text>
            <Text className="text-xs text-primary block mt-1">
              {ahLeaders.fillerWord ? `${ahLeaders.fillerWord.total} 次` : '等待记录'}
            </Text>
          </View>
        </View>
        {ahWordSummary.length > 0 ? (
          <View className="space-y-2 mt-3">
            {ahWordSummary.slice(0, 5).map((row, index) => (
              <View key={row.fillerWord} className="rounded-2xl border border-border/60 bg-background/55 px-3 py-2.5">
                <View className="flex items-center justify-between gap-3">
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-bold text-foreground block">
                      {index + 1}. {row.fillerWord}
                    </Text>
                    <Text className="text-[11px] text-muted-foreground block mt-1">涉及 {row.participantCount} 人</Text>
                  </View>
                  <Text className="text-base font-black text-primary">{row.total}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <View className="ui-panel-sharp px-3 py-3">
        <View className="flex items-center justify-between gap-2 mb-3">
          <Text className="text-[10px] uppercase tracking-widest text-muted-foreground">按人汇总</Text>
          <Text className="text-[11px] text-muted-foreground">点某人查看详情与回退依据</Text>
        </View>
        {ahSummaryRows.length > 0 ? (
          <View className="space-y-2">
            {ahSummaryRows.map((row) => (
              <View
                key={row.participantKey}
                className={`rounded-2xl border px-3 py-3 ${
                  selectedParticipantKey === row.participantKey
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border/60 bg-background/55'
                }`}
                onClick={() => setSelectedParticipantKey(row.participantKey)}>
                <View className="flex items-center justify-between gap-3">
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-black text-foreground block truncate">{row.participantName}</Text>
                    <Text className="text-[11px] text-muted-foreground block mt-1">
                      最高频词 {row.topWord || '暂无'}
                      {row.topWord ? ` · ${row.topWordCount} 次` : ''}
                    </Text>
                  </View>
                  <View className="rounded-full border border-border/60 bg-background/65 px-3 py-1.5">
                    <Text className="text-sm font-black text-primary">{row.total}</Text>
                  </View>
                </View>
                <View className="grid grid-cols-3 gap-2 mt-3">
                  {COMMON_FILLER_WORDS.map((word) => (
                    <View key={`${row.participantKey}-${word}`} className="rounded-xl bg-background/45 px-2 py-2">
                      <Text className="text-[10px] text-muted-foreground block">{word}</Text>
                      <Text className="text-sm font-bold text-foreground block mt-1">
                        {row.commonWordCounts[word] || 0}
                      </Text>
                    </View>
                  ))}
                  <View className="rounded-xl bg-background/45 px-2 py-2">
                    <Text className="text-[10px] text-muted-foreground block">其他</Text>
                    <Text className="text-sm font-bold text-foreground block mt-1">{row.otherCount}</Text>
                  </View>
                </View>
                {selectedParticipantKey === row.participantKey ? (
                  <View className="mt-3 pt-3 border-t border-border/40 space-y-2">
                    <Text className="text-[10px] uppercase tracking-widest text-muted-foreground block">
                      其他词明细
                    </Text>
                    {row.words.filter((wordRow) => !COMMON_FILLER_WORDS.includes(wordRow.word)).length > 0 ? (
                      row.words
                        .filter((wordRow) => !COMMON_FILLER_WORDS.includes(wordRow.word))
                        .map((wordRow) => (
                          <View
                            key={`${row.participantKey}-${wordRow.word}`}
                            className="rounded-2xl border border-border/60 bg-background/55 px-3 py-2.5">
                            <View className="flex items-center justify-between gap-2">
                              <View className="min-w-0 flex-1">
                                <Text className="text-sm font-bold text-foreground block break-all">
                                  {wordRow.word}
                                </Text>
                                <Text className="text-[11px] text-muted-foreground block mt-1">
                                  最近更新 {formatTimeLabel(wordRow.updatedAt)}
                                </Text>
                              </View>
                              <Text className="text-base font-black text-primary">{wordRow.count}</Text>
                            </View>
                            {wordRow.sampleQuote ? (
                              <Text className="text-xs text-muted-foreground block mt-1 break-all">
                                示例：{wordRow.sampleQuote}
                              </Text>
                            ) : null}
                          </View>
                        ))
                    ) : (
                      <Text className="text-xs text-muted-foreground">这个人没有其他哼哈词记录。</Text>
                    )}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : (
          <Text className="text-xs text-muted-foreground">还没有哼哈官记录。</Text>
        )}
      </View>
    </>
  )

  return (
    <>
      <View className="grid grid-cols-3 gap-2">
        <Button
          className="ui-btn-primary h-12 w-full text-sm font-bold rounded-2xl"
          onClick={() => {
            void flushPendingOps()
            onStartTimer()
          }}>
          <View className="i-mdi-play-circle text-xl mr-1" />
          开始计时
        </Button>
        <View className={actionButtonClass} onClick={() => setShowGrammarDrawer(true)}>
          <View className="i-mdi-alphabetical-variant text-base text-primary" />
          <Text className="text-xs font-semibold text-foreground">记录语法</Text>
        </View>
        <View className={actionButtonClass} onClick={() => setShowAhDrawer(true)}>
          <View className="i-mdi-message-badge-outline text-base text-primary" />
          <Text className="text-xs font-semibold text-foreground">记录哼哈</Text>
        </View>
      </View>

      <FullscreenPanel
        visible={showGrammarDrawer}
        title="语法记录"
        subtitle={panelHint}
        actionLabel={grammarViewMode === 'record' ? '统计' : undefined}
        onAction={grammarViewMode === 'record' ? () => setGrammarViewMode('global') : undefined}
        closeLabel={grammarViewMode === 'global' ? '返回' : '关闭'}
        onClose={() => {
          if (grammarViewMode === 'global') {
            setGrammarViewMode('record')
            return
          }
          setShowGrammarDrawer(false)
        }}>
        {grammarViewMode === 'record' ? renderGrammarRecordView() : renderGrammarGlobalView()}
      </FullscreenPanel>

      <FullscreenPanel
        visible={showAhDrawer}
        title="哼哈记录"
        subtitle={panelHint}
        actionLabel={ahViewMode === 'record' ? '统计' : undefined}
        onAction={ahViewMode === 'record' ? () => setAhViewMode('global') : undefined}
        closeLabel={ahViewMode === 'global' ? '返回' : '关闭'}
        onClose={() => {
          if (ahViewMode === 'global') {
            setAhViewMode('record')
            return
          }
          setShowAhDrawer(false)
        }}>
        {ahViewMode === 'record' ? renderAhRecordView() : renderAhGlobalView()}
      </FullscreenPanel>

      {showGrammarDrawer && showWordOfDayEditor ? (
        <View
          className="fixed inset-0 z-50 bg-black/55 flex items-center justify-center px-4"
          onClick={() => setShowWordOfDayEditor(false)}>
          <View className="ui-card-strong rounded-3xl w-full p-4" onClick={(e) => e.stopPropagation()}>
            <Text className="text-base font-black text-foreground block">修改每日一词</Text>
            <Text className="text-xs text-muted-foreground block mt-1">改完后直接继续点记，不占主记录区。</Text>
            <Input
              className="ui-input rounded-2xl px-3 py-2 text-sm mt-4"
              value={wordOfDayDraft}
              onInput={(e) => setWordOfDayDraft(e.detail.value)}
              placeholder="输入新的每日一词"
              adjustPosition={false}
            />
            <View className="grid grid-cols-2 gap-2 mt-4">
              <Button
                className="ui-btn-secondary h-11 text-sm font-semibold"
                onClick={() => setShowWordOfDayEditor(false)}>
                取消
              </Button>
              <Button className="ui-btn-primary h-11 text-sm font-bold" onClick={() => void handleSaveWordOfDay()}>
                保存
              </Button>
            </View>
          </View>
        </View>
      ) : null}
    </>
  )
}
