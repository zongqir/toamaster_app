import {Button, Input, ScrollView, Text, View} from '@tarojs/components'
import Taro, {useDidShow} from '@tarojs/taro'
import {useCallback, useEffect, useRef, useState} from 'react'
import {VotingDatabaseService} from '../../db/votingDatabase'
import {groupCandidatesFromMeeting} from '../../services/votingService'
import {useMeetingStore} from '../../store/meetingStore'
import type {VotingCandidate, VotingGroup, VotingSession} from '../../types/voting'
import {generateId} from '../../utils/id'

const supabaseUrl = process.env.TARO_APP_SUPABASE_URL
const supabaseAnonKey = process.env.TARO_APP_SUPABASE_ANON_KEY
const votingPollIntervalMs = 2000
const maxVotingStatusFailures = 3

type VotingGroupJobResult = {
  groups?: VotingGroup[]
  error?: string
}

type VotingGroupJobResponse = {
  jobId: string
  status: 'queued' | 'processing' | 'succeeded' | 'failed'
  result?: VotingGroupJobResult
  errorMessage?: string
}

function normalizeRequestError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  return message
}

function isFunctionNotFoundError(error: unknown) {
  const message = normalizeRequestError(error)
  return (
    message.includes('NOT_FOUND') || message.includes('Requested function was not found') || message.includes('404')
  )
}

