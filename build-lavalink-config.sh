#!/usr/bin/env bash
# Собирает /opt/lavalink/application.yml из .env бота.
# Источник включается только если для него есть токен. Запуск:
#   bash ~/bot/build-lavalink-config.sh && systemctl restart lavalink
set -euo pipefail

ENV_FILE="${ENV_FILE:-/root/bot/.env}"
OUT="${OUT:-/opt/lavalink/application.yml}"
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
YT_PLUGIN_VERSION="$(get YOUTUBE_PLUGIN_VERSION)"   # версия плагина YouTube; по умолчанию 1.18.2
[ -n "$YT_PLUGIN_VERSION" ] || YT_PLUGIN_VERSION="1.18.2"
YT_SNAP=false; case "$(get YOUTUBE_PLUGIN_SNAPSHOT)" in true|TRUE|1|yes) YT_SNAP=true;; esac   # true — брать сборку из snapshot-репозитория (версия = хэш коммита)
YT_OAUTH="$(get YOUTUBE_OAUTH)"            # true — войти в YouTube через Google-аккаунт (для клиента TV)
YT_REFRESH="$(get YOUTUBE_REFRESH_TOKEN)"  # после первого входа сюда кладётся refresh token
PX_URL="$(get RU_PROXY_URL)"               # необязательно: HTTP-прокси в России для Яндекса и VK
PX_USER="$(get RU_PROXY_USER)"
PX_PASS="$(get RU_PROXY_PASS)"
for v in PASS:"$PASS" YM:"$YM" VK:"$VK" SPID:"$SPID" SPSEC:"$SPSEC" YT_REFRESH:"$YT_REFRESH" YT_PLUGIN_VERSION:"$YT_PLUGIN_VERSION" PX_URL:"$PX_URL" PX_USER:"$PX_USER" PX_PASS:"$PX_PASS"; do check "${v%%:*}" "${v#*:}"; done

SP_ON=false; [ -n "$SPID" ] && [ -n "$SPSEC" ] && SP_ON=true
YM_ON=false; [ -n "$YM" ] && YM_ON=true
VK_ON=false; [ -n "$VK" ] && VK_ON=true
OAUTH_ON=false; case "$YT_OAUTH" in true|TRUE|1|yes) OAUTH_ON=true;; esac
PROXY_ON=false; [ -n "$PX_URL" ] && PROXY_ON=true

# необязательный блок proxy для Яндекса/VK (отступ 6 пробелов внутри секции источника)
proxy_block() {
  [ "$PROXY_ON" = true ] || return 0
  echo "      proxy:"
  echo "        url: \"${PX_URL}\""
  [ -n "$PX_USER" ] && echo "        username: \"${PX_USER}\""
  [ -n "$PX_PASS" ] && echo "        password: \"${PX_PASS}\""
  return 0
}

TMP="$(mktemp)"
{
cat <<YML
server:
  port: 2333
  address: 127.0.0.1
lavalink:
  plugins:
    - dependency: "dev.lavalink.youtube:youtube-plugin:${YT_PLUGIN_VERSION}"
      snapshot: ${YT_SNAP}
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
YML
if [ "$OAUTH_ON" = true ]; then cat <<YML
    clients:
      - MUSIC
      - TV
      - ANDROID_VR
      - WEB
      - WEBEMBEDDED
    oauth:
      enabled: true
YML
  [ -n "$YT_REFRESH" ] && echo "      refreshToken: \"${YT_REFRESH}\""
fi
cat <<YML
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
  proxy_block
fi
if [ "$VK_ON" = true ]; then cat <<YML
    vkmusic:
      userToken: "${VK}"
      playlistLoadLimit: 1
      artistLoadLimit: 1
      recommendationsLoadLimit: 10
YML
  proxy_block
fi
cat <<YML
logging:
  level:
    root: INFO
    lavalink: INFO
    dev.lavalink.youtube.http.YoutubeOauth2Handler: INFO
YML
} > "$TMP"

[ -f "$OUT" ] && cp "$OUT" "$OUT.bak"
mv "$TMP" "$OUT"
chmod 600 "$OUT"
id lavalink >/dev/null 2>&1 && chown lavalink:lavalink "$OUT" || true

echo "✅ Конфиг записан: $OUT"
echo "   Плагин YouTube: ${YT_PLUGIN_VERSION} (snapshot: ${YT_SNAP})"
echo "   YouTube: вкл (OAuth: $OAUTH_ON, refresh-токен: $([ -n "$YT_REFRESH" ] && echo есть || echo нет)) | Spotify: $SP_ON | Яндекс Музыка: $YM_ON | ВКонтакте: $VK_ON | прокси: $PROXY_ON | SoundCloud: выкл"
echo "   Дальше: systemctl restart lavalink"
