# LaTeX compile Lambda: the Node handler plus Tectonic with a pre-warmed package
# cache, so cold starts don't download LaTeX packages. Built by `sam build`.

# --- build the handler -----------------------------------------------------
FROM public.ecr.aws/lambda/nodejs:22 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx esbuild src/functions/latex.ts --bundle --platform=node --target=node22 \
      --minify --sourcemap --outfile=dist/latex.js

# --- runtime ----------------------------------------------------------------
FROM public.ecr.aws/lambda/nodejs:22
ARG TECTONIC_VERSION=0.17.0

RUN dnf install -y tar gzip fontconfig && dnf clean all \
 && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin \
 && tectonic --version

# Compile the starter template once so its packages are in the image. At
# runtime the cache is copied to writable /tmp (see src/lib/latex.ts).
COPY latex/starter-resume.tex /tmp/warm/main.tex
RUN cd /tmp/warm \
 && TECTONIC_CACHE_DIR=/opt/tectonic-cache tectonic --chatter minimal main.tex \
 && rm -rf /tmp/warm

COPY --from=build /build/dist/latex.js /build/dist/latex.js.map ${LAMBDA_TASK_ROOT}/
ENV NODE_OPTIONS=--enable-source-maps
CMD ["latex.handler"]
