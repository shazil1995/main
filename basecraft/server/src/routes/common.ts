import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { registerRoute, type AppContext, type RouteSpec } from '../http.js';
import type { ZodType } from 'zod';

export const uuid = z.string().uuid();
export const idParam = <K extends string>(name: K) => z.object({ [name]: uuid } as Record<K, typeof uuid>);
export const name200 = z.string().trim().min(1).max(200);

export type Reg = <P extends ZodType | undefined, Q extends ZodType | undefined, B extends ZodType | undefined>(spec: RouteSpec<P, Q, B>) => void;
export function makeReg(fastify: FastifyInstance, app: AppContext): Reg {
  return (spec) => registerRoute(fastify, app, { ...spec, path: '/api/v1' + spec.path });
}
