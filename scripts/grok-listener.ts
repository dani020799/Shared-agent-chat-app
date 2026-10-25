import { runGrokListener } from '../shared/grok-monitor.ts';

const socket=process.argv[2];
if(!socket)process.exit(1);
try{await runGrokListener(socket);}catch{process.exitCode=1;}
