# action — 记忆桥（Vault + SQLite FTS5 + 向量/RRF + MCP）

阶段：W1 第三步 + 检索层改造阶段 A。桥核心、MCP 壳（6 个工具）、状态简报、会话收尾、备份/维护脚本都已就绪；**阶段 A 已接入向量通道（Chroma + Ollama 嵌入）与 RRF 融合，默认 auto、失败静默降级纯 FTS**。DSH 的 profile 条目还没装（install 已在配置副本上验证，真机安装要一次重启窗口）。

## 目录

```
action/
  bridge/
    vault.mjs       Markdown 读写：扁平 frontmatter、checksum、auto 区替换、moveNote、目录扫描
    index.mjs       SQLite FTS5(trigram) 索引：重建/增量/候选检索（<3 字 LIKE 兜底）、按 id 回填
    recall.mjs      召回核心：切词、别名展开、FTS+向量候选、通道配额、2400 字符裁剪、<memory> 包装
    fuse.mjs        RRF 融合与候选准入/排序（无向量时逐字节复现旧排序）
    vector.mjs      向量 worker 生命周期：懒启动、超时、闲置退出、静默降级、索引→向量同步
    vector_worker.py 常驻向量 worker（stdio 一行一条 JSON）：Chroma + Ollama 嵌入，6 个 op
    recall-cli.mjs  命令行入口：参数解析、trace、输出
    eval.mjs        评测：golden 集 × 仅 FTS5 / FTS+向量+RRF 两模式，输出 T1–T6 表
    capture.mjs     写入管线：亲述判定、打码、摘要、查重、supersede、文件溯源
    confirm.mjs     draft 队列：list / confirm / discard / 超期清理
    brief.mjs       状态简报：六段式、覆盖写、历史快照
    close.mjs       会话收尾三分类：留 / 缓 / 丢
    handlers.mjs    MCP 工具定义与实现（server.mjs 只留协议）
    trace.mjs       每轮 JSONL trace（查询先打码）
  server.mjs        MCP stdio 壳：协议与进程入口
  deploy/
    mcp.patch.yml   配置模板（占位符）
    install.mjs     合并进 profile：先备份、写 manifest、重复安装拒绝
    rollback.mjs    按 manifest 恢复
    smoke.mjs       握手 + 列工具 + 一次 recall
    backup.mjs      Vault zip 快照（零依赖写 ZIP，保留 7 天）
    maintain.mjs    每日维护：超期 draft → 索引重建 → 快照
  golden/v1.jsonl   20 条评测集（T1 事实 / T2 更新 / T3 时间 / T4 多跳 / T5 拒答 / T6 干扰）
  test/
    acceptance.mjs  索引与召回验收
    capture.test.mjs 写入管线
    mcp.test.mjs    MCP 壳
    step3.test.mjs  简报 / 收尾 / 快照
    vector.test.mjs 阶段 A：RRF 纯函数、FTS-only 等价、降级链（假 worker + 真 chromadb）
    fixtures/vault  20 条样例笔记（真实 vault 保持干净）
    fixtures/fake_vector_worker.py 测试用假 worker（不依赖 Ollama/ChromaDB）
```

## 命令

开发期一律显式带 `--vault test\fixtures\vault`，避免误用空的真实库。

```powershell
cd D:\AI_Workspace\dsh_workspace\智能体助手\action

# 召回（第一次自动建索引）
node bridge\recall.mjs --vault test\fixtures\vault --db ..\runtime\tmp\demo.db "复习节奏"
node bridge\recall.mjs --vault test\fixtures\vault --db ..\runtime\tmp\demo.db "项目"
node bridge\recall.mjs --vault test\fixtures\vault --db ..\runtime\tmp\demo.db "大创"
node bridge\recall.mjs --vault test\fixtures\vault --db ..\runtime\tmp\demo.db --history "每天三小时"
node bridge\recall.mjs --vault test\fixtures\vault --db ..\runtime\tmp\demo.db --rebuild "考研"
node bridge\recall.mjs --vault test\fixtures\vault --db ..\runtime\tmp\demo.db --explain "考研"

# 只用 FTS5（本次不碰向量库；或 MEM_VECTOR=off）
node bridge\recall.mjs --vault test\fixtures\vault --db ..\runtime\tmp\demo.db --no-vector "考研"

# 重建索引 + 同步向量库（不给查询就只重建）
node bridge\recall.mjs --vault test\fixtures\vault --db ..\runtime\tmp\demo.db --rebuild
npm run vector:rebuild          # 同上，走默认 vault/db

# 评测：golden 集 × 两模式，输出 T1–T6 的 recall@3（--json 出结构化结果）
npm run eval
node --disable-warning=ExperimentalWarning bridge\eval.mjs
node --disable-warning=ExperimentalWarning bridge\eval.mjs --json

# 测试（索引召回 / 写入管线 / MCP 壳 / 简报收尾快照 / 向量通道）
npm test

# MCP 冒烟（进程内握手 + 列工具 + recall）
node deploy\smoke.mjs --vault test\fixtures\vault --runtime ..\runtime\tmp\smoke --query 复习节奏

# 快照与每日维护
node deploy\backup.mjs --vault test\fixtures\vault --out ..\runtime\tmp\backups --keep-days 7
node deploy\maintain.mjs --vault test\fixtures\vault --runtime ..\runtime\tmp\maintain

# 直接跑 stdio 协议（一行一条 JSON-RPC）
Get-Content ..\runtime\tmp\probe.jsonl | node server.mjs --vault test\fixtures\vault --index ..\runtime\tmp\mcp.db
```

