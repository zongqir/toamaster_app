# Completed Review Workspace Design

## Goal

When a meeting is marked complete, reopening it should land in a review-focused workspace instead of the editable timeline. The review workspace should make post-meeting follow-up fast and copy-friendly.

## Chosen Approach

Use the existing timeline route as the container, but split the completed state into a dedicated review workspace with four panels:

1. Meeting info
2. Timing review
3. Actual agenda review
4. Officer notes review

This keeps the reopen path simple while preserving the active meeting flow unchanged.

## Why This Approach

- Reopening a completed meeting becomes predictable.
- Existing timing and officer data can be reused instead of rebuilding everything.
- Copy/export can be centralized in one place.
- The active timeline remains focused on editing and execution.

## Structure

- `timeline/index.tsx`
  - Active meetings: keep existing editable timeline UI.
  - Completed meetings: render `CompletedMeetingReview`.
- `CompletedMeetingReview`
  - Top tab switcher for the four review panels.
  - `Copy current panel` and `Copy full review` actions.
  - Read-only views for review data.
- `MeetingStats`
  - Reused inside the timing panel with voting section disabled in review mode.

## Panel Responsibilities

### Meeting Info

- Meeting theme, date, time, location.
- Meeting link.
- Voting ID and voting result entry.

### Timing Review

- Reuse `MeetingStats` timing analysis.
- Keep timing export available through the review workspace copy actions.

### Actual Agenda Review

- Read-only list of actual agenda execution.
- Show planned duration, actual duration, timing verdict, and diff.

### Officer Notes Review

- Load participants, grammarian notes, ah-counter records, and word-of-day hits.
- Summarize by participant.
- Show recent grammar notes.

## Copy Strategy

- `Copy current panel`: exports only the active section.
- `Copy full review`: exports meeting info, timing review, actual agenda, and officer notes in order.

## Non-Goals

- No new standalone review page route in this iteration.
- No editing inside the completed review panels.
- No refactor of the live officer note entry page in this iteration.
