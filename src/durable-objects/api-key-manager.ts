// src/durable-objects/api-key-manager.ts

import { DurableObjectState } from "@cloudflare/workers-types";
import { Env, ApiKeyState, ApiKeyManagerStorage } from "../types";

export class ApiKeyManager {
    state: DurableObjectState;
    env: Env;
    keysState: ApiKeyState[] = [];
    currentIndex: number = 0;
    initialized: boolean = false;
    initializePromise: Promise<void> | null = null;
    constructor(state: DurableObjectState, env: Env) {
        this.state = state;
        this.env = env;
        this.initializePromise = this.state.blockConcurrencyWhile(async () => {
            await this.loadState();
            this.initialized = true;
        });
    }
    async loadState() {
        const stored: ApiKeyManagerStorage | undefined = await this.state.storage.get("keyManagerState");

        if (stored?.keys && stored.currentIndex !== undefined && stored.keys.length > 0) {
            // Load existing state
            this.keysState = stored.keys;
            this.currentIndex = stored.currentIndex;
            console.log(`Loaded state: ${this.keysState.length} keys, current index ${this.currentIndex}`);

            this.keysState.forEach(keyData => {
                // Ensure usageCount exists (for compatibility with older states)
                if (keyData.usageCount === undefined) {
                    keyData.usageCount = {};
                }
                // Ensure exhaustedModels exists (for compatibility with older states)
                if (keyData.exhaustedModels === undefined) {
                    keyData.exhaustedModels = [];
                }
            });
            // Ensure exhaustedReasons exists (for compatibility with older states)
            this.keysState.forEach(keyData => {
                if (keyData.exhaustedReasons === undefined) {
                    keyData.exhaustedReasons = {};
                }
            });

        } else {
            if (stored?.keys && stored.currentIndex !== undefined) {
                console.warn("Loaded state format is outdated or invalid. Re-initializing from environment variables.");
            } else {
                console.log("No stored state found. Initializing from environment variables.");
            }

            const apiKeysString = this.env.API_KEYS;
            console.log(this.env);
            if (!apiKeysString) {
                console.error("API_KEYS env not set.");
                this.keysState = [];
                this.currentIndex = 0;
            } else {
                const keys = apiKeysString.split(',').map(k => k.trim()).filter(Boolean);
                this.keysState = keys.map(key => ({ key: key, exhaustedModels: [], usageCount: {} }));
                this.currentIndex = 0;
                console.log(`Initialized state from environment variables: ${this.keysState.length} keys`);
                await this.saveState();
            }
        }
    }

    async saveState() {
        const stateToStore: ApiKeyManagerStorage = {
            keys: this.keysState,
            currentIndex: this.currentIndex,
        };
        await this.state.storage.put("keyManagerState", stateToStore);
        console.log(`Saved state: ${this.keysState.length} keys, current index ${this.currentIndex}`);
    }

    /**
     * @description Durable Object's fetch function, used to handle different API requests.
     * @param {Request} request - The client request.
     * @returns {Promise<Response>} - Returns a Promise that resolves to a Response object.
     */
    async fetch(request: Request): Promise<Response> {
        if (!this.initialized && this.initializePromise) {
            await this.initializePromise;
        } else if (!this.initialized) {
            await this.state.blockConcurrencyWhile(async () => {
                await this.loadState();
                this.initialized = true;
            });
        }

        const url = new URL(request.url);

        switch (url.pathname) {
            case "/getKey":
                return this.handleGetKey(request);
            case "/markExhausted":
                return this.handleMarkExhausted(request);
            case "/reset":
                return this.handleReset(request);
            case "/incrementUsage":
                return this.handleIncrementUsage(request);
            case "/getAllStats":
                return this.handleGetAllStats(request);
            default:
                return new Response("Not found in Durable Object", { status: 404 });
        }
    }

