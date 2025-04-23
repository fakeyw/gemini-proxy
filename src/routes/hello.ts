import { Env } from "../types";

/**
 * @description Handles the /hello route, returning a welcome HTML page.
 * @param {Request} request - The incoming request.
 * @param {Env} env - The environment variables.
 * @returns {Promise<Response>} - The response object.
 */
export async function handleHelloRequest(request: Request, env: Env): Promise<Response> {
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