import { Env } from "./types";
import { ExecutionContext } from "@cloudflare/workers-types";
import { handleHelloRequest } from "./routes/hello";
import { handleStatRequest, handleModelUsageRequest } from "./routes/stat";
import { handleApiRoute } from "./proxy/router";

/**
 * Main request router for the worker.
 * Dispatches requests to appropriate handlers based on URL and method.
 * @param request The incoming request.
 * @param env The environment variables.
 * @param ctx The execution context.
 * @returns A Promise resolving to a Response.
 */
export async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const doId = env.API_KEY_MANAGER.idFromName("global-api-key-manager");
    const managerStub = env.API_KEY_MANAGER.get(doId);

    if (url.pathname === '/hello' && request.method === 'GET') {
        return handleHelloRequest(request, env);
    } else if (url.pathname === '/stat' && request.method === 'GET') {
        return handleStatRequest(request, env);
    } else if (url.pathname === '/model_usage' && request.method === 'GET') {
        return handleModelUsageRequest(request, env, managerStub);
    } else {
        const allowedApiPrefixes = ['/chat', '/model', '/v1beta', '/embeddings'];
        const isApiRoute = allowedApiPrefixes.some(prefix => url.pathname.startsWith(prefix));
        if (isApiRoute) {
            return handleApiRoute(request, env, ctx);
        } else {
            return new Response('Not Found', { status: 404 });
        }
    }
}