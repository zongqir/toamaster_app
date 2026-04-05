type AgendaItemDraftInput = {
  title: string
  speaker: string
  durationText: string
}

type AgendaItemDraftValidation = {
  title: string
  speaker: string
  durationMinutes: number | null
  errorMessage: string | null
}

export function validateAgendaItemDraft(input: AgendaItemDraftInput): AgendaItemDraftValidation {
  const title = input.title.trim()
  const speaker = input.speaker.trim()
  const durationText = input.durationText.trim()
  const missingFields: string[] = []

  if (!title) {
    missingFields.push('环节名称')
  }

  if (!speaker) {
    missingFields.push('执行人')
  }

  if (!durationText) {
    missingFields.push('时间')
  }

  let durationMinutes: number | null = null
  let hasInvalidDuration = false

  if (durationText) {
    const isInteger = /^\d+$/.test(durationText)
    const parsedDuration = isInteger ? Number.parseInt(durationText, 10) : Number.NaN

    if (Number.isFinite(parsedDuration) && parsedDuration > 0) {
      durationMinutes = parsedDuration
    } else {
      hasInvalidDuration = true
    }
  }

  let errorMessage: string | null = null
  if (missingFields.length > 0 && hasInvalidDuration) {
    errorMessage = `请填写${missingFields.join('、')}，并输入正确的时间`
  } else if (missingFields.length > 0) {
    errorMessage = `请填写${missingFields.join('、')}`
  } else if (hasInvalidDuration) {
    errorMessage = '请填写正确的时间'
  }

  return {
    title,
    speaker,
    durationMinutes,
    errorMessage
  }
}
