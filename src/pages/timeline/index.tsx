import {Button, Input, ScrollView, Text, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {useCallback, useEffect, useRef, useState} from 'react'
import {supabase} from '../../client/supabase'
import CompletedMeetingReview from '../../components/CompletedMeetingReview'
import OfficerQuickActions from '../../components/OfficerQuickActions'
import PasswordModal from '../../components/PasswordModal'
import {AgendaV2DatabaseService} from '../../db/agendaV2Database'
import {DatabaseService} from '../../db/database'
import {VotingDatabaseService} from '../../db/votingDatabase'
import {AgendaOpsSyncQueueService} from '../../services/agendaOpsSyncQueue'
import {StorageService} from '../../services/storage'
import {useMeetingStore} from '../../store/meetingStore'
import type {AgendaOpInput} from '../../types/agendaV2'
import type {MeetingItem, MeetingSession} from '../../types/meeting'
import {isImpromptuBlock, isImpromptuSpeech} from '../../utils/agendaBusiness'
import {validateAgendaItemDraft} from '../../utils/agendaItemValidation'
import {buildStagedCreateAgendaOps, buildStagedReorderAgendaOps} from '../../utils/agendaOpBuilders'
import {verifyPassword} from '../../utils/auth'
import {generateId, generateUuid} from '../../utils/id'
import {safeRemoveRealtimeChannel} from '../../utils/realtime'
import {safeNavigateTo, safeSwitchTab} from '../../utils/safeNavigation'

export default function TimelinePage() {
  const {currentSession, setCurrentSession} = useMeetingStore()
  const [items, setItems] = useState<MeetingItem[]>([])
  const [metadata, setMetadata] = useState(currentSession?.metadata || {})
  const [isCloudSession, setIsCloudSession] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [isCompact, setIsCompact] = useState(false)
  const [showMeetingLinkDialog, setShowMeetingLinkDialog] = useState(false)
  const [meetingLinkInput, setMeetingLinkInput] = useState('')
  const [isEditingLink, setIsEditingLink] = useState(false)
  const [showInsertDialog, setShowInsertDialog] = useState(false)
  const [pendingInsertIndex, setPendingInsertIndex] = useState(0)
  const [insertTitle, setInsertTitle] = useState('')
  const [insertSpeaker, setInsertSpeaker] = useState('')
  const [insertDuration, setInsertDuration] = useState('2')
  const [passwordAction, setPasswordAction] = useState<'reset' | 'addLink' | null>(null)
  const [agendaOpsSyncStatus, setAgendaOpsSyncStatus] = useState<'idle' | 'syncing' | 'failed'>('idle')
  const [agendaOpsSyncError, setAgendaOpsSyncError] = useState('')
  const [availableSessions, setAvailableSessions] = useState<MeetingSession[]>([])
  const [sessionPickerLoading, setSessionPickerLoading] = useState(false)
  const agendaOpsSyncQueueRef = useRef(Promise.resolve())
  const agendaOpsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const realtimeSyncBusyRef = useRef(false)
  const deferredPatchRef = useRef<Map<string, Record<string, unknown>>>(new Map())
  const deferredTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const mapItemUpdatesToPatch = useCallback((updates: Partial<MeetingItem>): Record<string, unknown> => {
    const patch: Record<string, unknown> = {}
    if (updates.title !== undefined) patch.title = updates.title
    if (updates.speaker !== undefined) patch.speaker = updates.speaker
    if (updates.plannedDuration !== undefined) patch.plannedDuration = updates.plannedDuration
    if (updates.type !== undefined) patch.itemType = updates.type
    if (updates.ruleId !== undefined) patch.ruleId = updates.ruleId
    if (updates.parentTitle !== undefined) patch.parentTitle = updates.parentTitle
    if (updates.disabled !== undefined) patch.disabled = updates.disabled
    return patch
  }, [])

  const isAgendaVersionConflict = useCallback((errorText?: string, code?: string) => {
    if (code === 'VERSION_CONFLICT' || code === 'ROW_VERSION_CONFLICT') return true
    if (!errorText) return false
    return errorText.includes('VERSION_CONFLICT') || errorText.includes('ROW_VERSION_CONFLICT')
  }, [])

  const refreshSessionFromCloud = useCallback(
    async (meetingId: string): Promise<boolean> => {
      const cloudSession = await DatabaseService.getMeeting(meetingId)
      if (!cloudSession) {
        Taro.showToast({title: '获取云端最新议程失败', icon: 'none'})
        return false
      }

      setCurrentSession(cloudSession)
      setItems(cloudSession.items)
      setMetadata(cloudSession.metadata)
      StorageService.saveSession(cloudSession, {syncToCloud: false})
      return true
    },
    [setCurrentSession]
  )

  const drainAgendaOpsQueue = useCallback(
    async (meetingId: string) => {
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
            const latest = useMeetingStore.getState().currentSession
            if (!latest || latest.id !== meetingId) {
              break
            }

            const bootstrapResult = await AgendaV2DatabaseService.bootstrapAgendaFromSession(latest)
            if (!bootstrapResult.success) {
              console.error('[timeline] bootstrapAgendaFromSession failed', {
                meetingId,
                batch,
                sessionAgendaVersion: latest.agendaVersion,
                result: bootstrapResult
              })
              AgendaOpsSyncQueueService.markRetry(batch.id, bootstrapResult.error || '初始化失败')
              setAgendaOpsSyncStatus('failed')
              setAgendaOpsSyncError(bootstrapResult.error || '初始化失败')
              break
            }

            const baseAgendaVersion = bootstrapResult.data?.agendaVersion || latest.agendaVersion || 1
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
                      // 用户选择刷新，丢弃当前冲突 batch
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
              console.error('[timeline] applyAgendaOps failed', {
                meetingId,
                batch,
                baseAgendaVersion,
                detail,
                error: applyResult.error
              })
              const isVersionConflict = isAgendaVersionConflict(applyResult.error, detail?.code)
              if (isVersionConflict) {
                setAgendaOpsSyncStatus('failed')
                setAgendaOpsSyncError(applyResult.error || detail?.code || '冲突未解决')
                AgendaOpsSyncQueueService.markRetry(batch.id, applyResult.error || detail?.code || '冲突未解决')
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
                const versionedSession = {
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
          console.error('[timeline] Agenda V2 queue failed', {
            meetingId,
            error
          })
          setAgendaOpsSyncStatus('failed')
          setAgendaOpsSyncError(error instanceof Error ? error.message : '同步队列异常')
        })

      await agendaOpsSyncQueueRef.current
    },
    [isAgendaVersionConflict, refreshSessionFromCloud, setCurrentSession]
  )

  const syncAgendaOpsToCloud = useCallback(
    async (ops: AgendaOpInput[]) => {
      const latest = useMeetingStore.getState().currentSession || currentSession
      if (!latest) return

      if (ops.length > 0) {
        AgendaOpsSyncQueueService.enqueue(latest.id, ops)
      }
      await drainAgendaOpsQueue(latest.id)
    },
    [currentSession, drainAgendaOpsQueue]
  )

  Taro.useDidShow(() => {
    const latest = useMeetingStore.getState().currentSession
    if (latest?.id) {
      void drainAgendaOpsQueue(latest.id)
    }
  })

  const flushDeferredPatchForItem = useCallback(
    async (itemId: string) => {
      const timer = deferredTimerRef.current.get(itemId)
      if (timer) {
        clearTimeout(timer)
        deferredTimerRef.current.delete(itemId)
      }

      const patch = deferredPatchRef.current.get(itemId)
      if (!patch) return

      deferredPatchRef.current.delete(itemId)
      await syncAgendaOpsToCloud([
        {
          opId: generateUuid(),
          type: 'update_item',
          itemKey: itemId,
          payload: {patch}
        }
      ])
    },
    [syncAgendaOpsToCloud]
  )

  const flushAllDeferredPatches = useCallback(async () => {
    const ids = Array.from(deferredPatchRef.current.keys())
    for (const id of ids) {
      await flushDeferredPatchForItem(id)
    }
  }, [flushDeferredPatchForItem])

  const scheduleDeferredPatch = useCallback(
    (itemId: string, patch: Record<string, unknown>) => {
      const existingPatch = deferredPatchRef.current.get(itemId) || {}
      deferredPatchRef.current.set(itemId, {...existingPatch, ...patch})

      const prevTimer = deferredTimerRef.current.get(itemId)
      if (prevTimer) clearTimeout(prevTimer)

      const timer = setTimeout(() => {
        void flushDeferredPatchForItem(itemId)
      }, 500)
      deferredTimerRef.current.set(itemId, timer)
    },
    [flushDeferredPatchForItem]
  )

  const commitItemsMutation = useCallback(
    (
      mutate: (prevItems: MeetingItem[]) => MeetingItem[],
      buildOps?: (prevItems: MeetingItem[], nextItems: MeetingItem[]) => AgendaOpInput[]
    ) => {
      const latestSession = useMeetingStore.getState().currentSession || currentSession
      if (!latestSession) return

      const prevItems = latestSession.items
      const nextItems = mutate(prevItems)
      setItems(nextItems)

      const updatedSession = {
        ...latestSession,
        items: nextItems,
        metadata
      }
      setCurrentSession(updatedSession)
      StorageService.saveSession(updatedSession, {syncToCloud: false})

      if (buildOps) {
        const ops = buildOps(prevItems, nextItems)
        if (ops.length > 0) {
          void syncAgendaOpsToCloud(ops)
        }
      }
    },
    [currentSession, metadata, setCurrentSession, syncAgendaOpsToCloud]
  )

  useEffect(() => {
    try {
      const info = Taro.getSystemInfoSync()
      setIsCompact((info.windowWidth || 375) < 380)
    } catch {
      setIsCompact(false)
    }
  }, [])

  useEffect(() => {
    // 检查当前会议是否来自云端
    const checkCloudSession = async () => {
      if (currentSession) {
        const cloudSessions = await DatabaseService.getAllMeetings()
        const isCloud = cloudSessions.some((s) => s.id === currentSession.id)
        setIsCloudSession(isCloud)
      }
    }
    checkCloudSession()
  }, [currentSession])

  // 加载会议链接
  const loadMeetingLink = useCallback(async () => {
    if (!currentSession || !isCloudSession) return

    const link = await DatabaseService.getMeetingLink(currentSession.id)
    if (link) {
      // 使用函数式更新，避免依赖 metadata
      setMetadata((prev) => ({...prev, meetingLink: link}))
    }
  }, [currentSession, isCloudSession])

  useEffect(() => {
    if (currentSession) {
      setItems(currentSession.items)
      setMetadata(currentSession.metadata)
      // 加载会议链接（从数据库）
      if (isCloudSession) {
        loadMeetingLink()
      }
    }
  }, [currentSession, isCloudSession, loadMeetingLink])

  useEffect(() => {
    if (!currentSession?.id) return
    void drainAgendaOpsQueue(currentSession.id)
  }, [currentSession?.id, drainAgendaOpsQueue])

  useEffect(() => {
    if (!currentSession?.id) return
    const meetingId = currentSession.id
    const channel = supabase
      .channel(`agenda-v2-live-${meetingId}`)
      .on(
        'postgres_changes',
        {event: '*', schema: 'public', table: 'agenda_items_v2', filter: `meeting_id=eq.${meetingId}`},
        () => {
          void (async () => {
            if (realtimeSyncBusyRef.current) return
            if (AgendaOpsSyncQueueService.hasPending(meetingId)) return

            realtimeSyncBusyRef.current = true
            try {
              const cloudSession = await DatabaseService.getMeeting(meetingId)
              const latestLocal = useMeetingStore.getState().currentSession
              if (!cloudSession || !latestLocal || latestLocal.id !== meetingId) return
              if ((cloudSession.agendaVersion || 0) <= (latestLocal.agendaVersion || 0)) return

              setCurrentSession(cloudSession)
              setItems(cloudSession.items)
              setMetadata(cloudSession.metadata)
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
            if (realtimeSyncBusyRef.current) return
            if (AgendaOpsSyncQueueService.hasPending(meetingId)) return

            realtimeSyncBusyRef.current = true
            try {
              const cloudSession = await DatabaseService.getMeeting(meetingId)
              const latestLocal = useMeetingStore.getState().currentSession
              if (!cloudSession || !latestLocal || latestLocal.id !== meetingId) return
              if ((cloudSession.agendaVersion || 0) <= (latestLocal.agendaVersion || 0)) return

              setCurrentSession(cloudSession)
              setItems(cloudSession.items)
              setMetadata(cloudSession.metadata)
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

  useEffect(() => {
    return () => {
      if (agendaOpsRetryTimerRef.current) {
        clearTimeout(agendaOpsRetryTimerRef.current)
        agendaOpsRetryTimerRef.current = null
      }
      deferredTimerRef.current.forEach((timer) => {
        clearTimeout(timer)
      })
      deferredTimerRef.current.clear()
      deferredPatchRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (currentSession) return

    let active = true
    setSessionPickerLoading(true)
    void (async () => {
      const localSessions = StorageService.getSessions()
      const cloudSessions = await DatabaseService.getAllMeetings()
      if (!active) return

      const mergedMap = new Map<string, MeetingSession>()
      for (const session of cloudSessions) {
        mergedMap.set(session.id, session)
      }
      for (const session of localSessions) {
        const existing = mergedMap.get(session.id)
        if (!existing || session.createdAt > existing.createdAt) {
          mergedMap.set(session.id, session)
        }
      }

      setAvailableSessions(Array.from(mergedMap.values()).sort((a, b) => b.createdAt - a.createdAt))
      setSessionPickerLoading(false)
    })()

    return () => {
      active = false
    }
  }, [currentSession])

  const handleSaveAndStart = async () => {
    if (!currentSession) return
    await flushAllDeferredPatches()
    await drainAgendaOpsQueue(currentSession.id)
    await agendaOpsSyncQueueRef.current
    const updatedSession = {...currentSession, items, metadata}
    setCurrentSession(updatedSession)
    StorageService.saveSession(updatedSession, {syncToCloud: false})

    if (isCloudSession) {
      const metadataResult = await DatabaseService.updateMeetingMetadata(updatedSession.id, updatedSession.metadata, {
        isCompleted: false
      })
      if (!metadataResult.success) {
        Taro.showToast({title: `基础信息同步失败：${metadataResult.error}`, icon: 'none'})
      }
    }
    void safeNavigateTo('/pages/timer/index')
  }

  const handleCreateVoting = () => {
    if (!currentSession) return

    // 跳转到投票编辑页面
    void safeNavigateTo('/pages/vote-edit/index')
  }

  const handleUpdateWordOfDay = useCallback(
    (nextWordOfDay: string) => {
      const latest = useMeetingStore.getState().currentSession || currentSession
      if (!latest) return

      const normalizedWord = nextWordOfDay.trim()
      const nextMetadata = {
        ...latest.metadata,
        wordOfTheDay: normalizedWord || undefined
      }
      const nextSession = {
        ...latest,
        metadata: nextMetadata
      }

      setMetadata(nextMetadata)
      setCurrentSession(nextSession)
      StorageService.saveSession(nextSession, {syncToCloud: false})

      if (isCloudSession) {
        void DatabaseService.updateMeetingMetadata(latest.id, nextMetadata, {
          isCompleted: Boolean(latest.isCompleted)
        }).then((result) => {
          if (!result.success) {
            Taro.showToast({title: result.error || '每日一词同步失败', icon: 'none'})
          }
        })
      }
    },
    [currentSession, isCloudSession, setCurrentSession]
  )

  const handleResetMeeting = () => {
    if (!currentSession) return

    // 云端会议需要密码验证
    if (isCloudSession) {
      setPasswordAction('reset')
      setShowPasswordModal(true)
    } else {
      // 本地会议直接重置
      Taro.showModal({
        title: '重置会议',
        content: '确定要重置会议数据吗？将清空所有实际用时记录，可以重新开始计时。',
        confirmText: '重置',
        confirmColor: '#f59e0b',
        success: (res) => {
          if (res.confirm) {
            performReset()
          }
        }
      })
    }
  }

  const handlePasswordConfirm = (password: string) => {
    setShowPasswordModal(false)

    if (!verifyPassword(password)) {
      Taro.showToast({title: '密码错误', icon: 'error'})
      return
    }

    // 根据不同的操作执行相应的逻辑
    if (passwordAction === 'reset') {
      performReset()
    } else if (passwordAction === 'addLink') {
      saveMeetingLink()
    }
    setPasswordAction(null)
  }

  const handlePasswordCancel = () => {
    setShowPasswordModal(false)
    setPasswordAction(null)
  }

  // 打开会议链接对话框
  const handleOpenMeetingLink = () => {
    setMeetingLinkInput(metadata.meetingLink || '')
    setIsEditingLink(false) // 默认为查看模式
    setShowMeetingLinkDialog(true)
  }

  // 复制会议链接
  const handleCopyMeetingLink = () => {
    if (!metadata.meetingLink) {
      Taro.showToast({title: '暂无会议链接', icon: 'none'})
      return
    }
    Taro.setClipboardData({
      data: metadata.meetingLink,
      success: () => {
        Taro.showToast({title: '链接已复制', icon: 'success'})
      }
    })
  }

  // 保存会议链接（需要密码验证）
  const handleSaveMeetingLink = async () => {
    if (!meetingLinkInput.trim()) {
      Taro.showToast({title: '请输入会议链接', icon: 'none'})
      return
    }

    // 任何修改链接的操作都需要密码验证
    setPasswordAction('addLink')
    setShowPasswordModal(true)
  }

  // 执行保存会议链接
  const saveMeetingLink = async () => {
    if (!currentSession) return

    const updatedMetadata = {...metadata, meetingLink: meetingLinkInput.trim()}
    setMetadata(updatedMetadata)

    const updatedSession = {...currentSession, metadata: updatedMetadata}
    setCurrentSession(updatedSession)
    StorageService.saveSession(updatedSession, {syncToCloud: false})

    // 保存到数据库（使用独立的 meeting_links 表）
    if (isCloudSession) {
      const result = await DatabaseService.saveMeetingLink(currentSession.id, meetingLinkInput.trim())
      if (!result.success) {
        Taro.showToast({title: `保存失败：${result.error}`, icon: 'none'})
        return
      }
    }

    setShowMeetingLinkDialog(false)
    setIsEditingLink(false)
    Taro.showToast({title: '链接已保存', icon: 'success'})
  }

  const performReset = async () => {
    if (!currentSession) return
    await flushAllDeferredPatches()
    await agendaOpsSyncQueueRef.current

    // 1. 清空所有实际用时记录
    const resetItems = items.map((item) => ({
      ...item,
      actualDuration: undefined,
      actualStartTime: undefined,
      actualEndTime: undefined
    }))
    setItems(resetItems)

    // 2. 清除会议链接（从本地状态）
    const resetMetadata = {
      ...metadata,
      meetingLink: undefined
    }
    setMetadata(resetMetadata)

    // 3. 删除数据库中的会议链接
    if (isCloudSession && currentSession.id) {
      const deleteLinkResult = await DatabaseService.deleteMeetingLink(currentSession.id)
      if (!deleteLinkResult.success) {
        console.error('删除会议链接失败:', deleteLinkResult.error)
        // 继续执行重置，不因链接删除失败而中断
      }
    }

    // 4. 删除投票会话及其所有相关数据（通过级联删除自动处理）
    if (isCloudSession && currentSession.id) {
      const deleteVotingResult = await VotingDatabaseService.deleteVotingSession(currentSession.id)
      if (!deleteVotingResult.success) {
        console.error('删除投票会话失败:', deleteVotingResult.error)
        // 继续执行重置，不因投票删除失败而中断
      }
    }

    // 5. 更新会议状态
    const resetSession = {
      ...currentSession,
      items: resetItems,
      impromptuRecords: [],
      metadata: resetMetadata,
      isCompleted: false
    }
    setCurrentSession(resetSession)
    StorageService.saveSession(resetSession, {syncToCloud: false})

    if (isCloudSession && currentSession.id) {
      const clearImpromptuResult = await AgendaV2DatabaseService.clearImpromptuSpeechRecords(currentSession.id)
      if (!clearImpromptuResult.success) {
        console.error('清空即兴记录失败:', clearImpromptuResult.error)
      }
    }

    // 6. 同步重置后的计时字段到 Agenda V2
    const checkpointResetOps: AgendaOpInput[] = resetItems.map((item) => ({
      opId: generateUuid(),
      type: 'timer_checkpoint',
      itemKey: item.id,
      payload: {
        patch: {
          actualDuration: null,
          actualStartTime: null,
          actualEndTime: null
        }
      }
    }))
    if (checkpointResetOps.length > 0) {
      await syncAgendaOpsToCloud(checkpointResetOps)
    }

    // 7. 会议完成状态回滚
    if (isCloudSession) {
      const statusResult = await DatabaseService.updateMeetingMetadata(currentSession.id, resetMetadata, {
        isCompleted: false
      })
      if (!statusResult.success) {
        Taro.showToast({title: `状态同步失败：${statusResult.error}`, icon: 'none'})
        return
      }
    }

    Taro.showToast({title: '已重置会议', icon: 'success'})
  }

  const updateItem = (id: string, updates: Partial<MeetingItem>, options?: {deferred?: boolean}) => {
    const normalizedUpdates = {...updates}

    if (typeof normalizedUpdates.title === 'string') {
      const trimmedTitle = normalizedUpdates.title.trim()
      if (!trimmedTitle) return
      normalizedUpdates.title = trimmedTitle
    }

    if (typeof normalizedUpdates.speaker === 'string') {
      const trimmedSpeaker = normalizedUpdates.speaker.trim()
      if (!trimmedSpeaker) return
      normalizedUpdates.speaker = trimmedSpeaker
    }

    const patch = mapItemUpdatesToPatch(normalizedUpdates)
    commitItemsMutation((prev) => prev.map((item) => (item.id === id ? {...item, ...normalizedUpdates} : item)))

    if (Object.keys(patch).length === 0) return

    if (options?.deferred) {
      scheduleDeferredPatch(id, patch)
      return
    }

    void syncAgendaOpsToCloud([
      {
        opId: generateUuid(),
        type: 'update_item',
        itemKey: id,
        payload: {patch}
      }
    ])
  }

  const openInsertDialog = (index: number) => {
    setPendingInsertIndex(index)
    setInsertTitle('')
    setInsertSpeaker('')
    setInsertDuration('2')
    setShowInsertDialog(true)
  }

  const removeItem = (id: string) => {
    const pendingTimer = deferredTimerRef.current.get(id)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      deferredTimerRef.current.delete(id)
    }
    deferredPatchRef.current.delete(id)

    let removedIndex = -1
    let removedIds = new Set<string>()
    commitItemsMutation(
      (prev) => {
        removedIndex = prev.findIndex((item) => item.id === id)
        const target = prev.find((item) => item.id === id) || null
        const nextRemovedIds = new Set<string>([id])

        if (target && isImpromptuBlock(target)) {
          prev
            .filter((item) => isImpromptuSpeech(item) && item.agendaParentItemId === target.id)
            .forEach((item) => {
              nextRemovedIds.add(item.id)
            })
        }

        if (target && isImpromptuSpeech(target) && target.agendaParentItemId) {
          const siblingCount = prev.filter(
            (item) => isImpromptuSpeech(item) && item.agendaParentItemId === target.agendaParentItemId
          ).length
          if (siblingCount <= 1) {
            nextRemovedIds.add(target.agendaParentItemId)
          }
        }

        removedIds = nextRemovedIds
        return prev.filter((item) => !nextRemovedIds.has(item.id))
      },
      (prev, next) => {
        if (removedIndex < 0) return []
        const shiftedIds = new Set(next.filter((_, idx) => idx >= removedIndex).map((item) => item.id))
        const deleteOps = Array.from(removedIds).map((itemId) => ({
          opId: generateUuid(),
          type: 'delete_item' as const,
          itemKey: itemId,
          payload: {}
        }))
        return [...deleteOps, ...buildStagedReorderAgendaOps(prev, next, shiftedIds)]
      }
    )
  }

  // 上移环节
  const moveItemUp = (index: number) => {
    if (index === 0) return
    if (!items[index] || !items[index - 1]) return

    commitItemsMutation(
      (prev) => {
        const newItems = [...prev]
        ;[newItems[index - 1], newItems[index]] = [newItems[index], newItems[index - 1]]
        return newItems
      },
      (prev, next) => buildStagedReorderAgendaOps(prev, next)
    )
  }

  // 下移环节
  const moveItemDown = (index: number) => {
    if (index === items.length - 1) return
    if (!items[index] || !items[index + 1]) return

    commitItemsMutation(
      (prev) => {
        const newItems = [...prev]
        ;[newItems[index], newItems[index + 1]] = [newItems[index + 1], newItems[index]]
        return newItems
      },
      (prev, next) => buildStagedReorderAgendaOps(prev, next)
    )
  }

  // 在指定位置插入新环节
  const insertItemAt = (index: number) => {
    const validation = validateAgendaItemDraft({
      title: insertTitle,
      speaker: insertSpeaker,
      durationText: insertDuration
    })

    if (validation.errorMessage || !validation.durationMinutes) {
      Taro.showToast({title: validation.errorMessage || '请填写正确的环节信息', icon: 'none'})
      return
    }

    const newItem: MeetingItem = {
      id: generateId('item'),
      title: validation.title,
      speaker: validation.speaker,
      plannedDuration: validation.durationMinutes * 60,
      type: 'other',
      ruleId: 'short'
    }

    commitItemsMutation(
      (prev) => {
        const newItems = [...prev]
        newItems.splice(index, 0, newItem)
        return newItems
      },
      (prev, next) => {
        return [...buildStagedCreateAgendaOps(prev, next, [newItem]), ...buildStagedReorderAgendaOps(prev, next)]
      }
    )

    setShowInsertDialog(false)
    setInsertTitle('')
    setInsertSpeaker('')
    setInsertDuration('2')
    Taro.showToast({title: '已添加环节', icon: 'success'})
  }

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  if (!currentSession) {
    return (
      <View className="h-screen bg-gradient-page flex flex-col">
        <View className="px-4 pt-8 pb-4 border-b border-border/60 bg-background/90">
          <Text className="text-[22px] font-black text-foreground block">选择会议</Text>
          <Text className="text-sm text-muted-foreground block mt-1">
            先选择一场会议，再进入流程预览和三官快捷记录。
          </Text>
        </View>
        <ScrollView className="flex-1" scrollY>
          <View className="px-4 py-4 space-y-3">
            {sessionPickerLoading ? (
              <View className="ui-card p-4 flex items-center justify-center">
                <Text className="text-sm text-muted-foreground">会议列表加载中...</Text>
              </View>
            ) : availableSessions.length > 0 ? (
              availableSessions.map((session) => (
                <View
                  key={session.id}
                  className="ui-card p-4 active:opacity-80"
                  onClick={() => {
                    setCurrentSession(session)
                    StorageService.saveSession(session, {syncToCloud: false})
                  }}>
                  <Text className="text-base font-bold text-foreground block truncate">
                    {session.metadata.theme || '未命名会议'}
                  </Text>
                  <Text className="text-xs text-muted-foreground block mt-1">
                    {session.metadata.meetingNo ? `第 ${session.metadata.meetingNo} 次` : '未设置会议次数'} ·{' '}
                    {session.items.length} 个环节
                  </Text>
                </View>
              ))
            ) : (
              <View className="ui-card p-5">
                <Text className="text-base font-semibold text-foreground block">暂无可选会议</Text>
                <Text className="text-sm text-muted-foreground block mt-1">返回会议列表新建或选择一场会议。</Text>
                <Button
                  className="ui-btn-primary h-11 text-sm font-bold mt-4"
                  onClick={() => void safeSwitchTab('/pages/history/index')}>
                  返回会议列表
                </Button>
              </View>
            )}
          </View>
        </ScrollView>
      </View>
    )
  }

  const isCompleted = currentSession?.isCompleted || false
  const agendaSyncText =
    agendaOpsSyncStatus === 'syncing'
      ? '议程增量同步中...'
      : agendaOpsSyncStatus === 'failed'
        ? `议程增量同步失败${agendaOpsSyncError ? `：${agendaOpsSyncError}` : ''}`
        : '议程已增量保存'

  return (
    <View className="h-screen bg-gradient-page flex flex-col">
      <View className="p-4 pt-8 bg-background/90 border-b border-border/70 flex-shrink-0 backdrop-blur-sm">
        <View className="flex justify-between items-start mb-4 gap-2">
          <Text className="text-[22px] font-black text-foreground flex-1 min-w-0 truncate pr-1">
            {isCompleted ? '会议复盘' : '流程预览'}
          </Text>
          <View className="flex flex-wrap gap-2 justify-end">
            {!isCompleted && (
              <View
                className="ui-btn-secondary h-10 px-3 rounded-lg flex items-center gap-1.5"
                onClick={handleCreateVoting}>
                <View className="i-mdi-vote text-base text-foreground" />
                <Text className="text-xs font-semibold text-foreground">投票</Text>
              </View>
            )}
            {isCloudSession && (
              <View
                className="ui-btn-secondary h-10 px-3 rounded-lg flex items-center gap-1.5"
                onClick={handleOpenMeetingLink}>
                <View className="i-mdi-link-variant text-base text-foreground" />
                <Text className="text-xs font-semibold text-foreground">链接</Text>
              </View>
            )}
            <View
              className="ui-btn-secondary h-10 px-3 rounded-lg flex items-center gap-1.5"
              onClick={() => void safeSwitchTab('/pages/history/index')}>
              <View className="i-mdi-undo text-base text-foreground" />
              <Text className="text-xs font-semibold text-foreground">返回</Text>
            </View>
            {isCompleted && (
              <View
                className="h-10 px-3 rounded-lg flex items-center gap-1.5 border border-amber-500/55 bg-amber-500/10 active:bg-amber-500/15"
                onClick={handleResetMeeting}>
                <View className="i-mdi-refresh text-base text-amber-400" />
                <Text className="text-xs font-semibold text-amber-300">重置</Text>
              </View>
            )}
          </View>
        </View>
        {!isCompleted && (
          <Text
            className={`mb-2 block truncate text-xs ${
              agendaOpsSyncStatus === 'failed'
                ? 'text-red-300'
                : agendaOpsSyncStatus === 'syncing'
                  ? 'text-amber-300'
                  : 'text-emerald-300'
            }`}>
            {agendaSyncText}
          </Text>
        )}

        {!isCompleted && (
          <View className={`grid ${isCompact ? 'grid-cols-1' : 'grid-cols-2'} gap-2`}>
            <View className="ui-card p-2">
              <Text className="text-xs text-muted-foreground block mb-0.5 uppercase tracking-wider">会议主题</Text>
              <Input
                className="text-sm text-foreground w-full font-medium mt-1"
                value={metadata.theme}
                onInput={(e) => setMetadata({...metadata, theme: e.detail.value})}
                placeholder="请输入主题"
                adjustPosition={false}
              />
            </View>
            <View className="ui-card p-2">
              <Text className="text-xs text-muted-foreground block mb-0.5 uppercase tracking-wider">开始时间</Text>
              <Input
                className="text-sm text-foreground w-full font-medium mt-1"
                value={metadata.startTime}
                onInput={(e) => setMetadata({...metadata, startTime: e.detail.value})}
                placeholder="19:30"
                adjustPosition={false}
              />
            </View>
          </View>
        )}

        {!isCompleted && metadata.votingId && (
          <View className="mt-2 ui-card border-primary/30">
            <View className="flex justify-between items-center flex-wrap gap-2">
              <View className="flex-1 min-w-0">
                <Text className="text-[10px] text-muted-foreground block mb-0.5 uppercase tracking-wider">投票ID</Text>
                <Text className="text-lg font-bold text-foreground tracking-widest break-all">{metadata.votingId}</Text>
              </View>
              <View className="flex gap-2 justify-end shrink-0">
                <View
                  className="ui-top-action-btn w-11 h-11"
                  onClick={() => {
                    Taro.setClipboardData({
                      data: metadata.votingId!,
                      success: () => {
                        Taro.showToast({title: 'ID已复制', icon: 'success'})
                      }
                    })
                  }}>
                  <View className="i-mdi-content-copy text-base text-foreground" />
                </View>
                <View
                  className="ui-top-action-btn w-11 h-11 bg-primary border-primary/60 active:bg-primary/85"
                  onClick={() => {
                    void safeNavigateTo(`/pages/vote-result/index?id=${metadata.votingId}`)
                  }}>
                  <View className="i-mdi-chart-bar text-base text-white" />
                </View>
              </View>
            </View>
          </View>
        )}
      </View>

      {isCompleted ? (
        <CompletedMeetingReview
          session={currentSession}
          metadata={metadata}
          onOpenMeetingLink={handleOpenMeetingLink}
          onOpenVoteResult={() => {
            if (!metadata.votingId) return
            void safeNavigateTo(`/pages/vote-result/index?id=${metadata.votingId}`)
          }}
        />
      ) : (
        <ScrollView className="flex-1 min-h-0 pt-3" scrollY enableBackToTop>
          <View className="space-y-3 pl-4 pr-6 pb-3 max-w-full overflow-x-hidden">
            {items.map((item, index) => (
              <View key={item.id}>
                {index === 0 && (
                  <View className="flex items-center justify-center py-2 mb-2" onClick={() => openInsertDialog(0)}>
                    <View className="ui-btn-secondary h-9 px-4 rounded-full flex items-center gap-1.5">
                      <View className="i-mdi-plus text-base text-foreground" />
                      <Text className="text-sm text-foreground font-semibold">在此处插入环节</Text>
                    </View>
                  </View>
                )}

                <View
                  className={`ui-card-sharp p-4 ${item.disabled ? 'opacity-45 border-dashed' : 'border-l-2 border-l-primary/35'} flex flex-col relative`}>
                  <View className="flex justify-between items-start flex-wrap gap-2 mb-2">
                    <View className="flex items-center flex-1 min-w-0">
                      <View className="w-7 h-7 rounded-full bg-primary/20 border-2 border-primary/50 flex items-center justify-center mr-2">
                        <Text className="text-xs font-bold text-foreground">{index + 1}</Text>
                      </View>
                      <Input
                        className="text-base font-semibold text-foreground flex-1 min-w-0"
                        value={item.title}
                        onInput={(e) => updateItem(item.id, {title: e.detail.value}, {deferred: true})}
                        onBlur={() => {
                          void flushDeferredPatchForItem(item.id)
                        }}
                        adjustPosition={false}
                      />
                    </View>
                    <View className="flex items-center flex-wrap gap-1.5 justify-end">
                      <View
                        className={`ui-mini-icon-btn ${index === 0 ? 'opacity-40' : ''}`}
                        onClick={() => index > 0 && moveItemUp(index)}>
                        <View className="i-mdi-chevron-up text-base text-foreground/85" />
                      </View>
                      <View
                        className={`ui-mini-icon-btn ${index === items.length - 1 ? 'opacity-40' : ''}`}
                        onClick={() => index < items.length - 1 && moveItemDown(index)}>
                        <View className="i-mdi-chevron-down text-base text-foreground/85" />
                      </View>
                      <View className="ui-mini-icon-btn" onClick={() => updateItem(item.id, {disabled: !item.disabled})}>
                        {item.disabled ? (
                          <View className="i-mdi-eye-off text-base text-foreground/85" />
                        ) : (
                          <View className="i-mdi-eye text-base text-foreground/85" />
                        )}
                      </View>
                      <View
                        className="ui-mini-icon-btn bg-destructive/80 border-red-400/35 active:bg-destructive"
                        onClick={() => removeItem(item.id)}>
                        <View className="i-mdi-trash-can-outline text-base text-white" />
                      </View>
                    </View>
                  </View>

                  <View className="flex items-center justify-between mt-2 gap-2 flex-wrap">
                    <View className="ui-panel-sharp p-2 flex items-center gap-3 min-w-0 flex-1 flex-wrap">
                      <View className="flex items-center">
                        <View className="i-mdi-account-outline text-sm text-muted-foreground mr-1" />
                        <Input
                          className="text-sm text-foreground/90 flex-1 min-w-[96px]"
                          value={item.speaker}
                          onInput={(e) => updateItem(item.id, {speaker: e.detail.value}, {deferred: true})}
                          onBlur={() => {
                            void flushDeferredPatchForItem(item.id)
                          }}
                          placeholder="负责人"
                          adjustPosition={false}
                        />
                      </View>
                      <View className="flex items-center">
                        <View className="i-mdi-clock-outline text-sm text-muted-foreground mr-1" />
                        <Text className="text-sm text-foreground/90">{formatDuration(item.plannedDuration)}</Text>
                      </View>
                    </View>

                    <View className="ui-panel-sharp p-1 flex items-center gap-1">
                      <View
                        className="ui-btn-secondary h-10 px-3 rounded-lg"
                        onClick={() => updateItem(item.id, {plannedDuration: Math.max(30, item.plannedDuration - 30)})}>
                        <Text className="text-xs font-semibold">-30s</Text>
                      </View>
                      <View
                        className="ui-btn-secondary h-10 px-3 rounded-lg"
                        onClick={() => updateItem(item.id, {plannedDuration: item.plannedDuration + 30})}>
                        <Text className="text-xs font-semibold">+30s</Text>
                      </View>
                    </View>
                  </View>
                </View>

                <View className="flex items-center justify-center py-2" onClick={() => openInsertDialog(index + 1)}>
                  <View className="ui-btn-secondary h-9 px-4 rounded-full flex items-center gap-1.5">
                    <View className="i-mdi-plus text-base text-foreground" />
                    <Text className="text-sm text-foreground font-semibold">在此处插入环节</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      {!isCompleted && (
        <View className="shrink-0 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)] bg-gradient-to-t from-background via-background/95 to-transparent border-t border-border/60">
          <OfficerQuickActions
            meetingId={currentSession.id}
            items={items}
            wordOfTheDay={metadata.wordOfTheDay}
            onUpdateWordOfDay={handleUpdateWordOfDay}
            onStartTimer={handleSaveAndStart}
          />
        </View>
      )}

      {showInsertDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowInsertDialog(false)}>
          <View className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4" onClick={(e) => e.stopPropagation()}>
            <Text className="text-lg font-bold text-foreground block mb-4">新增环节</Text>
            <Text className="text-xs text-muted-foreground block mb-4 leading-5">
              环节名称、执行人和时间都必须填写后才能插入。
            </Text>
            <View className="space-y-3">
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">环节名称</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={insertTitle}
                  onInput={(e) => setInsertTitle(e.detail.value)}
                  placeholder="请输入环节名称"
                  adjustPosition={false}
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">执行人</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={insertSpeaker}
                  onInput={(e) => setInsertSpeaker(e.detail.value)}
                  placeholder="请输入执行人"
                  adjustPosition={false}
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">时间（分钟）</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  type="number"
                  value={insertDuration}
                  onInput={(e) => setInsertDuration(e.detail.value)}
                  placeholder="请输入时间"
                  adjustPosition={false}
                />
              </View>
            </View>
            <View className="flex flex-wrap gap-3 mt-6">
              <Button className="flex-1 ui-btn-secondary h-10 text-sm" onClick={() => setShowInsertDialog(false)}>
                取消
              </Button>
              <Button
                className="flex-1 ui-btn-primary h-10 text-sm font-bold"
                onClick={() => insertItemAt(pendingInsertIndex)}>
                添加
              </Button>
            </View>
          </View>
        </View>
      )}

      <PasswordModal visible={showPasswordModal} onConfirm={handlePasswordConfirm} onCancel={handlePasswordCancel} />

      {/* 会议链接对话框 */}
      {showMeetingLinkDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70]"
          onClick={() => {
            setShowMeetingLinkDialog(false)
            setIsEditingLink(false)
          }}>
          <View
            className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4 w-full max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <Text className="text-lg font-bold text-foreground block mb-4">
              {!metadata.meetingLink || isEditingLink ? '编辑会议链接' : '会议链接'}
            </Text>

            {!metadata.meetingLink || isEditingLink ? (
              <>
                <Text className="text-sm text-muted-foreground block mb-3">
                  {!metadata.meetingLink ? '添加' : '修改'}会议链接需要密码验证，请输入链接后点击保存
                </Text>
                <View className="ui-input rounded-lg px-3 py-2 mb-4">
                  <Input
                    className="text-sm text-foreground w-full"
                    value={meetingLinkInput}
                    onInput={(e) => setMeetingLinkInput(e.detail.value)}
                    placeholder="请输入会议链接"
                    adjustPosition={false}
                  />
                </View>
              </>
            ) : (
              <>
                <View className="bg-primary/10 rounded-lg p-3 mb-4 border border-primary/30">
                  <Text className="text-sm text-foreground break-all">{meetingLinkInput || '暂无链接'}</Text>
                </View>
                <Text className="text-xs text-muted-foreground block mb-3">💡 点击下方按钮可复制链接或编辑</Text>
              </>
            )}

            <View className="flex flex-wrap gap-3">
              <Button
                className="flex-1 ui-btn-secondary h-10 text-sm"
                onClick={() => {
                  setShowMeetingLinkDialog(false)
                  setIsEditingLink(false)
                }}>
                {!metadata.meetingLink || isEditingLink ? '取消' : '关闭'}
              </Button>
              {!metadata.meetingLink || isEditingLink ? (
                <Button className="flex-1 ui-btn-primary h-10 text-sm font-bold" onClick={handleSaveMeetingLink}>
                  保存
                </Button>
              ) : (
                <>
                  <Button className="flex-1 ui-btn-secondary h-10 text-sm font-bold" onClick={handleCopyMeetingLink}>
                    复制
                  </Button>
                  <Button
                    className="flex-1 ui-btn-primary h-10 text-sm font-bold"
                    onClick={() => setIsEditingLink(true)}>
                    编辑
                  </Button>
                </>
              )}
            </View>
          </View>
        </View>
      )}
    </View>
  )
}
