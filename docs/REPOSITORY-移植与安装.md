# Pharos 仓库移植与安装说明

本仓库包含两套入口：

- `framework/`：当前推荐的单人类监督 WebUI，启动命令为 `npm run start:framework`，默认端口 5174。
- `frontend/` 与 `src/math_agent/`：完整数学建模流水线和旧版通用 WebUI，启动命令为 `npm start`，默认端口 5173。

## 仓库中应该有什么

应提交源码、测试、文档、`package-lock.json`、`uv.lock`、`.env.example` 和 GitHub Actions 配置。

不应提交：`.env`、`node_modules/`、`.venv/`、`runs/`、用户题目附件、模型响应日志和密钥。`.gitignore` 已覆盖这些路径。

## Windows 新电脑

1. 安装 Git、Node.js 18+、Python 3.11–3.13 和 uv。
2. 克隆仓库并进入目录：

   ```powershell
   git clone <你的GitHub仓库地址>
   cd Pharos
   ```

3. 执行一次安装：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
   ```

4. 启动推荐 WebUI：

   ```powershell
   npm run start:framework
   ```

   也可以双击 `scripts\start-framework.bat`。

5. 浏览器打开启动器输出的地址，通常是 `http://127.0.0.1:5174/`。如果端口被占用，启动器会自动选择可用端口。

6. 在 WebUI 设置页选择 `demo` 做状态机测试；需要真实模型时再填写 OpenAI-compatible API 端点、密钥和服务端返回的模型 ID。

## macOS / Linux

```bash
git clone <你的GitHub仓库地址>
cd Pharos
bash scripts/setup.sh
npm run start:framework
```

## 验证安装

```bash
npm test
npm run test:framework
uv run pytest
```

如果只想验证 Python CLI：

```bash
uv run math-agent supervise --help
```

## 数据迁移

不要把旧电脑的整个 `runs/` 目录上传 GitHub。若需要迁移某次运行，请通过加密磁盘、私有备份或人工选择的运行包迁移，并先清除 API 请求日志和密钥。新电脑上的题目附件应从 WebUI 重新上传，系统会在本机重新计算 SHA-256。

## GitHub 推送

仓库创建后，在本地执行：

```bash
git init
git add .
git commit -m "Prepare portable Pharos repository"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

推送前务必确认：

```bash
git status --short
git ls-files .env runs node_modules .venv
```

第二条命令不应输出任何路径。
