import Taro from '@tarojs/taro'
import {useCallback, useRef, useState} from 'react'
import {AgendaV2DatabaseService} from '../db/agendaV2Database'
import {DatabaseService} from '../db/database'
import {AgendaOpsSyncQueueService} from '../services/agendaOpsSyncQueue'
import {StorageService} from '../services/storage'
import {useMeetingStore} from '../store/meetingStore'
import type {AgendaOpInput} from '../types/agendaV2'
import type {MeetingSession} from '../types/meeting'

type AgendaOpsSyncStatus = 'idle' | 'syncing' | 'failed'

interface UseAgendaOpsSyncOptions {
  applySession: (session: MeetingSession) => void
  queueErrorPrefix: string
  unknownErrorMessage: string
}

function isAgendaVersionConflict(errorText?: string, code?: string) {
  if (code === 'VERSION_CONFLICT' || code === 'ROW_VERSION_CONFLICT') return true
  if (!errorText) return false
  return errorText.includes('VERSION_CONFLICT') || errorText.includes('ROW_VERSION_CONFLICT')
}

export function useAgendaOpsSync({applySession, queueErrorPrefix, unknownErrorMessage}: UseAgendaOpsSyncOptions) {
  const [agendaOpsSyncStatus, setAgendaOpsSyncStatus] = useState<AgendaOpsSyncStatus>('idle')
  const [agendaOpsSyncError, setAgendaOpsSyncError] = useState('')
  const agendaOpsSyncQueueRef = useRef(Promise.resolve())
  const agendaOpsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshSessionFromCloud = useCallback(
    async (meetingId: string): Promise<boolean> => {
      const cloudSession = await DatabaseService.getMeeting(meetingId)
      if (!cloudSession) {
        Taro.showToast({title: '获取云端最新议程失败', icon: 'none'})
        return false
      }

      applySession(cloudSession)
      StorageService.saveSession(cloudSession, {syncToCloud: false})
      return true
    },
    [applySession]
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
              const conflict = isAgendaVersionConflict(applyResult.error, detail?.code)
              if (conflict) {
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
                applySession(versionedSession)
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
          console.warn(queueErrorPrefix, error)
          setAgendaOpsSyncStatus('failed')
          setAgendaOpsSyncError(error instanceof Error ? error.message : unknownErrorMessage)
        })

      await agendaOpsSyncQueueRef.current
    },
    [applySession, queueErrorPrefix, refreshSessionFromCloud, unknownErrorMessage]
  )

  const enqueueAgendaOps = useCallback(
    async (meetingId: string, ops: AgendaOpInput[]) => {
      if (ops.length > 0) {
        AgendaOpsSyncQueueService.enqueue(meetingId, ops)
      }
      await drainAgendaOpsQueue(meetingId)
    },
    [drainAgendaOpsQueue]
  )

  const waitForAgendaOpsQueue = useCallback(async () => {
    await agendaOpsSyncQueueRef.current
  }, [])

  const clearAgendaOpsRetryTimer = useCallback(() => {
    if (agendaOpsRetryTimerRef.current) {
      clearTimeout(agendaOpsRetryTimerRef.current)
      agendaOpsRetryTimerRef.current = null
    }
  }, [])

  return {
    agendaOpsSyncStatus,
    agendaOpsSyncError,
    drainAgendaOpsQueue,
    enqueueAgendaOps,
    waitForAgendaOpsQueue,
    clearAgendaOpsRetryTimer
  }
}
