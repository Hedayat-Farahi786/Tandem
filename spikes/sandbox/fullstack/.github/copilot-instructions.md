# Instructions for agents

- One repo, two parts: a Fastify 5 API in `src/server` and a React 19 UI in `src/web`.
- The UI only talks to the API through `src/web/api.ts`. API routes live in `src/server/app.ts` under `/api`.
- Server tests go in `test/server` (use `app.inject`); UI tests go in `test/web` (Testing Library, jsdom).
- Public JSON responses use camelCase keys.
