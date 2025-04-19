import { ApiHandler } from "./base";
import { Env } from "../types";

interface OpenAIRequestBody {
    model?: string;
    // Add other potential fields if needed for parsing
}

export class OpenAIHandler implements ApiHandler {
    public readonly apiType = 'openai';

    /**
     * Checks if the request path includes typical OpenAI API endpoint segments
     * (e.g., /chat/completions, /embeddings).
     * @param request The incoming request.
     * @returns True if the path matches, false otherwise.
     */
    match(request: Request): boolean {
        const url = new URL(request.url);
        const path = url.pathname;
        return path.includes('/chat/completions') || path.includes('/embeddings');
    }

    async parseModelName(request: Request): Promise<string | null> {
        try {
            const contentType = request.headers.get("Content-Type");
            if (request.method !== 'GET' && contentType && contentType.includes('application/json')) {
                const requestBody: OpenAIRequestBody = await request.json();
                return requestBody?.model ? String(requestBody.model) : null;
            }
        } catch (e) {
            console.warn("OpenAIHandler: Could not parse request body as JSON or extract model name.", e);
        }
        return null;
    }

    buildUpstreamRequest(request: Request, apiKey: string, modelName: string, env: Env): Request {
        let upstreamUrl = env.OPENAI_UPSTREAM_URL || "https://api.openai.com/v1/";
        const requestPath = new URL(request.url).pathname;

        if (upstreamUrl.endsWith('/')) {
            upstreamUrl = upstreamUrl.slice(0, -1);
        }
        upstreamUrl = upstreamUrl + requestPath;

        const upstreamRequest = new Request(upstreamUrl, {
            method: request.method,
            headers: (() => {
                const headers = new Headers(request.headers);
                headers.delete('Authorization');
                headers.set('Authorization', `Bearer ${apiKey}`);
                return headers;
            })(),
            body: request.body,
            redirect: 'follow'
        });

        return upstreamRequest;
    }
}