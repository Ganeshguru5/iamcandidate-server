# LaTeX compile Lambda: the Node handler plus Tectonic with a pre-warmed package
# cache, so cold starts don't download LaTeX packages. Built by `sam build`.

# --- build the handler -----------------------------------------------------
FROM public.ecr.aws/lambda/nodejs:22 AS build
# Only what bundling needs: esbuild on its own (cached until its version
# changes), then the runtime dependencies (cached until package-lock.json
# changes). The dev tools (eslint, vitest, TypeScript…) aren't needed here and
# made this step download hundreds of packages.
# Prefer IPv4: where Docker has no IPv6 route (Docker Desktop on Windows),
# npm otherwise waits minutes on each IPv6 connection before falling back.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
WORKDIR /tools
RUN npm install --no-audit --no-fund esbuild@0.28.2
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN /tools/node_modules/.bin/esbuild src/functions/latex.ts --bundle --platform=node --target=node22 \
      --minify --sourcemap --outfile=dist/latex.js

# --- runtime ----------------------------------------------------------------
FROM public.ecr.aws/lambda/nodejs:22
ARG TECTONIC_VERSION=0.17.0

RUN dnf install -y tar gzip fontconfig && dnf clean all \
 && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin \
 && tectonic --version

# Compile the starter template once so its packages are in the image. At
# runtime the cache is copied to writable /tmp (see src/lib/latex.ts). Lambda
# runs as a non-root user and Tectonic writes some files owner-only, so open up
# read access or the copy fails with EACCES. font-warmup.tex adds the OpenType
# fonts swapped in for pdfLaTeX font packages (src/lib/latex-fonts.ts).
COPY latex/starter-resume.tex /tmp/warm/main.tex
COPY latex/font-warmup.tex /tmp/warm/fonts.tex
RUN cd /tmp/warm \
 && TECTONIC_CACHE_DIR=/opt/tectonic-cache tectonic --chatter minimal main.tex \
 && TECTONIC_CACHE_DIR=/opt/tectonic-cache tectonic --chatter minimal fonts.tex \
 && rm -rf /tmp/warm \
 && chmod -R a+rX /opt/tectonic-cache

COPY --from=build /build/dist/latex.js /build/dist/latex.js.map ${LAMBDA_TASK_ROOT}/
ENV NODE_OPTIONS=--enable-source-maps
CMD ["latex.handler"]
