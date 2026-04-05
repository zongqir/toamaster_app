import Taro from '@tarojs/taro'
import type {AppSettings, MeetingSession, TimerRule} from '../types/meeting'
import {getMeetingItemBusinessType, IMPROMPTU_BLOCK_DURATION_SECONDS} from '../utils/agendaBusiness'

const SETTINGS_KEY = 'AACTP_TIMER_SETTINGS'
const SESSIONS_KEY = 'AACTP_TIMER_SESSIONS'

const DEFAULT_RULES: Record<string, TimerRule> = {
  short: {
    id: 'short',
    name: '短时规则 (<=3分钟)',
    yellowThreshold: 30,
    redThreshold: 0,
    timeoutThreshold: -15
  },
  long: {
    id: 'long',
    name: '长时规则 (>3分钟)',
    yellowThreshold: 60,
    redThreshold: 0,
    timeoutThreshold: -30
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  rules: DEFAULT_RULES,
  itemTypeDefaults: {
    opening: {ruleId: 'short', defaultDuration: 60},
    intro: {ruleId: 'short', defaultDuration: 120},
    role: {ruleId: 'short', defaultDuration: 60},
    tableTopics: {ruleId: 'short', defaultDuration: 120},
    preparedSpeech: {ruleId: 'long', defaultDuration: 420},
    evaluation: {ruleId: 'short', defaultDuration: 180},
    break: {ruleId: 'short', defaultDuration: 300},
    qa: {ruleId: 'short', defaultDuration: 180},
    voting: {ruleId: 'short', defaultDuration: 120},
    award: {ruleId: 'short', defaultDuration: 180},
    closing: {ruleId: 'short', defaultDuration: 60},
    other: {ruleId: 'short', defaultDuration: 60}
  },
  memberNames: []
  // aiConfig 默认为 undefined，使用文心AI
}

type SyncResult = {success: boolean; error?: string}
export type CloudSyncStatus = 'idle' | 'syncing' | 'failed'
export type SessionCloudSyncState = {
  status: CloudSyncStatus
  error?: string
  updatedAt: number
}

const EMPTY_CLOUD_SYNC_STATE: SessionCloudSyncState = {
  status: 'idle',
  updatedAt: 0
}

function normalizeStoredSession(session: MeetingSession): MeetingSession {
  let changed = false

  if (!session || typeof session !== 'object') {
    throw new Error('INVALID_SESSION_OBJECT')
  }

  if (!Array.isArray(session.items)) {
    throw new Error('INVALID_SESSION_ITEMS')
  }

  const items = session.items.map((item) => {
    if (!item || typeof item !== 'object') {
      changed = true
      return {
        id: '',
        title: '',
        speaker: '',
        plannedDuration: 0,
        type: 'other' as const,
        ruleId: 'short',
        disabled: true
      }
    }

    const businessType = getMeetingItemBusinessType(item)
    const nextBudgetLimitSeconds =
      businessType === 'impromptu_block'
        ? item.budgetLimitSeconds || item.plannedDuration || IMPROMPTU_BLOCK_DURATION_SECONDS
        : item.budgetLimitSeconds

    if (item.businessType !== businessType || item.budgetLimitSeconds !== nextBudgetLimitSeconds) {
      changed = true
      return {
        ...item,
        businessType,
        budgetLimitSeconds: nextBudgetLimitSeconds
      }
    }

    return item
  })

  return changed
    ? {
        ...session,
        items
      }
    : session
}

// 按会议维度做串行同步，避免旧快照晚到覆盖新状态（例如 isCompleted 被回滚）。
const pendingCloudSync = new Map<string, MeetingSession>()
const cloudWorkers = new Map<string, Promise<void>>()
const lastCloudSyncResult = new Map<string, SyncResult>()
const cloudSyncState = new Map<string, SessionCloudSyncState>()
const cloudSyncListeners = new Set<() => void>()

const emitCloudSyncStateChange = () => {
  cloudSyncListeners.forEach((listener) => {
    listener()
  })
}

const setCloudSyncState = (sessionId: string, state: SessionCloudSyncState) => {
  cloudSyncState.set(sessionId, state)
  emitCloudSyncStateChange()
}

const saveSessionToCloud = async (session: MeetingSession): Promise<SyncResult> => {
  try {
    // 动态导入避免循环依赖
    const {DatabaseService} = await import('../db/database')

    // Agenda V2 会话优先走 metadata-only，避免旧 saveMeeting 的整表覆盖路径。
    if (typeof session.agendaVersion === 'number' && session.agendaVersion > 0) {
      const metadataResult = await DatabaseService.updateMeetingMetadata(session.id, session.metadata, {
        isCompleted: session.isCompleted
      })
      if (metadataResult.success) {
        console.log('会议基础信息已同步到云端:', session.id)
        return {success: true}
      }

      console.warn('metadata-only 同步失败，尝试回退 saveMeeting:', metadataResult.error)
    }

    const fallbackResult = await DatabaseService.saveMeeting(session)
    if (fallbackResult.success) {
      console.log('会议已通过回退路径同步到云端:', session.id)
      return {success: true}
    }

    console.error('同步到云端失败:', fallbackResult.error)
    return {success: false, error: fallbackResult.error}
  } catch (error) {
    console.error('同步到云端异常:', error)
    return {success: false, error: error instanceof Error ? error.message : '未知错误'}
  }
}

const runCloudWorker = (sessionId: string): Promise<void> => {
  const existingWorker = cloudWorkers.get(sessionId)
  if (existingWorker) return existingWorker

  const worker = (async () => {
    while (true) {
      const nextSession = pendingCloudSync.get(sessionId)
      if (!nextSession) break

      pendingCloudSync.delete(sessionId)
      setCloudSyncState(sessionId, {status: 'syncing', updatedAt: Date.now()})
      const result = await saveSessionToCloud(nextSession)
      lastCloudSyncResult.set(sessionId, result)

      if (result.success) {
        setCloudSyncState(sessionId, {
          status: pendingCloudSync.has(sessionId) ? 'syncing' : 'idle',
          updatedAt: Date.now()
        })
      } else {
        setCloudSyncState(sessionId, {
          status: 'failed',
          error: result.error,
          updatedAt: Date.now()
        })
      }
    }
  })().finally(() => {
    cloudWorkers.delete(sessionId)

    // 如果 finally 前又有新快照进来，补起一个新的 worker
    if (pendingCloudSync.has(sessionId)) {
      void runCloudWorker(sessionId)
    }
  })

  cloudWorkers.set(sessionId, worker)
  return worker
}

export const StorageService = {
  getSettings(): AppSettings {
    const settings = Taro.getStorageSync(SETTINGS_KEY)
    if (!settings) return DEFAULT_SETTINGS
    return settings
  },

  saveSettings(settings: AppSettings) {
    Taro.setStorageSync(SETTINGS_KEY, settings)
  },

  getSessions(): MeetingSession[] {
    const sessions = Taro.getStorageSync(SESSIONS_KEY)
    if (!Array.isArray(sessions)) {
      return []
    }

    const normalizedSessions = sessions
      .map((session) => {
        try {
          return normalizeStoredSession(session as MeetingSession)
        } catch (error) {
          console.warn('[storage] skip invalid session cache', {error, session})
          return null
        }
      })
      .filter(Boolean) as MeetingSession[]

    if (JSON.stringify(normalizedSessions) !== JSON.stringify(sessions)) {
      Taro.setStorageSync(SESSIONS_KEY, normalizedSessions)
    }

    return normalizedSessions
  },

  getPreferredSession(): MeetingSession | null {
    const sessions = this.getSessions()
    if (sessions.length === 0) return null

    const getSessionProgressScore = (session: MeetingSession): number => {
      const completedItems = session.items.filter(
        (item) => item.actualDuration !== undefined || item.actualEndTime
      ).length
      const totalActual = session.items.reduce((sum, item) => sum + (item.actualDuration || 0), 0)
      const hasInProgressItem = session.items.some((item) => item.actualStartTime && !item.actualEndTime)
      const completedBonus = session.isCompleted ? 1_000_000 : 0
      const inProgressBonus = hasInProgressItem ? 500 : 0

      return completedBonus + completedItems * 1000 + totalActual + inProgressBonus
    }

    return sessions.reduce(
      (best, session) => {
        if (!best) return session

        const bestScore = getSessionProgressScore(best)
        const nextScore = getSessionProgressScore(session)
        if (nextScore === bestScore) {
          return session.createdAt > best.createdAt ? session : best
        }
        return nextScore > bestScore ? session : best
      },
      null as MeetingSession | null
    )
  },

  saveSession(session: MeetingSession, options?: {syncToCloud?: boolean}) {
    const sessions = this.getSessions()
    const index = sessions.findIndex((s) => s.id === session.id)
    if (index > -1) {
      sessions[index] = session
    } else {
      sessions.unshift(session)
    }
    Taro.setStorageSync(SESSIONS_KEY, sessions)

    // 默认仅本地保存，只有显式 syncToCloud: true 才走旧的整份云同步。
    if (options?.syncToCloud === true) {
      setCloudSyncState(session.id, {status: 'syncing', updatedAt: Date.now()})
      this.enqueueCloudSync(session)
    }
  },

  enqueueCloudSync(session: MeetingSession) {
    pendingCloudSync.set(session.id, session)
    void runCloudWorker(session.id)
  },

  async waitForCloudSync(sessionId: string): Promise<SyncResult> {
    if (pendingCloudSync.has(sessionId)) {
      void runCloudWorker(sessionId)
    }

    const worker = cloudWorkers.get(sessionId)
    if (worker) {
      await worker
    }

    return lastCloudSyncResult.get(sessionId) || {success: true}
  },

  async syncToCloud(session: MeetingSession) {
    this.enqueueCloudSync(session)
    return this.waitForCloudSync(session.id)
  },

  getCloudSyncState(sessionId?: string): SessionCloudSyncState {
    if (!sessionId) {
      return EMPTY_CLOUD_SYNC_STATE
    }

    return cloudSyncState.get(sessionId) || EMPTY_CLOUD_SYNC_STATE
  },

  subscribeCloudSyncState(listener: () => void): () => void {
    cloudSyncListeners.add(listener)
    return () => {
      cloudSyncListeners.delete(listener)
    }
  },

  deleteSession(id: string) {
    const sessions = this.getSessions()
    const filtered = sessions.filter((s) => s.id !== id)
    Taro.setStorageSync(SESSIONS_KEY, filtered)
    pendingCloudSync.delete(id)
    lastCloudSyncResult.delete(id)
    cloudSyncState.delete(id)
    emitCloudSyncStateChange()
  }
}
