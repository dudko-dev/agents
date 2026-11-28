# agent-swarm Helm chart

The [swarm example](../../../README.md) of `@dudko.dev/agent` on Kubernetes: the stateless
**gateway** (Deployment + Service, optional Ingress), the **workers** (Deployment) that run the
sessions' workflows and turns, and the **migrate** Job, run as a pre-install / pre-upgrade hook.
The image is `ghcr.io/dudko-dev/agent-swarm` (`docker.io/sergdudko/agent-swarm`), published by
`.github/workflows/swarm-image.yml`; its tag defaults to the chart's `appVersion`, the agent
version.

A private example, like the swarm: not published to a chart repository. Install it from the
repository.

## What you bring

- **Postgres** - external only. The chart runs no database: point `DATABASE_URL` (in a Secret) at
  a managed one or an operator's cluster. The gateway and the workers need `SELECT` / `INSERT` /
  `UPDATE` on the swarm's tables; give the migrate Job a role that may change the schema through
  `secrets.migrateDatabaseUrl`.
- **Temporal** - external by default (`temporal.address`, default
  `temporal-frontend.temporal.svc.cluster.local:7233`: the service the official chart makes for a
  release `temporal` in the namespace `temporal`). TLS, mTLS and API keys:
  `temporal.tls` and `secrets.temporalTls` / `secrets.temporalApiKey`.
- **The Secrets** under `secrets` - the chart reads them and never creates one. Each value is
  mounted as a file under `/run/secrets/agent-swarm` and handed to the app as `<NAME>_FILE`, so it
  never shows in a process listing or in `kubectl describe`.

```bash
kubectl create namespace swarm
kubectl -n swarm create secret generic agent-swarm \
  --from-literal=database-url='postgres://swarm:...@postgres.db:5432/swarm?sslmode=require' \
  --from-literal=gateway-tokens="$(openssl rand -base64 32)" \
  --from-literal=agent-api-key='sk-...'

helm repo add temporal https://go.temporal.io/helm-charts   # the optional dependency (below)
helm dependency build examples/swarm/deploy/helm/agent-swarm
helm install swarm examples/swarm/deploy/helm/agent-swarm -n swarm \
  --set temporal.address=temporal-frontend.temporal:7233 \
  --set agent.model=gpt-4.1-mini
```

`helm dependency build` fetches the pinned Temporal chart (`Chart.lock`) even when it is off:
Helm wants every listed dependency present.

## Values

Every key is in [`values.yaml`](values.yaml), with a comment, and checked by
[`values.schema.json`](values.schema.json) (a value the app would refuse at start - an unknown
approval mode, a Temporal address without a port, a root or writable container - is refused by
`helm install` instead). The groups:

