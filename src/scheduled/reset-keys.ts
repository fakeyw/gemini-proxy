import { Env } from "../types";
import { ScheduledController, ExecutionContext } from "@cloudflare/workers-types";

/**
 * Handles the scheduled task to reset API key status in the Durable Object.
 * @param controller The scheduled controller.
 * @param env The environment variables.
 * @param ctx The execution context.
 */
export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
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