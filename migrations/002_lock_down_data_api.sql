-- Hosted Postgres services such as Supabase expose every table in the public schema
-- through an auto-generated web API. Row level security with no policies closes that
-- door: only the game server (which connects as the table owner) can read or write.
-- On plain PostgreSQL this changes nothing for the server.
ALTER TABLE universe          ENABLE ROW LEVEL SECURITY;
ALTER TABLE regions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_regions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE objects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE discoveries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationships     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
