// Run only inside the intended native Antigravity session's shell tool.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { registerAgy } from '../shared/agy-native.ts';
process.umask(0o077);
const installed=resolve(homedir(),'.local/bin/agy');
// The standalone agentapi wrapper may point at an obsolete renamed executable.
const executable=process.env.HUB_AGY_BINARY ?? (existsSync(installed)?installed:process.env.ANTIGRAVITY_AGENTAPI_EXE);
try {console.log(JSON.stringify(await registerAgy({...process.env,ANTIGRAVITY_AGENTAPI_EXE:executable})));}
catch(error){console.error(error instanceof Error?error.message:'Native registration failed');process.exitCode=1;}
