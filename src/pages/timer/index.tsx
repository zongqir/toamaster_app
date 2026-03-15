import {Button, Input, Picker, ScrollView, Text, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {useCallback, useMemo, useRef, useState} from 'react'
import {DatabaseService} from '../../db/database'
import {useMeetingTimer} from '../../hooks/useMeetingTimer'
import {StorageService} from '../../services/storage'
import {useMeetingStore} from '../../store/meetingStore'
import type {MeetingItem, MeetingSession} from '../../types/meeting'
import {generateId} from '../../utils/id'
import {safeSwitchTab} from '../../utils/safeNavigation'

export default function TimerPage() {
  const {currentSession, settings, setCurrentSession} = useMeetingStore()
  const [_isCompleted, setIsCompleted] = useState(false)
  const [showRemainingItems, setShowRemainingItems] = useState(false)
  const [showOperationTips, setShowOperationTips] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editSpeaker, setEditSpeaker] = useState('')
  const [editDuration, setEditDuration] = useState('')
  const [editActualDuration, setEditActualDuration] = useState('')

  // 时间快速编辑相关状态
  const [showTimeEditDialog, setShowTimeEditDialog] = useState(false)
  const [selectedMinutes, setSelectedMinutes] = useState(0)
  const [selectedSeconds, setSelectedSeconds] = useState(0)
  const lastTapTimeRef = useRef(0)

  const activeItems = useMemo(() => {
    return currentSession?.items.filter((i) => !i.disabled) || []
  }, [currentSession])

  const mergeTimedItems = useCallback(
    (timedItems: MeetingItem[]): MeetingSession | null => {
      if (!currentSession) return null

      const mergedItems = currentSession.items.map((item) => {
        const updated = timedItems.find((timedItem) => timedItem.id === item.id)
        return updated || item
      })

      return {
        ...currentSession,
        items: mergedItems
      }
    },
    [currentSession]
  )

  const handleTimerCheckpoint = useCallback(
    (checkpointItems: MeetingItem[]) => {
      const checkpointSession = mergeTimedItems(checkpointItems)
      if (!checkpointSession) return

      setCurrentSession(checkpointSession)
      StorageService.saveSession(checkpointSession)
    },
    [mergeTimedItems, setCurrentSession]
  )

  const handleComplete = async (finalItems: MeetingItem[]) => {
    if (!currentSession) return

    // 合并回原始列表（包括 disabled 的）
    const allItems = currentSession.items.map((item) => {
      const updated = finalItems.find((f) => f.id === item.id)
      return updated || item
    })

    const updatedSession = {
      ...currentSession,
      items: allItems,
      isCompleted: true
    }

    setCurrentSession(updatedSession)
    StorageService.saveSession(updatedSession)
    setIsCompleted(true)

    Taro.showLoading({title: '正在保存...'})
    const syncResult = await StorageService.waitForCloudSync(updatedSession.id)
    Taro.hideLoading()

    if (!syncResult.success) {
      Taro.showModal({
        title: '云端保存失败',
        content: `会议已保存到本地。云端同步失败：${syncResult.error || '未知错误'}。请重试网络后重新完成会议。`,
        showCancel: false
      })
      return
    }

    Taro.showModal({
      title: '会议结束',
      content: '所有环节已完成，记录已保存。',
      showCancel: false,
      success: () => {
        void safeSwitchTab('/pages/history/index')
      }
    })
  }

  // 播放提示音（三声滴滴滴）
  const playBeepSound = () => {
    const beep = () => {
      Taro.vibrateShort({type: 'heavy'})
    }
    beep()
    setTimeout(beep, 200)
    setTimeout(beep, 400)
  }

  const {
    currentIndex,
    currentItem,
    nextItem,
    elapsed,
    remaining,
    isRunning,
    status,
    start,
    pause,
    next,
    prev,
    adjustTime,
    totalItems,
    updateCurrentItem,
    reset,
    jumpTo
  } = useMeetingTimer(activeItems, settings.rules, handleComplete, playBeepSound, handleTimerCheckpoint)

  // 打开编辑对话框
  const handleOpenEdit = () => {
    if (!currentItem) return
    setEditTitle(currentItem.title)
    setEditSpeaker(currentItem.speaker || '')
    setEditDuration(Math.floor(currentItem.plannedDuration / 60).toString())
    // 设置实际耗时（如果有的话）
    const actualMinutes = currentItem.actualDuration
      ? Math.floor(currentItem.actualDuration / 60)
      : Math.floor(elapsed / 60)
    const actualSeconds = currentItem.actualDuration ? currentItem.actualDuration % 60 : elapsed % 60
    setEditActualDuration(`${actualMinutes}:${actualSeconds.toString().padStart(2, '0')}`)
    setShowEditDialog(true)
  }

  // 保存编辑
  const handleSaveEdit = () => {
    if (!currentItem || !currentSession) return

    const duration = Number.parseInt(editDuration, 10) || 1

    // 解析实际耗时（格式：分钟:秒）
    let actualDurationInSeconds: number | undefined
    if (editActualDuration.trim()) {
      const parts = editActualDuration.split(':')
      if (parts.length === 2) {
        const minutes = Number.parseInt(parts[0], 10) || 0
        const seconds = Number.parseInt(parts[1], 10) || 0
        actualDurationInSeconds = minutes * 60 + seconds
      } else {
        // 如果只输入了数字，当作秒数
        actualDurationInSeconds = Number.parseInt(editActualDuration, 10) || undefined
      }
    }

    const updatedItem: MeetingItem = {
      ...currentItem,
      title: editTitle,
      speaker: editSpeaker,
      plannedDuration: duration * 60,
      actualDuration: actualDurationInSeconds
    }
    const normalizedItem = updateCurrentItem(updatedItem)

    // 更新 session
    const updatedItems = currentSession.items.map((item) => (item.id === normalizedItem.id ? normalizedItem : item))
    const updatedSession = {...currentSession, items: updatedItems}
    setCurrentSession(updatedSession)
    StorageService.saveSession(updatedSession)

    setShowEditDialog(false)
    Taro.showToast({title: '已更新', icon: 'success'})
  }

  // 新增环节
  const handleAddItem = () => {
    if (!currentSession) return
    const duration = Number.parseInt(editDuration, 10) || 1
    const newItem: MeetingItem = {
      id: generateId('item'),
      title: editTitle || '新环节',
      speaker: editSpeaker,
      plannedDuration: duration * 60,
      type: 'other',
      ruleId: 'short'
    }

    // 插入到当前环节之后
    const allItems = [...currentSession.items]
    const currentItemIndex = allItems.findIndex((item) => item.id === currentItem?.id)
    if (currentItemIndex !== -1) {
      allItems.splice(currentItemIndex + 1, 0, newItem)
    } else {
      allItems.push(newItem)
    }

    const updatedSession = {...currentSession, items: allItems}
    setCurrentSession(updatedSession)
    StorageService.saveSession(updatedSession)

    setShowAddDialog(false)
    setEditTitle('')
    setEditSpeaker('')
    setEditDuration('')
    Taro.showToast({title: '已添加环节', icon: 'success'})
  }

  // 打开新增对话框
  const handleOpenAdd = () => {
    setEditTitle('')
    setEditSpeaker('')
    setEditDuration('2')
    setShowAddDialog(true)
  }

  // 删除当前环节
  const handleDeleteCurrent = () => {
    if (!currentItem || !currentSession) return

    if (activeItems.length <= 1) {
      Taro.showToast({title: '至少保留一个环节', icon: 'none'})
      return
    }

    if (currentIndex === activeItems.length - 1) {
      Taro.showToast({title: '最后一个环节不允许删除', icon: 'none'})
      return
    }

    Taro.showModal({
      title: '删除环节',
      content: `确定要删除"${currentItem.title}"吗？`,
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: (res) => {
        if (res.confirm) {
          // 从 session 中删除当前环节
          const updatedItems = currentSession.items.filter((item) => item.id !== currentItem.id)
          if (updatedItems.length === 0) {
            Taro.showToast({title: '至少保留一个环节', icon: 'none'})
            return
          }
          const updatedSession = {...currentSession, items: updatedItems}
          setCurrentSession(updatedSession)
          StorageService.saveSession(updatedSession)
          Taro.showToast({title: '已删除', icon: 'success'})
        }
      }
    })
  }

  // 长按重置计时
  const handleLongPressReset = () => {
    if (isRunning) {
      Taro.showModal({
        title: '重置计时',
        content: '确定要重置当前环节的计时吗？',
        confirmText: '重置',
        confirmColor: '#f59e0b',
        success: (res) => {
          if (res.confirm) {
            reset()
            Taro.showToast({title: '已重置', icon: 'success'})
          }
        }
      })
    }
  }

  const openTimeEditDialog = useCallback(() => {
    if (!currentItem) return

    const minutes = Math.floor(currentItem.plannedDuration / 60)
    const seconds = currentItem.plannedDuration % 60
    setSelectedMinutes(minutes)
    setSelectedSeconds(seconds)
    setShowTimeEditDialog(true)
  }, [currentItem])

  // 双击时间圆盘打开快速编辑
  const handleDoubleTapTimer = useCallback(() => {
    const now = Date.now()
    const timeSinceLastTap = now - lastTapTimeRef.current

    if (timeSinceLastTap < 300) {
      openTimeEditDialog()
    }

    lastTapTimeRef.current = now
  }, [openTimeEditDialog])

  // 保存快速编辑的时间
  const handleSaveTimeEdit = useCallback(async () => {
    if (!currentItem || !currentSession) return

    const newDuration = selectedMinutes * 60 + selectedSeconds

    if (newDuration <= 0) {
      Taro.showToast({title: '时间必须大于0', icon: 'none'})
      return
    }

    // 更新当前环节
    const updatedItem: MeetingItem = {
      ...currentItem,
      plannedDuration: newDuration
    }

    const normalizedItem = updateCurrentItem(updatedItem)

    // 更新session
    const updatedItems = currentSession.items.map((item) => (item.id === normalizedItem.id ? normalizedItem : item))
    const updatedSession = {...currentSession, items: updatedItems}
    setCurrentSession(updatedSession)

    // 保存到localStorage
    StorageService.saveSession(updatedSession)

    // 保存到数据库
    await DatabaseService.saveMeeting(updatedSession)

    setShowTimeEditDialog(false)
    Taro.showToast({title: '时间已更新', icon: 'success'})
  }, [currentItem, currentSession, selectedMinutes, selectedSeconds, updateCurrentItem, setCurrentSession])

  // 生成分钟和秒的选择器数据
  const minutesRange = useMemo(() => Array.from({length: 60}, (_, i) => i.toString()), [])
  const secondsRange = useMemo(() => Array.from({length: 60}, (_, i) => i.toString()), [])

  const formatTime = (sec: number) => {
    const absSec = Math.abs(sec)
    const m = Math.floor(absSec / 60)
    const s = absSec % 60
    const sign = sec < 0 ? '-' : ''
    return `${sign}${m}:${s.toString().padStart(2, '0')}`
  }

  const bgColorClass = useMemo(() => {
    switch (status) {
      case 'yellow':
        return 'status-yellow'
      case 'red':
        return 'status-red'
      case 'timeout':
        return 'bg-destructive animate-pulse'
      case 'green':
        return isRunning ? 'status-green' : 'bg-gradient-page'
      default:
        return 'bg-gradient-page'
    }
  }, [status, isRunning])

  const {windowHeight, windowWidth} = useMemo(() => {
    try {
      const info = Taro.getSystemInfoSync()
      return {
        windowHeight: info.windowHeight || 812,
        windowWidth: info.windowWidth || 375
      }
    } catch {
      return {
        windowHeight: 812,
        windowWidth: 375
      }
    }
  }, [])
  const isCompact = windowHeight < 840 || windowWidth < 380
  const isNarrowLayout = windowWidth < 410

  if (!currentSession || activeItems.length === 0) return null

  return (
    <View className={`h-screen w-full overflow-hidden flex flex-col transition-colors duration-500 ${bgColorClass}`}>
      <View className={`${isCompact ? 'px-4 pt-6 pb-2' : 'p-5 pt-8'} flex justify-between items-center text-white`}>
        <View className="ui-btn-secondary w-9 h-9 p-0 rounded-full" onClick={() => Taro.navigateBack()}>
          <View className="i-mdi-chevron-left text-2xl text-foreground" />
        </View>
        <Text className="text-sm font-bold uppercase tracking-widest opacity-80">
          {currentIndex + 1} / {totalItems}
        </Text>
        <View className="w-8" />
      </View>

      <ScrollView scrollY enableFlex className="flex-1 w-full">
        <View
          className={`${isCompact ? 'w-full h-full px-4 pb-3' : 'w-full h-full px-4 pb-4'} flex flex-col justify-between`}>
          <View className={`flex flex-col items-center ${isCompact ? 'px-2 pt-1' : 'px-6 pt-2'}`}>
            <View className={`text-center w-full ${isCompact ? 'mb-4' : 'mb-8'}`}>
              <Text
                className={
                  isCompact
                    ? 'text-[34px] font-bold text-white block mb-1 max-w-full truncate px-1'
                    : 'text-3xl font-bold text-white block mb-2 drop-shadow-md max-w-full truncate px-1'
                }>
                {currentItem?.title}
              </Text>
              <Text
                className={
                  isCompact
                    ? 'text-lg text-white/90 block max-w-full truncate px-1'
                    : 'text-xl text-white/90 block max-w-full truncate px-1'
                }>
                {currentItem?.speaker || '主持人'}
              </Text>
            </View>

            <View
              className={`relative flex items-center justify-center ${isCompact ? 'w-44 h-44' : 'w-56 h-56'}`}
              onClick={handleDoubleTapTimer}>
              {/* 进度环效果 */}
              <View
                className={`${isCompact ? 'border-[5px]' : 'border-[6px]'} absolute inset-0 rounded-full border-white/10`}
              />
              <Text
                className={`${isCompact ? 'text-4xl' : 'text-5xl'} font-mono font-bold tracking-tight text-white ${status === 'timeout' ? 'scale-110' : ''} transition-transform`}>
                {formatTime(remaining)}
              </Text>
            </View>

            <View className={isCompact ? 'mt-2 text-center' : 'mt-8 text-center'}>
              <Text className={isCompact ? 'text-xs text-white/80 block' : 'text-sm text-white/80 block'}>
                已用时 {formatTime(elapsed)}
              </Text>
              {!isCompact && (
                <Text className="text-xs text-white/70 block mt-1">点“调时”修改计划时长，双击圆盘也可快速打开</Text>
              )}
            </View>
          </View>

          <View
            className={`${isCompact ? 'mb-2 pt-2.5 pb-3' : 'mb-2 pt-3 pb-4'} w-full px-0 bg-black/30 border-t border-white/10 overflow-x-hidden`}>
            {/* 查看 Agenda 按钮 */}
            <View className={`${isCompact ? 'mb-2' : 'mb-3'} flex items-center justify-center`}>
              <View
                className={`${isCompact ? 'h-9 px-3.5 gap-1.5' : 'h-10 px-4 gap-2'} ui-btn-secondary rounded-full flex items-center`}
                onClick={() => setShowRemainingItems(!showRemainingItems)}>
                <View className={`${isCompact ? 'text-sm' : 'text-base'} i-mdi-format-list-bulleted text-foreground`} />
                <Text className={`${isCompact ? 'text-[12px]' : 'text-sm'} font-bold text-foreground`}>
                  查看 Agenda 日程
                </Text>
                <View
                  className={`i-mdi-chevron-${showRemainingItems ? 'up' : 'down'} ${isCompact ? 'text-sm' : 'text-base'} text-foreground`}
                />
              </View>
            </View>

            <View className={`${isCompact ? 'mb-2' : 'mb-3'} flex items-center justify-center`}>
              <View
                className={`${isCompact ? 'h-8 px-3 gap-1.5' : 'h-9 px-3.5 gap-2'} ui-btn-secondary rounded-full flex items-center`}
                onClick={() => setShowOperationTips((prev) => !prev)}>
                <View className={`${isCompact ? 'text-xs' : 'text-sm'} i-mdi-information-outline text-foreground`} />
                <Text className={`${isCompact ? 'text-[11px]' : 'text-xs'} font-semibold text-foreground`}>
                  {showOperationTips ? '收起说明' : '展开说明'}
                </Text>
              </View>
            </View>

            {/* Agenda 日程列表 */}
            {showRemainingItems && (
              <View className="mb-3 bg-black/50 rounded-2xl overflow-hidden">
                <ScrollView
                  className={isCompact ? 'max-h-64' : 'max-h-96'}
                  scrollY
                  scrollIntoView={`item-${currentIndex}`}>
                  <View className="p-2">
                    <Text className="text-xs text-white/75 block px-3 py-2 uppercase tracking-wider">会议日程</Text>
                    {activeItems.map((item, idx) => {
                      const isCurrent = idx === currentIndex
                      const isPast = idx < currentIndex
                      const _isFuture = idx > currentIndex

                      return (
                        <View
                          key={item.id}
                          id={`item-${idx}`}
                          className={`mx-2 mb-2 rounded-xl overflow-hidden ${
                            isCurrent ? 'bg-primary/30 border-2 border-primary' : 'bg-black/30 border border-white/10'
                          }`}
                          onClick={() => {
                            if (!isCurrent) {
                              Taro.showModal({
                                title: '跳转确认',
                                content: `确定要跳转到"${item.title}"吗？`,
                                confirmText: '跳转',
                                success: (res) => {
                                  if (res.confirm) {
                                    jumpTo(idx)
                                    setShowRemainingItems(false)
                                    Taro.showToast({title: '已跳转', icon: 'success'})
                                  }
                                }
                              })
                            }
                          }}>
                          <View className="p-3 flex items-center gap-3">
                            {/* 序号或状态图标 */}
                            <View
                              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                                isCurrent
                                  ? 'bg-primary'
                                  : isPast
                                    ? 'bg-green-500/30 border border-green-500'
                                    : 'bg-white/10'
                              }`}>
                              {isPast ? (
                                <View className="i-mdi-check text-base text-green-400" />
                              ) : (
                                <Text className={`text-sm font-bold ${isCurrent ? 'text-white' : 'text-white/85'}`}>
                                  {idx + 1}
                                </Text>
                              )}
                            </View>

                            {/* 环节信息 */}
                            <View className="flex-1 min-w-0">
                              <View className="flex items-center flex-wrap gap-2 mb-1">
                                <Text
                                  className={`text-sm font-semibold block max-w-full truncate ${isCurrent ? 'text-white' : isPast ? 'text-white/70' : 'text-white/88'}`}>
                                  {item.title}
                                </Text>
                                {isCurrent && (
                                  <View className="bg-primary px-2 py-0.5 rounded-full">
                                    <Text className="text-[10px] text-white font-bold">当前</Text>
                                  </View>
                                )}
                              </View>
                              <View className="flex items-center flex-wrap gap-3 min-w-0">
                                <Text
                                  className={`text-xs max-w-full truncate ${isCurrent ? 'text-white/85' : 'text-white/68'}`}>
                                  {item.speaker || '未指定'}
                                </Text>
                                <Text className={`text-xs ${isCurrent ? 'text-white/85' : 'text-white/68'}`}>
                                  {Math.floor(item.plannedDuration / 60)}分钟
                                </Text>
                              </View>
                            </View>

                            {/* 跳转图标 */}
                            {!isCurrent && <View className="i-mdi-chevron-right text-lg text-white/65" />}
                          </View>
                        </View>
                      )
                    })}
                  </View>
                </ScrollView>
              </View>
            )}

            {showOperationTips && !isCompact && (
              <View className={`ui-panel-sharp mb-3 px-4 ${isNarrowLayout ? 'py-3.5' : 'py-3'}`}>
                <Text className={`${isNarrowLayout ? 'text-xs' : 'text-[11px]'} font-semibold text-white/88 block`}>
                  操作说明
                </Text>
                <View className="mt-1.5 space-y-1">
                  <View
                    className={`${isNarrowLayout ? 'text-xs' : 'text-[11px]'} text-white/75 leading-[1.65] break-words`}>
                    新增流程：插入当前后方，影响后续顺序与进度。
                  </View>
                  <View
                    className={`${isNarrowLayout ? 'text-xs' : 'text-[11px]'} text-white/75 leading-[1.65] break-words`}>
                    快速校时：只改当前已用时/剩余时长，不改计划时长。
                  </View>
                </View>
              </View>
            )}

            {/* 编辑、调时、新增、删除按钮 */}
            <View className={`${isCompact ? 'mb-2 gap-1.5 grid-cols-2' : 'mb-3 gap-2 grid-cols-2'} grid`}>
              <View
                className={`${isCompact ? 'min-h-[38px] py-2 px-2.5 gap-1 rounded-lg' : 'min-h-[42px] py-2 px-4 gap-1.5 rounded-lg'} ui-btn-secondary w-full flex items-center justify-center`}
                onClick={handleOpenEdit}>
                <View className={`${isCompact ? 'text-sm' : 'text-base'} i-mdi-pencil text-foreground`} />
                <Text
                  className={`${isCompact ? 'text-[11px]' : 'text-sm'} font-semibold text-foreground leading-tight`}>
                  编辑
                </Text>
              </View>
              <View
                className={`${isCompact ? 'min-h-[38px] py-2 px-2.5 gap-1 rounded-lg' : 'min-h-[42px] py-2 px-4 gap-1.5 rounded-lg'} ui-btn-secondary w-full flex items-center justify-center`}
                onClick={openTimeEditDialog}>
                <View className={`${isCompact ? 'text-sm' : 'text-base'} i-mdi-clock-outline text-foreground`} />
                <Text
                  className={`${isCompact ? 'text-[11px]' : 'text-sm'} font-semibold text-foreground leading-tight`}>
                  调时
                </Text>
              </View>
              <View
                className={`${isCompact ? 'min-h-[38px] py-2 px-2.5 gap-1 rounded-lg' : 'min-h-[42px] py-2 px-4 gap-1.5 rounded-lg'} ui-btn-primary w-full flex items-center justify-center`}
                onClick={handleOpenAdd}>
                <View className={`${isCompact ? 'text-sm' : 'text-base'} i-mdi-plus text-white`} />
                <Text className={`${isCompact ? 'text-[11px]' : 'text-sm'} font-semibold text-white leading-tight`}>
                  新增流程
                </Text>
              </View>
              <View
                className={`${isCompact ? 'min-h-[38px] py-2 px-2.5 gap-1 rounded-lg' : 'min-h-[42px] py-2 px-4 gap-1.5 rounded-lg'} ui-btn-danger w-full flex items-center justify-center`}
                onClick={handleDeleteCurrent}>
                <View className={`${isCompact ? 'text-sm' : 'text-base'} i-mdi-trash-can-outline text-white`} />
                <Text className={`${isCompact ? 'text-[11px]' : 'text-sm'} font-semibold text-white leading-tight`}>
                  删除
                </Text>
              </View>
            </View>

            <View style={{height: isCompact ? '4px' : '8px'}} />
          </View>
        </View>
      </ScrollView>

      {/* 底部固定控制区：保证关键按钮始终可见 */}
      <View
        className={`shrink-0 w-full bg-black/45 border-t border-white/12 ${isCompact ? 'px-3 pt-1.5' : 'px-4 pt-3'} pb-[max(env(safe-area-inset-bottom),10px)]`}>
        <View className={`${isCompact ? 'mb-1.5' : 'mb-2'} text-center`}>
          <Text className={isCompact ? 'text-[11px] text-white/88 block' : 'text-xs text-white/88 block'}>
            快速校时（仅当前环节）
          </Text>
          {!isCompact && (
            <Text className="text-[11px] text-white/68 block mt-0.5">
              回退 = 减少已用时（剩余变多）；补加 = 增加已用时（剩余变少）
            </Text>
          )}
        </View>

        <View className={`${isCompact ? 'mb-2 gap-2' : 'mb-3 gap-3'} flex items-center justify-center`}>
          <View className={`flex flex-col ${isCompact ? 'gap-1.5' : 'gap-2'}`}>
            <View
              className={`${isCompact ? 'w-[72px] h-9 rounded-lg' : 'w-[84px] h-10 rounded-xl'} bg-black/25 border border-white/40 flex items-center justify-center text-white active:border-white/60`}
              onClick={() => adjustTime(-30)}>
              <Text className={isCompact ? 'text-[13px] font-bold leading-none' : 'text-sm font-bold leading-none'}>
                -30
              </Text>
            </View>
            <View
              className={`${isCompact ? 'w-[72px] h-9 rounded-lg' : 'w-[84px] h-10 rounded-xl'} bg-black/25 border border-white/40 flex items-center justify-center text-white active:border-white/60`}
              onClick={() => adjustTime(-10)}>
              <Text className={isCompact ? 'text-[13px] font-bold leading-none' : 'text-sm font-bold leading-none'}>
                -10
              </Text>
            </View>
          </View>

          <View
            className={`${isCompact ? 'w-[72px] h-[72px]' : 'w-[84px] h-[84px]'} rounded-full bg-gradient-primary border border-cyan-300/35 flex flex-col items-center justify-center shadow-xl transition-all active:scale-95`}
            onClick={isRunning ? pause : start}
            onLongPress={handleLongPressReset}>
            <Text
              className={
                isCompact
                  ? 'text-[15px] font-bold text-white leading-none'
                  : 'text-base font-bold text-white leading-none'
              }>
              {isRunning ? '暂停' : '开始'}
            </Text>
            {isRunning && !isCompact && <Text className="text-[10px] text-white/70 mt-0.5">长按重置</Text>}
          </View>

          <View className={`flex flex-col ${isCompact ? 'gap-1.5' : 'gap-2'}`}>
            <View
              className={`${isCompact ? 'w-[72px] h-9 rounded-lg' : 'w-[84px] h-10 rounded-xl'} bg-black/25 border border-white/40 flex items-center justify-center text-white active:border-white/60`}
              onClick={() => adjustTime(10)}>
              <Text className={isCompact ? 'text-[13px] font-bold leading-none' : 'text-sm font-bold leading-none'}>
                +10
              </Text>
            </View>
            <View
              className={`${isCompact ? 'w-[72px] h-9 rounded-lg' : 'w-[84px] h-10 rounded-xl'} bg-black/25 border border-white/40 flex items-center justify-center text-white active:border-white/60`}
              onClick={() => adjustTime(30)}>
              <Text className={isCompact ? 'text-[13px] font-bold leading-none' : 'text-sm font-bold leading-none'}>
                +30
              </Text>
            </View>
          </View>
        </View>

        <View className={`flex items-center ${isCompact ? 'gap-2' : 'gap-3'}`}>
          <View className={`flex-1 ui-btn-secondary ${isCompact ? 'h-10' : 'h-11'} rounded-xl`} onClick={prev}>
            <Text className={`${isCompact ? 'text-[11px]' : 'text-sm'} font-semibold text-foreground`}>上一节</Text>
          </View>
          <View
            className={`flex-1 ui-btn-primary ${isCompact ? 'h-10' : 'h-11'} rounded-xl border-none`}
            onClick={next}>
            <Text className={`${isCompact ? 'text-[11px]' : 'text-sm'} font-bold text-white`}>
              {currentIndex === totalItems - 1 ? '完成会议' : '下一节'}
            </Text>
          </View>
        </View>
      </View>

      {/* 编辑对话框 */}
      {showEditDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowEditDialog(false)}>
          <View className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4" onClick={(e) => e.stopPropagation()}>
            <Text className="text-lg font-bold text-foreground block mb-4">编辑当前环节</Text>
            <View className="space-y-3">
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">环节名称</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={editTitle}
                  onInput={(e) => setEditTitle(e.detail.value)}
                  placeholder="请输入环节名称"
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">负责人</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={editSpeaker}
                  onInput={(e) => setEditSpeaker(e.detail.value)}
                  placeholder="请输入负责人"
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">计划时长（分钟）</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  type="number"
                  value={editDuration}
                  onInput={(e) => setEditDuration(e.detail.value)}
                  placeholder="请输入时长"
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">实际耗时（格式：分钟:秒，如 2:30）</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={editActualDuration}
                  onInput={(e) => setEditActualDuration(e.detail.value)}
                  placeholder="如：2:30 或留空"
                />
                <Text className="text-[10px] text-muted-foreground block mt-1">
                  用于补齐忘记计时的环节，留空则使用当前计时
                </Text>
              </View>
            </View>
            <View className="flex flex-wrap gap-3 mt-6">
              <Button className="flex-1 ui-btn-secondary h-10 text-sm" onClick={() => setShowEditDialog(false)}>
                取消
              </Button>
              <Button className="flex-1 ui-btn-primary h-10 text-sm font-bold" onClick={handleSaveEdit}>
                保存
              </Button>
            </View>
          </View>
        </View>
      )}

      {/* 新增环节对话框 */}
      {showAddDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowAddDialog(false)}>
          <View className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4" onClick={(e) => e.stopPropagation()}>
            <Text className="text-lg font-bold text-foreground block mb-4">新增环节</Text>
            <Text className="text-xs text-muted-foreground block mb-4 leading-5">
              新流程会插入在当前环节之后，并影响后续环节顺序与整体进度。
            </Text>
            <View className="space-y-3">
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">环节名称</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={editTitle}
                  onInput={(e) => setEditTitle(e.detail.value)}
                  placeholder="请输入环节名称"
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">负责人</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  value={editSpeaker}
                  onInput={(e) => setEditSpeaker(e.detail.value)}
                  placeholder="请输入负责人"
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground block mb-1">时长（分钟）</Text>
                <Input
                  className="ui-input rounded-lg px-3 py-2 text-sm w-full"
                  type="number"
                  value={editDuration}
                  onInput={(e) => setEditDuration(e.detail.value)}
                  placeholder="请输入时长"
                />
              </View>
            </View>
            <View className="flex flex-wrap gap-3 mt-6">
              <Button className="flex-1 ui-btn-secondary h-10 text-sm" onClick={() => setShowAddDialog(false)}>
                取消
              </Button>
              <Button className="flex-1 ui-btn-primary h-10 text-sm font-bold" onClick={handleAddItem}>
                添加
              </Button>
            </View>
          </View>
        </View>
      )}

      {/* 快速编辑时间对话框 */}
      {showTimeEditDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowTimeEditDialog(false)}>
          <View className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4" onClick={(e) => e.stopPropagation()}>
            <Text className="text-lg font-bold text-foreground block mb-4">编辑预设时间</Text>
            <Text className="text-sm text-muted-foreground block mb-4">当前环节：{currentItem?.title}</Text>
            <Text className="text-xs text-muted-foreground block mb-4">
              修改后会更新当前环节计划时长，并用于后续倒计时阈值判断。
            </Text>

            <View className="flex items-center justify-center flex-wrap gap-4 mb-6">
              {/* 分钟选择器 */}
              <View className="flex-1">
                <Text className="text-xs text-muted-foreground block mb-2 text-center">分钟</Text>
                <Picker
                  mode="selector"
                  range={minutesRange}
                  value={selectedMinutes}
                  onChange={(e) => setSelectedMinutes(Number(e.detail.value))}>
                  <View className="ui-input rounded-lg px-4 py-3 text-center">
                    <Text className="text-2xl font-bold text-foreground">{selectedMinutes}</Text>
                  </View>
                </Picker>
              </View>

              <Text className="text-2xl font-bold text-muted-foreground mt-6">:</Text>

              {/* 秒钟选择器 */}
              <View className="flex-1">
                <Text className="text-xs text-muted-foreground block mb-2 text-center">秒</Text>
                <Picker
                  mode="selector"
                  range={secondsRange}
                  value={selectedSeconds}
                  onChange={(e) => setSelectedSeconds(Number(e.detail.value))}>
                  <View className="ui-input rounded-lg px-4 py-3 text-center">
                    <Text className="text-2xl font-bold text-foreground">
                      {selectedSeconds.toString().padStart(2, '0')}
                    </Text>
                  </View>
                </Picker>
              </View>
            </View>

            <View className="ui-card rounded-lg p-3 mb-4 border-primary/30">
              <Text className="text-sm text-center text-foreground">
                总时长：
                <Text className="font-bold text-primary">
                  {selectedMinutes}分{selectedSeconds}秒
                </Text>
              </Text>
            </View>

            <View className="flex flex-wrap gap-3">
              <Button className="flex-1 ui-btn-secondary h-10 text-sm" onClick={() => setShowTimeEditDialog(false)}>
                取消
              </Button>
              <Button className="flex-1 ui-btn-primary h-10 text-sm font-bold" onClick={handleSaveTimeEdit}>
                确认
              </Button>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}
