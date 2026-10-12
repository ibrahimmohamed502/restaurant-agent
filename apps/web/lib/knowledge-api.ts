import { api } from './api';

export type ValidationError = { section: string; path: string; field: string | null; messageKey: string };
export type ReviewCounts = { added: number; modified: number; removed: number };
export type KnowledgeOverview = {
  source: { id: string; kind: string; title: string; brandId: string | null };
  published: { version: number; updatedAt: string; structured: Record<string, unknown> } | null;
  draft: { id: string; baseVersion: number; status: string; updatedAt: string; content: Record<string, unknown> } | null;
  history: Array<{ version: number; created_at: string; published_by_name: string | null }>;
  permissions: { canEdit: boolean; canPublish: boolean };
};

export const knowledgeApi = {
  overview: (brandId?: string) => api.get<KnowledgeOverview>(`/knowledge${brandId ? `?brandId=${brandId}` : ''}`),
  createDraft: () => api.post<{ draft: Draft; created: boolean }>('/knowledge/draft'),
  saveDraft: (content: Record<string, unknown>, baseVersion: number) =>
    api.post<{ draft: Draft; validation: { ok: boolean; errorCount: number; errors: ValidationError[] } }>('/knowledge/draft/put'.replace('/put', ''), { content, baseVersion }),
  validate: () => api.post<{ ok: boolean; errorCount: number; errors: ValidationError[]; review: Review }>('/knowledge/validate'),
  preview: () => api.post<{ validation: { ok: boolean; errorCount: number; errors: ValidationError[] }; review: Review; preview: Record<string, unknown> }>('/knowledge/preview'),
  publish: () => api.post<{ version: number; history: KnowledgeOverview['history'] }>('/knowledge/publish'),
  discard: () => api.post<{ discarded: boolean }>('/knowledge/discard'),
  history: () => api.get<KnowledgeOverview['history']>('/knowledge/history')
};

export type Draft = { id: string; baseVersion: number; status: string; updatedAt: string; content: Record<string, unknown> };
export type Review = {
  counts: ReviewCounts;
  bySection: Record<string, ReviewCounts>;
  items: Array<{ path: string; type: 'added' | 'modified' | 'removed'; value?: string; from?: string; to?: string }>;
};

/** Localized messages for server validation keys (must match API messageKeys). */
export const VALIDATION_MESSAGES: Record<string, { en: string; ar: string }> = {
  invalid_structure: { en: 'The knowledge structure is invalid.', ar: 'بنية المعرفة غير صحيحة.' },
  required: { en: 'This field is required.', ar: 'هذا الحقل مطلوب.' },
  invalid_url: { en: 'Enter a valid URL (https://…).', ar: 'أدخل رابطًا صحيحًا (https://…).' },
  invalid_phone: { en: 'Enter a valid phone number.', ar: 'أدخل رقم هاتف صحيحًا.' },
  invalid_price: { en: 'Enter a valid price, e.g. 4.650.', ar: 'أدخل سعرًا صحيحًا، مثل 4.650.' },
  duplicate: { en: 'This name already exists.', ar: 'هذا الاسم مستخدم بالفعل.' },
  invalid_type: { en: 'Unexpected data format.', ar: 'صيغة بيانات غير متوقعة.' },
  empty_category: { en: 'Category name cannot be empty.', ar: 'لا يمكن أن يكون اسم الفئة فارغًا.' },
  empty_subcategory: { en: 'Subcategory name cannot be empty.', ar: 'لا يمكن أن يكون اسم القائمة الفرعية فارغًا.' }
};
