-- THE NEXT FRAME - schema v1
-- The database is the memory of the universe. Nothing here is ever reset.

CREATE TABLE universe (
  id                INT PRIMARY KEY CHECK (id = 1),      -- there is exactly one universe
  current_tick      BIGINT NOT NULL,
  entropy           DOUBLE PRECISION NOT NULL,
  total_energy      BIGINT NOT NULL,                     -- constant: objects + observers + vacuum
  free_energy       BIGINT NOT NULL,                     -- the vacuum: energy not held by anything
  total_information BIGINT NOT NULL,
  age               BIGINT NOT NULL,
  last_epoch        BIGINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE regions (
  id                 TEXT PRIMARY KEY,                   -- "gx:gy"
  num                SERIAL UNIQUE,
  gx                 INT NOT NULL,
  gy                 INT NOT NULL,
  entropy            DOUBLE PRECISION NOT NULL DEFAULT 10,
  state              TEXT NOT NULL DEFAULT 'calm',       -- calm | unstable
  converged          BOOLEAN NOT NULL DEFAULT false,
  interaction_count  BIGINT NOT NULL DEFAULT 0,
  created_tick       BIGINT NOT NULL,
  created_by_user_id BIGINT
);

CREATE TABLE users (
  id                BIGSERIAL PRIMARY KEY,
  username          TEXT NOT NULL,
  email             TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_tick    BIGINT NOT NULL,
  energy            BIGINT NOT NULL DEFAULT 0,
  energy_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  knowledge         INT NOT NULL DEFAULT 0,
  influence         INT NOT NULL DEFAULT 0,
  current_location  TEXT REFERENCES regions(id),
  life_started_tick BIGINT NOT NULL,
  life_state        TEXT NOT NULL DEFAULT 'alive',       -- alive | echo (a life can end; it is never erased)
  domains           JSONB NOT NULL DEFAULT '{}',         -- knowledge per domain
  stats             JSONB NOT NULL DEFAULT '{}',         -- experience counters
  witnessed         JSONB NOT NULL DEFAULT '{}'          -- outcomes this observer has seen
);
CREATE UNIQUE INDEX users_username_idx ON users (lower(username));
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));

CREATE TABLE user_regions (
  user_id         BIGINT NOT NULL REFERENCES users(id),
  region_id       TEXT NOT NULL REFERENCES regions(id),
  discovered_tick BIGINT NOT NULL,
  PRIMARY KEY (user_id, region_id)
);
CREATE INDEX user_regions_region_idx ON user_regions (region_id);

CREATE TABLE objects (
  id                    BIGSERIAL PRIMARY KEY,
  type                  TEXT NOT NULL,
  name                  TEXT,
  parent_id             BIGINT REFERENCES objects(id),
  energy                BIGINT NOT NULL DEFAULT 0 CHECK (energy >= 0),
  stability             DOUBLE PRECISION NOT NULL DEFAULT 50,
  information           BIGINT NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL DEFAULT 'calm',    -- calm | excited | resonant | dormant | merged
  created_tick          BIGINT NOT NULL,
  last_interaction_tick BIGINT NOT NULL,
  last_sim_tick         BIGINT NOT NULL,                 -- lazy simulation: state is exact as of this tick
  owner_user_id         BIGINT REFERENCES users(id),
  x                     DOUBLE PRECISION NOT NULL,
  y                     DOUBLE PRECISION NOT NULL,
  z                     DOUBLE PRECISION NOT NULL DEFAULT 0,
  region_id             TEXT NOT NULL REFERENCES regions(id),
  props                 JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX objects_parent_idx ON objects (parent_id);
CREATE INDEX objects_last_interaction_idx ON objects (last_interaction_tick);
CREATE INDEX objects_last_sim_idx ON objects (last_sim_tick);
CREATE INDEX objects_region_idx ON objects (region_id);
CREATE INDEX objects_owner_idx ON objects (owner_user_id);
CREATE INDEX objects_type_idx ON objects (type);

CREATE TABLE observations (                              -- how much each observer has learned about each object
  user_id    BIGINT NOT NULL REFERENCES users(id),
  object_id  BIGINT NOT NULL REFERENCES objects(id),
  level      INT NOT NULL DEFAULT 0,
  count      INT NOT NULL DEFAULT 0,
  first_tick BIGINT NOT NULL,
  PRIMARY KEY (user_id, object_id)
);

CREATE TABLE interactions (                              -- immutable: one row per meaningful act
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id),
  object_id        BIGINT REFERENCES objects(id),
  target_object_id BIGINT REFERENCES objects(id),
  region_id        TEXT REFERENCES regions(id),
  interaction_type TEXT NOT NULL,
  energy_before    BIGINT NOT NULL,
  energy_spent     BIGINT NOT NULL,
  state_before     JSONB NOT NULL,
  probability_data JSONB NOT NULL,                       -- context, full distribution, roll
  outcome          TEXT NOT NULL,
  state_after      JSONB NOT NULL,
  transfers        JSONB NOT NULL DEFAULT '[]',          -- every movement of energy
  universe_tick    BIGINT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  seed             TEXT NOT NULL
);
CREATE INDEX interactions_tick_idx ON interactions (universe_tick);
CREATE INDEX interactions_user_idx ON interactions (user_id, universe_tick);
CREATE INDEX interactions_object_idx ON interactions (object_id, universe_tick);
CREATE INDEX interactions_region_idx ON interactions (region_id, universe_tick);

CREATE TABLE events (                                    -- immutable: what the universe remembers
  id                 BIGSERIAL PRIMARY KEY,
  universe_tick      BIGINT NOT NULL,
  event_type         TEXT NOT NULL,
  description        TEXT NOT NULL,
  affected_object_id BIGINT REFERENCES objects(id),
  region_id          TEXT REFERENCES regions(id),
  created_by_user_id BIGINT REFERENCES users(id),
  impact             TEXT NOT NULL DEFAULT 'minor',      -- minor | major | cosmic
  data               JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_tick_idx ON events (universe_tick);
CREATE INDEX events_impact_idx ON events (impact, universe_tick);
CREATE INDEX events_object_idx ON events (affected_object_id);

CREATE TABLE discoveries (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  discovery_type  TEXT NOT NULL,                         -- law | first
  key             TEXT NOT NULL,
  object_id       BIGINT REFERENCES objects(id),
  description     TEXT NOT NULL,
  discovered_tick BIGINT NOT NULL,
  UNIQUE (user_id, key)
);
CREATE INDEX discoveries_user_idx ON discoveries (user_id);

CREATE TABLE relationships (
  id                BIGSERIAL PRIMARY KEY,
  object_a          BIGINT NOT NULL REFERENCES objects(id),
  object_b          BIGINT NOT NULL REFERENCES objects(id),
  relationship_type TEXT NOT NULL DEFAULT 'bond',
  strength          INT NOT NULL DEFAULT 1,
  created_tick      BIGINT NOT NULL,
  ended_tick        BIGINT                               -- bonds end; they are not deleted
);
CREATE INDEX relationships_a_idx ON relationships (object_a);
CREATE INDEX relationships_b_idx ON relationships (object_b);

CREATE TABLE notes (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  object_id     BIGINT NOT NULL REFERENCES objects(id),
  body          TEXT NOT NULL,
  universe_tick BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notes_object_idx ON notes (object_id);

-- History cannot be erased.
CREATE FUNCTION forbid_rewrite() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'history is immutable: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER interactions_immutable BEFORE UPDATE OR DELETE ON interactions FOR EACH ROW EXECUTE FUNCTION forbid_rewrite();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION forbid_rewrite();
