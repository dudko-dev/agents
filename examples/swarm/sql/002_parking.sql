-- Parking and static subagents: the agent's call journal, the items a parked turn waits for, and
-- the fence a resume raises over the attempt it replaces. Never edit this file once applied: add
-- the next one (003_...).

-- The attempt a resume of the run claimed when it took the run (its lease's acquire), before it
-- read anything: from then on, writes of any older attempt are refused - its journal appends and
-- its snapshots (see src/db/runs.ts, src/db/journal.ts).
ALTER TABLE swarm_runs ADD COLUMN fence integer NOT NULL DEFAULT 0;

-- persistence.journal: every language-model response and tool result of a run, in the order they
-- were appended (n). An entry is the core's JSON, kept as text so it reads back byte for byte.
-- entry_id (`a<attempt>:<kind>:<position>`) is unique in a run.
CREATE TABLE swarm_journal (
  run_id     text NOT NULL,
  n          bigint GENERATED ALWAYS AS IDENTITY,
  entry_id   text NOT NULL,
  attempt    integer NOT NULL,
  entry      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, n),
  UNIQUE (run_id, entry_id)
);

-- For pruning old journals (DELETE ... WHERE created_at < ...), with the runs they belong to.
CREATE INDEX swarm_journal_created_at ON swarm_journal (created_at);

-- The items a parked turn waits for, as the turn activity found them (the gateway checks an
-- answer against them without asking a worker). answered_by: 'client' (a person's decision, a
-- result from an outside system) or 'subagent' (a child workflow answers it). state: pending ->
-- answered (the turn went on with it) | cancelled (the turn was stopped).
CREATE TABLE swarm_parked (
  session_id  text NOT NULL,
  item_id     text NOT NULL,
  turn        integer NOT NULL,
  run_id      text NOT NULL,
  kind        text NOT NULL,
  answered_by text NOT NULL,
  child_id    text,
  item        jsonb NOT NULL,
  state       text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, item_id)
);

CREATE INDEX swarm_parked_turn ON swarm_parked (session_id, turn);
