#!/bin/sh
# Wine 会派生 Windows 子进程。等待整个专属环境退出，避免过早放开存档导入及卸载。
wine=$1
shift
server="$(dirname "$wine")/wineserver"
status="$WINEPREFIX.exit"
write_status() {
    printf '%s\n' "$1" > "$status.tmp.$$" && mv -f "$status.tmp.$$" "$status"
}
stop() {
    trap '' TERM INT
    "$server" -k
    "$server" -w
    write_status 143
    exit 143
}
trap stop TERM INT
# 首次初始化后补充 Mac 自带中文字体替代；已有环境绝不覆盖。
if [ -f "$WINEPREFIX.fonts.reg" ]; then
    if [ ! -f "$WINEPREFIX/system.reg" ]; then
        "$wine" wineboot -u &
        wait $! || { write_status 1; exit 1; }
    fi
    "$wine" regedit /S "$WINEPREFIX.fonts.reg" &
    wait $! || { write_status 1; exit 1; }
fi
rm -f "$WINEPREFIX.fonts.reg"
"$wine" "$@" &
child=$!
wait "$child"
result=$?
# 即使入口交接后退出，也要等同一 WINEPREFIX 的实际游戏结束。
"$server" -w &
wait $!
write_status "$result"
exit "$result"
