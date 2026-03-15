import Taro from '@tarojs/taro'
import {useCallback, useEffect, useRef, useState} from 'react'
import type {MeetingItem, TimerRule} from '../types/meeting'

export function useMeetingTimer(
  items: MeetingItem[],
  rules: Record<string, TimerRule>,
  onSessionComplete: (updatedItems: MeetingItem[]) => void,
  onStatusChange?: () => void,
  onSessionCheckpoint?: (updatedItems: MeetingItem[]) => void
) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [isRunning, setIsRunning] = useState(false)
  const [updatedItems, setUpdatedItems] = useState<MeetingItem[]>([...items])

  const timerRef = useRef<any>(null)
  const lastStatusRef = useRef<string>('green')
  const runStartRef = useRef<number>(0)
  const baseElapsedRef = useRef<number>(0)
  const hasInitializedIndexRef = useRef(false)

  const getResumeIndex = useCallback((meetingItems: MeetingItem[]) => {
    if (meetingItems.length === 0) return 0

    const inProgressIndex = meetingItems.findIndex((item) => item.actualStartTime && !item.actualEndTime)
    if (inProgressIndex >= 0) return inProgressIndex

    const pausedIndex = meetingItems.findIndex((item) => item.actualDuration !== undefined && !item.actualEndTime)
    if (pausedIndex >= 0) return pausedIndex

    const firstPendingIndex = meetingItems.findIndex(
      (item) => item.actualDuration === undefined && item.actualEndTime === undefined
    )
    if (firstPendingIndex >= 0) return firstPendingIndex

    return meetingItems.length - 1
  }, [])

  const activeItemId = updatedItems[currentIndex]?.id

  // Sync external item list changes (add/remove/restore)
  useEffect(() => {
    setUpdatedItems([...items])

    if (items.length === 0) {
      setCurrentIndex(0)
      setElapsed(0)
      baseElapsedRef.current = 0
      hasInitializedIndexRef.current = false
      return
    }

    if (isRunning && activeItemId && !items.some((item) => item.id === activeItemId)) {
      setIsRunning(false)
    }

    setCurrentIndex((prev) => {
      // First entry to timer page: resume unfinished/in-progress item.
      if (!hasInitializedIndexRef.current) {
        hasInitializedIndexRef.current = true
        return getResumeIndex(items)
      }

      // Keep index valid when list length changes.
      return Math.min(prev, items.length - 1)
    })
  }, [items, getResumeIndex, activeItemId, isRunning])

  const getLiveElapsed = useCallback(() => {
    if (!updatedItems[currentIndex]) return elapsed
    if (!isRunning) return elapsed
    return baseElapsedRef.current + Math.floor((Date.now() - runStartRef.current) / 1000)
  }, [currentIndex, elapsed, isRunning, updatedItems])

  // Restore elapsed time for current item.
  useEffect(() => {
    const item = updatedItems[currentIndex]
    if (!item) {
      setElapsed(0)
      baseElapsedRef.current = 0
      return
    }

    if (item.actualStartTime && !item.actualEndTime) {
      const elapsedTime = (item.actualDuration || 0) + Math.floor((Date.now() - item.actualStartTime) / 1000)
      setElapsed(elapsedTime)
      baseElapsedRef.current = elapsedTime
      if (isRunning) {
        runStartRef.current = Date.now()
      }
    } else if (item.actualDuration !== undefined) {
      setElapsed(item.actualDuration)
      baseElapsedRef.current = item.actualDuration
    } else {
      setElapsed(0)
      baseElapsedRef.current = 0
    }

    lastStatusRef.current = 'green'
  }, [currentIndex, updatedItems, isRunning])

  const currentItem = updatedItems[currentIndex]
  const currentRule = rules[currentItem?.ruleId || 'short']
  const remaining = (currentItem?.plannedDuration || 0) - elapsed

  const getStatus = useCallback(() => {
    if (!currentItem) return 'idle'
    if (remaining <= currentRule.timeoutThreshold) return 'timeout'
    if (remaining <= currentRule.redThreshold) return 'red'
    if (remaining <= currentRule.yellowThreshold) return 'yellow'
    return 'green'
  }, [currentItem, remaining, currentRule])

  useEffect(() => {
    const status = getStatus()
    if (status !== lastStatusRef.current && status !== 'green' && status !== 'idle') {
      Taro.vibrateLong({
        success: () => {
          console.log('vibrate long success')
        },
        fail: (err) => {
          console.warn('vibrate long failed, fallback to short:', err)
          Taro.vibrateShort({
            fail: (err2) => {
              console.warn('vibrate short also failed:', err2)
            }
          })
        }
      })

      onStatusChange?.()
      lastStatusRef.current = status
    }

    if (status === 'green' || status === 'idle') {
      lastStatusRef.current = status
    }
  }, [getStatus, onStatusChange])

  const updateCurrentItem = useCallback(
    (item: MeetingItem) => {
      const now = Date.now()
      const liveElapsed = item.actualDuration ?? getLiveElapsed()
      const hadTiming =
        updatedItems[currentIndex]?.actualDuration !== undefined ||
        updatedItems[currentIndex]?.actualStartTime !== undefined ||
        item.actualDuration !== undefined ||
        liveElapsed > 0 ||
        isRunning
      const normalizedItem: MeetingItem = {
        ...item,
        actualDuration: hadTiming ? liveElapsed : undefined,
        actualStartTime: isRunning ? now : undefined,
        actualEndTime: item.actualEndTime
      }

      const newItems = [...updatedItems]
      newItems[currentIndex] = normalizedItem
      setUpdatedItems(newItems)

      setElapsed(liveElapsed)
      baseElapsedRef.current = liveElapsed

      if (isRunning) {
        runStartRef.current = now
      }

      return normalizedItem
    },
    [currentIndex, getLiveElapsed, isRunning, updatedItems]
  )

  const start = useCallback(() => {
    if (isRunning || !updatedItems[currentIndex]) return

    const now = Date.now()
    const baseElapsed = updatedItems[currentIndex].actualDuration ?? elapsed
    const newItems = [...updatedItems]
    newItems[currentIndex] = {
      ...newItems[currentIndex],
      actualDuration: baseElapsed,
      actualStartTime: now,
      actualEndTime: undefined
    }

    setUpdatedItems(newItems)
    setElapsed(baseElapsed)
    baseElapsedRef.current = baseElapsed
    runStartRef.current = now
    setIsRunning(true)
    onSessionCheckpoint?.(newItems)
  }, [isRunning, currentIndex, updatedItems, elapsed, onSessionCheckpoint])

  const pause = useCallback(() => {
    if (!updatedItems[currentIndex]) {
      setIsRunning(false)
      return
    }

    const now = Date.now()
    const liveElapsed = getLiveElapsed()
    const newItems = [...updatedItems]
    newItems[currentIndex] = {
      ...newItems[currentIndex],
      actualDuration: liveElapsed,
      actualStartTime: undefined,
      actualEndTime: undefined
    }

    setUpdatedItems(newItems)
    setElapsed(liveElapsed)
    baseElapsedRef.current = liveElapsed
    runStartRef.current = now
    setIsRunning(false)
    onSessionCheckpoint?.(newItems)
  }, [currentIndex, getLiveElapsed, onSessionCheckpoint, updatedItems])

  const reset = useCallback(() => {
    if (!updatedItems[currentIndex]) {
      setElapsed(0)
      setIsRunning(false)
      return
    }

    const newItems = [...updatedItems]
    newItems[currentIndex] = {
      ...newItems[currentIndex],
      actualDuration: undefined,
      actualStartTime: undefined,
      actualEndTime: undefined
    }

    setUpdatedItems(newItems)
    setElapsed(0)
    baseElapsedRef.current = 0
    runStartRef.current = 0
    setIsRunning(false)
    onSessionCheckpoint?.(newItems)
  }, [currentIndex, onSessionCheckpoint, updatedItems])

  const next = useCallback(() => {
    if (!updatedItems[currentIndex]) return

    const liveElapsed = getLiveElapsed()
    const newItems = [...updatedItems]
    newItems[currentIndex] = {
      ...newItems[currentIndex],
      actualDuration: liveElapsed,
      actualEndTime: Date.now()
    }

    setUpdatedItems(newItems)
    setElapsed(liveElapsed)
    baseElapsedRef.current = liveElapsed
    setIsRunning(false)
    onSessionCheckpoint?.(newItems)

    if (currentIndex < updatedItems.length - 1) {
      setCurrentIndex(currentIndex + 1)
    } else {
      onSessionComplete(newItems)
    }
  }, [currentIndex, getLiveElapsed, updatedItems, onSessionComplete, onSessionCheckpoint])

  const prev = useCallback(() => {
    if (currentIndex <= 0) return

    if (updatedItems[currentIndex]) {
      const liveElapsed = getLiveElapsed()
      const newItems = [...updatedItems]
      newItems[currentIndex] = {
        ...newItems[currentIndex],
        actualDuration: liveElapsed,
        actualEndTime: Date.now()
      }

      setUpdatedItems(newItems)
      setElapsed(liveElapsed)
      baseElapsedRef.current = liveElapsed
      setIsRunning(false)
      onSessionCheckpoint?.(newItems)
    }

    setCurrentIndex(currentIndex - 1)
  }, [currentIndex, getLiveElapsed, updatedItems, onSessionCheckpoint])

  const adjustTime = useCallback(
    (seconds: number) => {
      if (!updatedItems[currentIndex]) return

      const now = Date.now()
      const nextElapsed = Math.max(0, getLiveElapsed() + seconds)
      const newItems = [...updatedItems]
      newItems[currentIndex] = {
        ...newItems[currentIndex],
        actualDuration: nextElapsed,
        actualStartTime: isRunning ? now : undefined,
        actualEndTime: undefined
      }

      setUpdatedItems(newItems)
      setElapsed(nextElapsed)
      baseElapsedRef.current = nextElapsed

      if (isRunning) {
        runStartRef.current = now
      }

      onSessionCheckpoint?.(newItems)
    },
    [currentIndex, getLiveElapsed, isRunning, onSessionCheckpoint, updatedItems]
  )

  const jumpTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= items.length) return

      if (currentIndex < items.length && updatedItems[currentIndex]) {
        const liveElapsed = getLiveElapsed()
        const newItems = [...updatedItems]
        newItems[currentIndex] = {
          ...newItems[currentIndex],
          actualDuration: liveElapsed,
          actualEndTime: Date.now()
        }

        setUpdatedItems(newItems)
        setElapsed(liveElapsed)
        baseElapsedRef.current = liveElapsed
        onSessionCheckpoint?.(newItems)
      }

      setIsRunning(false)
      setCurrentIndex(index)
    },
    [currentIndex, getLiveElapsed, updatedItems, items.length, onSessionCheckpoint]
  )

  useEffect(() => {
    if (isRunning) {
      timerRef.current = setInterval(() => {
        const now = Date.now()
        const actualElapsed = baseElapsedRef.current + Math.floor((now - runStartRef.current) / 1000)
        setElapsed(actualElapsed)
      }, 500)
    } else if (timerRef.current) {
      clearInterval(timerRef.current)
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [isRunning])

  return {
    currentIndex,
    currentItem,
    nextItem: updatedItems[currentIndex + 1],
    elapsed,
    remaining,
    isRunning,
    status: getStatus(),
    start,
    pause,
    next,
    prev,
    adjustTime,
    reset,
    totalItems: items.length,
    updateCurrentItem,
    jumpTo
  }
}
