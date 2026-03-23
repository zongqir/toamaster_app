import {supabase} from '../client/supabase'
import type {MeetingItem, MeetingMetadata, MeetingSession} from '../types/meeting'

/**
 * 数据库会议记录类型
 */
interface DBMeeting {
  id: string
  title: string
  date: string | null
  theme: string | null
  word_of_the_day: string | null
  start_time: string | null
  end_time: string | null
  time_range: string | null
  location: string | null
  club_name: string | null
  meeting_no: string | number | null // 支持数字或带后缀的字符串（如"123(1)"）
  voting_id: string | null
  meeting_link: string | null
  is_completed: boolean
  created_at: number
  created_by: string
  total_planned_duration: number
  total_actual_duration: number
  agenda_version?: number
}

interface DBMeetingItem {
  id: string
  meeting_id: string
  title: string
  speaker: string | null
  planned_duration: number
  actual_duration: number | null
  actual_start_time: number | null
  actual_end_time: number | null
  start_time: string | null
  item_type: string
  rule_id: string
  disabled: boolean
  parent_title: string | null
  order_index: number
}

interface DBAgendaItemV2 {
  meeting_id: string
  item_key: string
  title: string
  speaker: string | null
  planned_duration: number
  actual_duration: number | null
  actual_start_time: number | null
  actual_end_time: number | null
  start_time: string | null
  item_type: string
  rule_id: string
  disabled: boolean
  parent_title: string | null
  order_index: number
  deleted_at: number | null
}

function mapLegacyItemToMeetingItem(item: DBMeetingItem): MeetingItem {
  return {
    id: item.id,
    title: item.title,
    speaker: item.speaker || '',
    plannedDuration: item.planned_duration,
    actualDuration: item.actual_duration || undefined,
    actualStartTime: item.actual_start_time || undefined,
    actualEndTime: item.actual_end_time || undefined,
    startTime: item.start_time || undefined,
    type: item.item_type as MeetingItem['type'],
    ruleId: item.rule_id,
    disabled: item.disabled,
    parentTitle: item.parent_title || undefined
  }
}

function mapAgendaV2ItemToMeetingItem(item: DBAgendaItemV2): MeetingItem {
  return {
    id: item.item_key,
    title: item.title,
    speaker: item.speaker || '',
    plannedDuration: item.planned_duration,
    actualDuration: item.actual_duration || undefined,
    actualStartTime: item.actual_start_time || undefined,
    actualEndTime: item.actual_end_time || undefined,
    startTime: item.start_time || undefined,
    type: item.item_type as MeetingItem['type'],
    ruleId: item.rule_id,
    disabled: item.disabled,
    parentTitle: item.parent_title || undefined
  }
}

/**
 * 数据库服务
 */
