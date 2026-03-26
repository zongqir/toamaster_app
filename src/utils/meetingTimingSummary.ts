import type {MeetingItem} from '../types/meeting'
import {classifyTimingReport} from './timingReport'

export interface MeetingTimingSpeakerItem {
  itemId: string
  title: string
  planned: number
  actual: number
  diff: number
}

export interface MeetingTimingSpeakerStats {
  speaker: string
  totalPlanned: number
  totalActual: number
  itemCount: number
  overtimeCount: number
  severeOvertimeCount: number
  ontimeCount: number
  undertimeCount: number
  items: MeetingTimingSpeakerItem[]
}

export interface MeetingTimingOvertimeItem {
  speaker: string
  title: string
  overtime: number
  severe: boolean
}

export interface MeetingTimingUndertimeItem {
  speaker: string
  title: string
  undertime: number
}

export interface MeetingTimingSummary {
  totalPlanned: number
  totalActual: number
  totalDiff: number
  pendingCount: number
  ontimeCount: number
  overtimeCount: number
  severeOvertimeCount: number
  undertimeCount: number
  overtimeItems: MeetingItem[]
  severeOvertimeItems: MeetingItem[]
  ontimeItems: MeetingItem[]
  undertimeItems: MeetingItem[]
  speakerStats: MeetingTimingSpeakerStats[]
  overtimeBySpeaker: Map<string, MeetingTimingOvertimeItem[]>
  undertimeBySpeaker: Map<string, MeetingTimingUndertimeItem[]>
}

export function summarizeMeetingTiming(items: MeetingItem[]): MeetingTimingSummary {
  const speakerStatsMap = new Map<string, MeetingTimingSpeakerStats>()
  const overtimeItems: MeetingItem[] = []
  const severeOvertimeItems: MeetingItem[] = []
  const ontimeItems: MeetingItem[] = []
  const undertimeItems: MeetingItem[] = []
  const overtimeBySpeaker = new Map<string, MeetingTimingOvertimeItem[]>()
  const undertimeBySpeaker = new Map<string, MeetingTimingUndertimeItem[]>()

  let totalPlanned = 0
  let totalActual = 0
  let pendingCount = 0
  let ontimeCount = 0
  let overtimeCount = 0
  let severeOvertimeCount = 0
  let undertimeCount = 0

  items.forEach((item) => {
    totalPlanned += item.plannedDuration

    if (item.actualDuration === undefined) {
      pendingCount += 1
      return
    }

    const speaker = item.speaker || '未指定'
    const actual = item.actualDuration
    const diff = actual - item.plannedDuration
    const category = classifyTimingReport(item.plannedDuration, actual)

    totalActual += actual

    let stats = speakerStatsMap.get(speaker)
    if (!stats) {
      stats = {
        speaker,
        totalPlanned: 0,
        totalActual: 0,
        itemCount: 0,
        overtimeCount: 0,
        severeOvertimeCount: 0,
        ontimeCount: 0,
        undertimeCount: 0,
        items: []
      }
      speakerStatsMap.set(speaker, stats)
    }

    stats.totalPlanned += item.plannedDuration
    stats.totalActual += actual
    stats.itemCount += 1
    stats.items.push({
      itemId: item.id,
      title: item.title,
      planned: item.plannedDuration,
      actual,
      diff
    })

    if (category === 'severe_overtime') {
      overtimeCount += 1
      severeOvertimeCount += 1
      stats.overtimeCount += 1
      stats.severeOvertimeCount += 1
      severeOvertimeItems.push(item)
      overtimeItems.push(item)
      if (!overtimeBySpeaker.has(speaker)) {
        overtimeBySpeaker.set(speaker, [])
      }
      overtimeBySpeaker.get(speaker)?.push({
        speaker,
        title: item.title,
        overtime: diff,
        severe: true
      })
      return
    }

    if (category === 'overtime') {
      overtimeCount += 1
      stats.overtimeCount += 1
      overtimeItems.push(item)
      if (!overtimeBySpeaker.has(speaker)) {
        overtimeBySpeaker.set(speaker, [])
      }
      overtimeBySpeaker.get(speaker)?.push({
        speaker,
        title: item.title,
        overtime: diff,
        severe: false
      })
      return
    }

    if (category === 'on_time') {
      ontimeCount += 1
      stats.ontimeCount += 1
      ontimeItems.push(item)
      return
    }

    if (category === 'undertime') {
      undertimeCount += 1
      stats.undertimeCount += 1
      undertimeItems.push(item)
      if (!undertimeBySpeaker.has(speaker)) {
        undertimeBySpeaker.set(speaker, [])
      }
      undertimeBySpeaker.get(speaker)?.push({
        speaker,
        title: item.title,
        undertime: Math.abs(diff)
      })
    }
  })

  return {
    totalPlanned,
    totalActual,
    totalDiff: totalActual - totalPlanned,
    pendingCount,
    ontimeCount,
    overtimeCount,
    severeOvertimeCount,
    undertimeCount,
    overtimeItems,
    severeOvertimeItems,
    ontimeItems,
    undertimeItems,
    speakerStats: Array.from(speakerStatsMap.values()),
    overtimeBySpeaker,
    undertimeBySpeaker
  }
}
