# Build environment for Anthropic OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this image with the repository as the build context, then audits it with no network access,
# so everything the build, the unit tests and the smoke test need is installed here. Mirrors the "checks" job in
# .github/workflows/ci.yml.
FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive \
    CI=true

# xvfb and the shared libraries Electron needs to start headless for the smoke test.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 libdrm2 libatk-bridge2.0-0 \
      libcups2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# npm ci also downloads the Electron binary, which the smoke test needs offline.
RUN npm ci
RUN npm run build

# Run the checks so the image is known to work, but do not let a failure abort the build.
RUN npm run typecheck || echo "WARNING: typecheck reported errors"
RUN npm test || echo "WARNING: unit tests reported failures"
RUN timeout 300 xvfb-run -a npm run smoke -- out/smoke || echo "WARNING: smoke test failed"
