import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const dataDir = resolve(process.env.HUB_DATA_DIR ?? 'data');
export function config() {
  try { return JSON.parse(readFileSync(resolve(dataDir,'config.json'),'utf8')) as { adminToken: string; agentToken: string }; }
  catch { throw new Error('Missing hub configuration. Run npm run init first.'); }
}
