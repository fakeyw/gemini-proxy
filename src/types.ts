// src/types.ts

import { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
    API_KEY_MANAGER: DurableObjectNamespace;
    API_KEYS: string;
    GEMINI_UPSTREAM_URL: string;
    OPENAI_UPSTREAM_URL: string;
    ASSETS: Fetcher; // Add ASSETS binding
    // API_TYPE is now determined dynamically
    // UPSTREAM_API_URL is now specific to each handler (e.g., GEMINI_UPSTREAM_URL)
}

export interface ApiKeyState {
    key: string;
    exhaustedModels: string[];
    usageCount: { [modelName: string]: number }; // 新增：记录每个模型的调用次数
}

export interface ApiKeyManagerStorage {
    keys?: ApiKeyState[];
    currentIndex?: number;
}