export const DatabaseService = {
  /**
   * 保存会议到数据库
   */
  async saveMeeting(session: MeetingSession): Promise<{success: boolean; error?: string}> {
    try {
      // 计算总时长
      const totalPlanned = session.items.reduce((sum, item) => sum + item.plannedDuration, 0)
      const totalActual = session.items.reduce((sum, item) => sum + (item.actualDuration || 0), 0)

      // 准备会议数据
      const meetingData: DBMeeting = {
        id: session.id,
        title: session.metadata.theme || '未命名会议',
        date: session.metadata.date || null,
        theme: session.metadata.theme || null,
        word_of_the_day: session.metadata.wordOfTheDay || null,
        start_time: session.metadata.startTime || null,
        end_time: session.metadata.endTime || null,
        time_range: session.metadata.timeRange || null,
        location: session.metadata.location || null,
        club_name: session.metadata.clubName || null,
        meeting_no: session.metadata.meetingNo || null,
        voting_id: session.metadata.votingId || null,
        meeting_link: session.metadata.meetingLink || null,
        is_completed: session.isCompleted || false,
        created_at: session.createdAt,
        created_by: 'anonymous',
        total_planned_duration: totalPlanned,
        total_actual_duration: totalActual,
        agenda_version: session.agendaVersion
      }

      // 保存会议基本信息（使用 upsert）
      const {error: meetingError} = await supabase.from('meetings').upsert(meetingData, {
        onConflict: 'id'
      })

      if (meetingError) {
        console.error('保存会议失败:', meetingError)
        return {success: false, error: meetingError.message}
      }

      // 准备环节数据
      const itemsData: DBMeetingItem[] = session.items.map((item, index) => ({
        id: item.id,
        meeting_id: session.id,
        title: item.title,
        speaker: item.speaker || null,
        planned_duration: item.plannedDuration,
        actual_duration: item.actualDuration || null,
        actual_start_time: item.actualStartTime || null,
        actual_end_time: item.actualEndTime || null,
        start_time: item.startTime || null,
        item_type: item.type,
        rule_id: item.ruleId,
        disabled: item.disabled || false,
        parent_title: item.parentTitle || null,
        order_index: index
      }))

      // 删除旧的环节数据
      const {error: deleteError} = await supabase.from('meeting_items').delete().eq('meeting_id', session.id)

      if (deleteError) {
        console.error('删除旧环节失败:', deleteError)
      }

      // 保存新的环节数据
      // 使用 upsert 防止并发保存导致的主键冲突（同一环节 id 重复提交）
      const {error: itemsError} = await supabase.from('meeting_items').upsert(itemsData, {
        onConflict: 'id'
      })

      if (itemsError) {
        console.error('保存环节失败:', itemsError)
        return {success: false, error: itemsError.message}
      }

      return {success: true}
    } catch (error) {
      console.error('保存会议异常:', error)
      return {success: false, error: error instanceof Error ? error.message : '未知错误'}
    }
  },

  /**
   * 获取所有会议列表
   */
  async getAllMeetings(): Promise<MeetingSession[]> {
    try {
      // 获取会议列表
      const {data: meetings, error: meetingsError} = await supabase
        .from('meetings')
        .select('*')
        .order('created_at', {ascending: false})

      if (meetingsError) {
        console.error('获取会议列表失败:', meetingsError)
        return []
      }

      if (!meetings || meetings.length === 0) {
        return []
      }

      // 获取所有环节
      const meetingIds = meetings.map((m) => m.id)
      const meetingItemsMap = new Map<string, MeetingItem[]>()
      const v2KnownMeetingIds = new Set<string>()

      const {data: v2Items, error: v2ItemsError} = await supabase
        .from('agenda_items_v2')
        .select('*')
        .in('meeting_id', meetingIds)
        .order('meeting_id', {ascending: true})
        .order('order_index', {ascending: true})

      if (v2ItemsError) {
        console.warn('获取 Agenda V2 环节失败，将回退旧表:', v2ItemsError.message)
      } else {
        ;((v2Items || []) as DBAgendaItemV2[]).forEach((item) => {
          v2KnownMeetingIds.add(item.meeting_id)
          if (item.deleted_at !== null) return

          const mapped = mapAgendaV2ItemToMeetingItem(item)
          const current = meetingItemsMap.get(item.meeting_id) || []
          current.push(mapped)
          meetingItemsMap.set(item.meeting_id, current)
        })
      }

      const fallbackMeetingIds = meetingIds.filter((meetingId) => !v2KnownMeetingIds.has(meetingId))
      if (fallbackMeetingIds.length > 0) {
        const {data: legacyItems, error: legacyItemsError} = await supabase
          .from('meeting_items')
          .select('*')
          .in('meeting_id', fallbackMeetingIds)
          .order('meeting_id', {ascending: true})
          .order('order_index', {ascending: true})

        if (legacyItemsError) {
          console.error('获取旧版环节列表失败:', legacyItemsError)
        } else {
          ;((legacyItems || []) as DBMeetingItem[]).forEach((item) => {
            const mapped = mapLegacyItemToMeetingItem(item)
            const current = meetingItemsMap.get(item.meeting_id) || []
            current.push(mapped)
            meetingItemsMap.set(item.meeting_id, current)
          })
        }
      }

      // 组装数据
      const sessions: MeetingSession[] = meetings.map((meeting) => {
        const meetingItems = meetingItemsMap.get(meeting.id) || []

        return {
          id: meeting.id,
          metadata: {
            clubName: meeting.club_name || undefined,
            meetingNo: meeting.meeting_no || undefined,
            date: meeting.date || undefined,
            theme: meeting.theme || undefined,
            wordOfTheDay: meeting.word_of_the_day || undefined,
            timeRange: meeting.time_range || undefined,
            startTime: meeting.start_time || undefined,
            endTime: meeting.end_time || undefined,
            location: meeting.location || undefined,
            votingId: meeting.voting_id || undefined,
            meetingLink: meeting.meeting_link || undefined
          },
          items: meetingItems,
          createdAt: meeting.created_at,
          agendaVersion: meeting.agenda_version || 1,
          isCompleted: meeting.is_completed
        }
      })

      return sessions
    } catch (error) {
      console.error('获取会议列表异常:', error)
      return []
    }
  },

  /**
   * 获取单个会议详情
   */
  async getMeeting(id: string): Promise<MeetingSession | null> {
    try {
      // 获取会议信息
      const {data: meeting, error: meetingError} = await supabase
        .from('meetings')
        .select('*')
        .eq('id', id)
        .maybeSingle()

      if (meetingError || !meeting) {
        console.error('获取会议失败:', meetingError)
        return null
      }

      // 获取环节列表
      let meetingItems: MeetingItem[] = []
      let hasV2Items = false

      const {data: v2Items, error: v2ItemsError} = await supabase
        .from('agenda_items_v2')
        .select('*')
        .eq('meeting_id', id)
        .order('order_index', {ascending: true})

      if (v2ItemsError) {
        console.warn('获取 Agenda V2 环节失败，将回退旧表:', v2ItemsError.message)
      } else if ((v2Items || []).length > 0) {
        meetingItems = ((v2Items || []) as DBAgendaItemV2[])
          .filter((item) => item.deleted_at === null)
          .map((item) => mapAgendaV2ItemToMeetingItem(item))
        hasV2Items = true
      }

      if (!hasV2Items) {
        const {data: legacyItems, error: legacyItemsError} = await supabase
          .from('meeting_items')
          .select('*')
          .eq('meeting_id', id)
          .order('order_index', {ascending: true})

        if (legacyItemsError) {
          console.error('获取旧版环节失败:', legacyItemsError)
          return null
        }

        meetingItems = ((legacyItems || []) as DBMeetingItem[]).map((item) => mapLegacyItemToMeetingItem(item))
      }

      return {
        id: meeting.id,
        metadata: {
          clubName: meeting.club_name || undefined,
          meetingNo: meeting.meeting_no || undefined,
          date: meeting.date || undefined,
          theme: meeting.theme || undefined,
          wordOfTheDay: meeting.word_of_the_day || undefined,
          timeRange: meeting.time_range || undefined,
          startTime: meeting.start_time || undefined,
          endTime: meeting.end_time || undefined,
          location: meeting.location || undefined,
          votingId: meeting.voting_id || undefined,
          meetingLink: meeting.meeting_link || undefined
        },
        items: meetingItems,
        createdAt: meeting.created_at,
        agendaVersion: meeting.agenda_version || 1,
        isCompleted: meeting.is_completed
      }
    } catch (error) {
      console.error('获取会议详情异常:', error)
      return null
    }
  },

  /**
   * 删除会议（会自动级联删除所有关联数据）
   */
  async deleteMeeting(id: string): Promise<{success: boolean; error?: string}> {
    try {
      // 删除会议（外键约束会自动级联删除以下数据）：
      // - meeting_items（会议环节）
      // - meeting_links（会议链接）
      // - voting_sessions（投票会话）
      // - voting_groups（投票分组）
      // - voting_candidates（投票候选人）
      // - votes（投票记录）
      const {error} = await supabase.from('meetings').delete().eq('id', id)

      if (error) {
        console.error('删除会议失败:', error)
        return {success: false, error: error.message}
      }

      return {success: true}
    } catch (error) {
      console.error('删除会议异常:', error)
      return {success: false, error: error instanceof Error ? error.message : '未知错误'}
    }
  },

  /**
   * 更新会议完成状态
   */
  async updateMeetingStatus(id: string, isCompleted: boolean): Promise<{success: boolean; error?: string}> {
    try {
      const {error} = await supabase.from('meetings').update({is_completed: isCompleted}).eq('id', id)

      if (error) {
        console.error('更新会议状态失败:', error)
        return {success: false, error: error.message}
      }

      return {success: true}
    } catch (error) {
      console.error('更新会议状态异常:', error)
      return {success: false, error: error instanceof Error ? error.message : '未知错误'}
    }
  },

  /**
   * 根据会议ID获取会议号
   */
  async getMeetingNo(id: string): Promise<string | number | null> {
    try {
      const {data, error} = await supabase.from('meetings').select('meeting_no').eq('id', id).single()

      if (error) {
        console.error('获取会议号失败:', error)
        return null
      }

      return data?.meeting_no || null
    } catch (error) {
      console.error('获取会议号异常:', error)
      return null
    }
  },

  /**
   * 生成唯一的会议号（处理重复情况）
   */
  async generateUniqueMeetingNo(baseMeetingNo: string | number | null): Promise<string | number> {
    if (!baseMeetingNo) {
      return Date.now() // 如果没有会议号，使用时间戳
    }

    try {
      // 获取所有现有的会议号
      const {data: meetings, error} = await supabase.from('meetings').select('meeting_no')

      if (error) {
        console.error('获取会议号列表失败:', error)
        return baseMeetingNo // 如果查询失败，直接返回原会议号
      }

      const existingMeetingNos = new Set(meetings?.map((m) => String(m.meeting_no)) || [])

      // 检查基础会议号是否已存在
      const baseMeetingNoStr = String(baseMeetingNo)
      if (!existingMeetingNos.has(baseMeetingNoStr)) {
        return baseMeetingNo // 不重复，直接返回
      }

      // 如果重复，生成带后缀的会议号
      let suffix = 1
      let newMeetingNo = `${baseMeetingNoStr}(${suffix})`
      while (existingMeetingNos.has(newMeetingNo)) {
        suffix++
        newMeetingNo = `${baseMeetingNoStr}(${suffix})`
      }

      return newMeetingNo
    } catch (error) {
      console.error('生成唯一会议号异常:', error)
      return baseMeetingNo
    }
  },

  /**
   * 保存或更新会议链接
   */
  async saveMeetingLink(meetingId: string, link: string): Promise<{success: boolean; error?: string}> {
    try {
      const now = Date.now()

      // 使用 upsert 实现插入或更新
      const {error} = await supabase.from('meeting_links').upsert(
        {
          meeting_id: meetingId,
          link: link,
          updated_at: now
        },
        {
          onConflict: 'meeting_id'
        }
      )

      if (error) {
        console.error('保存会议链接失败:', error)
        return {success: false, error: error.message}
      }

      return {success: true}
    } catch (error) {
      console.error('保存会议链接异常:', error)
      return {success: false, error: error instanceof Error ? error.message : '未知错误'}
    }
  },

  /**
   * 获取会议链接
   */
  async getMeetingLink(meetingId: string): Promise<string | null> {
    try {
      const {data, error} = await supabase
        .from('meeting_links')
        .select('link')
        .eq('meeting_id', meetingId)
        .maybeSingle()

      if (error) {
        console.error('获取会议链接失败:', error)
        return null
      }

      return data?.link || null
    } catch (error) {
      console.error('获取会议链接异常:', error)
      return null
    }
  },

  /**
   * 删除会议链接
   */
  async deleteMeetingLink(meetingId: string): Promise<{success: boolean; error?: string}> {
    try {
      const {error} = await supabase.from('meeting_links').delete().eq('meeting_id', meetingId)

      if (error) {
        console.error('删除会议链接失败:', error)
        return {success: false, error: error.message}
      }

      return {success: true}
    } catch (error) {
      console.error('删除会议链接异常:', error)
      return {success: false, error: error instanceof Error ? error.message : '未知错误'}
    }
  },

  /**
   * 仅更新会议基础信息（不更新 meeting_items，避免整表覆盖）
   */
  async updateMeetingMetadata(
    id: string,
    metadata: MeetingMetadata,
    options?: {isCompleted?: boolean}
  ): Promise<{success: boolean; error?: string}> {
    try {
      const payload: Partial<DBMeeting> = {
        title: metadata.theme || '未命名会议',
        date: metadata.date || null,
        theme: metadata.theme || null,
        word_of_the_day: metadata.wordOfTheDay || null,
        start_time: metadata.startTime || null,
        end_time: metadata.endTime || null,
        time_range: metadata.timeRange || null,
        location: metadata.location || null,
        club_name: metadata.clubName || null,
        meeting_no: metadata.meetingNo || null,
        voting_id: metadata.votingId || null,
        meeting_link: metadata.meetingLink || null
      }

      if (typeof options?.isCompleted === 'boolean') {
        payload.is_completed = options.isCompleted
      }

      const {error} = await supabase.from('meetings').update(payload).eq('id', id)
      if (error) {
        console.error('更新会议基础信息失败:', error)
        return {success: false, error: error.message}
      }

      return {success: true}
    } catch (error) {
      console.error('更新会议基础信息异常:', error)
      return {success: false, error: error instanceof Error ? error.message : '未知错误'}
    }
  }
}
