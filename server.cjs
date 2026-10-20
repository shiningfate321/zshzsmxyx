// 仅向本机提供这个目录中的静态文件。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const port = Number(process.env.PORT || 8765);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};
http.createServer((req,res)=>{
  let file;
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) {res.writeHead(403).end(); return;}
  } catch {res.writeHead(400).end(); return;}
  fs.readFile(file,(err,data)=>{
    if(err) {res.writeHead(404).end('Not found'); return;}
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store'});
    res.end(data);
  });
}).listen(port,'127.0.0.1',()=>console.log(`游戏已启动：http://127.0.0.1:${port}\n按 Ctrl+C 停止。`))
.on('error',err=>{console.error(err.message);process.exitCode=1;});
