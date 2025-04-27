import { DurableObjectStub, ExecutionContext } from "@cloudflare/workers-types";

/**
 * @description Gets an available API key from the Durable Object.
 * @param {DurableObjectStub} managerStub - The Durable Object stub.
 * @returns {Promise<string>} - The API key string.
 * @throws {Error} - If communication fails or no key is available.
 */
export async function getApiKey(managerStub: DurableObjectStub, modelName: string, apiType: string): Promise<string> {
    let apiKeyResponse: Response;
    try {
        apiKeyResponse = await managerStub.fetch(`https://internal-do/getKey?model=${encodeURIComponent(modelName)}&api_type=${encodeURIComponent(apiType)}`);
    } catch (err) {
        console.error("Error fetching key from Durable Object:", err);
        throw new Error("Failed to communicate with key manager");
    }

    if (apiKeyResponse.status === 429) {
        console.warn(`Could not get API key from manager (status ${apiKeyResponse.status}): All keys are exhausted for model ${modelName}.`);
        throw new Error(`All API keys are currently exhausted for model ${modelName}`);
    } else if (!apiKeyResponse.ok) {
        const errorBody = await apiKeyResponse.text();
        console.warn(`Could not get API key from manager for model ${modelName} (status ${apiKeyResponse.status}): ${errorBody}`);
        throw new Error(errorBody || "Failed to get an available API key");
    }

    const { apiKey } = await apiKeyResponse.json<{ apiKey: string }>();
    if (!apiKey) {
        console.error("Durable Object returned OK, but no API key found in response.");
        throw new Error("Internal error: Invalid response from key manager");
    }
    return apiKey;
}

/**
 * Handles the upstream 429 response by marking the key as exhausted in the DO.
 */
export function handleUpstream429(apiKey: string, managerStub: DurableObjectStub, ctx: ExecutionContext, modelName: string, reason: string): void { // Added reason parameter
    console.warn(`API key ${apiKey.substring(0, 5)}... may be exhausted for model ${modelName} (status 429). Reason: ${reason}. Marking as exhausted.`);
    // Removed query parameters from URL
    const markRequest = new Request(`https://internal-do/markExhausted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }, // Added header
        body: JSON.stringify({ key: apiKey, model: modelName, reason: reason }) // Added body
    });
    try {
        ctx.waitUntil(managerStub.fetch(markRequest).catch(err => console.error(`Failed to mark key ${apiKey.substring(0, 5)} exhausted for model ${modelName}:`, err)));
    } catch (err) {
        console.error(`Error scheduling key exhaustion update for ${apiKey.substring(0, 5)}... model ${modelName}: `, err);
    }
}