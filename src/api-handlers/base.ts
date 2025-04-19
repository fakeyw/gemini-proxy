import { Env } from "../types";
import { DurableObjectStub, ExecutionContext } from "@cloudflare/workers-types";

export interface ApiHandler {
    /**
     * A string identifier for the API type (e.g., 'openai', 'gemini').
     */
    readonly apiType: string;

    /**
     * Checks if the incoming request matches the characteristics of this API type.
     * @param request The incoming request object.
     * @returns True if the request matches, false otherwise.
     */
    match(request: Request): boolean;

    /**
     * Parses the model name from the incoming request.
     * Returns the model name string or null if not found.
     */
    parseModelName(request: Request): Promise<string | null>;

    /**
     * Builds the upstream request based on the original request, API key, model name, and environment.
     */
    buildUpstreamRequest(request: Request, apiKey: string, modelName: string, env: Env): Request;

    /**
     * Optional: Handles specific upstream errors (e.g., 429) and determines if a retry is needed.
     * Returns true if a retry is needed, false otherwise.
     */
    handleUpstreamError?(response: Response, apiKey: string, modelName: string, managerStub: DurableObjectStub, ctx: ExecutionContext): Promise<boolean>;
}