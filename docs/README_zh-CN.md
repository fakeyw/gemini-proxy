# Gemini Proxy

## 简介

本项目是一个 Cloudflare Workers 应用，用于代理 LLM API 请求，并智能地管理多个 API key。

## 部署步骤

1.  **安装 Wrangler CLI：**

    ```bash
    npm install -g wrangler
    ```

2.  **配置 Cloudflare 账号：**

    ```bash
    wrangler login
    ```

3.  **配置环境变量：**

    你需要配置以下环境变量：

    *   `UPSTREAM_API_URL`：上游 API 的 URL，默认为 `https://generativelanguage.googleapis.com/v1beta/openai`。
    *   `API_KEYS`：API key 列表，多个 key 之间用逗号分隔。

    你可以使用以下命令配置环境变量：

    ```bash
    npx wrangler secret put UPSTREAM_API_URL
    npx wrangler secret put API_KEYS
    ```

    或者，你也可以在 `wrangler.json` 文件中配置环境变量：

    ```json
    "vars": {
		"UPSTREAM_API_URL": "https://generativelanguage.googleapis.com/v1beta/openai"
	},
    ```

    **注意：**  使用 `wrangler secret put` 命令配置的环境变量会加密存储，更加安全。

4.  **部署 Worker：**

    ```bash
    npx wrangler deploy
    ```

## `wrangler` 命令使用

*   `wrangler login`：配置 Cloudflare 账号。
*   `wrangler secret put <key>`：配置加密环境变量。
*   `wrangler deploy`：部署 Worker。
*   `wrangler dev`：在本地开发和测试 Worker。

## 异常处理

本项目尽可能地捕获异常，并在 HTTP 返回的内容里打印具体异常和 stacktrace 等信息，方便调试。

## API Key 管理

本项目使用 Durable Objects 来管理 API Key。

*   `API_KEY_MANAGER`：Durable Object 的绑定名称，在 `wrangler.toml` 文件中配置。

## 定时任务

本项目每天在 GMT+8 15:00 (UTC 07:00) 通过定时任务重置所有 key 的状态。