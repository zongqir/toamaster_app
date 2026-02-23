import Taro from '@tarojs/taro'
import type {AppSettings, MeetingSession, TimerRule} from '../types/meeting'

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

// 按会议维度做串行同步，避免旧快照晚到覆盖新状态（例如 isCompleted 被回滚）。
const pendingCloudSync = new Map<string, MeetingSession>()
const cloudWorkers = new Map<string, Promise<void>>()
const lastCloudSyncResult = new Map<string, SyncResult>()

const saveSessionToCloud = async (session: MeetingSession): Promise<SyncResult> => {
  try {
    // 动态导入避免循环依赖
    const {DatabaseService} = await import('../db/database')
    const result = await DatabaseService.saveMeeting(session)
    if (result.success) {
      console.log('会议已同步到云端:', session.id)
      return {success: true}
    }

    console.error('同步到云端失败:', result.error)
    return {success: false, error: result.error}
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
      const result = await saveSessionToCloud(nextSession)
      lastCloudSyncResult.set(sessionId, result)
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
    return sessions || []
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

    // 异步同步到云端（不阻塞本地保存）
    if (options?.syncToCloud !== false) {
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

  deleteSession(id: string) {
    const sessions = this.getSessions()
    const filtered = sessions.filter((s) => s.id !== id)
    Taro.setStorageSync(SESSIONS_KEY, filtered)
  }
}
