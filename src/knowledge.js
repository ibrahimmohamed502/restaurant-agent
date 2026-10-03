import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const knowledgePath = path.join(__dirname, '..', 'knowledge.json');

/**
 * The "knowledge base" from the workflow diagram (استخراج التفاصيل من المعرفة).
 * Edit knowledge.json — no code changes needed. The agent answers
 * menu/hours/location/offers questions from this data ONLY.
 */
export const knowledgeBase = JSON.parse(readFileSync(knowledgePath, 'utf8'));
