#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""bridge/vector_worker.py — 常驻向量 worker（阶段 A）。

协议：一行一条 JSON，stdin 进 stdout 出（`--relay REQ RES` 时改成轮询两个文件，供不能开管道的受限环境用）。

请求：{"id":1,"op":"query","text":"复习节奏","n":20,"statuses":["active"],"expected_count":20,"config":{...}}
响应：{"id":1,"ok":true,"hits":[{"id":"f-2026...","distance":0.23}],"count":20,"ms":31}

op：query / upsert / rebuild / stat / warmup / shutdown

设计（阶段 A）：
- 整条笔记一个 chunk：document = title + "\\n" + body，id 与 FTS 同 id，不切块。
- collection metadata 记录 schema / model / digest / dim / normalize=l2 / query_prefix /
  doc_prefix / chromadb 版本 / 解释器路径；启动时与当前配置比对，不一致即 stale（调用方降级 FTS）。
  Chroma 的 get_or_create 会静默保留旧 metadata，所以这里一律先 get_collection 再人工比对。
- 查询默认加 Qwen3-Embedding 官方 instruction 前缀，可按请求关掉（config.query_prefix=""）。
- 只读调用 `ollama_ai` 环境，不安装任何包；任何失败都返回 ok:false，不抛给调用方。
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback

SCHEMA = 1
COLLECTION = "notes"
DEFAULT_MODEL = "dengcao/Qwen3-Embedding-0.6B:Q8_0"
DEFAULT_DIM = 1024
DEFAULT_OLLAMA = "http://127.0.0.1:11434"
DEFAULT_QUERY_PREFIX = (
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: "
)
DEFAULT_IDLE_MS = 600000
META_FIELDS = [
    "schema", "model", "digest", "dim", "normalize",
    "query_prefix", "doc_prefix", "chromadb", "python",
]

_entries = {}
_digest_cache = {}


class OpError(Exception):
    """带机器可读 reason 的失败；调用方据此静默降级。"""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail or reason


# ---------------------------------------------------------------- 配置

def _cfg(req):
    raw = dict(req.get("config") or {})
    directory = raw.get("dir") or os.environ.get("MEM_VECTOR_DIR") or ""
    if not directory:
        raise OpError("bad_config", "缺少向量目录（config.dir）")
    prefix = raw.get("query_prefix")
    return {
        "dir": os.path.abspath(directory),
        "model": str(raw.get("model") or DEFAULT_MODEL),
        "dim": int(raw.get("dim") or DEFAULT_DIM),
        "ollama": str(raw.get("ollama") or DEFAULT_OLLAMA).rstrip("/"),
        "query_prefix": DEFAULT_QUERY_PREFIX if prefix is None else str(prefix),
        "doc_prefix": str(raw.get("doc_prefix") or ""),
        "collection": str(raw.get("collection") or COLLECTION),
        "embed_timeout_s": float(raw.get("embed_timeout_s") or 120),
    }


# ---------------------------------------------------------------- 依赖

def _chromadb():
    try:
        import chromadb
        return chromadb
    except Exception as exc:  # pragma: no cover - 环境缺失时才走到
        raise OpError("chromadb_missing", f"{type(exc).__name__}: {exc}")


def _requests():
    try:
        import requests
        return requests
    except Exception as exc:  # pragma: no cover
        raise OpError("requests_missing", f"{type(exc).__name__}: {exc}")


def _model_digest(cfg):
    """Ollama 模型 digest；取不到（离线/模型不在）返回 None，不当作失败。"""
    model = cfg["model"]
    now = time.time()
    cached = _digest_cache.get(model)
    if cached and now < cached[1]:
        return cached[0]
    digest = None
    try:
        resp = _requests().get(f"{cfg['ollama']}/api/tags", timeout=5)
        if resp.status_code == 200:
            for item in resp.json().get("models") or []:
                if item.get("name") == model or item.get("model") == model:
                    digest = item.get("digest") or None
                    break
    except Exception:
        digest = None
    _digest_cache[model] = (digest, now + (300 if digest else 60))
    return digest


