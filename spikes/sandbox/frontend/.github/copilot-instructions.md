# Instructions for agents

- React 19 + Vite + TypeScript. Components live in `src/`, tests in `test/` with Testing Library.
- All network calls go through `src/api.ts`; components take loaders as props so tests do not need a server.
- Every component state (loading, ready, error) needs a test.
