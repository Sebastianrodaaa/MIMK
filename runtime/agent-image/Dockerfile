FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    GNOME_ACCESSIBILITY=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox dbus-x11 at-spi2-core \
      ca-certificates curl gnupg software-properties-common \
    && add-apt-repository -y ppa:mozillateam/ppa \
    && printf 'Package: *\nPin: release o=LP-PPA-mozillateam\nPin-Priority: 1001\n' \
       > /etc/apt/preferences.d/mozilla-firefox \
    && apt-get update && apt-get install -y --no-install-recommends firefox x11vnc novnc websockify \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm i -g agent-desktop@1.0.2

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 python3-venv \
    && python3 -m venv /opt/osint-venv \
    && /opt/osint-venv/bin/pip install --no-cache-dir maigret==0.6.6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /agent
COPY tools.json loop.ts compact.ts jev.ts entrypoint.sh tsconfig.json ./
COPY lane/ ./lane/
COPY policies.json /usr/lib/firefox/distribution/policies.json
RUN npm init -y >/dev/null && npm i --no-save typescript@5.9.3 @types/node@20.19.0 \
    && ./node_modules/.bin/tsc loop.ts compact.ts jev.ts lane/*.ts --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --types node --outDir . && chmod +x entrypoint.sh

ENTRYPOINT ["/agent/entrypoint.sh"]
