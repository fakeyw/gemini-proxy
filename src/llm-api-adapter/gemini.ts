import { ApiHandler } from "./base";
import { Env } from "../types";

export class GeminiHandler implements ApiHandler {
    public readonly apiType = 'gemini';

    /**
     * Checks if the request path matches the Gemini API pattern
     * (e.g., /v1beta/models/gemini-pro:generateContent).
     * @param request The incoming request.
     * @returns True if the path matches, false otherwise.
     */
    match(request: Request): boolean {
        const url = new URL(request.url);
        const path = url.pathname;
        // Check if path includes '/models/' and ends with a Gemini action suffix
        // This covers both /v1beta/models/... and /models/... patterns
        const hasModelsSegment = path.includes('/models/');
        const hasActionSuffix = path.endsWith(':generateContent') || path.endsWith(':embedContent') || path.endsWith(':streamGenerateContent')
        return hasModelsSegment && hasActionSuffix;
    }

    async parseModelName(request: Request): Promise<string | null> {
        try {
            const url = new URL(request.url);
            const match = url.pathname.match(/\/models\/([^/:]+)/);
            if (match && match[1]) {
                return match[1];
            }
        } catch (e) {
            console.warn("GeminiHandler: Could not parse URL or extract model name from path.", e);
        }
        return null;
    }

    /**
     * Parses the API key from the incoming request's Authorization header.
     * Expects the format "Bearer <key>".
     * @param request The incoming request.
     * @returns The API key string or null if not found or in incorrect format.
     */
    parseApiKey(request: Request): string | null {
        const headerApiKey = request.headers.get('x-goog-api-key');
        if (headerApiKey) {
            return headerApiKey;
        }

        const url = new URL(request.url);
        const queryApiKey = url.searchParams.get('key');
        if (queryApiKey) {
            return queryApiKey;
        }

        return null;
    }

    buildUpstreamRequest(request: Request, apiKey: string | null, modelName: string, env: Env): Request {
        const url = new URL(request.url);
        const params = new URLSearchParams(url.search);
        params.delete('key');

        let pathname = url.pathname;
        // FOR ROO CODE COMPITABLE
        if (pathname.startsWith('/v1beta/')) {
            pathname = pathname.substring('/v1beta'.length);
        }
        const upstreamUrl = `${env.GEMINI_UPSTREAM_URL}${pathname}?${params.toString()}`;

        // console.log("Gemini real redirect url = ", upstreamUrl);

        const upstreamRequest = new Request(upstreamUrl, {
            method: request.method,
            headers: (() => {
                const headers = new Headers(request.headers);
                headers.delete('Authorization');
                if (apiKey !== null) {
                    headers.set('x-goog-api-key', apiKey);
                }
                return headers;
            })(),
            body: request.body,
            redirect: 'follow'
        });

        return upstreamRequest;
    }
}