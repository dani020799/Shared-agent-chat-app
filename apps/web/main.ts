import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../../shared/config.ts';
import { body, failure } from '../../shared/http.ts';
import { HubError } from '../../shared/store.ts';
const secrets=config(),base=process.env.HUB_URL ?? 'http://127.0.0.1:4310';
const assets:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
const routes=new Set(['rooms','room','messages','pause','retry','events','delete-room']);
const server=createServer(async(req,res)=>{
  try {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy','no-referrer');
    const url=new URL(req.url!,'http://localhost');
    if(req.method==='GET' && assets[url.pathname]) {
      const [name,type]=assets[url.pathname];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-cache'});
      res.end(readFileSync(fileURLToPath(new URL('./public/'+name,import.meta.url))));return;
    }
    if(req.method!=='GET') {
      const expected=process.env.HUB_WEB_ORIGIN ?? `http://${req.headers.host}`;
      if(req.headers.origin!==expected) throw new HubError('Origin rejected',403);
    }
    const route=url.pathname.replace('/api/','');
    if(!url.pathname.startsWith('/api/')||!routes.has(route))throw new HubError('Not found',404);
    const abort=new AbortController();res.on('close',()=>abort.abort());
    const upstream=await fetch(`${base}/admin/${route}${url.search}`,{method:req.method,headers:{Authorization:`Bearer ${secrets.adminToken}`,'Content-Type':'application/json'},body:req.method==='POST'?JSON.stringify(await body(req)):undefined,signal:abort.signal});
    res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')??'application/json','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    if(upstream.body)for await(const chunk of upstream.body as any) {if(res.destroyed)break;if(!res.write(chunk))await new Promise<void>(resolve=>{res.once('drain',resolve);res.once('close',resolve);});}
    res.end();
  }catch(error){if(!res.destroyed)failure(res,error);}
});
const port=Number(process.env.HUB_WEB_PORT??4311),host=process.env.HUB_WEB_BIND??'127.0.0.1';
server.listen(port,host,()=>console.log(`Web interface: http://${host}:${(server.address() as {port:number}).port}`));
