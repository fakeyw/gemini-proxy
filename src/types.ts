// src/types.ts

import { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
    API_KEY_MANAGER: DurableObjectNamespace;
    API_KEYS: string;
    UPSTREAM_API_URL: string;
    ASSETS: Fetcher; // Add ASSETS binding
}

export interface ApiKeyState {
    key: string;
    status: 'available' | 'exhausted';
}

export interface ApiKeyManagerStorage {
    keys?: ApiKeyState[];
    currentIndex?: number;
}