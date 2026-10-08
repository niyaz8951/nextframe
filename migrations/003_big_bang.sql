-- THE BIG BANG. A one-time restart, made before the universe was opened to other
-- observers: the first universe began with a star and a planet already in place;
-- this one begins with dust. Migrations run exactly once, so this can never repeat.
-- (TRUNCATE is used because history rows cannot be deleted one by one.)
TRUNCATE universe, regions, users, user_regions, objects, observations, interactions, events, discoveries, relationships, notes RESTART IDENTITY CASCADE;

ALTER TABLE universe ADD COLUMN big_bang_at   TIMESTAMPTZ NOT NULL DEFAULT now();  -- real time of the first frame
ALTER TABLE universe ADD COLUMN clock_at      TIMESTAMPTZ NOT NULL DEFAULT now();  -- real time up to which background ticks are counted
ALTER TABLE universe ADD COLUMN natural_stars INT NOT NULL DEFAULT 0;              -- stars that formed with no observer feeding them
ALTER TABLE universe ADD COLUMN era           INT NOT NULL DEFAULT 0;
