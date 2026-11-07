# Builder sandbox (untrusted agent). Context: .local/context/builder, assembled and scanned by
# `npm run package`: packaged game, public toolchain and public helpers only.
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS toolchain
COPY toolchain/package.json toolchain/package-lock.json /opt/toolchain/
RUN cd /opt/toolchain && npm ci --omit=dev --no-audit --no-fund --ignore-scripts
FROM ${NODE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-noto-cjk fonts-dejavu-core tini \
  && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
COPY --from=toolchain /opt/toolchain /opt/toolchain
COPY fn /opt/toolchain/fn
COPY target /opt/target
RUN ln -s /opt/toolchain/node_modules /node_modules \
  && useradd -u 10001 -M -d /work -s /usr/sbin/nologin builder \
  && chmod -R a+rX,go-w /opt/toolchain /opt/target
ENV NODE_PATH=/opt/toolchain/node_modules FN_TARGET=/opt/target FRUIT_NINJA_CHROMIUM=/usr/bin/chromium HOME=/work
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["tini", "--"]
CMD ["sleep", "infinity"]
