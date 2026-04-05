export type TimingReportCategory = 'not_started' | 'undertime' | 'on_time' | 'overtime' | 'severe_overtime'

export type TimingReportDefinition = {
  qualifiedThresholdSec: number
  warningThresholdSec: number
  severeOvertimeSec: number
}

export function getTimingReportDefinition(plannedDurationSec: number): TimingReportDefinition {
  if (plannedDurationSec > 300) {
    return {
      // >5 分钟环节：达到 2 分钟进入绿牌，1 分钟进入黄牌
      qualifiedThresholdSec: 120,
      warningThresholdSec: 60,
      severeOvertimeSec: 30
    }
  }

  return {
    // <=5 分钟环节：达到 1 分钟进入绿牌，30 秒进入黄牌
    qualifiedThresholdSec: 60,
    warningThresholdSec: 30,
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

  const {qualifiedThresholdSec, severeOvertimeSec} = getTimingReportDefinition(plannedDurationSec)
  const remaining = plannedDurationSec - actualDurationSec

  // 未达到绿牌线，视为时间不足。
  if (remaining > qualifiedThresholdSec) return 'undertime'

  // 达到绿牌线且未超过红牌结束时间，视为准时。
  if (remaining >= 0) return 'on_time'

  // 红牌后到紫牌前，视为超时。
  if (remaining > -severeOvertimeSec) return 'overtime'

  // 到达紫牌阈值后，视为严重超时。
  if (remaining <= -severeOvertimeSec) return 'severe_overtime'

  return 'undertime'
}
