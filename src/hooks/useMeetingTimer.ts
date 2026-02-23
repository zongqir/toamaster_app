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

    const firstPendingIndex = meetingItems.findIndex(
      (item) => item.actualDuration === undefined && item.actualEndTime === undefined
    )
    if (firstPendingIndex >= 0) return firstPendingIndex

    return meetingItems.length - 1
  }, [])

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

    setCurrentIndex((prev) => {
      // First entry to timer page: resume unfinished/in-progress item.
      if (!hasInitializedIndexRef.current) {
        hasInitializedIndexRef.current = true
        return getResumeIndex(items)
      }

      // Keep index valid when list length changes.
      return Math.min(prev, items.length - 1)
    })
  }, [items, getResumeIndex])

  // Restore elapsed time for current item.
  useEffect(() => {
    const item = updatedItems[currentIndex]
    if (!item) {
      setElapsed(0)
      baseElapsedRef.current = 0
      return
    }

    if (item.actualDuration !== undefined) {
      setElapsed(item.actualDuration)
      baseElapsedRef.current = item.actualDuration
    } else if (item.actualStartTime && !item.actualEndTime) {
      const elapsedTime = Math.floor((Date.now() - item.actualStartTime) / 1000)
      setElapsed(elapsedTime)
      baseElapsedRef.current = elapsedTime
    } else {
      setElapsed(0)
      baseElapsedRef.current = 0
    }

    lastStatusRef.current = 'green'
  }, [currentIndex, updatedItems])

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
      const newItems = [...updatedItems]
      newItems[currentIndex] = item
      setUpdatedItems(newItems)
      setElapsed(0)
    },
    [currentIndex, updatedItems]
  )

  const start = useCallback(() => {
    if (isRunning || !updatedItems[currentIndex]) return

    baseElapsedRef.current = elapsed
    runStartRef.current = Date.now()
    setIsRunning(true)

    if (!updatedItems[currentIndex].actualStartTime) {
      const newItems = [...updatedItems]
      newItems[currentIndex].actualStartTime = Date.now()
      setUpdatedItems(newItems)
      onSessionCheckpoint?.(newItems)
    }
  }, [isRunning, currentIndex, updatedItems, elapsed, onSessionCheckpoint])

  const pause = useCallback(() => {
    setIsRunning(false)
  }, [])

  const reset = useCallback(() => {
    setElapsed(0)
    setIsRunning(false)
  }, [])

  const next = useCallback(() => {
    if (!updatedItems[currentIndex]) return

    if (isRunning) {
      setIsRunning(false)
    }

    const newItems = [...updatedItems]
    newItems[currentIndex].actualEndTime = Date.now()
    newItems[currentIndex].actualDuration = elapsed
    setUpdatedItems(newItems)
    onSessionCheckpoint?.(newItems)

    if (currentIndex < updatedItems.length - 1) {
      setCurrentIndex(currentIndex + 1)
    } else {
      onSessionComplete(newItems)
    }
  }, [currentIndex, updatedItems, elapsed, onSessionComplete, isRunning, onSessionCheckpoint])

  const prev = useCallback(() => {
    if (currentIndex <= 0) return

    if (isRunning && updatedItems[currentIndex]) {
      setIsRunning(false)
      const newItems = [...updatedItems]
      newItems[currentIndex].actualEndTime = Date.now()
      newItems[currentIndex].actualDuration = elapsed
      setUpdatedItems(newItems)
      onSessionCheckpoint?.(newItems)
    }

    setCurrentIndex(currentIndex - 1)
  }, [currentIndex, isRunning, updatedItems, elapsed, onSessionCheckpoint])

  const adjustTime = useCallback((seconds: number) => {
    setElapsed((prev) => Math.max(0, prev + seconds))
  }, [])

  const jumpTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= items.length) return

      if (isRunning) {
        setIsRunning(false)
      }

      if (currentIndex < items.length && updatedItems[currentIndex]) {
        const newItems = [...updatedItems]
        newItems[currentIndex].actualEndTime = Date.now()
        newItems[currentIndex].actualDuration = elapsed
        setUpdatedItems(newItems)
        onSessionCheckpoint?.(newItems)
      }

      setCurrentIndex(index)
    },
    [currentIndex, updatedItems, elapsed, items.length, isRunning, onSessionCheckpoint]
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
