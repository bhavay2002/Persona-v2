import { httpDuration, queueDuration, ragRecall } from './metrics.js';

export function startHttpTimer(method: string, route: string) {
  return httpDuration.startTimer({ method, route });
}

export function startQueueTimer(queue: string, job: string) {
  return queueDuration.startTimer({ queue, job });
}

export function setRagRecall(scope: string, value: number) {
  ragRecall.set({ persona_scope: scope }, value);
}