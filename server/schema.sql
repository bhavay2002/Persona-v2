-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  trust_score INTEGER DEFAULT 1000,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Personas
CREATE TABLE IF NOT EXISTS personas (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar_emoji TEXT DEFAULT '🎭',
  tone TEXT,
  ideology TEXT,
  archetype TEXT,
  expertise TEXT[] DEFAULT '{}',
  description TEXT,
  ai_prompt_profile TEXT,
  status VARCHAR(20) DEFAULT 'active',
  is_public BOOLEAN DEFAULT false,
  clone_count INTEGER DEFAULT 0,
  cloned_from INTEGER REFERENCES personas(id),
  post_count INTEGER DEFAULT 0,
  debate_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  reputation_score NUMERIC(6,2) DEFAULT 100,
  trust_score NUMERIC(6,2) DEFAULT 100,
  abuse_flags INTEGER DEFAULT 0,
  shadow_banned BOOLEAN DEFAULT false,
  tone_formality NUMERIC(3,2) DEFAULT 0.5,
  tone_emotionality NUMERIC(3,2) DEFAULT 0.5,
  tone_assertiveness NUMERIC(3,2) DEFAULT 0.5,
  beliefs JSONB DEFAULT '[]',
  rhetorical_style TEXT[] DEFAULT '{}',
  taboos TEXT[] DEFAULT '{}',
  goals TEXT[] DEFAULT '{}',
  constraints_list TEXT[] DEFAULT '{}',
  version INTEGER DEFAULT 1,
  drift_score NUMERIC(5,3) DEFAULT 0,
  baseline_traits JSONB DEFAULT '{}',
  consistency_score NUMERIC(5,2) DEFAULT 100,
  evolution_summary TEXT,
  longitudinal_insight JSONB,
  last_evolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_personas_user_id ON personas(user_id);
CREATE INDEX IF NOT EXISTS idx_personas_status ON personas(status);

-- Posts
CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  persona_id INTEGER REFERENCES personas(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  original_input TEXT,
  original_content TEXT,
  ai_generated BOOLEAN DEFAULT false,
  like_count INTEGER DEFAULT 0,
  topic_tags TEXT[] DEFAULT '{}',
  shadow_banned BOOLEAN DEFAULT false,
  moderation JSONB,
  ai_metrics JSONB,
  intent_type TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_posts_persona_id ON posts(persona_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);

-- Post Likes
CREATE TABLE IF NOT EXISTS post_likes (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

-- Post Thinking Styles
CREATE TABLE IF NOT EXISTS post_thinking_styles (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE UNIQUE,
  thinking_style TEXT,
  confidence NUMERIC(4,3),
  political_bias TEXT,
  emotional_bias TEXT,
  extremity_score NUMERIC(4,3),
  cognitive_metrics JSONB,
  claims JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Debates
CREATE TABLE IF NOT EXISTS debates (
  id SERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  description TEXT,
  persona_a_id INTEGER REFERENCES personas(id) ON DELETE CASCADE,
  persona_b_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'open',
  stance_a TEXT,
  stance_b TEXT,
  votes_a INTEGER DEFAULT 0,
  votes_b INTEGER DEFAULT 0,
  quality_score NUMERIC(4,3),
  trust_score NUMERIC(5,2) DEFAULT 0,
  winner_side VARCHAR(1),
  is_ai_generated BOOLEAN DEFAULT false,
  rounds_total INTEGER DEFAULT 6,
  rounds_completed INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_debates_status ON debates(status);
CREATE INDEX IF NOT EXISTS idx_debates_created_at ON debates(created_at DESC);

-- Debate Messages
CREATE TABLE IF NOT EXISTS debate_messages (
  id SERIAL PRIMARY KEY,
  debate_id INTEGER REFERENCES debates(id) ON DELETE CASCADE,
  persona_id INTEGER REFERENCES personas(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  ai_generated BOOLEAN DEFAULT false,
  msg_type TEXT DEFAULT 'argument',
  logic_score NUMERIC(4,3),
  toxicity_score NUMERIC(4,3),
  persuasiveness_score NUMERIC(4,3),
  fallacies JSONB DEFAULT '[]',
  is_strongest BOOLEAN DEFAULT false,
  ai_metrics JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_debate_messages_debate_id ON debate_messages(debate_id);

-- Debate Votes
CREATE TABLE IF NOT EXISTS debate_votes (
  id SERIAL PRIMARY KEY,
  debate_id INTEGER REFERENCES debates(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  voted_for VARCHAR(1) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(debate_id, user_id)
);

-- Persona Evolution Log
CREATE TABLE IF NOT EXISTS persona_evolution_log (
  id SERIAL PRIMARY KEY,
  persona_id INTEGER REFERENCES personas(id) ON DELETE CASCADE,
  previous_profile TEXT,
  new_profile TEXT,
  delta_summary TEXT,
  trigger_type TEXT DEFAULT 'auto',
  version_before INTEGER,
  version_after INTEGER,
  changes_explained TEXT,
  updated_traits JSONB,
  confidence NUMERIC(4,3) DEFAULT 0.7,
  drift_score NUMERIC(5,3) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evolution_persona_id ON persona_evolution_log(persona_id);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);

-- Activity Log
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_user_id ON activity_log(user_id);

-- Moderation Log
CREATE TABLE IF NOT EXISTS moderation_log (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Job Queue (PostgreSQL-backed)
CREATE TABLE IF NOT EXISTS job_queue (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  process_after TIMESTAMP DEFAULT NOW(),
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status, process_after);

-- Persona Marketplace
CREATE TABLE IF NOT EXISTS persona_marketplace (
  id SERIAL PRIMARY KEY,
  persona_id INTEGER REFERENCES personas(id) ON DELETE CASCADE UNIQUE,
  tags TEXT[] DEFAULT '{}',
  rating NUMERIC(3,2) DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  downloads INTEGER DEFAULT 0,
  featured BOOLEAN DEFAULT false,
  published_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_persona_id ON persona_marketplace(persona_id);

-- Persona Cognitive Timeseries
CREATE TABLE IF NOT EXISTS persona_cognitive_timeseries (
  id SERIAL PRIMARY KEY,
  persona_id INTEGER REFERENCES personas(id) ON DELETE CASCADE,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  avg_argument_complexity NUMERIC(4,3),
  avg_openness_score NUMERIC(4,3),
  avg_certainty_score NUMERIC(4,3),
  avg_emotional_intensity NUMERIC(4,3),
  dominant_thinking_style TEXT,
  post_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cognitive_timeseries_persona_id ON persona_cognitive_timeseries(persona_id);

-- Persona Contradictions
CREATE TABLE IF NOT EXISTS persona_contradictions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  persona_a_id INTEGER REFERENCES personas(id) ON DELETE CASCADE,
  persona_b_id INTEGER REFERENCES personas(id) ON DELETE CASCADE,
  claim_a TEXT,
  claim_b TEXT,
  contradiction_type TEXT,
  severity NUMERIC(4,3),
  conflict_score NUMERIC(4,3) DEFAULT 0,
  contradictions JSONB DEFAULT '[]',
  explanation TEXT,
  updated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(persona_a_id, persona_b_id)
);
CREATE INDEX IF NOT EXISTS idx_contradictions_user_id ON persona_contradictions(user_id);

-- Experimentation Layer (A/B Testing)
CREATE TABLE IF NOT EXISTS experiments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  variant_a JSONB NOT NULL DEFAULT '{}',
  variant_b JSONB NOT NULL DEFAULT '{}',
  metric TEXT NOT NULL DEFAULT 'engagement',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS experiment_results (
  id SERIAL PRIMARY KEY,
  experiment_name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  variant VARCHAR(1) NOT NULL,
  metric_value NUMERIC NOT NULL DEFAULT 0,
  event_type TEXT,
  entity_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_experiment_results ON experiment_results(experiment_name, variant);

-- Cognitive Dissonance Score (CDS)
CREATE TABLE IF NOT EXISTS user_cds_scores (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  cds_score NUMERIC(5,3) NOT NULL DEFAULT 0,
  interpretation VARCHAR(20) DEFAULT 'Low',
  dominant_conflict_domains TEXT[] DEFAULT '{}',
  persona_count INTEGER DEFAULT 0,
  pair_count INTEGER DEFAULT 0,
  computed_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_cds ON user_cds_scores(user_id);