def _expected_meta(cfg, digest, chromadb):
    return {
        "schema": SCHEMA,
        "model": cfg["model"],
        "digest": digest or "",
        "dim": int(cfg["dim"]),
        "normalize": "l2",
        "query_prefix": cfg["query_prefix"],
        "doc_prefix": cfg["doc_prefix"],
        "chromadb": str(getattr(chromadb, "__version__", "")),
        "python": sys.executable,
    }


def _diff_meta(stored, expected):
    """只比对硬字段；digest 取不到时跳过（离线也要能用旧库）。"""
    stored = dict(stored or {})
    diffs = []
    for field in META_FIELDS:
        want = expected.get(field)
        got = stored.get(field)
        if field == "digest" and not want:
            continue
        if field == "python":
            if not got or os.path.normcase(str(got)) != os.path.normcase(str(want)):
                diffs.append(field)
            continue
        if got != want:
            diffs.append(field)
    return diffs


def _ensure(cfg, force_rebuild=False):
    """拿到 collection，并带上 metadata 校验结果；不缓存失败状态以外的东西。"""
    key = (cfg["dir"], cfg["model"], cfg["collection"])
    if not force_rebuild and key in _entries:
        return _entries[key]

    chromadb = _chromadb()
    os.makedirs(cfg["dir"], exist_ok=True)
    client = chromadb.PersistentClient(path=cfg["dir"])
    expected = _expected_meta(cfg, _model_digest(cfg), chromadb)
    collection = None
    if force_rebuild:
        try:
            client.delete_collection(cfg["collection"])
        except Exception:
            pass
    else:
        try:
            collection = client.get_collection(cfg["collection"])
        except Exception:
            collection = None

    created = collection is None
    if created:
        collection = client.create_collection(
            name=cfg["collection"],
            metadata=expected,
            configuration={"hnsw": {"space": "cosine"}},
            embedding_function=None,
        )
        stale_fields = []
    else:
        stale_fields = _diff_meta(collection.metadata, expected)

    entry = {
        "dir": cfg["dir"],
        "client": client,
        "collection": collection,
        "expected": expected,
        "stale_fields": stale_fields,
        "stale": bool(stale_fields),
        "created": created,
        "digest": expected["digest"],
    }
    _entries[key] = entry
    return entry


# ---------------------------------------------------------------- 嵌入

def _embed(texts, cfg, prefix=""):
    """走 Ollama /api/embed；返回原始向量（未归一化）。"""
    if not texts:
        return []
    requests = _requests()
    url = f"{cfg['ollama']}/api/embed"
    batch = 16
    out = []
    for start in range(0, len(texts), batch):
        chunk = [f"{prefix}{text}" for text in texts[start:start + batch]] if prefix else list(texts[start:start + batch])
        try:
            resp = requests.post(
                url,
                json={"model": cfg["model"], "input": chunk},
                timeout=cfg["embed_timeout_s"],
            )
        except Exception as exc:
            raise OpError("ollama_unavailable", f"{type(exc).__name__}: {exc}")
        if resp.status_code != 200:
            raise OpError("ollama_error", f"HTTP {resp.status_code}: {resp.text[:200]}")
        try:
            vectors = resp.json().get("embeddings")
        except Exception as exc:
            raise OpError("ollama_error", f"返回不是 JSON：{exc}")
        if not isinstance(vectors, list) or len(vectors) != len(chunk):
            raise OpError("ollama_error", f"向量条数不符：{len(vectors or [])} != {len(chunk)}")
        out.extend(vectors)
    return out


def _prepare(vectors, cfg):
    """维度校验 + L2 归一化（collection 用 cosine 空间，归一化后 distance = 1 - cos）。"""
    if not vectors:
        return []
    try:
        import numpy as np
    except Exception as exc:  # pragma: no cover
        raise OpError("numpy_missing", f"{type(exc).__name__}: {exc}")
    arr = np.asarray(vectors, dtype=np.float32)
    if arr.ndim != 2:
        raise OpError("embed_failed", f"向量维度异常：{arr.shape}")
    dim = int(cfg["dim"])
    if arr.shape[1] != dim:
        raise OpError("dim_mismatch", f"实际 {arr.shape[1]} 维，配置 {dim} 维")
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (arr / norms).tolist()


