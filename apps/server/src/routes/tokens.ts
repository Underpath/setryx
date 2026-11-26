import type { FastifyPluginAsync } from 'fastify';
import { createApiTokenRequestSchema } from '@setryx/shared';
import { requireUser } from '../app.ts';
import { createApiToken, deleteApiToken, listApiTokens } from '../api-tokens.ts';
import { HttpError, parse } from '../http.ts';

/** Personal API tokens, managed only while signed in (a token can't manage tokens). */
export const tokenRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  app.addHook('preHandler', async (req) => void requireUser(req));

  app.get('/tokens', async (req) => ({ tokens: listApiTokens(db, req.user!.id) }));

  app.post('/tokens', async (req, reply) => {
    const body = parse(createApiTokenRequestSchema, req.body);
    if (listApiTokens(db, req.user!.id).length >= 20) throw new HttpError(400, 'too_many_tokens', 'You have 20 tokens. Revoke one you no longer use first.');
    return reply.status(201).send(createApiToken(db, req.user!.id, body));
  });

  app.delete<{ Params: { id: string } }>('/tokens/:id', async (req, reply) => {
    if (!deleteApiToken(db, req.user!.id, req.params.id)) throw new HttpError(404, 'not_found', 'No such token.');
    return reply.status(204).send();
  });
};
