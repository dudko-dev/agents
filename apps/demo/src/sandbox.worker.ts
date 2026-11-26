// The sandbox's Web Worker (`config.sandbox.worker`): the core's entry serves by itself when it
// is loaded inside a worker. One worker per `run_js` call; the agent terminates it.
import '@dudko.dev/agent-web/sandbox-worker'
