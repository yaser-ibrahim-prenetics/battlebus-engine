BEGIN;
CREATE ROLE battle_bus_replay_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO battle_bus_replay_writer;
COMMENT ON ROLE battle_bus_replay_writer IS
  'Grant only to the approved isolated replay worker identity, never to application runtime roles.';
COMMIT;
