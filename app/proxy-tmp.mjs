import http from 'node:http';
const HOST = '5173-iot84gke8ixvahgmlef4i.e2b.app';
http.createServer((req, res) => {
  const p = http.request({ host:'127.0.0.1', port:5173, path:req.url, method:req.method,
    headers:{ ...req.headers, host: HOST } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  p.on('error', e => { res.writeHead(502); res.end(String(e)); });
  req.pipe(p);
}).listen(7777,'0.0.0.0');
