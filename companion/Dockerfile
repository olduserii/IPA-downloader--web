# Multi-stage Docker build for IPA Vault FairPlay SAP Bridge
# Deploy to Render / Railway / Fly.io / VPS and connect to Vercel via SAP_BRIDGE_URL

FROM golang:1.26-bookworm AS builder

WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

# Clone latest majd/ipatool (includes Unicorn ARM64 + CoreFP FairPlay SAP signer)
RUN git clone --depth 1 https://github.com/majd/ipatool.git /src/ipatool

# Inject bridge export + HTTP server into the module
COPY bridge_export.go /src/ipatool/pkg/appstore/bridge_export.go
RUN mkdir -p /src/ipatool/cmd/bridge
COPY main.go /src/ipatool/cmd/bridge/main.go

WORKDIR /src/ipatool
RUN CGO_ENABLED=1 go build -o /out/sap-bridge ./cmd/bridge

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out/sap-bridge /usr/local/bin/sap-bridge

ENV PORT=8080
EXPOSE 8080

CMD ["/usr/local/bin/sap-bridge"]
