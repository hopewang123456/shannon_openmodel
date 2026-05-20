# 🛡️ Shannon Fork — 多 Provider 增强版

> 基于 [KeygraphHQ/shannon](https://github.com/KeygraphHQ/shannon) 的独立分支，适配国内网络环境和多 LLM Provider。

---

## 本 Fork 的核心增强

### 🔄 移除 Claude Agent SDK 依赖

原版 Shannon 深度绑定 Anthropic Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`），该 SDK 需要通过 npm 安装且依赖 Claude Code 的认证流程。**本 Fork 完全移除了这一依赖**，改用自研的轻量级 LLM Provider 抽象层。

### 🏗️ 新增：多 Provider LLM 适配层

**文件：** `apps/worker/src/ai/llm-provider.ts`

全新的 `callLLM()` 函数支持两大 API 格式：

| Provider 类型 | 支持格式 | 适用场景 |
|---------------|----------|----------|
| **OpenAI 兼容** | `POST /v1/chat/completions` | DeepSeek, OpenAI, OpenRouter, Ollama, vLLM, 国内镜像等 |
| **Anthropic 原生** | `POST /v1/messages` | DeepSeek v4（Anthropic 端点）、官方 Anthropic API |

**环境变量配置：**

```bash
# Provider 选择（默认 openai）
LLM_PROVIDER=openai          # openai | anthropic

# OpenAI 兼容模式
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.deepseek.com/v1

# 或 Anthropic 原生模式
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic

# 模型分档（可覆盖）
LLM_SMALL_MODEL=deepseek-chat
LLM_MEDIUM_MODEL=deepseek-chat
LLM_LARGE_MODEL=deepseek-chat
```

**模型分档覆盖优先级：** `LLM_SMALL_MODEL` → `ANTHROPIC_SMALL_MODEL` → `LLM_MODEL` → 默认 `deepseek-chat`

### 📦 Dockerfile 优化：node:22-slim

- 基础镜像从 `chainguard/wolfi-base` 改为 `node:22-slim`——**国内 mirror 可用，docker pull 不卡墙**
- 移除 Chromium 硬依赖，改为可选（`CHROMIUM=true` build arg）
- 移除 Claude Code CLI 安装步骤（已不再需要）
- 精简构建流程，减少镜像层数

### 🔐 安全增强

- 所有 `.env` 文件已在 `.gitignore` 保护
- `.env.example` 全部使用 `your-api-key-here` 占位符
- `litellm-config/` 目录加入 `.gitignore`（容量大且可能含 key）
- 移除 Bedrock/Vertex AI 的默认模型硬编码

### 🧪 Preflight 验证重写

**文件：** `apps/worker/src/services/preflight.ts`

- 凭据验证从 `Claude SDK query()` 改为 HTTP 调用 `validateLLMConnection()`
- 参数签名从**位置参数**改为**选项对象**，减少调用方出错概率
- 移除顶层未引用变量 `resolveModel` 的导入

### 🔄 Pipeline-Testing 模式重写：摆脱 save-deliverable & playwright-cli

**文件：** `apps/worker/prompts/pipeline-testing/*`

原版 Shannon 的 pipeline-testing（快速验证模式）依赖两个外部工具：
- `save-deliverable` — 自有脚本，用于保存分析结果
- `playwright-cli` — 浏览器自动化，用于动态截图验证

这在 CI/无头环境或没有 Node.js 工具链时就是一个硬依赖。**本 Fork 将 7 个 pipeline-testing prompt 全部从 CLI 调用模式改为纯 LLM 代码分析模式**：

| 原版 | 本 Fork |
|------|---------|
| `@include(shared/_filesystem.txt)` + `save-deliverable` | 直接注入文件系统上下文 + 自然语言输出（中文） |
| `playwright-cli navigate` + `screenshot` | LLM 直接分析源码，无需浏览器 |
| `return []` 空数组 | 输出完整 JSON 结构化漏洞数据 |

每个 prompt 现在输出详细的中文分析，附带标准化的 JSON 漏洞数据结构，可直接用于最终安全报告。pipeline-testing 模式从此**零外部依赖**。

### 🪟 WSL 兼容性改进

针对 Windows WSL2 环境的适配：
- `entrypoint.sh`：跳过 `su -m pentest`（WSL 下 env 丢失）
- `apps/cli/src/docker.ts`：`docker compose` → `docker-compose`（v5 兼容）
- `apps/cli/src/docker.ts`：跳过 `SHANNON_HOST_UID` 设置（WSL 不需要）
- `apps/cli/src/env.ts`：新增 `OPENAI_API_KEY`、`LLM_PROVIDER`、`LLM_*_MODEL` 环境变量透传

### 📈 Report Agent 增强

**文件：** `apps/worker/src/services/agent-execution.ts`

报告生成阶段不再仅凭记忆，而是将每位 agent 的完整 deliverable 上下文注入 prompt，生成质量更高的安全评估报告。

### ⏱ Fetch 超时优化

**文件：** `apps/worker/src/ai/llm-provider.ts`

推理模型（如 DeepSeek Reasoner）响应时间长，将 fetch 超时从 60s 提升至 120s，避免推理过程中的超时断开。

---

## 快速开始（国内友好版）

```bash
# 1. 克隆本仓库
git clone https://github.com/hopewang123456/shannon_openmodel.git
cd shannon_openmodel

# 2. 配置环境变量（DeepSeek 示例）
cat > .env << 'EOF'
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-your-deepseek-key
OPENAI_BASE_URL=https://api.deepseek.com/v1
LLM_SMALL_MODEL=deepseek-chat
LLM_MEDIUM_MODEL=deepseek-chat
LLM_LARGE_MODEL=deepseek-chat
LLM_MAX_TOKENS=64000
EOF

# 3. 构建（无需科学上网）
./shannon build

# 4. 运行
./shannon start -u https://your-app.com -r /path/to/your-repo
```

### 使用 DeepSeek v4 Anthropic 端点

如果你希望使用 DeepSeek v4 的 Anthropic 兼容端点（支持 thinking blocks 和 tool use）：

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-your-deepseek-key
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
```

---

## 变更清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `Dockerfile` | 重写 | wolfi-base → node:22-slim，移除 Claude Code，Chromium 可选 |
| `pnpm-workspace.yaml` | 修改 | 移除 Claude Code workspace |
| `.env.example` | 重写 | 多 Provider 示例，移除 Claude Code 相关变量 |
| `.gitignore` | 扩展 | 添加 `litellm-config/` |
| `apps/worker/src/ai/llm-provider.ts` | **新增** | 多 Provider LLM 调用层（383行） |
| `apps/worker/src/ai/claude-executor.ts` | 重写 | 移除 Claude SDK，改用 `callLLM()` |
| `apps/worker/src/ai/models.ts` | 重写 | 支持 `LLM_*_MODEL` 多 Provider 模型配置 |
| `apps/worker/src/ai/types.ts` | 修改 | 移除 SDK 类型依赖 |
| `apps/worker/src/ai/queue-schemas.ts` | 修改 | 移除 SDK 类型引用 |
| `apps/worker/src/ai/message-handlers.ts` | 修改 | 清理 SDK 引用 |
| `apps/worker/src/services/preflight.ts` | 重写 | HTTP ping 代替 SDK query，选项对象签名 |
| `entrypoint.sh` | 修改 | 移除 `/tmp/.claude` 路径，跳过 WSL 下 `su -m pentest` |
| `apps/worker/prompts/pipeline-testing/pre-recon-code.txt` | 重写 | 从 `save-deliverable` CLI 改为纯 LLM 代码分析 |
| `apps/worker/prompts/pipeline-testing/recon.txt` | 重写 | 同上，摆脱 playwright-cli 依赖 |
| `apps/worker/prompts/pipeline-testing/report-executive.txt` | 重写 | 注入完整 deliverables 上下文 |
| `apps/worker/prompts/pipeline-testing/vuln-auth.txt` | 重写 | 输出中文分析 + JSON 结构化数据 |
| `apps/worker/prompts/pipeline-testing/vuln-authz.txt` | 重写 | 同上 |
| `apps/worker/prompts/pipeline-testing/vuln-injection.txt` | 重写 | 同上 |
| `apps/worker/prompts/pipeline-testing/vuln-ssrf.txt` | 重写 | 同上 |
| `apps/worker/prompts/pipeline-testing/vuln-xss.txt` | 重写 | 同上 |
| `apps/worker/src/services/agent-execution.ts` | 增强 | 报告阶段注入完整 deliverable 上下文 |
| `apps/cli/src/docker.ts` | 修复 | WSL 兼容：docker-compose 命名、跳过 UID 设置 |
| `apps/cli/src/env.ts` | 增强 | 新增多 Provider 环境变量透传 |

---

## 与原版的差异

| 对比项 | 原版 Shannon | 本 Fork |
|--------|-------------|---------|
| **LLM 依赖** | Claude Agent SDK（仅 Anthropic） | 自实现 Provider（OpenAI + Anthropic） |
| **支持的 Provider** | Anthropic Claude 系列 | 任意 OpenAI 兼容 API + Anthropic |
| **安装方式** | npm publish + Docker pull | git clone + `./shannon build` |
| **Docker 基础镜像** | wolfi-base（国内 pull 困难） | node:22-slim（mirror 可用） |
| **Chromium** | 强制安装 300MB+ | 可选（CHROMIUM=true） |
| **模型配置** | 硬编码 Claude 模型 ID | 环境变量全可覆盖 |
| **网络要求** | 需要访问 Docker Hub + npm | 可配置使用国内镜像/代理 |

---

## License

本 Fork 基于 [AGPL-3.0](./LICENSE) 协议发布，继承原版 [KeygraphHQ/shannon](https://github.com/KeygraphHQ/shannon) 的许可证。
