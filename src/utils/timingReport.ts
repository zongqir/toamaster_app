export type TimingReportCategory = 'not_started' | 'undertime' | 'on_time' | 'overtime' | 'severe_overtime'

export type TimingReportDefinition = {
  onTimeEarlyToleranceSec: number
  severeOvertimeSec: number
}

export function getTimingReportDefinition(plannedDurationSec: number): TimingReportDefinition {
  if (plannedDurationSec > 300) {
    return {
      // >5 分钟环节：提前 60 秒以内仍算“准时”
      onTimeEarlyToleranceSec: 60,
      severeOvertimeSec: 30
    }
  }

  return {
    // <=5 分钟环节：提前 30 秒以内仍算“准时”
    onTimeEarlyToleranceSec: 30,
    severeOvertimeSec: 30
  }
}

export function classifyTimingReport(
  plannedDurationSec: number,
  actualDurationSec?: number | null
): TimingReportCategory {
  if (actualDurationSec === undefined || actualDurationSec === null) {
    return 'not_started'
  }

  const {onTimeEarlyToleranceSec, severeOvertimeSec} = getTimingReportDefinition(plannedDurationSec)
  const diff = actualDurationSec - plannedDurationSec

  if (diff > severeOvertimeSec) return 'severe_overtime'
  if (diff > 0) return 'overtime'
  if (diff >= -onTimeEarlyToleranceSec) return 'on_time'
  return 'undertime'
}
