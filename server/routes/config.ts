// Central configuration — single source of truth for environment-dependent constants.
// Import from here rather than re-reading process.env in each module.

const DEFAULT_JWT_SECRET = 'persona-secret-key-change-in-prod';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('[FATAL] JWT_SECRET environment variable is not set in production. Refusing to start with default secret.');
  process.exit(1);
}
export const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
export const GEMINI_MODEL = 'gemini-2.5-flash';
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const PORT = parseInt(process.env.PORT || '3001', 10);
