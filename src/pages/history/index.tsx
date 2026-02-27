import {Input, Text, View} from '@tarojs/components'
import Taro, {useDidShow} from '@tarojs/taro'
import {useRef, useState} from 'react'
import PasswordModal from '../../components/PasswordModal'
import {DatabaseService} from '../../db/database'
import {StorageService} from '../../services/storage'
import {useMeetingStore} from '../../store/meetingStore'
import type {MeetingSession} from '../../types/meeting'
import {verifyPassword} from '../../utils/auth'
import {generateId} from '../../utils/id'
import {safeNavigateTo} from '../../utils/safeNavigation'

type PasswordAction = 'delete' | null

export default function HistoryPage() {
  const [sessions, setSessions] = useState<MeetingSession[]>([])
  const [filteredSessions, setFilteredSessions] = useState<MeetingSession[]>([])
  const [searchText, setSearchText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isNavigating, setIsNavigating] = useState(false)
  const {setCurrentSession} = useMeetingStore()
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [passwordAction, setPasswordAction] = useState<PasswordAction>(null)
  const [pendingSession, setPendingSession] = useState<MeetingSession | null>(null)
  const isNavigatingRef = useRef(false)
  const completedCount = sessions.filter((session) => session.isCompleted).length
  const inProgressCount = sessions.length - completedCount

  const getSessionProgressScore = (session: MeetingSession): number => {
    const completedItems = session.items.filter(
      (item) => item.actualDuration !== undefined || item.actualEndTime
    ).length
    const totalActual = session.items.reduce((sum, item) => sum + (item.actualDuration || 0), 0)
    const hasInProgressItem = session.items.some((item) => item.actualStartTime && !item.actualEndTime)
    const completedBonus = session.isCompleted ? 1_000_000 : 0
    const inProgressBonus = hasInProgressItem ? 500 : 0

    return completedBonus + completedItems * 1000 + totalActual + inProgressBonus
  }

  const pickPreferredSession = (a: MeetingSession, b: MeetingSession): MeetingSession => {
    const aScore = getSessionProgressScore(a)
    const bScore = getSessionProgressScore(b)
    if (aScore === bScore) {
      return a.createdAt >= b.createdAt ? a : b
    }
    return aScore > bScore ? a : b
  }

  const goToTimeline = async (session: MeetingSession) => {
    if (isNavigatingRef.current) return
    isNavigatingRef.current = true

    setIsNavigating(true)
    setCurrentSession(session)
    StorageService.saveSession(session)

    const ok = await safeNavigateTo('/pages/timeline/index')
    if (!ok) {
      setIsNavigating(false)
      Taro.showToast({title: '页面打开失败，请重试', icon: 'none'})
    }

    setTimeout(() => {
      isNavigatingRef.current = false
      setIsNavigating(false)
    }, 800)
  }

  useDidShow(() => {
    loadSessions()
  })

  const loadSessions = async () => {
    setIsLoading(true)
    // 只加载云端会议
    const localSessions = StorageService.getSessions()
    const cloudSessions = await DatabaseService.getAllMeetings()

    const mergedMap = new Map<string, MeetingSession>()
    for (const session of cloudSessions) {
      mergedMap.set(session.id, session)
    }

    for (const session of localSessions) {
      const existing = mergedMap.get(session.id)
      if (!existing) {
        mergedMap.set(session.id, session)
      } else {
        mergedMap.set(session.id, pickPreferredSession(session, existing))
      }
    }

    const mergedSessions = Array.from(mergedMap.values()).sort((a, b) => b.createdAt - a.createdAt)
    setSessions(mergedSessions)
    setFilteredSessions(mergedSessions)
    setIsLoading(false)
  }

  const handleSearch = (text: string) => {
    setSearchText(text)
    if (!text.trim()) {
      setFilteredSessions(sessions)
      return
    }

    const filtered = sessions.filter((session) => {
      const theme = session.metadata.theme?.toLowerCase() || ''
      const meetingNo = session.metadata.meetingNo?.toString() || ''
      const searchLower = text.toLowerCase()

      return theme.includes(searchLower) || meetingNo.includes(searchLower)
    })

    setFilteredSessions(filtered)
  }

  const handleNewMeeting = () => {
    setCurrentSession(null)
    void safeNavigateTo('/pages/import/index')
  }

  const handleSelectSession = (session: MeetingSession) => {
    void goToTimeline(session)
  }

  const handleDeleteSession = async (session: MeetingSession, e: any) => {
    e.stopPropagation()

    // 云端会议需要密码验证
    setPendingSession(session)
    setPasswordAction('delete')
    setShowPasswordModal(true)
  }

  const handlePasswordConfirm = async (password: string) => {
    setShowPasswordModal(false)

    if (!verifyPassword(password)) {
      Taro.showToast({title: '密码错误', icon: 'error'})
      return
    }

    if (!pendingSession) return

    // 密码正确，执行删除操作
    if (passwordAction === 'delete') {
      const result = await DatabaseService.deleteMeeting(pendingSession.id)
      if (result.success) {
        StorageService.deleteSession(pendingSession.id)
        Taro.showToast({title: '已删除', icon: 'success'})
        loadSessions()
      } else {
        Taro.showToast({title: '删除失败', icon: 'error'})
      }
    }

    setPendingSession(null)
    setPasswordAction(null)
  }

  const handlePasswordCancel = () => {
    setShowPasswordModal(false)
    setPendingSession(null)
    setPasswordAction(null)
  }

  const handleCopySession = async (session: MeetingSession, e: any) => {
    e.stopPropagation()

    // 生成唯一的会议号
    let newMeetingNo = session.metadata.meetingNo
    if (newMeetingNo) {
      // 获取所有会议（本地+云端）
      const localSessions = StorageService.getSessions()
      const cloudSessions = await DatabaseService.getAllMeetings()
      const allSessions = [...localSessions, ...cloudSessions]

      // 提取所有已存在的会议号
      const existingNos = allSessions
        .map((s) => s.metadata.meetingNo)
        .filter((no): no is number | string => no !== undefined && no !== null)

      // 如果会议号已存在，添加后缀
      const meetingNoStr = String(newMeetingNo)
      if (existingNos.some((no) => String(no) === meetingNoStr)) {
        let suffix = 1
        let baseNo = meetingNoStr

        // 检查是否已有后缀格式 (如 "123(1)")
        const match = meetingNoStr.match(/^(.+)\((\d+)\)$/)
        if (match) {
          baseNo = match[1]
          suffix = parseInt(match[2], 10) + 1
        }

        // 找到可用的后缀数字
        while (existingNos.some((no) => String(no) === `${baseNo}(${suffix})`)) {
          suffix++
        }

        // 使用字符串格式保存，如 "123(1)"
        newMeetingNo = `${baseNo}(${suffix})`
      }
    }

    const newSession: MeetingSession = {
      ...session,
      id: generateId('session'),
      createdAt: Date.now(),
      isCompleted: false,
      metadata: {
        ...session.metadata,
        meetingNo: newMeetingNo,
        votingId: undefined, // 清除投票ID
        meetingLink: undefined // 清除会议链接
      },
      items: session.items.map((item) => ({
        ...item,
        id: generateId('item'),
        actualDuration: undefined,
        actualStartTime: undefined,
        actualEndTime: undefined
      }))
    }

    // 立即保存到本地存储
    StorageService.saveSession(newSession, {syncToCloud: false})

    // 立即保存到数据库
    await DatabaseService.saveMeeting(newSession)

    setCurrentSession(newSession)
    Taro.showToast({title: '已复制并保存会议', icon: 'success', duration: 1500})
    setTimeout(() => {
      void goToTimeline(newSession)
    }, 1500)
  }

  return (
    <View className="app-page h-screen overflow-y-auto pb-[max(env(safe-area-inset-bottom),96px)]">
      {/* 简洁的标题栏 */}
      <View className="app-content pb-3">
        <View className="app-hero fade-in-up">
          <Text className="app-title">会议历史</Text>
          <Text className="app-subtitle">共 {sessions.length} 场会议</Text>
          <View className="ui-stat-grid">
            <View className="ui-stat-card">
              <Text className="ui-stat-label block">已完成</Text>
              <Text className="ui-stat-value block">{completedCount}</Text>
            </View>
            <View className="ui-stat-card">
              <Text className="ui-stat-label block">进行中</Text>
              <Text className="ui-stat-value block">{inProgressCount}</Text>
            </View>
          </View>
        </View>
      </View>

      {/* 搜索框 */}
      <View className="px-4 pt-4 pb-2">
        <View className="ui-card flex items-center px-4 py-2">
          <View className="i-mdi-magnify text-xl text-muted-foreground mr-2" />
          <Input
            className="flex-1 text-sm text-foreground"
            placeholder="搜索会议名称或会议次数"
            value={searchText}
            onInput={(e) => handleSearch(e.detail.value)}
          />
          {searchText && (
            <View className="i-mdi-close text-lg text-muted-foreground" onClick={() => handleSearch('')} />
          )}
        </View>
      </View>

      {/* 会议列表 */}
      <View className="px-4 pt-2">
        {isLoading ? (
          <View className="flex flex-col items-center justify-center py-20">
            <View className="i-mdi-loading text-4xl mb-4 text-primary animate-spin" />
            <Text className="text-sm text-muted-foreground">加载中...</Text>
          </View>
        ) : filteredSessions.length === 0 ? (
          <View className="flex flex-col items-center justify-center py-20">
            <View className="i-mdi-calendar-blank text-6xl mb-4 text-muted-foreground/30" />
            <Text className="text-base font-semibold text-foreground mb-2">
              {searchText ? '未找到匹配的会议' : '暂无会议记录'}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {searchText ? '尝试其他关键词' : '点击下方按钮开始第一场会议'}
            </Text>
          </View>
        ) : (
          <View className="space-y-3 pb-6">
            {filteredSessions.map((session) => (
              <View
                key={session.id}
                className="ui-card active:opacity-80 transition-opacity border-l-2 border-l-primary/35"
                onClick={() => handleSelectSession(session)}>
                {/* 会议信息 */}
                <View className="p-4">
                  <View className="flex items-start justify-between flex-wrap gap-2 mb-2">
                    <View className="flex-1 min-w-0 mr-3">
                      <Text className="text-base font-bold text-foreground mb-1 block truncate">
                        {session.metadata.theme || '未命名会议'}
                      </Text>
                      <View className="ui-row-wrap">
                        {session.metadata.meetingNo && (
                          <View className="ui-pill">
                            <Text className="text-xs text-foreground font-semibold">
                              第 {session.metadata.meetingNo} 次
                            </Text>
                          </View>
                        )}
                        {session.isCompleted && (
                          <View className="px-2 py-0.5 rounded-full border border-green-400/40 bg-green-500/20">
                            <Text className="text-xs text-foreground font-semibold">已完成</Text>
                          </View>
                        )}
                      </View>
                    </View>
                    {/* 操作按钮 */}
                    <View className="ui-actions-wrap shrink-0">
                      <View
                        className="ui-btn-secondary h-8 px-3 rounded-full flex items-center gap-1 active:opacity-80"
                        onClick={(e) => handleCopySession(session, e)}>
                        <View className="i-mdi-content-copy text-sm text-foreground" />
                        <Text className="text-xs text-foreground font-semibold">复制</Text>
                      </View>
                      <View
                        className="ui-btn-danger h-8 px-3 rounded-full flex items-center gap-1 active:opacity-80"
                        onClick={(e) => handleDeleteSession(session, e)}>
                        <View className="i-mdi-delete text-sm text-white" />
                        <Text className="text-xs text-white font-semibold">删除</Text>
                      </View>
                    </View>
                  </View>
                  {/* 详细信息 */}
                  <View className="ui-inline-meta">
                    <View className="flex items-center gap-1">
                      <View className="i-mdi-calendar text-sm" />
                      <Text className="text-xs">{session.metadata.date || '无日期'}</Text>
                    </View>
                    <View className="flex items-center gap-1">
                      <View className="i-mdi-clock-outline text-sm" />
                      <Text className="text-xs">{session.items.length} 个环节</Text>
                    </View>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* 右下角悬浮按钮 (FAB) */}
      <View
        className="ui-fab fixed right-6"
        style={{bottom: 'calc(env(safe-area-inset-bottom) + 88px)'}}
        onClick={handleNewMeeting}>
        <View className="i-mdi-plus text-3xl text-white" />
      </View>

      <PasswordModal visible={showPasswordModal} onConfirm={handlePasswordConfirm} onCancel={handlePasswordCancel} />

      {isNavigating && (
        <View className="fixed inset-0 z-[90] bg-gradient-page flex flex-col items-center justify-center">
          <View className="i-mdi-loading text-4xl text-primary animate-spin mb-3" />
          <Text className="text-sm text-white/80">正在打开会议...</Text>
        </View>
      )}
    </View>
  )
}
