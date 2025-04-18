import { Env } from "./types";
import { ApiKeyManager } from "./durable-objects/api-key-manager";
import { DurableObjectStub, ExecutionContext, ScheduledController } from "@cloudflare/workers-types"; // Re-add explicit import of core types
/**
 * Export the ApiKeyManager class.
 */
export { ApiKeyManager };

// Helper Functions

/**
 * @description Handles the /hello route, returning a welcome HTML page.
 * @param {Request} request - The incoming request.
 * @param {Env} env - The environment variables.
 * @returns {Promise<Response>} - The response object.
 */
async function handleHelloRequest(request: Request, env: Env): Promise<Response> {
    console.log('env.ASSETS:', env.ASSETS);
    let htmlTemplate = "";
    try {
        const helloHtmlUrl = new URL('/hello.html', request.url);
        const helloHtmlRequest = new Request(helloHtmlUrl.toString(), { method: 'GET' });
        const assetResponse = await env.ASSETS.fetch(helloHtmlRequest);

        if (!assetResponse.ok) {
            console.error(`Error fetching hello.html template from ASSETS: Status ${assetResponse.status}`);
            return new Response('Error fetching hello.html template from ASSETS', { status: assetResponse.status });
        }
        htmlTemplate = await assetResponse.text();

    } catch (e: any) {
        console.error('Error fetching or processing hello.html template from ASSETS:', e);
        return new Response(`Error processing hello.html: ${e.message}\n${e.stack}`, { status: 500 });
    }
    const html = htmlTemplate.replace('${UPSTREAM_API_URL}', env.UPSTREAM_API_URL || 'Not Configured');

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

/**
 * @description Gets an available API key from the Durable Object.
 * @param {DurableObjectStub} managerStub - The Durable Object stub.
 * @returns {Promise<string>} - The API key string.
 * @throws {Error} - If communication fails or no key is available.
 */
async function getApiKey(managerStub: DurableObjectStub, modelName: string): Promise<string> {
    let apiKeyResponse: Response;
    try {
        // Pass the modelName as a query parameter
        apiKeyResponse = await managerStub.fetch(`https://internal-do/getKey?model=${encodeURIComponent(modelName)}`);
    } catch (err) {
        console.error("Error fetching key from Durable Object:", err);
        throw new Error("Failed to communicate with key manager");
    }

    if (apiKeyResponse.status === 429) {
        console.warn(`Could not get API key from manager (status ${apiKeyResponse.status}): All keys are exhausted for model ${modelName}.`);
        throw new Error(`All API keys are currently exhausted for model ${modelName}`);
    } else if (!apiKeyResponse.ok) {
        const errorBody = await apiKeyResponse.text();
        console.warn(`Could not get API key from manager for model ${modelName} (status ${apiKeyResponse.status}): ${errorBody}`);
        throw new Error(errorBody || "Failed to get an available API key");
    }

    const { apiKey } = await apiKeyResponse.json<{ apiKey: string }>();
    if (!apiKey) {
        console.error("Durable Object returned OK, but no API key found in response.");
        throw new Error("Internal error: Invalid response from key manager");
    }
    return apiKey;
}

/**
 * Proxies the incoming request to the upstream API using the provided API key.
 * Returns the upstream Response object.
 * Throws an error if the upstream fetch fails.
 */
async function proxyRequestToUpstream(request: Request, apiKey: string, env: Env): Promise<Response> { // Ensure Request/Response use imported types
    var upstreamUrl = env.UPSTREAM_API_URL || "https://api.openai.com/v1/"; // Default or from env
    const requestPath = new URL(request.url).pathname;
    console.log("path=", requestPath)
    if (upstreamUrl.endsWith('/')) {
        upstreamUrl = upstreamUrl.slice(0, -1);
    }
    upstreamUrl = upstreamUrl + requestPath;
    const upstreamRequest = new Request(upstreamUrl, {
        method: request.method,
        headers: (() => {
            const headers = new Headers(request.headers);
            headers.delete('Authorization'); // Remove existing Authorization header
            headers.set('Authorization', `Bearer ${apiKey}`); // Set the new one
            return headers;
        })(),
        body: request.body,
        redirect: 'follow'
    });

    console.log(`Proxying request to ${upstreamUrl} using key ${apiKey.substring(0, 5)}...`);
    console.log(`Request details: Method - ${upstreamRequest.method}, URL - ${upstreamRequest.url}, Headers - ${JSON.stringify(Object.fromEntries(upstreamRequest.headers.entries()))}`);

    try {
        const response = await fetch(upstreamRequest);
        console.log(`Received response from ${upstreamUrl} with status ${response.status}`);
        console.log(`Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
        return response;

    } catch (error) {
        console.error(`Error during upstream request with key ${apiKey.substring(0, 5)}...:`, error);
        throw new Error("Error proxying request to upstream API"); // Re-throw for handling in the main loop
    }
}

/**
 * Handles the upstream 429 response by marking the key as exhausted in the DO.
 */
function handleUpstream429(apiKey: string, managerStub: DurableObjectStub, ctx: ExecutionContext, modelName: string): void { // Ensure DurableObjectStub/ExecutionContext use imported types
    console.warn(`API key ${apiKey.substring(0, 5)}... may be exhausted for model ${modelName} (status 429). Marking as exhausted and retrying.`);
    const markRequest = new Request(`https://internal-do/markExhausted?key=${encodeURIComponent(apiKey)}&model=${encodeURIComponent(modelName)}`, { method: 'POST' });
    try {
        ctx.waitUntil(managerStub.fetch(markRequest).catch(err => console.error(`后台 key 标记失败，对于 ${apiKey.substring(0, 5)}... 和模型 ${modelName}:`, err)));
    } catch (err) {
        console.error(`set key ${apiKey.substring(0, 5)}... exhausted for model ${modelName} failed: `, err);
    }
}

/**
 * Main handler for proxying API requests with key rotation and retries.
 */
async function handleApiProxy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { // Ensure Request/ExecutionContext/Response use imported types
    const doId = env.API_KEY_MANAGER.idFromName("global-api-key-manager");
    const managerStub = env.API_KEY_MANAGER.get(doId);
    const maxRetries = 5;
    let retries = 0;

    const requestCloneForBody = request.clone();
    let modelName: string = "";
    let requestBody: any;

    try {
        const contentType = requestCloneForBody.headers.get("Content-Type");
        if (requestCloneForBody.method !== 'GET' && contentType && contentType.includes('application/json')) {
             requestBody = await requestCloneForBody.json();
             if (requestBody?.model) {
                 modelName = requestBody.model;
                 console.log(`Extracted model name from body: ${modelName}`);
             } else {
                 console.warn("Request body is JSON but does not contain a 'model' field. Using default model name.");
             }
        } else {
             console.log(`Request method ${requestCloneForBody.method} or Content-Type ${contentType} does not suggest a JSON body with model info. Using default model name.`);
        }

    } catch (e: any) {
        console.warn("Could not parse request body as JSON or extract model name. Using default model name.", e.message);
    }


    while (retries < maxRetries) {
        let apiKey: string;
        try {
            apiKey = await getApiKey(managerStub, modelName);
        } catch (error: any) {
            const status = error.message.includes("all API key") ? 429 : 500;
            return new Response(error.message, { status });
        }

        try {
            const upstreamResponse = await proxyRequestToUpstream(request.clone(), apiKey, env);
            if (upstreamResponse.status === 429) {
                handleUpstream429(apiKey, managerStub, ctx, modelName);
                console.log(`Retrying request for model ${modelName}... (attempt ${retries + 1}/${maxRetries})`);
                retries++;
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }

            console.log(`Request succeeded or non-quota error (status ${upstreamResponse.status}) for model ${modelName}, using key ${apiKey.substring(0, 5)}... Incrementing usage count.`);

            // 使用 waitUntil 异步上报调用次数
            const incrementUrl = `https://internal-do/incrementUsage?key=${encodeURIComponent(apiKey)}&model=${encodeURIComponent(modelName)}`;
            ctx.waitUntil(
                managerStub.fetch(incrementUrl, { method: 'POST' })
                    .then(async (res) => {
                        if (!res.ok) {
                            console.error(`Failed to increment usage count for key ${apiKey.substring(0, 5)}... model ${modelName}: ${await res.text()}`);
                        } else {
                             console.log(`Successfully incremented usage count for key ${apiKey.substring(0, 5)}... model ${modelName}`);
                        }
                    })
                    .catch(err => console.error(`Error calling incrementUsage for key ${apiKey.substring(0, 5)}... model ${modelName}:`, err))
            );

            const responseHeaders = new Headers(upstreamResponse.headers);
            responseHeaders.set('X-Proxied-By', 'Cloudflare-Worker'); // Add custom header
            return new Response(upstreamResponse.body, {
                status: upstreamResponse.status,
                statusText: upstreamResponse.statusText,
                headers: responseHeaders
            });

        } catch (error: any) {
            console.error(`Error during upstream request for model ${modelName} with key ${apiKey.substring(0, 5)}...:`, error);
            return new Response(error.message || "Error proxying request to upstream API", { status: 502 }); // Bad Gateway might be appropriate
        }
    }

    console.error(`Maximum number of retries reached (${maxRetries}). Request failed for model ${modelName}.`);
    return new Response(`Unable to process request after ${maxRetries} attempts using different keys for model ${modelName}. All keys may be exhausted for this model or the upstream service is unavailable.`, { status: 503 }); // Service Unavailable
}


// --- Worker Entrypoint ---

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/' && request.method === 'GET') {
            return handleHelloRequest(request, env);
        } else {
            return handleApiProxy(request, env, ctx);
        }
    },

    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        console.log(`Cron job triggered at ${new Date().toISOString()} (UTC)`);
        const doId = env.API_KEY_MANAGER.idFromName("global-api-key-manager");
        const managerStub = env.API_KEY_MANAGER.get(doId);
        try {
            console.log("Calling API Key manager reset...");
            const resetResponse = await managerStub.fetch("https://internal-do/reset", { method: "POST" });
            if (resetResponse.ok) {
                console.log("Successfully reset API key status.");
            } else {
                console.error(`Failed to reset API key status (status ${resetResponse.status}): ${await resetResponse.text()}`);
            }
        } catch (err) {
            console.error("Error calling reset on API Key manager:", err);
        }
    }
};