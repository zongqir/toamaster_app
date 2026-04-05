import Taro from '@tarojs/taro'
import {useCallback, useEffect, useRef, useState} from 'react'
import type {MeetingItem, TimerRule} from '../types/meeting'
import {getTimingReportDefinition} from '../utils/timingReport'

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

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastStatusRef = useRef<string>('white')
  const runStartRef = useRef<number>(0)
  const baseElapsedRef = useRef<number>(0)
  const hasInitializedIndexRef = useRef(false)
  const currentIndexRef = useRef(0)
  const elapsedRef = useRef(0)
  const isRunningRef = useRef(false)
  const updatedItemsRef = useRef<MeetingItem[]>([...items])

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

  // Sync external item list changes (add/remove/restore)
  useEffect(() => {
    const previousActiveItemId = updatedItemsRef.current[currentIndexRef.current]?.id
    const nextItems = [...items]
    updatedItemsRef.current = nextItems
    setUpdatedItems(nextItems)

    if (items.length === 0) {
      currentIndexRef.current = 0
      elapsedRef.current = 0
      isRunningRef.current = false
      setCurrentIndex(0)
      setElapsed(0)
      setIsRunning(false)
      baseElapsedRef.current = 0
      hasInitializedIndexRef.current = false
      return
    }

    if (isRunningRef.current && previousActiveItemId && !items.some((item) => item.id === previousActiveItemId)) {
      isRunningRef.current = false
      setIsRunning(false)
    }

    setCurrentIndex((prev) => {
      // First entry to timer page: resume unfinished/in-progress item.
      if (!hasInitializedIndexRef.current) {
        hasInitializedIndexRef.current = true
        const nextIndex = getResumeIndex(items)
        currentIndexRef.current = nextIndex
        return nextIndex
      }

      // Keep index valid when list length changes.
      const nextIndex = Math.min(prev, items.length - 1)
      currentIndexRef.current = nextIndex
      return nextIndex
    })
  }, [items, getResumeIndex])

  useEffect(() => {
    currentIndexRef.current = currentIndex
  }, [currentIndex])

  useEffect(() => {
    elapsedRef.current = elapsed
  }, [elapsed])

  useEffect(() => {
    isRunningRef.current = isRunning
  }, [isRunning])

  useEffect(() => {
    updatedItemsRef.current = updatedItems
  }, [updatedItems])

  const getLiveElapsed = useCallback(() => {
    const index = currentIndexRef.current
    const itemsSnapshot = updatedItemsRef.current
    if (!itemsSnapshot[index]) return elapsedRef.current
    if (!isRunningRef.current) return elapsedRef.current
    return baseElapsedRef.current + Math.floor((Date.now() - runStartRef.current) / 1000)
  }, [])

  // Restore elapsed time for current item.
  useEffect(() => {
    const item = updatedItems[currentIndex]
    if (!item) {
      isRunningRef.current = false
      setIsRunning(false)
      elapsedRef.current = 0
      setElapsed(0)
      baseElapsedRef.current = 0
      return
    }

    if (item.actualStartTime && !item.actualEndTime) {
      const elapsedTime = (item.actualDuration || 0) + Math.floor((Date.now() - item.actualStartTime) / 1000)
      isRunningRef.current = true
      setIsRunning(true)
      elapsedRef.current = elapsedTime
      setElapsed(elapsedTime)
      baseElapsedRef.current = elapsedTime
      runStartRef.current = Date.now()
    } else if (item.actualDuration !== undefined) {
      isRunningRef.current = false
      setIsRunning(false)
      elapsedRef.current = item.actualDuration
      setElapsed(item.actualDuration)
      baseElapsedRef.current = item.actualDuration
    } else {
      isRunningRef.current = false
      setIsRunning(false)
      elapsedRef.current = 0
      setElapsed(0)
      baseElapsedRef.current = 0
    }

    lastStatusRef.current = 'white'
  }, [currentIndex, updatedItems])

  const currentItem = updatedItems[currentIndex]
  const currentRule = rules[currentItem?.ruleId || 'short']
  const timingDefinition = getTimingReportDefinition(currentItem?.plannedDuration || 0)
  const greenThreshold = timingDefinition.qualifiedThresholdSec
  const remaining = (currentItem?.plannedDuration || 0) - elapsed

  const getStatus = useCallback(() => {
    if (!currentItem) return 'idle'
    if (remaining <= currentRule.timeoutThreshold) return 'purple'
    if (remaining <= currentRule.redThreshold) return 'red'
    if (remaining <= currentRule.yellowThreshold) return 'yellow'
    if (remaining <= greenThreshold) return 'green'
    return 'white'
  }, [currentItem, currentRule, greenThreshold, remaining])

  useEffect(() => {
    const status = getStatus()
    if (status !== lastStatusRef.current && status !== 'white' && status !== 'green' && status !== 'idle') {
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
    }

    lastStatusRef.current = status
  }, [getStatus, onStatusChange])

  const updateCurrentItem = useCallback(
    (item: MeetingItem) => {
      const index = currentIndexRef.current
      const itemsSnapshot = updatedItemsRef.current
      const running = isRunningRef.current
      const now = Date.now()
      const liveElapsed = item.actualDuration ?? getLiveElapsed()
      const hadTiming =
        itemsSnapshot[index]?.actualDuration !== undefined ||
        itemsSnapshot[index]?.actualStartTime !== undefined ||
        item.actualDuration !== undefined ||
        liveElapsed > 0 ||
        running
      const normalizedItem: MeetingItem = {
        ...item,
        actualDuration: hadTiming ? liveElapsed : undefined,
        actualStartTime: running ? now : undefined,
        actualEndTime: item.actualEndTime
      }

      const newItems = [...itemsSnapshot]
      newItems[index] = normalizedItem
      updatedItemsRef.current = newItems
      setUpdatedItems(newItems)

      elapsedRef.current = liveElapsed
      setElapsed(liveElapsed)
      baseElapsedRef.current = liveElapsed

      if (running) {
        runStartRef.current = now
      }

      return normalizedItem
    },
    [getLiveElapsed]
  )

  const start = useCallback(() => {
    const index = currentIndexRef.current
    const itemsSnapshot = updatedItemsRef.current
    if (isRunningRef.current || !itemsSnapshot[index]) return

    const now = Date.now()
    const baseElapsed = itemsSnapshot[index].actualDuration ?? elapsedRef.current
    const newItems = [...itemsSnapshot]
    newItems[index] = {
      ...newItems[index],
      actualDuration: baseElapsed,
      actualStartTime: now,
      actualEndTime: undefined
    }

    updatedItemsRef.current = newItems
    setUpdatedItems(newItems)
    elapsedRef.current = baseElapsed
    setElapsed(baseElapsed)
    baseElapsedRef.current = baseElapsed
    runStartRef.current = now
    isRunningRef.current = true
    setIsRunning(true)
    onSessionCheckpoint?.(newItems)
  }, [onSessionCheckpoint])

  const pause = useCallback(() => {
    const index = currentIndexRef.current
    const itemsSnapshot = updatedItemsRef.current
    if (!itemsSnapshot[index]) {
      isRunningRef.current = false
      setIsRunning(false)
      return
    }

    const now = Date.now()
    const liveElapsed = getLiveElapsed()
    const newItems = [...itemsSnapshot]
    newItems[index] = {
      ...newItems[index],
      actualDuration: liveElapsed,
      actualStartTime: undefined,
      actualEndTime: undefined
    }

    updatedItemsRef.current = newItems
    setUpdatedItems(newItems)
    elapsedRef.current = liveElapsed
    setElapsed(liveElapsed)
    baseElapsedRef.current = liveElapsed
    runStartRef.current = now
    isRunningRef.current = false
    setIsRunning(false)
    onSessionCheckpoint?.(newItems)
  }, [getLiveElapsed, onSessionCheckpoint])

  const reset = useCallback(() => {
    const index = currentIndexRef.current
    const itemsSnapshot = updatedItemsRef.current
    if (!itemsSnapshot[index]) {
      elapsedRef.current = 0
      isRunningRef.current = false
      setElapsed(0)
      setIsRunning(false)
      return
    }

    const newItems = [...itemsSnapshot]
    newItems[index] = {
      ...newItems[index],
      actualDuration: undefined,
      actualStartTime: undefined,
      actualEndTime: undefined
    }

    updatedItemsRef.current = newItems
    setUpdatedItems(newItems)
    elapsedRef.current = 0
    setElapsed(0)
    baseElapsedRef.current = 0
    runStartRef.current = 0
    isRunningRef.current = false
    setIsRunning(false)
    onSessionCheckpoint?.(newItems)
  }, [onSessionCheckpoint])

  const next = useCallback(() => {
    const index = currentIndexRef.current
    const itemsSnapshot = updatedItemsRef.current
    if (!itemsSnapshot[index]) return

    const liveElapsed = getLiveElapsed()
    const newItems = [...itemsSnapshot]
    newItems[index] = {
      ...newItems[index],
      actualDuration: liveElapsed,
      actualEndTime: Date.now()
    }

    updatedItemsRef.current = newItems
    setUpdatedItems(newItems)
    elapsedRef.current = liveElapsed
    setElapsed(liveElapsed)
    baseElapsedRef.current = liveElapsed
    isRunningRef.current = false
    setIsRunning(false)
    onSessionCheckpoint?.(newItems)

    if (index < itemsSnapshot.length - 1) {
      currentIndexRef.current = index + 1
      setCurrentIndex(index + 1)
    } else {
      onSessionComplete(newItems)
    }
  }, [getLiveElapsed, onSessionComplete, onSessionCheckpoint])

  const prev = useCallback(() => {
    const index = currentIndexRef.current
    const itemsSnapshot = updatedItemsRef.current
    if (index <= 0) return

    if (itemsSnapshot[index]) {
      const liveElapsed = getLiveElapsed()
      const newItems = [...itemsSnapshot]
      newItems[index] = {
        ...newItems[index],
        actualDuration: liveElapsed,
        actualEndTime: Date.now()
      }

      updatedItemsRef.current = newItems
      setUpdatedItems(newItems)
      elapsedRef.current = liveElapsed
      setElapsed(liveElapsed)
      baseElapsedRef.current = liveElapsed
      isRunningRef.current = false
      setIsRunning(false)
      onSessionCheckpoint?.(newItems)
    }

    currentIndexRef.current = index - 1
    setCurrentIndex(index - 1)
  }, [getLiveElapsed, onSessionCheckpoint])

  const adjustTime = useCallback(
    (seconds: number) => {
      const index = currentIndexRef.current
      const itemsSnapshot = updatedItemsRef.current
      const running = isRunningRef.current
      if (!itemsSnapshot[index]) return

      const now = Date.now()
      const nextElapsed = Math.max(0, getLiveElapsed() + seconds)
      const newItems = [...itemsSnapshot]
      newItems[index] = {
        ...newItems[index],
        actualDuration: nextElapsed,
        actualStartTime: running ? now : undefined,
        actualEndTime: undefined
      }

      updatedItemsRef.current = newItems
      setUpdatedItems(newItems)
      elapsedRef.current = nextElapsed
      setElapsed(nextElapsed)
      baseElapsedRef.current = nextElapsed

      if (running) {
        runStartRef.current = now
      }

      onSessionCheckpoint?.(newItems)
    },
    [getLiveElapsed, onSessionCheckpoint]
  )

  const flushCheckpoint = useCallback(
    (options?: {skipCheckpoint?: boolean}) => {
      const index = currentIndexRef.current
      const itemsSnapshot = updatedItemsRef.current
      const running = isRunningRef.current
      if (!itemsSnapshot[index]) return null

      const now = Date.now()
      const liveElapsed = getLiveElapsed()
      const currentItem = itemsSnapshot[index]
      const hadTiming =
        currentItem.actualDuration !== undefined ||
        currentItem.actualStartTime !== undefined ||
        currentItem.actualEndTime !== undefined ||
        liveElapsed > 0 ||
        running
      const newItems = [...itemsSnapshot]
      newItems[index] = {
        ...newItems[index],
        actualDuration: hadTiming ? liveElapsed : undefined,
        actualStartTime: running ? now : undefined,
        actualEndTime: undefined
      }

      updatedItemsRef.current = newItems
      setUpdatedItems(newItems)
      elapsedRef.current = liveElapsed
      setElapsed(liveElapsed)
      baseElapsedRef.current = liveElapsed

      if (running) {
        runStartRef.current = now
      }

      if (!options?.skipCheckpoint) {
        onSessionCheckpoint?.(newItems)
      }

      return newItems
    },
    [getLiveElapsed, onSessionCheckpoint]
  )

  const jumpTo = useCallback(
    (index: number) => {
      const current = currentIndexRef.current
      const itemsSnapshot = updatedItemsRef.current
      if (index < 0 || index >= items.length) return

      if (current < items.length && itemsSnapshot[current]) {
        const liveElapsed = getLiveElapsed()
        const newItems = [...itemsSnapshot]
        newItems[current] = {
          ...newItems[current],
          actualDuration: liveElapsed,
          actualEndTime: Date.now()
        }

        updatedItemsRef.current = newItems
        setUpdatedItems(newItems)
        elapsedRef.current = liveElapsed
        setElapsed(liveElapsed)
        baseElapsedRef.current = liveElapsed
        onSessionCheckpoint?.(newItems)
      }

      isRunningRef.current = false
      setIsRunning(false)
      currentIndexRef.current = index
      setCurrentIndex(index)
    },
    [getLiveElapsed, items.length, onSessionCheckpoint]
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
    flushCheckpoint,
    reset,
    totalItems: items.length,
    updateCurrentItem,
    jumpTo
  }
}
