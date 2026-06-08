#!/usr/bin/env python3
"""
Pionex CORS Proxy — 解決瀏覽器直連 Pionex API 的 CORS 限制
啟動後在 http://127.0.0.1:8001 監聽，將 /pionex/* 轉發至 api.pionex.com
"""
import sys
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler

PIONEX_BASE = 'https://api.pionex.com'
PORT = 8001

CORS_HEADERS = [
    ('Access-Control-Allow-Origin', '*'),
    ('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'),
    ('Access-Control-Allow-Headers',
     'Content-Type, X-PIONEX-KEY, X-PIONEX-SIGNATURE, X-PIONEX-TIMESTAMP'),
]

FORWARD_HEADERS = [
    'Content-Type', 'X-PIONEX-KEY', 'X-PIONEX-SIGNATURE', 'X-PIONEX-TIMESTAMP',
]

class PionexProxy(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f'[Proxy] {self.command} {self.path} → {args[1] if len(args) > 1 else ""}')

    def _send_cors(self, status, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        for k, v in CORS_HEADERS:
            self.send_header(k, v)
        self.end_headers()

    def do_OPTIONS(self):
        self._send_cors(204, 'text/plain')

    def do_GET(self):    self._proxy()
    def do_POST(self):   self._proxy()
    def do_DELETE(self): self._proxy()

    def _proxy(self):
        if not self.path.startswith('/pionex'):
            self._send_cors(404)
            self.wfile.write(b'{"result":false,"message":"not found"}')
            return

        target = PIONEX_BASE + self.path[7:]  # 去掉 /pionex 前綴
        length = int(self.headers.get('Content-Length', 0) or 0)
        body   = self.rfile.read(length) if length else None

        req_headers = {k: self.headers[k] for k in FORWARD_HEADERS if self.headers.get(k)}
        req = urllib.request.Request(target, data=body, headers=req_headers, method=self.command)

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                self._send_cors(resp.status)
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self._send_cors(e.code)
            self.wfile.write(data)
        except Exception as ex:
            self._send_cors(502)
            self.wfile.write(f'{{"result":false,"message":"{ex}"}}'.encode())


if __name__ == '__main__':
    server = HTTPServer(('127.0.0.1', PORT), PionexProxy)
    print(f'✅  Pionex 代理伺服器啟動 → http://127.0.0.1:{PORT}')
    print('   瀏覽器端的 Pionex API 請求將自動透過此代理發送')
    print('   按 Ctrl+C 停止\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')
        sys.exit(0)
