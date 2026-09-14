// Contract stub: replaced by the port. Signatures are the interface other packages code against.
const notImplemented = (name: string): never => { throw new Error(`${name} is not implemented yet`); };

export interface ToolCall { name: string; summary: string; is_error: boolean }
export interface BashCall { command: string; is_error: boolean; tail: string }
export interface HookStat { runs: number; errors: number; max_ms: number }
export interface EvidencePack {
  session_id: string; cwd: string; prompts: string[]; final_assistant_texts: string[]; tool_calls: ToolCall[];
  bash: BashCall[]; test_like: BashCall[]; skills_used: string[]; agents_used: Array<{ subagent_type: string; model: string | null }>;
  hooks: Record<string, HookStat>; errors: string[];
  counts: { tool_uses: number; turns: number; user_prompts: number; attachments: number };
  git: { head_at_start: string | null; head_now: string | null; diff_stat: string; diff_excerpt: string; files_changed: string[] };
}
export interface EvidenceOptions { gitHeadAtStart?: string | null; maxChars?: number }

export function* iterRecords(_path: string, _maxBytes?: number): Generator<Record<string, unknown>> { notImplemented("iterRecords"); }
export function countToolUses(_path: string): number { return notImplemented("countToolUses"); }
export function evidencePack(_transcriptPath: string, _cwd: string, _opts?: EvidenceOptions): EvidencePack { return notImplemented("evidencePack"); }
