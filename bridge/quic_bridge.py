# -*- coding: utf-8 -*-
"""quic_bridge.py - 本地 TCP -> HTTP/3(QUIC) 桥接服务（由 ammp 托管，一般无需手动运行）

背景：部分 API 域名在 TCP 上被防火墙阻断（TLS 握手明文 SNI 触发 RST），但同一服务在
HTTP/3(UDP/443) 上可用（QUIC 握手整体加密，看不到 SNI）。本服务在本机接收普通 HTTP
请求，改用 QUIC 转发到上游，响应（含 SSE 流式）原样回吐。

用法（由 server/bridge.js 自动拉起）：
    python quic_bridge.py --config <path/to/bridge.json>

配置（每请求实时读取，改动即时生效、无需重启）：
{
  "port": 8787,
  "routes": {
    "my-gateway": { "upstream": "https://upstream.example.com", "apiKey": "sk-...(可选，客户端未带鉴权时注入)" }
  }
}

路由规则：请求 http://127.0.0.1:<port>/<routeId>/<rest>  ->  <upstream>/<rest>
    例：/my-gateway/v1/chat/completions -> https://upstream.example.com/v1/chat/completions
内置端点：GET /__bridge/status -> 运行状态 JSON（无鉴权，仅本机可达）
"""
import argparse
import asyncio
import http.server
import json
import os
import ssl
import sys
import time
import urllib.parse

from aioquic.asyncio.client import connect
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import DataReceived, HeadersReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ConnectionTerminated

FIRST_EVENT_TIMEOUT = 60      # 等响应头
STREAM_IDLE_TIMEOUT = 600     # 流式数据块间隔
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}
_TERMINATED = object()
CONFIG_PATH = None
START_TIME = time.time()


def load_config():
    """每次请求实时读取配置：路由改动无需重启桥接"""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        return {"port": int(cfg.get("port", 8787)), "routes": cfg.get("routes") or {}}
    except Exception:
        return {"port": 8787, "routes": {}}


