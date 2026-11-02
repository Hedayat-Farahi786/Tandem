import Fastify, { type FastifyInstance } from 'fastify';

export interface Greeting {
  message: string;
}

export function greeting(name?: string): Greeting {
  const who = name?.trim() ? name.trim() : 'world';
  return { message: `Hello, ${who}` };
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get<{ Querystring: { name?: string } }>('/api/greeting', async (request) => {
    return greeting(request.query.name);
  });

  return app;
}
