import type {MeetingItem} from '../types/meeting'

export const MIN_EFFECTIVE_STATS_DURATION_SECONDS = 20

export function shouldCountItemInMeetingStats(item: MeetingItem) {
  return (
    !item.disabled &&
    typeof item.actualDuration === 'number' &&
    item.actualDuration > MIN_EFFECTIVE_STATS_DURATION_SECONDS
  )
}
