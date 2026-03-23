import Taro from '@tarojs/taro'
import type {AgendaOpInput} from '../types/agendaV2'
import {generateId} from '../utils/id'

const AGENDA_OPS_QUEUE_KEY = 'AACTP_AGENDA_OPS_QUEUE_V1'
const MAX_BACKOFF_MS = 60_000
const BASE_BACKOFF_MS = 1_000

export type PendingAgendaOpsBatch = {
  id: string
  meetingId: string
  ops: AgendaOpInput[]
  attempts: number
  nextRetryAt: number
  createdAt: number
  updatedAt: number
  lastError?: string
}

function nowMs() {
  return Date.now()
}

function safeLoadQueue(): PendingAgendaOpsBatch[] {
  const raw = Taro.getStorageSync(AGENDA_OPS_QUEUE_KEY)
  if (!raw || !Array.isArray(raw)) return []

  return raw.filter((item): item is PendingAgendaOpsBatch => {
    return (
      item &&
      typeof item.id === 'string' &&
      typeof item.meetingId === 'string' &&
      Array.isArray(item.ops) &&
      typeof item.attempts === 'number' &&
      typeof item.nextRetryAt === 'number'
    )
  })
}

function safeSaveQueue(queue: PendingAgendaOpsBatch[]) {
  Taro.setStorageSync(AGENDA_OPS_QUEUE_KEY, queue)
}

function calcBackoff(attempts: number) {
  const exp = Math.max(0, attempts)
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exp)
}

export const AgendaOpsSyncQueueService = {
  enqueue(meetingId: string, ops: AgendaOpInput[]): PendingAgendaOpsBatch | null {
    if (!meetingId || ops.length === 0) return null

    const batch: PendingAgendaOpsBatch = {
      id: generateId('agenda_batch'),
      meetingId,
      ops,
      attempts: 0,
      nextRetryAt: nowMs(),
      createdAt: nowMs(),
      updatedAt: nowMs()
    }

    const queue = safeLoadQueue()
    queue.push(batch)
    safeSaveQueue(queue)
    return batch
  },

  listReadyBatches(meetingId: string, currentTs?: number): PendingAgendaOpsBatch[] {
    const ts = currentTs || nowMs()
    const queue = safeLoadQueue()
    return queue.filter((item) => item.meetingId === meetingId && item.nextRetryAt <= ts)
  },

  getNextRetryAt(meetingId: string): number | null {
    const queue = safeLoadQueue().filter((item) => item.meetingId === meetingId)
    if (queue.length === 0) return null
    return Math.min(...queue.map((item) => item.nextRetryAt))
  },

  markSuccess(batchId: string) {
    const queue = safeLoadQueue().filter((item) => item.id !== batchId)
    safeSaveQueue(queue)
  },

  markRetry(batchId: string, error?: string) {
    const queue = safeLoadQueue()
    const idx = queue.findIndex((item) => item.id === batchId)
    if (idx < 0) return

    const current = queue[idx]
    const nextAttempts = current.attempts + 1
    queue[idx] = {
      ...current,
      attempts: nextAttempts,
      updatedAt: nowMs(),
      nextRetryAt: nowMs() + calcBackoff(nextAttempts),
      lastError: error
    }
    safeSaveQueue(queue)
  },

  removeBatch(batchId: string) {
    const queue = safeLoadQueue().filter((item) => item.id !== batchId)
    safeSaveQueue(queue)
  },

  hasPending(meetingId: string): boolean {
    const queue = safeLoadQueue()
    return queue.some((item) => item.meetingId === meetingId)
  },

  countPending(meetingId: string): number {
    const queue = safeLoadQueue()
    return queue.filter((item) => item.meetingId === meetingId).length
  },

  clearMeeting(meetingId: string) {
    const queue = safeLoadQueue().filter((item) => item.meetingId !== meetingId)
    safeSaveQueue(queue)
  }
}
