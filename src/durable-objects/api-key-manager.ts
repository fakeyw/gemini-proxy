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
        if (stored?.keys && stored.currentIndex !== undefined) {
            this.keysState = stored.keys;
            this.currentIndex = stored.currentIndex;
            console.log(`Loaded state: ${this.keysState.length} keys, current index ${this.currentIndex}`);
        } else {
            const apiKeysString = this.env.API_KEYS;
            console.log(this.env);
            if (!apiKeysString) {
                console.error("API_KEYS env not set.");
                this.keysState = [];
                this.currentIndex = 0;
            } else {
                const keys = apiKeysString.split(',').map(k => k.trim()).filter(Boolean);
                this.keysState = keys.map(key => ({ key: key, status: 'available' }));
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
            default:
                return new Response("Not found in Durable Object", { status: 404 });
        }
    }

    /**
     * @description Handles the /getKey route, returning an available API key.
     * @param {Request} request - The client request.
     * @returns {Promise<Response>} - Returns a Promise that resolves to a Response object containing the API key.
     */
    async handleGetKey(request: Request): Promise<Response> {
        if (this.keysState.length === 0) {
            return new Response("API key not configured", { status: 500 });
        }

        let attempts = 0;
        const maxAttempts = this.keysState.length;

        while (attempts < maxAttempts) {
            const currentKeyData = this.keysState[this.currentIndex];
            if (currentKeyData.status === 'available') {
                console.log(`Providing key (index ${this.currentIndex}): ${currentKeyData.key.substring(0, 5)}...`);
                // Return the currently used key and index for easy marking by the worker.
                return new Response(JSON.stringify({ apiKey: currentKeyData.key, index: this.currentIndex }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            this.currentIndex = (this.currentIndex + 1) % this.keysState.length;
            attempts++;
        }

        console.warn("All API keys have been marked as exhausted.");
        return new Response("All API keys have been marked as exhausted", { status: 429 });
    }

    /**
     * @description Handles the /markExhausted route, marking the specified API key as exhausted.
     * @param {Request} request - The client request.
     * @returns {Promise<Response>} - Returns a Promise that resolves to a Response object representing the operation result.
     */
    async handleMarkExhausted(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const apiKeyToMark = url.searchParams.get("key");

        if (!apiKeyToMark) {
            return new Response("Missing 'key' query parameter", { status: 400 });
        }

        let marked = false;
        const keyIndex = this.keysState.findIndex(k => k.key === apiKeyToMark);

        if (keyIndex !== -1 && this.keysState[keyIndex].status === 'available') {
            this.keysState[keyIndex].status = 'exhausted';
            marked = true;
            // Only move the index if the exhausted key is the one currently pointed to
            if (this.currentIndex === keyIndex) {
                this.currentIndex = (this.currentIndex + 1) % this.keysState.length;
            }
            console.log(`Marking key as exhausted: ${apiKeyToMark.substring(0, 5)}... (index ${keyIndex}). Current index is now ${this.currentIndex}`);
            await this.saveState();
            return new Response(`Marked key ${apiKeyToMark.substring(0, 5)}... as exhausted`, { status: 200 });
        } else {
            console.log(`Key not found or already exhausted: ${apiKeyToMark.substring(0, 5)}...`);
            return new Response("Key not found or already exhausted", { status: 404 });
        }
    }

    /**
     * @description Handles the /reset route, resetting the status of all API keys to available.
     * @param {Request} request - The client request.
     * @returns {Promise<Response>} - Returns a Promise that resolves to a Response object representing the operation result.
     */
    async handleReset(request: Request): Promise<Response> {
        if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
        }

        console.log("Resetting the status of all API keys to available.");
        this.keysState.forEach(keyData => keyData.status = 'available');
        this.currentIndex = 0;
        await this.saveState();
        return new Response("All API key statuses have been reset", { status: 200 });
    }
}