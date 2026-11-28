-- The swarm's state: sessions, run snapshots, the event log and the rate limiter.
-- Applied once, in file-name order, by `main.ts migrate` (src/db/migrate.ts). Never edit an
-- applied file: add the next one (002_...). The runner refuses a file whose checksum changed.

-- One row per session the gateway started (the workflow is `session-<session_id>`).
CREATE TABLE swarm_sessions (
  session_id  text PRIMARY KEY,
  workflow_id text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per agent run: bound to (session, turn) when its lease is taken, then its snapshot.
-- run_no counts the runs of a turn (a second one only when the first died before its plan).
-- attempt is the attempt of the last snapshot written: writes are fenced by it.
CREATE TABLE swarm_runs (
  run_id       text PRIMARY KEY,
  session_id   text NOT NULL,
  turn         integer NOT NULL,
  run_no       integer NOT NULL,
  attempt_base integer NOT NULL DEFAULT 0,
  attempt      integer NOT NULL DEFAULT 1,
  status       text,
  lease_owner  text,
  snapshot     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, turn, run_no)
);

-- Every event of every run, keyed by the core's own numbers. The stream reads a session in
-- (turn, turn_attempt, seq) order: turn_attempt = attempt_base + attempt (the turn markers use
-- 0 and 2147483647).
CREATE TABLE swarm_events (
  session_id   text NOT NULL,
  turn         integer NOT NULL,
  run_id       text NOT NULL,
  attempt      integer NOT NULL,
  seq          integer NOT NULL,
  turn_attempt integer NOT NULL,
  type         text NOT NULL,
  event        jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, run_id, attempt, seq)
);

CREATE UNIQUE INDEX swarm_events_stream ON swarm_events (session_id, turn, turn_attempt, seq);
-- For pruning old events (DELETE ... WHERE created_at < ...).
CREATE INDEX swarm_events_created_at ON swarm_events (created_at);

-- One NOTIFY per session per statement, in the inserting transaction: delivered at commit, so a
-- listener never reads before the rows are visible.
CREATE FUNCTION swarm_events_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('swarm_events', s.session_id) FROM (SELECT DISTINCT session_id FROM inserted) s;
  RETURN NULL;
END
$$;

CREATE TRIGGER swarm_events_notify AFTER INSERT ON swarm_events
  REFERENCING NEW TABLE AS inserted
  FOR EACH STATEMENT EXECUTE FUNCTION swarm_events_notify();

-- The shared token bucket(s) of sharedLimits.
CREATE TABLE swarm_limiter (
  bucket     text PRIMARY KEY,
  tokens     double precision NOT NULL,
  updated_at timestamptz NOT NULL
);
