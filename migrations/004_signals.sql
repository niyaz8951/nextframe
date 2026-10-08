-- Signals: wordless marks left on objects. Some are left by observers, some by the
-- universe itself, and nothing on a signal says which. Two observers make contact
-- when one answers the other's echo. Only then can they see each other's names and speak.
CREATE TABLE signals (
  id            BIGSERIAL PRIMARY KEY,
  object_id     BIGINT NOT NULL REFERENCES objects(id),
  user_id       BIGINT REFERENCES users(id),             -- NULL: the universe left this one
  pattern       TEXT NOT NULL CHECK (pattern ~ '^[0-5]{3}$'),
  reply_to      BIGINT REFERENCES signals(id),           -- set when this signal is an echo of another
  universe_tick BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX signals_object_idx ON signals (object_id, id);
CREATE INDEX signals_user_idx ON signals (user_id, id);
CREATE INDEX signals_reply_idx ON signals (reply_to);
CREATE INDEX signals_tick_idx ON signals (universe_tick);

CREATE TABLE contacts (
  id           BIGSERIAL PRIMARY KEY,
  user_a       BIGINT NOT NULL REFERENCES users(id),     -- always the lower id
  user_b       BIGINT NOT NULL REFERENCES users(id),
  signal_id    BIGINT REFERENCES signals(id),            -- the answer that completed the handshake
  created_tick BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_a, user_b), CHECK (user_a < user_b)
);
CREATE INDEX contacts_b_idx ON contacts (user_b);

CREATE TABLE messages (
  id            BIGSERIAL PRIMARY KEY,
  contact_id    BIGINT NOT NULL REFERENCES contacts(id),
  user_id       BIGINT NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,
  universe_tick BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_contact_idx ON messages (contact_id, id);

ALTER TABLE signals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
