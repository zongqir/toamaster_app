import type {AppSettings, MeetingItem, MeetingItemType, MeetingMetadata} from '../types/meeting'
import {generateId} from '../utils/id'

export const ParserService = {
  parseTable(text: string, _settings: AppSettings): {metadata: MeetingMetadata; items: MeetingItem[]} {
    // 边界情况：空输入
    if (!text || text.trim().length === 0) {
      console.warn('解析器：输入文本为空')
      return {metadata: {}, items: []}
    }

    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    // 边界情况：没有有效行
    if (lines.length === 0) {
      console.warn('解析器：没有有效的文本行')
      return {metadata: {}, items: []}
    }

    const items: MeetingItem[] = []
    const metadata: MeetingMetadata = {}

    // 尝试识别元信息
    for (const line of lines) {
      try {
        if (line.includes('日期：') || line.includes('Date:')) metadata.date = line.split(/[：:]/)[1]?.trim()
        if (line.includes('主题：') || line.includes('Theme:')) metadata.theme = line.split(/[：:]/)[1]?.trim()
        if (line.includes('每日一词') || line.includes('Word of the Day'))
          metadata.wordOfTheDay = line.split(/[：:]/)[1]?.trim()
        if (line.includes('地点：') || line.includes('Location:')) metadata.location = line.split(/[：:]/)[1]?.trim()
        if (line.includes('时间：') || line.includes('Time:')) {
          const timeVal = line.split(/[：:]/)[1]?.trim()
          if (timeVal && /^\d{1,2}[:：]\d{2}/.test(timeVal)) {
            metadata.startTime = timeVal
          }
        }
      } catch (error) {
        console.warn('解析元信息时出错:', line, error)
      }
    }

    // 尝试识别表格行
    // 假设常见的 TSV 拷贝或者空格分隔
    for (const line of lines) {
      try {
        // 过滤掉标题行
        if (line.includes('活动') || line.includes('Activity') || line.includes('负责人')) continue

        const parts = line.split(/\t| {2,}/) // 匹配 tab 或 2个以上空格
        if (parts.length < 2) continue

        let timeStr = ''
        let activity = ''
        let durationStr = ''
        let participant = ''

        // 启发式识别：如果第一项是时间格式
        if (/^\d{1,2}[:：]\d{2}/.test(parts[0])) {
          timeStr = parts[0]
          activity = parts[1] || ''
          durationStr = parts[2] || ''
          participant = parts[3] || ''
        } else {
          activity = parts[0]
          durationStr = parts[1] || ''
          participant = parts[2] || ''
        }

        if (!activity || activity.length < 2) continue

        const duration = this.parseDuration(durationStr)
        if (duration === 0 && !timeStr) continue

        const type = this.inferType(activity)
        const ruleId = duration > 180 ? 'long' : 'short'

        items.push({
          id: generateId('item'),
          title: activity,
          speaker: participant,
          plannedDuration: duration,
          startTime: timeStr,
          type: type,
          ruleId: ruleId
        })
      } catch (error) {
        console.warn('解析行时出错:', line, error)
      }
    }

    // 边界情况：没有解析出任何环节
    if (items.length === 0) {
      console.warn('解析器：未能识别出任何会议环节，请检查输入格式')
    }

    return {metadata, items}
  },

  parseDuration(str: string): number {
    if (!str || str.trim().length === 0) return 0

    try {
      const trimmed = str.trim()

      // HH:MM:SS 格式
      const hhmmssMatch = trimmed.match(/(\d+):(\d+):(\d+)/)
      if (hhmmssMatch) {
        const hours = parseInt(hhmmssMatch[1], 10)
        const minutes = parseInt(hhmmssMatch[2], 10)
        const seconds = parseInt(hhmmssMatch[3], 10)
        return hours * 3600 + minutes * 60 + seconds
      }

      // MM:SS 或 M:SS 格式
      const mmssMatch = trimmed.match(/(\d+):(\d+)/)
      if (mmssMatch) {
        const first = parseInt(mmssMatch[1], 10)
        const second = parseInt(mmssMatch[2], 10)
        // 如果第一个数字 > 60，可能是 MM:SS
        return first * 60 + second
      }

      // X分钟 or Xmin
      const minMatch = trimmed.match(/(\d+)\s*(分钟|min|m)/i)
      if (minMatch) {
        return parseInt(minMatch[1], 10) * 60
      }

      // X秒 or Xs
      const secMatch = trimmed.match(/(\d+)\s*(秒|s)/i)
      if (secMatch) {
        return parseInt(secMatch[1], 10)
      }

      // 纯数字（默认为分钟）
      if (/^\d+$/.test(trimmed)) {
        return parseInt(trimmed, 10) * 60
      }
    } catch (error) {
      console.warn('解析时长失败:', str, error)
    }

    return 0
  },

  inferType(title: string): MeetingItemType {
    const t = title.toLowerCase()

    // 开场
    if (t.includes('开场') || t.includes('opening')) return 'opening'

    // 介绍
    if (t.includes('介绍') || t.includes('intro')) return 'intro'

    // 角色报告
    if (
      t.includes('时间官') ||
      t.includes('语法官') ||
      t.includes('哼哈官') ||
      t.includes('总点评') ||
      t.includes('timer') ||
      t.includes('grammarian') ||
      t.includes('官') ||
      t.includes('master') ||
      t.includes('报告')
    )
      return 'role'

    // 即兴演讲
    if (t.includes('即兴') || t.includes('table topic')) return 'tableTopics'

    // 备稿演讲
    if (
      t.includes('备稿') ||
      t.includes('prepared') ||
      t.includes('演讲') ||
      t.includes('破冰') ||
      t.includes('speech')
    )
      return 'preparedSpeech'

    // 点评
    if (t.includes('点评') || t.includes('evaluation')) return 'evaluation'

    // 休息
    if (t.includes('休息') || t.includes('拍照') || t.includes('break')) return 'break'

    // 问答
    if (t.includes('q&a') || t.includes('问答') || t.includes('qa')) return 'qa'

    // 投票
    if (t.includes('投票') || t.includes('voting') || t.includes('分享')) return 'voting'

    // 颁奖
    if (t.includes('颁奖') || t.includes('最佳') || t.includes('award')) return 'award'

    // 结束
    if (t.includes('结束') || t.includes('ending') || t.includes('closing')) return 'closing'

    return 'other'
  }
}
