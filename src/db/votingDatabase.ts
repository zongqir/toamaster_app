import {supabase} from '../client/supabase'
import type {VoteSubmission, VotingGroup, VotingResult, VotingSession} from '../types/voting'
import {generateId} from '../utils/id'

const UNIQUE_VIOLATION_CODE = '23505'

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const maybeError = error as {code?: string; message?: string}
  return (
    maybeError.code === UNIQUE_VIOLATION_CODE ||
    (typeof maybeError.message === 'string' && maybeError.message.toLowerCase().includes('duplicate key'))
  )
}

function normalizeSelections(selections: VoteSubmission['selections']): VoteSubmission['selections'] {
  const groupMap = new Map<string, Set<string>>()

  selections.forEach((selection) => {
    if (!groupMap.has(selection.groupId)) {
      groupMap.set(selection.groupId, new Set())
    }

    selection.candidateIds.forEach((candidateId) => {
      groupMap.get(selection.groupId)?.add(candidateId)
    })
  })

  return Array.from(groupMap.entries()).map(([groupId, candidateSet]) => ({
    groupId,
    candidateIds: Array.from(candidateSet)
  }))
}

function getVoterIdentityKey(userId: string): string {
  return `wxuser_${userId.replace(/-/g, '')}`
}

function buildVoteIdentityFilter(userId: string): string {
  return `voter_user_id.eq.${userId},voter_fingerprint.eq.${getVoterIdentityKey(userId)}`
}

function mapAtomicVoteError(error?: string): string {
  switch (error) {
    case 'ALREADY_SUBMITTED':
      return 'ALREADY_SUBMITTED'
    case 'VOTING_SESSION_NOT_FOUND':
      return '投票不存在'
    case 'VOTING_SESSION_CLOSED':
      return '投票已关闭'
    case 'AUTH_REQUIRED_FOR_TRACE_MODE':
      return '当前投票需要登录后参与'
    case 'EMPTY_SELECTIONS':
      return '请至少选择一位候选人'
    case 'INVALID_VOTING_GROUP':
      return '投票分组无效，请刷新后重试'
    case 'INVALID_CANDIDATE_GROUP_RELATION':
      return '候选人数据已变更，请刷新后重试'
    case 'MAX_SELECTIONS_EXCEEDED':
      return '所选候选人数超过分组上限，请重新选择'
    case 'DUPLICATE_CANDIDATE_SELECTION':
      return '存在重复候选人，请重新选择'
    default:
      return error || '投票提交失败'
  }
}

async function executeAtomicVoteSubmission(
  session: VotingSession,
  submission: VoteSubmission,
  allowReplace: boolean
): Promise<{success: boolean; error?: string}> {
  const normalizedSelections = normalizeSelections(submission.selections)
  const hasAnySelection = normalizedSelections.some((selection) => selection.candidateIds.length > 0)
  if (!hasAnySelection) {
    return {success: false, error: '请至少选择一位候选人'}
  }

  const voterIdentityKey = getVoterIdentityKey(submission.voterUserId)
  const votesData: Array<{
    id: string
    voting_group_id: string
    candidate_id: string
    voter_name_snapshot: string
    created_at: number
  }> = []

  normalizedSelections.forEach((selection) => {
    selection.candidateIds.forEach((candidateId) => {
      votesData.push({
        id: generateId('vote'),
        voting_group_id: selection.groupId,
        candidate_id: candidateId,
        voter_name_snapshot: submission.voterNameSnapshot || '微信用户',
        created_at: Date.now()
      })
    })
  })

  const {data, error} = await supabase.rpc('persist_vote_atomic', {
    p_voting_session_id: submission.votingSessionId,
    p_voter_fingerprint: voterIdentityKey,
    p_meeting_id: session.meetingId,
    p_votes: votesData,
    p_allow_replace: allowReplace
  })

  if (error) {
    console.error('原子投票提交失败:', error)
    if (isUniqueViolation(error)) {
      return {success: false, error: allowReplace ? '投票修改冲突，请稍后重试' : 'ALREADY_SUBMITTED'}
    }
    return {success: false, error: error.message}
  }

  if (data && !data.success) {
    console.error('原子投票提交失败:', data.error)
    if (typeof data.error === 'string' && data.error.toLowerCase().includes('duplicate key')) {
      return {success: false, error: allowReplace ? '投票修改冲突，请稍后重试' : 'ALREADY_SUBMITTED'}
    }
    return {success: false, error: mapAtomicVoteError(data.error)}
  }

  return {success: true}
}

