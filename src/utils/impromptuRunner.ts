import type {ImpromptuSpeechRecord, MeetingItem} from '../types/meeting'

export type ImpromptuRunnerStatus = 'idle' | 'hosting' | 'pending_speaker' | 'speaking' | 'completed'

export function sortImpromptuRecords(records: ImpromptuSpeechRecord[]) {
  return [...records].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return a.createdAt - b.createdAt
  })
}

export function getImpromptuRecordsForAgendaItem(records: ImpromptuSpeechRecord[] | undefined, agendaItemId: string) {
  return sortImpromptuRecords(
    (records || []).filter((record) => record.agendaItemId === agendaItemId && !record.deletedAt)
  )
}

export function getPendingImpromptuRecord(records: ImpromptuSpeechRecord[]) {
  return records.find((record) => record.status === 'pending') || null
}

export function getSpeakingImpromptuRecord(records: ImpromptuSpeechRecord[]) {
  return records.find((record) => record.status === 'speaking') || null
}

export function getCompletedImpromptuRecords(records: ImpromptuSpeechRecord[]) {
  return records.filter((record) => record.status === 'completed')
}

export function getImpromptuSpeechElapsedSeconds(record: ImpromptuSpeechRecord | null, now = Date.now()) {
  if (!record) return 0
  const baseDuration = record.speechDurationSeconds || 0
  if (record.status === 'speaking' && record.speechStartedAt) {
    return Math.max(0, baseDuration + Math.floor((now - record.speechStartedAt) / 1000))
  }
  return baseDuration
}

export function hasImpromptuPoolStarted(item: MeetingItem | null | undefined) {
  if (!item || item.actualEndTime) return false
  if (item.actualStartTime) return true
  return Number(item.actualDuration || 0) > 0
}

export function getImpromptuRunnerStatus(item: MeetingItem | null | undefined, records: ImpromptuSpeechRecord[]) {
  if (!item) return 'idle' as const
  if (item.actualEndTime) return 'completed' as const
  if (getSpeakingImpromptuRecord(records)) return 'speaking' as const
  if (getPendingImpromptuRecord(records)) return 'pending_speaker' as const

  return hasImpromptuPoolStarted(item) ? ('hosting' as const) : ('idle' as const)
}
