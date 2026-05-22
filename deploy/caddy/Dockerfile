# Caddy with the Cloudflare DNS-01 plugin baked in.
# Needed for wildcard certs on *.lab.environments.learnlytica.com.
FROM caddy:2.8-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2.8
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
