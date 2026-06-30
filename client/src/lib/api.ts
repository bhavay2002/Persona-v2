const BASE = '/api';

function getToken() { return localStorage.getItem('persona_token'); }

function headers() {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) h['Authorization'] = `Bearer ${t}`;
  return h;
}

async function request(method: string, path: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  // Auth
  register: (email: string, password: string) => request('POST', '/auth/register', { email, password }),
  login: (email: string, password: string) => request('POST', '/auth/login', { email, password }),
  me: () => request('GET', '/auth/me'),

  // Personas
  getPersonas: () => request('GET', '/personas'),
  getPublicPersonas: () => request('GET', '/personas/public'),
  getPersona: (id: number) => request('GET', `/personas/${id}`),
  createPersona: (data: any) => request('POST', '/personas', data),
  updatePersona: (id: number, data: any) => request('PUT', `/personas/${id}`, data),
  deletePersona: (id: number) => request('DELETE', `/personas/${id}`),
  clonePersona: (id: number) => request('POST', `/personas/${id}/clone`),
  setPersonaStatus: (id: number, status: 'draft' | 'active' | 'archived') =>
    request('PATCH', `/personas/${id}/status`, { status }),

  // Posts
  getPosts: (params?: Record<string, any>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request('GET', `/posts${q}`);
  },
  createPost: (data: any) => request('POST', '/posts', data),
  likePost: (id: number) => request('POST', `/posts/${id}/like`),

  // Debates
  getDebates: (params?: Record<string, any>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request('GET', `/debates${q}`);
  },
  getDebate: (id: number) => request('GET', `/debates/${id}`),
  createDebate: (data: any) => request('POST', '/debates', data),
  joinDebate: (id: number, data: any) => request('POST', `/debates/${id}/join`, data),
  sendDebateMessage: (id: number, data: any) => request('POST', `/debates/${id}/message`, data),
  voteDebate: (id: number, votedFor: 'a' | 'b') => request('POST', `/debates/${id}/vote`, { votedFor }),

  // AI
  rewriteText: (text: string, personaId: number) => request('POST', '/ai/rewrite', { text, personaId }),
  generateArgument: (topic: string, personaId: number, side?: string, previousMessages?: any[], debateId?: number) =>
    request('POST', '/ai/generate-argument', { topic, personaId, side, previousMessages, debateId }),
  enhancePersona: (data: any) => request('POST', '/ai/enhance-persona', data),
  suggestPersona: (keyword: string) => request('POST', '/ai/suggest-persona', { keyword }),
  evolvePersona: (personaId: number) => request('POST', '/ai/evolve-persona', { personaId }),

  // Feed
  getFeed: (type?: string, tag?: string) => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (tag) params.set('tag', tag);
    const q = params.toString() ? `?${params}` : '';
    return request('GET', `/feed${q}`);
  },

  // Insights
  getInsights: () => request('GET', '/insights'),

  // Marketplace
  getMarketplace: (params?: Record<string, any>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request('GET', `/marketplace${q}`);
  },
  publishPersona: (id: number, tags?: string[]) => request('POST', `/marketplace/${id}/publish`, { tags: tags || [] }),
  unpublishPersona: (id: number) => request('DELETE', `/marketplace/${id}/publish`),
  cloneMarketplacePersona: (id: number) => request('POST', `/marketplace/${id}/clone`),
  ratePersona: (id: number, rating: number) => request('POST', `/marketplace/${id}/rate`, { rating }),

  // AI vs AI Debate
  createAiDebate: (data: any) => request('POST', '/debates/ai-vs-ai', data),
  startLiveDebate: (id: number) => request('POST', `/debates/${id}/live-start`, {}),

  // Opposite Persona
  generateOppositePersona: (sourcePersonaId?: number) => request('POST', '/ai/opposite-persona', { sourcePersonaId }),

  // Activity log
  getActivity: (limit = 30) => request('GET', `/activity?limit=${limit}`),

  // Notifications
  getNotifications: (limit = 30) => request('GET', `/notifications?limit=${limit}`),
  getNotificationCount: () => request('GET', '/notifications/count'),
  markNotificationRead: (id: number) => request('PATCH', `/notifications/${id}/read`),
  markAllNotificationsRead: () => request('PATCH', '/notifications/read-all'),

  // Knowledge Graph
  getKgGraph: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request('GET', `/kg/graph${q}`);
  },
  getKgClaims: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return request('GET', `/kg/claims${q}`);
  },
  getKgClaim: (id: number) => request('GET', `/kg/claims/${id}`),
  getKgTopics: () => request('GET', '/kg/topics'),
  getKgStats: () => request('GET', '/kg/stats'),
  getKgDebateSuggestions: () => request('GET', '/kg/debate-suggestions'),
  getKgPersonaProfile: (personaId: number) => request('GET', `/kg/persona/${personaId}`),
  extractKgClaims: (data: { text: string; personaId?: number; postId?: number; debateMessageId?: number }) =>
    request('POST', '/kg/extract', data),

  // Explainability
  analyzeArgument: (data: { text: string; personaId?: number; postId?: number; debateMessageId?: number }) =>
    request('POST', '/kg/explain', data),
  getStoredAnalysis: (type: 'post' | 'debate_message', id: number) =>
    request('GET', `/kg/explain/${type}/${id}`),
  detectFallacies: (text: string) => request('POST', '/kg/detect-fallacies', { text }),

  // Personalization Engine
  getPersonalizationProfile: () => request('GET', '/personalization/profile'),
  updatePersonalizationProfile: (data: { challenge_mode?: boolean; openness_score?: number; skill_level?: number }) =>
    request('PATCH', '/personalization/profile', data),
  resetPersonalizationProfile: () => request('POST', '/personalization/profile/reset'),
  getPersonalizedFeed: (params?: { limit?: number; tag?: string }) => {
    const q = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : '';
    return request('GET', `/personalization/feed${q}`);
  },
  getAdaptiveDifficulty: () => request('GET', '/personalization/difficulty'),
  getPersonalizationContext: () => request('GET', '/personalization/context'),
  analyzeTextForProfile: (text: string) => request('POST', '/personalization/analyze-text', { text }),
  getPersonalizationInsights: () => request('GET', '/personalization/insights'),

  // Resilience Layer
  getResilienceStatus: () => request('GET', '/resilience/status'),
  getResilienceMetrics: () => request('GET', '/resilience/metrics'),
  resetCircuitBreaker: (name: string) => request('POST', `/resilience/circuit/${name}/reset`),
  forceOpenBreaker: (name: string) => request('POST', `/resilience/circuit/${name}/open`),
  getChaosConfig: () => request('GET', '/resilience/chaos'),
  updateChaosConfig: (data: {
    enabled?: boolean;
    ai_failure_probability?: number;
    ai_latency_probability?: number;
    ai_latency_ms?: number;
    db_failure_probability?: number;
  }) => request('POST', '/resilience/chaos', data),
  getResilienceEvents: (limit?: number) =>
    request('GET', `/resilience/events${limit ? `?limit=${limit}` : ''}`),

  // Truth Calibration + Multi-Task Analysis
  getCalibrationStatus: () => request('GET', '/calibration/status'),
  getReliabilityCurve: () => request('GET', '/calibration/reliability-curve'),
  getEvaluationQueue: (limit?: number) =>
    request('GET', `/calibration/queue${limit ? `?limit=${limit}` : ''}`),
  submitCalibrationLabel: (evaluationId: number, label: 0 | 1, reason?: string) =>
    request('POST', '/calibration/label', { evaluation_id: evaluationId, label, reason }),
  runCalibrationEval: (text: string, postId?: number) =>
    request('POST', '/calibration/evaluate', { text, post_id: postId }),
  runMultiTaskAnalysis: (text: string, inferenceMode?: string) =>
    request('POST', '/calibration/multi-task', { text, inference_mode: inferenceMode }),
  getTaskPerformance: (limit?: number) =>
    request('GET', `/calibration/tasks${limit ? `?limit=${limit}` : ''}`),
  getCalibrationEvaluations: (limit?: number) =>
    request('GET', `/calibration/evaluations${limit ? `?limit=${limit}` : ''}`),
  bulkCalibratePost: (data: { limit?: number }) =>
    request('POST', '/calibration/bulk-calibrate', data),

  // Evaluation System
  getEvalDatasets: () => request('GET', '/eval/datasets'),
  runEval: (dataset_name: string, model_version: string, fast_mode: boolean) =>
    request('POST', '/eval/run', { dataset_name, model_version, fast_mode }),
  getEvalHistory: (limit?: number) =>
    request('GET', `/eval/history${limit ? `?limit=${limit}` : ''}`),
  getModelVersions: () => request('GET', '/eval/versions'),
  createModelVersion: (data: { version_name: string; config: any; status?: string }) =>
    request('POST', '/eval/versions', data),
  updateVersionStatus: (name: string, status: string) =>
    request('PATCH', `/eval/versions/${name}`, { status }),
  getGateSummary: (dataset_name?: string) =>
    request('GET', `/eval/gate${dataset_name ? `?dataset_name=${dataset_name}` : ''}`),
  runShadowTest: (text: string, version_a: string, version_b: string) =>
    request('POST', '/eval/shadow', { text, version_a, version_b }),
  getShadowTests: (limit?: number) =>
    request('GET', `/eval/shadow${limit ? `?limit=${limit}` : ''}`),
  getOnlineMetrics: (model_version?: string, days?: number) =>
    request('GET', `/eval/online${model_version ? `?model_version=${model_version}` : ''}${days ? `&days=${days}` : ''}`),

  // RAG Pipeline
  ragQuery: (query: string, top_k?: number, skip_grounding?: boolean) =>
    request('POST', '/eval/rag/query', { query, top_k, skip_grounding }),
  getRAGStats: () => request('GET', '/eval/rag/stats'),
  ingestRAGDocument: (data: { content: string; title?: string; source?: string; source_quality?: number; topic?: string }) =>
    request('POST', '/eval/rag/ingest', data),
  syncPostsToRAG: (limit?: number) =>
    request('POST', '/eval/rag/sync-posts', { limit }),
  getRAGDocuments: (limit?: number) =>
    request('GET', `/eval/rag/documents${limit ? `?limit=${limit}` : ''}`),

  // Observability
  getMetricsSummary: () => request('GET', '/observability/metrics/summary'),
  getSLOStatus: () => request('GET', '/observability/metrics/slo'),
  getLatencyBreakdown: () => request('GET', '/observability/metrics/latency'),
  getRequestLogs: (limit?: number, hours?: number) =>
    request('GET', `/observability/logs${limit ? `?limit=${limit}` : ''}${hours ? `&hours=${hours}` : ''}`),
};
