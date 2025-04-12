// src/types.ts

import { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
    API_KEY_MANAGER: DurableObjectNamespace;
    API_KEYS: string;
    UPSTREAM_API_URL: string;
}

export interface ApiKeyState {
    key: string;
    status: 'available' | 'exhausted';
}

export interface ApiKeyManagerStorage {
    keys?: ApiKeyState[];
    currentIndex?: number;
}