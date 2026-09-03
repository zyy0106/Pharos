# automcm-pro Web UI

该目录包含 automcm-pro 的本地 Web 工作台与 Node.js API 服务：

- `server.mjs`：提供健康检查、示例题、运行控制、日志流和产物读取接口；
- `index.html`、`app.js`、`styles.css`：浏览器端界面；
- `assets/`：Logo 与页面图片资源。

请从项目根目录启动：

```bash
npm start
```

然后访问 `http://127.0.0.1:5173`。直接打开 `index.html` 只能查看静态页面，无法调用运行、恢复和产物接口。

## 首次配置

项目缺少 `.env` 或 API 密钥时，页面会自动打开五步引导：

1. 检查 Python 3.11--3.13、Node.js 18+ 与 uv；
2. 选择模型服务商，并带入推荐端点与模型；
3. 填写 API 端点和密钥；
4. 测试主力、强力与图像模型；
5. 将确认后的配置保存到项目根目录 `.env`。

界面中的模型名统一使用 LiteLLM 的 `provider/model` 格式，例如 `openai/deepseek-chat` 或
`ollama/llama3`。连接测试会直连填写的 OpenAI 兼容端点，并自动移除 LiteLLM 传输前缀；
保存配置时仍保留或补齐 `provider/`，供正式流水线使用。

## 工作台流程

主工作区按“导入题目 → 确认题目 → 启动生成”组织。首次使用可以保持高级选项默认值；模板、
RAG、人工审核和运行参数均收纳在折叠面板中。题目就绪后主按钮才会启用，并明确显示下一步动作。

题面导入支持 JSON、Markdown、TXT、PDF 和 Word。数据附件支持 Excel、CSV、PDF、Word、TXT 和 Markdown，可多选上传；服务端会保存附件并生成摘要，运行时把真实文件路径写入题目配置，供后端审计读取。

运行失败后，产物面板会保留失败日志并显示“从最近检查点恢复”。该操作只对当前 Web 会话内状态为
`failed` 且输出目录中存在 `checkpoints.sqlite` 的任务开放；服务端通过
`math-agent supervise-recover` 从最近节点继续，并沿用 supervisor 的同节点失败上限与总恢复预算。
恢复再次达到安全上限后，页面进入 `blocked`，不会继续显示恢复按钮。人工审核暂停仍使用独立的
“批准并继续/拒绝”流程，不会与错误恢复混用。

## 验证

从项目根目录运行：

```bash
npm test
```