| Key | What |
| --- | --- |
| `image.*` | repository, tag (default: `appVersion`) or `digest`, pull policy |
| `secrets.*` | the Secret and key of each secret: `databaseUrl`, `migrateDatabaseUrl`, `gatewayTokens`, `agentApiKey`, `temporalApiKey`, `temporalTls` (`ca.crt`, and `tls.crt` + `tls.key` with `clientCertificate`) |
| `temporal.*` | `address`, `namespace`, `taskQueue`, `tls`; `enabled` runs the bundled Temporal chart (below) |
| `session.*` | the session options: read by the gateway, fixed when a session starts (`SESSION_*`, `TURN_*`, `SUBAGENT_MAX_PER_*`, `PIPELINE_MAX_PER_*`) |
| `gateway.*` | replicas, auth, CORS, body and stream bounds, the Service, `preStopSleepSeconds`, `terminationGracePeriodSeconds`, the HPA (`autoscaling`), resources, scheduling, `extraEnv` / `extraEnvFrom` |
| `worker.*` | concurrency, `shutdownGraceSeconds` (+ `terminationExtraSeconds` = the pod's grace period), lease, the shared limiter, autoscaling (HPA on CPU, or KEDA), resources, scheduling, extra env |
| `agent.*` | the agent's non-secret settings: provider, model(s), base URL, system prompt, `toolApproval` and `toolRules`, `mcpServers`, `subagents` (SUBAGENTS), `pipelines` (PIPELINES), caps, any other `AGENT_*` under `extra` |
| `migrate.*` | the hook Job: on/off, retries, deadline, resources |
| `serviceAccount.*`, `podDisruptionBudget.*`, `ingress.*`, `networkPolicy.*` | as below |
| `podSecurityContext`, `securityContext`, `tmp.sizeLimit` | the pods' security (below) |

## Scaling and disruption

- **Gateway**: an HPA on CPU (`gateway.autoscaling`, on by default, 2-10). Streams need no
  affinity: a client that loses its replica reconnects to another with `Last-Event-ID`.
- **Workers**: an HPA on CPU (`worker.autoscaling`) is the fallback - a worker mostly waits on the
  model, so CPU says little about its load. Where [KEDA](https://keda.sh) runs, set
  `worker.autoscaling.keda.enabled`: a `ScaledObject` with KEDA's **`temporal` scaler**, which
  scales on the task queue's backlog (`queueTypes: workflow,activity`, `targetQueueSize`). It needs
  **KEDA v2.17.0 or later** - the scaler was introduced in v2.17.0 (KEDA's CHANGELOG, "Introduce
  new Temporal scaler", kedacore/keda#4724; `pkg/scalers/temporal.go`). With an API key or a client
  certificate the chart adds a `TriggerAuthentication` from the same Secrets.
  `minReplicaCount: 0` scales the workers to zero: messages and answers still land (Temporal takes
  signals without a worker) and the backlog brings a worker up, at the price of a cold first turn.
- **PodDisruptionBudgets** (`maxUnavailable: 1` each): a drain takes one gateway and one worker at
  a time. A worker drains on SIGTERM - its turns get `shutdownGraceSeconds`, then move to another
  worker - and its pod's `terminationGracePeriodSeconds` is that plus `terminationExtraSeconds`.
  The gateway gets `preStopSleepSeconds` (a kubelet `sleep` action: the image has no shell) to
  leave the endpoints before it stops.

## Probes

| Role | Readiness | Liveness |
| --- | --- | --- |
| gateway | `GET /readyz` on 8080: Postgres, Temporal and the LISTEN connection answer | `GET /healthz` on 8080 |
| worker | `GET /readyz` on 8081: the worker polls Temporal | `GET /healthz` on 8081: it has not failed |

## Security

- **Pods**: non-root (uid / gid 1000), `readOnlyRootFilesystem`, all capabilities dropped, no
  privilege escalation, `seccompProfile: RuntimeDefault`; `/tmp` is an `emptyDir`
  (`tmp.sizeLimit`) for the agent's per-run sandbox. The schema refuses a values file that
  weakens any of these.
- **ServiceAccount**: its own, with no token mounted - the app never talks to the Kubernetes API.
  The migrate Job runs before the release's objects exist, so it uses the namespace's default
  ServiceAccount (no token either), unless `serviceAccount.create` is off and `name` is given.
- **Secrets**: by reference only, mounted as files (`defaultMode: 0440`, group 1000). The gateway
  never gets the provider key, the migrate Job neither.
- **NetworkPolicy** (`networkPolicy.enabled`): the gateway takes its port from `gatewayFrom`
  (anyone when empty - narrow it to your ingress controller); the workers take nothing (the
  kubelet's probes are not pod traffic); egress is DNS, Postgres (`postgres.to`, port), Temporal
  (`temporal.to`, or the bundled chart's frontend pods), and for the workers only the provider and
  MCP servers (`provider.ports` / `to`, default any address on 443, plus `extraWorkerEgress`).
  The migrate Job's policy applies from the first upgrade on: at the first install the hook runs
  before it exists.
- **Ingress**: TLS terminates there (`ingress.tls`); the gateway speaks plain HTTP. SSE needs an
  unbuffered proxy with a long read timeout (the annotations in `values.yaml`).

## The bundled Temporal chart

`temporal.enabled: true` installs the official chart (`temporal` 1.8.0 from
<https://go.temporal.io/helm-charts>, source <https://github.com/temporalio/helm-charts>, pinned
in `Chart.yaml` / `Chart.lock`) in the same release, and the swarm talks to its frontend
(`<release>-temporal-frontend:7233`). Every key under `temporal:` but the swarm's own (`address`,
`namespace`, `taskQueue`, `tls`, `enabled`) goes to that chart as is: it needs its persistence -
two databases, `temporal` and `temporal_visibility` - under
`temporal.server.config.persistence.datastores`, and `temporal.server.config.namespaces` to create
the swarm's namespace ([`ci/all-on-values.yaml`](ci/all-on-values.yaml) has an example). Off by
default: a production Temporal is run on its own, with its own upgrades and backups.

## Checks

`.github/workflows/swarm.yml` (job `chart`), with pinned `helm` and `kubeconform` (checksums):

- `helm lint --strict` with the default values and with [`ci/all-on-values.yaml`](ci/all-on-values.yaml)
  (every flag on: KEDA with TLS and an API key, NetworkPolicy, Ingress, the bundled Temporal, the
  limiter, subagents, a pipeline, extra env, a digest);
- `helm template` of both, validated by `kubeconform -strict` against the Kubernetes schemas
  (pinned commit of yannh/kubernetes-json-schema) and the CRD schemas KEDA's objects need (pinned
  commit of datreeio/CRDs-catalog) - nothing is skipped: a kind without a schema fails;
- values the schema must refuse.

`tests/chart.test.ts` (the swarm's unit tests) checks the schema against the same values and that
every variable the ConfigMaps set is one the app reads.
