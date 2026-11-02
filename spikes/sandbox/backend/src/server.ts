import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';

const app = buildApp();
app
  .listen({ port, host })
  .then((address) => {
    console.log(`backend listening on ${address}`);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
