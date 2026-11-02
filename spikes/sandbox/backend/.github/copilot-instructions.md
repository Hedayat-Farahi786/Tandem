# Instructions for agents

- This is a Fastify 5 service written in TypeScript (ESM, NodeNext).
- Routes live in `src/app.ts`; keep `buildApp()` free of side effects so tests can use `app.inject`.
- Every route needs a Vitest test in `test/` that uses `app.inject`.
- Public JSON responses use camelCase keys.
