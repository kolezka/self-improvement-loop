// Contract stub: replaced by the port. Signatures are the interface other packages code against.
const notImplemented = (name: string): never => { throw new Error(`${name} is not implemented yet`); };

import type { LlmConfig, Role, World } from "@sil/core";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatOptions { world: World; llm?: LlmConfig; jsonMode?: boolean; maxTokens?: number }
export type ChatFn = (role: Role, messages: ChatMessage[], opts: ChatOptions) => Promise<string>;
export interface ProviderStatus { endpoint: string | null; kind: string | null; base_url: string | null; models: Record<string, string | null>; reachable: boolean | null; error: string | null }

export const chat: ChatFn = async (_role, _messages, _opts) => notImplemented("chat");
export async function status(_world: World, _llm?: LlmConfig): Promise<ProviderStatus> { return notImplemented("status"); }
