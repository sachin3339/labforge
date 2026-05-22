# Gateway

In production this directory will contain Traefik / Envoy configuration for
TLS termination, wildcard routing, and WebRTC TURN. For the v0 MVP the
control plane itself proxies wildcard `*.lab.localhost` requests to the
correct lab container over the internal docker network — see
`packages/control-plane/src/wildcardProxy.ts`.

When we split this out, the gateway will:

1. Terminate TLS for `*.lab.example.com` via cert-manager / Let's Encrypt.
2. Call `GET /internal/forward-auth` on the control plane for every request,
   passing the original `Host` and `Cookie` headers.
3. On a `200` response, proxy upstream to the host returned in
   `X-LF-Upstream`. On `401/403/404`, return the auth error to the browser.
4. Handle HTTP/1.1 + WebSocket + HTTP/2 + (eventually) WebRTC SFU.
5. Be deployed one-per-node as a DaemonSet, behind anycast LB.
