import { Env } from "./types";
import { ApiKeyManager } from "./durable-objects/api-key-manager";
import { DurableObjectStub, ExecutionContext, ScheduledController } from "@cloudflare/workers-types"; // Re-add explicit import of core types
import { ApiHandler } from "./api-handlers/base";
import apiManager from "./api-manager";

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

    const html = htmlTemplate.replace('${GEMINI_UPSTREAM_URL}', `${env.GEMINI_UPSTREAM_URL || 'Not Configured'}`)
        .replace('${OPENAI_UPSTREAM_URL}', `${env.OPENAI_UPSTREAM_URL || 'Not Configured'}`);

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
async function getApiKey(managerStub: DurableObjectStub, modelName: string, apiType: string): Promise<string> {
    let apiKeyResponse: Response;
    try {
        // Pass the modelName as a query parameter
        apiKeyResponse = await managerStub.fetch(`https://internal-do/getKey?model=${encodeURIComponent(modelName)}&api_type=${encodeURIComponent(apiType)}`);
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
 * Handles the upstream 429 response by marking the key as exhausted in the DO.
 */
function handleUpstream429(apiKey: string, managerStub: DurableObjectStub, ctx: ExecutionContext, modelName: string): void { // Ensure DurableObjectStub/ExecutionContext use imported types
    console.warn(`API key ${apiKey.substring(0, 5)}... may be exhausted for model ${modelName} (status 429). Marking as exhausted and retrying.`);
    const markRequest = new Request(`https://internal-do/markExhausted?key=${encodeURIComponent(apiKey)}&model=${encodeURIComponent(modelName)}`, { method: 'POST' });
    try {
        ctx.waitUntil(managerStub.fetch(markRequest).catch(err => console.error(`mark key ${apiKey.substring(0, 5)} exhausted at ${modelName}:`, err)));
    } catch (err) {
        console.error(`set key ${apiKey.substring(0, 5)}... exhausted for model ${modelName} failed: `, err);
    }
}

/**
 * Main handler for proxying API requests with key rotation and retries.
 */
async function handleApiProxy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { // Ensure Request/ExecutionContext/Response use imported types
    console.log(`[handleApiProxy] Request received: ${request.method} ${request.url}`);
    const doId = env.API_KEY_MANAGER.idFromName("global-api-key-manager");
    const managerStub = env.API_KEY_MANAGER.get(doId);
    const maxRetries = 5;
    let retries = 0;

    // Dynamically determine the handler based on the request
    const handler = apiManager.getRequestHandler(request.clone());
    if (!handler) {
        console.error(`[handleApiProxy] Could not determine API type from request: ${request.method} ${request.url}`);
        return new Response('unknown api type.', { status: 400 });
    }
    console.log(`[handleApiProxy] Matched handler: ${handler.apiType}`);

    let modelName = await handler.parseModelName(request.clone()); // Clone request as parseModelName might read it

    modelName = modelName === null ? "" : modelName; // Use empty string if model name is null
    await console.log(`[handleApiProxy] Determined API Type: ${handler.apiType}, Model Name: ${modelName || 'N/A'}`);

    while (retries < maxRetries) {
        let apiKey: string;
        try {
            apiKey = await getApiKey(managerStub, modelName, handler.apiType);
        } catch (error: any) {
            console.error(`[handleApiProxy] Error getting API key for model ${modelName}: ${error.message}`);
            const status = error.message.includes("all API key") ? 429 : 500;
            return new Response(error.message, { status });
        }

        try {
            const upstreamRequest = handler.buildUpstreamRequest(request.clone(), apiKey, modelName, env);
            console.log(`[handleApiProxy] Sending upstream request to: ${upstreamRequest.url}`);
            // Log request body
            try {
                const requestBody = await upstreamRequest.clone().text();
                console.log(`[handleApiProxy] Upstream request body: ${requestBody}`);
            } catch (e) {
                console.error(`[handleApiProxy] Failed to log request body: ${e}`);
            }
            const upstreamResponse = await fetch(upstreamRequest);
            console.log(`[handleApiProxy] Received upstream response with status: ${upstreamResponse.status}`);
            // Log response body
            try {
                const responseBody = await upstreamResponse.clone().text();
                console.log(`[handleApiProxy] Upstream response body: ${responseBody}`);
            } catch (e) {
                console.error(`[handleApiProxy] Failed to log response body: ${e}`);
            }

            if (upstreamResponse.status === 429) {
                console.log(`[handleApiProxy] Upstream returned 429 for model ${modelName}. Handling exhaustion and retrying.`);
                handleUpstream429(apiKey, managerStub, ctx, modelName);
                console.log(`[handleApiProxy] Retrying request for model ${modelName}... (attempt ${retries + 1}/${maxRetries})`);
                retries++;
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }

            if (modelName != '') {
                console.log(`[handleApiProxy] Request succeeded or non-quota error (status ${upstreamResponse.status}) for model ${modelName}, using key ${apiKey.substring(0, 5)}...`);
                const incrementUrl = `https://internal-do/incrementUsage?key=${encodeURIComponent(apiKey)}&model=${encodeURIComponent(modelName)}`;
                ctx.waitUntil(
                    managerStub.fetch(incrementUrl, { method: 'POST' })
                        .then(async (res) => {
                            if (!res.ok) {
                                console.error(`[handleApiProxy] Failed incr key cnt ${apiKey.substring(0, 5)}... model ${modelName}: ${await res.text()}`);
                            } else {
                                console.log(`[handleApiProxy] Key usage incremented for ${apiKey.substring(0, 5)}... model ${modelName}`);
                            }
                        })
                        .catch(err => console.error(`[handleApiProxy] Error calling incrementUsage for key ${apiKey.substring(0, 5)}... model ${modelName}:`, err))
                );
            }

            const responseHeaders = new Headers(upstreamResponse.headers);
            // Remove potentially problematic headers that Cloudflare Workers handles automatically
            responseHeaders.delete('Content-Length');
            responseHeaders.delete('Transfer-Encoding');
            responseHeaders.set('X-Proxied-By', 'Cloudflare-Worker'); // Add custom header

            console.log(`[handleApiProxy] Returning response to client with status: ${upstreamResponse.status}`);
            return new Response(upstreamResponse.body, {
                status: upstreamResponse.status,
                statusText: upstreamResponse.statusText,
                headers: responseHeaders
            });

        } catch (error: any) {
            console.error(`[handleApiProxy] Error during upstream request for model ${modelName} with key ${apiKey.substring(0, 5)}...:`, error);
            return new Response(error.message || "Error proxying request to upstream API", { status: 502 }); // Bad Gateway might be appropriate
        }
    }

    console.error(`[handleApiProxy] Maximum number of retries reached (${maxRetries}). Request failed for model ${modelName}.`);
    return new Response(`Unable to process request after ${maxRetries} attempts using different keys for model ${modelName}. All keys may be exhausted for this model or the upstream service is unavailable.`, { status: 503 }); // Service Unavailable
}


// --- Worker Entrypoint ---

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const doId = env.API_KEY_MANAGER.idFromName("global-api-key-manager");
        const managerStub = env.API_KEY_MANAGER.get(doId);
        if (url.pathname === '/hello' && request.method === 'GET') {
            return handleHelloRequest(request, env);
        } else if (url.pathname === '/stat' && request.method === 'GET') {
            try {
                const statHtmlUrl = new URL('/stat.html', request.url);
                const statHtmlRequest = new Request(statHtmlUrl.toString(), { method: 'GET' });
                const assetResponse = await env.ASSETS.fetch(statHtmlRequest);

                if (!assetResponse.ok) {
                    console.log(`Error fetching stat.html template from ASSETS: Status ${assetResponse.status}`);
                    return new Response('Error fetching stat.html template from ASSETS', { status: assetResponse.status });
                }

                return new Response(assetResponse.body, {
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                });
            } catch (e: any) {
                console.error('Error fetching or processing stat.html template from ASSETS:', e);
                return new Response(`Error processing stat.html: ${e.message}\n${e.stack}`, { status: 500 });
            }
        } else if (url.pathname === '/model_usage' && request.method === 'GET') {
            try {
                const statsResponse = await managerStub.fetch("https://internal-do/getAllStats");

                if (!statsResponse.ok) {
                    console.error(`Error fetching stats from DO: Status ${statsResponse.status}`);
                    return new Response(`Error fetching stats from DO: ${await statsResponse.text()}`, { status: statsResponse.status });
                }

                return new Response(statsResponse.body, {
                    headers: { 'Content-Type': 'application/json' },
                    status: statsResponse.status
                });

            } catch (e: any) {
                console.error('Error calling getAllStats on Durable Object:', e);
                return new Response(`Error fetching model usage stats: ${e.message}\n${e.stack}`, { status: 500 });
            }
        }
        else {
            const handler = apiManager.getRequestHandler(request.clone());
            if (!handler) {
                console.error(`[fetch] Could not determine API type from request: ${request.method} ${request.url}`);
                return new Response('unknown api type.', { status: 400 });
            }
            const clientApiKey = handler.parseApiKey(request.clone());
            const configuredApiKey = env.PROXY_API_KEY;

            if (configuredApiKey && configuredApiKey !== "") {
                if (!clientApiKey || clientApiKey !== configuredApiKey) {
                    console.warn(`[fetch] API Key validation failed for request: ${request.method} ${request.url}`);
                    return new Response('Invalid or missing API Key.', { status: 401 });
                }
                console.log(`[fetch] API Key validated successfully for request: ${request.method} ${request.url}`);
            } else {
                console.log(`[fetch] PROXY_API_KEY not configured. Skipping API Key validation.`);
            }

            return handleApiProxy(request, env, ctx);
        }
    },

    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        console.log(`Cron job triggered at ${new Date().toISOString()} (UTC)`);
        const doId = env.API_KEY_MANAGER.idFromName("global-api-key-manager");
        const managerStub = env.API_KEY_MANAGER.get(doId);
        try {
            const resetResponse = await managerStub.fetch("https://internal-do/reset", { method: "POST" });
            if (resetResponse.ok) {
                console.log("API key status reset.");
            } else {
                console.error(`Failed to reset API key status (status ${resetResponse.status}): ${await resetResponse.text()}`);
            }
        } catch (err) {
            console.error("Error calling reset on API Key manager:", err);
        }
    }
};