class _H3Client(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.h3 = None
        self.events = asyncio.Queue()

    def quic_event_received(self, event):
        if isinstance(event, ConnectionTerminated):
            self.events.put_nowait(_TERMINATED)
            return
        if self.h3 is None:
            self.h3 = H3Connection(self._quic)
        for ev in self.h3.handle_event(event):
            self.events.put_nowait(ev)


async def _forward(host, port, method, path, header_items, body, api_key, auth_style,
                   on_headers, on_data):
    cfg = QuicConfiguration(is_client=True, alpn_protocols=H3_ALPN,
                            idle_timeout=STREAM_IDLE_TIMEOUT)
    cfg.verify_mode = ssl.CERT_NONE
    async with connect(host, port, configuration=cfg,
                       create_protocol=_H3Client) as client:
        await client.wait_connected()
        if client.h3 is None:
            client.h3 = H3Connection(client._quic)
        sid = client._quic.get_next_available_stream_id()

        hdrs = [
            (b":method", method.encode()),
            (b":scheme", b"https"),
            (b":authority", host.encode()),
            (b":path", path.encode()),
        ]
        # 鉴权策略：路由里配了 key 就以它为准（客户端传什么都忽略——避免误填的 key 把请求打挂）；
        # 路由没配 key 时才透传客户端的鉴权头。
        strip_client_auth = bool(api_key)
        for k, v in header_items:
            lk = k.lower()
            if lk in HOP_BY_HOP or lk.startswith(":"):
                continue
            if lk in ("authorization", "x-api-key"):
                if strip_client_auth:
                    continue  # 路由 key 优先，丢弃客户端鉴权头
                vv = (v or "").strip()
                if not vv or vv.lower() in ("bearer", "bearer null", "null"):
                    continue  # 空/占位鉴权头不转发
            hdrs.append((lk.encode(), v.encode()))
        # 用路由配置的 key 注入鉴权（在桥接里配一次，客户端无需再配、也不会覆盖）
        if api_key:
            if auth_style == "x-api-key":
                hdrs.append((b"x-api-key", api_key.encode()))
                hdrs.append((b"anthropic-version", b"2023-06-01"))
            else:
                hdrs.append((b"authorization", b"Bearer " + api_key.encode()))
        if body:
            hdrs.append((b"content-length", str(len(body)).encode()))

        client.h3.send_headers(sid, hdrs, end_stream=not body)
        if body:
            client.h3.send_data(sid, body, end_stream=True)

        status = None
        first = True
        while True:
            timeout = FIRST_EVENT_TIMEOUT if first else STREAM_IDLE_TIMEOUT
            ev = await asyncio.wait_for(client.events.get(), timeout=timeout)
            first = False
            if ev is _TERMINATED:
                raise ConnectionError("upstream QUIC connection terminated")
            if isinstance(ev, HeadersReceived) and ev.stream_id == sid:
                if status is None:
                    st = 200
                    hs = []
                    for k, v in ev.headers:
                        if k == b":status":
                            st = int(v)
                        # H3 的头名是 bytes；必须先 decode 再比对，否则 HOP_BY_HOP 过滤不生效，
                        # 上游的 content-length/transfer-encoding 会和本服务补的 chunked 打架
                        elif k.decode("latin-1").lower() not in HOP_BY_HOP:
                            hs.append((k.decode("utf-8", "replace"),
                                       v.decode("utf-8", "replace")))
                    if 100 <= st < 200:
                        continue
                    status = st
                    on_headers(st, hs)
                    if ev.stream_ended:
                        break
            elif isinstance(ev, DataReceived) and ev.stream_id == sid:
                if ev.data:
                    on_data(bytes(ev.data))
                if ev.stream_ended:
                    break
        return status


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ammp-quic-bridge/2.0"

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))
        sys.stdout.flush()

    def _read_body(self):
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            body = b""
            while True:
                size_line = self.rfile.readline()
                if not size_line:
                    break
                size = int(size_line.strip().split(b";")[0] or b"0", 16)
                if size == 0:
                    while True:
                        t = self.rfile.readline()
                        if t in (b"\r\n", b"\n", b""):
                            break
                    break
                body += self.rfile.read(size)
                self.rfile.readline()
            return body
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n else b""

    def _send_json(self, code, obj):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()

    def _handle(self):
        cfg = load_config()
        parsed = urllib.parse.urlsplit(self.path)

        # 内置状态端点（供 ammp 探活）
        if parsed.path == "/__bridge/status":
            routes = {rid: (r.get("upstream") if isinstance(r, dict) else r)
                      for rid, r in cfg["routes"].items()}
            self._send_json(200, {
                "ok": True, "service": "ammp-quic-bridge", "pid": os.getpid(),
                "listenPort": int(self.server.server_address[1]),
                "uptimeSec": round(time.time() - START_TIME),
                "routes": routes,
            })
            return

        parts = parsed.path.lstrip("/").split("/", 1)
        route_id = parts[0]
        rest = ("/" + parts[1]) if len(parts) > 1 else ""
        if parsed.query:
            rest += "?" + parsed.query
        route = cfg["routes"].get(route_id)
        if not isinstance(route, dict) or not route.get("upstream"):
            self._send_json(404, {
                "error": "bridge: 未找到路由 '%s'" % route_id,
                "hint": "在 ammp 里给该 Provider 打开「走桥接」后重试",
            })
            return

        up = urllib.parse.urlsplit(route["upstream"])
        host = up.hostname
        port = up.port or 443
        # 上游基础路径（如 /v1）：upstream 自身带就用它，否则取 originalBaseUrl 的路径。
        # 客户端 BaseURL 可能写到 /v1 为止，也可能只写到 /<routeId>：后者要自动补上基础路径，
        # 否则会把 /chat/completions 直接打到上游根路径而 404。
        base_path = up.path.rstrip("/")
        if not base_path:
            orig = route.get("originalBaseUrl")
            if isinstance(orig, str) and orig:
                try:
                    base_path = urllib.parse.urlsplit(orig).path.rstrip("/")
                except Exception:
                    base_path = ""
        if base_path and not (rest == base_path or rest.startswith(base_path + "/")):
            target_path = base_path + rest
        else:
            target_path = rest
        if not target_path.startswith("/"):
            target_path = "/" + target_path

        header_items = list(self.headers.items())
        body = self._read_body()
        state = {"headers_sent": False}

        # 路由配置的鉴权：明文 apiKey，或 apiKeyEnv（运行时从环境变量取值，避免明文落盘）
        route_key = route.get("apiKey")
        if not route_key and route.get("apiKeyEnv"):
            route_key = os.environ.get(route["apiKeyEnv"])
        auth_style = route.get("authStyle") or "bearer"

        def on_headers(status, headers):
            self.send_response(status)
            for k, v in headers:
                self.send_header(k, v)
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            state["headers_sent"] = True

        def on_data(chunk):
            self.wfile.write(("%X\r\n" % len(chunk)).encode() + chunk + b"\r\n")
            self.wfile.flush()

        self.close_connection = True
        last_err = None
        for attempt in (1, 2):
            try:
                asyncio.run(_forward(host, port, self.command, target_path,
                                     header_items, body, route_key, auth_style,
                                     on_headers, on_data))
                last_err = None
                break
            except Exception as e:
                last_err = e
                if state["headers_sent"] or attempt == 2:
                    break
                time.sleep(0.6)          # 上游 QUIC 偶发抖动 -> 重试一次
        if last_err is None and state["headers_sent"]:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        elif last_err is None:
            self._send_json(502, {"error": "bridge: 上游无响应"})
        else:
            msg = "bridge error: %s: %s" % (type(last_err).__name__, last_err)
            self.log_message("%s %s -> %s", self.command, self.path, msg)
            try:
                if not state["headers_sent"]:
                    self._send_json(502, {"error": msg})
            except Exception:
                pass

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _handle


def main():
    global CONFIG_PATH
    ap = argparse.ArgumentParser(description="Local TCP -> HTTP/3 bridge (managed by ammp)")
    ap.add_argument("--config", required=True, help="bridge.json 路径")
    ap.add_argument("--port", type=int, default=None, help="覆盖配置里的端口")
    args = ap.parse_args()
    CONFIG_PATH = args.config
    port = args.port or load_config()["port"]

    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    srv = Server(("127.0.0.1", port), BridgeHandler)
    print("ammp-quic-bridge listening on http://127.0.0.1:%d (routes live from %s)"
          % (port, CONFIG_PATH))
    sys.stdout.flush()
    srv.serve_forever()


if __name__ == "__main__":
    main()

