#!/bin/bash
set -e
Xvfb :99 -screen 0 1280x800x24 &
sleep 1
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
openbox &
sleep 1
firefox --width 1200 --height 760 ${START_URL:+"$START_URL"} &
x11vnc -display :99 -nopw -forever -shared -localhost &
websockify --web /usr/share/novnc 6080 localhost:5900 &
node /agent/loop.js
code=$?
sleep "${LINGER_S:-90}"
exit $code
