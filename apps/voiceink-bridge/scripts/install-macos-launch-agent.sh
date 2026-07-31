#!/bin/sh
set -eu

label="com.wissmannmedia.voiceink.t3bridge"
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
bridge_entry="$repo_root/apps/voiceink-bridge/src/bin.ts"
support_dir=${VOICEINK_T3_BRIDGE_SUPPORT_DIR:-"$HOME/Library/Application Support/VoiceInk/T3Bridge"}
launch_agents_dir=${VOICEINK_T3_BRIDGE_LAUNCH_AGENTS_DIR:-"$HOME/Library/LaunchAgents"}
plist="$launch_agents_dir/$label.plist"
log_dir="$support_dir/logs"
log_file="$log_dir/bridge.log"
node_bin=${VOICEINK_T3_BRIDGE_NODE:-}

if [ -z "$node_bin" ]; then
    for candidate in "$HOME"/Library/pnpm/nodejs/24.*/bin/node; do
        if [ -x "$candidate" ]; then
            node_bin="$candidate"
        fi
    done
fi

if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
    echo "Node.js 24 is required. Set VOICEINK_T3_BRIDGE_NODE to its absolute executable path." >&2
    exit 1
fi

case "$("$node_bin" --version)" in
    v24.*) ;;
    *)
        echo "The VoiceInk T3 Bridge service requires Node.js 24." >&2
        exit 1
        ;;
esac

if [ ! -f "$bridge_entry" ]; then
    echo "Bridge entry point not found: $bridge_entry" >&2
    exit 1
fi

xml_escape() {
    /usr/bin/sed \
        -e 's/&/\&amp;/g' \
        -e 's/</\&lt;/g' \
        -e 's/>/\&gt;/g' \
        -e 's/"/\&quot;/g'
}

node_xml=$(printf '%s' "$node_bin" | xml_escape)
entry_xml=$(printf '%s' "$bridge_entry" | xml_escape)
root_xml=$(printf '%s' "$repo_root" | xml_escape)
log_xml=$(printf '%s' "$log_file" | xml_escape)
home_xml=$(printf '%s' "$HOME" | xml_escape)

/bin/mkdir -p "$launch_agents_dir" "$log_dir"
/bin/chmod 700 "$support_dir" "$log_dir"
/usr/bin/touch "$log_file"
/bin/chmod 600 "$log_file"
temporary_plist="$plist.tmp.$$"
trap '/bin/rm -f "$temporary_plist"' EXIT HUP INT TERM

/bin/cat > "$temporary_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$node_xml</string>
        <string>$entry_xml</string>
        <string>serve</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$root_xml</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$home_xml</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>$log_xml</string>
    <key>StandardErrorPath</key>
    <string>$log_xml</string>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$temporary_plist" >/dev/null
/bin/chmod 600 "$temporary_plist"
/bin/mv "$temporary_plist" "$plist"
trap - EXIT HUP INT TERM

if [ "${VOICEINK_T3_BRIDGE_SKIP_LAUNCHCTL:-0}" = "1" ]; then
    echo "Wrote test launch agent: $plist"
    exit 0
fi

domain="gui/$(/usr/bin/id -u)"
/bin/launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
loaded=0
bootstrap_error="$support_dir/bootstrap-error.$$"
trap '/bin/rm -f "$bootstrap_error"' EXIT HUP INT TERM
for attempt in 1 2 3 4 5; do
    if /bin/launchctl bootstrap "$domain" "$plist" 2>"$bootstrap_error"; then
        loaded=1
        break
    fi
    if [ "$attempt" -lt 5 ]; then
        /bin/sleep 1
    fi
done
if [ "$loaded" -ne 1 ]; then
    /bin/cat "$bootstrap_error" >&2
    echo "Could not load $label after five attempts." >&2
    exit 1
fi
/bin/rm -f "$bootstrap_error"
trap - EXIT HUP INT TERM
/bin/launchctl kickstart -k "$domain/$label"

echo "Installed and started $label"
echo "Bridge log: $log_file"
