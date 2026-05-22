# Caddy with the Cloudflare DNS-01 plugin baked in.
# Needed for wildcard certs on *.lab.environments.learnlytica.com.
# Pinned to 2.10 because caddy-dns/cloudflare >= v0.2.x requires certmagic
# from Caddy 2.9+ (zapslog.HandlerOptions API).
FROM caddy:2.10-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2.10
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
