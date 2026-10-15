import { resolve } from 'node:path';
import { config, dataDir } from '../../shared/config.ts';
import { Store } from '../../shared/store.ts';
import { createHub } from './server.ts';
const store = new Store(resolve(dataDir,'hub.sqlite')); store.recover();
const hub = createHub(store,config());
const host = process.env.HUB_BIND ?? '127.0.0.1', port = Number(process.env.HUB_PORT ?? 4310);
hub.server.listen(port,host,()=>console.log(`Conversation service listening on ${host}:${port}`));
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{hub.closeStreams(); hub.server.close(()=>{store.close();process.exit(0);});});
