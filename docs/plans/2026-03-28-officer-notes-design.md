# Officer Notes Refactor Design

Date: 2026-03-28

## Goal

Refactor the officer notes page so that:

- The page only has two tabs: `语法官` and `哼哈官`
- The live cursor tracked target becomes a recommendation only, not a hard-controlled target
- The recommendation area becomes much more compact
- Officers can manually choose any participant, with `Agenda` acting as the primary ordered reference
- The grammarian can record `每日一词` usage with `+1 / -1`
- `每日一词` supports both per-participant statistics and a meeting-wide total

## Product Decisions

### Officer Tabs

- Remove the separate `角色选择` screen
- Keep only two tabs:
  - `语法官`
  - `哼哈官`

### Tracked Target Semantics

- The live cursor target is advisory only
- Manual participant selection is the real recording target
- Live cursor changes must not override the participant currently selected by the officer

### Agenda As Ordered Reference

- Participant candidates come from two sources:
  - Agenda speakers from the current meeting session
  - Existing meeting participants stored in the database
- Agenda speakers are the primary reference and should drive the default order
- Existing database participants not present in the current agenda remain available as supplemental options
- Search is flat and optimized for speed, while default presentation keeps agenda-based ordering

## UX Design

### Compact Recommendation Area

Replace the large tracked-object card with a compact strip that shows:

- `建议跟踪：<speaker or item title>`
- `当前环节：<agenda item title>`
- A short explanation that the recommendation comes from the timer officer live cursor and is advisory only

### Participant Selection

The officer page will expose:

- A search input for quick filtering
- A compact quick-pick list using agenda-based ordering
- Manual selection that remains stable until the officer changes it

Default ordering:

1. Current agenda speaker
2. Upcoming agenda speakers in meeting order
3. Other participants already stored in the database

### Word Of The Day

The grammarian tab gains a compact word-of-the-day card that shows:

- Current word of the day
- Current selected participant
- Per-participant usage count
- Meeting-wide total usage count

Controls:

- `+1`
- `-1`

If the meeting has no configured `wordOfTheDay`, the card stays visible but actions are disabled.

## Data Model

Add a dedicated table: `word_of_day_hits_v2`

Each button press writes one event row instead of mutating a stored total.

Suggested columns:

- `id`
- `meeting_id`
- `participant_key`
- `word_text`
- `delta` with allowed values `1` or `-1`
- `related_item_key`
- `observer_user_id`
- `observer_name`
- `observer_role`
- `row_version`
- `created_at`
- `updated_at`
- `deleted_at`

## Data Flow

### Participant Options

- Build participant options from current agenda items first
- Merge in `meeting_participants_v2`
- Deduplicate by normalized participant key
- Preserve agenda-derived ordering where possible

### Word Of The Day Events

- On `+1 / -1`, ensure the selected participant exists in `meeting_participants_v2`
- Write an event into `word_of_day_hits_v2`
- Refresh all derived counters through realtime reload

### Derived Statistics

Meeting total:

- Sum `delta` grouped by `meeting_id`

Per-participant total:

- Sum `delta` grouped by `meeting_id + participant_key`

Recent history:

- Show latest word-of-the-day events in reverse chronological order

## Error Handling

- If no participant is selected, block recording and show a toast
- If no word of the day is configured, disable `+1 / -1`
- If an agenda-only speaker has not been synced into `meeting_participants_v2`, auto-upsert before writing an event
- If database write fails, keep the current selection and show a concise toast error

## Validation And Acceptance

The change is complete when:

- The officer page only has `语法官` and `哼哈官`
- The tracked-object area is visually smaller and explicitly advisory
- Participant selection supports both quick picking and searching
- Agenda ordering is used as the default reference order
- The grammarian page supports `每日一词 +1 / -1`
- The page shows both meeting-wide totals and per-participant totals
- Realtime refresh keeps the officer page aligned with agenda and timer updates
