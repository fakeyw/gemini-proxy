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
			console.log(`已加载状态：${this.keysState.length} 个 key，当前索引 ${this.currentIndex}`);
		} else {
			const apiKeysString = this.env.API_KEYS;
			console.log(this.env);
			if (!apiKeysString) {
				console.error("API_KEYS 环境变量未设置！");
				this.keysState = [];
				this.currentIndex = 0;
			} else {
				const keys = apiKeysString.split(',').map(k => k.trim()).filter(Boolean);
				this.keysState = keys.map(key => ({ key: key, status: 'available' }));
				this.currentIndex = 0;
				console.log(`已从环境变量初始化状态：${this.keysState.length} 个 key`);
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
		console.log(`已保存状态：${this.keysState.length} 个 key，当前索引 ${this.currentIndex}`);
	}
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
			case "/getKey": {
				if (this.keysState.length === 0) {
					return new Response("未配置 API key", { status: 500 });
				}
				let attempts = 0;
				const maxAttempts = this.keysState.length;
				while (attempts < maxAttempts) {
					const currentKeyData = this.keysState[this.currentIndex];
					if (currentKeyData.status === 'available') {
						console.log(`提供 key (索引 ${this.currentIndex})：${currentKeyData.key.substring(0, 5)}...`);
						// 将当前使用的 key 和索引返回，方便 worker 端标记
						return new Response(JSON.stringify({ apiKey: currentKeyData.key, index: this.currentIndex }), {
							headers: { 'Content-Type': 'application/json' },
						});
					}
					this.currentIndex = (this.currentIndex + 1) % this.keysState.length;
					attempts++;
				}
				console.warn("所有 API key 都已被标记为耗尽。");
				return new Response("所有 API key 都已耗尽", { status: 429 });
			}
			case "/markExhausted": {
				const apiKeyToMark = url.searchParams.get("key");
				if (!apiKeyToMark) {
					return new Response("缺少 'key' 查询参数", { status: 400 });
				}
				let marked = false;
				const keyIndex = this.keysState.findIndex(k => k.key === apiKeyToMark);
				if (keyIndex !== -1 && this.keysState[keyIndex].status === 'available') {
					this.keysState[keyIndex].status = 'exhausted';
					marked = true;
					// 只有当耗尽的是当前索引指向的 key 时，才移动索引
					if (this.currentIndex === keyIndex) {
						this.currentIndex = (this.currentIndex + 1) % this.keysState.length;
					}
					console.log(`标记 key 为耗尽：${apiKeyToMark.substring(0, 5)}... (索引 ${keyIndex})。当前索引现在是 ${this.currentIndex}`);
					await this.saveState();
					return new Response(`已标记 key ${apiKeyToMark.substring(0, 5)}... 为耗尽`, { status: 200 });
				} else {
					console.log(`未找到 key 或已耗尽：${apiKeyToMark.substring(0, 5)}...`);
					return new Response("未找到 key 或已耗尽", { status: 404 });
				}
			}
			case "/reset": {
				if (request.method !== "POST") {
					return new Response("Method Not Allowed", { status: 405 });
				}
				console.log("将所有 API key 状态重置为可用。");
				this.keysState.forEach(keyData => keyData.status = 'available');
				this.currentIndex = 0;
				await this.saveState();
				return new Response("所有 API key 状态已重置", { status: 200 });
			}
			default:
				return new Response("在 Durable Object 中未找到", { status: 404 });
		}
	}
}