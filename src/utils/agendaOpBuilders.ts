import type {AgendaOpInput} from '../types/agendaV2'
import type {MeetingItem} from '../types/meeting'
import {type AgendaPlacement, buildAgendaPlacements, buildCreateAgendaItemPayload} from './agendaBusiness'
import {generateUuid} from './id'

const CREATE_TEMP_ORDER_BASE = 1_000_000_000
const MOVE_TEMP_ORDER_BASE = 1_100_000_000

function hasPlacementChanged(prev: AgendaPlacement | undefined, next: AgendaPlacement | undefined) {
  if (!prev || !next) return true

  return prev.parentItemKey !== next.parentItemKey || prev.orderIndex !== next.orderIndex || prev.depth !== next.depth
}

export function buildStagedCreateAgendaOps(
  _prevItems: MeetingItem[],
  nextItems: MeetingItem[],
  createdItems: MeetingItem[]
): AgendaOpInput[] {
  const nextPlacements = buildAgendaPlacements(nextItems)

  return [...createdItems]
    .sort((left, right) => {
      const leftPlacement = nextPlacements.get(left.id)
      const rightPlacement = nextPlacements.get(right.id)

      return (
        (leftPlacement?.depth ?? 1) - (rightPlacement?.depth ?? 1) ||
        (leftPlacement?.orderIndex ?? 0) - (rightPlacement?.orderIndex ?? 0)
      )
    })
    .map((item, index) => {
      const placement = nextPlacements.get(item.id)

      return {
        opId: generateUuid(),
        type: 'create_item' as const,
        itemKey: item.id,
        payload: {
          item: buildCreateAgendaItemPayload(item, {
            parentItemKey: placement?.parentItemKey ?? null,
            depth: placement?.depth ?? 1,
            orderIndex: CREATE_TEMP_ORDER_BASE + index,
            nodeKind: placement?.nodeKind ?? 'leaf',
            budgetMode: placement?.budgetMode ?? 'independent',
            budgetLimitSeconds: placement?.budgetLimitSeconds ?? null,
            consumeParentBudget: placement?.consumeParentBudget ?? true
          })
        }
      }
    })
}

export function buildStagedReorderAgendaOps(
  prevItems: MeetingItem[],
  nextItems: MeetingItem[],
  includeItemIds?: Set<string>
): AgendaOpInput[] {
  const prevPlacements = buildAgendaPlacements(prevItems)
  const nextPlacements = buildAgendaPlacements(nextItems)

  const targetItems = nextItems.filter((item) => {
    if (includeItemIds && !includeItemIds.has(item.id)) return false
    return hasPlacementChanged(prevPlacements.get(item.id), nextPlacements.get(item.id))
  })

  const tempMoveOps = targetItems
    .filter((item) => prevPlacements.has(item.id))
    .map((item, index) => {
      const placement = nextPlacements.get(item.id)

      return {
        opId: generateUuid(),
        type: 'move_item' as const,
        itemKey: item.id,
        payload: {
          parentItemKey: placement?.parentItemKey ?? null,
          orderIndex: MOVE_TEMP_ORDER_BASE + index,
          depth: placement?.depth ?? 1
        }
      }
    })

  const finalMoveOps = targetItems.map((item, index) => {
    const placement = nextPlacements.get(item.id)

    return {
      opId: generateUuid(),
      type: 'move_item' as const,
      itemKey: item.id,
      payload: {
        parentItemKey: placement?.parentItemKey ?? null,
        orderIndex: placement?.orderIndex ?? index,
        depth: placement?.depth ?? 1
      }
    }
  })

  return [...tempMoveOps, ...finalMoveOps]
}
