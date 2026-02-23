export type TimerRule = {
  id: string
  name: string
  yellowThreshold: number // 剩余秒数触发黄牌
  redThreshold: number // 剩余秒数触发红牌
  timeoutThreshold: number // 超时结束阈值（负数表示超过后的秒数）
}

export type MeetingItemType =
  | 'opening'
  | 'intro'
  | 'role'
  | 'tableTopics'
  | 'preparedSpeech'
  | 'evaluation'
  | 'break'
  | 'qa'
  | 'voting'
  | 'award'
  | 'closing'
  | 'other'

export type MeetingItem = {
  id: string
  title: string
  speaker: string
  plannedDuration: number // 秒
  startTime?: string // 计划开始时间 15:00
  type: MeetingItemType
  ruleId: string
  disabled?: boolean
  parentTitle?: string // 父级标题（用于子活动）

  // 运行记录
  actualStartTime?: number
  actualEndTime?: number
  actualDuration?: number
}

export type MeetingMetadata = {
  clubName?: string // 俱乐部名称
  meetingNo?: number | string // 会议次数（支持数字或带后缀的字符串如"123(1)"）
  theme?: string // 会议主题
  date?: string // 日期
  wordOfTheDay?: string // 每日一词
  location?: string // 地点
  timeRange?: string // 会议时段（如 15:00-17:30）
  startTime?: string // 开始时间
  endTime?: string // 结束时间
  votingId?: string // 投票ID
  meetingLink?: string // 会议链接
}

export type MeetingSession = {
  id: string
  metadata: MeetingMetadata
  items: MeetingItem[]
  createdAt: number
  isCompleted?: boolean
}

export type AIConfig = {
  apiUrl: string
  apiKey: string
  model?: string
}

export type AppSettings = {
  rules: Record<string, TimerRule>
  itemTypeDefaults: Record<MeetingItemType, {ruleId: string; defaultDuration: number}>
  memberNames: string[]
  aiConfig?: AIConfig // 可选，默认使用文心AI
}
