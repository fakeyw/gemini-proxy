// src/types.ts

import { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
    API_KEY_MANAGER: DurableObjectNamespace;
    API_KEYS: string;
    GEMINI_UPSTREAM_URL: string;
    OPENAI_UPSTREAM_URL: string;
    PROXY_API_KEY?: string;
    ASSETS: Fetcher;
}

export interface ApiKeyState {
    key: string;
    exhaustedModels: string[];
    usageCount: { [modelName: string]: number };
    exhaustedReasons?: Record<string, string>;
}

export interface ApiKeyManagerStorage {
    keys?: ApiKeyState[];
    currentIndex?: number;
}