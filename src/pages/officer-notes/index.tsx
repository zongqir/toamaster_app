import {Button, Input, ScrollView, Text, View} from '@tarojs/components'
import Taro, {useDidHide, useDidShow} from '@tarojs/taro'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {supabase} from '@/client/supabase'
import {useAuth} from '@/contexts/AuthContext'
import {AgendaV2DatabaseService} from '@/db/agendaV2Database'
import {DatabaseService} from '@/db/database'
import {StorageService} from '@/services/storage'
import {useMeetingStore} from '@/store/meetingStore'
import type {
  AgendaMutationActor,
  AhCounterRecordV2,
  GrammarianNoteV2,
  GrammarNoteType,
  MeetingLiveCursorV2,
  WordOfDayHitV2
} from '@/types/agendaV2'
import type {MeetingItem} from '@/types/meeting'
import {safeRemoveRealtimeChannel} from '@/utils/realtime'
import {safeSwitchTab} from '@/utils/safeNavigation'

type OfficerTab = 'grammarian' | 'ah_counter'

type ParticipantOption = {
  key: string
  name: string
  agendaOrder: number | null
  source: 'agenda' | 'db' | 'both'
}

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
const COMMON_FILLER_WORDS = ['嗯', '啊', '然后', '就是', '那个', '长停顿']
const OFFICER_PENDING_OPS_KEY_PREFIX = 'AACTP_OFFICER_NOTES_PENDING:'
const OFFICER_SYNC_INTERVAL_MS = 5000

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

function createPendingOpId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function getOfficerPendingOpsStorageKey(meetingId: string) {
  return `${OFFICER_PENDING_OPS_KEY_PREFIX}${meetingId}`
}

function readPendingOfficerOps(meetingId: string): PendingOfficerOp[] {
  if (!meetingId) return []
  try {
    const data = Taro.getStorageSync(getOfficerPendingOpsStorageKey(meetingId))
    return Array.isArray(data) ? (data as PendingOfficerOp[]) : []
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
      observer_role: 'grammarian',
      row_version: 0,
      created_at: op.clientTs,
      updated_at: op.clientTs,
      deleted_at: null
    }))

  return [...pendingNotes, ...remoteNotes].sort(
    (left, right) => Number(right.created_at || 0) - Number(left.created_at || 0)
  )
}

function applyPendingAhRecords(
  remoteRecords: AhCounterRecordV2[],
  pendingOps: PendingOfficerOp[],
  observerName: string
) {
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
        observer_name: observerName,
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
      observer_name: observerName,
      observer_role: 'ah_counter',
      row_version: 0,
      created_at: op.clientTs,
      updated_at: op.clientTs,
      deleted_at: null
    })
  })

  return Array.from(map.values()).sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0))
}

function applyPendingWordHits(remoteHits: WordOfDayHitV2[], pendingOps: PendingOfficerOp[], observerName: string) {
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
      map.set(key, {
        ...existing,
        hit_count: nextHitCount,
        related_item_key: op.relatedItemKey ?? existing.related_item_key ?? null,
        observer_name: observerName,
        updated_at: op.clientTs
      })
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
      observer_name: observerName,
      observer_role: 'grammarian',
      row_version: 0,
      created_at: op.clientTs,
      updated_at: op.clientTs,
      deleted_at: null
    })
  })

  return Array.from(map.values()).sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0))
}

