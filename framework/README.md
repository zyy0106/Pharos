# Supervised Modeling Workbench

这是一个独立于旧 Beacon 流程的单人类监督 WebUI。它把“提议者、决策者、Agent Supervisor、执行者、数学核验者、论文审查者、写作者、终结器”放在可持久化的 21 节点状态机中，并强制每个文件交接包经过：

```text
四文件提交 -> Supervisor -> 人类第一审 -> 人类第二审 -> approved 原子晋级 -> 下一 Agent
```

## 启动

在项目根目录执行：

```powershell
npm run start:framework
```

浏览器打开 `http://127.0.0.1:5174`。正式项目在“项目总览”依次点击“新建项目”、选择题目与数据文件、“上传选中文件”、“确认题目与数据”和“启动项目”。也可点击“使用内置题目演示”；演示不需要 API Key。

题目支持 PDF、DOCX、MD、TXT、JSON；数据支持 CSV、XLSX、XLS。每个文件进入 `runs/framework/<run-id>/inputs/` 前会登记文件名、大小和 SHA-256。当前本地确定性执行器会直接解析 CSV；PDF、DOCX、XLSX、XLS 已保存并登记哈希，但要让模型理解二进制正文仍需接入对应解析器。

## 真实模型配置

设置页面支持保存 OpenAI-compatible 路由，但真实模型模式需要你自己在第三方服务中创建密钥。APIKEY.FUN 可以先尝试：

```text
推荐主端点：https://api.apikey.fun/v1
延迟敏感备选：https://slb.apikey.fun/v1
```

模型名不要猜，先从服务端 `GET /v1/models` 返回的 `id` 中选择。测试阶段选择列表中最便宜、支持文本输出的模型；真实论文阶段再单独切换更强模型。当前项目历史的 `openai/<model>` 是 LiteLLM 路由写法；这里的直连适配器应向第三方 `/chat/completions` 发送服务端实际模型 ID，不要把 `openai/` 前缀盲目拼进第三方模型名。

演示模式只验证状态机和审批链，不代表 Agent 在思考。真实模式使用模型驱动的受限工具闭环：

```text
读取题目和已批准包
  -> Agent 提取事实、比较替代方案并选择路线
  -> Agent 生成 result_code.py 和多格式文件
  -> 工作台运行 Python，保存 stdout/stderr
  -> 失败：将错误交回 Agent 修复，重新执行（最多一次）
  -> 成功：Agent 根据真实执行证据反思并定稿
  -> 独立 Agent Supervisor 反向审查
  -> 唯一人类第一审
  -> 唯一人类第二审
  -> 哈希复核和 approved 原子晋级
```

真实模式不会用演示代码兜底。模型返回非 JSON、缺少代码、写入非法路径、工具执行失败、反思时改动已执行文件或 Supervisor 调用失败，都会令当前节点进入 `blocked`，不能进入人工批准页面。WebUI 展示的是结构化、可审计的观察、替代方案、决策依据、工具计划、检查结果和不确定性，不保存或展示模型的隐藏思维链。

## 交接产物

每个阶段产生：

```text
result_code.py
result_document.md
result_issues.md
result_improvement_direction.md
manifest.json
supervisor_verdict.json
stdout.txt
stderr.txt
execution_log.json
```

运行数据默认保存在 `runs/framework/`。浏览器断开不会清除服务端事件；WebUI 使用 SSE 接收事件，服务端持久化 `events.jsonl`，重连时按事件序号补发。