    /**
     * @description Handles the /getKey route, returning an available API key for a specific model.
     * @param {Request} request - The client request.
     * @returns {Promise<Response>} - Returns a Promise that resolves to a Response object containing the API key.
     */
    async handleGetKey(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const modelName = url.searchParams.get("model"); // Get model name
        const apiType = url.searchParams.get("api_type");

        if (this.keysState.length === 0) {
            return new Response("API key not configured", { status: 500 });
        }

        let attempts = 0;
        const maxAttempts = this.keysState.length;
        let searchIndex = this.currentIndex; // Start searching from the current index

        while (attempts < maxAttempts) {
            const currentKeyData = this.keysState[searchIndex];

            let isAvailable = false;
            if (modelName) {
                isAvailable = !currentKeyData.exhaustedModels.includes(modelName);
            } else {
                isAvailable = true;
            }

            if (isAvailable) {
                console.log(`Providing key (index ${searchIndex}) ${modelName ? `for model ${modelName}, api ${apiType}` : ''}: ${currentKeyData.key.substring(0, 5)}...`);
                this.currentIndex = (searchIndex + 1) % this.keysState.length;
                return new Response(JSON.stringify({ apiKey: currentKeyData.key, index: searchIndex }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            searchIndex = (searchIndex + 1) % this.keysState.length;
            attempts++;
        }

        if (modelName) {
            console.warn(`All API keys are exhausted for model ${modelName}.`);
            return new Response(`All API keys exhausted for model ${modelName}`, { status: 429 });
        } else {
            console.warn("Could not find an available API key (no model specified).");
            return new Response("Could not find an available API key", { status: 429 });
        }
    }

    /**
     * @description Handles the /markExhausted route, marking the specified API key as exhausted for a specific model.
     * @param {Request} request - The client request.
     * @returns {Promise<Response>} - Returns a Promise that resolves to a Response object representing the operation result.
     */
    async handleMarkExhausted(request: Request): Promise<Response> {
        if (request.method !== "POST") {
             return new Response("Method Not Allowed", { status: 405 });
        }
        const { key: apiKeyToMark, model: modelName, reason } = await request.json<{ key: string; model: string; reason: string }>();

        if (!apiKeyToMark || !modelName || reason === undefined) {
            return new Response("Missing 'key', 'model', or 'reason' in request body", { status: 400 });
        }

        const keyIndex = this.keysState.findIndex(k => k.key === apiKeyToMark);

        if (keyIndex !== -1) {
            const keyData = this.keysState[keyIndex];
            // Ensure exhaustedReasons exists
            if (!keyData.exhaustedReasons) {
                keyData.exhaustedReasons = {};
            }
            if (!keyData.exhaustedModels.includes(modelName)) {
                keyData.exhaustedModels.push(modelName);
            }
            // Store or update the reason
            keyData.exhaustedReasons[modelName] = reason;
            console.log(`Marking key ${apiKeyToMark.substring(0, 5)}... (index ${keyIndex}) as exhausted for model ${modelName}. Reason: ${reason}`);
            await this.saveState();
            return new Response(`Marked key ${apiKeyToMark.substring(0, 5)}... as exhausted for model ${modelName}`, { status: 200 });
        } else {
            console.log(`Key not found: ${apiKeyToMark.substring(0, 5)}...`);
            return new Response("Key not found", { status: 404 });
        }
    }

    /**
     * @description Handles the /reset route, resetting the exhausted models list for all API keys.
     * @param {Request} request - The client request.
     * @returns {Promise<Response>} - Returns a Promise that resolves to a Response object representing the operation result.
     */
    async handleReset(request: Request): Promise<Response> {
        if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
        }

        console.log("Resetting the exhausted models list for all API keys.");
        this.keysState.forEach(keyData => {
            keyData.exhaustedModels = []; // Reset exhausted models
            keyData.usageCount = {}; // Reset usage count
            keyData.exhaustedReasons = {}; // 新增：清空耗尽原因
        });
        this.currentIndex = 0; // Reset index
        await this.saveState();
        return new Response("All API key exhausted model lists, usage counts, and reasons have been reset", { status: 200 });
    }
    /**
     * @description Handles the /incrementUsage route, increments the usage count for a specific key and model.
     * @param {Request} request - The client request.
     * @returns {Promise<Response>} - Returns a Promise that resolves to a Response object representing the operation result.
     */
    async handleIncrementUsage(request: Request): Promise<Response> {
        if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
        }

        const url = new URL(request.url);
        const apiKeyToIncrement = url.searchParams.get("key");
        const modelName = url.searchParams.get("model");

        if (!apiKeyToIncrement) {
            return new Response("Missing 'key' query parameter", { status: 400 });
        }
        if (!modelName) {
            return new Response("Missing 'model' query parameter", { status: 400 });
        }

        const keyIndex = this.keysState.findIndex(k => k.key === apiKeyToIncrement);

        if (keyIndex !== -1) {
            const keyData = this.keysState[keyIndex];
            // Ensure usageCount exists (for compatibility)
            if (keyData.usageCount === undefined) {
                keyData.usageCount = {};
            }
            // Increment count for the specific model
            keyData.usageCount[modelName] = (keyData.usageCount[modelName] || 0) + 1;

            console.log(`Incremented usage for key ${apiKeyToIncrement.substring(0, 5)}... (index ${keyIndex}) for model ${modelName}. New count: ${keyData.usageCount[modelName]}`);
            await this.saveState();
            return new Response(`Incremented usage for key ${apiKeyToIncrement.substring(0, 5)}... model ${modelName}`, { status: 200 });
        } else {
            console.log(`Key not found for incrementing usage: ${apiKeyToIncrement.substring(0, 5)}...`);
            return new Response("Key not found", { status: 404 });
        }
    }

    /**
     * @description Handles the /getAllStats route, returns usage statistics for all keys.
     * @param {Request} request - The client request.
     * @returns {Promise<Response>} - Returns a Promise that resolves to a Response object containing the statistics.
     */
    async handleGetAllStats(request: Request): Promise<Response> {
        if (request.method !== "GET") {
            return new Response("Method Not Allowed", { status: 405 });
        }

        console.log("Providing all API key usage statistics.");

        // Return a structure containing key, usageCount, exhaustedModels, and exhaustedReasons
        const stats = this.keysState.map(keyData => ({
            key: keyData.key,
            usageCount: keyData.usageCount || {}, // Ensure usageCount is an object even if undefined
            exhaustedModels: keyData.exhaustedModels || [], // Include exhausted models
            exhaustedReasons: keyData.exhaustedReasons || {} // Include reasons
        }));

        return new Response(JSON.stringify(stats), {
            headers: { 'Content-Type': 'application/json' },
            status: 200
        });
    }
}