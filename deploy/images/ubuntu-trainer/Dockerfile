# syntax=docker/dockerfile:1.6
#
# Labforge "Ubuntu Trainer" desktop image.
# Base: KasmVNC Ubuntu Jammy desktop (same as ubuntu-desktop template).
# Adds: Python 3 + pip + venv, JupyterLab, MySQL Workbench, Postman.
#
# Build (on the prod host so the daemon has the result locally):
#   cd deploy/images/ubuntu-trainer
#   sudo docker build -t labforge/ubuntu-trainer:1.0 .
#
# The image is referenced by the `ubuntu-trainer` template in
# packages/control-plane/src/catalog/defaults.ts.

ARG BASE=kasmweb/ubuntu-jammy-desktop:1.16.0
FROM ${BASE}

# Layer order is from most-stable to least-stable so rebuilds stay cheap.
USER root
ENV DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# 1. APT packages: Python, build prerequisites, libs Postman/Workbench need
#    at runtime. MySQL Workbench is no longer in Ubuntu's repos; we install
#    Oracle's official .deb in a dedicated layer below.
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv python3-dev \
        # Postman/Electron + Workbench runtime deps
        libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils \
        libatspi2.0-0 libuuid1 libsecret-1-0 \
        # Workbench-specific runtime libs (kasm base lacks these)
        libpcre2-8-0 libsqlite3-0 libzip4 libgl1 libglu1-mesa \
        libxslt1.1 libproj22 libvulkan1 \
        ca-certificates wget tar \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# 1b. MySQL Workbench 8.0 — direct .deb from Oracle (no apt repo prompts).
#     Pinned to a known-good version; bump as Oracle releases newer .debs.
# ---------------------------------------------------------------------------
ARG WORKBENCH_VERSION=8.0.42-1ubuntu22.04
RUN set -eux; \
    wget -q -O /tmp/workbench.deb \
        "https://dev.mysql.com/get/Downloads/MySQLGUITools/mysql-workbench-community_${WORKBENCH_VERSION}_amd64.deb"; \
    apt-get update; \
    apt-get install -y --no-install-recommends /tmp/workbench.deb; \
    rm /tmp/workbench.deb; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# 2. JupyterLab (system-wide pip install so every user gets it).
# ---------------------------------------------------------------------------
RUN pip3 install --no-cache-dir --upgrade pip \
 && pip3 install --no-cache-dir \
        jupyterlab \
        notebook \
        ipywidgets \
        pandas \
        numpy \
        matplotlib \
        requests

# ---------------------------------------------------------------------------
# 3. Postman: official tarball into /opt + .desktop launcher.
#    (Snap doesn't work inside a container; .deb isn't published.)
# ---------------------------------------------------------------------------
RUN set -eux; \
    wget -q -O /tmp/postman.tar.gz "https://dl.pstmn.io/download/latest/linux64"; \
    tar -xzf /tmp/postman.tar.gz -C /opt; \
    ln -sf /opt/Postman/Postman /usr/local/bin/postman; \
    rm /tmp/postman.tar.gz

# ---------------------------------------------------------------------------
# 4. Desktop menu entries so users can launch from the XFCE menu.
# ---------------------------------------------------------------------------
RUN install -d /usr/share/applications
RUN printf '%s\n' \
    '[Desktop Entry]' \
    'Name=Postman' \
    'Comment=API Development Environment' \
    'Exec=/opt/Postman/Postman %U' \
    'Icon=/opt/Postman/app/resources/app/assets/icon.png' \
    'Terminal=false' \
    'Type=Application' \
    'Categories=Development;' \
    > /usr/share/applications/postman.desktop
RUN printf '%s\n' \
    '[Desktop Entry]' \
    'Name=JupyterLab' \
    'Comment=Browser-based Jupyter notebook' \
    "Exec=bash -lc 'jupyter lab --ServerApp.token= --ServerApp.password= --notebook-dir=\$HOME'" \
    'Icon=utilities-terminal' \
    'Terminal=true' \
    'Type=Application' \
    'Categories=Development;Science;' \
    > /usr/share/applications/jupyterlab.desktop

# ---------------------------------------------------------------------------
# 5. Hand control back to the unprivileged kasm user that the base image
#    launches the desktop as.
# ---------------------------------------------------------------------------
USER 1000
