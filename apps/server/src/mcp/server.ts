import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveApiToken } from '../api-tokens.ts';
import type { DB } from '../db.ts';
import { HttpError, isSameOrigin } from '../http.ts';
import { limitRequest } from '../app.ts';
import { findUserById } from '../users.ts';
import { type Ctx, ToolError, describeTool, toolsFor } from './tools.ts';

// An MCP server at /mcp, over Streamable HTTP in its simplest form: each POST
// carries one JSON-RPC message and gets a plain JSON answer, with no
// long-lived connection or server-side session. It signs in with the same
// personal API tokens as the REST API, and every tool calls that API.

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const KEY = 'mcp_enabled';
const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export function mcpEnabled(db: DB): boolean {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  return row?.value === 'true'; // off until an admin turns it on
}

export function setMcpEnabled(db: DB, enabled: boolean): void {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, String(enabled));
}

const INSTRUCTIONS = `setryx is a workout tracker. These tools read and change the signed-in person's own exercises, workouts, routines and sessions.
- Weights are kilograms. A dumbbell weight is the weight of one dumbbell.
- Exercises, workouts and routines can be named instead of given by id; when a name is unclear the tool suggests close matches.
- A workout is a list of steps: exercises (one set each, or "sets" for straight sets), rests, and supersets repeated for several rounds.
- To change a workout's steps, call get_workout first and send the edited items back to update_workout, keeping step ids. For target changes alone, use update_targets.
- whats_next and training_summary are good starting points.`;

type RpcId = string | number;
type RpcRequest = { jsonrpc: '2.0'; id?: RpcId | null; method?: string; params?: Record<string, unknown> };

const rpcError = (id: RpcId | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const result = (id: RpcId, value: unknown) => ({ jsonrpc: '2.0', id, result: value });

function toolText(value: unknown, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function validationMessage(err: z.ZodError): string {
  return `Some arguments need fixing: ${err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`;
}

export const mcpRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  const deny = (reply: FastifyReply, status: number, message: string) => {
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="setryx"');
    return reply.status(status).send(rpcError(null, -32001, message));
  };

  async function handle(req: FastifyRequest, ctx: Ctx, msg: RpcRequest): Promise<object | null> {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && 'id' in msg && msg.id != null ? rpcError(msg.id, -32600, 'Invalid request.') : null; // responses from the client need no answer
    }
    if (msg.id == null) return null; // a notification, e.g. notifications/initialized
    const id = msg.id;
    switch (msg.method) {
      case 'initialize': {
        const asked = String(msg.params?.protocolVersion ?? '');
        return result(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'setryx', title: 'setryx', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, { tools: toolsFor(ctx.scope).map(describeTool) });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const tool = toolsFor(ctx.scope).find((t) => t.name === name);
        if (!tool) {
          const exists = toolsFor('write').some((t) => t.name === name);
          return exists ? result(id, toolText('This token can only read. Create a read and write token in setryx to make changes.', true)) : rpcError(id, -32602, `Unknown tool: ${name}`);
        }
        const args = tool.input.safeParse(msg.params?.arguments ?? {});
        if (!args.success) return result(id, toolText(validationMessage(args.error), true));
        try {
          return result(id, toolText(await tool.run(ctx, args.data)));
        } catch (err) {
          if (err instanceof ToolError) return result(id, toolText(err.message, true));
          req.log.error(err);
          return result(id, toolText('Something went wrong on the setryx server. Check its logs.', true));
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
  }

  app.post('/mcp', async (req, reply) => {
    if (!mcpEnabled(db)) return deny(reply, 404, 'MCP is turned off on this setryx server. An admin can turn it on in Settings → API and AI agents.');
    // Browsers send Origin; refuse other sites (DNS rebinding). Agents send none.
    if (!isSameOrigin(req)) return deny(reply, 403, 'Requests from other sites are blocked.');

    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const token = m ? resolveApiToken(db, m[1]!) : null;
    const user = token ? findUserById(db, token.userId) : null;
    if (!token || !user || user.disabled) return deny(reply, 401, 'Send a setryx API token as “Authorization: Bearer <token>”. Create one in Settings → API and AI agents.');

    // Each message counts against the token's limit, so a batch can't get round it.
    const body = req.body as RpcRequest | RpcRequest[];
    const cost = Math.max(1, Array.isArray(body) ? body.length : 1);
    try {
      limitRequest(req, reply, `token:${token.id}`, app.limits.get().tokenPerMinute, cost, 'This token');
    } catch (err) {
      if (err instanceof HttpError) return deny(reply, err.status, err.message);
      throw err;
    }

    const authorization = req.headers.authorization!;
    const ctx: Ctx = {
      db,
      userId: user.id,
      scope: token.scope,
      async api(method, path, body) {
        const res = await app.inject({ method, url: `/api/v1${path}`, headers: { authorization, 'x-setryx-internal': app.internalKey }, ...(body === undefined ? {} : { payload: body as object }) });
        const data = res.body ? res.json() : null;
        if (res.statusCode >= 400) {
          const fields = data?.fields ? ` (${Object.entries(data.fields).map(([k, v]) => `${k}: ${v}`).join('; ')})` : '';
          throw new ToolError(`${data?.message ?? `The request failed with ${res.statusCode}.`}${fields}`);
        }
        return data;
      },
    };

    if (Array.isArray(body)) {
      const answers = (await Promise.all(body.map((msg) => handle(req, ctx, msg)))).filter(Boolean);
      return answers.length ? reply.send(answers) : reply.status(202).send();
    }
    const answer = await handle(req, ctx, body);
    return answer ? reply.send(answer) : reply.status(202).send();
  });

  // No server-to-client stream and no sessions to end.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) => reply.status(405).header('Allow', 'POST').send(rpcError(null, -32000, 'Use POST.'));
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
};
