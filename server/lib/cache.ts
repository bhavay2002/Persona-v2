import NodeCache from 'node-cache';

const feedCache = new NodeCache({ stdTTL: 60, checkperiod: 30, useClones: false });
const personaCache = new NodeCache({ stdTTL: 300, checkperiod: 60, useClones: false });
const aiCache = new NodeCache({ stdTTL: 3600, checkperiod: 300, useClones: false });

export function getCachedFeed(key: string): any | undefined {
  return feedCache.get(key);
}

export function setCachedFeed(key: string, data: any): void {
  feedCache.set(key, data);
}

export function invalidateFeed(): void {
  feedCache.flushAll();
}

export function getCachedPersona(id: number): any | undefined {
  return personaCache.get(`persona:${id}`);
}

export function setCachedPersona(id: number, data: any): void {
  personaCache.set(`persona:${id}`, data);
}

export function invalidatePersona(id: number): void {
  personaCache.del(`persona:${id}`);
}

export function getCachedAI(key: string): string | undefined {
  return aiCache.get<string>(key);
}

export function setCachedAI(key: string, value: string): void {
  aiCache.set(key, value);
}

export function cacheStats() {
  return {
    feed: feedCache.getStats(),
    persona: personaCache.getStats(),
    ai: aiCache.getStats(),
  };
}