def _where(statuses):
    values = [str(s) for s in (statuses or []) if s]
    if not values:
        return None
    return {"status": {"$in": values}}


def _meta_of(note):
    channel = note.get("channel")
    try:
        channel = int(channel or 0)
    except Exception:
        channel = 0
    return {
        "path": str(note.get("path") or ""),
        "title": str(note.get("title") or "")[:500],
        "channel": channel,
        "status": str(note.get("status") or "active"),
        "updated_at": str(note.get("updated_at") or ""),
    }


def _write_notes(collection, notes, cfg):
    """按 id 去重后批量 upsert；document 与 id 都和 FTS 对齐。"""
    unique = {}
    for note in notes or []:
        note_id = str(note.get("id") or "")
        if note_id:
            unique[note_id] = note
    ids = list(unique.keys())
    if not ids:
        return 0
    documents = [str(unique[i].get("text") or "") for i in ids]
    prefix = cfg["doc_prefix"]
    embed_inputs = [f"{prefix}{text}" for text in documents] if prefix else documents
    vectors = _prepare(_embed(embed_inputs, cfg), cfg)
    collection.upsert(
        ids=ids,
        embeddings=vectors,
        documents=documents,
        metadatas=[_meta_of(unique[i]) for i in ids],
    )
    return len(ids)


# ---------------------------------------------------------------- ops

def op_query(req):
    cfg = _cfg(req)
    entry = _ensure(cfg)
    if entry["stale"]:
        return {
            "ok": False, "stale": True, "reason": "metadata_mismatch",
            "detail": "collection metadata 与当前配置不一致，需 --rebuild",
            "stale_fields": entry["stale_fields"], "count": entry["collection"].count(),
        }
    collection = entry["collection"]
    count = collection.count()
    expected = req.get("expected_count")
    if expected is not None:
        try:
            expected = int(expected)
        except Exception:
            expected = None
    if expected is not None and expected != count:
        return {
            "ok": False, "reason": "count_mismatch", "stale": False,
            "detail": f"collection {count} 条，索引 {expected} 条，需 --rebuild",
            "count": count, "expected": expected,
        }

    text = str(req.get("text") or "")
    if not text.strip() or count <= 0:
        return {"ok": True, "hits": [], "count": count, "stale": False}

    prefix = cfg["query_prefix"] if req.get("query_prefix", True) else ""
    vector = _prepare(_embed([text], cfg, prefix), cfg)
    n = max(1, min(int(req.get("n") or 20), count))
    try:
        result = collection.query(
            query_embeddings=vector,
            n_results=n,
            where=_where(req.get("statuses")),
            include=["distances"],
        )
    except Exception as exc:
        raise OpError("chroma_query_failed", f"{type(exc).__name__}: {exc}")

    ids = (result.get("ids") or [[]])[0] or []
    distances = (result.get("distances") or [[]])[0] or []
    hits = []
    for note_id, distance in zip(ids, distances):
        try:
            value = float(distance)
        except Exception:
            continue
        if value < 0:
            value = 0.0
        hits.append({"id": str(note_id), "distance": round(value, 6)})
    return {"ok": True, "hits": hits, "count": count, "stale": False}


def op_upsert(req, rebuild=False):
    cfg = _cfg(req)
    notes = req.get("notes") or []
    if rebuild:
        entry = _ensure(cfg, force_rebuild=True)
    else:
        entry = _ensure(cfg)
        if entry["stale"]:
            return {
                "ok": False, "stale": True, "reason": "metadata_mismatch",
                "detail": "collection metadata 不一致，需 --rebuild",
                "stale_fields": entry["stale_fields"],
            }
    collection = entry["collection"]
    written = _write_notes(collection, notes, cfg)
    return {
        "ok": True, "count": collection.count(), "written": written,
        "stale": False, "rebuilt": bool(rebuild), "dir": cfg["dir"],
    }


