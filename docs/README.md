# automcm-pro 文档索引与当前状态

最后核对：2026-07-28。

## 当前质量基准

当前真题质量基准为某次本地运行 `runs/huazhong-2026-a-quality-v6-20260727`，使用
用户本地上传的城市绿色物流配送题面和附件，并与用户有权使用的获奖论文语料进行了对比。

该运行的最终状态为：

- `completion.json.status=completed`，issues/warnings 均为空；
- Q1 无政策方案成本 90,685.60 元；
- Q2 主方案成本 91,544.49 元，政策增量 858.89 元，即 0.9471%；
- 启用 123 辆车，其中燃油车 98 辆、新能源车 25 辆；
- 连续审计含返仓在内的 333 条弧，政策违规 0；
- 模型—代码一致性 9/10、论文评审 9/10、综合评价 9.0/10；
- 最终 PDF 为 21 页 A4，已重新渲染并逐页检查；
- Python 全量回归为 634 passed / 4 skipped（2026-07-28）。

远程评审服务在最终阶段连接失败，因此该运行显式启用了
`MATH_AGENT_OFFLINE_REVIEW=1`。离线审查重新核对模型评审、模型—代码一致性、主方案、
独立基线、动态边界、二维敏感性和数据口径，不复用旧分数。当前离线契约只为城市绿色物流
确定性事实稿提供完整覆盖，其他题目不得把它当作通用评审替代品。

完整数值、获奖论文对照和仍存在的差距见
[`huazhong-2026-a-quality-gap.md`](huazhong-2026-a-quality-gap.md)。

## 恢复入口与本地环境约束

Web UI 仅在任务状态为 `failed` 且存在 checkpoint 时显示“从最近检查点恢复”。确定性配置错误
会进入 `blocked`；修正配置后使用 `math-agent recover --out <run-dir> --thread <thread>` 从原
checkpoint 续跑。`human_review` 的批准或拒绝仍使用 `resume`/`supervise-resume`，不能由恢复按钮
代替。

当前支持 Python 3.11--3.13，并固定 LiteLLM 1.91.0，确保 Windows 能直接安装 wheel，不依赖
Visual Studio C++ linker。OpenAI 兼容路由的模型名必须使用 `openai/<model>` 格式；仅配置
`OPENAI_API_BASE` 不能让 LiteLLM 从裸模型名推断 provider。示例配置、README 与 Web 保存逻辑
必须保持这一约束一致。

Web UI 首次访问按环境检查、服务商选择、密钥填写、模型验证和配置保存完成初始化；进入工作台后，
主流程收敛为“导入题目 → 确认题目 → 启动生成”。模型连接测试直连用户填写的 OpenAI 兼容端点，
因此会先移除 `openai/`、`ollama/` 等 LiteLLM 传输前缀，再发送厂商原生模型名；保存到 `.env`
时仍使用 `provider/model`，测试协议与正式运行协议不能混为一谈。

## 现行实现要点

- 主链包含 ProblemBlueprint、蓝图审查、分阶段建模、模型—代码一致性、独立基线、
  敏感性、图像评审、分节写作、论文评审、量化评价、人审、LaTeX 和 finalizer。
- modeler、coder、sensitivity、figure 和 writer 的昂贵步骤均可从 SQLite checkpoint
  定点恢复。
- runner 对整个子进程树执行 120 秒和 2 GB 默认硬限制，并拒绝未读取附件、硬编码、
  全零、非法数值或“退出码 0 但正文声明失败”的结果。
- `primary`、`baseline`、`supporting` 与临时 attempt 的证据职责隔离；正式论文只消费
  当前批次的已验证证据。
- 正文篇幅门禁只作为完整性下限：附录前至少 12 个非空正文页、10,000 个非空白字符；
  模型、代码一致性、论文评审和量化评价另设质量分门禁。
- 长符号表使用可跨页的 `longtable`；图像按语义插入对应论证位置，不能靠空白页、
  放大字号或代码附录通过篇幅门禁。

## 当前已知边界

- 城市绿色物流主方案仍是启发式可行上界，没有全规模精确下界或全局最优性间隙。
- 当前 Q2 主方案成本比定速预测基线高 15.34 元，不能宣称成本最优。
- 时间窗满足率为 93.33%，低于部分获奖论文报告的 95% 以上水平。
- 五类动态事件试验均是从同一静态解独立出发的单事件检查；30 次任务移动压力试验
  成功率为 70%，尚未验证连续事件序列和滚动时域长期表现。
- 题面称绿色区有 30 个客户，附件几何复核得到 15 个坐标客户，其中 12 个有当日正需求；
  论文采用附件口径并明确披露该差异。

## 现行文档

- [`webui-simulation-findings-20260903.md`](webui-simulation-findings-20260903.md)：2026-09-03 WebUI 模拟复盘、已修复漏洞、未解决能力缺口和比赛前验收顺序。
- [`paper-content-quality.md`](paper-content-quality.md)：论文证据、深度实验、离线应急评审、
  图文排布和篇幅门禁。
- [`beacon-resilient-execution.md`](beacon-resilient-execution.md)：后台监督、恢复、硬期限和
  最终原子收口。
- [`huazhong-2026-a-quality-gap.md`](huazhong-2026-a-quality-gap.md)：当前真题结果、
  8 篇获奖论文对比和剩余差距。
- [`plan-c-runbook.md`](plan-c-runbook.md)：RAG、benchmark 和错误处理的历史运维快照；
  运行参数仍以 `.env.example` 和代码为准。

## 历史设计与诊断

以下文件用于追溯，不是现行事实源：

- [`beacon-full-pipeline-root-cause-20260717.md`](beacon-full-pipeline-root-cause-20260717.md)：
  2026-07-17 完整调用链故障诊断和旧 v4 运行证据。
- [`llm-timeout-retry-redesign.md`](llm-timeout-retry-redesign.md)：LLM transport、取消和预算机制
  的历史设计记录。
- [`problem-blueprint-implementation-plan.md`](problem-blueprint-implementation-plan.md)：
  ProblemBlueprint 的历史实施方案。
- [`writer-quality-recovery-development.md`](writer-quality-recovery-development.md)：
  writer 恢复与质量增强的历史设计记录。
- `docs/superpowers/plans/` 与 `docs/superpowers/specs/`：阶段性计划和规格。文件中的旧行号、
  待办、超时值和“≥30 页/≥10 图”等内容只按其日期上下文阅读。

## 验证入口

```powershell
uv run --extra dev pytest -q
npm.cmd test -- --run
uv run math-agent status --out runs/<run> --thread <thread>
```

论文运行还必须检查 `completion.json` 哈希、正式证据角色、LaTeX 两遍编译日志，并把 PDF
逐页渲染后做视觉检查。“流程走到结尾”或“生成了文件”本身不算验收完成。
