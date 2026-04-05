import Taro from '@tarojs/taro'
import type {ImpromptuSpeechRecord, MeetingItem, MeetingSession} from '../types/meeting'
import type {VotingCandidate, VotingGroup, VotingGroupType} from '../types/voting'
import {generateId} from '../utils/id'

/**
 * 投票分组服务
 */

interface GroupingRule {
  type: VotingGroupType
  name: string
  matcher: (item: MeetingItem) => boolean
  order: number
}

function isImpromptuRoleItem(item: MeetingItem) {
  const normalizedTitle = item.title.trim().toLowerCase()
  return (
    normalizedTitle.includes('即兴主持') ||
    normalizedTitle.includes('table topics master') ||
    normalizedTitle.includes('即兴点评') ||
    normalizedTitle.includes('table topics evaluator')
  )
}

// 分组规则定义
const GROUPING_RULES: GroupingRule[] = [
  {
    type: 'preparedSpeech',
    name: '备稿演讲',
    matcher: (item) => item.type === 'preparedSpeech',
    order: 1
  },
  {
    type: 'evaluation',
    name: '备稿点评',
    matcher: (item) => item.type === 'evaluation',
    order: 2
  },
  {
    type: 'tableTopics',
    name: '即兴演讲',
    matcher: (item) => item.type === 'tableTopics' && !isImpromptuRoleItem(item),
    order: 3
  },
  {
    type: 'officials',
    name: '三官',
    matcher: (item) => {
      const title = item.title.toLowerCase()
      const speaker = item.speaker?.toLowerCase() || ''
      return (
        title.includes('时间官') ||
        title.includes('语法官') ||
        title.includes('哼哈官') ||
        title.includes('timer') ||
        title.includes('grammarian') ||
        title.includes('ah counter') ||
        speaker.includes('时间官') ||
        speaker.includes('语法官') ||
        speaker.includes('哼哈官')
      )
    },
    order: 4
  },
  {
    type: 'others',
    name: '最佳角色',
    matcher: (item) => {
      if (isImpromptuRoleItem(item)) return true
      if (item.type !== 'role') return false
      const title = item.title.toLowerCase()
      const speaker = item.speaker?.toLowerCase() || ''
      const isOfficial =
        title.includes('时间官') ||
        title.includes('语法官') ||
        title.includes('哼哈官') ||
        speaker.includes('时间官') ||
        speaker.includes('语法官') ||
        speaker.includes('哼哈官')
      return !isOfficial
    },
    order: 5
  }
]

/**
 * 计算每组的最大可选数量
 */
function calculateMaxSelections(candidateCount: number): number {
  if (candidateCount <= 3) return 1
  if (candidateCount <= 6) return 2
  return 3
}

function buildCandidatesFromItems(items: MeetingItem[]): VotingCandidate[] {
  const candidateMap = new Map<string, MeetingItem>()
  items.forEach((item) => {
    if (item.speaker) {
      candidateMap.set(item.speaker, item)
    }
  })

  return Array.from(candidateMap.entries()).map(([name, item], index) => ({
    id: generateId('cand'),
    votingGroupId: '',
    name,
    itemId: item.id,
    description: item.title,
    orderIndex: index
  }))
}

function buildCandidatesFromImpromptuRecords(records: ImpromptuSpeechRecord[]): VotingCandidate[] {
  const candidateMap = new Map<string, ImpromptuSpeechRecord>()

  records
    .filter((record) => record.status === 'completed' && record.speechStartedAt && !record.deletedAt)
    .forEach((record) => {
      candidateMap.set(record.speakerName, record)
    })

  return Array.from(candidateMap.entries()).map(([name, record], index) => ({
    id: generateId('cand'),
    votingGroupId: '',
    name,
    itemId: record.agendaItemId,
    description: `即兴演讲 ${index + 1}`,
    orderIndex: index
  }))
}

/**
 * 从会议中提取候选人并分组
 */