def op_stat(req):
    cfg = _cfg(req)
    entry = _ensure(cfg)
    count = entry["collection"].count()
    return {
        "ok": True,
        "count": count,
        "stale": entry["stale"],
        "stale_fields": entry["stale_fields"],
        "metadata": dict(entry["collection"].metadata or {}),
        "expected": entry["expected"],
        "dir": cfg["dir"],
        "collection": cfg["collection"],
        "model": cfg["model"],
    }


def op_warmup(req):
    cfg = _cfg(req)
    entry = _ensure(cfg)
    if entry["stale"]:
        return {
            "ok": False, "stale": True, "reason": "metadata_mismatch",
            "stale_fields": entry["stale_fields"],
        }
    text = "预热：向量通道是否可用"
    _prepare(_embed([text], cfg, cfg["doc_prefix"]), cfg)
    return {
        "ok": True, "count": entry["collection"].count(), "stale": False,
        "model": cfg["model"], "digest": entry["digest"], "dir": cfg["dir"],
    }


def _handle(req):
    op = str(req.get("op") or "")
    started = time.time()
    try:
        if op == "query":
            out = op_query(req)
        elif op == "upsert":
            out = op_upsert(req, rebuild=False)
        elif op == "rebuild":
            out = op_upsert(req, rebuild=True)
        elif op == "stat":
            out = op_stat(req)
        elif op == "warmup":
            out = op_warmup(req)
        elif op == "shutdown":
            out = {"ok": True}
        else:
            out = {"ok": False, "reason": "unknown_op", "detail": op}
    except OpError as exc:
        out = {"ok": False, "reason": exc.reason, "detail": exc.detail}
    except Exception as exc:  # 兜底：worker 不因为单条请求崩掉
        out = {
            "ok": False,
            "reason": "worker_error",
            "detail": f"{type(exc).__name__}: {exc}",
            "trace": traceback.format_exc()[-1200:],
        }
    out["id"] = req.get("id")
    out["op"] = op
    out["ms"] = int((time.time() - started) * 1000)
    return out


# ---------------------------------------------------------------- 传输

def _write_stdout(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _append_file(path, payload):
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        handle.flush()


def _serve_stdio():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            _write_stdout({"ok": False, "reason": "bad_json", "detail": str(exc)})
            continue
        out = _handle(req)
        _write_stdout(out)
        if req.get("op") == "shutdown":
            return


def _serve_relay(req_path, res_path, idle_ms):
    """受限环境（父进程不能开管道）用：轮询请求文件，响应追加到响应文件。"""
    offset = 0
    buffer = ""
    last_seen = time.time()
    missing_since = None
    while True:
        try:
            size = os.path.getsize(req_path)
            missing_since = None
        except OSError:
            size = 0
            if missing_since is None:
                missing_since = time.time()
            elif time.time() - missing_since > 5:
                return
        if size > offset:
            with open(req_path, "rb") as handle:
                handle.seek(offset)
                chunk = handle.read()
            offset += len(chunk)
            buffer += chunk.decode("utf-8", "replace")
            last_seen = time.time()
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception as exc:
                _append_file(res_path, {"ok": False, "reason": "bad_json", "detail": str(exc)})
                continue
            _append_file(res_path, _handle(req))
            last_seen = time.time()
            if req.get("op") == "shutdown":
                return
        if time.time() - last_seen > idle_ms / 1000.0:
            return
        time.sleep(0.005)


def main(argv):
    args = list(argv)
    log_path = None
    if "--log" in args:
        log_path = args[args.index("--log") + 1]
    if log_path:
        try:
            sys.stderr = open(log_path, "a", encoding="utf-8", newline="\n")
        except Exception:
            pass
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    idle_ms = DEFAULT_IDLE_MS
    if "--idle-ms" in args:
        try:
            idle_ms = int(args[args.index("--idle-ms") + 1])
        except Exception:
            pass
    if "--relay" in args:
        start = args.index("--relay")
        _serve_relay(args[start + 1], args[start + 2], idle_ms)
    else:
        _serve_stdio()


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception:
        try:
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
        except Exception:
            pass
        raise