/**
 * 投票数据库服务
 */
export const VotingDatabaseService = {
  /**
   * 关闭所有活跃的投票
   */
  async closeAllActiveVotings(): Promise<{success: boolean; error?: string}> {
    try {
      const {error} = await supabase.from('voting_sessions').update({status: 'closed'}).eq('status', 'active')

      if (error) {
        console.error('关闭活跃投票失败:', error)
        return {success: false, error: error.message}
      }

      return {success: true}
    } catch (error) {
      console.error('关闭活跃投票异常:', error)
      return {success: false, error: error instanceof Error ? error.message : 'Unknown error'}
    }
  },

  /**
   * 关闭投票会话
   */
  async closeVotingSession(sessionId: string): Promise<{success: boolean; error?: string}> {
    try {
      console.log('关闭投票会话:', sessionId)

      const {error} = await supabase.from('voting_sessions').update({status: 'closed'}).eq('id', sessionId)

      if (error) {
        console.error('关闭投票会话失败:', error)
        return {success: false, error: error.message}
      }

      console.log('投票会话关闭成功')
      return {success: true}
    } catch (error) {
      console.error('关闭投票会话异常:', error)
      return {success: false, error: error instanceof Error ? error.message : 'Unknown error'}
    }
  },

  /**
   * 删除投票会话及其所有相关数据
   */
  async deleteVotingSession(sessionId: string): Promise<{success: boolean; error?: string}> {
    try {
      console.log('开始删除投票会话:', sessionId)

      // 由于设置了 ON DELETE CASCADE，删除 voting_sessions 会自动删除相关的：
      // - voting_groups
      // - voting_candidates
      // - votes
      const {error} = await supabase.from('voting_sessions').delete().eq('id', sessionId)

      if (error) {
        console.error('删除投票会话失败:', error)
        return {success: false, error: error.message}
      }

      console.log('投票会话删除成功')
      return {success: true}
    } catch (error) {
      console.error('删除投票会话异常:', error)
      return {success: false, error: error instanceof Error ? error.message : 'Unknown error'}
    }
  },

  /**
   * 获取当前活跃的投票
   */
  async getActiveVoting(): Promise<VotingSession | null> {
    try {
      // 1. 获取活跃的投票会话
      const {data: sessions, error: sessionError} = await supabase
        .from('voting_sessions')
        .select('*')
        .eq('status', 'active')
        .order('created_at', {ascending: false})
        .limit(1)

      if (sessionError) {
        console.error('获取活跃投票失败:', sessionError)
        return null
      }

      if (!sessions || sessions.length === 0) {
        return null
      }

      const session = sessions[0]

      // 2. 检查是否过期（24小时）
      const now = Date.now()
      if (session.expires_at && now > session.expires_at) {
        // 过期，自动关闭
        await supabase.from('voting_sessions').update({status: 'closed'}).eq('id', session.id)
        return null
      }

      // 3. 获取完整的投票信息
      return await this.getVotingSession(session.id)
    } catch (error) {
      console.error('获取活跃投票异常:', error)
      return null
    }
  },

  /**
   * 创建投票会话
   */
  async createVotingSession(
    session: VotingSession,
    groups: VotingGroup[]
  ): Promise<{success: boolean; error?: string}> {
    try {
      console.log('创建投票会话，ID:', session.id)

      // 0. 检查是否已存在该投票会话
      const {data: relatedSessions, error: relatedSessionsError} = await supabase
        .from('voting_sessions')
        .select('id')
        .or(`id.eq.${session.id},meeting_id.eq.${session.meetingId}`)

      if (relatedSessionsError) {
        console.error('查找冲突投票会话失败:', relatedSessionsError)
        return {success: false, error: relatedSessionsError.message}
      }

      const sessionIdsToDelete = Array.from(new Set((relatedSessions || []).map((item) => item.id)))
      for (const oldSessionId of sessionIdsToDelete) {
        const {error: deleteOldSessionError} = await supabase.from('voting_sessions').delete().eq('id', oldSessionId)

        if (deleteOldSessionError) {
          console.error('删除旧投票会话失败:', deleteOldSessionError)
          return {success: false, error: deleteOldSessionError.message}
        }
      }

      const sessionPayload = {
        id: session.id,
        meeting_id: session.meetingId,
        title: session.title,
        description: session.description || null,
        status: session.status,
        vote_trace_mode: session.voteTraceMode || 'anonymous',
        created_at: session.createdAt,
        expires_at: session.expiresAt || null,
        created_by: session.createdBy || null
      }

      // 1. 创建投票会话
      let {error: sessionError} = await supabase.from('voting_sessions').insert(sessionPayload)

      if (sessionError && isUniqueViolation(sessionError)) {
        const {error: deleteByMeetingError} = await supabase
          .from('voting_sessions')
          .delete()
          .eq('meeting_id', session.meetingId)

        if (deleteByMeetingError) {
          console.error('冲突后清理旧会话失败:', deleteByMeetingError)
          return {success: false, error: deleteByMeetingError.message}
        }

        const retry = await supabase.from('voting_sessions').insert(sessionPayload)
        sessionError = retry.error
      }

      if (sessionError) {
        console.error('创建投票会话失败:', sessionError)
        return {success: false, error: sessionError.message}
      }

      const groupsData = groups.map((group) => ({
        id: group.id,
        voting_session_id: session.id,
        meeting_id: session.meetingId, // 添加 meeting_id
        group_name: group.groupName,
        group_type: group.groupType,
        max_selections: group.maxSelections,
        order_index: group.orderIndex
      }))

      const {error: groupsError} = await supabase.from('voting_groups').insert(groupsData)

      if (groupsError) {
        console.error('创建投票分组失败:', groupsError)
        return {success: false, error: groupsError.message}
      }

      // 3. 创建候选人
      const candidatesData: any[] = []
      groups.forEach((group) => {
        group.candidates?.forEach((candidate) => {
          candidatesData.push({
            id: candidate.id,
            voting_group_id: group.id,
            meeting_id: session.meetingId, // 添加 meeting_id
            name: candidate.name,
            item_id: candidate.itemId || null,
            description: candidate.description || null,
            order_index: candidate.orderIndex
          })
        })
      })

      if (candidatesData.length > 0) {
        const {error: candidatesError} = await supabase.from('voting_candidates').insert(candidatesData)

        if (candidatesError) {
          console.error('创建候选人失败:', candidatesError)
          return {success: false, error: candidatesError.message}
        }
      }

      console.log('投票会话创建成功')
      return {success: true}
    } catch (error) {
      console.error('创建投票会话异常:', error)
      return {success: false, error: error instanceof Error ? error.message : 'Unknown error'}
    }
  },

  /**
   * 获取投票会话详情
   */
  async getVotingSession(sessionId: string): Promise<VotingSession | null> {
    try {
      console.log('getVotingSession - 开始查询，sessionId:', sessionId)

      // 1. 获取会话信息
      const {data: session, error: sessionError} = await supabase
        .from('voting_sessions')
        .select('*')
        .eq('id', sessionId)
        .single()

      if (sessionError || !session) {
        console.error('获取投票会话失败:', sessionError)
        return null
      }
      console.log('getVotingSession - 会话信息:', session)

      // 检查投票是否过期
      if (session.expires_at && Date.now() > session.expires_at) {
        console.log('投票已过期，自动关闭')
        // 自动关闭过期的投票
        await this.closeVotingSession(sessionId)
        session.status = 'closed'
      }

      // 2. 获取分组
      const {data: groups, error: groupsError} = await supabase
        .from('voting_groups')
        .select('*')
        .eq('voting_session_id', sessionId)
        .order('order_index', {ascending: true})

      if (groupsError) {
        console.error('获取投票分组失败:', groupsError)
        return null
      }
      console.log('getVotingSession - 分组数量:', groups?.length || 0)

      // 3. 获取候选人
      const groupIds = groups?.map((g) => g.id) || []
      console.log('getVotingSession - 分组IDs:', groupIds)

      const {data: candidates, error: candidatesError} = await supabase
        .from('voting_candidates')
        .select('*')
        .in('voting_group_id', groupIds)
        .order('order_index', {ascending: true})

      if (candidatesError) {
        console.error('获取候选人失败:', candidatesError)
      }
      console.log('getVotingSession - 候选人数量:', candidates?.length || 0)

      // 4. 组装数据
      const votingGroups: VotingGroup[] =
        groups?.map((group) => ({
          id: group.id,
          votingSessionId: group.voting_session_id,
          groupName: group.group_name,
          groupType: group.group_type,
          maxSelections: group.max_selections,
          orderIndex: group.order_index,
          candidates: candidates
            ?.filter((c) => c.voting_group_id === group.id)
            .map((c) => ({
              id: c.id,
              votingGroupId: c.voting_group_id,
              name: c.name,
              itemId: c.item_id || undefined,
              description: c.description || undefined,
              orderIndex: c.order_index
            }))
        })) || []

      console.log('getVotingSession - 组装后的分组数量:', votingGroups.length)
      console.log('getVotingSession - 第一个分组的候选人数量:', votingGroups[0]?.candidates?.length || 0)

      const result = {
        id: session.id,
        meetingId: session.meeting_id,
        title: session.title,
        description: session.description || undefined,
        status: session.status,
        voteTraceMode: session.vote_trace_mode || 'anonymous',
        createdAt: session.created_at,
        expiresAt: session.expires_at || undefined,
        createdBy: session.created_by || undefined,
        groups: votingGroups
      }

      console.log('getVotingSession - 返回结果:', result)
      return result
    } catch (error) {
      console.error('获取投票会话异常:', error)
      return null
    }
  },

  /**
   * 提交投票（不需要姓名）
   */
  async submitVote(submission: VoteSubmission): Promise<{success: boolean; error?: string}> {
    try {
      // 1. 检查投票是否过期
      const session = await this.getVotingSession(submission.votingSessionId)
      if (!session) {
        return {success: false, error: '投票不存在'}
      }

      if (session.status === 'closed') {
        return {success: false, error: '投票已关闭'}
      }

      if (session.expiresAt && Date.now() > session.expiresAt) {
        // 过期，自动关闭
        await supabase.from('voting_sessions').update({status: 'closed'}).eq('id', submission.votingSessionId)
        return {success: false, error: '投票已过期'}
      }

      return await executeAtomicVoteSubmission(session, submission, false)
    } catch (error) {
      console.error('提交投票异常:', error)
      return {success: false, error: error instanceof Error ? error.message : 'Unknown error'}
    }
  },

  /**
   * 获取投票结果（基于 meeting_id 查询）
   */
  async getVotingResult(sessionId: string): Promise<VotingResult | null> {
    try {
      // 1. 获取投票会话
      const session = await this.getVotingSession(sessionId)
      if (!session || !session.groups) return null

      // 2. 基于 meeting_id 获取所有投票记录
      const {data: votes, error: votesError} = await supabase
        .from('votes')
        .select('*')
        .eq('meeting_id', session.meetingId)

      if (votesError) {
        console.error('获取投票记录失败:', votesError)
        return null
      }

      // 3. 统计结果（按分组统计）
      const groupResults = session.groups.map((group) => {
        const groupVotes = votes?.filter((v) => v.voting_group_id === group.id) || []

        const candidateResults =
          group.candidates?.map((candidate) => {
            const candidateVotes = groupVotes.filter((v) => v.candidate_id === candidate.id)
            return {
              candidate,
              voteCount: candidateVotes.length,
              voters: candidateVotes.map((v) => v.voter_name_snapshot || v.voter_name)
            }
          }) || []

        // 按得票数降序排序
        candidateResults.sort((a, b) => b.voteCount - a.voteCount)

        return {
          group,
          candidates: candidateResults,
          totalVotes: groupVotes.length
        }
      })

      // 4. 统计总投票人数
      const voterSet = new Set(
        votes?.map((v) => v.voter_user_id || v.voter_fingerprint_hash || v.voter_fingerprint).filter(Boolean) || []
      )
      const voterNames = Array.from(
        new Set(votes?.map((v) => v.voter_name_snapshot || v.voter_name).filter(Boolean) || [])
      )

      return {
        session,
        groups: groupResults,
        totalVoters: voterSet.size,
        voterNames
      }
    } catch (error) {
      console.error('获取投票结果异常:', error)
      return null
    }
  },

  /**
   * 通过会议ID获取投票结果
   * 现在投票会话 ID 就是会议 ID，直接查询即可
   */
  async getVotingResultByMeetingId(meetingId: string): Promise<VotingResult | null> {
    try {
      console.log('通过会议ID查找投票结果:', meetingId)

      // 先查找该会议的投票会话
      const {data: session, error: sessionError} = await supabase
        .from('voting_sessions')
        .select('*')
        .eq('meeting_id', meetingId)
        .single()

      if (sessionError || !session) {
        console.log('该会议没有投票会话')
        return null
      }

      // 检查投票是否过期
      if (session.expires_at && Date.now() > session.expires_at) {
        console.log('投票已过期，自动关闭')
        await this.closeVotingSession(session.id)
      }

      // 获取投票结果
      return await this.getVotingResult(session.id)
    } catch (error) {
      console.error('通过会议ID获取投票结果异常:', error)
      return null
    }
  },

  /**
   * 检查用户是否已投票
   */
  async hasVoted(sessionId: string, userId: string): Promise<boolean> {
    try {
      console.log('检查投票状态 - sessionId:', sessionId, 'userId:', userId)

      const {data, error} = await supabase
        .from('votes')
        .select('id')
        .eq('voting_session_id', sessionId)
        .or(buildVoteIdentityFilter(userId))
        .limit(1)

      if (error) {
        console.error('检查投票状态失败:', error)
        return false
      }

      console.log('查询到的投票记录数:', data?.length || 0)
      const hasVoted = (data?.length || 0) > 0
      console.log('hasVoted 结果:', hasVoted)

      return hasVoted
    } catch (error) {
      console.error('检查投票状态异常:', error)
      return false
    }
  },

  /**
   * 获取用户的投票记录
   */
  async getUserVotes(
    sessionId: string,
    userId: string
  ): Promise<{groupId: string; candidateIds: string[]}[] | null> {
    try {
      const {data, error} = await supabase
        .from('votes')
        .select('voting_group_id, candidate_id')
        .eq('voting_session_id', sessionId)
        .or(buildVoteIdentityFilter(userId))

      if (error) {
        console.error('获取用户投票记录失败:', error)
        return null
      }

      if (!data || data.length === 0) {
        return null
      }

      // 按分组聚合候选人
      const groupMap = new Map<string, string[]>()
      data.forEach((vote) => {
        const groupId = vote.voting_group_id
        const candidateId = vote.candidate_id
        if (!groupMap.has(groupId)) {
          groupMap.set(groupId, [])
        }
        groupMap.get(groupId)?.push(candidateId)
      })

      return Array.from(groupMap.entries()).map(([groupId, candidateIds]) => ({
        groupId,
        candidateIds
      }))
    } catch (error) {
      console.error('获取用户投票记录异常:', error)
      return null
    }
  },

  /**
   * 更新用户的投票（使用原子性RPC函数）
   */
  async updateVote(submission: VoteSubmission): Promise<{success: boolean; error?: string}> {
    try {
      // 1. 检查投票是否过期
      const session = await this.getVotingSession(submission.votingSessionId)
      if (!session) {
        return {success: false, error: '投票不存在'}
      }

      if (session.status === 'closed') {
        return {success: false, error: '投票已关闭'}
      }

      if (session.expiresAt && Date.now() > session.expiresAt) {
        // 过期，自动关闭
        await supabase.from('voting_sessions').update({status: 'closed'}).eq('id', submission.votingSessionId)
        return {success: false, error: '投票已过期'}
      }

      return await executeAtomicVoteSubmission(session, submission, true)
    } catch (error) {
      console.error('更新投票异常:', error)
      return {success: false, error: error instanceof Error ? error.message : 'Unknown error'}
    }
  }
}
