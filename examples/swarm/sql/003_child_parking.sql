-- Children that wait for a person: a static subagent's run, or a pipeline node visit's, parks on
-- an "ask" like a session turn does. Its items are recorded under the SESSION (session_id: what
-- the gateway looks an answer up by - an item of another session is not found) in the parent's
-- turn (turn: a stop of that turn closes them with the turn's own), answered by a client, and
-- OWNED by the child workflow that waits for them - the one the gateway signals the answer to.
-- Never edit this file once applied: add the next one (004_...).

-- The child workflow that waits for the item (NULL: the session's own turn waits for it).
ALTER TABLE swarm_parked ADD COLUMN owner_id text;
-- The parked turn's item that child answers (a subagent call, or a pipeline call): the gateway
-- checks the owner against it - the owner's workflow id is recomputed from the session, that
-- item's run and id (and the node and visit), never taken from this row alone.
ALTER TABLE swarm_parked ADD COLUMN owner_item text;
-- A pipeline node visit's node and visit (NULL for a subagent child).
ALTER TABLE swarm_parked ADD COLUMN owner_node text;
ALTER TABLE swarm_parked ADD COLUMN owner_visit integer;

-- A child's end closes what it still waits for (UPDATE ... WHERE session_id AND owner_id).
CREATE INDEX swarm_parked_owner ON swarm_parked (session_id, owner_id) WHERE owner_id IS NOT NULL;
