import type {AgendaBudgetMode, AgendaNodeKind} from '../types/agendaV2'
import type {MeetingItem, MeetingItemBusinessType, MeetingItemType} from '../types/meeting'

export const IMPROMPTU_BLOCK_TITLE = '即兴演讲'
export const IMPROMPTU_BLOCK_DURATION_SECONDS = 25 * 60
export const IMPROMPTU_SPEECH_DURATION_SECONDS = 2 * 60

const ROOT_PARENT_KEY = '__root__'

function isImpromptuBlockTitle(title: string | null | undefined) {
  const normalizedTitle = title?.trim().toLowerCase() || ''
  return (
    title?.trim() === IMPROMPTU_BLOCK_TITLE ||
    normalizedTitle === 'table topics' ||
    normalizedTitle === 'table topics session'
  )
}

function hasImpromptuKeyword(text: string | null | undefined) {
  const normalized = text?.trim().toLowerCase() || ''
  return normalized.includes('即兴') || normalized.includes('table topic')
}

function isLegacyImpromptuBlock(item: MeetingItem) {
  if (item.agendaParentItemId) return false

  // 兼容旧会议结构：
  // 旧数据可能只保存成 tableTopics，没有 businessType，
  // 但它本质上仍然是一个 15-25 分钟的即兴总池。
  return (
    item.type === 'tableTopics' &&
    (hasImpromptuKeyword(item.title) || hasImpromptuKeyword(item.parentTitle) || item.plannedDuration >= 10 * 60)
  )
}

function isLegacyImpromptuSpeech(item: MeetingItem) {
  if (item.agendaParentItemId) return true

  return Boolean(
    item.parentTitle &&
      hasImpromptuKeyword(item.parentTitle) &&
      item.plannedDuration <= IMPROMPTU_SPEECH_DURATION_SECONDS * 2
  )
}

export type AgendaPlacement = {
  parentItemKey: string | null
  depth: number
  orderIndex: number
  nodeKind: AgendaNodeKind
  budgetMode: AgendaBudgetMode
  budgetLimitSeconds: number | null
  consumeParentBudget: boolean
}

type FlattenableAgendaItem = {
  item_key: string
  parent_item_key?: string | null
  order_index: number
}

export function getMeetingItemBusinessType(item: MeetingItem | null | undefined): MeetingItemBusinessType {
  if (!item) return 'normal'
  if (item.businessType) return item.businessType
  if (isImpromptuBlockTitle(item.title) || isLegacyImpromptuBlock(item)) return 'impromptu_block'
  if (isLegacyImpromptuSpeech(item)) return 'impromptu_speech'
  return 'normal'
}

export function isImpromptuBlock(item: MeetingItem | null | undefined) {
  return getMeetingItemBusinessType(item) === 'impromptu_block'
}

export function isImpromptuSpeech(item: MeetingItem | null | undefined) {
  return getMeetingItemBusinessType(item) === 'impromptu_speech'
}

export function isImpromptuAgendaItem(item: MeetingItem | null | undefined) {
  return getMeetingItemBusinessType(item) === 'impromptu_block'
}

export function resolveMeetingItemType(itemType: string): {
  type: MeetingItemType
  businessType: MeetingItemBusinessType
} {
  if (itemType === 'impromptu_block') {
    return {type: 'other', businessType: 'impromptu_block'}
  }

  if (itemType === 'impromptu_speech') {
    return {type: 'other', businessType: 'impromptu_speech'}
  }

  return {
    type: itemType as MeetingItemType,
    businessType: 'normal'
  }
}

export function getAgendaItemType(item: MeetingItem) {
  const businessType = getMeetingItemBusinessType(item)
  if (businessType === 'impromptu_block') return 'impromptu_block'
  if (businessType === 'impromptu_speech') return 'impromptu_speech'
  return item.type
}

export function buildAgendaPlacements(items: MeetingItem[]) {
  const siblingOrderMap = new Map<string, number>()
  const placements = new Map<string, AgendaPlacement>()

  items.forEach((item) => {
    const businessType = getMeetingItemBusinessType(item)
    const parentItemKey = businessType === 'impromptu_speech' ? item.agendaParentItemId || null : null
    const siblingKey = parentItemKey || ROOT_PARENT_KEY
    const orderIndex = siblingOrderMap.get(siblingKey) || 0

    siblingOrderMap.set(siblingKey, orderIndex + 1)

    placements.set(item.id, {
      parentItemKey,
      depth: parentItemKey ? 2 : 1,
      orderIndex,
      nodeKind: businessType === 'impromptu_block' ? 'segment' : 'leaf',
      budgetMode: businessType === 'impromptu_block' ? 'hard_cap' : 'independent',
      budgetLimitSeconds:
        businessType === 'impromptu_block' ? item.budgetLimitSeconds || IMPROMPTU_BLOCK_DURATION_SECONDS : null,
      consumeParentBudget: businessType === 'impromptu_speech' ? (item.consumeParentBudget ?? true) : true
    })
  })

  return placements
}

export function buildCreateAgendaItemPayload(item: MeetingItem, placement: AgendaPlacement) {
  return {
    itemKey: item.id,
    title: item.title,
    speaker: item.speaker || null,
    plannedDuration: item.plannedDuration,
    orderIndex: placement.orderIndex,
    parentItemKey: placement.parentItemKey,
    depth: placement.depth,
    itemType: getAgendaItemType(item),
    ruleId: item.ruleId,
    nodeKind: placement.nodeKind,
    budgetMode: placement.budgetMode,
    budgetLimitSeconds: placement.budgetLimitSeconds,
    consumeParentBudget: placement.consumeParentBudget,
    slotGroupKey: item.slotGroupKey || null,
    parentTitle: item.parentTitle || null,
    disabled: item.disabled ?? false,
    statusCode: 'initial',
    statusColor: 'blue',
    statusRuleProfile: item.plannedDuration > 300 ? 'gt5m' : 'lte5m'
  }
}

export function flattenAgendaTree<T extends FlattenableAgendaItem>(items: T[]) {
  const childrenByParent = new Map<string | null, T[]>()

  items.forEach((item) => {
    const parentKey = item.parent_item_key || null
    const bucket = childrenByParent.get(parentKey) || []
    bucket.push(item)
    childrenByParent.set(parentKey, bucket)
  })

  childrenByParent.forEach((bucket) => {
    bucket.sort((a, b) => a.order_index - b.order_index)
  })

  const ordered: T[] = []
  const visit = (parentKey: string | null) => {
    const bucket = childrenByParent.get(parentKey) || []
    bucket.forEach((item) => {
      ordered.push(item)
      visit(item.item_key)
    })
  }

  visit(null)
  return ordered
}
