import { Env } from "./types";
import { Headers } from '@cloudflare/workers-types';
import { ApiKeyManager } from "./durable-objects/api-key-manager";
import { DurableObjectStub, ExecutionContext, ScheduledController } from "@cloudflare/workers-types"; // <-- 重新添加显式导入核心类型
export { ApiKeyManager }; // 导出 DO 类

// --- Helper Functions ---

/**
 * Handles the /hello route, returning a welcome HTML page.
 */
function handleHelloRequest(env: Env): Response {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>欢迎来到 LLM API 代理！</title>
        <style>
            body { font-family: sans-serif; line-height: 1.6; padding: 2em; background-color: #f4f4f4; color: #333; }
            .container { max-width: 800px; margin: auto; background: #fff; padding: 2em; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
            h1 { color: #007bff; }
            code { background-color: #eee; padding: 0.2em 0.4em; border-radius: 3px; }
        </style>
</head>
<body>
    <div class="container">
        <h1>👋 欢迎来到 Cloudflare Worker LLM API 代理！</h1>
        <p>此 worker 充当您配置的 LLM API 的代理 (<code>${env.UPSTREAM_API_URL || '未配置'}</code>)。</p>
            <p>它智能地管理多个 API key：</p>
        <ul>
            <li>轮换通过 <code>API_KEYS</code> 密钥提供的可用 API key。</li>
            <li>如果上游 API 返回 429 状态代码，则自动将 key 标记为耗尽。</li>
            <li>每天在 GMT+8 15:00 (UTC 07:00) 通过定时任务重置所有 key 的状态。</li>
        </ul>
        <p>要使用代理，只需将您的 API 请求发送到此 worker 的 URL，而不是直接发送到 LLM API URL。</p>
        <hr>
        <p><small>您看到此页面是因为您访问了 <code>/hello</code> 端点。</small></p>
    </div>
</body>
</html>
`;
    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

/**
 * Gets an available API key from the Durable Object.
 * Throws an error if communication fails or no key is available.
 * Returns the API key string if successful.
 */
async function getApiKey(managerStub: DurableObjectStub): Promise<string> { // Ensure DurableObjectStub uses imported type
    let apiKeyResponse: Response; // Ensure this uses the imported Response type
    try {
        apiKeyResponse = await managerStub.fetch("https://internal-do/getKey");
    } catch (err) {
        console.error("从 Durable Object 获取 key 时出错：", err);
        throw new Error("无法与 key 管理器通信"); // Throw specific error
    }

    if (apiKeyResponse.status === 429) {
        console.warn(`无法从管理器获取 API key (状态 ${apiKeyResponse.status})：所有 key 都已耗尽。`);
        throw new Error("所有 API key 当前都已耗尽"); // Throw specific error
    } else if (!apiKeyResponse.ok) {
        const errorBody = await apiKeyResponse.text();
        console.warn(`无法从管理器获取 API key (状态 ${apiKeyResponse.status})：${errorBody}`);
        throw new Error(errorBody || "无法获取可用的 API key"); // Throw specific error
    }

    const { apiKey } = await apiKeyResponse.json<{ apiKey: string }>();
    if (!apiKey) {
        console.error("Durable Object 返回 OK，但在响应中未找到 API key。");
        throw new Error("内部错误：来自 key 管理器的响应无效"); // Throw specific error
    }
    return apiKey;
}

/**
 * Proxies the incoming request to the upstream API using the provided API key.
 * Returns the upstream Response object.
 * Throws an error if the upstream fetch fails.
 */
async function proxyRequestToUpstream(request: Request, apiKey: string, env: Env): Promise<Response> { // Ensure Request/Response use imported types
    const upstreamUrl = env.UPSTREAM_API_URL || "https://api.openai.com/v1/chat/completions"; // Default or from env
    const upstreamRequest = new Request(upstreamUrl, {
        method: request.method,
        headers: {
            ...request.headers, // Clone incoming headers
            'Authorization': `Bearer ${apiKey}`,
            // Consider removing or conditionally setting 'Content-Type' if needed
        },
        body: request.body,
        redirect: 'follow'
    });

    console.log(`使用 key ${apiKey.substring(0, 5)}... 代理请求到 ${upstreamUrl}`);
    try {
        return await fetch(upstreamRequest);
    } catch (error) {
        console.error(`使用 key ${apiKey.substring(0, 5)}... 进行上游请求时出错：`, error);
        throw new Error("代理请求到上游 API 时出错"); // Re-throw for handling in the main loop
    }
}

/**
 * Handles the upstream 429 response by marking the key as exhausted in the DO.
 */
function handleUpstream429(apiKey: string, managerStub: DurableObjectStub, ctx: ExecutionContext): void { // Ensure DurableObjectStub/ExecutionContext use imported types
    console.warn(`API key ${apiKey.substring(0, 5)}... 可能已耗尽 (状态 429)。标记为耗尽并重试。`);
    const markRequest = new Request(`https://internal-do/markExhausted?key=${encodeURIComponent(apiKey)}`, { method: 'POST' });
    try {
        // Fire and forget, don't await completion
        ctx.waitUntil(managerStub.fetch(markRequest).catch(err => console.error(`后台 key 标记失败，对于 ${apiKey.substring(0, 5)}...:`, err)));
    } catch (err) {
        // Log error if starting the fetch fails, but don't block
        console.error(`启动标记 key ${apiKey.substring(0, 5)}... 为耗尽时出错：`, err);
    }
}

/**
 * Main handler for proxying API requests with key rotation and retries.
 */
async function handleApiProxy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { // Ensure Request/ExecutionContext/Response use imported types
    const doId = env.API_KEY_MANAGER.idFromName("global-api-key-manager");
    const managerStub = env.API_KEY_MANAGER.get(doId);
    const maxRetries = 5; // Consider making this configurable via env var?
    let retries = 0;

    while (retries < maxRetries) {
        let apiKey: string;
        try {
            apiKey = await getApiKey(managerStub);
        } catch (error: any) {
            // Handle errors from getApiKey (communication, all keys exhausted, invalid response)
            const status = error.message.includes("所有 API key") ? 429 : 500;
            return new Response(error.message, { status });
        }

        try {
            const upstreamResponse = await proxyRequestToUpstream(request.clone(), apiKey, env); // Clone request for potential retries

            if (upstreamResponse.status === 429) {
                handleUpstream429(apiKey, managerStub, ctx);
                retries++;
                console.log(`重试请求... (尝试 ${retries + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, 100)); // Short delay before retry
                continue; // Try next key
            }

            // Success or non-429 error from upstream
            console.log(`请求成功或非额度错误 (状态 ${upstreamResponse.status})，使用 key ${apiKey.substring(0, 5)}...`);
            const responseHeaders = new Headers(upstreamResponse.headers);
            responseHeaders.set('X-Proxied-By', 'Cloudflare-Worker'); // Add custom header
            return new Response(upstreamResponse.body, {
                status: upstreamResponse.status,
                statusText: upstreamResponse.statusText,
                headers: responseHeaders
            });

        } catch (error: any) {
            // Handle errors from proxyRequestToUpstream (fetch failed)
            // We don't necessarily know if the key is bad, could be network. Don't mark key.
            return new Response(error.message || "代理请求到上游 API 时出错", { status: 502 }); // Bad Gateway might be appropriate
        }
    }

    // Retries exhausted
    console.error(`已达到最大重试次数 (${maxRetries})。请求失败。`);
    return new Response(`经过 ${maxRetries} 次使用不同 key 的尝试后，无法处理请求。所有 key 可能都已耗尽或上游服务不可用。`, { status: 503 }); // Service Unavailable
}


// --- Worker Entrypoint ---

export default { // Ensure Request/ExecutionContext/Response use imported types
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { // Ensure Request/ExecutionContext/Response use imported types
        const url = new URL(request.url);

        if (url.pathname === '/hello' && request.method === 'GET') {
            return handleHelloRequest(env);
        } else {
            // Handle API proxy logic for all other paths
            return handleApiProxy(request, env, ctx);
        }
    },

    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> { // Ensure ScheduledController/ExecutionContext use imported types
        console.log(`Cron 作业已触发，时间为 ${new Date().toISOString()} (UTC)`);
        const doId = env.API_KEY_MANAGER.idFromName("global-api-key-manager");
        const managerStub = env.API_KEY_MANAGER.get(doId);
        try {
            console.log("调用 API Key 管理器重置...");
            const resetResponse = await managerStub.fetch("https://internal-do/reset", { method: "POST" });
            if (resetResponse.ok) {
                console.log("成功重置 API key 状态。");
            } else {
                console.error(`无法重置 API key 状态 (状态 ${resetResponse.status})：${await resetResponse.text()}`);
            }
        } catch (err) {
            console.error("调用 API Key 管理器上的重置时出错：", err);
        }
    }
};