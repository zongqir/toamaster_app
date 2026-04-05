import {supabase} from '../client/supabase'

type RealtimeChannelLike = {
  _joinRef?: () => string
  topic?: string
}

type RealtimeClientLike = {
  _remove?: (channel: RealtimeChannelLike) => void
  connectionState?: () => string
  getChannels?: () => RealtimeChannelLike[]
}

function isSameChannel(left: RealtimeChannelLike, right: RealtimeChannelLike) {
  if (left === right) return true

  const leftJoinRef = left?._joinRef?.()
  const rightJoinRef = right?._joinRef?.()
  if (leftJoinRef && rightJoinRef) {
    return leftJoinRef === rightJoinRef
  }

  return Boolean(left?.topic && right?.topic && left.topic === right.topic)
}

export async function safeRemoveRealtimeChannel(channel: RealtimeChannelLike | null | undefined) {
  if (!channel) return

  const realtime = (supabase as unknown as {realtime?: RealtimeClientLike}).realtime
  const channels = realtime?.getChannels?.() || []
  const exists = channels.some((currentChannel) => isSameChannel(currentChannel, channel))

  if (!exists) return

  if (realtime?.connectionState?.() !== 'open') {
    realtime?._remove?.(channel)
    return
  }

  try {
    await supabase.removeChannel(channel as never)
  } catch (error) {
    console.warn('[realtime] safeRemoveRealtimeChannel fallback', {
      topic: channel.topic,
      error
    })
    realtime?._remove?.(channel)
  }
}
