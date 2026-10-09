// Minimal type shim so tests can import the plain-JS backend module.
declare module '*/src/services/knowledge.js' {
  export type KnowledgeError = { section: string; path: string; field: string | null; messageKey: string };
  export type ValidationResult = { ok: boolean; errors: KnowledgeError[] };
  export type ReviewResult = {
    counts: { added: number; modified: number; removed: number };
    bySection: Record<string, { added: number; modified: number; removed: number }>;
    items: Array<{ path: string; type: 'added' | 'modified' | 'removed'; value?: string; from?: string; to?: string }>;
  };
  export function validateKnowledge(knowledge: unknown): ValidationResult;
  export function diffKnowledge(previous: unknown, next: unknown): ReviewResult;
}
