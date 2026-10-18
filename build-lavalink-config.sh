#!/usr/bin/env bash
# Собирает /opt/lavalink/application.yml из .env бота.
# Источник включается только если для него есть токен. Запуск:
#   bash ~/bot/build-lavalink-config.sh && systemctl restart lavalink
set -euo pipefail

ENV_FILE="${ENV_FILE:-/root/bot/.env}"
OUT="${OUT:-/opt/lavalink/application.yml}"
YT_PLUGIN_VERSION="1.18.2"
LAVASRC_VERSION="4.8.3"

[ -f "$ENV_FILE" ] || { echo "❌ Не найден $ENV_FILE"; exit 1; }

# достаёт значение KEY из .env (без выполнения содержимого файла)
get() {
  { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | tail -n1 | cut -d= -f2- | tr -d '\r' \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
check() { # в токене не должно быть символов, ломающих YAML
  case "$2" in *'"'*|*'\'*) echo "❌ В $1 есть кавычка или обратный слеш — уберите их"; exit 1;; esac
}

PASS="$(get LAVALINK_PASSWORD)"
if [ -z "$PASS" ] && [ -f "$OUT" ]; then
  PASS="$(grep -m1 'password:' "$OUT" | cut -d'"' -f2)"   # берём пароль из старого конфига
fi
[ -n "$PASS" ] || { echo "❌ Нет LAVALINK_PASSWORD ни в .env, ни в старом конфиге"; exit 1; }

YM="$(get YANDEX_MUSIC_TOKEN)"
VK="$(get VK_MUSIC_TOKEN)"
SPID="$(get SPOTIFY_CLIENT_ID)"
SPSEC="$(get SPOTIFY_CLIENT_SECRET)"
for v in PASS:"$PASS" YM:"$YM" VK:"$VK" SPID:"$SPID" SPSEC:"$SPSEC"; do check "${v%%:*}" "${v#*:}"; done

SP_ON=false; [ -n "$SPID" ] && [ -n "$SPSEC" ] && SP_ON=true
YM_ON=false; [ -n "$YM" ] && YM_ON=true
VK_ON=false; [ -n "$VK" ] && VK_ON=true

TMP="$(mktemp)"
{
cat <<YML
server:
  port: 2333
  address: 127.0.0.1
lavalink:
  plugins:
    - dependency: "dev.lavalink.youtube:youtube-plugin:${YT_PLUGIN_VERSION}"
    - dependency: "com.github.topi314.lavasrc:lavasrc-plugin:${LAVASRC_VERSION}"
      repository: "https://maven.lavalink.dev/releases"
  server:
    password: "${PASS}"
    sources:
      youtube: false
      soundcloud: false
      http: true
      bandcamp: false
      twitch: false
      vimeo: false
      local: false
plugins:
  youtube:
    enabled: true
    allowSearch: true
  lavasrc:
    # Если трек нужно «подменить» (Spotify, Apple Music), ищем двойника в этом порядке:
    providers:
      - "ytsearch:\"%ISRC%\""
YML
[ "$YM_ON" = true ] && echo '      - "ymsearch:%QUERY%"'
[ "$VK_ON" = true ] && echo '      - "vksearch:%QUERY%"'
cat <<YML
      - "ytmsearch:%QUERY%"
      - "ytsearch:%QUERY%"
    sources:
      spotify: ${SP_ON}
      applemusic: false
      deezer: false
      yandexmusic: ${YM_ON}
      vkmusic: ${VK_ON}
      youtube: false
YML
if [ "$SP_ON" = true ]; then cat <<YML
    spotify:
      clientId: "${SPID}"
      clientSecret: "${SPSEC}"
      countryCode: "US"
      playlistLoadLimit: 3
      albumLoadLimit: 3
YML
fi
if [ "$YM_ON" = true ]; then cat <<YML
    yandexmusic:
      accessToken: "${YM}"
      playlistLoadLimit: 1
      albumLoadLimit: 1
      artistLoadLimit: 1
YML
fi
if [ "$VK_ON" = true ]; then cat <<YML
    vkmusic:
      userToken: "${VK}"
      playlistLoadLimit: 1
      artistLoadLimit: 1
      recommendationsLoadLimit: 10
YML
fi
cat <<YML
logging:
  level:
    root: INFO
    lavalink: INFO
YML
} > "$TMP"

[ -f "$OUT" ] && cp "$OUT" "$OUT.bak"
mv "$TMP" "$OUT"
chmod 600 "$OUT"
id lavalink >/dev/null 2>&1 && chown lavalink:lavalink "$OUT" || true

echo "✅ Конфиг записан: $OUT"
echo "   YouTube: вкл | Spotify: $SP_ON | Яндекс Музыка: $YM_ON | ВКонтакте: $VK_ON | SoundCloud: выкл"
echo "   Дальше: systemctl restart lavalink"