export function groupCandidatesFromMeeting(session: MeetingSession): VotingGroup[] {
  const groups: Map<VotingGroupType, MeetingItem[]> = new Map()
  const impromptuCandidates = buildCandidatesFromImpromptuRecords(session.impromptuRecords || [])

  // 初始化分组
  GROUPING_RULES.forEach((rule) => {
    groups.set(rule.type, [])
  })

  // 将会议环节分配到各组
  session.items.forEach((item) => {
    // 跳过禁用的环节
    if (item.disabled) return

    // 跳过没有负责人的环节
    if (!item.speaker || item.speaker === '主持人') return

    // 尝试匹配规则
    for (const rule of GROUPING_RULES) {
      if (rule.matcher(item)) {
        groups.get(rule.type)?.push(item)
        break
      }
    }
  })

  // 构建 VotingGroup 数组
  const votingGroups: VotingGroup[] = []

  GROUPING_RULES.forEach((rule) => {
    const items = groups.get(rule.type) || []
    const candidates =
      rule.type === 'tableTopics'
        ? impromptuCandidates.length > 0
          ? impromptuCandidates
          : buildCandidatesFromItems(items)
        : buildCandidatesFromItems(items)

    if (candidates.length === 0) return // 跳过没有候选人的组

    const groupId = generateId('group')

    // 更新候选人的 groupId
    candidates.forEach((c) => {
      c.votingGroupId = groupId
    })

    votingGroups.push({
      id: groupId,
      votingSessionId: '', // 稍后填充
      groupName: rule.name,
      groupType: rule.type,
      maxSelections: calculateMaxSelections(candidates.length),
      orderIndex: rule.order,
      candidates
    })
  })

  return votingGroups
}

/**
 * 验证投票选择是否符合规则
 */
export function validateVoteSelections(
  groups: VotingGroup[],
  selections: {groupId: string; candidateIds: string[]}[]
): {valid: boolean; error?: string} {
  for (const selection of selections) {
    const group = groups.find((g) => g.id === selection.groupId)
    if (!group) {
      return {valid: false, error: `分组 ${selection.groupId} 不存在`}
    }

    if (selection.candidateIds.length > group.maxSelections) {
      return {
        valid: false,
        error: `${group.groupName} 最多只能选择 ${group.maxSelections} 个候选人`
      }
    }

    const uniqueCandidateIds = new Set(selection.candidateIds)
    if (uniqueCandidateIds.size !== selection.candidateIds.length) {
      return {valid: false, error: `${group.groupName} 存在重复候选人`}
    }

    // 验证候选人是否属于该组
    const validCandidateIds = new Set(group.candidates?.map((c) => c.id) || [])
    for (const candidateId of selection.candidateIds) {
      if (!validCandidateIds.has(candidateId)) {
        return {valid: false, error: `候选人 ${candidateId} 不属于 ${group.groupName}`}
      }
    }
  }

  return {valid: true}
}

/**
 * 生成设备指纹
 */
/**
 * 生成设备指纹
 * 使用本地存储确保同一设备的指纹一致
 */
export function generateDeviceFingerprint(): string {
  const STORAGE_KEY = 'device_fingerprint'

  try {
    // 尝试从本地存储获取已有的指纹
    const storedFingerprint = Taro.getStorageSync(STORAGE_KEY)
    if (storedFingerprint) {
      return storedFingerprint
    }
  } catch (error) {
    console.warn('读取设备指纹失败，将生成新指纹:', error)
  }

  // 生成新的设备指纹：基于 userAgent、时间戳和随机数
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
  const timestamp = Date.now()
  const random = generateId('fp').replace(/^fp_/, '')
  const fingerprint = `fp_${ua.slice(0, 20).replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}_${random}`

  // 保存到本地存储（带错误处理）
  try {
    Taro.setStorageSync(STORAGE_KEY, fingerprint)
  } catch (error) {
    console.error('保存设备指纹失败:', error)
    // 即使保存失败，也返回生成的指纹，至少本次会话内有效
  }

  return fingerprint
}
