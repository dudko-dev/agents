// The names a session gives its parts: the session's own id, its children's (a static subagent
// call, a pipeline call, a pipeline's node visit), their event streams and the routes that serve
// them. Pure functions of the ids, no imports: the workflows name children with them, the gateway
// RECOMPUTES them (an answer to a child's item goes only to the child the session named), and a
// platform stores rows and events under them - their format never changes (sessions live for
// days; ids and stream keys are persisted).

// A workflow id per session: the prefix keeps them apart from anything else in the namespace.
export const workflowIdOf = (sessionId: string): string => `session-${sessionId}`

// The child that runs one static subagent call (one item of a parked turn). Its id is a function
// of the session, the parent run and the item (the core's item id is stable across attempts): a
// replayed or retried start names the same child, never a second one.
export const subagentWorkflowIdOf = (sessionId: string, runId: string, itemId: string): string =>
  `subagent-${sessionId}-${runId}-${itemId}`

// The child's own stream: its run and its events are keyed by this in place of a session id, so
// they never mix with the parent turn's order.
export const subagentStreamOf = (sessionId: string, itemId: string): string =>
  `${sessionId}/${itemId}`

// The child that runs one pipeline call (one item of a parked turn), named like a subagent's child:
// from the session, the parent run and the item. The pipeline's graph engine is its scheduler, and
// every node visit is a child of its own.
export const pipelineWorkflowIdOf = (sessionId: string, runId: string, itemId: string): string =>
  `pipeline-${sessionId}-${runId}-${itemId}`

// The pipeline's own stream (the engine's pipeline.* events): keyed like a subagent child's.
export const pipelineStreamOf = (sessionId: string, itemId: string): string =>
  `${sessionId}/${itemId}`

// A node visit's child: the pipeline's id, the node and the visit. A node id has no '.' (the swarm
// refuses one), so the parts never run into each other.
export const pipelineNodeWorkflowIdOf = (
  pipelineWorkflowId: string,
  nodeId: string,
  visit: number,
): string => `${pipelineWorkflowId}.${nodeId}.${visit}`

// A node visit's own stream: its run and its events.
export const pipelineNodeStreamOf = (
  sessionId: string,
  itemId: string,
  nodeId: string,
  visit: number,
): string => `${sessionId}/${itemId}/${nodeId}/${visit}`

// Where the gateway serves those streams.
export const pipelineEventsPath = (sessionId: string, itemId: string): string =>
  `/sessions/${sessionId}/pipelines/${itemId}/events`
export const pipelineNodeEventsPath = (
  sessionId: string,
  itemId: string,
  nodeId: string,
  visit: number,
): string => `/sessions/${sessionId}/pipelines/${itemId}/nodes/${nodeId}/${visit}/events`

// The child that waits for an item of the session: a subagent child, or a pipeline's node visit
// (named from the pipeline's id, the node and the visit). A pure function of the session, the
// parked turn's run and its item - what the gateway recomputes to check that the child an item
// names is one of THIS session's before it signals it.
export const childWorkflowIdOf = (
  sessionId: string,
  runId: string,
  itemId: string,
  node?: { nodeId: string; visit: number },
): string =>
  node
    ? pipelineNodeWorkflowIdOf(
        pipelineWorkflowIdOf(sessionId, runId, itemId),
        node.nodeId,
        node.visit,
      )
    : subagentWorkflowIdOf(sessionId, runId, itemId)
