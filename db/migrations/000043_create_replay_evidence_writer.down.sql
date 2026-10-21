BEGIN;
REVOKE USAGE ON SCHEMA public FROM battle_bus_replay_writer;
DROP ROLE battle_bus_replay_writer;
COMMIT;
