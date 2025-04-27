import { ApiHandler } from "./base";
import { OpenAIHandler } from "./openai";
import { GeminiHandler } from "./gemini";

/**
 * Manages and provides access to different API handlers based on their type.
 */
class ApiManager {
    private handlers: Map<string, ApiHandler> = new Map();

    /**
     * Registers an API handler instance. The handler's type is determined by its `apiType` property.
     * @param handlerInstance An instance of the ApiHandler.
     */
    public register(handlerInstance: ApiHandler): void {
        const apiType = handlerInstance.apiType;
        if (this.handlers.has(apiType)) {
            console.warn(`ApiHandler for type "${apiType}" is already registered. Overwriting.`);
        }
        this.handlers.set(apiType, handlerInstance);
        console.log(`ApiHandler for type "${apiType}" registered successfully.`);
    }

    /**
     * Retrieves the registered API handler for the given type.
     * @param apiType The string identifier for the API type.
     * @returns The ApiHandler instance or undefined if not found.
     */
    public getHandler(apiType: string): ApiHandler | undefined {
        return this.handlers.get(apiType);
    }

    /**
     * Determines the appropriate API handler for a given request by calling the `match` method
     * of each registered handler.
     * @param request The incoming request object.
     * @returns The matching ApiHandler instance or null if no handler matches.
     */
    public getRequestHandler(request: Request): ApiHandler | null {
        for (const handler of this.handlers.values()) {
            try {
                if (handler.match(request)) {
                    return handler;
                }
            } catch (e) {
                console.error(`Error calling match function for handler type "${handler.apiType}":`, e);
            }
        }
        console.warn("No matching API handler found for the request:", request.method, request.url);
        return null;
    }
}

// Create and export a singleton instance of ApiManager
const apiManager = new ApiManager();

// Register existing handlers
apiManager.register(new OpenAIHandler());
apiManager.register(new GeminiHandler());

export default apiManager;