import {Button, ScrollView, Text, View} from '@tarojs/components'
import Taro, {useDidShow, useRouter} from '@tarojs/taro'
import {useCallback, useEffect, useState} from 'react'
import {DatabaseService} from '../../db/database'
import {VotingDatabaseService} from '../../db/votingDatabase'
import {generateDeviceFingerprint, validateVoteSelections} from '../../services/votingService'
import type {VoteSubmission, VotingSession} from '../../types/voting'
import {safeRedirectTo, safeSwitchTab} from '../../utils/safeNavigation'

export default function VotePage() {
  const router = useRouter()
  const {id: sessionId} = router.params

  const [session, setSession] = useState<VotingSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [selections, setSelections] = useState<Map<string, Set<string>>>(new Map())
  const [hasVoted, setHasVoted] = useState(false)
  const [fingerprint, setFingerprint] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isEditing, setIsEditing] = useState(false) // 是否处于编辑模式
  const [meetingNo, setMeetingNo] = useState<string | number | null>(null) // 会议号

  // 生成设备指纹
  useEffect(() => {
    const fp = generateDeviceFingerprint()
    console.log('生成的设备指纹:', fp)
    setFingerprint(fp)
  }, [])

  // 加载投票会话
  const loadSession = useCallback(async () => {
    if (!sessionId) {
      Taro.showToast({title: '投票ID无效', icon: 'none'})
      return
    }

    setLoading(true)
    const data = await VotingDatabaseService.getVotingSession(sessionId)
    setLoading(false)

    if (!data) {
      Taro.showToast({title: '投票不存在', icon: 'none'})
      return
    }

    // 检查是否过期
    if (data.expiresAt && Date.now() > data.expiresAt) {
      data.status = 'closed'
    }

    setSession(data)

    // 加载会议号
    if (data.meetingId) {
      const no = await DatabaseService.getMeetingNo(data.meetingId)
      setMeetingNo(no)
    }

    // 检查是否已投票 - 需要等待 fingerprint 生成
    // 这部分逻辑移到单独的 useEffect 中处理
  }, [sessionId])

  useDidShow(() => {
    loadSession()
  })

  // 当 fingerprint 和 session 都准备好后，检查投票状态
  useEffect(() => {
    const checkVotingStatus = async () => {
      if (!sessionId || !fingerprint || !session) {
        console.log('检查投票状态 - 条件不满足:', {sessionId, fingerprint: !!fingerprint, session: !!session})
        return
      }

      console.log('开始检查投票状态 - sessionId:', sessionId, 'fingerprint:', fingerprint)
      const voted = await VotingDatabaseService.hasVoted(sessionId, fingerprint)
      console.log('投票状态检查结果:', voted)
      setHasVoted(voted)

      // 如果已投票，加载之前的投票记录
      if (voted) {
        console.log('用户已投票，加载投票记录')
        const userVotes = await VotingDatabaseService.getUserVotes(sessionId, fingerprint)
        console.log('用户投票记录:', userVotes)
        if (userVotes) {
          const newSelections = new Map<string, Set<string>>()
          userVotes.forEach((vote) => {
            newSelections.set(vote.groupId, new Set(vote.candidateIds))
          })
          setSelections(newSelections)
          console.log('已加载用户投票记录，设置 selections')
        }
      }
    }

    checkVotingStatus()
  }, [sessionId, fingerprint, session])

  // 切换候选人选择
  const toggleCandidate = (groupId: string, candidateId: string, maxSelections: number) => {
    // 如果已投票且不在编辑模式，不允许修改
    if (hasVoted && !isEditing) return

    setSelections((prev) => {
      const newSelections = new Map(prev)
      const groupSelections = newSelections.get(groupId) || new Set()

      if (groupSelections.has(candidateId)) {
        // 取消选择
        groupSelections.delete(candidateId)
      } else {
        // 添加选择
        if (groupSelections.size >= maxSelections) {
          Taro.showToast({
            title: `最多只能选择 ${maxSelections} 个`,
            icon: 'none',
            duration: 1500
          })
          return prev
        }
        groupSelections.add(candidateId)
      }

      newSelections.set(groupId, groupSelections)
      return newSelections
    })
  }

  // 提交投票
  const handleSubmit = async () => {
    if (!session || !fingerprint || isSubmitting) return

    // 验证是否所有组都已选择
    const groups = session.groups || []
    for (const group of groups) {
      const groupSelections = selections.get(group.id)
      if (!groupSelections || groupSelections.size === 0) {
        Taro.showToast({
          title: `请为"${group.groupName}"投票`,
          icon: 'none',
          duration: 2000
        })
        return
      }
    }

    // 构建提交数据（不需要姓名）
    const submission: VoteSubmission = {
      votingSessionId: sessionId!,
      voterName: '匿名', // 固定为匿名
      voterFingerprint: fingerprint,
      selections: Array.from(selections.entries()).map(([groupId, candidateIds]) => ({
        groupId,
        candidateIds: Array.from(candidateIds)
      }))
    }

    // 验证选择
    const validation = validateVoteSelections(groups, submission.selections)
    if (!validation.valid) {
      Taro.showToast({
        title: validation.error || '投票数据无效',
        icon: 'none',
        duration: 2000
      })
      return
    }

    const isUpdatingExistingVote = hasVoted

    // 提交或更新投票
    setIsSubmitting(true)
    Taro.showLoading({title: isUpdatingExistingVote ? '更新中...' : '提交中...'})

    try {
      const result = isUpdatingExistingVote
        ? await VotingDatabaseService.updateVote(submission)
        : await VotingDatabaseService.submitVote(submission)

      if (!result.success) {
        // 网络超时后重复提交时，服务端会返回该标识；视为已成功提交，避免用户被迫重投
        if (result.error === 'ALREADY_SUBMITTED') {
          setHasVoted(true)
          setIsEditing(false)
          Taro.showToast({
            title: '检测到你已提交过投票',
            icon: 'success',
            duration: 1600
          })
          setTimeout(() => {
            void safeRedirectTo(`/pages/vote-result/index?id=${sessionId}`)
          }, 1600)
          return
        }

        const maybeTransientError =
          !result.error || /timeout|network|fetch|request|failed|abort|offline|连接|超时|网络/i.test(result.error)
        if (!isUpdatingExistingVote && maybeTransientError && sessionId) {
          const votedAfterError = await VotingDatabaseService.hasVoted(sessionId, fingerprint)
          if (votedAfterError) {
            setHasVoted(true)
            setIsEditing(false)
            Taro.showToast({
              title: '已确认投票成功',
              icon: 'success',
              duration: 1600
            })
            setTimeout(() => {
              void safeRedirectTo(`/pages/vote-result/index?id=${sessionId}`)
            }, 1600)
            return
          }
        }

        Taro.showToast({
          title: result.error || '提交失败',
          icon: 'none',
          duration: 2000
        })
        return
      }

      // 提交成功
      setHasVoted(true)
      setIsEditing(false)
      Taro.showToast({
        title: isUpdatingExistingVote ? '投票已更新' : '投票成功',
        icon: 'success',
        duration: 2000
      })

      // 延迟跳转到结果页面
      setTimeout(() => {
        void safeRedirectTo(`/pages/vote-result/index?id=${sessionId}`)
      }, 2000)
    } finally {
      Taro.hideLoading()
      setIsSubmitting(false)
    }
  }

  // 查看结果
  const handleViewResult = () => {
    if (!sessionId) return
    void safeRedirectTo(`/pages/vote-result/index?id=${sessionId}`)
  }

  if (loading) {
    return (
      <View className="h-screen bg-gradient-page flex items-center justify-center">
        <Text className="text-muted-foreground">加载中...</Text>
      </View>
    )
  }

  if (!session) {
    return (
      <View className="h-screen bg-gradient-page flex items-center justify-center p-4">
        <View className="text-center">
          <View className="i-mdi-alert-circle text-6xl text-muted-foreground mb-4" />
          <Text className="text-foreground text-lg">投票不存在</Text>
        </View>
      </View>
    )
  }

  if (session.status === 'closed') {
    // 检查是否因为过期而关闭
    const isExpired = session.expiresAt && Date.now() > session.expiresAt

    return (
      <View className="h-screen bg-gradient-page flex items-center justify-center p-4">
        <View className="text-center">
          <View className="i-mdi-lock text-6xl text-muted-foreground mb-4" />
          <Text className="text-foreground text-lg mb-2">{isExpired ? '投票已过期' : '投票已关闭'}</Text>
          {isExpired && session.expiresAt && (
            <Text className="text-xs text-muted-foreground mb-4">
              过期时间：{new Date(session.expiresAt).toLocaleString('zh-CN')}
            </Text>
          )}
          <Button className="mt-4 ui-btn-primary px-5 break-keep" onClick={handleViewResult}>
            查看结果
          </Button>
        </View>
      </View>
    )
  }

  const groups = session.groups || []

  return (
    <View className="h-screen bg-gradient-page flex flex-col">
      {/* 头部 */}
      <View className="p-4 pt-8 bg-transparent border-b border-border flex-shrink-0">
        <View className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <View className="ui-row-wrap flex-1 min-w-0">
            <View
              className="ui-icon-btn"
              hoverClass="opacity-70"
              onClick={(e) => {
                e.stopPropagation()
                void safeSwitchTab('/pages/history/index')
              }}>
              <View className="i-mdi-arrow-left text-base text-foreground" />
            </View>
            <Text className="text-xl font-bold text-foreground flex-1 min-w-0 truncate">{session.title}</Text>
          </View>
          {meetingNo && (
            <View className="ui-pill shrink-0">
              <Text className="text-xs font-medium text-foreground">#{meetingNo}</Text>
            </View>
          )}
        </View>
        {session.description && <Text className="text-xs text-muted-foreground mt-1">{session.description}</Text>}

        {/* 过期时间提示 */}
        {session.expiresAt && session.status === 'active' && (
          <View className="mt-2 bg-muted/50 p-2 rounded-lg border border-border">
            <Text className="text-xs text-muted-foreground text-center">
              投票截止：{new Date(session.expiresAt).toLocaleString('zh-CN')}
            </Text>
          </View>
        )}

        {hasVoted && !isEditing && (
          <View className="mt-2 bg-green-600 p-2 rounded-lg border border-green-500/30">
            <Text className="text-xs text-white text-center">✓ 您已投票</Text>
          </View>
        )}
        {hasVoted && isEditing && (
          <View className="mt-2 bg-primary/15 p-2 rounded-lg border border-primary/30">
            <Text className="text-xs text-foreground text-center">正在修改投票...</Text>
          </View>
        )}
      </View>

      {/* 内容区 */}
      <ScrollView scrollY className="flex-1 min-h-0 p-4 pb-6" enableBackToTop>
        {/* 投票分组 */}
        {groups.map((group) => {
          const groupSelections = selections.get(group.id) || new Set()
          const candidates = group.candidates || []

          return (
            <View key={group.id} className="mb-4 ui-card">
              <View className="flex justify-between items-center flex-wrap gap-2 mb-3">
                <Text className="text-base font-bold text-foreground">{group.groupName}</Text>
                <Text className="text-xs text-muted-foreground">
                  {hasVoted && !isEditing ? '已投票' : `最多选 ${group.maxSelections} 个`}
                </Text>
              </View>

              <View className="space-y-2">
                {candidates.map((candidate) => {
                  const isSelected = groupSelections.has(candidate.id)

                  return (
                    <View
                      key={candidate.id}
                      className={`p-3 rounded-lg border-2 transition-all ${
                        isSelected
                          ? 'bg-primary/10 border-primary'
                          : 'bg-transparent border-border hover:border-primary/50'
                      } ${hasVoted && !isEditing ? 'opacity-60' : 'active:scale-98'}`}
                      onClick={() => toggleCandidate(group.id, candidate.id, group.maxSelections)}>
                      <View className="flex justify-between items-start">
                        <View className="flex-1 min-w-0">
                          <Text className="text-base font-medium text-foreground">{candidate.name}</Text>
                          {candidate.description && (
                            <Text className="text-xs text-muted-foreground mt-1">{candidate.description}</Text>
                          )}
                        </View>
                        <View
                          className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ml-3 shrink-0 ${
                            isSelected ? 'bg-primary border-primary' : 'border-border'
                          }`}>
                          {isSelected && <View className="i-mdi-check text-white text-sm" />}
                        </View>
                      </View>
                    </View>
                  )
                })}
              </View>
            </View>
          )
        })}
      </ScrollView>

      {/* 底部按钮 */}
      <View className="shrink-0 px-4 pt-2 pb-[max(env(safe-area-inset-bottom),12px)] bg-background border-t border-border">
        {hasVoted && !isEditing ? (
          <View className="flex gap-2">
            <Button
              className="flex-1 min-w-0 ui-btn-secondary h-11 text-sm break-keep"
              disabled={isSubmitting}
              onClick={() => setIsEditing(true)}>
              修改投票
            </Button>
            <Button className="flex-1 min-w-0 ui-btn-primary h-11 text-sm break-keep" onClick={handleViewResult}>
              查看结果
            </Button>
          </View>
        ) : (
          <Button
            className="w-full ui-btn-primary h-11 text-sm break-keep"
            disabled={isSubmitting}
            onClick={handleSubmit}>
            {isSubmitting ? '提交中...' : hasVoted ? '保存修改' : '提交投票'}
          </Button>
        )}
      </View>
    </View>
  )
}
