# Pin the runtime to an official Node build.
#
# Why this file exists instead of relying on `.nvmrc`:
# Railway builds this service with Nixpacks, and Nixpacks resolves the Node
# version by MAJOR version only — it installs the nixpkgs `nodejs_24`
# derivation. The `.nvmrc` pin of 24.15.0 therefore never reached production:
# the container was running the nixpkgs build of Node 24.10.0
# (/nix/store/...-nodejs-24.10.0), which leaks ~670 KB of native memory per
# worker-thread spawn. The same churn is flat on the official 24.10.0 and
# 24.15.0 builds. See docs/operations.md for the measurements.
FROM node:24.15.0-bookworm-slim

WORKDIR /app

# devDependencies are required at build time — `npm run build` runs `tsc`.
# Scripts are left enabled to match the previous Nixpacks build exactly;
# husky's `prepare` step degrades gracefully without a .git directory.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

CMD ["npm", "run", "start"]
