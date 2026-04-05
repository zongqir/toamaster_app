import {Button, Input, Picker, ScrollView, Text, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react'
import {supabase} from '../../client/supabase'
import {AgendaV2DatabaseService} from '../../db/agendaV2Database'
import {DatabaseService} from '../../db/database'
import {useMeetingTimer} from '../../hooks/useMeetingTimer'
import {AgendaOpsSyncQueueService} from '../../services/agendaOpsSyncQueue'
import {StorageService} from '../../services/storage'
import {useMeetingStore} from '../../store/meetingStore'
import type {AgendaLivePhase, AgendaOpInput} from '../../types/agendaV2'
import type {ImpromptuSpeechRecord, MeetingItem, MeetingSession} from '../../types/meeting'
import {
  IMPROMPTU_BLOCK_DURATION_SECONDS,
  IMPROMPTU_SPEECH_DURATION_SECONDS,
  isImpromptuAgendaItem,
  isImpromptuBlock,
  isImpromptuSpeech
} from '../../utils/agendaBusiness'
import {validateAgendaItemDraft} from '../../utils/agendaItemValidation'
import {buildStagedCreateAgendaOps, buildStagedReorderAgendaOps} from '../../utils/agendaOpBuilders'
import {generateId, generateUuid} from '../../utils/id'
import {
  getCompletedImpromptuRecords,
  getImpromptuRecordsForAgendaItem,
  getImpromptuRunnerStatus,
  getImpromptuSpeechElapsedSeconds,
  getPendingImpromptuRecord,
  getSpeakingImpromptuRecord,
  hasImpromptuPoolStarted
} from '../../utils/impromptuRunner'
import {safeRemoveRealtimeChannel} from '../../utils/realtime'
import {safeNavigateTo, safeSwitchTab} from '../../utils/safeNavigation'

const TIMER_OFFICER_CONFIRM_KEY_PREFIX = 'AACTP_TIMER_OFFICER_CONFIRMED:'
const TIMER_RECENT_ITEM_TITLES_PREFIX = 'AACTP_TIMER_RECENT_ITEM_TITLES:'
const LIVE_CURSOR_SYNC_INTERVAL_SECONDS = 5

function resolveTimerLivePhase(item: MeetingItem | null | undefined) {
  return item?.speaker?.trim() ? 'speech' : 'other'
}

function isImpromptuStageTitle(title: string) {
  const normalized = title.trim().toLowerCase()
  return title.trim() === '即兴演讲' || normalized === 'table topics' || normalized === 'table topics session'
}

function isImpromptuHostRoleTitle(title: string | null | undefined) {
  const normalized = title?.trim().toLowerCase() || ''
  return normalized.includes('即兴主持') || normalized.includes('table topics master')
}

function isPlaceholderImpromptuHostName(name: string | null | undefined) {
  const normalized = name?.trim().toLowerCase() || ''
  return normalized === '即兴演讲官' || normalized === '即兴主持' || normalized === 'table topics master'
}

function isImpromptuHostBridgeItem(item: MeetingItem | null | undefined, nextItem: MeetingItem | null | undefined) {
  if (!item || !nextItem) return false
  if (!isImpromptuHostRoleTitle(item.title)) return false
  if (!isImpromptuAgendaItem(nextItem)) return false

  return item.plannedDuration >= 10 * 60
}

function getLiveCursorPayload(
  item: MeetingItem | null | undefined,
  impromptuRecords: ImpromptuSpeechRecord[] | undefined
) {
  if (!item) {
    return {
      currentParticipantKey: null,
      currentPhase: 'other' as AgendaLivePhase
    }
  }

  if (isImpromptuAgendaItem(item)) {
    const speakingRecord = getSpeakingImpromptuRecord(getImpromptuRecordsForAgendaItem(impromptuRecords, item.id))
    return {
      currentParticipantKey: speakingRecord?.speakerKey || null,
      currentPhase: speakingRecord ? ('speech' as AgendaLivePhase) : ('other' as AgendaLivePhase)
    }
  }

  return {
    currentParticipantKey: item.speaker?.trim() || null,
    currentPhase: resolveTimerLivePhase(item) as AgendaLivePhase
  }
}

function getItemRemainingSeconds(item: MeetingItem | null | undefined) {
  if (!item) return null
  return item.plannedDuration - Number(item.actualDuration || 0)
}

function formatTime(sec: number) {
  const absSec = Math.abs(sec)
  const m = Math.floor(absSec / 60)
  const s = absSec % 60
  const sign = sec < 0 ? '-' : ''
  return `${sign}${m}:${s.toString().padStart(2, '0')}`
}

type QuickChipProps = {
  compact: boolean
  iconClass: string
  label: string
  onClick: () => void
  className?: string
}

function QuickChip({compact, iconClass, label, onClick, className}: QuickChipProps) {
  return (
    <View
      className={`${
        compact ? 'w-[50px] h-[50px] rounded-[18px] px-1' : 'w-[58px] h-[58px] rounded-[20px] px-1'
      } bg-black/16 border border-white/20 flex flex-col items-center justify-center gap-1 active:border-white/45 ${className || ''}`}
      onClick={onClick}>
      <View className={`${compact ? 'text-[14px]' : 'text-[15px]'} ${iconClass} text-white`} />
      <Text
        className={`${compact ? 'text-[8px]' : 'text-[9px]'} text-white/88 font-semibold text-center leading-tight`}>
        {label}
      </Text>
    </View>
  )
}

type ActionTileProps = {
  compact: boolean
  iconClass: string
  label: string
  variant?: 'primary' | 'secondary' | 'danger'
  onClick: () => void
  fullWidth?: boolean
  disabled?: boolean
  dense?: boolean
}

function ActionTile({
  compact,
  iconClass,
  label,
  variant = 'secondary',
  onClick,
  fullWidth = false,
  disabled = false,
  dense = false
}: ActionTileProps) {
  const variantClass =
    variant === 'primary' ? 'ui-btn-primary' : variant === 'danger' ? 'ui-btn-danger' : 'ui-btn-secondary'
  const textClass = variant === 'secondary' ? 'text-foreground' : 'text-white'

  return (
    <View
      className={`${
        compact
          ? dense
            ? 'min-h-[34px] py-1 px-2 gap-0.5 rounded-xl'
            : 'min-h-[42px] py-2 px-2.5 gap-1 rounded-xl'
          : dense
            ? 'min-h-[36px] py-1.5 px-2.5 gap-0.5 rounded-xl'
            : 'min-h-[46px] py-2.5 px-4 gap-1.5 rounded-xl'
      } ${variantClass} ${disabled ? 'opacity-45' : ''} ${fullWidth ? 'col-span-2' : ''} w-full flex items-center justify-center`}
      onClick={() => {
        if (disabled) return
        onClick()
      }}>
      <View className={`${compact ? 'text-[12px]' : dense ? 'text-[13px]' : 'text-base'} ${iconClass} ${textClass}`} />
      <Text
        className={`${compact ? 'text-[9px]' : dense ? 'text-[11px]' : 'text-sm'} font-semibold ${textClass} leading-tight`}>
        {label}
      </Text>
    </View>
  )
}

type AgendaPanelProps = {
  currentIndex: number
  items: MeetingItem[]
  isCompact: boolean
  onJump: (index: number) => void
}

function AgendaPanel({currentIndex, items, isCompact, onJump}: AgendaPanelProps) {
  return (
    <View className="mb-3 bg-black/50 rounded-2xl overflow-hidden">
      <ScrollView className={isCompact ? 'max-h-64' : 'max-h-96'} scrollY scrollIntoView={`item-${currentIndex}`}>
        <View className="p-2">
          <Text className="text-xs text-white/75 block px-3 py-2 uppercase tracking-wider">会议日程</Text>
          {items.map((item, idx) => {
            const isCurrent = idx === currentIndex
            const isPast = idx < currentIndex

            return (
              <View
                key={item.id}
                id={`item-${idx}`}
                className={`mx-2 mb-2 rounded-xl overflow-hidden ${
                  isCurrent ? 'bg-primary/30 border-2 border-primary' : 'bg-black/30 border border-white/10'
                }`}
                onClick={() => {
                  if (isCurrent) return

                  Taro.showModal({
                    title: '跳转确认',
                    content: `确定要跳转到"${item.title}"吗？`,
                    confirmText: '跳转',
                    success: (res) => {
                      if (!res.confirm) return
                      onJump(idx)
                      Taro.showToast({title: '已跳转', icon: 'success'})
                    }
                  })
                }}>
                <View className="p-3 flex items-center gap-3">
                  <View
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      isCurrent ? 'bg-primary' : isPast ? 'bg-green-500/30 border border-green-500' : 'bg-white/10'
                    }`}>
                    {isPast ? (
                      <View className="i-mdi-check text-base text-green-400" />
                    ) : (
                      <Text className={`text-sm font-bold ${isCurrent ? 'text-white' : 'text-white/85'}`}>
                        {idx + 1}
                      </Text>
                    )}
                  </View>

                  <View className="flex-1 min-w-0">
                    <View className="flex items-center flex-wrap gap-2 mb-1">
                      <Text
                        className={`text-sm font-semibold block max-w-full truncate ${
                          isCurrent ? 'text-white' : isPast ? 'text-white/70' : 'text-white/88'
                        }`}>
                        {item.title}
                      </Text>
                      {isCurrent && (
                        <View className="bg-primary px-2 py-0.5 rounded-full">
                          <Text className="text-[10px] text-white font-bold">当前</Text>
                        </View>
                      )}
                    </View>
                    <View className="flex items-center flex-wrap gap-3 min-w-0">
                      <Text className={`text-xs max-w-full truncate ${isCurrent ? 'text-white/85' : 'text-white/68'}`}>
                        {item.speaker || '未指定'}
                      </Text>
                      <Text className={`text-xs ${isCurrent ? 'text-white/85' : 'text-white/68'}`}>
                        {Math.floor(item.plannedDuration / 60)}分钟
                      </Text>
                    </View>
                  </View>

                  {!isCurrent && <View className="i-mdi-chevron-right text-lg text-white/65" />}
                </View>
              </View>
            )
          })}
        </View>
      </ScrollView>
    </View>
  )
}

export default function TimerPage() {
  const {currentSession, settings, setCurrentSession} = useMeetingStore()
  const [_isCompleted, setIsCompleted] = useState(false)
  const [showAgendaDialog, setShowAgendaDialog] = useState(false)
  const [timerOfficerConfirmed, setTimerOfficerConfirmed] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editSpeaker, setEditSpeaker] = useState('')
  const [editDuration, setEditDuration] = useState('')
  const [addTitle, setAddTitle] = useState('')
  const [addSpeaker, setAddSpeaker] = useState('')
  const [addDuration, setAddDuration] = useState('2')
  const [recentItemTitles, setRecentItemTitles] = useState<string[]>([])
  const [agendaOpsSyncStatus, setAgendaOpsSyncStatus] = useState<'idle' | 'syncing' | 'failed'>('idle')
  const [agendaOpsSyncError, setAgendaOpsSyncError] = useState<string>('')
  const [showImpromptuSpeakerDialog, setShowImpromptuSpeakerDialog] = useState(false)
  const [showCompletedImpromptuDialog, setShowCompletedImpromptuDialog] = useState(false)
  const [impromptuSpeakerDraft, setImpromptuSpeakerDraft] = useState('')
  const [impromptuNow, setImpromptuNow] = useState(() => Date.now())

  // 时间快速编辑相关状态
  const [showTimeEditDialog, setShowTimeEditDialog] = useState(false)
  const [selectedMinutes, setSelectedMinutes] = useState(0)
  const [selectedSeconds, setSelectedSeconds] = useState(0)
  const [quickEditSpeaker, setQuickEditSpeaker] = useState('')
  const lastTapTimeRef = useRef(0)
  const agendaOpsSyncQueueRef = useRef(Promise.resolve())
  const agendaOpsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const realtimeSyncBusyRef = useRef(false)
  const isRunningRef = useRef(false)
  const currentItemRef = useRef<MeetingItem | null>(null)
  const impromptuTimerToggleRequestIdRef = useRef(0)
  const impromptuQueueRequestIdRef = useRef(0)
  const agendaCloudWriteDisabledRef = useRef(false)
  const syncAgendaOpsToCloudRef = useRef<(sessionSnapshot: MeetingSession, ops: AgendaOpInput[]) => Promise<void>>(
    async () => {}
  )

  const activeItems = useMemo(() => {
    const items = currentSession?.items || []
    return items.filter((item, index) => {
      if (isImpromptuSpeech(item)) return false
      if (isImpromptuHostBridgeItem(item, items[index + 1])) return false
      return !item.disabled || isImpromptuBlock(item)
    })
  }, [currentSession])
  const availableRecentItemTitles = useMemo(
    () => recentItemTitles.filter((title) => !isImpromptuStageTitle(title)),
    [recentItemTitles]
  )
  const sessionId = currentSession?.id
  const timerOfficerConfirmKey = useMemo(
    () => (sessionId ? `${TIMER_OFFICER_CONFIRM_KEY_PREFIX}${sessionId}` : ''),
    [sessionId]
  )
  const cloudSyncState = useSyncExternalStore(
    StorageService.subscribeCloudSyncState,
    () => StorageService.getCloudSyncState(sessionId),
    () => ({status: 'idle' as const, updatedAt: 0})
  )

  useEffect(() => {
    if (!timerOfficerConfirmKey) {
      setTimerOfficerConfirmed(false)
      return
    }

    setTimerOfficerConfirmed(Boolean(Taro.getStorageSync(timerOfficerConfirmKey)))
  }, [timerOfficerConfirmKey])

  useEffect(() => {
    if (!sessionId) {
      setRecentItemTitles([])
      agendaCloudWriteDisabledRef.current = false
      return
    }

    setRecentItemTitles(Taro.getStorageSync<string[]>(`${TIMER_RECENT_ITEM_TITLES_PREFIX}${sessionId}`) || [])
    agendaCloudWriteDisabledRef.current = false
  }, [sessionId])
  const cloudSyncText = useMemo(() => {
    if (agendaOpsSyncStatus === 'syncing') {
      return '议程增量同步中...'
    }
    if (agendaOpsSyncStatus === 'failed') {
      return `议程增量同步失败${agendaOpsSyncError ? `：${agendaOpsSyncError}` : ''}`
    }

    switch (cloudSyncState.status) {
      case 'syncing':
        return '本地已保存，云端同步中...'
      case 'failed':
        return `本地已保存，云端同步失败${cloudSyncState.error ? `：${cloudSyncState.error}` : ''}`
      default:
        return '已保存（本地 + 云端）'
    }
  }, [agendaOpsSyncError, agendaOpsSyncStatus, cloudSyncState.error, cloudSyncState.status])
  const cloudSyncClassName = useMemo(() => {
    if (agendaOpsSyncStatus === 'failed') return 'text-red-200'
    if (agendaOpsSyncStatus === 'syncing') return 'text-amber-100'

    switch (cloudSyncState.status) {
      case 'failed':
        return 'text-red-200'
      case 'syncing':
        return 'text-amber-100'
      default:
        return 'text-emerald-100'
    }
  }, [agendaOpsSyncStatus, cloudSyncState.status])

  const mergeTimedItems = useCallback(
    (timedItems: MeetingItem[]): MeetingSession | null => {
      if (!currentSession) return null

      const mergedItems = currentSession.items.map((item) => {
        const updated = timedItems.find((timedItem) => timedItem.id === item.id)
        return updated || item
      })

      return {
        ...currentSession,
        items: mergedItems
      }
    },
    [currentSession]
  )

  const buildTimerCheckpointOps = useCallback((prevItems: MeetingItem[], nextItems: MeetingItem[]): AgendaOpInput[] => {
    const prevMap = new Map(prevItems.map((item) => [item.id, item]))
    const ops: AgendaOpInput[] = []

    nextItems.forEach((item) => {
      const prevItem = prevMap.get(item.id)
      if (!prevItem) return

      const prevActualDuration = prevItem.actualDuration ?? null
      const prevActualStartTime = prevItem.actualStartTime ?? null
      const prevActualEndTime = prevItem.actualEndTime ?? null

      const nextActualDuration = item.actualDuration ?? null
      const nextActualStartTime = item.actualStartTime ?? null
      const nextActualEndTime = item.actualEndTime ?? null

      if (
        prevActualDuration === nextActualDuration &&
        prevActualStartTime === nextActualStartTime &&
        prevActualEndTime === nextActualEndTime
      ) {
        return
      }

      ops.push({
        opId: generateUuid(),
        type: 'timer_checkpoint',
        itemKey: item.id,
        payload: {
          patch: {
            actualDuration: nextActualDuration,
            actualStartTime: nextActualStartTime,
            actualEndTime: nextActualEndTime
          }
        }
      })
    })

    return ops
  }, [])

  const handleTimerCheckpoint = useCallback(
    (checkpointItems: MeetingItem[]) => {
      const latestSession = useMeetingStore.getState().currentSession || currentSession
      if (!latestSession) return

      const mergedItems = latestSession.items.map((item) => {
        const updated = checkpointItems.find((timedItem) => timedItem.id === item.id)
        return updated || item
      })

      const checkpointSession: MeetingSession = {
        ...latestSession,
        items: mergedItems
      }
      setCurrentSession(checkpointSession)
      StorageService.saveSession(checkpointSession, {syncToCloud: false})

      const ops = buildTimerCheckpointOps(latestSession.items, mergedItems)
      if (ops.length > 0) {
        void syncAgendaOpsToCloudRef.current(checkpointSession, ops)
      }
    },
    [buildTimerCheckpointOps, currentSession, setCurrentSession]
  )

  const handleComplete = async (finalItems: MeetingItem[]) => {
    if (!currentSession) return
    await agendaOpsSyncQueueRef.current

    // 合并回原始列表（包括 disabled 的）
    const allItems = currentSession.items.map((item) => {
      const updated = finalItems.find((f) => f.id === item.id)
      return updated || item
    })

    const updatedSession = {
      ...currentSession,
      items: allItems,
      isCompleted: true
    }

    setCurrentSession(updatedSession)
    StorageService.saveSession(updatedSession, {syncToCloud: false})
    setIsCompleted(true)

    const metadataResult = await DatabaseService.updateMeetingMetadata(updatedSession.id, updatedSession.metadata, {
      isCompleted: true
    })
    if (!metadataResult.success) {
      Taro.showModal({
        title: '云端保存失败',
        content: `会议已保存到本地。状态同步失败：${metadataResult.error || '未知错误'}。`,
        showCancel: false
      })
      return
    }

    Taro.showModal({
      title: '会议结束',
      content: '所有环节已完成，记录已保存。',
      showCancel: false,
      success: () => {
        void safeSwitchTab('/pages/history/index')
      }
    })
  }

  // 播放提示音（三声滴滴滴）
  const playBeepSound = () => {
    const beep = () => {
      Taro.vibrateShort({type: 'heavy'})
    }
    beep()
    setTimeout(beep, 200)
    setTimeout(beep, 400)
  }

  const {
    currentIndex,
    currentItem,
    nextItem,
    elapsed,
    remaining,
    isRunning,
    status,
    start,
    pause,
    next,
    prev,
    adjustTime,
    totalItems,
    updateCurrentItem,
    flushCheckpoint,
    reset,
    jumpTo
  } = useMeetingTimer(activeItems, settings.rules, handleComplete, playBeepSound, handleTimerCheckpoint)

  const isCurrentImpromptu = useMemo(() => isImpromptuAgendaItem(currentItem), [currentItem])
  const currentImpromptuRecords = useMemo(
    () => (currentItem ? getImpromptuRecordsForAgendaItem(currentSession?.impromptuRecords, currentItem.id) : []),
    [currentItem, currentSession?.impromptuRecords]
  )
  const currentImpromptuHostItem = useMemo(() => {
    if (!isCurrentImpromptu || !currentItem) return null

    const items = currentSession?.items || []
    const currentIndexInSession = items.findIndex((item) => item.id === currentItem.id)
    if (currentIndexInSession <= 0) return null

    const previousItem = items[currentIndexInSession - 1]
    return isImpromptuHostBridgeItem(previousItem, currentItem) ? previousItem : null
  }, [currentItem, currentSession?.items, isCurrentImpromptu])
  const pendingImpromptuRecord = useMemo(
    () => getPendingImpromptuRecord(currentImpromptuRecords),
    [currentImpromptuRecords]
  )
  const isPendingImpromptuSpeakerSyncing = useMemo(
    () => Boolean(pendingImpromptuRecord?.id?.startsWith('impromptu_')),
    [pendingImpromptuRecord]
  )
  const speakingImpromptuRecord = useMemo(
    () => getSpeakingImpromptuRecord(currentImpromptuRecords),
    [currentImpromptuRecords]
  )
  const completedImpromptuRecords = useMemo(
    () => getCompletedImpromptuRecords(currentImpromptuRecords),
    [currentImpromptuRecords]
  )
  const impromptuRunnerStatus = useMemo(
    () => (isCurrentImpromptu ? getImpromptuRunnerStatus(currentItem, currentImpromptuRecords) : 'idle'),
    [currentImpromptuRecords, currentItem, isCurrentImpromptu]
  )
  const impromptuSpeechElapsedSeconds = useMemo(
    () => getImpromptuSpeechElapsedSeconds(speakingImpromptuRecord, impromptuNow),
    [impromptuNow, speakingImpromptuRecord]
  )
  const currentImpromptuSpeechRemainingSeconds = useMemo(
    () =>
      speakingImpromptuRecord
        ? Math.max(0, speakingImpromptuRecord.speechPlannedDurationSeconds - impromptuSpeechElapsedSeconds)
        : IMPROMPTU_SPEECH_DURATION_SECONDS,
    [impromptuSpeechElapsedSeconds, speakingImpromptuRecord]
  )
  const impromptuPoolRemainingSeconds = useMemo(
    () => (isCurrentImpromptu && currentItem ? remaining : currentItem ? getItemRemainingSeconds(currentItem) : null),
    [currentItem, isCurrentImpromptu, remaining]
  )
  const hasCurrentImpromptuPoolStarted = useMemo(() => hasImpromptuPoolStarted(currentItem), [currentItem])
  const impromptuGuidanceText = useMemo(() => {
    if (!isCurrentImpromptu) return ''
    if (impromptuRunnerStatus === 'speaking') return '当前有人正在发言，结束后会回到等待下一位。'
    if (impromptuRunnerStatus === 'pending_speaker') {
      return isRunning
        ? '本节计时正在进行，点击开始发言即可进入该演讲者的 2 分钟。'
        : '本节计时已暂停，点击开始发言会自动恢复计时并开始发言。'
    }
    if (!hasCurrentImpromptuPoolStarted) {
      return '当前显示的是日程里填写的即兴演讲官。先开始本节计时，再登记下一位；若本节暂不进行，可直接点右下角跳过到下一节。'
    }
    if (!isRunning) return '本节计时当前已暂停，点中间圆盘恢复后再登记下一位。'
    return '本节计时正在进行。点“下一位”登记人名，点右下角可结束即兴并进入下一节。'
  }, [hasCurrentImpromptuPoolStarted, impromptuRunnerStatus, isCurrentImpromptu, isRunning])
  const currentLiveParticipantKey = isCurrentImpromptu ? speakingImpromptuRecord?.speakerKey || null : null
  const currentLivePhase: AgendaLivePhase = isCurrentImpromptu
    ? speakingImpromptuRecord
      ? 'speech'
      : 'other'
    : resolveTimerLivePhase(currentItem)
  const currentLiveOverrides = useMemo(
    () =>
      isCurrentImpromptu
        ? {
            participantKey: currentLiveParticipantKey,
            currentPhase: currentLivePhase
          }
        : undefined,
    [currentLiveParticipantKey, currentLivePhase, isCurrentImpromptu]
  )
  const liveCursorSyncBucket = useMemo(() => {
    if (!currentSession?.id) return 'no-session'
    if (!currentItem) return `idle:${currentSession.id}`

    const participantKey = currentLiveParticipantKey || 'none'
    if (!isRunning) {
      return `stopped:${currentSession.id}:${currentItem.id}:${currentLivePhase}:${participantKey}`
    }

    return `running:${currentSession.id}:${currentItem.id}:${currentLivePhase}:${participantKey}:${Math.floor(elapsed / LIVE_CURSOR_SYNC_INTERVAL_SECONDS)}`
  }, [currentItem, currentLiveParticipantKey, currentLivePhase, currentSession?.id, elapsed, isRunning])

  useEffect(() => {
    if (!isCurrentImpromptu || impromptuRunnerStatus !== 'speaking') return

    setImpromptuNow(Date.now())
    const timer = setInterval(() => {
      setImpromptuNow(Date.now())
    }, 500)

    return () => clearInterval(timer)
  }, [impromptuRunnerStatus, isCurrentImpromptu])

  useEffect(() => {
    isRunningRef.current = isRunning
  }, [isRunning])

  useEffect(() => {
    currentItemRef.current = currentItem || null
  }, [currentItem])

  const persistTimerOfficerLiveCursor = useCallback(
    async (
      item: MeetingItem | null,
      remainingSeconds: number | null,
      agendaVersion?: number,
      overrides?: {participantKey?: string | null; currentPhase?: AgendaLivePhase}
    ) => {
      const sessionSnapshot = useMeetingStore.getState().currentSession || currentSession
      if (!sessionSnapshot?.id) return
      const derivedPayload = getLiveCursorPayload(item, sessionSnapshot.impromptuRecords)

      const result = await AgendaV2DatabaseService.setLiveCursor({
        meetingId: sessionSnapshot.id,
        agendaVersion: agendaVersion ?? sessionSnapshot.agendaVersion ?? 1,
        currentItemKey: item?.id || null,
        currentParticipantKey: overrides?.participantKey ?? derivedPayload.currentParticipantKey,
        currentPhase: overrides?.currentPhase ?? derivedPayload.currentPhase,
        remainingSeconds
      })

      if (!result.success) {
        console.error('[timer] setLiveCursor failed', {
          meetingId: sessionSnapshot.id,
          itemKey: item?.id || null,
          error: result.error
        })
      }
    },
    [currentSession]
  )

  const appendTimerOfficerEvent = useCallback(
    async (
      eventType:
        | 'start_item'
        | 'pause_item'
        | 'adjust_time'
        | 'reset_item'
        | 'next_item'
        | 'prev_item'
        | 'jump_item'
        | 'complete_meeting',
      item: MeetingItem | null,
      remainingSeconds: number | null,
      payload: Record<string, unknown> = {},
      agendaVersion?: number,
      overrides?: {participantKey?: string | null; currentPhase?: AgendaLivePhase}
    ) => {
      const sessionSnapshot = useMeetingStore.getState().currentSession || currentSession
      if (!sessionSnapshot?.id) return
      const derivedPayload = getLiveCursorPayload(item, sessionSnapshot.impromptuRecords)

      const result = await AgendaV2DatabaseService.appendTimerOfficerEvent({
        meetingId: sessionSnapshot.id,
        agendaVersion: agendaVersion ?? sessionSnapshot.agendaVersion ?? 1,
        eventType,
        itemKey: item?.id || null,
        participantKey: overrides?.participantKey ?? derivedPayload.currentParticipantKey,
        currentPhase: overrides?.currentPhase ?? derivedPayload.currentPhase,
        remainingSeconds,
        payload
      })

      if (!result.success) {
        console.error('[timer] appendTimerOfficerEvent failed', {
          meetingId: sessionSnapshot.id,
          eventType,
          itemKey: item?.id || null,
          error: result.error
        })
      }
    },
    [currentSession]
  )

  useEffect(() => {
    if (!currentSession?.id) return
    void persistTimerOfficerLiveCursor(
      currentItem || null,
      currentItem ? remaining : null,
      currentSession.agendaVersion || 1,
      currentLiveOverrides
    )
  }, [
    currentItem,
    currentLiveOverrides,
    currentSession?.agendaVersion,
    currentSession?.id,
    liveCursorSyncBucket,
    persistTimerOfficerLiveCursor,
    remaining
  ])

  const commitSessionMutation = useCallback(
    (mutateSession: (session: MeetingSession) => MeetingSession) => {
      const latestSession = useMeetingStore.getState().currentSession || currentSession
      if (!latestSession) return null

      const checkpointItems = flushCheckpoint({skipCheckpoint: true})
      const checkpointSession = checkpointItems ? mergeTimedItems(checkpointItems) : latestSession
      if (!checkpointSession) return null

      const updatedSession = mutateSession(checkpointSession)
      setCurrentSession(updatedSession)
      StorageService.saveSession(updatedSession, {syncToCloud: false})
      return updatedSession
    },
    [currentSession, flushCheckpoint, mergeTimedItems, setCurrentSession]
  )

  const commitAgendaMutation = useCallback(
    (mutateItems: (items: MeetingItem[]) => MeetingItem[]) =>
      commitSessionMutation((session) => ({
        ...session,
        items: mutateItems(session.items)
      })),
    [commitSessionMutation]
  )

  const isAgendaVersionConflict = useCallback((errorText?: string, code?: string) => {
    if (code === 'VERSION_CONFLICT' || code === 'ROW_VERSION_CONFLICT') return true
    if (!errorText) return false
    return errorText.includes('VERSION_CONFLICT') || errorText.includes('ROW_VERSION_CONFLICT')
  }, [])

  const isAgendaPermissionDenied = useCallback((errorText?: string, code?: string) => {
    if (code === 'FORBIDDEN' || code === '42501') return true
    if (!errorText) return false

    const normalized = errorText.toLowerCase()
    return (
      normalized.includes('row-level security') ||
      normalized.includes('permission denied') ||
      normalized.includes('forbidden') ||
      normalized.includes('violates row-level security policy')
    )
  }, [])

  const markAgendaCloudWriteDisabled = useCallback((meetingId: string, errorText?: string) => {
    agendaCloudWriteDisabledRef.current = true
    AgendaOpsSyncQueueService.clearMeeting(meetingId)
    if (agendaOpsRetryTimerRef.current) {
      clearTimeout(agendaOpsRetryTimerRef.current)
      agendaOpsRetryTimerRef.current = null
    }
    setAgendaOpsSyncStatus('failed')
    setAgendaOpsSyncError(errorText || '云端议程权限异常，同步已停止，请检查数据库权限配置')
  }, [])

  const saveRecentItemTitle = useCallback(
    (title: string) => {
      const trimmed = title.trim()
      if (!trimmed || !sessionId) return

      const nextTitles = [trimmed, ...recentItemTitles.filter((item) => item !== trimmed)].slice(0, 6)
      setRecentItemTitles(nextTitles)
      Taro.setStorageSync(`${TIMER_RECENT_ITEM_TITLES_PREFIX}${sessionId}`, nextTitles)
    },
    [recentItemTitles, sessionId]
  )

  const refreshSessionFromCloud = useCallback(
    async (meetingId: string): Promise<boolean> => {
      const cloudSession = await DatabaseService.getMeeting(meetingId)
      if (!cloudSession) {
        Taro.showToast({title: '获取云端最新议程失败', icon: 'none'})
        return false
      }

      setCurrentSession(cloudSession)
      StorageService.saveSession(cloudSession, {syncToCloud: false})
      return true
    },
    [setCurrentSession]
  )

  const drainAgendaOpsQueue = useCallback(
    async (meetingId: string) => {
      if (agendaCloudWriteDisabledRef.current) {
        setAgendaOpsSyncStatus('failed')
        setAgendaOpsSyncError('云端议程权限异常，同步已停止，请检查数据库权限配置')
        return
      }

      agendaOpsSyncQueueRef.current = agendaOpsSyncQueueRef.current
        .then(async () => {
          if (agendaOpsRetryTimerRef.current) {
            clearTimeout(agendaOpsRetryTimerRef.current)
            agendaOpsRetryTimerRef.current = null
          }

          const readyBatches = AgendaOpsSyncQueueService.listReadyBatches(meetingId)
          if (readyBatches.length === 0) {
            setAgendaOpsSyncStatus(AgendaOpsSyncQueueService.hasPending(meetingId) ? 'syncing' : 'idle')
            return
          }

          setAgendaOpsSyncStatus('syncing')
          setAgendaOpsSyncError('')

          for (const batch of readyBatches) {
            const latestSession = useMeetingStore.getState().currentSession
            if (!latestSession || latestSession.id !== meetingId) {
              break
            }

            const bootstrapResult = await AgendaV2DatabaseService.bootstrapAgendaFromSession(latestSession)
            if (!bootstrapResult.success) {
              console.error('[timer] bootstrapAgendaFromSession failed', {
                meetingId,
                batch,
                sessionAgendaVersion: latestSession.agendaVersion,
                result: bootstrapResult
              })
              if (isAgendaPermissionDenied(bootstrapResult.error)) {
                markAgendaCloudWriteDisabled(meetingId, bootstrapResult.error)
                break
              }
              AgendaOpsSyncQueueService.markRetry(batch.id, bootstrapResult.error || '初始化失败')
              setAgendaOpsSyncStatus('failed')
              setAgendaOpsSyncError(bootstrapResult.error || '初始化失败')
              break
            }

            const baseAgendaVersion = bootstrapResult.data?.agendaVersion || latestSession.agendaVersion || 1
            let applyResult = await AgendaV2DatabaseService.applyAgendaOps({
              meetingId,
              baseAgendaVersion,
              ops: batch.ops,
              clientTs: Date.now()
            })

            if (!applyResult.success && isAgendaVersionConflict(applyResult.error, applyResult.data?.code)) {
              const latestCloud = await DatabaseService.getMeeting(meetingId)
              if (latestCloud) {
                const retryBaseVersion = latestCloud.agendaVersion || baseAgendaVersion
                const retryResult = await AgendaV2DatabaseService.applyAgendaOps({
                  meetingId,
                  baseAgendaVersion: retryBaseVersion,
                  ops: batch.ops,
                  clientTs: Date.now()
                })
                if (retryResult.success) {
                  applyResult = retryResult
                } else {
                  const refreshDecision = await Taro.showModal({
                    title: '议程冲突',
                    content: '检测到他人刚刚修改了议程。是否刷新到云端最新版本？',
                    confirmText: '刷新最新',
                    cancelText: '保留本地'
                  })

                  if (refreshDecision.confirm) {
                    const refreshed = await refreshSessionFromCloud(meetingId)
                    if (refreshed) {
                      AgendaOpsSyncQueueService.removeBatch(batch.id)
                      setAgendaOpsSyncStatus('idle')
                      setAgendaOpsSyncError('')
                      Taro.showToast({title: '已刷新到最新议程', icon: 'success'})
                      continue
                    }
                  }

                  applyResult = retryResult
                }
              }
            }

            if (!applyResult.success) {
              const detail = applyResult.data
              console.error('[timer] applyAgendaOps failed', {
                meetingId,
                batch,
                baseAgendaVersion,
                detail,
                error: applyResult.error
              })
              if (isAgendaPermissionDenied(applyResult.error, detail?.code)) {
                markAgendaCloudWriteDisabled(meetingId, applyResult.error || detail?.code || 'FORBIDDEN')
                break
              }
              const isVersionConflict = isAgendaVersionConflict(applyResult.error, detail?.code)
              if (isVersionConflict) {
                AgendaOpsSyncQueueService.markRetry(batch.id, applyResult.error || detail?.code || '冲突未解决')
                setAgendaOpsSyncStatus('failed')
                setAgendaOpsSyncError(applyResult.error || detail?.code || '冲突未解决')
              } else {
                AgendaOpsSyncQueueService.markRetry(batch.id, applyResult.error || detail?.code || '同步失败')
                setAgendaOpsSyncStatus('failed')
                setAgendaOpsSyncError(applyResult.error || detail?.code || '同步失败')
              }
              break
            }

            const newVersion = applyResult.data?.newVersion
            if (typeof newVersion === 'number') {
              const newest = useMeetingStore.getState().currentSession
              if (newest && newest.id === meetingId) {
                const versionedSession: MeetingSession = {
                  ...newest,
                  agendaVersion: newVersion
                }
                setCurrentSession(versionedSession)
                StorageService.saveSession(versionedSession, {syncToCloud: false})
              }
            }
            AgendaOpsSyncQueueService.markSuccess(batch.id)
          }

          const nextRetryAt = AgendaOpsSyncQueueService.getNextRetryAt(meetingId)
          if (nextRetryAt !== null && AgendaOpsSyncQueueService.hasPending(meetingId)) {
            const delay = Math.max(300, nextRetryAt - Date.now())
            agendaOpsRetryTimerRef.current = setTimeout(() => {
              void drainAgendaOpsQueue(meetingId)
            }, delay)
          } else {
            setAgendaOpsSyncStatus('idle')
            setAgendaOpsSyncError('')
          }
        })
        .catch((error) => {
          console.error('[timer] Agenda V2 queued sync failed', {
            meetingId,
            error
          })
          const message = error instanceof Error ? error.message : '未知错误'
          if (isAgendaPermissionDenied(message)) {
            markAgendaCloudWriteDisabled(meetingId, message)
            return
          }
          setAgendaOpsSyncStatus('failed')
          setAgendaOpsSyncError(message)
        })

      await agendaOpsSyncQueueRef.current
    },
    [
      isAgendaPermissionDenied,
      isAgendaVersionConflict,
      markAgendaCloudWriteDisabled,
      refreshSessionFromCloud,
      setCurrentSession
    ]
  )

  const syncAgendaOpsToCloud = useCallback(
    async (sessionSnapshot: MeetingSession, ops: AgendaOpInput[]) => {
      if (!sessionSnapshot) return
      if (agendaCloudWriteDisabledRef.current) return
      if (ops.length > 0) {
        AgendaOpsSyncQueueService.enqueue(sessionSnapshot.id, ops)
      }
      await drainAgendaOpsQueue(sessionSnapshot.id)
    },
    [drainAgendaOpsQueue]
  )
  syncAgendaOpsToCloudRef.current = syncAgendaOpsToCloud

  Taro.useDidShow(() => {
    const latest = useMeetingStore.getState().currentSession
    if (latest?.id) {
      void drainAgendaOpsQueue(latest.id)
    }
  })

  useEffect(() => {
    if (!currentSession?.id) return

    const meetingId = currentSession.id
    const channel = supabase
      .channel(`agenda-v2-live-timer-${meetingId}`)
      .on(
        'postgres_changes',
        {event: '*', schema: 'public', table: 'agenda_items_v2', filter: `meeting_id=eq.${meetingId}`},
        () => {
          void (async () => {
            if (isRunningRef.current) return
            if (realtimeSyncBusyRef.current) return
            if (AgendaOpsSyncQueueService.hasPending(meetingId)) return

            realtimeSyncBusyRef.current = true
            try {
              const cloudSession = await DatabaseService.getMeeting(meetingId)
              const localSession = useMeetingStore.getState().currentSession
              if (!cloudSession || !localSession || localSession.id !== meetingId) return
              if ((cloudSession.agendaVersion || 0) <= (localSession.agendaVersion || 0)) return

              setCurrentSession(cloudSession)
              StorageService.saveSession(cloudSession, {syncToCloud: false})
            } finally {
              realtimeSyncBusyRef.current = false
            }
          })()
        }
      )
      .on(
        'postgres_changes',
        {event: 'UPDATE', schema: 'public', table: 'meetings', filter: `id=eq.${meetingId}`},
        () => {
          void (async () => {
            if (isRunningRef.current) return
            if (realtimeSyncBusyRef.current) return
            if (AgendaOpsSyncQueueService.hasPending(meetingId)) return

            realtimeSyncBusyRef.current = true
            try {
              const cloudSession = await DatabaseService.getMeeting(meetingId)
              const localSession = useMeetingStore.getState().currentSession
              if (!cloudSession || !localSession || localSession.id !== meetingId) return
              if ((cloudSession.agendaVersion || 0) <= (localSession.agendaVersion || 0)) return

              setCurrentSession(cloudSession)
              StorageService.saveSession(cloudSession, {syncToCloud: false})
            } finally {
              realtimeSyncBusyRef.current = false
            }
          })()
        }
      )
      .on(
        'postgres_changes',
        {event: '*', schema: 'public', table: 'impromptu_speeches_v2', filter: `meeting_id=eq.${meetingId}`},
        () => {
          void (async () => {
            if (isRunningRef.current) return
            if (realtimeSyncBusyRef.current) return
            if (AgendaOpsSyncQueueService.hasPending(meetingId)) return

            realtimeSyncBusyRef.current = true
            try {
              const cloudSession = await DatabaseService.getMeeting(meetingId)
              const localSession = useMeetingStore.getState().currentSession
              if (!cloudSession || !localSession || localSession.id !== meetingId) return

              setCurrentSession(cloudSession)
              StorageService.saveSession(cloudSession, {syncToCloud: false})
            } finally {
              realtimeSyncBusyRef.current = false
            }
          })()
        }
      )
      .subscribe()

    return () => {
      void safeRemoveRealtimeChannel(channel)
    }
  }, [currentSession?.id, setCurrentSession])

  const persistCheckpointSnapshot = useCallback(() => {
    const latestSession = useMeetingStore.getState().currentSession || currentSession
    if (!latestSession) return
    const checkpointItems = flushCheckpoint({skipCheckpoint: true})
    const checkpointSession = checkpointItems
      ? {
          ...latestSession,
          items: latestSession.items.map((item) => {
            const updated = checkpointItems.find((timedItem) => timedItem.id === item.id)
            return updated || item
          })
        }
      : null
    if (!checkpointSession) return

    const pausedSession =
      isRunning && currentItem
        ? {
            ...checkpointSession,
            items: checkpointSession.items.map((item) =>
              item.id === currentItem.id
                ? {
                    ...item,
                    actualStartTime: undefined
                  }
                : item
            )
          }
        : checkpointSession

    setCurrentSession(pausedSession)
    StorageService.saveSession(pausedSession, {syncToCloud: false})

    const ops = buildTimerCheckpointOps(latestSession.items, pausedSession.items)
    if (ops.length > 0) {
      void syncAgendaOpsToCloudRef.current(pausedSession, ops)
    }
  }, [buildTimerCheckpointOps, currentItem, currentSession, flushCheckpoint, isRunning, setCurrentSession])

  Taro.useDidHide(() => {
    if (isRunning) {
      pause()
      return
    }
    persistCheckpointSnapshot()
  })

  Taro.useUnload(() => {
    if (agendaOpsRetryTimerRef.current) {
      clearTimeout(agendaOpsRetryTimerRef.current)
      agendaOpsRetryTimerRef.current = null
    }
    if (isRunning) {
      pause()
      return
    }
    persistCheckpointSnapshot()
  })

  const mergeImpromptuRecordIntoSession = useCallback(
    (record: ImpromptuSpeechRecord, mode: 'upsert' | 'replace' = 'upsert') => {
      const updatedSession = commitSessionMutation((session) => {
        const currentRecords = session.impromptuRecords || []
        const nextRecords =
          mode === 'replace'
            ? currentRecords.some((item) => item.id === record.id)
              ? currentRecords.map((item) => (item.id === record.id ? record : item))
              : [...currentRecords, record]
            : currentRecords.some((item) => item.id === record.id)
              ? currentRecords.map((item) => (item.id === record.id ? record : item))
              : [...currentRecords, record]

        return {
          ...session,
          impromptuRecords: nextRecords
        }
      })

      return updatedSession
    },
    [commitSessionMutation]
  )

  const replaceImpromptuRecordLocally = useCallback(
    (sourceRecordId: string, nextRecord: ImpromptuSpeechRecord) =>
      commitSessionMutation((session) => {
        const records = session.impromptuRecords || []
        const nextRecords = records.some((record) => record.id === sourceRecordId)
          ? records.map((record) => (record.id === sourceRecordId ? nextRecord : record))
          : records.some((record) => record.id === nextRecord.id)
            ? records.map((record) => (record.id === nextRecord.id ? nextRecord : record))
            : [...records, nextRecord]

        return {
          ...session,
          impromptuRecords: nextRecords
        }
      }),
    [commitSessionMutation]
  )

  const removeImpromptuRecordLocally = useCallback(
    (recordId: string) =>
      commitSessionMutation((session) => ({
        ...session,
        impromptuRecords: (session.impromptuRecords || []).filter((record) => record.id !== recordId)
      })),
    [commitSessionMutation]
  )

  const removeImpromptuRecordsForAgendaItem = useCallback(
    (agendaItemId: string) =>
      commitSessionMutation((session) => ({
        ...session,
        impromptuRecords: (session.impromptuRecords || []).filter((record) => record.agendaItemId !== agendaItemId)
      })),
    [commitSessionMutation]
  )

  const getImpromptuLiveOverrides = useCallback(
    (phase: AgendaLivePhase, participantKey?: string | null) => ({
      participantKey: phase === 'speech' ? participantKey || null : null,
      currentPhase: phase
    }),
    []
  )

  const ensureCurrentTimerRunning = useCallback(async () => {
    if (isRunning) return true

    if (timerOfficerConfirmKey && !timerOfficerConfirmed) {
      const decision = await Taro.showModal({
        title: '确认计时',
        content: '当前只建议由时间官操作计时。若多人同时计时，结果会不准。是否继续由你计时？',
        confirmText: '继续计时',
        cancelText: '取消'
      })

      if (!decision.confirm) return false

      Taro.setStorageSync(timerOfficerConfirmKey, true)
      setTimerOfficerConfirmed(true)
    }

    if (
      isCurrentImpromptu &&
      speakingImpromptuRecord &&
      !speakingImpromptuRecord.speechStartedAt &&
      currentSession?.id
    ) {
      const requestId = impromptuTimerToggleRequestIdRef.current + 1
      impromptuTimerToggleRequestIdRef.current = requestId
      const requestStartedAt = Date.now()
      const pausedElapsedSnapshot = elapsed
      const optimisticRecord: ImpromptuSpeechRecord = {
        ...speakingImpromptuRecord,
        speechStartedAt: requestStartedAt,
        updatedAt: requestStartedAt
      }

      mergeImpromptuRecordIntoSession(optimisticRecord, 'replace')
      void AgendaV2DatabaseService.updateImpromptuSpeechRecord({
        id: speakingImpromptuRecord.id,
        meetingId: currentSession.id,
        patch: {
          speechStartedAt: requestStartedAt
        }
      }).then((resumeResult) => {
        if (impromptuTimerToggleRequestIdRef.current !== requestId) return
        if (resumeResult.success && resumeResult.data) {
          mergeImpromptuRecordIntoSession(resumeResult.data, 'replace')
          return
        }

        mergeImpromptuRecordIntoSession(speakingImpromptuRecord, 'replace')
        pause()
        const latestItem = currentItemRef.current
        if (latestItem) {
          updateCurrentItem({
            ...latestItem,
            actualDuration: pausedElapsedSnapshot,
            actualStartTime: undefined,
            actualEndTime: undefined
          })
          void flushCheckpoint()
        }
        Taro.showToast({title: resumeResult.error || '继续计时失败，已恢复', icon: 'none'})
      })
    }

    start()
    void Promise.allSettled([
      appendTimerOfficerEvent('start_item', currentItem || null, remaining, {}, undefined, currentLiveOverrides),
      persistTimerOfficerLiveCursor(currentItem || null, remaining, undefined, currentLiveOverrides)
    ])

    return true
  }, [
    appendTimerOfficerEvent,
    currentItem,
    currentSession?.id,
    currentLiveOverrides,
    elapsed,
    flushCheckpoint,
    isCurrentImpromptu,
    isRunning,
    mergeImpromptuRecordIntoSession,
    pause,
    persistTimerOfficerLiveCursor,
    remaining,
    speakingImpromptuRecord,
    start,
    timerOfficerConfirmKey,
    timerOfficerConfirmed,
    updateCurrentItem
  ])

  const handleOpenImpromptuQueue = useCallback(async () => {
    if (!currentItem || !isCurrentImpromptu) return
    if (!isRunning) {
      const ensuredRunning = await ensureCurrentTimerRunning()
      if (!ensuredRunning) return
    }
    if (pendingImpromptuRecord || speakingImpromptuRecord) {
      Taro.showToast({title: '请先完成当前发言', icon: 'none'})
      return
    }

    setImpromptuSpeakerDraft('')
    setShowImpromptuSpeakerDialog(true)
  }, [
    currentItem,
    ensureCurrentTimerRunning,
    isCurrentImpromptu,
    isRunning,
    pendingImpromptuRecord,
    speakingImpromptuRecord
  ])

  const handleQueueImpromptuSpeaker = useCallback(async () => {
    const speakerName = impromptuSpeakerDraft.trim()
    if (!currentSession?.id || !currentItem || !isCurrentImpromptu) return
    if (!speakerName) {
      Taro.showToast({title: '请输入人名', icon: 'none'})
      return
    }

    const requestId = impromptuQueueRequestIdRef.current + 1
    impromptuQueueRequestIdRef.current = requestId
    const timestamp = Date.now()
    const tempRecordId = generateId('impromptu')
    const tempRecord: ImpromptuSpeechRecord = {
      id: tempRecordId,
      meetingId: currentSession.id,
      agendaItemId: currentItem.id,
      sortOrder: currentImpromptuRecords.length + 1,
      speakerName,
      speakerKey: speakerName,
      status: 'pending',
      poolDurationSeconds: currentItem.plannedDuration || IMPROMPTU_BLOCK_DURATION_SECONDS,
      speechPlannedDurationSeconds: IMPROMPTU_SPEECH_DURATION_SECONDS,
      createdAt: timestamp,
      updatedAt: timestamp
    }

    mergeImpromptuRecordIntoSession(tempRecord)
    setShowImpromptuSpeakerDialog(false)
    Taro.showToast({title: '已登记下一位', icon: 'success'})

    const result = await AgendaV2DatabaseService.createImpromptuSpeechRecord({
      meetingId: currentSession.id,
      agendaItemId: currentItem.id,
      speakerName,
      sortOrder: currentImpromptuRecords.length + 1,
      poolDurationSeconds: currentItem.plannedDuration || IMPROMPTU_BLOCK_DURATION_SECONDS,
      speechPlannedDurationSeconds: IMPROMPTU_SPEECH_DURATION_SECONDS
    })

    if (impromptuQueueRequestIdRef.current !== requestId) return

    if (!result.success || !result.data) {
      removeImpromptuRecordLocally(tempRecordId)
      setImpromptuSpeakerDraft(speakerName)
      if (currentItemRef.current?.id === currentItem.id) {
        setShowImpromptuSpeakerDialog(true)
      }
      Taro.showToast({title: result.error || '登记失败，已恢复', icon: 'none'})
      return
    }

    replaceImpromptuRecordLocally(tempRecordId, result.data)
    setImpromptuSpeakerDraft('')
  }, [
    currentImpromptuRecords.length,
    currentItem,
    currentSession?.id,
    impromptuSpeakerDraft,
    isCurrentImpromptu,
    mergeImpromptuRecordIntoSession,
    removeImpromptuRecordLocally,
    replaceImpromptuRecordLocally
  ])

  const handleCancelPendingImpromptuSpeaker = useCallback(async () => {
    if (!currentSession?.id || !pendingImpromptuRecord) return false

    const result = await AgendaV2DatabaseService.updateImpromptuSpeechRecord({
      id: pendingImpromptuRecord.id,
      meetingId: currentSession.id,
      patch: {
        status: 'cancelled'
      }
    })

    if (!result.success || !result.data) {
      Taro.showToast({title: result.error || '取消失败', icon: 'none'})
      return false
    }

    mergeImpromptuRecordIntoSession(result.data, 'replace')
    Taro.showToast({title: '已取消登记', icon: 'success'})
    return true
  }, [currentSession?.id, mergeImpromptuRecordIntoSession, pendingImpromptuRecord])

  const handleStartImpromptuSpeech = useCallback(async () => {
    if (!currentSession?.id || !currentItem || !pendingImpromptuRecord) return
    if (isPendingImpromptuSpeakerSyncing) {
      Taro.showToast({title: '正在保存名单，请稍候', icon: 'none'})
      return
    }
    const ensuredRunning = isRunning ? true : await ensureCurrentTimerRunning()
    if (!ensuredRunning) {
      return
    }

    if (remaining < IMPROMPTU_SPEECH_DURATION_SECONDS) {
      const warningMinutes = Math.floor(Math.abs(remaining) / 60)
      const warningSeconds = Math.abs(remaining) % 60
      const warningLabel = `${remaining < 0 ? '-' : ''}${warningMinutes}:${warningSeconds.toString().padStart(2, '0')}`
      const decision = await Taro.showModal({
        title: '时间提醒',
        content: `本节剩余仅 ${warningLabel}，仍要开始发言吗？`,
        confirmText: '继续开始',
        cancelText: '取消'
      })
      if (!decision.confirm) return
    }

    const nowTs = Date.now()
    const result = await AgendaV2DatabaseService.updateImpromptuSpeechRecord({
      id: pendingImpromptuRecord.id,
      meetingId: currentSession.id,
      patch: {
        status: 'speaking',
        speechStartedAt: nowTs,
        speechDurationSeconds: 0,
        poolRemainingSecondsAtStart: remaining,
        startedWithLowRemaining: remaining < IMPROMPTU_SPEECH_DURATION_SECONDS
      }
    })

    if (!result.success || !result.data) {
      Taro.showToast({title: result.error || '开始失败', icon: 'none'})
      return
    }

    mergeImpromptuRecordIntoSession(result.data, 'replace')
    void Promise.allSettled([
      appendTimerOfficerEvent(
        'adjust_time',
        currentItem,
        remaining,
        {
          impromptuAction: 'start_speech',
          impromptuRecordId: result.data.id,
          speakerName: result.data.speakerName
        },
        currentSession.agendaVersion || 1,
        getImpromptuLiveOverrides('speech', result.data.speakerKey)
      ),
      persistTimerOfficerLiveCursor(
        currentItem,
        remaining,
        currentSession.agendaVersion || 1,
        getImpromptuLiveOverrides('speech', result.data.speakerKey)
      )
    ])
    Taro.showToast({title: '已开始发言', icon: 'success'})
  }, [
    appendTimerOfficerEvent,
    currentItem,
    currentSession?.agendaVersion,
    currentSession?.id,
    ensureCurrentTimerRunning,
    getImpromptuLiveOverrides,
    isPendingImpromptuSpeakerSyncing,
    isRunning,
    mergeImpromptuRecordIntoSession,
    pendingImpromptuRecord,
    persistTimerOfficerLiveCursor,
    remaining
  ])

  const handleFinishImpromptuSpeech = useCallback(async () => {
    if (!currentSession?.id || !currentItem || !speakingImpromptuRecord) return false

    const endedAt = Date.now()
    const speechDurationSeconds = getImpromptuSpeechElapsedSeconds(speakingImpromptuRecord, endedAt)
    const result = await AgendaV2DatabaseService.updateImpromptuSpeechRecord({
      id: speakingImpromptuRecord.id,
      meetingId: currentSession.id,
      patch: {
        status: 'completed',
        speechEndedAt: endedAt,
        speechDurationSeconds,
        isOvertime: speechDurationSeconds > IMPROMPTU_SPEECH_DURATION_SECONDS
      }
    })

    if (!result.success || !result.data) {
      Taro.showToast({title: result.error || '结束失败', icon: 'none'})
      return false
    }

    mergeImpromptuRecordIntoSession(result.data, 'replace')
    void Promise.allSettled([
      appendTimerOfficerEvent(
        'adjust_time',
        currentItem,
        remaining,
        {
          impromptuAction: 'finish_speech',
          impromptuRecordId: result.data.id,
          speakerName: result.data.speakerName,
          speechDurationSeconds
        },
        currentSession.agendaVersion || 1,
        getImpromptuLiveOverrides('other', null)
      ),
      persistTimerOfficerLiveCursor(
        currentItem,
        remaining,
        currentSession.agendaVersion || 1,
        getImpromptuLiveOverrides('other', null)
      )
    ])
    Taro.showToast({title: '已结束发言', icon: 'success'})
    return true
  }, [
    appendTimerOfficerEvent,
    currentItem,
    currentSession?.agendaVersion,
    currentSession?.id,
    getImpromptuLiveOverrides,
    mergeImpromptuRecordIntoSession,
    persistTimerOfficerLiveCursor,
    remaining,
    speakingImpromptuRecord
  ])

  const finalizeImpromptuBeforeLeave = useCallback(async () => {
    if (!isCurrentImpromptu) return true

    if (speakingImpromptuRecord) {
      const decision = await Taro.showModal({
        title: '结束即兴',
        content: '当前有人正在发言。离开此环节前，会先结束当前发言，是否继续？',
        confirmText: '继续离开',
        cancelText: '留在此页'
      })
      if (!decision.confirm) return false
      const finished = await handleFinishImpromptuSpeech()
      if (!finished) return false
    }

    if (pendingImpromptuRecord) {
      const decision = await Taro.showModal({
        title: '结束即兴',
        content: '当前有已登记但未开始发言的人名。离开此环节前将取消登记，是否继续？',
        confirmText: '继续离开',
        cancelText: '留在此页'
      })
      if (!decision.confirm) return false
      const cancelled = await handleCancelPendingImpromptuSpeaker()
      if (!cancelled) return false
    }

    return true
  }, [
    handleCancelPendingImpromptuSpeaker,
    handleFinishImpromptuSpeech,
    isCurrentImpromptu,
    pendingImpromptuRecord,
    speakingImpromptuRecord
  ])

  // 打开编辑对话框
  const handleOpenEdit = () => {
    if (!currentItem) return
    setEditTitle(currentItem.title)
    setEditSpeaker(currentItem.speaker || '')
    setEditDuration(Math.floor(currentItem.plannedDuration / 60).toString())
    setShowEditDialog(true)
  }

  const openAddDialog = useCallback((preset?: {title?: string; speaker?: string; duration?: string}) => {
    setAddTitle(preset?.title || '')
    setAddSpeaker(preset?.speaker || '')
    setAddDuration(preset?.duration || '2')
    setShowAddDialog(true)
  }, [])

  // 保存编辑
  const handleSaveEdit = () => {
    if (!currentItem || !currentSession) return

    const validation = validateAgendaItemDraft({
      title: editTitle,
      speaker: editSpeaker,
      durationText: editDuration
    })

    if (validation.errorMessage || !validation.durationMinutes) {
      Taro.showToast({title: validation.errorMessage || '请填写正确的环节信息', icon: 'none'})
      return
    }
    if (isImpromptuStageTitle(validation.title)) {
      Taro.showToast({title: '即兴环节请在会前编排阶段创建', icon: 'none'})
      return
    }

    const duration = validation.durationMinutes
    const currentItemId = currentItem.id

    const updatedSession = commitAgendaMutation((items) =>
      items.map((item) => {
        if (item.id !== currentItemId) return item
        return {
          ...item,
          title: validation.title,
          speaker: validation.speaker,
          plannedDuration: duration * 60
        }
      })
    )

    if (updatedSession) {
      const patchPayload: Record<string, unknown> = {
        title: validation.title,
        speaker: validation.speaker,
        plannedDuration: duration * 60
      }

      void syncAgendaOpsToCloud(updatedSession, [
        {
          opId: generateUuid(),
          type: 'update_item',
          itemKey: currentItemId,
          payload: {
            patch: patchPayload
          }
        }
      ])

      const updatedCurrentItem = updatedSession.items.find((item) => item.id === currentItemId) || null
      void persistTimerOfficerLiveCursor(
        updatedCurrentItem,
        updatedCurrentItem ? updatedCurrentItem.plannedDuration - Number(updatedCurrentItem.actualDuration || 0) : null,
        updatedSession.agendaVersion || 1
      )
    }

    setShowEditDialog(false)
    Taro.showToast({title: '已更新', icon: 'success'})
  }

  // 新增环节
  const handleAddItem = () => {
    if (!currentSession) return
    const previousItems = (useMeetingStore.getState().currentSession || currentSession)?.items || []
    const validation = validateAgendaItemDraft({
      title: addTitle,
      speaker: addSpeaker,
      durationText: addDuration
    })

    if (validation.errorMessage || !validation.durationMinutes) {
      Taro.showToast({title: validation.errorMessage || '请填写正确的环节信息', icon: 'none'})
      return
    }

    const duration = validation.durationMinutes
    const createdItems: MeetingItem[] = []

    const updatedSession = commitAgendaMutation((items) => {
      const allItems = [...items]
      const currentItemIndex = allItems.findIndex((item) => item.id === currentItem?.id)

      const newItem: MeetingItem = {
        id: generateId('item'),
        title: validation.title,
        speaker: validation.speaker,
        plannedDuration: duration * 60,
        type: 'other',
        ruleId: duration * 60 > 180 ? 'long' : 'short',
        businessType: 'normal'
      }

      const insertIndex = currentItemIndex !== -1 ? currentItemIndex + 1 : allItems.length
      allItems.splice(insertIndex, 0, newItem)
      createdItems.push(newItem)
      return allItems
    })

    if (updatedSession) {
      if (createdItems.length === 0) return

      saveRecentItemTitle(createdItems[createdItems.length - 1].title)
      const createOps = buildStagedCreateAgendaOps(previousItems, updatedSession.items, createdItems)
      const orderOps = buildStagedReorderAgendaOps(previousItems, updatedSession.items)
      void syncAgendaOpsToCloud(updatedSession, [...createOps, ...orderOps])
    }

    setShowAddDialog(false)
    setAddTitle('')
    setAddSpeaker('')
    setAddDuration('2')
    Taro.showToast({title: '已添加环节', icon: 'success'})
  }

  // 打开新增对话框
  const handleOpenAdd = () => {
    openAddDialog({duration: '2'})
  }

  // 删除当前环节
  const handleDeleteCurrent = () => {
    if (!currentItem || !currentSession) return

    if (activeItems.length <= 1) {
      Taro.showToast({title: '至少保留一个环节', icon: 'none'})
      return
    }

    if (currentIndex === activeItems.length - 1) {
      Taro.showToast({title: '最后一个环节不允许删除', icon: 'none'})
      return
    }

    Taro.showModal({
      title: '删除环节',
      content: `确定要删除"${currentItem.title}"吗？`,
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: (res) => {
        if (res.confirm) {
          const previousItems = (useMeetingStore.getState().currentSession || currentSession)?.items || []
          const updatedItems = activeItems.filter((item) => item.id !== currentItem.id)
          if (updatedItems.length === 0) {
            Taro.showToast({title: '至少保留一个环节', icon: 'none'})
            return
          }
          const updatedSession = commitSessionMutation((session) => ({
            ...session,
            items: session.items.filter((item) => item.id !== currentItem.id),
            impromptuRecords: isImpromptuAgendaItem(currentItem)
              ? (session.impromptuRecords || []).filter((record) => record.agendaItemId !== currentItem.id)
              : session.impromptuRecords
          }))
          if (updatedSession) {
            const deleteOps: AgendaOpInput[] = [
              {
                opId: generateUuid(),
                type: 'delete_item',
                itemKey: currentItem.id,
                payload: {}
              }
            ]
            const orderOps = buildStagedReorderAgendaOps(previousItems, updatedSession.items)
            void syncAgendaOpsToCloud(updatedSession, [...deleteOps, ...orderOps])
          }
          Taro.showToast({title: '已删除', icon: 'success'})
        }
      }
    })
  }

  // 长按重置计时
  const handleLongPressReset = () => {
    if (isRunning) {
      Taro.showModal({
        title: '重置计时',
        content: '确定要重置当前环节的计时吗？',
        confirmText: '重置',
        confirmColor: '#f59e0b',
        success: (res) => {
          if (res.confirm) {
            reset()
            if (isCurrentImpromptu && currentSession?.id && currentItem) {
              const deletedAt = Date.now()
              void Promise.all(
                currentImpromptuRecords.map((record) =>
                  AgendaV2DatabaseService.updateImpromptuSpeechRecord({
                    id: record.id,
                    meetingId: currentSession.id,
                    patch: {
                      deletedAt,
                      status: 'cancelled'
                    }
                  })
                )
              ).then((results) => {
                const nextRecords = results
                  .map((result) => (result.success ? result.data : null))
                  .filter(Boolean) as ImpromptuSpeechRecord[]

                if (nextRecords.length > 0) {
                  removeImpromptuRecordsForAgendaItem(currentItem.id)
                }
              })
            }
            void Promise.allSettled([
              appendTimerOfficerEvent(
                'reset_item',
                currentItem || null,
                currentItem?.plannedDuration ?? null,
                {
                  resetToPlannedDuration: true
                },
                undefined,
                currentLiveOverrides
              ),
              persistTimerOfficerLiveCursor(
                currentItem || null,
                currentItem?.plannedDuration ?? null,
                undefined,
                currentLiveOverrides
              )
            ])
            Taro.showToast({title: '已重置', icon: 'success'})
          }
        }
      })
    }
  }

  const openTimeEditDialog = useCallback(() => {
    if (!currentItem) return

    const minutes = Math.floor(currentItem.plannedDuration / 60)
    const seconds = currentItem.plannedDuration % 60
    setSelectedMinutes(minutes)
    setSelectedSeconds(seconds)
    setQuickEditSpeaker(currentItem.speaker || '')
    setShowTimeEditDialog(true)
  }, [currentItem])

  // 双击时间圆盘打开快速编辑
  const handleDoubleTapTimer = useCallback(() => {
    const now = Date.now()
    const timeSinceLastTap = now - lastTapTimeRef.current

    if (timeSinceLastTap < 300) {
      openTimeEditDialog()
    }

    lastTapTimeRef.current = now
  }, [openTimeEditDialog])

  const handleJumpFromAgenda = useCallback(
    async (index: number) => {
      const canLeave = await finalizeImpromptuBeforeLeave()
      if (!canLeave) return

      const sourceItem = currentItem || null
      const targetItem = activeItems[index] || null
      jumpTo(index)
      setShowAgendaDialog(false)

      void Promise.allSettled([
        appendTimerOfficerEvent('jump_item', targetItem, getItemRemainingSeconds(targetItem), {
          fromItemKey: sourceItem?.id || null,
          toItemKey: targetItem?.id || null,
          fromRemainingSeconds: remaining
        }),
        persistTimerOfficerLiveCursor(targetItem, getItemRemainingSeconds(targetItem))
      ])
    },
    [
      activeItems,
      appendTimerOfficerEvent,
      currentItem,
      finalizeImpromptuBeforeLeave,
      jumpTo,
      persistTimerOfficerLiveCursor,
      remaining
    ]
  )

  const handleOpenTimerStats = useCallback(() => {
    void safeNavigateTo('/pages/timer-stats/index')
  }, [])

  const handlePrimaryTimerPress = useCallback(async () => {
    if (isRunning) {
      if (isCurrentImpromptu && speakingImpromptuRecord && currentSession?.id) {
        const requestId = impromptuTimerToggleRequestIdRef.current + 1
        impromptuTimerToggleRequestIdRef.current = requestId
        const requestStartedAt = Date.now()
        const elapsedSnapshot = elapsed
        const optimisticRecord: ImpromptuSpeechRecord = {
          ...speakingImpromptuRecord,
          speechDurationSeconds: impromptuSpeechElapsedSeconds,
          speechStartedAt: undefined,
          updatedAt: requestStartedAt
        }

        mergeImpromptuRecordIntoSession(optimisticRecord, 'replace')
        void AgendaV2DatabaseService.updateImpromptuSpeechRecord({
          id: speakingImpromptuRecord.id,
          meetingId: currentSession.id,
          patch: {
            speechDurationSeconds: impromptuSpeechElapsedSeconds,
            speechStartedAt: null
          }
        }).then((pauseResult) => {
          if (impromptuTimerToggleRequestIdRef.current !== requestId) return
          if (pauseResult.success && pauseResult.data) {
            mergeImpromptuRecordIntoSession(pauseResult.data, 'replace')
            return
          }

          mergeImpromptuRecordIntoSession(speakingImpromptuRecord, 'replace')
          const latestItem = currentItemRef.current
          if (latestItem) {
            updateCurrentItem({
              ...latestItem,
              actualDuration: elapsedSnapshot + Math.max(0, Math.floor((Date.now() - requestStartedAt) / 1000)),
              actualStartTime: undefined,
              actualEndTime: undefined
            })
            start()
          }
          Taro.showToast({title: pauseResult.error || '暂停失败，已恢复', icon: 'none'})
        })
      }

      pause()
      void Promise.allSettled([
        appendTimerOfficerEvent('pause_item', currentItem || null, remaining, {}, undefined, currentLiveOverrides),
        persistTimerOfficerLiveCursor(currentItem || null, remaining, undefined, currentLiveOverrides)
      ])
      return
    }

    await ensureCurrentTimerRunning()
  }, [
    appendTimerOfficerEvent,
    currentItem,
    currentSession?.id,
    currentLiveOverrides,
    ensureCurrentTimerRunning,
    elapsed,
    impromptuSpeechElapsedSeconds,
    isCurrentImpromptu,
    isRunning,
    mergeImpromptuRecordIntoSession,
    pause,
    start,
    remaining,
    speakingImpromptuRecord,
    persistTimerOfficerLiveCursor,
    updateCurrentItem
  ])

  // 保存快速编辑的时间
  const handleSaveTimeEdit = useCallback(() => {
    if (!currentItem || !currentSession) return
    const currentItemId = currentItem.id

    const newDuration = selectedMinutes * 60 + selectedSeconds

    const validation = validateAgendaItemDraft({
      title: currentItem.title,
      speaker: quickEditSpeaker,
      durationText: String(newDuration)
    })

    if (validation.errorMessage || !newDuration) {
      Taro.showToast({title: validation.errorMessage || '时间必须大于0', icon: 'none'})
      return
    }

    const updatedSession = commitAgendaMutation((items) =>
      items.map((item) => {
        if (item.id !== currentItemId) return item
        return {
          ...item,
          plannedDuration: newDuration,
          speaker: validation.speaker
        }
      })
    )

    if (updatedSession) {
      void syncAgendaOpsToCloud(updatedSession, [
        {
          opId: generateUuid(),
          type: 'update_item',
          itemKey: currentItemId,
          payload: {
            patch: {
              plannedDuration: newDuration,
              speaker: validation.speaker
            }
          }
        }
      ])

      const updatedCurrentItem = updatedSession.items.find((item) => item.id === currentItemId) || null
      void persistTimerOfficerLiveCursor(
        updatedCurrentItem,
        updatedCurrentItem ? updatedCurrentItem.plannedDuration - Number(updatedCurrentItem.actualDuration || 0) : null,
        updatedSession.agendaVersion || 1
      )
    }

    setShowTimeEditDialog(false)
    Taro.showToast({title: '当前环节已更新', icon: 'success'})
  }, [
    commitAgendaMutation,
    currentItem,
    currentSession,
    persistTimerOfficerLiveCursor,
    quickEditSpeaker,
    selectedMinutes,
    selectedSeconds,
    syncAgendaOpsToCloud
  ])

  const handleDelayThirtySeconds = useCallback(() => {
    const nextRemainingSeconds = currentItem ? currentItem.plannedDuration - Math.max(0, elapsed - 30) : null
    adjustTime(-30)
    void Promise.allSettled([
      appendTimerOfficerEvent(
        'adjust_time',
        currentItem || null,
        nextRemainingSeconds,
        {
          deltaSeconds: -30
        },
        undefined,
        currentLiveOverrides
      ),
      persistTimerOfficerLiveCursor(currentItem || null, nextRemainingSeconds, undefined, currentLiveOverrides)
    ])
    Taro.showToast({title: '本环节延后30秒', icon: 'none'})
  }, [adjustTime, appendTimerOfficerEvent, currentItem, currentLiveOverrides, elapsed, persistTimerOfficerLiveCursor])

  const handleAdvanceThirtySeconds = useCallback(() => {
    const nextRemainingSeconds = currentItem ? currentItem.plannedDuration - Math.max(0, elapsed + 30) : null
    adjustTime(30)
    void Promise.allSettled([
      appendTimerOfficerEvent(
        'adjust_time',
        currentItem || null,
        nextRemainingSeconds,
        {
          deltaSeconds: 30
        },
        undefined,
        currentLiveOverrides
      ),
      persistTimerOfficerLiveCursor(currentItem || null, nextRemainingSeconds, undefined, currentLiveOverrides)
    ])
    Taro.showToast({title: '本环节提前30秒', icon: 'none'})
  }, [adjustTime, appendTimerOfficerEvent, currentItem, currentLiveOverrides, elapsed, persistTimerOfficerLiveCursor])

  const handlePrevItem = useCallback(async () => {
    if (currentIndex <= 0) return
    const canLeave = await finalizeImpromptuBeforeLeave()
    if (!canLeave) return

    const sourceItem = currentItem || null
    const targetItem = activeItems[currentIndex - 1] || null
    prev()
    void Promise.allSettled([
      appendTimerOfficerEvent('prev_item', targetItem, getItemRemainingSeconds(targetItem), {
        fromItemKey: sourceItem?.id || null,
        toItemKey: targetItem?.id || null,
        fromRemainingSeconds: remaining
      }),
      persistTimerOfficerLiveCursor(targetItem, getItemRemainingSeconds(targetItem))
    ])
  }, [
    activeItems,
    appendTimerOfficerEvent,
    currentIndex,
    currentItem,
    finalizeImpromptuBeforeLeave,
    persistTimerOfficerLiveCursor,
    prev,
    remaining
  ])

  const handleNextItem = useCallback(async () => {
    const isLastItem = currentIndex === totalItems - 1
    if (isCurrentImpromptu) {
      const isSkippingUnstartedImpromptu = !hasCurrentImpromptuPoolStarted
      const decision = await Taro.showModal({
        title: isSkippingUnstartedImpromptu
          ? isLastItem
            ? '跳过即兴并完成会议'
            : '跳过即兴并进入下一节'
          : isLastItem
            ? '结束即兴并完成会议'
            : '结束即兴并进入下一节',
        content: isSkippingUnstartedImpromptu
          ? isLastItem
            ? '当前即兴还未开始，这会直接跳过本节并完成整场会议。'
            : '当前即兴还未开始，这会直接跳过本节并进入下一节，之后仍可通过“上一节”回到这里。'
          : isLastItem
            ? '这会结束当前即兴环节，并直接完成整场会议。'
            : '这会结束当前即兴环节并进入下一节，之后仍可通过“上一节”回到这里。',
        confirmText: isSkippingUnstartedImpromptu
          ? isLastItem
            ? '完成'
            : '跳过'
          : isLastItem
            ? '完成'
            : '下一节',
        cancelText: '取消'
      })
      if (!decision.confirm) return
    }

    const canLeave = await finalizeImpromptuBeforeLeave()
    if (!canLeave) return

    const sourceItem = currentItem || null
    const targetItem = nextItem || null
    next()
    if (isLastItem) {
      void Promise.allSettled([
        appendTimerOfficerEvent('complete_meeting', sourceItem, 0, {
          completedItemKey: sourceItem?.id || null
        }),
        persistTimerOfficerLiveCursor(null, null)
      ])
      return
    }

    void Promise.allSettled([
      appendTimerOfficerEvent('next_item', targetItem, getItemRemainingSeconds(targetItem), {
        fromItemKey: sourceItem?.id || null,
        toItemKey: targetItem?.id || null,
        fromRemainingSeconds: remaining
      }),
      persistTimerOfficerLiveCursor(targetItem, getItemRemainingSeconds(targetItem))
    ])
  }, [
    appendTimerOfficerEvent,
    currentIndex,
    currentItem,
    finalizeImpromptuBeforeLeave,
    hasCurrentImpromptuPoolStarted,
    isCurrentImpromptu,
    next,
    nextItem,
    persistTimerOfficerLiveCursor,
    remaining,
    totalItems
  ])

  // 生成分钟和秒的选择器数据
  const minutesRange = useMemo(() => Array.from({length: 60}, (_, i) => i.toString()), [])
  const secondsRange = useMemo(() => Array.from({length: 60}, (_, i) => i.toString()), [])

  const impromptuCurrentStatusLabel = isCurrentImpromptu
    ? impromptuRunnerStatus === 'speaking'
      ? '发言中'
      : impromptuRunnerStatus === 'pending_speaker'
        ? '下一位已登记'
        : impromptuRunnerStatus === 'completed'
          ? '即兴已结束'
          : impromptuRunnerStatus === 'hosting'
            ? '即兴主持中'
            : '即兴待开始'
    : ''
  const currentSpeakerDisplayName = isCurrentImpromptu
    ? speakingImpromptuRecord?.speakerName
      ? `当前讲者：${speakingImpromptuRecord.speakerName}`
      : pendingImpromptuRecord?.speakerName
        ? `下一位：${pendingImpromptuRecord.speakerName}`
        : `即兴演讲官：${
            !isPlaceholderImpromptuHostName(currentItem?.speaker) && currentItem?.speaker
              ? currentItem.speaker
              : currentImpromptuHostItem?.speaker || currentItem?.speaker || '未设置负责人'
          }`
    : currentItem?.speaker || '主持人'
  const impromptuStatusTone = useMemo(() => {
    if (!isCurrentImpromptu || impromptuRunnerStatus !== 'speaking') return 'neutral'
    if (currentImpromptuSpeechRemainingSeconds <= 0) return 'red'
    if (currentImpromptuSpeechRemainingSeconds <= 30) return 'yellow'
    if (currentImpromptuSpeechRemainingSeconds <= 60) return 'green'
    return 'neutral'
  }, [currentImpromptuSpeechRemainingSeconds, impromptuRunnerStatus, isCurrentImpromptu])
  const impromptuStatusCardClass = useMemo(() => {
    switch (impromptuStatusTone) {
      case 'green':
        return 'ui-panel-sharp px-3 py-2 border-emerald-400/35 bg-emerald-500/10'
      case 'yellow':
        return 'ui-panel-sharp px-3 py-2 border-amber-400/35 bg-amber-500/12'
      case 'red':
        return 'ui-panel-sharp px-3 py-2 border-red-400/35 bg-red-500/12'
      default:
        return 'ui-panel-sharp px-3 py-2'
    }
  }, [impromptuStatusTone])
  const impromptuStatusLabelClass = useMemo(() => {
    switch (impromptuStatusTone) {
      case 'green':
        return 'text-emerald-100'
      case 'yellow':
        return 'text-amber-100'
      case 'red':
        return 'text-red-100'
      default:
        return 'text-white/55'
    }
  }, [impromptuStatusTone])
  const impromptuStatusPrimaryTextClass = useMemo(() => {
    switch (impromptuStatusTone) {
      case 'green':
        return 'text-emerald-50'
      case 'yellow':
        return 'text-amber-50'
      case 'red':
        return 'text-red-50'
      default:
        return 'text-white'
    }
  }, [impromptuStatusTone])
  const impromptuStatusSecondaryTextClass = useMemo(() => {
    switch (impromptuStatusTone) {
      case 'green':
        return 'text-emerald-100/85'
      case 'yellow':
        return 'text-amber-100/85'
      case 'red':
        return 'text-red-100/85'
      default:
        return 'text-white/78'
    }
  }, [impromptuStatusTone])
  const impromptuStatusHintTextClass = useMemo(() => {
    switch (impromptuStatusTone) {
      case 'green':
        return 'text-emerald-100/70'
      case 'yellow':
        return 'text-amber-100/75'
      case 'red':
        return 'text-red-100/75'
      default:
        return 'text-white/60'
    }
  }, [impromptuStatusTone])
  const impromptuStatusTimerSubTextClass = useMemo(() => {
    switch (impromptuStatusTone) {
      case 'green':
        return 'text-emerald-100/75'
      case 'yellow':
        return 'text-amber-100/80'
      case 'red':
        return 'text-red-100/80'
      default:
        return 'text-white/65'
    }
  }, [impromptuStatusTone])

  const bgColorClass = useMemo(() => {
    switch (status) {
      case 'white':
        return 'bg-gradient-page'
      case 'green':
        return isRunning ? 'status-green' : 'bg-gradient-page'
      case 'yellow':
        return 'status-yellow'
      case 'red':
        return 'status-red'
      case 'purple':
        return 'status-purple'
      default:
        return 'bg-gradient-page'
    }
  }, [status, isRunning])

  const timerDialClass = useMemo(() => {
    switch (status) {
      case 'green':
        return 'timer-dial-green'
      case 'yellow':
        return 'timer-dial-yellow'
      case 'red':
        return 'timer-dial-red'
      case 'purple':
        return 'timer-dial-purple'
      default:
        return 'timer-dial-white'
    }
  }, [status])

  const timerTextClass = useMemo(() => {
    switch (status) {
      case 'red':
      case 'purple':
        return 'text-white'
      default:
        return 'text-slate-900'
    }
  }, [status])
  const timerHintClass = useMemo(() => (status === 'white' ? 'text-slate-500' : 'text-white/78'), [status])

  const {windowHeight, windowWidth} = useMemo(() => {
    try {
      const info = Taro.getSystemInfoSync()
      return {
        windowHeight: info.windowHeight || 812,
        windowWidth: info.windowWidth || 375
      }
    } catch {
      return {
        windowHeight: 812,
        windowWidth: 375
      }
    }
  }, [])
  const isCompact = windowHeight < 840 || windowWidth < 380

  if (!currentSession || activeItems.length === 0) return null

  return (
    <View className={`h-screen w-full overflow-hidden flex flex-col transition-colors duration-500 ${bgColorClass}`}>
      <View className={`${isCompact ? 'px-4 pt-6 pb-2' : 'p-5 pt-8'} flex justify-between items-center text-white`}>
        <View className="flex items-center gap-2">
          <View className="ui-btn-secondary w-9 h-9 p-0 rounded-full" onClick={() => Taro.navigateBack()}>
            <View className="i-mdi-chevron-left text-2xl text-foreground" />
          </View>
          <View
            className="h-9 px-3 rounded-full border border-red-400/35 bg-red-500/12 flex items-center justify-center gap-1.5"
            onClick={handleDeleteCurrent}>
            <View className="i-mdi-trash-can-outline text-sm text-red-200" />
            <Text className="text-xs font-semibold text-red-100">删除</Text>
          </View>
        </View>
        <Text className="text-sm font-bold uppercase tracking-widest opacity-80">
          {currentIndex + 1} / {totalItems}
        </Text>
        <View className="w-8" />
      </View>
      <View className={`${isCompact ? 'px-4 pb-2' : 'px-5 pb-3'}`}>
        <Text className={`${isCompact ? 'text-[11px]' : 'text-xs'} ${cloudSyncClassName} block truncate`}>
          {cloudSyncText}
        </Text>
      </View>

      <ScrollView scrollY enableFlex className="flex-1 w-full">
        <View
          className={`${isCompact ? 'w-full h-full px-4 pb-2.5' : 'w-full h-full px-4 pb-3'} flex flex-col justify-between`}>
          <View className={`flex flex-col items-center ${isCompact ? 'px-2 pt-0.5' : 'px-6 pt-1'}`}>
            <View className={`text-center w-full ${isCompact ? 'mb-2' : 'mb-3.5'}`}>
              <Text
                className={
                  isCompact
                    ? 'text-[34px] font-bold text-white block mb-1 max-w-full truncate px-1'
                    : 'text-3xl font-bold text-white block mb-2 drop-shadow-md max-w-full truncate px-1'
                }>
                {currentItem?.title}
              </Text>
              <Text
                className={
                  isCompact
                    ? 'text-lg text-white/90 block max-w-full truncate px-1'
                    : 'text-xl text-white/90 block max-w-full truncate px-1'
                }>
                {currentSpeakerDisplayName}
              </Text>
            </View>

            <View className={`w-full flex items-start justify-center ${isCompact ? 'gap-2' : 'gap-3'}`}>
              <View
                className={`flex flex-col items-center ${isCompact ? 'gap-2 translate-y-0.5' : 'gap-2 translate-y-1'}`}>
                <QuickChip
                  compact={isCompact}
                  iconClass="i-mdi-format-list-bulleted"
                  label="Agenda"
                  onClick={() => setShowAgendaDialog(true)}
                />
              </View>
              <View
                className={`relative flex items-center justify-center ${isCompact ? 'w-40 h-40' : 'w-52 h-52'}`}
                onClick={handleDoubleTapTimer}>
                <View
                  className={`${isCompact ? 'border-[4px]' : 'border-[5px]'} absolute inset-0 rounded-full ${timerDialClass}`}
                />
                <View
                  className={`relative z-10 flex flex-col items-center justify-center text-center ${isCompact ? 'px-3' : 'px-4'}`}>
                  <Text className={`${isCompact ? 'text-[10px]' : 'text-[11px]'} ${timerHintClass} block`}>
                    {remaining >= 0 ? '剩余时间' : '已超时'}
                  </Text>
                  <Text
                    className={`${isCompact ? 'text-[27px]' : 'text-[34px]'} font-mono font-bold tracking-tight ${timerTextClass} ${
                      status === 'purple' ? 'scale-110' : ''
                    } transition-transform block`}>
                    {formatTime(remaining)}
                  </Text>
                  <Text className={`${isCompact ? 'text-[10px]' : 'text-[11px]'} ${timerHintClass} block mt-1`}>
                    计划 {formatTime(currentItem?.plannedDuration || 0)}
                  </Text>
                </View>
              </View>
              <View
                className={`flex flex-col items-center ${isCompact ? 'gap-2 translate-y-0.5' : 'gap-2 translate-y-1'}`}>
                <QuickChip
                  compact={isCompact}
                  iconClass="i-mdi-chart-box-outline"
                  label="实时统计"
                  onClick={handleOpenTimerStats}
                />
                {isCurrentImpromptu && (
                  <QuickChip
                    compact={isCompact}
                    iconClass="i-mdi-format-list-bulleted-square"
                    label={
                      completedImpromptuRecords.length > 0
                        ? `已完成\n${completedImpromptuRecords.length}人`
                        : '已完成\n名单'
                    }
                    onClick={() => setShowCompletedImpromptuDialog(true)}
                  />
                )}
              </View>
            </View>

            <View className={isCompact ? 'mt-0.5 text-center' : 'mt-2 text-center'}>
              <Text className={isCompact ? 'text-xs text-white/85 block' : 'text-sm text-white/85 block'}>
                已用时 {formatTime(elapsed)}
              </Text>
              <Text className={`${isCompact ? 'text-[11px]' : 'text-xs'} text-white/68 block mt-1`}>
                双击圆盘可快调时间和执行人
              </Text>
            </View>

            {isCurrentImpromptu && (
              <View className={`w-full ${isCompact ? 'mt-2' : 'mt-2.5'} space-y-2`}>
                <View className={impromptuStatusCardClass}>
                  <View className="flex items-center justify-between gap-2.5">
                    <View className="min-w-0 flex-1">
                      <Text className={`text-[10px] uppercase tracking-widest block ${impromptuStatusLabelClass}`}>
                        即兴状态
                      </Text>
                      <Text
                        className={`${isCompact ? 'text-[15px]' : 'text-sm'} font-bold block mt-1 ${impromptuStatusPrimaryTextClass}`}>
                        {impromptuCurrentStatusLabel}
                      </Text>
                      <Text
                        className={`${isCompact ? 'text-[12px]' : 'text-[13px]'} block mt-1 truncate ${impromptuStatusSecondaryTextClass}`}>
                        {currentSpeakerDisplayName}
                      </Text>
                      <Text className={`text-[10px] block mt-1 leading-4 ${impromptuStatusHintTextClass}`}>
                        {impromptuGuidanceText}
                      </Text>
                    </View>
                    <View className="text-right shrink-0">
                      <Text className={`text-[10px] uppercase tracking-widest block ${impromptuStatusLabelClass}`}>
                        发言计时
                      </Text>
                      <Text
                        className={`${isCompact ? 'text-[18px]' : 'text-[20px]'} font-mono font-bold block mt-1 ${impromptuStatusPrimaryTextClass}`}>
                        {formatTime(impromptuSpeechElapsedSeconds)}
                      </Text>
                      <Text className={`text-[10px] block mt-1 ${impromptuStatusTimerSubTextClass}`}>
                        剩余 {formatTime(currentImpromptuSpeechRemainingSeconds)}
                      </Text>
                    </View>
                  </View>
                  {typeof impromptuPoolRemainingSeconds === 'number' &&
                    impromptuPoolRemainingSeconds < IMPROMPTU_SPEECH_DURATION_SECONDS &&
                    impromptuRunnerStatus !== 'idle' && (
                      <View className="mt-1.5 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-1">
                        <Text className="text-[11px] text-amber-100 block">
                          即兴总剩余 {formatTime(impromptuPoolRemainingSeconds)}，继续开始下一位时会提示，但不强拦截。
                        </Text>
                      </View>
                    )}
                </View>
              </View>
            )}
          </View>

          <View
            className={`${isCompact ? 'mb-1.5 pt-1.5 pb-2.5' : 'mb-2 pt-1.5 pb-3'} w-full px-0 bg-black/30 border-t border-white/10 overflow-x-hidden`}>
            <View className="ui-panel-sharp mb-1 px-2.5 py-2">
              {isCurrentImpromptu ? (
                <View className={`${isCompact ? 'gap-1.5' : 'gap-2'} grid grid-cols-2`}>
                  {!hasCurrentImpromptuPoolStarted ? (
                    <ActionTile
                      compact={isCompact}
                      iconClass="i-mdi-play-circle-outline"
                      label="开始本节计时"
                      variant="primary"
                      fullWidth
                      dense
                      onClick={() => void handlePrimaryTimerPress()}
                    />
                  ) : impromptuRunnerStatus === 'speaking' ? (
                    <ActionTile
                      compact={isCompact}
                      iconClass="i-mdi-progress-clock"
                      label="进行中"
                      disabled
                      dense
                      onClick={() => {}}
                    />
                  ) : impromptuRunnerStatus !== 'pending_speaker' ? (
                    <ActionTile
                      compact={isCompact}
                      iconClass="i-mdi-account-plus-outline"
                      label="下一位"
                      variant="primary"
                      fullWidth
                      dense
                      onClick={handleOpenImpromptuQueue}
                    />
                  ) : (
                    <ActionTile
                      compact={isCompact}
                      iconClass="i-mdi-play-circle-outline"
                      label={isPendingImpromptuSpeakerSyncing ? '保存中' : isRunning ? '开始发言' : '开始计时并发言'}
                      variant="primary"
                      dense
                      disabled={isPendingImpromptuSpeakerSyncing}
                      onClick={() => void handleStartImpromptuSpeech()}
                    />
                  )}

                  {impromptuRunnerStatus === 'speaking' ? (
                    <ActionTile
                      compact={isCompact}
                      iconClass="i-mdi-stop-circle-outline"
                      label="结束发言"
                      dense
                      onClick={() => void handleFinishImpromptuSpeech()}
                    />
                  ) : impromptuRunnerStatus === 'pending_speaker' ? (
                    <ActionTile
                      compact={isCompact}
                      iconClass="i-mdi-close-circle-outline"
                      label="取消登记"
                      dense
                      onClick={() => void handleCancelPendingImpromptuSpeaker()}
                    />
                  ) : null}
                </View>
              ) : (
                <View className={`${isCompact ? 'gap-2' : 'gap-2.5'} grid grid-cols-2`}>
                  <ActionTile compact={isCompact} iconClass="i-mdi-pencil" label="编辑" onClick={handleOpenEdit} />
                  <ActionTile
                    compact={isCompact}
                    iconClass="i-mdi-plus"
                    label="新增流程"
                    variant="primary"
                    onClick={handleOpenAdd}
                  />
                </View>
              )}
            </View>

            <View style={{height: isCompact ? '4px' : '8px'}} />
          </View>
        </View>
      </ScrollView>

      {/* 底部固定控制区：保证关键按钮始终可见 */}
      <View
        className={`shrink-0 w-full bg-black/45 border-t border-white/12 ${isCompact ? 'px-3 pt-1.5' : 'px-4 pt-3'} pb-[max(env(safe-area-inset-bottom),10px)]`}>
        <View className={`${isCompact ? 'mb-1.5' : 'mb-2'} text-center`}>
          <Text className={isCompact ? 'text-[11px] text-white/88 block' : 'text-xs text-white/88 block'}>
            快速校时（30 秒，仅当前环节）
          </Text>
          <Text className="text-[11px] text-white/68 block mt-0.5">
            当前只建议由时间官操作开始计时，避免多人同时计时导致结果不准。
          </Text>
        </View>

        <View className={`${isCompact ? 'mb-2 gap-2' : 'mb-3 gap-3'} flex items-center justify-center`}>
          <View
            className={`${isCompact ? 'w-[80px] h-10 rounded-xl' : 'w-[96px] h-11 rounded-2xl'} bg-black/25 border border-white/40 flex items-center justify-center text-white active:border-white/60`}
            onClick={handleDelayThirtySeconds}>
            <Text className={isCompact ? 'text-[12px] font-bold leading-none' : 'text-sm font-bold leading-none'}>
              延后30秒
            </Text>
          </View>

          <View
            className={`${isCompact ? 'w-[72px] h-[72px]' : 'w-[84px] h-[84px]'} rounded-full bg-gradient-primary border border-cyan-300/35 flex flex-col items-center justify-center shadow-xl transition-all active:scale-95`}
            onClick={() => void handlePrimaryTimerPress()}
            onLongPress={handleLongPressReset}>
            <Text
              className={
                isCompact
                  ? `font-bold text-white text-center px-2 ${isCurrentImpromptu ? 'text-[12px] leading-tight' : 'text-[15px] leading-none'}`
                  : `font-bold text-white text-center px-2 ${isCurrentImpromptu ? 'text-[13px] leading-tight' : 'text-base leading-none'}`
              }>
              {isCurrentImpromptu ? (isRunning ? '暂停本节计时' : '开始本节计时') : isRunning ? '暂停' : '开始'}
            </Text>
            {!isCompact && (
              <Text className="text-[10px] text-white/70 mt-0.5">
                {isRunning ? '长按重置' : isCurrentImpromptu ? '先开始本节计时，再登记下一位' : '首次会确认'}
              </Text>
            )}
          </View>

          <View
            className={`${isCompact ? 'w-[80px] h-10 rounded-xl' : 'w-[96px] h-11 rounded-2xl'} bg-black/25 border border-white/40 flex items-center justify-center text-white active:border-white/60`}
            onClick={handleAdvanceThirtySeconds}>
            <Text className={isCompact ? 'text-[12px] font-bold leading-none' : 'text-sm font-bold leading-none'}>
              提前30秒
            </Text>
          </View>
        </View>

        <View className={`flex items-center ${isCompact ? 'gap-2' : 'gap-3'}`}>
          <View
            className={`flex-1 ui-btn-secondary ${isCompact ? 'h-10' : 'h-11'} rounded-xl`}
            onClick={handlePrevItem}>
            <Text className={`${isCompact ? 'text-[11px]' : 'text-sm'} font-semibold text-foreground`}>
              {'上一节'}
            </Text>
          </View>
          <View
            className={`flex-1 ui-btn-primary ${isCompact ? 'h-10' : 'h-11'} rounded-xl border-none`}
            onClick={handleNextItem}>
            <Text className={`${isCompact ? 'text-[11px]' : 'text-sm'} font-bold text-white`}>
              {currentIndex === totalItems - 1
                ? '完成'
                : isCurrentImpromptu
                  ? hasCurrentImpromptuPoolStarted
                    ? '结束即兴'
                    : '跳过即兴'
                  : '下一节'}
            </Text>
          </View>
        </View>
      </View>

      {/* 编辑对话框 */}
      {showEditDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowEditDialog(false)}>
          <View className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4" onClick={(e) => e.stopPropagation()}>
            <Text className="text-lg font-bold text-foreground block mb-4">编辑当前环节</Text>
            <View className="space-y-3">
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">环节名称</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={editTitle}
                  onInput={(e) => setEditTitle(e.detail.value)}
                  placeholder="请输入环节名称"
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">执行人</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={editSpeaker}
                  onInput={(e) => setEditSpeaker(e.detail.value)}
                  placeholder="请输入执行人"
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">计划时长（分钟）</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  type="number"
                  value={editDuration}
                  onInput={(e) => setEditDuration(e.detail.value)}
                  placeholder="请输入时长"
                />
              </View>
            </View>
            <View className="flex flex-wrap gap-3 mt-6">
              <Button className="flex-1 ui-btn-secondary h-10 text-sm" onClick={() => setShowEditDialog(false)}>
                取消
              </Button>
              <Button className="flex-1 ui-btn-primary h-10 text-sm font-bold" onClick={handleSaveEdit}>
                保存
              </Button>
            </View>
          </View>
        </View>
      )}

      {/* 新增环节对话框 */}
      {showAddDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowAddDialog(false)}>
          <View className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4" onClick={(e) => e.stopPropagation()}>
            <Text className="text-lg font-bold text-foreground block mb-4">新增环节</Text>
            <Text className="text-xs text-muted-foreground block mb-4 leading-5">
              新流程会插入在当前环节之后，并影响后续环节顺序与整体进度。即兴环节请在会前编排阶段创建。
            </Text>
            <View className="space-y-3">
              {availableRecentItemTitles.length > 0 && (
                <View>
                  <Text className="text-xs text-muted-foreground block mb-2">本场最近新增</Text>
                  <View className="flex flex-wrap gap-2">
                    {availableRecentItemTitles.map((title) => (
                      <View
                        key={title}
                        className="h-8 px-3 rounded-full border border-white/14 bg-white/6 flex items-center justify-center"
                        onClick={() => setAddTitle(title)}>
                        <Text className="text-[11px] text-white/88">{title}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">环节名称</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={addTitle}
                  onInput={(e) => setAddTitle(e.detail.value)}
                  placeholder="请输入环节名称"
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">执行人</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={addSpeaker}
                  onInput={(e) => setAddSpeaker(e.detail.value)}
                  placeholder="请输入本流程执行人"
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">时长（分钟）</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  type="number"
                  value={addDuration}
                  onInput={(e) => setAddDuration(e.detail.value)}
                  placeholder="请输入时长"
                />
              </View>
            </View>
            <View className="flex flex-wrap gap-3 mt-6">
              <Button className="flex-1 ui-btn-secondary h-10 text-sm" onClick={() => setShowAddDialog(false)}>
                取消
              </Button>
              <Button className="flex-1 ui-btn-primary h-10 text-sm font-bold" onClick={handleAddItem}>
                添加
              </Button>
            </View>
          </View>
        </View>
      )}

      {showImpromptuSpeakerDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowImpromptuSpeakerDialog(false)}>
          <View className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4" onClick={(e) => e.stopPropagation()}>
            <Text className="text-lg font-bold text-foreground block mb-4">登记下一位</Text>
            <Text className="text-xs text-muted-foreground block mb-4 leading-5">
              这里只登记姓名，不会立即开始 2 分钟计时。轮到这位时，再点击“开始发言”。
            </Text>
            <View>
              <Text className="text-xs text-muted-foreground block mb-1">姓名</Text>
              <Input
                className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                value={impromptuSpeakerDraft}
                onInput={(e) => setImpromptuSpeakerDraft(e.detail.value)}
                placeholder="请输入即兴演讲者姓名"
                focus
              />
            </View>
            <View className="flex flex-wrap gap-3 mt-6">
              <Button
                className="flex-1 ui-btn-secondary h-10 text-sm"
                onClick={() => setShowImpromptuSpeakerDialog(false)}>
                取消
              </Button>
              <Button
                className="flex-1 ui-btn-primary h-10 text-sm font-bold"
                onClick={() => void handleQueueImpromptuSpeaker()}>
                确定
              </Button>
            </View>
          </View>
        </View>
      )}

      {showCompletedImpromptuDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowCompletedImpromptuDialog(false)}>
          <View
            className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}>
            <View className="flex items-center justify-between gap-3 mb-4">
              <View className="min-w-0 flex-1">
                <Text className="text-lg font-bold text-foreground block">已完成名单</Text>
                <Text className="text-xs text-muted-foreground block mt-1">
                  {completedImpromptuRecords.length > 0
                    ? `共 ${completedImpromptuRecords.length} 位已完成即兴演讲`
                    : '当前还没有完成的即兴演讲者'}
                </Text>
              </View>
              <View
                className="ui-btn-secondary w-9 h-9 p-0 rounded-full shrink-0"
                onClick={() => setShowCompletedImpromptuDialog(false)}>
                <View className="i-mdi-close text-lg text-foreground" />
              </View>
            </View>

            {completedImpromptuRecords.length === 0 ? (
              <View className="rounded-2xl border border-white/12 bg-white/6 px-4 py-8">
                <Text className="text-sm text-muted-foreground block text-center">还没有完成的即兴演讲者。</Text>
              </View>
            ) : (
              <ScrollView scrollY enableFlex className={isCompact ? 'h-72' : 'h-80'} showScrollbar={false}>
                <View className="space-y-2 pr-1">
                  {completedImpromptuRecords.map((record) => (
                    <View
                      key={record.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-black/25 px-3 py-3">
                      <View className="min-w-0 flex-1">
                        <Text className="text-sm font-semibold text-white block truncate">{record.speakerName}</Text>
                        <Text className="text-[11px] text-white/60 block mt-0.5">
                          {record.startedWithLowRemaining ? '低剩余开讲' : '正常开讲'}
                        </Text>
                      </View>
                      <View className="text-right shrink-0">
                        <Text className="text-sm font-mono font-bold text-white block">
                          {formatTime(record.speechDurationSeconds || 0)}
                        </Text>
                        <Text
                          className={`text-[11px] block mt-0.5 ${record.isOvertime ? 'text-amber-200' : 'text-emerald-200'}`}>
                          {record.isOvertime ? '超时' : '准时'}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      )}

      {showAgendaDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowAgendaDialog(false)}>
          <View
            className="ui-card-strong ui-modal-panel rounded-2xl p-4 mx-4 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}>
            <View className="flex items-center justify-between gap-3 mb-3 px-2">
              <View className="min-w-0 flex-1">
                <Text className="text-lg font-bold text-foreground block">Agenda</Text>
                <Text className="text-xs text-muted-foreground block mt-1">点击任一环节即可直接跳转</Text>
              </View>
              <View
                className="ui-btn-secondary w-9 h-9 p-0 rounded-full shrink-0"
                onClick={() => setShowAgendaDialog(false)}>
                <View className="i-mdi-close text-lg text-foreground" />
              </View>
            </View>
            <AgendaPanel
              currentIndex={currentIndex}
              items={activeItems}
              isCompact={isCompact}
              onJump={handleJumpFromAgenda}
            />
          </View>
        </View>
      )}

      {/* 快速编辑时间对话框 */}
      {showTimeEditDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowTimeEditDialog(false)}>
          <View className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4" onClick={(e) => e.stopPropagation()}>
            <Text className="text-lg font-bold text-foreground block mb-4">快速调整当前环节</Text>
            <Text className="text-sm text-muted-foreground block mb-4">当前环节：{currentItem?.title}</Text>
            <Text className="text-xs text-muted-foreground block mb-4 leading-5">
              双击圆盘后可一起调整计划时长和执行人，不会改动当前已累计耗时。
            </Text>

            <View className="mb-4">
              <Text className="text-xs text-muted-foreground block mb-2">执行人</Text>
              <Input
                className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                value={quickEditSpeaker}
                onInput={(e) => setQuickEditSpeaker(e.detail.value)}
                placeholder="请输入执行人"
              />
            </View>

            <View className="flex items-center justify-center flex-wrap gap-4 mb-6">
              {/* 分钟选择器 */}
              <View className="flex-1">
                <Text className="text-xs text-muted-foreground block mb-2 text-center">分钟</Text>
                <Picker
                  mode="selector"
                  range={minutesRange}
                  value={selectedMinutes}
                  onChange={(e) => setSelectedMinutes(Number(e.detail.value))}>
                  <View className="ui-input rounded-lg px-4 py-3 text-center">
                    <Text className="text-2xl font-bold text-foreground">{selectedMinutes}</Text>
                  </View>
                </Picker>
              </View>

              <Text className="text-2xl font-bold text-muted-foreground mt-6">:</Text>

              {/* 秒钟选择器 */}
              <View className="flex-1">
                <Text className="text-xs text-muted-foreground block mb-2 text-center">秒</Text>
                <Picker
                  mode="selector"
                  range={secondsRange}
                  value={selectedSeconds}
                  onChange={(e) => setSelectedSeconds(Number(e.detail.value))}>
                  <View className="ui-input rounded-lg px-4 py-3 text-center">
                    <Text className="text-2xl font-bold text-foreground">
                      {selectedSeconds.toString().padStart(2, '0')}
                    </Text>
                  </View>
                </Picker>
              </View>
            </View>

            <View className="ui-card rounded-lg p-3 mb-4 border-primary/30">
              <Text className="text-sm text-center text-foreground">
                总时长：
                <Text className="font-bold text-primary">
                  {selectedMinutes}分{selectedSeconds}秒
                </Text>
              </Text>
            </View>

            <View className="flex flex-wrap gap-3">
              <Button className="flex-1 ui-btn-secondary h-10 text-sm" onClick={() => setShowTimeEditDialog(false)}>
                取消
              </Button>
              <Button className="flex-1 ui-btn-primary h-10 text-sm font-bold" onClick={handleSaveTimeEdit}>
                确认
              </Button>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}
