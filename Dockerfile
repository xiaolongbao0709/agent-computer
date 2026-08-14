# 角色电脑「容器模式」镜像（可选，需 Workers 付费计划）。
#
# 只有在 wrangler.jsonc 里取消 containers 配置的注释后，这个文件才会被用到；
# 免费部署（基础模式/完整模式）完全不碰它。
#
# 结构照抄 Cloudflare 官方 examples/container：
#  - computerd 是官方守护进程，从公开 GHCR 镜像里拷出来。它把 DO 硬盘经
#    FUSE 挂载到容器的 /workspace——命令看到的就是角色电脑的那块持久硬盘，
#    双向同步由 @cloudflare/computer 处理；
#  - FUSE_MOUNT=auto：线上（有 /dev/fuse）走真 FUSE，wrangler dev 本地自动
#    降级为用户态实现，两边同一镜像。

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.0 AS computerd

FROM debian:stable-slim

# 基础层：FUSE + 证书 + git；Node.js 22（npm 可用）；
# 顺手带上常用工具：python3/pip、zip/unzip（打包 docx/pptx）、jq。
# 想加 pandoc / ffmpeg 之类的重家伙，在下面 apt-get install 里追加即可（镜像会变大）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git \
      python3 python3-pip python3-venv \
      zip unzip jq \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# computerd 默认：HTTP+WS 在 :8080，硬盘挂载点在 MOUNT_POINT
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
