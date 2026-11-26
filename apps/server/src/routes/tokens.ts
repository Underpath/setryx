import type { FastifyPluginAsync } from 'fastify';
import { createApiTokenRequestSchema } from '@setryx/shared';
import { requireUser } from '../app.ts';
import { createApiToken, deleteApiToken, listApiTokens } from '../api-tokens.ts';
import { HttpError, parse } from '../http.ts';
import { mcpEnabled } from '../mcp/server.ts';

/** Personal API tokens, managed only while signed in (a token can't manage tokens). */
export const tokenRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  app.addHook('preHandler', async (req) => void requireUser(req));

  app.get('/tokens', async (req) => {
    const { tokenPerMinute, maxTokensPerUser } = app.limits.get();
    return { tokens: listApiTokens(db, req.user!.id), mcpEnabled: mcpEnabled(db), limits: { perMinute: tokenPerMinute, maxTokens: maxTokensPerUser } };
  });

  app.post('/tokens', async (req, reply) => {
    const body = parse(createApiTokenRequestSchema, req.body);
    const max = app.limits.get().maxTokensPerUser;
    if (listApiTokens(db, req.user!.id).length >= max) {
      throw new HttpError(400, 'too_many_tokens', `You have ${max === 1 ? 'a token' : `${max} tokens`}, the most this server allows. Revoke one you no longer use first.`);
    }
    return reply.status(201).send(createApiToken(db, req.user!.id, body));
  });

  app.delete<{ Params: { id: string } }>('/tokens/:id', async (req, reply) => {
    if (!deleteApiToken(db, req.user!.id, req.params.id)) throw new HttpError(404, 'not_found', 'No such token.');
    return reply.status(204).send();
  });
};
