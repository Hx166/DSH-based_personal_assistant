#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""test/fixtures/fake_vector_worker.py — 测试用的假向量 worker。

协议与 bridge/vector_worker.py 相同（stdio 一行一条 JSON，也支持 --relay），
用环境变量摆出各种故障姿态，让测试不依赖 Ollama / ChromaDB：

  FAKE_HITS       query 返回的命中 JSON，例如 [{"id":"f-1","distance":0.1}]
  FAKE_COUNT      stat/query 报告的 collection 条数
  FAKE_REASON     强制返回 ok:false 的 reason（例如 metadata_mismatch）
  FAKE_STALE      1 时 stale:true
  FAKE_DELAY_MS   每条请求先睡多久（模拟超时）
  FAKE_OP_LOG     把收到的每条请求（一行 JSON）追加到这个文件，供测试核对 ops
"""

import json
import os
import sys
import time


def _record(req):
    log_path = os.environ.get("FAKE_OP_LOG")
    if not log_path:
        return
    try:
        with open(log_path, "a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(req, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _payload(req):
    _record(req)
    op = req.get("op") or ""
    delay = float(os.environ.get("FAKE_DELAY_MS") or 0) / 1000.0
    if delay:
        time.sleep(delay)
    stale = os.environ.get("FAKE_STALE") == "1"
    count = int(os.environ.get("FAKE_COUNT") or 0)
    reason = os.environ.get("FAKE_REASON") or ""
    if reason:
        return {"id": req.get("id"), "op": op, "ok": False, "reason": reason, "stale": stale, "count": count}
    if op == "query":
        hits = json.loads(os.environ.get("FAKE_HITS") or "[]")
        return {"id": req.get("id"), "op": op, "ok": True, "hits": hits, "count": count, "stale": False}
    if op in ("upsert", "rebuild"):
        notes = req.get("notes") or []
        return {"id": req.get("id"), "op": op, "ok": True, "count": len(notes), "written": len(notes),
                "stale": False, "rebuilt": op == "rebuild"}
    if op == "stat":
        return {"id": req.get("id"), "op": op, "ok": True, "count": count, "stale": stale, "stale_fields": []}
    if op == "warmup":
        return {"id": req.get("id"), "op": op, "ok": True, "count": count, "stale": False}
    if op == "shutdown":
        return {"id": req.get("id"), "op": op, "ok": True}
    return {"id": req.get("id"), "op": op, "ok": False, "reason": "unknown_op"}


def serve_stdio():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        sys.stdout.write(json.dumps(_payload(req), ensure_ascii=False) + "\n")
        sys.stdout.flush()
        if req.get("op") == "shutdown":
            return


def serve_relay(req_path, res_path, idle_ms):
    offset = 0
    buffer = ""
    last = time.time()
    while True:
        try:
            size = os.path.getsize(req_path)
        except OSError:
            return
        if size > offset:
            with open(req_path, "rb") as handle:
                handle.seek(offset)
                chunk = handle.read()
            offset += len(chunk)
            buffer += chunk.decode("utf-8", "replace")
            last = time.time()
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line:
                continue
            req = json.loads(line)
            with open(res_path, "a", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(_payload(req), ensure_ascii=False) + "\n")
            last = time.time()
            if req.get("op") == "shutdown":
                return
        if time.time() - last > idle_ms / 1000.0:
            return
        time.sleep(0.005)


def main(argv):
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    idle_ms = 600000
    if "--idle-ms" in argv:
        idle_ms = int(argv[argv.index("--idle-ms") + 1])
    if "--relay" in argv:
        index = argv.index("--relay")
        serve_relay(argv[index + 1], argv[index + 2], idle_ms)
    else:
        serve_stdio()


if __name__ == "__main__":
    main(sys.argv[1:])
