import { Env } from "../types";
import { ExecutionContext } from "@cloudflare/workers-types";
import apiManager from "../api-manager";
import { handleApiProxy } from "./handler";

/**
 * Handles routing and preparation for API proxy requests.
 * Determines API type, validates keys, and calls the core proxy handler.
 * @param request The incoming request.
 * @param env The environment variables.
 * @param ctx The execution context.
 * @returns A Promise resolving to a Response.
 */
export async function handleApiRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handler = apiManager.getRequestHandler(request.clone());
    if (!handler) {
        console.error(`[handleApiRoute] Could not determine API type from request: ${request.method} ${request.url}`);
        return new Response('unknown api type.', { status: 400 });
    }
    console.log(`[handleApiRoute] Matched handler: ${handler.apiType}`);

    const clientApiKey = handler.parseApiKey(request.clone());
    const configuredApiKey = env.PROXY_API_KEY;

    let modelName = await handler.parseModelName(request.clone());
    modelName = modelName === null ? "" : modelName;
    console.log(`[handleApiRoute] Determined API Type: ${handler.apiType}, Model Name: ${modelName || 'N/A'}`);


    const useInternalKeyManager =
        (clientApiKey !== null
            && configuredApiKey !== undefined
            && configuredApiKey !== ""
            && clientApiKey === configuredApiKey);

    if (clientApiKey !== null && configuredApiKey !== undefined && configuredApiKey !== "" && clientApiKey !== configuredApiKey) {
        console.warn(`[handleApiRoute] API Key validation failed for request: ${request.method} ${request.url}`);
        return new Response('Invalid API Key.', { status: 401 });
    }

    console.log(`[handleApiRoute] useInternalKeyManager = ${useInternalKeyManager}.`);
    return handleApiProxy(request, env, ctx, useInternalKeyManager, handler, modelName);
}