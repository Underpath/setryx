import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { ApiError } from '@setryx/shared';
import { hostAllowed } from './config.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/** Validates input with a shared Zod schema; turns failures into a 400 with per-field messages. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  throw new HttpError(400, 'invalid_input', 'Some fields need fixing.', fields);
}

export function sendError(reply: FastifyReply, err: HttpError): FastifyReply {
  const body: ApiError = { error: err.code, message: err.message };
  if (err.fields) body.fields = err.fields;
  return reply.status(err.status).send(body);
}

/**
 * CSRF defence in addition to SameSite=Lax cookies: state-changing requests
 * must come from this origin. Browsers always send Origin on cross-site POSTs.
 */
export function isSameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, CLI); cookies still required for auth
  try {
    const host = new URL(origin).host;
    // With allowed hosts set, the Host header was already checked against them,
    // and Origin must be one of them too: a rebinding page's own name is neither.
    const allowed = req.server.config.allowedHosts;
    return allowed ? hostAllowed(allowed, host) && host === req.host : host === req.host;
  } catch {
    return false;
  }
}
