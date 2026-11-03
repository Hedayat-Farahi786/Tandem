/** A spec that passes validation for a two-repo task (API contract included). */
export const VALID_SPEC = `# Add a health endpoint

| Task | Version | Status |
| --- | --- | --- |
| TND-1 | 1 | In review |

## Problem and goal

Operators can't tell whether the service is up. Add GET /health and show it on the main page.

## User story

As an operator, I want to see the service status so that I know it is running.

## Acceptance criteria

1. Given the backend is running, when GET /health is called, then it returns 200 with {"status":"ok"}.
2. Given the main page loads, when the health call succeeds, then the page shows "Status: ok".

## In scope

- GET /health in the backend, status line on the main page.

## Out of scope

- Authentication, metrics.

## Affected repos and changes

- backend: new route in src/app.ts.
- frontend: status line in src/App.tsx.

## API contract

Request:

\`\`\`http
GET /health
\`\`\`

Response:

\`\`\`json
{ "status": "ok" }
\`\`\`

Error (503 when unhealthy):

\`\`\`json
{ "status": "error" }
\`\`\`

## Data and database changes

None.

## UI changes and states

Loading shows "Checking status…", error shows "Status unavailable".

## Edge cases and errors

Backend down: the page shows the error state.

## Security and permissions

Public endpoint, no data exposed.

## Tests to add

- backend test/health.test.ts (criterion 1)
- frontend test/App.test.tsx (criterion 2)

## Rollout notes

No flags needed.

## Open questions

None.

## Approvals
`;
