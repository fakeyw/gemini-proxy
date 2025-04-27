import { Env } from "../types";
import { DurableObjectStub } from "@cloudflare/workers-types";

/**
 * @description Handles the /stat route, returning a statistics HTML page.
 * @param {Request} request - The incoming request.
 * @param {Env} env - The environment variables.
 * @returns {Promise<Response>} - The response object.
 */
export async function handleStatRequest(request: Request, env: Env): Promise<Response> {
    try {
        const statHtmlUrl = new URL('/stat.html', request.url);
        const statHtmlRequest = new Request(statHtmlUrl.toString(), { method: 'GET' });
        const assetResponse = await env.ASSETS.fetch(statHtmlRequest);

        if (!assetResponse.ok) {
            return new Response('Error fetching stat.html template from ASSETS', { status: assetResponse.status });
        }

        return new Response(assetResponse.body, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    } catch (e: any) {
        console.error('Error fetching or processing stat.html template from ASSETS:', e);
        return new Response(`Error processing stat.html: ${e.message}\n${e.stack}`, { status: 500 });
    }
}

/**
 * @description Handles the /model_usage route, fetching stats from the Durable Object.
 * @param {Request} request - The incoming request.
 * @param {Env} env - The environment variables.
 * @param {DurableObjectStub} managerStub - The Durable Object stub for the ApiKeyManager.
 * @returns {Promise<Response>} - The response object.
 */
export async function handleModelUsageRequest(request: Request, env: Env, managerStub: DurableObjectStub): Promise<Response> {
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