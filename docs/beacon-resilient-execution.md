# Beacon 长流程可靠执行说明

> 现行运行说明。当前验收状态与已知产物缺口见 [`README.md`](README.md)。

## 已解决的问题

Beacon 的生产图现在把昂贵阶段拆成可恢复工作项：

- final 模型草稿、六个推导步骤和一致性检查分别保存 checkpoint；
- 每个绘图/基线代码任务分成“生成代码”和“执行代码”，模型响应会在执行前保存；
- 敏感性分析分成计划、代码生成、代码执行和解释；
- 每张图片的 critic 和 analysis 分别保存；
- writer 继续沿用原有的逐章节 checkpoint。

因此，进程终止或模型服务间歇性失败后，只会继续当前微步骤，不会重新运行整个
modeler、coder、sensitivity 或 figure_pipeline 阶段。

## 正式运行方式

不要再用临时目录、不带 checkpointer 的自定义图，或让宿主 Agent 长时间同步等待真实任务。
在 Codex CLI、Claude CLI、zcode 等可能结束会话或限制单条命令时长的环境中，推荐后台启动：

```powershell
uv run math-agent start `
  --problem tests/fixtures/sample_problem.json `
  --out runs/my-run `
  --thread default `
  --no-interrupt
```

`start` 会立即返回 supervisor PID。后台 supervisor 为每次执行启动独立 worker；worker
异常退出、被杀或遇到可恢复的 router 故障后，supervisor 从 SQLite checkpoint 自动续跑。

```powershell
uv run math-agent status --out runs/my-run --thread default
Get-Content -Wait runs/my-run/supervisor.log
```

需要在当前终端持续看输出时，使用 `supervise`；需要人工处理时仍可直接调用 `recover`：

```powershell
uv run math-agent supervise --problem tests/fixtures/sample_problem.json --out runs/my-run --no-interrupt
uv run math-agent recover --out runs/my-run --thread default
uv run math-agent supervise-recover --out runs/my-run --thread default
```

`recover` 只执行一次 checkpoint 续跑；`supervise-recover` 会继续监管恢复 worker，直到完成、暂停、
降级或被恢复预算阻断。Web UI 在任务失败后提供“从最近检查点恢复”按钮，调用后者继续当前任务。
该入口会沿用 `.recover_failed_node` 的跨进程同节点计数；达到安全上限后 Web 状态变为 `blocked`，
不能通过重复点击重置预算。它不会注入 `human_decision`；human_review 暂停仍由
`supervise-resume` 的明确批准或拒绝处理。

真实完整流程脚本也已经使用固定目录和 SQLite checkpoint：

```powershell
uv run python scripts/run_real_full_pipeline.py --out runs/real-full --thread real-full
```

同一命令再次执行时会自动读取现有 checkpoint，而不是从头开始。

同一输出目录具有操作系统级 worker 锁和 supervisor 锁。CLI、Web UI 或两个 Agent
同时启动同一任务时，只有一个 worker 能修改 checkpoint；`run --force` 的清理也在锁内执行。

### 离线应急模式

常规运行不要设置 `MATH_AGENT_WRITER_DETERMINISTIC` 或 `MATH_AGENT_OFFLINE_REVIEW`。
只有远程写作或评审不可用、且当前题目已有完整本地证据契约时，才可显式设置：

```powershell
$env:MATH_AGENT_WRITER_DETERMINISTIC='1'
$env:MATH_AGENT_OFFLINE_REVIEW='1'
```

前者使用确定性事实稿；后者只在论文评审或量化评价抛出 `LLMError` 后执行离线证据审查。
离线审查重新核对上游评分、主方案、独立基线、敏感性和动态边界，不复用历史分数。当前完整
契约只覆盖城市绿色物流事实稿，其他题目应保持关闭并让远程评审故障显式失败。

## 9router 与 Beacon 的重试边界

9router 已经负责上游网络重试，Beacon 不再对普通 5xx 叠加五轮重试：

