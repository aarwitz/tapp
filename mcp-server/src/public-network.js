import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";

function publicIPv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [a,b,c] = value.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export async function resolvePublicHost(host) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || /\.(localhost|local|internal|test|invalid)$/.test(normalized)) throw new Error("A publicly reachable app hostname is required");
  const addresses = net.isIP(normalized) ? [{address:normalized}] : await dns.lookup(normalized,{all:true,family:4});
  if (!addresses.length || addresses.some(item=>!publicIPv4(item.address))) throw new Error("Private and reserved network addresses are unavailable to hosted website runs");
  return addresses[0].address;
}
export async function publicRequest(url, {method="POST",headers={},body,timeout=15000}={}) {
  const target = new URL(url);
  if(target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443")) throw new Error("Backend actions require public HTTPS on port 443");
  const address=await resolvePublicHost(target.hostname);
  return new Promise((resolve,reject)=>{
    const req=https.request(target,{method,headers,family:4,lookup:(_host,options,callback)=>options.all ? callback(null,[{address,family:4}]) : callback(null,address,4)},response=>{
      let size=0; const chunks=[];
      response.on("data",chunk=>{size+=chunk.length;if(size>262144) {response.destroy();req.destroy(new Error("Backend response exceeded 256 KiB"));}else chunks.push(chunk);});
      response.on("error",reject);
      response.on("end",()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString("utf8")}));
    });
    req.on("error",reject);req.setTimeout(timeout,()=>req.destroy(new Error("Backend action timed out")));
    if(body)req.write(body);req.end();
  });
}

/**
 * A read-only GET the hosted Studio may make on a visitor's behalf (a brand's surfaces, ADR-0013):
 * every hop resolves to a public address and connects to that address — a name that answers
 * public first and private on the real connection gets nowhere. Follows a few redirects, each
 * resolved again; reads at most half a megabyte; never sends credentials.
 */
export async function publicGet(url, { timeout = 10_000, maxBytes = 512 * 1024, redirects = 3, headers = {} } = {}) {
  let target = new URL(url);
  for (let hop = 0; ; hop += 1) {
    if (!/^https?:$/.test(target.protocol) || target.username || target.password) throw new Error("A public http(s) address is required");
    if (target.port && target.port !== (target.protocol === "https:" ? "443" : "80")) throw new Error("Only the standard port is reachable from the hosted Studio");
    const address = await resolvePublicHost(target.hostname);
    const transport = target.protocol === "https:" ? https : http;
    const answer = await new Promise((resolve, reject) => {
      const req = transport.request(target, {
        method: "GET", family: 4,
        headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 tapp/1", accept: "text/html,application/json;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.8", ...headers },
        lookup: (_host, options, callback) => options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
      }, (response) => {
        let size = 0; const chunks = [];
        response.on("data", (chunk) => { if (size >= maxBytes) return; size += chunk.length; chunks.push(chunk); if (size >= maxBytes) response.destroy(); });
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
        response.on("close", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.setTimeout(timeout, () => req.destroy(new Error("The page did not answer in time")));
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(answer.status) && answer.headers.location && hop < redirects) {
      target = new URL(answer.headers.location, target);
      continue;
    }
    return { status: answer.status, url: target.href, text: answer.text };
  }
}

// Resolve and pin every TCP connection, including redirects and subresources.
// This proxy is for URL-only work; it deliberately cannot reach local dev servers.
export async function startPublicBrowserProxy() {
  const sockets=new Set();
  const track=socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));socket.on("error",()=>{});return socket;};
  const server=http.createServer(async (request,response)=>{
    try{
      const url=new URL(request.url);
      if(url.protocol!=="http:" || (url.port && url.port!=="80") || url.username || url.password) throw new Error();
      const address=await resolvePublicHost(url.hostname);
      const headers={...request.headers,host:url.host};delete headers["proxy-authorization"];delete headers["proxy-connection"];
      const outgoing=http.request({host:address,port:80,path:url.pathname+url.search,method:request.method,headers},remote=>{response.writeHead(remote.statusCode,remote.headers);remote.pipe(response);});
      outgoing.on("socket",track);outgoing.setTimeout(30000,()=>outgoing.destroy());outgoing.on("error",()=>{if(!response.headersSent)response.writeHead(502);response.end();});
      request.on("aborted",()=>outgoing.destroy());request.pipe(outgoing);
    }catch{response.writeHead(403);response.end("Public network access required");}
  });
  server.on("connection",track);
  server.on("connect",async (request,socket,head)=>{
    try{
      const target=new URL(`https://${request.url}`);
      if(target.port && target.port!=="443")throw new Error();
      const address=await resolvePublicHost(target.hostname);
      const upstream=track(net.connect(443,address,()=>{socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);}));
      upstream.setTimeout(120000,()=>upstream.destroy());socket.on("close",()=>upstream.destroy());upstream.on("close",()=>socket.destroy());
    }catch{socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");}
  });
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  return {url:`http://127.0.0.1:${server.address().port}`,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
