# Deploy with Helm

The chart is an OCI artifact beside the image. It renders a Deployment, a Service
and one route — no ServiceAccount, no HPA, no PodDisruptionBudget.

Optionally it also renders a cache sidecar: `cache.enabled=true` puts Vinyl Cache
in the pod and points the Service at it. See
[put a CDN in front](put-a-cdn-in-front.md#the-cache-sidecar).

## Make the Secret first

The chart deliberately creates none: a token belongs to whatever manages your
secrets, not to a chart release. Every key in the Secret arrives as an
environment variable.

```bash
kubectl create secret generic pr-lens-git \
  --from-literal=GIT_TOKEN=glpat-…
```

An ssh remote needs no Secret at all — leave `secretName` empty and mount a key
instead, as [connect a remote](connect-a-remote.md#over-ssh-with-a-key) shows.

## Install

<!-- x-release-please-start-version -->
```bash
helm install lens oci://ghcr.io/thejoeejoee/charts/pr-lens-git-backend \
  --version 0.8.0 \
  --set secretName=pr-lens-git \
  --set config.git.remote=https://gitlab.example.com/platform/pr-lens-canvases.git \
  --set config.publicUrl=https://lens.example.com \
  --set ingress.enabled=true \
  --set ingress.host=lens.example.com
```
<!-- x-release-please-end -->

## More than one host

A release often answers on two names — the canonical one and an internal or
staging one pointing at the same backend. `ingress.hosts` takes the list, and
every host gets the same rule, because they are the same server:

```yaml
ingress:
  enabled: true
  hosts:
    - pr-lens.cdn.example.com
    - pr-lens.test.cdn.example.com
  tls:
    - secretName: lens-tls
      hosts: [pr-lens.cdn.example.com, pr-lens.test.cdn.example.com]

config:
  publicUrl: https://pr-lens.cdn.example.com
```

`ingress.host` still works and is the single-host spelling of the same thing;
setting the list ignores it.

Set `config.publicUrl` when you do this. Without it every answer names whichever
host the request arrived on, so the same canvas pushed through the internal name
comes back as an internal link — a link somebody then pastes into a README that
readers outside the cluster cannot open. With it, every answer names the
canonical host no matter which one the push arrived on.

For Gateway API instead of an Ingress:

```bash
  --set httpRoute.enabled=true \
  --set httpRoute.hostnames[0]=lens.example.com \
  --set httpRoute.parentRefs[0].name=my-gateway
```

Leave both off and nothing is exposed; `kubectl port-forward` still works.

## Set publicUrl

Without it, every answer names whichever host the request arrived on. Behind an
ingress that is usually right, but anything that rewrites `Host` will send the
CLI's edit links to the wrong place. Set it once and stop thinking about it.

## Two replicas is the default

The server holds nothing that cannot be rebuilt, so a second replica costs a
little memory and buys a rolling restart with no downtime. The two things that
are per-pod rather than shared:

- the rate limiters, so the effective limit is `replicas × the number you set`
- the read cache, so one pod can be up to `READ_CACHE_TTL_MS` behind another

Neither can corrupt anything — see
[Why git works](../explanation/why-git.md) for why a stale read is safe.

Each pod keeps its own mirror of the repository, in the `emptyDir` at `/tmp`.
They never have to agree: a push is a fast-forward or it is refused, so a pod
whose mirror is behind finds that out from the remote and fetches. A pod that
moves loses its mirror and clones again, which costs a moment and no canvases.

What replicas do share is the branch tip, and that is the one thing worth sizing
for. Writes land one at a time across the whole deployment — not per pod — so a
pod queues its own writes rather than racing them, and what is left contending is
one push per pod. Two pods cost nothing for that; each extra pod is another
contender for the same tip, and a burst of writes drains at roughly one push per
round trip whatever the replica count is.

Reads do not share anything and scale with replicas as you would expect, which is
the direction that actually needs the pods.

## Say what this host is, in your own words

The page at `/` explains PR Lens to a stranger. For a host your own team uses,
what belongs there is usually which project is behind it and who to ask. One
value replaces the whole page:

````yaml
config:
  indexMarkdown: |
    # Platform canvases

    Diagrams for the payments group. Ask in #platform-eng.

    ```sh
    export PR_LENS_API_URL={{origin}}
    ```
````

It becomes a ConfigMap mounted at `/etc/pr-lens/index.md`, and the server re-reads
it when it changes — so `kubectl edit configmap <release>-index` is the whole
deployment, with no rollout. `{{origin}}` and four other placeholders are filled
in; [Configuration](../reference/configuration.md#your-own-page-at-) lists them,
and says which HTML that page may hold: everything except what executes.

## Probes

`/healthz` is liveness and asks only whether the process is up. `/readyz` is
readiness and reaches the remote, so an unreachable remote takes pods out of the
Service without restarting them in a loop.

`charts/pr-lens-git-backend/values.yaml` documents every setting.
