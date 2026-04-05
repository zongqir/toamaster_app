# Import Parse Job Design

## Goal

Keep the import page in a waiting state while moving long-running AI parsing work off the original client request.

## Design

- Add a `parse_jobs` table to track parse input, lifecycle state, result payload, and failure reason.
- Replace the direct long-running import request with:
  - `submit-parse-job` to create a queued job and schedule background work.
  - `get-parse-job` to poll status and retrieve the final result.
- Run the actual parse work in a background task via `EdgeRuntime.waitUntil(...)`.
- Preserve the existing client-side save flow after parsing succeeds so meeting creation behavior stays unchanged.

## Error Handling

- Jobs move through `queued -> processing -> succeeded|failed`.
- AI timeout is capped inside the shared parser and converted into a user-facing message.
- Polling retries tolerate transient status-query failures before surfacing an error.

## Local Development

- Set Supabase edge runtime policy to `per_worker` so background tasks continue to run during local development.
