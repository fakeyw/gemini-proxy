# Gemini Proxy

## Introduction

This project is a Cloudflare Workers application that proxies LLM API requests and intelligently manages multiple API keys.
Support and automatically recognize API requests in Gemini and OpenAI styles.

[简体中文](/docs/README_zh-CN.md)

## Deployment Steps

1.  **Configure Cloudflare Account:**

    ```bash
    npx wrangler login
    ```

2.  **Configure Environment Variables:**

    You need to configure the following environment variables:

    *   `GEMINI_UPSTREAM_URL`: The URL of the GEMINI upstream API, as `https://generativelanguage.googleapis.com/v1beta`. This is typically set in `wrangler.jsonc`.
    *   `OPENAI_UPSTREAM_URL`: The URL of the OPENAI upstream API, as `https://generativelanguage.googleapis.com/v1beta/openai`. This is typically set in `wrangler.jsonc`.
    *   `API_KEYS`: A list of API keys, separated by commas. This should be set using `wrangler secret put API_KEYS`.
    *   `PROXY_API_KEY`: (Optional) A custom API key for request validation. This should be set using `wrangler secret put PROXY_API_KEY`.

    If `PROXY_API_KEY` is set, incoming API proxy requests must include this key for authentication. Clients can provide the key in one of two ways:
        *   **For OpenAI-style requests:** Include an `Authorization: Bearer <key>` header.
        *   **For Gemini-style requests:** Include a `key=<key>` query parameter in the URL.

    You can configure environment variables using the following commands:

    ```bash
    npx wrangler secret put API_KEYS
    npx wrangler secret put PROXY_API_KEY
    ```

    You can configure `GEMINI_UPSTREAM_URL` and `OPENAI_UPSTREAM_URL` in the `wrangler.jsonc` file:

    ```json
    "vars": {
        "GEMINI_UPSTREAM_URL": "https://generativelanguage.googleapis.com/v1beta",
        "OPENAI_UPSTREAM_URL": "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    ```

    **Note:** Environment variables configured using the `wrangler secret put` command are stored encrypted and are more secure.

3.  **Deploy Worker:**

    ```bash
    npx wrangler deploy
    ```

## `wrangler` Command Usage

*   `npx wrangler login`: Configure Cloudflare account.
*   `npx wrangler secret put <key>`: Configure encrypted environment variables.
*   `npx wrangler deploy`: Deploy Worker.
*   `npx wrangler dev`: Develop and test Worker locally.

## Error Handling

This project captures exceptions as much as possible and prints specific exceptions and stacktraces in the HTTP response for easy debugging.

## API Key Management

This project uses Durable Objects to manage API Keys.

*   `API_KEY_MANAGER`: The binding name of the Durable Object, configured in the `wrangler.toml` file.

## Scheduled Tasks

This project resets the status of all keys daily at GMT+8 15:00 (UTC 07:00) via scheduled tasks.

## Model Usage Statistics Page (`/stat`)

This project includes a `/stat` page that displays API key and model usage statistics. You can access this page at the `/stat` path.

**Features:**

*   **Model Usage Display**: Shows the usage count for each model under each API key.
*   **Exhausted Key/Model Marking**: API keys that are exhausted for a specific model (due to upstream 429 errors) are marked on the page.
*   **Exhaustion Reason Display**: Clicking on a marked exhausted model reveals the specific reason provided by the upstream API for the exhaustion.

![Statistics Page Example](/asset/stat_display.png)