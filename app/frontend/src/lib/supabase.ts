import { createClient } from '@supabase/supabase-js';

/**
 * 前端只使用「公开配置」:Project URL + anon key。
 * service_role key 绝不出现在前端,只配置在 Node Worker 的环境变量里。
 * 请在 app/frontend/.env 中填写(见 .env.example)。
 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key'
);

export type PreviewRecovery = {
  project_id: string;
  sandbox_id: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  phase: string;
  execution_id: string | null;
  preview_url: string | null;
  error: string | null;
  updated_at: string;
};

export type Project = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  framework: string;
  sandbox_id: string | null;
  preview_url: string | null;
  status: string;
  deletion_state?: 'deleting' | 'delete_failed' | null;
  delete_error?: string | null;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: string;
  project_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  meta: Record<string, unknown>;
  task_id: string | null;
  created_at: string;
};

export type TaskStep = { tool: string; phase: string; observation: string; at: string; ok?: boolean; ms?: number; event?: 'started' | 'finished'; path?: string };
export type Stage = { key: string; label: string; status: 'pending' | 'running' | 'done' | 'failed'; note: string };

export type PlanQuestion = { id: string; question: string; options: string[]; recommended?: string };
export type PlanAcceptance = { id: string; action: string; expect: string; external: boolean; steps?: Array<Record<string, unknown>> };

export type PlanContent = {
  understanding: string;
  flows?: string[];
  rules?: string[];
  storage?: string;
  acceptance?: PlanAcceptance[];
  scope?: string[];
  steps: string[];
  design?: string;
  questions?: PlanQuestion[];
};
export type Plan = {
  id: string;
  project_id: string;
  version: number;
  kind: 'plan' | 'action';
  status: 'draft' | 'approved' | 'superseded';
  content: PlanContent;
  source_task_id: string | null;
  approved_at: string | null;
  created_at: string;
};
export type PlanFeedback = {
  id: string;
  plan_id: string;
  plan_version: number;
  content: string;
  answers: Record<string, string>;
  created_at: string;
};

export type Task = {
  id: string;
  project_id: string;
  mode: 'plan' | 'build';
  prompt: string;
  status: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
  phase: string;
  plan: Stage[] | string[];
  steps: TaskStep[];
  error: string | null;
  fix_rounds: number;
  tool_steps: number;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  plan_id: string | null;
  plan_version: number | null;
  round: number | null;
  kind: 'new' | 'resume';
  retry_of: string | null;
  resumes: number;
  last_tool: string | null;
  last_tool_ms: number | null;
};

export type ProjectFile = {
  id: string;
  project_id: string;
  path: string;
  content: string;
  updated_at: string;
};

export type Memory = {
  id: string;
  scope: 'user' | 'project';
  key: string;
  value: string;
  project_id: string | null;
  enabled?: boolean;
};

export type MemorySuggestion = { id: string; key: string; value: string; status: string; created_at: string };
export type FeedbackCategory = 'missing_feature' | 'preview_broken' | 'stuck' | 'design_mismatch' | 'other';
export type TaskFeedback = { id: string; task_id: string; execution_id: string | null; category: FeedbackCategory; note: string; created_at: string };
