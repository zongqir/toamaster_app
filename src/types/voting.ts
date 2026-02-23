/**
 * 投票相关类型定义
 */

export type VotingGroupType = 'preparedSpeech' | 'evaluation' | 'tableTopics' | 'officials' | 'others'

export type VotingSessionStatus = 'active' | 'closed'

export interface VotingCandidate {
  id: string
  votingGroupId: string
  name: string
  itemId?: string // 关联到 meeting_item
  description?: string
  orderIndex: number
  voteCount?: number // 得票数（查询时附加）
}

export interface VotingGroup {
  id: string
  votingSessionId: string
  groupName: string
  groupType: VotingGroupType
  maxSelections: number // 最多可选数量
  orderIndex: number
  candidates?: VotingCandidate[] // 候选人列表（查询时附加）
}

export interface VotingSession {
  id: string
  meetingId: string
  title: string
  description?: string
  status: VotingSessionStatus
  createdAt: number
  expiresAt?: number
  createdBy?: string
  groups?: VotingGroup[] // 分组列表（查询时附加）
}

export interface Vote {
  id: string
  votingSessionId: string
  votingGroupId: string
  candidateId: string
  voterName: string
  voterFingerprint: string
  createdAt: number
}

/**
 * 投票提交数据
 */
export interface VoteSubmission {
  votingSessionId: string
  voterName: string
  voterFingerprint: string
  selections: {
    groupId: string
    candidateIds: string[]
  }[]
}

/**
 * 投票结果统计
 */
export interface VotingResult {
  session: VotingSession
  groups: Array<{
    group: VotingGroup
    candidates: Array<{
      candidate: VotingCandidate
      voteCount: number
      voters: string[] // 投票人姓名列表
    }>
    totalVotes: number
  }>
  totalVoters: number
  voterNames: string[]
}
