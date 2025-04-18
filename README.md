# Gemini Proxy

## Introduction

This project is a Cloudflare Workers application that proxies LLM API requests and intelligently manages multiple API keys.

[简体中文](/docs/README_zh-CN.md)

## Deployment Steps

1.  **Install Wrangler CLI:**

    ```bash
    npm install -g wrangler
    ```

2.  **Configure Cloudflare Account:**

    ```bash
    wrangler login
    ```

3.  **Configure Environment Variables:**

    You need to configure the following environment variables:

    *   `UPSTREAM_API_URL`: The URL of the upstream API, defaults to `https://generativelanguage.googleapis.com/v1beta/openai`.
    *   `API_KEYS`: A list of API keys, separated by commas.

    You can configure environment variables using the following commands:

    ```bash
    npx wrangler secret put UPSTREAM_API_URL
    npx wrangler secret put API_KEYS
    ```

    Alternatively, you can configure environment variables in the `wrangler.json` file:

    ```json
    "vars": {
		"UPSTREAM_API_URL": "https://generativelanguage.googleapis.com/v1beta/openai"
	},
    ```

    **Note:** Environment variables configured using the `wrangler secret put` command are stored encrypted and are more secure.

4.  **Deploy Worker:**

    ```bash
    npx wrangler deploy
    ```

## `wrangler` Command Usage

*   `wrangler login`: Configure Cloudflare account.
*   `wrangler secret put <key>`: Configure encrypted environment variables.
*   `wrangler deploy`: Deploy Worker.
*   `wrangler dev`: Develop and test Worker locally.

## Error Handling

This project captures exceptions as much as possible and prints specific exceptions and stacktraces in the HTTP response for easy debugging.

## API Key Management

This project uses Durable Objects to manage API Keys.

*   `API_KEY_MANAGER`: The binding name of the Durable Object, configured in the `wrangler.toml` file.

## Scheduled Tasks

This project resets the status of all keys daily at GMT+8 15:00 (UTC 07:00) via scheduled tasks.

## Model Usage Statistics Page (`/stat`)

This project includes a `/stat` page that displays model usage statistics. You can access this page at the `/stat` path.