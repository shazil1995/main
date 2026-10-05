import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { Worker } from './worker.js';

const config = loadConfig();
const { fastify, ctx } = await buildApp(config);
let worker: Worker | undefined;
if (config.WORKER_MODE === 'inline') { worker = new Worker(ctx, fastify.log); worker.start(); }

const shutdown = async (sig: string) => {
  fastify.log.info({ sig }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 15_000); force.unref();
  await fastify.close();       // stop accepting; finish in-flight requests
  await worker?.stop();        // let the current batch finish
  await ctx.db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await fastify.listen({ port: config.PORT, host: config.HOST });