function normalizeParticipantKey(name: string) {
  return name.trim()
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase()
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

function getItemDisplayTitle(item: MeetingItem | null) {
  if (!item) return '未识别到当前环节'
  return item.title || '未命名环节'
}

function getSuggestedParticipantLabel(item: MeetingItem | null, liveCursor: MeetingLiveCursorV2 | null) {
  if (liveCursor?.current_participant_key?.trim()) {
    return liveCursor.current_participant_key.trim()
  }

  if (item?.speaker?.trim()) {
    return item.speaker.trim()
  }

  return item?.title || '暂无建议对象'
}

export default function OfficerNotesPage() {
  const {currentSession, setCurrentSession} = useMeetingStore()
  const {user, profile} = useAuth()

  const [activeTab, setActiveTab] = useState<OfficerTab>('grammarian')
  const [participantOptions, setParticipantOptions] = useState<ParticipantOption[]>([])
  const [syncedParticipantKeys, setSyncedParticipantKeys] = useState<string[]>([])
  const [selectedParticipantKey, setSelectedParticipantKey] = useState('')
  const [participantSearchText, setParticipantSearchText] = useState('')
  const [liveCursor, setLiveCursor] = useState<MeetingLiveCursorV2 | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [roleError, setRoleError] = useState('')

  const [grammarNoteType, setGrammarNoteType] = useState<GrammarNoteType>('good_word')
  const [grammarContent, setGrammarContent] = useState('')
  const [remoteGrammarNotes, setRemoteGrammarNotes] = useState<GrammarianNoteV2[]>([])
  const [isEditingWordOfDay, setIsEditingWordOfDay] = useState(false)
  const [wordOfDayDraft, setWordOfDayDraft] = useState('')

  const [fillerWord, setFillerWord] = useState('')
  const [sampleQuote, setSampleQuote] = useState('')
  const [remoteAhRecords, setRemoteAhRecords] = useState<AhCounterRecordV2[]>([])
  const [remoteWordOfDayHits, setRemoteWordOfDayHits] = useState<WordOfDayHitV2[]>([])
  const [pendingOps, setPendingOps] = useState<PendingOfficerOp[]>([])
  const pendingOpsRef = useRef<PendingOfficerOp[]>([])
  const flushBusyRef = useRef(false)

  const meetingId = currentSession?.id || ''
  const meetingTitle = currentSession?.metadata?.theme || '当前会议'
  const wordOfTheDay = currentSession?.metadata?.wordOfTheDay?.trim() || ''
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

  const currentAgendaIndex = useMemo(() => {
    if (!currentSession || !liveCursor?.current_item_key) return -1
    return currentSession.items.findIndex((item) => item.id === liveCursor.current_item_key)
  }, [currentSession, liveCursor?.current_item_key])

  const nextAgendaItem = useMemo(() => {
    if (!currentSession || currentAgendaIndex < 0) return null
    return currentSession.items[currentAgendaIndex + 1] || null
  }, [currentAgendaIndex, currentSession])

  const filteredParticipantOptions = useMemo(() => {
    const keyword = normalizeSearchText(participantSearchText)
    if (!keyword) return participantOptions
    return participantOptions.filter((option) => normalizeSearchText(option.name).includes(keyword))
  }, [participantOptions, participantSearchText])

  const searchResultOptions = useMemo(() => filteredParticipantOptions.slice(0, 6), [filteredParticipantOptions])
  const quickPickOptions = useMemo(() => participantOptions.slice(0, 8), [participantOptions])
  const trimmedParticipantSearchText = useMemo(() => participantSearchText.trim(), [participantSearchText])

  const selectedParticipantName = useMemo(() => {
    if (!selectedParticipantKey) return ''
    return participantNameMap.get(selectedParticipantKey) || selectedParticipantKey
  }, [participantNameMap, selectedParticipantKey])

  const selectedParticipantSynced = useMemo(() => {
    if (!selectedParticipantKey) return false
    return syncedParticipantKeySet.has(selectedParticipantKey)
  }, [selectedParticipantKey, syncedParticipantKeySet])

  const currentSuggestionLabel = useMemo(
    () => getSuggestedParticipantLabel(currentItem, liveCursor),
    [currentItem, liveCursor]
  )

  const currentAgendaSummary = useMemo(() => {
    const currentText = currentItem?.speaker?.trim()
      ? `${getItemDisplayTitle(currentItem)} · ${currentItem.speaker?.trim()}`
      : getItemDisplayTitle(currentItem)
    const nextText = nextAgendaItem?.speaker?.trim()
      ? `${getItemDisplayTitle(nextAgendaItem)} · ${nextAgendaItem.speaker?.trim()}`
      : getItemDisplayTitle(nextAgendaItem)
    return {
      currentText,
      nextText: nextAgendaItem ? nextText : '无'
    }
  }, [currentItem, nextAgendaItem])

  const grammarNotes = useMemo(
    () => applyPendingGrammarNotes(remoteGrammarNotes, pendingOps, actor.name || '会议官员'),
    [actor.name, pendingOps, remoteGrammarNotes]
  )

  const ahRecords = useMemo(
    () => applyPendingAhRecords(remoteAhRecords, pendingOps, actor.name || '会议官员'),
    [actor.name, pendingOps, remoteAhRecords]
  )

  const wordOfDayHits = useMemo(
    () => applyPendingWordHits(remoteWordOfDayHits, pendingOps, actor.name || '会议官员'),
    [actor.name, pendingOps, remoteWordOfDayHits]
  )

  const wordOfDayHitsForCurrentWord = useMemo(() => {
    const normalizedWord = normalizeSearchText(wordOfTheDay)
    if (!normalizedWord) return [] as WordOfDayHitV2[]
    return wordOfDayHits.filter((hit) => normalizeSearchText(hit.word_text) === normalizedWord)
  }, [wordOfDayHits, wordOfTheDay])

  const meetingWordUsageTotal = useMemo(
    () => wordOfDayHitsForCurrentWord.reduce((sum, hit) => sum + Number(hit.hit_count || 0), 0),
    [wordOfDayHitsForCurrentWord]
  )

  const wordOfDaySummary = useMemo(() => {
    const summaryMap = new Map<string, number>()
    wordOfDayHitsForCurrentWord.forEach((hit) => {
      summaryMap.set(hit.participant_key, (summaryMap.get(hit.participant_key) || 0) + Number(hit.hit_count || 0))
    })

    return Array.from(summaryMap.entries())
      .map(([participantKey, total]) => ({
        participantKey,
        participantName: participantNameMap.get(participantKey) || participantKey,
        total
      }))
      .sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total
        return a.participantName.localeCompare(b.participantName)
      })
  }, [participantNameMap, wordOfDayHitsForCurrentWord])

  const selectedParticipantWordUsage = useMemo(() => {
    if (!selectedParticipantKey) return 0
    return wordOfDaySummary.find((row) => row.participantKey === selectedParticipantKey)?.total || 0
  }, [selectedParticipantKey, wordOfDaySummary])

  const selectedParticipantAhRecords = useMemo(() => {
    if (!selectedParticipantKey) return [] as AhCounterRecordV2[]
    return ahRecords.filter((record) => record.participant_key === selectedParticipantKey)
  }, [ahRecords, selectedParticipantKey])

  const canCreateParticipantFromSearch = useMemo(() => {
    if (!trimmedParticipantSearchText) return false
    return !participantOptions.some(
      (option) => normalizeParticipantKey(option.name).toLowerCase() === trimmedParticipantSearchText.toLowerCase()
    )
  }, [participantOptions, trimmedParticipantSearchText])

  useEffect(() => {
    if (isEditingWordOfDay) return
    setWordOfDayDraft(wordOfTheDay)
  }, [isEditingWordOfDay, wordOfTheDay])

  useEffect(() => {
    pendingOpsRef.current = pendingOps
  }, [pendingOps])

  useEffect(() => {
    if (!meetingId) {
      setPendingOps([])
      pendingOpsRef.current = []
      return
    }

    const restored = readPendingOfficerOps(meetingId)
    setPendingOps(restored)
    pendingOpsRef.current = restored
  }, [meetingId])

  useEffect(() => {
    if (!meetingId) return
    const storageKey = getOfficerPendingOpsStorageKey(meetingId)
    if (pendingOps.length > 0) {
      Taro.setStorageSync(storageKey, pendingOps)
    } else {
      Taro.removeStorageSync(storageKey)
    }
  }, [meetingId, pendingOps])

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

  const queuePendingOp = useCallback((op: PendingOfficerOp) => {
    setPendingOps((prev) => {
      const next = [...prev, op]
      pendingOpsRef.current = next
      return next
    })
  }, [])

  const queueParticipantUpsert = useCallback(
    (participantKey: string, displayName: string) => {
      if (!participantKey || syncedParticipantKeySet.has(participantKey)) return
      queuePendingOp({
        id: createPendingOpId('participant'),
        kind: 'participant_upsert',
        participantKey,
        displayName,
        clientTs: Date.now()
      })
      setSyncedParticipantKeys((prev) => {
        if (prev.includes(participantKey)) return prev
        return [...prev, participantKey]
      })
    },
    [queuePendingOp, syncedParticipantKeySet]
  )

  const loadData = useCallback(async () => {
    if (!meetingId || !currentSession) return

    setLoading(true)
    try {
      const [participantsRes, cursorRes, grammarRes, ahRes, wordRes] = await Promise.all([
        AgendaV2DatabaseService.listParticipants(meetingId),
        AgendaV2DatabaseService.getLiveCursor(meetingId),
        AgendaV2DatabaseService.listGrammarianNotes(meetingId),
        AgendaV2DatabaseService.listAhCounterRecords(meetingId),
        AgendaV2DatabaseService.listWordOfDayHits(meetingId)
      ])

      const agendaOrderMap = new Map<string, number>()
      currentSession.items.forEach((item, index) => {
        const speaker = item.speaker?.trim()
        if (!speaker) return
        const key = normalizeParticipantKey(speaker)
        if (!key || agendaOrderMap.has(key)) return
        agendaOrderMap.set(key, index)
      })

      const liveData = cursorRes.success ? cursorRes.data || null : null
      const liveCurrentSpeaker = (() => {
        if (!liveData?.current_item_key) return ''
        const matched = currentSession.items.find((item) => item.id === liveData.current_item_key)
        return matched?.speaker?.trim() || ''
      })()
      const fallbackRecommendedKey = normalizeParticipantKey(liveCurrentSpeaker)
      const nextRecommendedKey = liveData?.current_participant_key || fallbackRecommendedKey || ''

      const dedup = new Map<string, ParticipantOption>()
      const syncedKeys = new Set<string>()

      agendaOrderMap.forEach((order, key) => {
        dedup.set(key, {
          key,
          name: key,
          agendaOrder: order,
          source: 'agenda'
        })
      })

      if (participantsRes.success) {
        participantsRes.data?.forEach((participant) => {
          const key = participant.participant_key
          if (!key) return
          syncedKeys.add(key)
          const existing = dedup.get(key)
          dedup.set(key, {
            key,
            name: participant.display_name || existing?.name || participant.participant_key,
            agendaOrder: existing?.agendaOrder ?? null,
            source: existing ? 'both' : 'db'
          })
        })
      }

      pendingOpsRef.current.forEach((op) => {
        if (op.kind !== 'participant_upsert') return
        syncedKeys.add(op.participantKey)
        const existing = dedup.get(op.participantKey)
        if (!existing) return
        dedup.set(op.participantKey, {
          ...existing,
          name: op.displayName || existing.name
        })
      })

      const currentItemIndex = currentSession.items.findIndex((item) => item.id === liveData?.current_item_key)
      const effectiveAgendaIndex = currentItemIndex >= 0 ? currentItemIndex : -1

      const sortedOptions = Array.from(dedup.values()).sort((left, right) => {
        const leftIsRecommended = nextRecommendedKey && left.key === nextRecommendedKey
        const rightIsRecommended = nextRecommendedKey && right.key === nextRecommendedKey
        if (leftIsRecommended !== rightIsRecommended) return leftIsRecommended ? -1 : 1

        const leftOrder = left.agendaOrder
        const rightOrder = right.agendaOrder
        const leftGroup =
          leftOrder === null ? 3 : effectiveAgendaIndex >= 0 && leftOrder >= effectiveAgendaIndex ? 1 : 2
        const rightGroup =
          rightOrder === null ? 3 : effectiveAgendaIndex >= 0 && rightOrder >= effectiveAgendaIndex ? 1 : 2

        if (leftGroup !== rightGroup) return leftGroup - rightGroup
        if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) return leftOrder - rightOrder
        if (leftOrder !== null && rightOrder === null) return -1
        if (leftOrder === null && rightOrder !== null) return 1
        return left.name.localeCompare(right.name)
      })

      if (cursorRes.success) {
        setLiveCursor(liveData)
      }
      if (grammarRes.success) {
        setRemoteGrammarNotes(grammarRes.data || [])
      }
      if (ahRes.success) {
        setRemoteAhRecords(ahRes.data || [])
      }
      if (wordRes.success) {
        setRemoteWordOfDayHits(wordRes.data || [])
      }

      setParticipantOptions(sortedOptions)
      setSyncedParticipantKeys(Array.from(syncedKeys))
      setSelectedParticipantKey((prev) => {
        if (prev && sortedOptions.some((option) => option.key === prev)) return prev
        if (nextRecommendedKey && sortedOptions.some((option) => option.key === nextRecommendedKey)) {
          return nextRecommendedKey
        }
        return sortedOptions[0]?.key || ''
      })
    } finally {
      setLoading(false)
    }
  }, [currentSession, meetingId])

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
          const key = op.participantKey
          const existing = participantGroups.get(key)
          if (existing) {
            existing.ids.push(op.id)
            existing.displayName = op.displayName || existing.displayName
          } else {
            participantGroups.set(key, {
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
          setRoleError(result.error || '后台同步失败')
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
        setRoleError('')
        void loadData()
      }
    } finally {
      flushBusyRef.current = false
    }
  }, [actor, loadData, meetingId])

  useEffect(() => {
    if (currentSession) return

    const preferredSession = StorageService.getPreferredSession()
    if (preferredSession) {
      setCurrentSession(preferredSession)
    }
  }, [currentSession, setCurrentSession])

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
    const timer = setInterval(() => {
      void flushPendingOps()
    }, OFFICER_SYNC_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [flushPendingOps, meetingId])

  const handleBackToHistory = useCallback(() => {
    void flushPendingOps()
    void Taro.switchTab({url: '/pages/history/index'}).catch(async (error) => {
      console.error('[officer-notes] switchTab history failed', error)
      try {
        await Taro.reLaunch({url: '/pages/history/index'})
      } catch (fallbackError) {
        console.error('[officer-notes] reLaunch history failed', fallbackError)
        Taro.showToast({title: '返回会议列表失败', icon: 'none'})
      }
    })
  }, [flushPendingOps])

  useDidShow(() => {
    Taro.hideTabBar({animation: false}).catch(() => undefined)
  })

  useDidHide(() => {
    void flushPendingOps()
    Taro.showTabBar({animation: false}).catch(() => undefined)
  })

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
      .on(
        'postgres_changes',
        {event: '*', schema: 'public', table: 'word_of_day_hits_v2', filter: `meeting_id=eq.${meetingId}`},
        () => {
          void loadData()
        }
      )
      .subscribe()

    return () => {
      void safeRemoveRealtimeChannel(channel)
    }
  }, [loadData, meetingId])

  const handleCreateParticipantFromSearch = async () => {
    const displayName = trimmedParticipantSearchText
    const participantKey = normalizeParticipantKey(displayName)
    if (!participantKey) {
      Taro.showToast({title: '请输入记录对象姓名', icon: 'none'})
      return
    }

    setSubmitting(true)
    try {
      const result = await ensureParticipantReady(participantKey, displayName)
      if (!result.success) {
        const message = result.error || '新增记录对象失败'
        setRoleError(message)
        Taro.showToast({title: message, icon: 'none'})
        return
      }

      setRoleError('')
      setSelectedParticipantKey(participantKey)
      setParticipantSearchText('')
      Taro.showToast({title: '已添加记录对象', icon: 'success'})
      await loadData()
    } finally {
      setSubmitting(false)
    }
  }

  const handleSaveWordOfDay = async () => {
    if (!currentSession || !meetingId) return

    const nextWordOfDay = wordOfDayDraft.trim()
    if (!nextWordOfDay) {
      Taro.showToast({title: '请输入每日一词', icon: 'none'})
      return
    }

    setSubmitting(true)
    try {
      const nextMetadata = {
        ...currentSession.metadata,
        wordOfTheDay: nextWordOfDay
      }

      const result = await DatabaseService.updateMeetingMetadata(meetingId, nextMetadata, {
        isCompleted: currentSession.isCompleted
      })

      if (!result.success) {
        const message = result.error || '保存每日一词失败'
        setRoleError(message)
        Taro.showToast({title: message, icon: 'none'})
        return
      }

      const nextSession = {
        ...currentSession,
        metadata: nextMetadata
      }

      StorageService.saveSession(nextSession)
      setCurrentSession(nextSession)
      setRoleError('')
      setIsEditingWordOfDay(false)
      Taro.showToast({title: '每日一词已更新', icon: 'success'})
      await loadData()
    } finally {
      setSubmitting(false)
    }
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

    if (!selectedParticipantSynced) {
      queueParticipantUpsert(selectedParticipantKey, selectedParticipantName || selectedParticipantKey)
    }

    queuePendingOp({
      id: createPendingOpId('grammar'),
      kind: 'grammar_note',
      participantKey: selectedParticipantKey,
      noteType: grammarNoteType,
      content: grammarContent.trim(),
      relatedItemKey: currentItem?.id || null,
      clientTs: Date.now()
    })

    setRoleError('')
    setGrammarContent('')
    Taro.showToast({title: '已加入后台同步', icon: 'success'})
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

    if (!selectedParticipantSynced) {
      queueParticipantUpsert(selectedParticipantKey, selectedParticipantName || selectedParticipantKey)
    }

    queuePendingOp({
      id: createPendingOpId('ah'),
      kind: 'ah_delta',
      participantKey: selectedParticipantKey,
      fillerWord: fillerWord.trim(),
      delta: 1,
      sampleQuote: sampleQuote.trim() || null,
      relatedItemKey: currentItem?.id || null,
      clientTs: Date.now()
    })

    setRoleError('')
    setFillerWord('')
    setSampleQuote('')
    Taro.showToast({title: '已加入后台同步', icon: 'success'})
  }

  const handleQuickAhWord = async (word: string) => {
    if (!meetingId) return
    if (!selectedParticipantKey) {
      Taro.showToast({title: '请先选择记录对象', icon: 'none'})
      return
    }

    const normalizedWord = word.trim()
    if (!normalizedWord) return

    if (!selectedParticipantSynced) {
      queueParticipantUpsert(selectedParticipantKey, selectedParticipantName || selectedParticipantKey)
    }

    queuePendingOp({
      id: createPendingOpId('ah'),
      kind: 'ah_delta',
      participantKey: selectedParticipantKey,
      fillerWord: normalizedWord,
      delta: 1,
      sampleQuote: null,
      relatedItemKey: currentItem?.id || null,
      clientTs: Date.now()
    })

    setRoleError('')
    Taro.showToast({title: `${normalizedWord} +1`, icon: 'success'})
  }

  const handleDecrementAhRecord = async (record: AhCounterRecordV2) => {
    if (!record?.participant_key || !record?.filler_word) return

    queuePendingOp({
      id: createPendingOpId('ah'),
      kind: 'ah_delta',
      participantKey: record.participant_key,
      fillerWord: record.filler_word,
      delta: -1,
      sampleQuote: null,
      relatedItemKey: record.related_item_key ?? currentItem?.id ?? null,
      clientTs: Date.now()
    })

    setRoleError('')
    Taro.showToast({title: '已回退 1 次', icon: 'success'})
  }

  const handleAdjustWordOfDay = async (delta: 1 | -1) => {
    if (!meetingId) return
    if (!wordOfTheDay) {
      setIsEditingWordOfDay(true)
      setWordOfDayDraft('')
      Taro.showToast({title: '先设置每日一词', icon: 'none'})
      return
    }
    if (!selectedParticipantKey) {
      Taro.showToast({title: '请先选择记录对象', icon: 'none'})
      return
    }
    if (delta === -1 && selectedParticipantWordUsage <= 0) {
      Taro.showToast({title: '当前对象暂无可回退次数', icon: 'none'})
      return
    }

    if (!selectedParticipantSynced) {
      queueParticipantUpsert(selectedParticipantKey, selectedParticipantName || selectedParticipantKey)
    }

    queuePendingOp({
      id: createPendingOpId('word'),
      kind: 'word_delta',
      participantKey: selectedParticipantKey,
      wordText: wordOfTheDay,
      delta,
      relatedItemKey: currentItem?.id || null,
      clientTs: Date.now()
    })

    setRoleError('')
    Taro.showToast({
      title: delta > 0 ? '每日一词 +1' : '每日一词 -1',
      icon: 'success'
    })
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
      <View className="px-4 pt-7 pb-3 bg-background/90 border-b border-border/70 backdrop-blur-sm shrink-0">
        <View className="flex justify-between items-center gap-2">
          <View className="min-w-0 flex-1">
            <Text className="text-sm text-foreground font-semibold block truncate">{meetingTitle}</Text>
            <Text className="text-[11px] text-muted-foreground block mt-0.5 truncate">
              建议：{currentSuggestionLabel} | 当前：{currentAgendaSummary.currentText} | 下个：
              {currentAgendaSummary.nextText}
            </Text>
          </View>
          <View
            className="ui-btn-secondary h-9 px-3 rounded-lg flex items-center gap-1.5"
            onClick={handleBackToHistory}>
            <View className="i-mdi-arrow-left text-base text-foreground" />
            <Text className="text-xs font-semibold text-foreground">返回</Text>
          </View>
        </View>

        <View className="mt-3 grid grid-cols-2 gap-2">
          <View
            className={`h-9 rounded-lg flex items-center justify-center border ${
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
            className={`h-9 rounded-lg flex items-center justify-center border ${
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
        {roleError && <Text className="text-xs text-red-300 mt-1">提示：{roleError}</Text>}
      </View>

      <ScrollView className="flex-1 min-h-0" scrollY enableBackToTop>
        <View className="px-4 py-3 space-y-3">
          <View className="ui-card-sharp p-3">
            <Text className="text-xs text-muted-foreground uppercase tracking-wider">记录谁</Text>

            {trimmedParticipantSearchText ? (
              searchResultOptions.length > 0 ? (
                <View className="grid grid-cols-2 gap-2 mt-2">
                  {searchResultOptions.map((option) => (
                    <Button
                      key={option.key}
                      className={`h-10 rounded-lg border px-3 text-sm font-semibold leading-[38px] ${
                        selectedParticipantKey === option.key
                          ? 'ui-btn-primary border-primary/60 text-white'
                          : 'ui-btn-secondary border-border/70 text-foreground'
                      }`}
                      loading={false}
                      disabled={submitting || loading}
                      onClick={() => setSelectedParticipantKey(option.key)}>
                      {option.name}
                    </Button>
                  ))}
                </View>
              ) : (
                <View className="ui-muted-panel mt-2">
                  <Text className="text-xs text-muted-foreground">
                    {canCreateParticipantFromSearch ? '未找到匹配对象，可在下方直接添加' : '未找到匹配对象'}
                  </Text>
                </View>
              )
            ) : quickPickOptions.length > 0 ? (
              <View className="grid grid-cols-4 gap-2 mt-2">
                {quickPickOptions.map((option) => (
                  <Button
                    key={option.key}
                    className={`h-9 rounded-lg border px-2 text-xs font-semibold leading-[34px] ${
                      selectedParticipantKey === option.key
                        ? 'ui-btn-primary border-primary/60 text-white'
                        : 'ui-btn-secondary border-border/70 text-foreground'
                    }`}
                    loading={false}
                    disabled={submitting || loading}
                    onClick={() => setSelectedParticipantKey(option.key)}>
                    {option.name}
                  </Button>
                ))}
              </View>
            ) : (
              <View className="ui-muted-panel mt-2">
                <Text className="text-xs text-muted-foreground">暂无可选记录对象</Text>
              </View>
            )}

            <Input
              className="ui-input rounded-lg px-3 py-2 text-sm mt-3"
              value={participantSearchText}
              onInput={(e) => setParticipantSearchText(e.detail.value)}
              placeholder="搜索或直接输入姓名"
              adjustPosition={false}
            />

            {trimmedParticipantSearchText && canCreateParticipantFromSearch && (
              <Button
                className="w-full ui-btn-primary h-10 text-sm font-bold mt-2"
                disabled={submitting || loading}
                loading={false}
                onClick={handleCreateParticipantFromSearch}>
                {`添加“${trimmedParticipantSearchText}”`}
              </Button>
            )}

            <Text className="text-xs text-muted-foreground block mt-2">
              当前记录：{selectedParticipantName || '未选择'}
            </Text>

            {!selectedParticipantSynced && selectedParticipantKey && (
              <Text className="text-[11px] text-amber-300 mt-2">
                当前对象尚未同步到参会人表，首次记录时会自动补同步。
              </Text>
            )}
          </View>

          {activeTab === 'grammarian' ? (
            <View key="grammarian-panel" className="space-y-3">
              <View className="ui-card-sharp p-2.5">
                <View className="flex items-center justify-between gap-2">
                  <Text className="text-xs text-muted-foreground uppercase tracking-wider">每日一词</Text>
                  {!isEditingWordOfDay && (
                    <Text
                      className="text-[11px] text-primary font-semibold"
                      onClick={() => {
                        setWordOfDayDraft(wordOfTheDay)
                        setIsEditingWordOfDay(true)
                      }}>
                      点击编辑每日一词
                    </Text>
                  )}
                </View>

                {isEditingWordOfDay ? (
                  <View className="mt-2">
                    <Input
                      className="ui-input rounded-lg px-3 py-2 text-sm"
                      value={wordOfDayDraft}
                      onInput={(e) => setWordOfDayDraft(e.detail.value)}
                      placeholder="输入每日一词"
                      adjustPosition={false}
                    />
                    <View className="grid grid-cols-2 gap-2 mt-2">
                      <Button
                        className="ui-btn-primary h-9 text-sm font-bold"
                        disabled={submitting || loading}
                        loading={submitting || loading}
                        onClick={handleSaveWordOfDay}>
                        保存
                      </Button>
                      <Button
                        className="ui-btn-secondary h-9 text-sm font-semibold"
                        disabled={submitting || loading}
                        loading={false}
                        onClick={() => {
                          setWordOfDayDraft(wordOfTheDay)
                          setIsEditingWordOfDay(false)
                        }}>
                        取消
                      </Button>
                    </View>
                  </View>
                ) : (
                  <View
                    className="mt-2 ui-panel-sharp px-3 py-2.5"
                    onClick={() => {
                      setWordOfDayDraft(wordOfTheDay)
                      setIsEditingWordOfDay(true)
                    }}>
                    <Text className={`text-sm font-bold block ${wordOfTheDay ? 'text-foreground' : 'text-primary'}`}>
                      {wordOfTheDay || '点击编辑每日一词'}
                    </Text>
                    {!wordOfTheDay && (
                      <Text className="text-[11px] text-muted-foreground block mt-1">先设置词，再开始计数</Text>
                    )}
                  </View>
                )}

                <View className="grid grid-cols-[1.4fr_0.9fr] gap-2 mt-2">
                  <View className="ui-panel-sharp px-3 py-2">
                    <Text className="text-[10px] text-muted-foreground uppercase tracking-wider block">当前对象</Text>
                    <View className="flex items-end justify-between gap-2 mt-1">
                      <Text className="text-sm text-foreground font-semibold truncate">
                        {selectedParticipantName || '未选择记录对象'}
                      </Text>
                      <Text className="text-lg text-foreground font-black shrink-0">
                        {selectedParticipantWordUsage}
                      </Text>
                    </View>
                  </View>
                  <View className="ui-panel-sharp px-3 py-2">
                    <Text className="text-[10px] text-muted-foreground uppercase tracking-wider block">全场总计</Text>
                    <Text className="text-lg text-foreground font-black block mt-1">{meetingWordUsageTotal}</Text>
                  </View>
                </View>

                <View className="grid grid-cols-2 gap-2 mt-2">
                  <Button
                    className={`h-9 text-sm font-bold ${wordOfTheDay ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
                    disabled={!selectedParticipantKey || submitting || loading}
                    loading={submitting || loading}
                    onClick={() => handleAdjustWordOfDay(1)}>
                    +1
                  </Button>
                  <Button
                    className="ui-btn-secondary h-9 text-sm font-bold"
                    disabled={!selectedParticipantKey || selectedParticipantWordUsage <= 0 || submitting || loading}
                    loading={false}
                    onClick={() => handleAdjustWordOfDay(-1)}>
                    -1
                  </Button>
                </View>
              </View>

              <View className="ui-card-sharp p-3">
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
                        className={`text-xs font-semibold ${
                          grammarNoteType === noteType ? 'text-white' : 'text-foreground'
                        }`}>
                        {GRAMMAR_NOTE_TYPE_LABELS[noteType]}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>

              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-1 uppercase tracking-wider">语法记录</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm"
                  value={grammarContent}
                  onInput={(e) => setGrammarContent(e.detail.value)}
                  placeholder="请输入好词好句或语法问题"
                  adjustPosition={false}
                />
                <Button
                  className="w-full ui-btn-primary h-10 text-sm font-bold mt-3"
                  loading={submitting || loading}
                  disabled={submitting || loading}
                  onClick={handleSubmitGrammarianNote}>
                  记录语法观察
                </Button>
              </View>

              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">每日一词排行</Text>
                {wordOfDaySummary.length > 0 ? (
                  <View className="space-y-1.5">
                    {wordOfDaySummary.slice(0, 8).map((row) => (
                      <View key={row.participantKey} className="flex items-center justify-between">
                        <Text className="text-sm text-foreground truncate pr-2">{row.participantName}</Text>
                        <Text className="text-xs text-primary font-semibold">{row.total} 次</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text className="text-xs text-muted-foreground">暂无每日一词记录。</Text>
                )}
              </View>

              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-2 uppercase tracking-wider">最近语法记录</Text>
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
            <View key="ah-counter-panel" className="space-y-3">
              <View className="ui-card-sharp p-3">
                <View className="flex items-center justify-between gap-2 mb-2">
                  <Text className="text-xs text-muted-foreground uppercase tracking-wider">常用哼哈词</Text>
                  <Text className="text-[11px] text-muted-foreground">点击直接 +1</Text>
                </View>
                <View className="flex flex-wrap gap-2">
                  {COMMON_FILLER_WORDS.map((word) => (
                    <View
                      key={word}
                      className={`h-9 px-3 rounded-full border flex items-center justify-center ${
                        !selectedParticipantKey || submitting || loading
                          ? 'bg-secondary/40 border-border/50 opacity-50'
                          : 'bg-secondary/70 border-border/70 active:bg-secondary/85'
                      }`}
                      onClick={() => {
                        if (!selectedParticipantKey || submitting || loading) return
                        void handleQuickAhWord(word)
                      }}>
                      <Text className="text-xs font-bold text-foreground">{`${word} +1`}</Text>
                    </View>
                  ))}
                </View>
                <Text className="text-[11px] text-muted-foreground mt-2">
                  “长停顿”仍按一种标签记录，后续再拆独立类型。
                </Text>
              </View>

              <View className="ui-card-sharp p-3">
                <Text className="text-xs text-muted-foreground block mb-1 uppercase tracking-wider">其他哼哈词</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm"
                  value={fillerWord}
                  onInput={(e) => setFillerWord(e.detail.value)}
                  placeholder="搜索不到时，手动输入其他词"
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
                  记录其他哼哈词
                </Button>
              </View>

              <View className="ui-card-sharp p-3">
                <View className="flex items-center justify-between gap-2 mb-2">
                  <Text className="text-xs text-muted-foreground uppercase tracking-wider">当前对象记录</Text>
                  <Text className="text-[11px] text-muted-foreground">
                    {selectedParticipantName || '未选择记录对象'}
                  </Text>
                </View>
                {selectedParticipantAhRecords.length > 0 ? (
                  <View className="space-y-2">
                    {selectedParticipantAhRecords.map((record) => (
                      <View key={record.id} className="ui-panel-sharp p-2.5">
                        <View className="flex items-center justify-between gap-2">
                          <View className="min-w-0 flex-1 pr-2">
                            <Text className="text-sm text-foreground font-bold break-all">{record.filler_word}</Text>
                            <Text className="text-[11px] text-muted-foreground block mt-0.5">
                              最近更新 {formatTimeLabel(record.updated_at || record.created_at)}
                            </Text>
                          </View>
                          <View className="flex items-center gap-2 shrink-0">
                            <Text className="text-base text-primary font-black">{record.hit_count}</Text>
                            <View
                              className={`h-8 px-3 rounded-lg border flex items-center justify-center ${
                                submitting || loading
                                  ? 'bg-secondary/40 border-border/50 opacity-50'
                                  : 'bg-secondary/70 border-border/70 active:bg-secondary/85'
                              }`}
                              onClick={() => {
                                if (submitting || loading) return
                                void handleDecrementAhRecord(record)
                              }}>
                              <Text className="text-xs font-bold text-foreground">-1</Text>
                            </View>
                          </View>
                        </View>
                        {record.sample_quote && (
                          <Text className="text-xs text-muted-foreground mt-1 break-all">
                            示例：{record.sample_quote}
                          </Text>
                        )}
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text className="text-xs text-muted-foreground">
                    {selectedParticipantKey ? '当前对象还没有哼哈记录。' : '请先选择记录对象。'}
                  </Text>
                )}
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  )
}