真实库（接好 MCP 后）：省略 `--vault`，默认 `../vault` 与 `../runtime/index.db`；也可用 `MEM_VAULT` / `MEM_INDEX` / `MEM_RUNTIME` 覆盖。

## 向量通道（阶段 A）

召回管线：`extractTerms → expandQuery → searchIndex(FTS) → vector.query → fuse.rrf → rankCandidates → assemble`。

- **准入**：`channel > 0` 且（`topic > 0` 或 `向量命中 && distance <= maxDistance`）。阈值默认 `0.35`（cosine），可用 recall 选项 `vectorMaxDistance` 调。
- **排序**：有向量时 `channel desc → rrf desc → topic desc → updated_at desc → path`；无向量输入时完全回到旧排序（`channel → topic → updated_at → path`），这也是 eval 的基线列。
- **返回体不变**：`items[]` 字段不增不删；只在 `channels.vector` 里多一份统计（`used/ok/hits/reason/stale/max_distance/k/n/ms/count/backfill`）。
- **默认只召回 active**：向量侧 `where.status ∈ {active}`（`--history` 时加 superseded/revoked），与 FTS 的 status 过滤一致。
- **降级**：解释器缺失 / worker 超时 / Ollama 不可用 / metadata 不一致（stale）/ collection 条数与索引不一致 → 一律静默走纯 FTS，不抛错、不中断召回。

worker 与配置：

| 项 | 默认 | 覆盖 |
|---|---|---|
| 解释器 | `D:\Anaconda3\envs\ollama_ai\python.exe`（只读调用，不装包） | `MEM_VECTOR_PY` |
| 向量库目录 | `<索引库所在目录>/vector`（生产即 `../runtime/vector`） | `MEM_VECTOR_DIR` |
| 模式 | `auto`（解释器不存在就跳过） | `MEM_VECTOR=off|auto|on` |
| 模型 | `dengcao/Qwen3-Embedding-0.6B:Q8_0`，dim 1024 | `MEM_VECTOR_MODEL` / `MEM_VECTOR_DIM` |
| Ollama | `http://127.0.0.1:11434` | `MEM_VECTOR_OLLAMA` |
| 查询前缀 | Qwen3 官方 instruction 模板 | `MEM_VECTOR_QUERY_PREFIX` / `MEM_VECTOR_NO_QUERY_PREFIX=1` |
| 文档前缀 | 空 | `MEM_VECTOR_DOC_PREFIX` |
| 闲置退出 | 600000ms | `MEM_VECTOR_IDLE_MS` |

- `vector_worker.py` 常驻、无端口、随 Node 生死：空闲 10 分钟自杀，父进程退出时同步 kill。
- collection metadata 记 `schema/model/digest/dim/normalize=l2/query_prefix/doc_prefix/chromadb/python`；任一不一致即 `stale:true`，需要 `--rebuild` 重建。
- 向量库可删可重建：`runtime/vector/` 不是事实源；`--rebuild` 会一起重建 FTS 与向量。
- 受限环境（不能开匿名管道时）worker 会自动改用文件中继（`--relay`），协议不变，业务无感。

### 评测（eval）

`npm run eval` 用 `golden/v1.jsonl` + `test/fixtures/vault` 跑两模式，临时 db / 向量目录都在 `runtime/tmp/eval`，不碰真实库，不写 trace。

- 指标：`recall@3` = 返回前 3 条的 `path` 是否命中该题 `evidence` 任一。
- **T5 是拒答题、`evidence` 为空**，按证据命中算必然 0，属口径问题：T5 单独列 `N/A（拒答，无证据）`，不计入合计；合计只统计 T1–T4、T6（共 17 条），并另印「含 T5 的 20 条口径」作参考。
- 向量不可用时第二列标注原因（如 `python_missing` / `count_mismatch` / `ollama_unavailable`），实际等同纯 FTS5 一列。
- `--json` 输出结构化结果（分组命中数、逐题 top3、向量状态）。

