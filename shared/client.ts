export async function call(base: string, token: string, path: string, data?: unknown) {
  const response = await fetch(base+path,{
    method:data === undefined ? 'GET' : 'POST',
    headers:{Authorization:`Bearer ${token}`,...(data === undefined ? {} : {'Content-Type':'application/json'})},
    body:data === undefined ? undefined : JSON.stringify(data), signal:AbortSignal.timeout(15_000),
  });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
export async function subscribe(base:string,token:string,signal:AbortSignal,onEvent:(type:string,data:any)=>void|Promise<void>) {
  const res = await fetch(base+'/events',{headers:{Authorization:`Bearer ${token}`},signal});
  if (!res.ok || !res.body) throw new Error(`Event stream HTTP ${res.status}`);
  const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    while(true) {
      const {value,done} = await reader.read(); if(done) throw new Error('Event stream closed');
      buffer += decoder.decode(value,{stream:true});
      if(buffer.length > 256_000) throw new Error('Event frame too large');
      let at;
      while((at=buffer.indexOf('\n\n'))>=0) {
        const frame=buffer.slice(0,at); buffer=buffer.slice(at+2);
        const type=frame.split('\n').find(line=>line.startsWith('event: '))?.slice(7);
        const data=frame.split('\n').find(line=>line.startsWith('data: '))?.slice(6);
        if(type && data) await onEvent(type,JSON.parse(data));
      }
    }
  } finally { await reader.cancel().catch(()=>{}); }
}
