// Shared Gemini AI client — single instance for the entire server.
// Import `genAI` and `GEMINI_MODEL` from here instead of instantiating per-module.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_MODEL } from '../config.js';

if (!process.env.GEMINI_API_KEY) {
  console.warn('[gemini] GEMINI_API_KEY is not set — AI features will use fallback responses');
}

export const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export function getModel(model = GEMINI_MODEL) {
  return genAI.getGenerativeModel({ model });
}

export { GEMINI_MODEL };