async function invokePublicEdgeFunction<T>(functionName: string, body: Record<string, unknown>): Promise<T> {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('缺少 Supabase 配置')
  }

  const response = await Taro.request({
    url: `${supabaseUrl}/functions/v1/${functionName}`,
    method: 'POST',
    timeout: 300000,
    header: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`
    },
    data: body
  })

  const payload =
    typeof response.data === 'string'
      ? (() => {
          try {
            return JSON.parse(response.data)
          } catch {
            return response.data
          }
        })()
      : response.data

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errorText = typeof payload === 'string' ? payload : JSON.stringify(payload)
    throw new Error(errorText)
  }

  return payload as T
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default function VoteEditPage() {
  const {currentSession, setCurrentSession} = useMeetingStore()

  const [groups, setGroups] = useState<VotingGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [aiGenerating, setAiGenerating] = useState(false)
  const [aiStatusText, setAiStatusText] = useState('')
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingCandidateId, setEditingCandidateId] = useState<string | null>(null)
  const isPageActiveRef = useRef(true)

  useEffect(() => {
    return () => {
      isPageActiveRef.current = false
    }
  }, [])

  const setGeneratingStatus = useCallback((message: string) => {
    if (!isPageActiveRef.current) return
    setAiStatusText(message)
  }, [])

  const mergeAIGroups = useCallback(
    (aiGroups: VotingGroup[]) => {
      if (!currentSession) {
        return aiGroups
      }

      const localGroups = groupCandidatesFromMeeting(currentSession)
      const localImpromptuGroup = localGroups.find((group) => group.groupType === 'tableTopics') || null

      if (!localImpromptuGroup) {
        return aiGroups
      }

      return [...aiGroups.filter((group) => group.groupType !== 'tableTopics'), localImpromptuGroup].sort(
        (a, b) => a.orderIndex - b.orderIndex
      )
    },
    [currentSession]
  )

  const applyLocalFallback = useCallback(
    (toastTitle: string) => {
      if (!currentSession || !isPageActiveRef.current) return false

      const fallbackGroups = groupCandidatesFromMeeting(currentSession)
      if (fallbackGroups.length > 0) {
        setGroups(fallbackGroups)
        Taro.showToast({
          title: toastTitle,
          icon: 'none',
          duration: 3000
        })
        return true
      }

      return false
    },
    [currentSession]
  )

  const waitForVotingGroupResult = useCallback(
    async (jobId: string): Promise<VotingGroup[]> => {
      let failureCount = 0

      while (isPageActiveRef.current) {
        let job: VotingGroupJobResponse

        try {
          job = await invokePublicEdgeFunction<VotingGroupJobResponse>('get-voting-group-job', {jobId})
          failureCount = 0
        } catch (error) {
          failureCount += 1
          if (failureCount >= maxVotingStatusFailures) {
            throw error instanceof Error ? error : new Error('状态查询失败，请重试')
          }

          setGeneratingStatus('状态同步中...')
          await sleep(votingPollIntervalMs)
          continue
        }

        if (job.status === 'queued') {
          setGeneratingStatus('排队中...')
          await sleep(votingPollIntervalMs)
          continue
        }

        if (job.status === 'processing') {
          setGeneratingStatus('智能分组中...')
          await sleep(votingPollIntervalMs)
          continue
        }

        if (job.status === 'failed') {
          throw new Error(job.errorMessage || '智能分组任务失败')
        }

        if (job.status === 'succeeded') {
          const generatedGroups = job.result?.groups
          if (!generatedGroups || !Array.isArray(generatedGroups)) {
            throw new Error('智能分组任务已完成，但结果为空')
          }
          return generatedGroups
        }

        throw new Error('未知的投票分组任务状态')
      }

      throw new Error('页面已离开，停止等待智能分组结果')
    },
    [setGeneratingStatus]
  )

  const generateGroupsWithLegacyAI = useCallback(async () => {
    if (!currentSession) {
      throw new Error('没有当前会议数据')
    }

    const response = await invokePublicEdgeFunction<VotingGroupJobResult>('ai-voting-groups', {
      meetingSession: currentSession
    })

    const generatedGroups = response.groups
    if (!generatedGroups || !Array.isArray(generatedGroups)) {
      throw new Error(response.error || '智能分组结果格式错误')
    }

    return generatedGroups
  }, [currentSession])

  // 调用 AI 生成分组
  const generateGroupsWithAI = useCallback(async () => {
    if (aiGenerating) {
      return
    }

    if (!currentSession) {
      console.error('没有当前会议')
      Taro.showToast({
        title: '没有当前会议数据',
        icon: 'none'
      })
      return
    }

    setAiGenerating(true)
    setGeneratingStatus('提交中...')

    try {
      let aiGroups: VotingGroup[]

      try {
        const submitResult = await invokePublicEdgeFunction<VotingGroupJobResponse>('submit-voting-group-job', {
          meetingSession: currentSession
        })

        aiGroups = await waitForVotingGroupResult(submitResult.jobId)
      } catch (error) {
        if (!isFunctionNotFoundError(error)) {
          throw error
        }

        setGeneratingStatus('兼容旧版分组服务...')
        aiGroups = await generateGroupsWithLegacyAI()
      }

      const mergedGroups = mergeAIGroups(aiGroups)

      if (!isPageActiveRef.current) {
        return
      }

      setGroups(mergedGroups)
      setAiStatusText('')
      Taro.showToast({
        title: `智能分组完成，共 ${mergedGroups.length} 组`,
        icon: 'success'
      })
    } catch (error) {
      console.error('调用智能分组失败:', error)
      if (isPageActiveRef.current) {
        setAiStatusText('')
      }
      const hasFallback = applyLocalFallback('智能分组失败，已切换本地分组')
      if (!hasFallback && isPageActiveRef.current) {
        Taro.showToast({
          title: error instanceof Error ? error.message : '智能分组失败',
          icon: 'none',
          duration: 3000
        })
      }
    } finally {
      if (isPageActiveRef.current) {
        setAiGenerating(false)
        setAiStatusText('')
      }
    }
  }, [
    aiGenerating,
    applyLocalFallback,
    currentSession,
    generateGroupsWithLegacyAI,
    mergeAIGroups,
    setGeneratingStatus,
    waitForVotingGroupResult
  ])

  useDidShow(() => {
    setLoading(false)
    // 自动调用 AI 生成分组
    if (groups.length === 0 && !aiGenerating) {
      void generateGroupsWithAI()
    }
  })

  // 新增分组
  const handleAddGroup = () => {
    const newGroup: VotingGroup = {
      id: generateId('group'),
      votingSessionId: '',
      groupName: '新分组',
      groupType: 'others',
      maxSelections: 1,
      orderIndex: groups.length,
      candidates: []
    }
    setGroups([...groups, newGroup])
  }

  // 删除分组
  const handleDeleteGroup = (groupId: string) => {
    Taro.showModal({
      title: '确认删除',
      content: '确定要删除这个分组吗？',
      success: (res) => {
        if (res.confirm) {
          setGroups(groups.filter((g) => g.id !== groupId))
        }
      }
    })
  }

  // 更新分组
  const handleUpdateGroup = (groupId: string, updates: Partial<VotingGroup>) => {
    setGroups(groups.map((g) => (g.id === groupId ? {...g, ...updates} : g)))
  }

  // 新增候选人
  const handleAddCandidate = (groupId: string) => {
    const newCandidate: VotingCandidate = {
      id: generateId('candidate'),
      votingGroupId: groupId,
      name: '新候选人',
      description: '',
      orderIndex: groups.find((g) => g.id === groupId)?.candidates?.length || 0
    }

    setGroups(
      groups.map((g) => {
        if (g.id === groupId) {
          return {
            ...g,
            candidates: [...(g.candidates || []), newCandidate]
          }
        }
        return g
      })
    )
  }

  // 删除候选人
  const handleDeleteCandidate = (groupId: string, candidateId: string) => {
    setGroups(
      groups.map((g) => {
        if (g.id === groupId) {
          return {
            ...g,
            candidates: g.candidates?.filter((c) => c.id !== candidateId)
          }
        }
        return g
      })
    )
  }

  // 更新候选人
  const handleUpdateCandidate = (groupId: string, candidateId: string, updates: Partial<VotingCandidate>) => {
    setGroups(
      groups.map((g) => {
        if (g.id === groupId) {
          return {
            ...g,
            candidates: g.candidates?.map((c) => (c.id === candidateId ? {...c, ...updates} : c))
          }
        }
        return g
      })
    )
  }

  // 保存并创建投票
  const handleSave = async () => {
    if (!currentSession) return

    // 验证
    if (groups.length === 0) {
      Taro.showToast({
        title: '请至少添加一个分组',
        icon: 'none'
      })
      return
    }

    for (const group of groups) {
      if (!group.candidates || group.candidates.length === 0) {
        Taro.showToast({
          title: `分组"${group.groupName}"没有候选人`,
          icon: 'none'
        })
        return
      }
    }

    try {
      Taro.showLoading({title: '创建投票中...'})

      // 使用会议 ID 作为投票会话 ID，确保一个会议只有一个投票
      const voteId = currentSession.id
      const now = Date.now()
      const expiresAt = now + 24 * 60 * 60 * 1000

      // 创建投票会话
      const votingSession: VotingSession = {
        id: voteId,
        meetingId: currentSession.id,
        title: `${currentSession.metadata.theme || '会议'} - 投票`,
        description: `${currentSession.metadata.date || ''} ${currentSession.metadata.clubName || ''}`,
        status: 'active',
        createdAt: now,
        expiresAt: expiresAt,
        createdBy: 'anonymous'
      }

      // 使用会议 ID 作为前缀生成固定的分组和候选人 ID
      const groupsWithNewIds = groups.map((group, groupIndex) => {
        const newGroupId = `${voteId}_group_${groupIndex}`
        return {
          ...group,
          id: newGroupId,
          votingSessionId: voteId,
          candidates: group.candidates?.map((candidate, candidateIndex) => ({
            ...candidate,
            id: `${voteId}_candidate_${groupIndex}_${candidateIndex}`,
            votingGroupId: newGroupId
          }))
        }
      })

      // 保存到数据库
      const result = await VotingDatabaseService.createVotingSession(votingSession, groupsWithNewIds)

      Taro.hideLoading()

      if (!result.success) {
        Taro.showToast({
          title: result.error || '创建投票失败',
          icon: 'none'
        })
        return
      }

      // 更新会议的 metadata，添加 votingId
      if (currentSession) {
        const updatedSession = {
          ...currentSession,
          metadata: {
            ...currentSession.metadata,
            votingId: voteId
          }
        }
        // 保存到本地存储
        const sessions = Taro.getStorageSync('meeting_sessions') || []
        const sessionIndex = sessions.findIndex((s: any) => s.id === currentSession.id)
        if (sessionIndex !== -1) {
          sessions[sessionIndex] = updatedSession
          Taro.setStorageSync('meeting_sessions', sessions)
          console.log('已更新会议 metadata，添加 votingId:', voteId)
        }
        // 更新 Zustand store
        setCurrentSession(updatedSession)
        console.log('已更新 currentSession store')
      }

      // 显示投票 ID
      Taro.showModal({
        title: '投票创建成功',
        content: `投票ID: ${voteId}\n\n投票已创建，有效期 24 小时。参与者可在"投票入口"页面直接进入投票。`,
        confirmText: '返回',
        success: () => {
          Taro.navigateBack()
        }
      })
    } catch (error) {
      Taro.hideLoading()
      console.error('创建投票失败:', error)
      Taro.showToast({
        title: '创建投票失败',
        icon: 'none'
      })
    }
  }

  if (loading) {
    return (
      <View className="h-screen bg-gradient-page flex items-center justify-center">
        <Text className="text-muted-foreground">加载中...</Text>
      </View>
    )
  }

  return (
    <View className="h-screen bg-gradient-page flex flex-col">
      {/* 头部 */}
      <View className="p-4 pt-8 bg-transparent border-b border-border flex-shrink-0">
        <View className="flex justify-between items-center flex-wrap gap-2">
          <Text className="text-xl font-bold text-foreground">编辑投票分组</Text>
          <View className="ui-actions-wrap">
            <View className="ui-btn-secondary w-10 h-10 p-0 rounded-lg" onClick={() => Taro.navigateBack()}>
              <View className="i-mdi-close text-sm text-foreground" />
            </View>
          </View>
        </View>
        {aiGenerating && (
          <View className="mt-2 bg-primary/15 p-2 rounded-lg border border-primary/30">
            <Text className="text-xs text-foreground text-center">{aiStatusText || '智能分组中...'}</Text>
          </View>
        )}
      </View>

      {/* 内容区 */}
      <ScrollView scrollY className="flex-1 min-h-0 p-4 pb-6" enableBackToTop>
        {groups.length === 0 && !aiGenerating && (
          <View className="text-center py-10">
            <View className="i-mdi-vote-outline text-6xl text-muted-foreground mb-4" />
            <Text className="text-muted-foreground">暂无分组</Text>
          </View>
        )}

        {groups.map((group) => (
          <View key={group.id} className="mb-4 ui-card">
            {/* 分组头部 */}
            <View className="flex justify-between items-center flex-wrap gap-2 mb-3">
              <View className="flex-1 mr-2">
                {editingGroupId === group.id ? (
                  <View className="bg-transparent rounded-lg border border-border px-3 py-2">
                    <Input
                      className="w-full text-foreground"
                      value={group.groupName}
                      onInput={(e) => handleUpdateGroup(group.id, {groupName: e.detail.value})}
                      onBlur={() => setEditingGroupId(null)}
                      focus
                    />
                  </View>
                ) : (
                  <Text className="text-base font-bold text-foreground" onClick={() => setEditingGroupId(group.id)}>
                    {group.groupName}
                  </Text>
                )}
              </View>
              <View className="flex items-center flex-wrap gap-2">
                <View
                  className="ui-btn-secondary w-10 h-10 p-0 rounded-lg"
                  onClick={() => handleAddCandidate(group.id)}>
                  <View className="i-mdi-plus text-sm text-foreground" />
                </View>
                <View className="ui-btn-danger w-10 h-10 p-0 rounded-lg" onClick={() => handleDeleteGroup(group.id)}>
                  <View className="i-mdi-delete text-sm text-white" />
                </View>
              </View>
            </View>

            {/* 最大可选数 */}
            <View className="mb-3 flex items-center flex-wrap gap-2">
              <Text className="text-xs text-muted-foreground">最多可选：</Text>
              <View className="flex flex-wrap gap-1">
                {[1, 2, 3].map((num) => (
                  <View
                    key={num}
                    className={`px-3 py-1 rounded-lg border ${
                      group.maxSelections === num
                        ? 'bg-primary border-primary/70 text-white'
                        : 'bg-secondary/20 border-border/50 text-foreground'
                    }`}
                    onClick={() => handleUpdateGroup(group.id, {maxSelections: num})}>
                    <Text className={`text-xs ${group.maxSelections === num ? 'text-white' : 'text-foreground'}`}>
                      {num}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {/* 候选人列表 */}
            <View className="space-y-2">
              {group.candidates?.map((candidate) => (
                <View key={candidate.id} className="p-3 bg-transparent rounded-lg border border-border">
                  <View className="flex justify-between items-start">
                    <View className="flex-1 mr-2">
                      {editingCandidateId === candidate.id ? (
                        <View className="space-y-2">
                          <View className="bg-transparent rounded-lg border border-border px-3 py-2">
                            <Input
                              className="w-full text-foreground"
                              value={candidate.name}
                              onInput={(e) => handleUpdateCandidate(group.id, candidate.id, {name: e.detail.value})}
                              placeholder="姓名"
                            />
                          </View>
                          <View className="bg-transparent rounded-lg border border-border px-3 py-2">
                            <Input
                              className="w-full text-foreground"
                              value={candidate.description || ''}
                              onInput={(e) =>
                                handleUpdateCandidate(group.id, candidate.id, {description: e.detail.value})
                              }
                              placeholder="描述（可选）"
                              onBlur={() => setEditingCandidateId(null)}
                            />
                          </View>
                        </View>
                      ) : (
                        <View onClick={() => setEditingCandidateId(candidate.id)}>
                          <Text className="text-base font-medium text-foreground">{candidate.name}</Text>
                          {candidate.description && (
                            <Text className="text-xs text-muted-foreground mt-1">{candidate.description}</Text>
                          )}
                        </View>
                      )}
                    </View>
                    <View
                      className="p-2 bg-destructive rounded-lg active:bg-destructive/80"
                      onClick={() => handleDeleteCandidate(group.id, candidate.id)}>
                      <View className="i-mdi-close text-sm text-white" />
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ))}

        {/* 新增分组按钮 */}
        <View
          className="mb-4 p-4 bg-transparent rounded-xl border-2 border-dashed border-border active:bg-white/5"
          onClick={handleAddGroup}>
          <View className="flex items-center justify-center gap-2">
            <View className="i-mdi-plus text-foreground text-lg" />
            <Text className="text-foreground font-medium">新增分组</Text>
          </View>
        </View>
      </ScrollView>

      {/* 底部按钮 */}
      <View className="shrink-0 p-4 pb-[max(env(safe-area-inset-bottom),12px)] bg-gradient-to-t from-background via-background/95 to-transparent border-t border-border">
        <View className="flex gap-2">
          <Button
            className="flex-1 min-w-0 ui-btn-secondary h-11 break-keep text-sm"
            disabled={aiGenerating}
            onClick={() => void generateGroupsWithAI()}>
            {aiGenerating ? '智能分组中...' : '重新智能分组'}
          </Button>
          <Button className="flex-1 min-w-0 ui-btn-primary h-11 break-keep text-sm" onClick={handleSave}>
            保存并创建投票
          </Button>
        </View>
      </View>
    </View>
  )
}
