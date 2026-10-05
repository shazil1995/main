import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { Worker } from './worker.js';

// Stand-alone worker process (WORKER_MODE=separate on the API). Reuses the app context but does not listen.
const config = loadConfig();
const { fastify, ctx } = await buildApp(config);
const worker = new Worker(ctx, fastify.log);
worker.start();
fastify.log.info('worker started');
const stop = async () => { await worker.stop(); await ctx.db.close(); process.exit(0); };
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
