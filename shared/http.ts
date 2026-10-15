import type { IncomingMessage, ServerResponse } from 'node:http';
import { HubError, digest } from './store.ts';
import { timingSafeEqual } from 'node:crypto';
export const sameSecret = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a)),Buffer.from(digest(b)));
export function bearer(req: IncomingMessage) { return req.headers.authorization?.replace(/^Bearer /,'') ?? ''; }
export async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 100_000) throw new HubError('Request too large',413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString() || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new HubError('Expected a JSON object'); }
}
export function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(value));
}
export function failure(res: ServerResponse, error: unknown) {
  const known = error instanceof HubError;
  if (!known) console.error(error);
  if (res.headersSent) { res.end(); return; }
  json(res,{error: known ? error.message : 'Internal server error'},known ? error.status : 500);
}
