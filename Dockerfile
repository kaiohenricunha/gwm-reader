# gwm-reader image. Multi-stage: npm ci in the Node builder, then only the
# production files on distroless (no shell, no package manager), non-root.
# Base images are pinned by digest; update them with a reviewed PR.

FROM node:24.22.0-alpine3.23@sha256:e44c87c7dd212720eb00469aeac89504ca2be77b8f0d6dbffb30665d5fcc59e1 AS build
WORKDIR /app
COPY haval-h6-mqtt/package.json haval-h6-mqtt/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY haval-h6-mqtt/*.js ./
RUN rm -f eslint.config.js \
 && mkdir -p /out/data \
 && chown 65532:65532 /out/data \
 && chmod 0700 /out/data

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:78f07ef1b5ea71ad7c055df15d0dd8997f2d288f9158623c4d4ae3d765b7d50d
WORKDIR /app
COPY --from=build /app /app
# Copy the directory entry itself (from its parent) so 0700 is kept.
COPY --from=build /out/ /
ENV NODE_ENV=production \
    DATA_DIR=/data
USER 65532:65532
VOLUME ["/data"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["/app/index.js"]
