import {Button, Input, ScrollView, Text, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {useCallback, useEffect, useState} from 'react'
import MeetingStats from '../../components/MeetingStats'
import PasswordModal from '../../components/PasswordModal'
import {DatabaseService} from '../../db/database'
import {VotingDatabaseService} from '../../db/votingDatabase'
import {StorageService} from '../../services/storage'
import {useMeetingStore} from '../../store/meetingStore'
import type {MeetingItem} from '../../types/meeting'
import {verifyPassword} from '../../utils/auth'
import {generateId} from '../../utils/id'
import {safeNavigateTo, safeSwitchTab} from '../../utils/safeNavigation'

export default function TimelinePage() {
  const {currentSession, setCurrentSession} = useMeetingStore()
  const [items, setItems] = useState<MeetingItem[]>([])
  const [metadata, setMetadata] = useState(currentSession?.metadata || {})
  const [showStats, setShowStats] = useState(false)
  const [isCloudSession, setIsCloudSession] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [isCompact, setIsCompact] = useState(false)
  const [showMeetingLinkDialog, setShowMeetingLinkDialog] = useState(false)
  const [meetingLinkInput, setMeetingLinkInput] = useState('')
  const [isEditingLink, setIsEditingLink] = useState(false)
  const [passwordAction, setPasswordAction] = useState<'reset' | 'addLink' | null>(null)

  useEffect(() => {
    try {
      const info = Taro.getSystemInfoSync()
      setIsCompact((info.windowWidth || 375) < 380)
    } catch {
      setIsCompact(false)
    }
  }, [])

  useEffect(() => {
    // 检查当前会议是否来自云端
    const checkCloudSession = async () => {
      if (currentSession) {
        const cloudSessions = await DatabaseService.getAllMeetings()
        const isCloud = cloudSessions.some((s) => s.id === currentSession.id)
        setIsCloudSession(isCloud)
      }
    }
    checkCloudSession()
  }, [currentSession])

  // 加载会议链接
  const loadMeetingLink = useCallback(async () => {
    if (!currentSession || !isCloudSession) return

    const link = await DatabaseService.getMeetingLink(currentSession.id)
    if (link) {
      // 使用函数式更新，避免依赖 metadata
      setMetadata((prev) => ({...prev, meetingLink: link}))
    }
  }, [currentSession, isCloudSession])

  useEffect(() => {
    if (currentSession) {
      setItems(currentSession.items)
      setMetadata(currentSession.metadata)
      // 如果会议已完成，默认显示统计视图
      if (currentSession.isCompleted) {
        setShowStats(true)
      }
      // 加载会议链接（从数据库）
      if (isCloudSession) {
        loadMeetingLink()
      }
    }
  }, [currentSession, isCloudSession, loadMeetingLink])

  useEffect(() => {
    if (currentSession) return

    // 给 Zustand 状态同步留一个缓冲窗口，避免页面切换瞬间白屏闪烁
    const timer = setTimeout(() => {
      void safeSwitchTab('/pages/history/index')
    }, 600)

    return () => clearTimeout(timer)
  }, [currentSession])

  const handleSaveAndStart = () => {
    if (!currentSession) return
    const updatedSession = {...currentSession, items, metadata}
    setCurrentSession(updatedSession)
    StorageService.saveSession(updatedSession)
    void safeNavigateTo('/pages/timer/index')
  }

  const handleExportAgenda = () => {
    if (!currentSession) return

    // 生成格式化的 Agenda 文本
    let text = '━━━━━━━━━━━━━━━━━━━━\n'
    text += '📋 会议 Agenda 日程\n'
    text += '━━━━━━━━━━━━━━━━━━━━\n\n'

    // 会议基本信息
    if (metadata.clubName) text += `🏛️  俱乐部：${metadata.clubName}\n`
    if (metadata.meetingNo) text += `🔢 会议次数：第 ${metadata.meetingNo} 次\n`
    if (metadata.theme) text += `📌 主题：${metadata.theme}\n`
    if (metadata.date) text += `📅 日期：${metadata.date}\n`
    if (metadata.timeRange) text += `⏰ 时间：${metadata.timeRange}\n`
    else if (metadata.startTime) text += `⏰ 开始时间：${metadata.startTime}\n`
    if (metadata.location) text += `📍 地点：${metadata.location}\n`
    if (metadata.wordOfTheDay) text += `💬 每日一词：${metadata.wordOfTheDay}\n`
    text += '\n'

    // 环节列表
    text += '━━━━━━━━━━━━━━━━━━━━\n'
    text += '📝 会议流程\n'
    text += '━━━━━━━━━━━━━━━━━━━━\n\n'

    items.forEach((item, index) => {
      if (item.disabled) return
      const minutes = Math.floor(item.plannedDuration / 60)
      const seconds = item.plannedDuration % 60
      const timeStr = seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分钟`

      text += `${index + 1}. ${item.title}\n`
      if (item.parentTitle) text += `   📂 所属：${item.parentTitle}\n`
      text += `   👤 负责人：${item.speaker}\n`
      text += `   ⏱️  时长：${timeStr}\n`
      if (item.startTime) text += `   🕐 开始：${item.startTime}\n`
      text += '\n'
    })

    // 统计信息
    const totalDuration = items.reduce((sum, item) => (item.disabled ? sum : sum + item.plannedDuration), 0)
    const totalMinutes = Math.floor(totalDuration / 60)
    text += '━━━━━━━━━━━━━━━━━━━━\n'
    text += `📊 总计：${items.filter((i) => !i.disabled).length} 个环节，预计 ${totalMinutes} 分钟\n`
    text += '━━━━━━━━━━━━━━━━━━━━\n\n'
    text += '© 启航AACTP 时间官'

    // 复制到剪贴板
    Taro.setClipboardData({
      data: text,
      success: () => {
        Taro.showToast({
          title: 'Agenda 已复制到剪贴板',
          icon: 'success',
          duration: 2000
        })
      }
    })
  }

  const handleCreateVoting = () => {
    if (!currentSession) return

    // 跳转到投票编辑页面
    void safeNavigateTo('/pages/vote-edit/index')
  }

  const handleResetMeeting = () => {
    if (!currentSession) return

    // 云端会议需要密码验证
    if (isCloudSession) {
      setPasswordAction('reset')
      setShowPasswordModal(true)
    } else {
      // 本地会议直接重置
      Taro.showModal({
        title: '重置会议',
        content: '确定要重置会议数据吗？将清空所有实际用时记录，可以重新开始计时。',
        confirmText: '重置',
        confirmColor: '#f59e0b',
        success: (res) => {
          if (res.confirm) {
            performReset()
          }
        }
      })
    }
  }

  const handlePasswordConfirm = (password: string) => {
    setShowPasswordModal(false)

    if (!verifyPassword(password)) {
      Taro.showToast({title: '密码错误', icon: 'error'})
      return
    }

    // 根据不同的操作执行相应的逻辑
    if (passwordAction === 'reset') {
      performReset()
    } else if (passwordAction === 'addLink') {
      saveMeetingLink()
    }
    setPasswordAction(null)
  }

  const handlePasswordCancel = () => {
    setShowPasswordModal(false)
    setPasswordAction(null)
  }

  // 打开会议链接对话框
  const handleOpenMeetingLink = () => {
    setMeetingLinkInput(metadata.meetingLink || '')
    setIsEditingLink(false) // 默认为查看模式
    setShowMeetingLinkDialog(true)
  }

  // 复制会议链接
  const handleCopyMeetingLink = () => {
    if (!metadata.meetingLink) {
      Taro.showToast({title: '暂无会议链接', icon: 'none'})
      return
    }
    Taro.setClipboardData({
      data: metadata.meetingLink,
      success: () => {
        Taro.showToast({title: '链接已复制', icon: 'success'})
      }
    })
  }

  // 保存会议链接（需要密码验证）
  const handleSaveMeetingLink = async () => {
    if (!meetingLinkInput.trim()) {
      Taro.showToast({title: '请输入会议链接', icon: 'none'})
      return
    }

    // 任何修改链接的操作都需要密码验证
    setPasswordAction('addLink')
    setShowPasswordModal(true)
  }

  // 执行保存会议链接
  const saveMeetingLink = async () => {
    if (!currentSession) return

    const updatedMetadata = {...metadata, meetingLink: meetingLinkInput.trim()}
    setMetadata(updatedMetadata)

    const updatedSession = {...currentSession, metadata: updatedMetadata}
    setCurrentSession(updatedSession)
    StorageService.saveSession(updatedSession)

    // 保存到数据库（使用独立的 meeting_links 表）
    if (isCloudSession) {
      const result = await DatabaseService.saveMeetingLink(currentSession.id, meetingLinkInput.trim())
      if (!result.success) {
        Taro.showToast({title: `保存失败：${result.error}`, icon: 'none'})
        return
      }
    }

    setShowMeetingLinkDialog(false)
    setIsEditingLink(false)
    Taro.showToast({title: '链接已保存', icon: 'success'})
  }

  const performReset = async () => {
    if (!currentSession) return

    // 1. 清空所有实际用时记录
    const resetItems = items.map((item) => ({
      ...item,
      actualDuration: undefined,
      actualStartTime: undefined,
      actualEndTime: undefined
    }))
    setItems(resetItems)

    // 2. 清除会议链接（从本地状态）
    const resetMetadata = {
      ...metadata,
      meetingLink: undefined
    }
    setMetadata(resetMetadata)

    // 3. 删除数据库中的会议链接
    if (isCloudSession && currentSession.id) {
      const deleteLinkResult = await DatabaseService.deleteMeetingLink(currentSession.id)
      if (!deleteLinkResult.success) {
        console.error('删除会议链接失败:', deleteLinkResult.error)
        // 继续执行重置，不因链接删除失败而中断
      }
    }

    // 4. 删除投票会话及其所有相关数据（通过级联删除自动处理）
    if (isCloudSession && currentSession.id) {
      const deleteVotingResult = await VotingDatabaseService.deleteVotingSession(currentSession.id)
      if (!deleteVotingResult.success) {
        console.error('删除投票会话失败:', deleteVotingResult.error)
        // 继续执行重置，不因投票删除失败而中断
      }
    }

    // 5. 更新会议状态
    const resetSession = {
      ...currentSession,
      items: resetItems,
      metadata: resetMetadata,
      isCompleted: false
    }
    setCurrentSession(resetSession)
    StorageService.saveSession(resetSession, {syncToCloud: false})

    // 6. 如果是云端会议，同步到数据库
    if (isCloudSession) {
      const result = await DatabaseService.saveMeeting(resetSession)
      if (!result.success) {
        Taro.showToast({title: `保存失败：${result.error}`, icon: 'none'})
        return
      }
    }

    setShowStats(false)
    Taro.showToast({title: '已重置会议', icon: 'success'})
  }

  const updateItem = (id: string, updates: Partial<MeetingItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? {...item, ...updates} : item)))
  }

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }

  // 上移环节
  const moveItemUp = (index: number) => {
    if (index === 0) return
    const newItems = [...items]
    ;[newItems[index - 1], newItems[index]] = [newItems[index], newItems[index - 1]]
    setItems(newItems)
  }

  // 下移环节
  const moveItemDown = (index: number) => {
    if (index === items.length - 1) return
    const newItems = [...items]
    ;[newItems[index], newItems[index + 1]] = [newItems[index + 1], newItems[index]]
    setItems(newItems)
  }

  // 在指定位置插入新环节
  const insertItemAt = (index: number) => {
    const newItem: MeetingItem = {
      id: generateId('item'),
      title: '新环节',
      speaker: '',
      plannedDuration: 120,
      type: 'other',
      ruleId: 'short'
    }
    const newItems = [...items]
    newItems.splice(index, 0, newItem)
    setItems(newItems)
    Taro.showToast({title: '已添加环节', icon: 'success'})
  }

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  if (!currentSession) {
    return (
      <View className="h-screen bg-gradient-page flex items-center justify-center">
        <Text className="text-sm text-white/80">正在加载会议...</Text>
      </View>
    )
  }

  const isCompleted = currentSession?.isCompleted || false

  console.log('Timeline Debug:', {
    hasSession: !!currentSession,
    isCompleted,
    itemsCount: items.length
  })

  return (
    <View className="h-screen bg-gradient-page flex flex-col">
      <View className="p-4 pt-8 bg-background/90 border-b border-border/70 flex-shrink-0 backdrop-blur-sm">
        <View className="flex justify-between items-start mb-4 gap-2">
          <Text className="text-[22px] font-black text-foreground flex-1 min-w-0 truncate pr-1">
            {isCompleted ? '会议复盘' : '流程预览'}
          </Text>
          <View className="flex flex-wrap gap-2 justify-end">
            {!isCompleted && (
              <>
                <View
                  className="ui-btn-secondary h-10 px-3 rounded-lg flex items-center gap-1.5"
                  onClick={handleExportAgenda}>
                  <View className="i-mdi-export text-base text-foreground" />
                  <Text className="text-xs font-semibold text-foreground">导出</Text>
                </View>
                <View
                  className="ui-btn-secondary h-10 px-3 rounded-lg flex items-center gap-1.5"
                  onClick={handleCreateVoting}>
                  <View className="i-mdi-vote text-base text-foreground" />
                  <Text className="text-xs font-semibold text-foreground">投票</Text>
                </View>
              </>
            )}
            <View
              className="ui-btn-secondary h-10 px-3 rounded-lg flex items-center gap-1.5"
              onClick={() => Taro.navigateBack()}>
              <View className="i-mdi-undo text-base text-foreground" />
              <Text className="text-xs font-semibold text-foreground">返回</Text>
            </View>
            {isCompleted && (
              <>
                <View
                  className="h-10 px-3 rounded-lg flex items-center gap-1.5 border border-amber-500/55 bg-amber-500/10 active:bg-amber-500/15"
                  onClick={handleResetMeeting}>
                  <View className="i-mdi-refresh text-base text-amber-400" />
                  <Text className="text-xs font-semibold text-amber-300">重置</Text>
                </View>
                <View
                  className={`h-10 px-3 rounded-lg flex items-center gap-1.5 border ${
                    showStats
                      ? 'bg-primary border-primary/60 active:bg-primary/85'
                      : 'bg-secondary/70 border-border/70 active:bg-secondary/85'
                  }`}
                  onClick={() => setShowStats(!showStats)}>
                  <View
                    className={`i-mdi-${showStats ? 'format-list-bulleted' : 'chart-bar'} text-base ${
                      showStats ? 'text-white' : 'text-foreground'
                    }`}
                  />
                  <Text className={`text-xs font-semibold ${showStats ? 'text-white' : 'text-foreground'}`}>
                    {showStats ? '列表' : '统计'}
                  </Text>
                </View>
                <View
                  className="h-10 px-3 rounded-lg flex items-center gap-1.5 border border-primary/60 bg-primary active:bg-primary/85"
                  onClick={() => {
                    const summary = items
                      .filter((i) => !i.disabled)
                      .map(
                        (i) =>
                          `${i.title} (${i.speaker || 'N/A'}): 计划 ${formatDuration(
                            i.plannedDuration
                          )}, 实际 ${formatDuration(i.actualDuration || 0)}`
                      )
                      .join('\n')
                    Taro.setClipboardData({data: summary})
                  }}>
                  <View className="i-mdi-content-copy text-base text-white" />
                  <Text className="text-xs font-semibold text-white">复制</Text>
                </View>
              </>
            )}
          </View>
        </View>

        {!showStats && (
          <>
            <View className={`grid ${isCompact ? 'grid-cols-1' : 'grid-cols-2'} gap-2`}>
              <View className="ui-card p-2">
                <Text className="text-xs text-muted-foreground block mb-0.5 uppercase tracking-wider">会议主题</Text>
                <Input
                  className="text-sm text-foreground w-full font-medium mt-1"
                  value={metadata.theme}
                  onInput={(e) => setMetadata({...metadata, theme: e.detail.value})}
                  placeholder="请输入主题"
                  adjustPosition={false}
                />
              </View>
              <View className="ui-card p-2">
                <Text className="text-xs text-muted-foreground block mb-0.5 uppercase tracking-wider">开始时间</Text>
                <Input
                  className="text-sm text-foreground w-full font-medium mt-1"
                  value={metadata.startTime}
                  onInput={(e) => setMetadata({...metadata, startTime: e.detail.value})}
                  placeholder="19:30"
                  adjustPosition={false}
                />
              </View>
            </View>

            {/* 投票 ID 显示 */}
            {metadata.votingId && (
              <View className="mt-2 ui-card border-primary/30">
                <View className="flex justify-between items-center flex-wrap gap-2">
                  <View className="flex-1 min-w-0">
                    <Text className="text-[10px] text-muted-foreground block mb-0.5 uppercase tracking-wider">
                      投票ID
                    </Text>
                    <Text className="text-lg font-bold text-foreground tracking-widest break-all">
                      {metadata.votingId}
                    </Text>
                  </View>
                  <View className="flex gap-2 justify-end shrink-0">
                    <View
                      className="ui-top-action-btn w-11 h-11"
                      onClick={() => {
                        Taro.setClipboardData({
                          data: metadata.votingId!,
                          success: () => {
                            Taro.showToast({title: 'ID已复制', icon: 'success'})
                          }
                        })
                      }}>
                      <View className="i-mdi-content-copy text-base text-foreground" />
                    </View>
                    <View
                      className="ui-top-action-btn w-11 h-11 bg-primary border-primary/60 active:bg-primary/85"
                      onClick={() => {
                        void safeNavigateTo(`/pages/vote-result/index?id=${metadata.votingId}`)
                      }}>
                      <View className="i-mdi-chart-bar text-base text-white" />
                    </View>
                  </View>
                </View>
              </View>
            )}
          </>
        )}
      </View>

      {showStats && isCompleted ? (
        <View className="flex-1">
          <MeetingStats
            items={items}
            metadata={metadata}
            meetingId={currentSession?.id}
            onCreateVoting={handleCreateVoting}
            topContent={
              <View className="space-y-2">
                <View className="ui-card p-3 border-primary/30">
                  <Text className="text-sm font-medium text-foreground block text-center">
                    📊 查看会议统计数据和超时分析
                  </Text>
                </View>

                <View className="flex flex-wrap gap-2">
                  <View
                    className="flex-1 ui-btn-secondary h-11 p-3 rounded-lg flex items-center justify-center"
                    onClick={handleOpenMeetingLink}>
                    <View className="i-mdi-link-variant text-base text-primary mr-2" />
                    <Text className="text-sm text-foreground">查看会议链接</Text>
                  </View>
                  {metadata.meetingLink && (
                    <View
                      className="ui-btn-primary h-11 px-4 rounded-lg flex items-center justify-center"
                      onClick={handleCopyMeetingLink}>
                      <View className="i-mdi-content-copy text-base text-white" />
                    </View>
                  )}
                </View>

                <View className="ui-muted-panel">
                  <Text className="text-sm text-muted-foreground text-center">
                    💡 提示：点击"查看会议链接"可{metadata.meetingLink ? '查看或编辑' : '添加'}
                    会议链接，添加需要密码验证
                  </Text>
                </View>
              </View>
            }
          />
        </View>
      ) : (
        <ScrollView className="flex-1 min-h-0 pt-3" scrollY enableBackToTop>
          <View className={`space-y-3 pl-4 pr-6 ${isCompleted ? 'pb-6' : 'pb-3'} max-w-full overflow-x-hidden`}>
            {items.map((item, index) => (
              <View key={item.id}>
                {/* 在第一个环节前显示插入按钮 */}
                {index === 0 && (
                  <View className="flex items-center justify-center py-2 mb-2" onClick={() => insertItemAt(0)}>
                    <View className="ui-btn-secondary h-9 px-4 rounded-full flex items-center gap-1.5">
                      <View className="i-mdi-plus text-base text-foreground" />
                      <Text className="text-sm text-foreground font-semibold">在此处插入环节</Text>
                    </View>
                  </View>
                )}

                {/* 环节卡片 */}
                <View
                  className={`ui-card-sharp p-4 ${item.disabled ? 'opacity-45 border-dashed' : 'border-l-2 border-l-primary/35'} flex flex-col relative`}>
                  <View className="flex justify-between items-start flex-wrap gap-2 mb-2">
                    <View className="flex items-center flex-1 min-w-0">
                      <View className="w-7 h-7 rounded-full bg-primary/20 border-2 border-primary/50 flex items-center justify-center mr-2">
                        <Text className="text-xs font-bold text-foreground">{index + 1}</Text>
                      </View>
                      <Input
                        className="text-base font-semibold text-foreground flex-1 min-w-0"
                        value={item.title}
                        onInput={(e) => updateItem(item.id, {title: e.detail.value})}
                        adjustPosition={false}
                      />
                    </View>
                    <View className="flex items-center flex-wrap gap-1.5 justify-end">
                      {/* 上移按钮 */}
                      <View
                        className={`ui-mini-icon-btn ${index === 0 ? 'opacity-40' : ''}`}
                        onClick={() => index > 0 && moveItemUp(index)}>
                        <View className="i-mdi-chevron-up text-base text-foreground/85" />
                      </View>
                      {/* 下移按钮 */}
                      <View
                        className={`ui-mini-icon-btn ${index === items.length - 1 ? 'opacity-40' : ''}`}
                        onClick={() => index < items.length - 1 && moveItemDown(index)}>
                        <View className="i-mdi-chevron-down text-base text-foreground/85" />
                      </View>
                      {/* 禁用/启用按钮 */}
                      <View
                        className="ui-mini-icon-btn"
                        onClick={() => updateItem(item.id, {disabled: !item.disabled})}>
                        {item.disabled ? (
                          <View className="i-mdi-eye-off text-base text-foreground/85" />
                        ) : (
                          <View className="i-mdi-eye text-base text-foreground/85" />
                        )}
                      </View>
                      {/* 删除按钮 */}
                      <View
                        className="ui-mini-icon-btn bg-destructive/80 border-red-400/35 active:bg-destructive"
                        onClick={() => removeItem(item.id)}>
                        <View className="i-mdi-trash-can-outline text-base text-white" />
                      </View>
                    </View>
                  </View>

                  <View className="flex items-center justify-between mt-2 gap-2 flex-wrap">
                    <View className="ui-panel-sharp p-2 flex items-center gap-3 min-w-0 flex-1 flex-wrap">
                      <View className="flex items-center">
                        <View className="i-mdi-account-outline text-sm text-muted-foreground mr-1" />
                        <Input
                          className="text-sm text-foreground/90 flex-1 min-w-[96px]"
                          value={item.speaker}
                          onInput={(e) => updateItem(item.id, {speaker: e.detail.value})}
                          placeholder="负责人"
                          adjustPosition={false}
                        />
                      </View>
                      <View className="flex items-center">
                        <View className="i-mdi-clock-outline text-sm text-muted-foreground mr-1" />
                        <Text className="text-sm text-foreground/90">{formatDuration(item.plannedDuration)}</Text>
                      </View>
                    </View>

                    <View className="ui-panel-sharp p-1 flex items-center gap-1">
                      <View
                        className="ui-btn-secondary h-10 px-3 rounded-lg"
                        onClick={() => updateItem(item.id, {plannedDuration: Math.max(30, item.plannedDuration - 30)})}>
                        <Text className="text-xs font-semibold">-30s</Text>
                      </View>
                      <View
                        className="ui-btn-secondary h-10 px-3 rounded-lg"
                        onClick={() => updateItem(item.id, {plannedDuration: item.plannedDuration + 30})}>
                        <Text className="text-xs font-semibold">+30s</Text>
                      </View>
                    </View>
                  </View>
                </View>

                {/* 在每个环节后显示插入按钮 */}
                <View className="flex items-center justify-center py-2" onClick={() => insertItemAt(index + 1)}>
                  <View className="ui-btn-secondary h-9 px-4 rounded-full flex items-center gap-1.5">
                    <View className="i-mdi-plus text-base text-foreground" />
                    <Text className="text-sm text-foreground font-semibold">在此处插入环节</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      {!isCompleted && (
        <View className="shrink-0 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)] bg-gradient-to-t from-background via-background/95 to-transparent border-t border-border/60">
          {/* 开始计时按钮 */}
          <Button
            className="ui-btn-primary h-12 flex items-center justify-center font-bold shadow-xl w-full text-base break-keep"
            onClick={handleSaveAndStart}>
            <View className="i-mdi-play-circle text-2xl mr-2" />
            开始计时
          </Button>
        </View>
      )}

      <PasswordModal visible={showPasswordModal} onConfirm={handlePasswordConfirm} onCancel={handlePasswordCancel} />

      {/* 会议链接对话框 */}
      {showMeetingLinkDialog && (
        <View
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70]"
          onClick={() => {
            setShowMeetingLinkDialog(false)
            setIsEditingLink(false)
          }}>
          <View
            className="ui-card-strong ui-modal-panel rounded-2xl p-6 mx-4 w-full max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <Text className="text-lg font-bold text-foreground block mb-4">
              {!metadata.meetingLink || isEditingLink ? '编辑会议链接' : '会议链接'}
            </Text>

            {!metadata.meetingLink || isEditingLink ? (
              <>
                <Text className="text-sm text-muted-foreground block mb-3">
                  {!metadata.meetingLink ? '添加' : '修改'}会议链接需要密码验证，请输入链接后点击保存
                </Text>
                <View className="ui-input rounded-lg px-3 py-2 mb-4">
                  <Input
                    className="text-sm text-foreground w-full"
                    value={meetingLinkInput}
                    onInput={(e) => setMeetingLinkInput(e.detail.value)}
                    placeholder="请输入会议链接"
                    adjustPosition={false}
                  />
                </View>
              </>
            ) : (
              <>
                <View className="bg-primary/10 rounded-lg p-3 mb-4 border border-primary/30">
                  <Text className="text-sm text-foreground break-all">{meetingLinkInput || '暂无链接'}</Text>
                </View>
                <Text className="text-xs text-muted-foreground block mb-3">💡 点击下方按钮可复制链接或编辑</Text>
              </>
            )}

            <View className="flex flex-wrap gap-3">
              <Button
                className="flex-1 ui-btn-secondary h-10 text-sm"
                onClick={() => {
                  setShowMeetingLinkDialog(false)
                  setIsEditingLink(false)
                }}>
                {!metadata.meetingLink || isEditingLink ? '取消' : '关闭'}
              </Button>
              {!metadata.meetingLink || isEditingLink ? (
                <Button className="flex-1 ui-btn-primary h-10 text-sm font-bold" onClick={handleSaveMeetingLink}>
                  保存
                </Button>
              ) : (
                <>
                  <Button className="flex-1 ui-btn-secondary h-10 text-sm font-bold" onClick={handleCopyMeetingLink}>
                    复制
                  </Button>
                  <Button
                    className="flex-1 ui-btn-primary h-10 text-sm font-bold"
                    onClick={() => setIsEditingLink(true)}>
                    编辑
                  </Button>
                </>
              )}
            </View>
          </View>
        </View>
      )}
    </View>
  )
}