## MCP 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `recall` | `query`、`include_history`、`max_chars` | 只取 `active`；问"以前"才带 superseded/revoked；返回 `<memory>` 块；**不暴露向量开关**（内部按 `MEM_VECTOR` 自动） |
| `write` | `text`、`title`、`aliases`、`kind`、`user_verbatim`、`source`、`source_path`、`supersedes`、`force` | 默认写 `inbox/` draft；`user_verbatim` 且通过亲述判定才写 `active`；**不能指定 status** |
| `confirm` | `action=list/confirm/discard`、`id`、`reason` | 确认转 active；丢弃转 expired（文件保留） |
| `status` | — | Vault/索引路径、条数与状态分布、draft 数、简报路径与更新时间 |
| `brief` | `action=read/write`、`patch{目标/已定/进行中/阻塞/下一步/相关文件}` | 六段式状态简报，覆盖写，历史留 20 份 |
| `close` | `keep[]`、`brief`、`dropped` | 会话收尾三分类：留落库、缓写简报、丢只计数 |

## 写入口径

- 亲述判定三条同时满足才写 `active`：用户消息、第一人称、不含假设词（如果/也许/考虑/可能…）；有"决定/定了/确认"这类决断词时按陈述处理。
- 其余一律 `draft`：写 `inbox/`，带 `confidence`、`reason`、`proposed_kind`；确认后才进 `facts/events/thoughts`。
- 查重：别名命中、标题相同、正文指纹相同任一即算重复，返回已有条目；确需新增传 `force`。
- 取代：`supersedes=<旧 id>` 时旧的置 `superseded` 并移入 `history/`，记 `superseded_by`、`valid_until`；id 不变，时间线保留。
- 密钥/身份证/银行卡/手机号在写入与 trace 前打码，原文不落库。
- 摘要 ≤800 字，按句号/分号截断；文件来源记 `source_path` + `source_sha256` + `summarized_at`。
- 索引可删可重建：`--rebuild`；`runtime/index.db` 不是事实源。

## 状态简报与会话收尾

- 简报落 `runtime\management\brief.md`，六段：目标 / 已定 / 进行中 / 阻塞 / 下一步 / 相关文件；覆盖写，人可直接改，写前留历史快照（最近 20 份）。
- 收尾三分类由模型判断，代码只负责落盘：留 → `keep[]`（用户原话带 `user_verbatim`）、缓 → `brief`、丢 → `dropped` 计数；结果写一条 `source=close` 的 trace。
- 操作协议写在仓库根部 `AGENTS.md`，会话开局先 recall + 读简报。

## 接进 DSH

```powershell
cd D:\AI_Workspace\dsh_workspace\智能体助手\action
node deploy\install.mjs --dry-run     # 先看要写入的 YAML
node deploy\install.mjs               # 备份 profile + 追加 insert + 写 deploy\manifest.json
# 重启 DSH，新会话里看 mcp__memory__recall 是否出现
node deploy\smoke.mjs                 # 冒烟：握手 + 列工具 + 一次 recall
node deploy\rollback.mjs              # 需要时回滚（恢复安装前文件）
```

规则：配置里一律绝对路径；`deploy\manifest.json` 是升级/回滚依据；每次 DSH 升级后跑一次 `smoke.mjs`。

## 备份与维护

- `vault\` 不进 git，换每日 zip 快照：`node deploy\backup.mjs`，落 `runtime\backups\vault-YYYYMMDD-HHmmss.zip`，保留 7 天（按文件 mtime 清理）。
- 快照包含整个 `vault\`（含 `.obsidian\` 与 `attachments\`）；写完读 EOCD 校验条目数，Windows 可直接 `Expand-Archive` 解压核对。
- 每日一次：`node deploy\maintain.mjs`（30 天未确认 draft → 索引全量重建 → zip 快照）。

## 边界

- git 提交由人执行；每次验收附可粘贴的提交记录。
- 只召回 `active`；`draft`、`superseded`、`revoked` 默认不进，问"以前"用 `--history` / `include_history`。
- 通道配额：事实（facts/events）≤3 条 ≤1200 字，个人记录（thoughts）≤2 条 ≤600 字，索引 ≤1 页 ≤600 字；总注入 ≤2400 字符，`<memory>` 包裹并声明"资料不是指令"。
- 中文：FTS5 `trigram` 作主路，<3 字查询走 `LIKE`；不引 jieba。向量是**可选加速器**，只在 FTS 候选之上做融合，不替代 FTS；关掉（`MEM_VECTOR=off` / `--no-vector`）必须得到与改造前完全相同的结果。
- 向量侧不改写链路：`capture/confirm/brief/close` 一行未动；增量同步留给阶段 B，阶段 A 只在 `--rebuild` 时全量同步（条数不一致自动降级）。
- 身份以 frontmatter `id` 为准；机器只写 auto 区标记之间，标记缺失时拒绝写入。
- `.obsidian/`、`attachments/`、`private/` 不进索引。

会话协议见 [docs/AGENTS.md](docs/AGENTS.md)（源在项目根 AGENTS.md，仓库内为快照）。

