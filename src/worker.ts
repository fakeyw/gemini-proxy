import { Env } from "./types";
import { ApiKeyManager } from "./durable-objects/api-key-manager";
import { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { routeRequest } from "./router";
import { handleScheduled } from "./scheduled/reset-keys";

/**
 * Export the ApiKeyManager class.
 */
export { ApiKeyManager };

// --- Worker Entrypoint ---

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        return routeRequest(request, env, ctx);
    },

    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        return handleScheduled(controller, env, ctx);
    }
};