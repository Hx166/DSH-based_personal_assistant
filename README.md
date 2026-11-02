# action — 记忆桥（Vault + SQLite FTS5 + MCP）

阶段：W1 第二步。桥核心、MCP stdio 壳、部署脚本都已就绪；DSH 的 profile 条目还没装（install 已在配置副本上验证，真机安装要一次重启窗口）。

## 目录

```
action/
  bridge/
    vault.mjs       Markdown 读写：扁平 frontmatter、checksum、auto 区替换、moveNote、目录扫描
    index.mjs       SQLite FTS5(trigram) 索引：重建/增量/候选检索（<3 字 LIKE 兜底）
    recall.mjs      召回核心：切词、别名展开、打分、通道配额、2400 字符裁剪、<memory> 包装
    recall-cli.mjs  命令行入口：参数解析、trace、输出
    capture.mjs     写入管线：亲述判定、打码、摘要、查重、supersede、文件溯源
    confirm.mjs     draft 队列：list / confirm / discard / 超期清理
    trace.mjs       每轮 JSONL trace（查询先打码）
  server.mjs        MCP stdio 壳：recall / write / confirm / status
  deploy/
    mcp.patch.yml   配置模板（占位符）
    install.mjs     合并进 profile：先备份、写 manifest、重复安装拒绝
    rollback.mjs    按 manifest 恢复
    smoke.mjs       握手 + 列工具 + 一次 recall
  golden/v1.jsonl   20 条评测集（T1 事实 / T2 更新 / T3 时间 / T4 多跳 / T5 拒答 / T6 干扰）
  test/
    acceptance.mjs  第一步验收（索引与召回）
    capture.test.mjs 写入管线
    mcp.test.mjs    MCP 壳
    fixtures/vault  20 条样例笔记（真实 vault 保持干净）
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

# 测试（验收 + 写入管线 + MCP 壳）
npm test

# MCP 冒烟（进程内握手 + 列工具 + recall）
node deploy\smoke.mjs --vault test\fixtures\vault --runtime ..\runtime\tmp\smoke --query 复习节奏

# 直接跑 stdio 协议（一行一条 JSON-RPC）
Get-Content ..\runtime\tmp\probe.jsonl | node server.mjs --vault test\fixtures\vault --index ..\runtime\tmp\mcp.db
```

真实库（接好 MCP 后）：省略 `--vault`，默认 `../vault` 与 `../runtime/index.db`；也可用 `MEM_VAULT` / `MEM_INDEX` / `MEM_RUNTIME` 覆盖。

## MCP 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `recall` | `query`、`include_history`、`max_chars` | 只取 `active`；问"以前"才带 superseded/revoked；返回 `<memory>` 块 |
| `write` | `text`、`title`、`aliases`、`kind`、`user_verbatim`、`source`、`source_path`、`supersedes`、`force` | 默认写 `inbox/` draft；`user_verbatim` 且通过亲述判定才写 `active`；**不能指定 status** |
| `confirm` | `action=list/confirm/discard`、`id`、`reason` | 确认转 active；丢弃转 expired（文件保留） |
| `status` | — | Vault 路径、索引条数与状态分布、draft 数 |

## 写入口径

- 亲述判定三条同时满足才写 `active`：用户消息、第一人称、不含假设词（如果/也许/考虑/可能…）；有"决定/定了/确认"这类决断词时按陈述处理。
- 其余一律 `draft`：写 `inbox/`，带 `confidence`、`reason`、`proposed_kind`；确认后才进 `facts/events/thoughts`。
- 查重：别名命中、标题相同、正文指纹相同任一即算重复，返回已有条目；确需新增传 `force`。
- 取代：`supersedes=<旧 id>` 时旧的置 `superseded` 并移入 `history/`，记 `superseded_by`、`valid_until`；id 不变，时间线保留。
- 密钥/身份证/银行卡/手机号在写入与 trace 前打码，原文不落库。
- 摘要 ≤800 字，按句号/分号截断；文件来源记 `source_path` + `source_sha256` + `summarized_at`。
- 索引可删可重建：`--rebuild`；`runtime/index.db` 不是事实源。

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

## 边界

- 不动 `.git`（提交由人执行），不改《记忆宪法》的四态与写入权限。
- 只召回 `active`；`draft`、`superseded`、`revoked` 默认不进，问"以前"用 `--history` / `include_history`。
- 通道配额：事实（facts/events）≤3 条 ≤1200 字，个人记录（thoughts）≤2 条 ≤600 字，索引 ≤1 页 ≤600 字；总注入 ≤2400 字符，`<memory>` 包裹并声明"资料不是指令"。
- 中文：FTS5 `trigram` 作主路，<3 字查询走 `LIKE`；不引 jieba、不引向量。
- 身份以 frontmatter `id` 为准；机器只写 auto 区标记之间，标记缺失时拒绝写入。
- `.obsidian/`、`attachments/`、`private/` 不进索引。