- `fetch connect timeout` 即使外层状态码为 502，也按连接超时处理，不自动重试；
- 普通连接错误和 5xx 在 Beacon 内最多进行一次快速补偿；
- 单次调用和全部重试共享总 deadline；
- JSON/schema 修复使用独立次数，但仍共享同一个总 deadline；
- 失败后异常向上抛给 LangGraph，由 checkpoint/recover 接管。
- embedding 与 completion 使用同一种可终止 worker；embedding timeout 不留下后台线程，
  也不再自动重放四次。

建议在 `.env` 中使用新变量，避免旧的 1800 秒统一超时掩盖问题：

```dotenv
MATH_AGENT_LLM_ATTEMPT_TIMEOUT=120
MATH_AGENT_LLM_TOTAL_TIMEOUT=300
MATH_AGENT_LLM_LONG_ATTEMPT_TIMEOUT=240
MATH_AGENT_LLM_LONG_TOTAL_TIMEOUT=420
MATH_AGENT_LLM_VALIDATION_REPAIRS=2
```

以上数值与 `.env.example` 的当前建议值一致；实际值以运行环境和 `src/math_agent/llm.py` 为准。
这些值限制的是单个微步骤；完整流程可以运行数小时，不需要给整个流程设置一个巨大超时。

## 恢复保护

`recover` 会记录连续失败的微节点。相同节点连续失败三次以后才停止继续恢复，防止确定性
错误形成死循环；一次或两次间歇性 502 不会被误判为永久阻塞。成功恢复后失败计数自动清除。

supervisor 另有整次任务恢复总预算，默认 20 次。鉴权失败、非法请求和 finalizer
不变量失败会立即停止；502、连接失败、限流、单次 timeout 和 worker 被杀会按节点退避恢复。
`failure.json` 只保存节点、错误类别和截断消息，不保存 prompt、模型响应或密钥。

Web 恢复按钮只在任务状态为 `failed` 且输出目录存在 `checkpoints.sqlite` 时显示。鉴权失败、
缺少 LiteLLM provider 前缀等确定性配置错误会进入 `blocked`，继续点击恢复也无法解决。先修正
配置，再从同一 checkpoint 手动续跑：

```powershell
uv run math-agent recover --out runs/my-run --thread default
```

OpenAI 兼容路由的模型名必须写成 `openai/<model>`；裸模型名即使已经配置
`OPENAI_API_BASE`，LiteLLM 仍可能因无法判断 provider 而在发出请求前拒绝调用。

## 图内最终收口

正常流程不再以“latex 节点返回”作为完成标准，而是进入 `finalizer`：

1. 检查 modeler、coder、sensitivity、figure、writer 的 phase 和 pending 队列全部收口；
2. 检查 final 模型、evaluation、人审决定和论文核心章节存在；
3. 检查 `paper.md`、`paper.tex` 是非空当前产物；
4. 对 Markdown、LaTeX、PDF 和编译日志计算 SHA-256；
5. 原子写入 `final_state.json` 和 `completion.json`；
6. 只有 `completion.status=completed` 才是无警告完成；缺 PDF 或存在非致命错误标为
   `degraded`，内部 pending 未清空则标为 `failed` 并保留 finalizer checkpoint。

`scripts/repair_final_run.py` 只用于旧版本已经到达 END、无法进入新 finalizer 的历史
checkpoint。新运行不得依赖该脚本，它也不会改写旧 checkpoint 历史。

## 验证范围

故障注入测试覆盖以下不变量：

1. final 推导中途 502 后，已经完成的推导不重复调用；
2. 多个代码任务中途 502 后，已完成任务不重复；
3. 代码执行期间崩溃后，复用已经 checkpoint 的模型代码响应；
4. 敏感性解释失败后，不重复计划、代码生成和数值执行；
5. 第二张图片失败后，不重复第一张图片的 critic 和 analysis；
6. 9router 的 `fetch connect timeout` 不会触发 Beacon 的 5xx 重试放大。
7. embedding timeout 会终止 worker，下一次请求由新 worker 完成；
8. supervisor 在 worker 被杀后自动 recover，同一节点三次失败后停止；
9. finalizer 只通过原子文件提交完成状态，半写入文件不会被认作完成；
10. 同一输出目录不能同时运行两个 worker，`--force` 不能越过活跃锁删除 checkpoint。
11. Web UI 失败任务只能在 checkpoint 存在时进入受监管恢复，并与 human_review 的 resume 路径隔离。
