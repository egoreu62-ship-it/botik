require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    ChannelType,
    AttachmentBuilder
} = require('discord.js');

const {
    joinVoiceChannel,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    StreamType
} = require('@discordjs/voice');

const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

const play = require('play-dl');

// Достаёт чистый ID видео из любой YouTube-ссылки (youtu.be, youtube.com, с плейлистом и т.п.)
function extractYoutubeVideoId(input) {
    const match = input.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const fs = require('fs');

const GUILD_ID = process.env.GUILD_ID;
let currentVoiceChannelId = process.env.VOICE_CHANNEL_ID;
const TOKEN = process.env.TOKEN;

// ==== Чёрный и белый список (сохраняются в файл, переживают перезапуск) ====
const DATA_FILE = './lists.json';

function loadLists() {
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return { blacklist: parsed.blacklist || [], whitelist: parsed.whitelist || [] };
    } catch (e) {
        return { blacklist: [], whitelist: [] };
    }
}

function saveLists() {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ blacklist, whitelist }, null, 2));
}

let { blacklist, whitelist } = loadLists();

let connection;

// ==== Музыка ====
const player = createAudioPlayer();
const queue = [];
let currentResource = null;
let currentTrackInfo = null; // { title, duration (сек) }
let loopEnabled = false;
let loopTrack = null; // копия объекта трека, которую подставляем обратно в очередь при повторе
let currentVolume = 100; // проценты (0-200)

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function playNext() {
    if (queue.length === 0) {
        console.log('🔇 Очередь пуста');
        // Если музыка кончилась, возвращаем стандартный статус
        client.user.setPresence({
            status: 'online',
            activities: [{ name: 'в войсе 🎧' }]
        });
        return;
    }
    const next = queue.shift();
    console.log('▶️ Пытаюсь запустить ресурс, тип:', next.inputType);

    // ОБНОВЛЕНИЕ СТАТУСА: Ставим название текущего трека в плашку бота
    if (next.title) {
        client.user.setPresence({
            status: 'online',
            activities: [{ name: `🎵 ${next.title}` }] // Будет писать: "Играет в 🎵 Название трека"
        });
    }

    const resource = createAudioResource(next.stream, {
        inputType: next.inputType || StreamType.Arbitrary,
        inlineVolume: true
    });

    if (resource.volume) {
        resource.volume.setVolume(currentVolume / 100);
    }

    currentResource = resource;
    currentTrackInfo = { title: next.title, duration: next.duration, url: next.url, requestedBy: next.requestedBy || null };

    const subscribeResult = connection ? connection.subscribe(player) : null;
    console.log('🔗 Подписка на плеер:', subscribeResult ? 'успешно' : 'ПРОВАЛ (connection нет или уже уничтожен)');
    player.play(resource);
    console.log('📊 Статус плеера после play():', player.state.status);
}


player.on(AudioPlayerStatus.Idle, () => {
    console.log('⏹ Плеер перешёл в Idle');

    if (loopEnabled && currentTrackInfo && currentTrackInfo.url) {
        console.log('🔁 Повтор трека:', currentTrackInfo.title);
        play.stream(currentTrackInfo.url, { discordPlayerCompatible: true })
            .then((streamInfo) => {
                queue.unshift({
                    stream: streamInfo.stream,
                    inputType: streamInfo.type,
                    title: currentTrackInfo.title,
                    duration: currentTrackInfo.duration,
                    url: currentTrackInfo.url
                });
                playNext();
            })
            .catch((error) => {
                console.error('Ошибка при повторе трека:', error);
                playNext();
            });
        return;
    }

    playNext();
});

player.on(AudioPlayerStatus.Playing, () => {
    console.log('🔊 Плеер реально начал играть (Playing)');
});

player.on(AudioPlayerStatus.Buffering, () => {
    console.log('⏳ Плеер буферизует...');
});

player.on('error', (error) => {
    // EPIPE — обычно безобидный обрыв старого потока при резкой смене трека, не критично
    if (error.message && error.message.includes('EPIPE')) {
        console.log('⚠️ EPIPE (обрыв старого потока при смене трека) — игнорирую');
    } else {
        console.error('Ошибка плеера:', error);
    }
    playNext();
});

async function joinVoice() {
    try {
        const guild = await client.guilds.fetch(GUILD_ID);

        const channel = await guild.channels.fetch(currentVoiceChannelId);

        if (!channel) {
            console.error('❌ Голосовой канал не найден');
            return;
        }

        if (channel.type !== ChannelType.GuildVoice) {
            console.error('❌ Указанный канал не является обычным голосовым каналом');
            return;
        }

        if (connection) {
            connection.destroy();
        }

        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,

            // Бот не слышит других, но теперь может передавать звук музыки
            selfDeaf: false,
            selfMute: false
        });

        connection.on(VoiceConnectionStatus.Ready, () => {
            console.log(`✅ Бот находится в канале: ${channel.name}`);
            connection.subscribe(player);
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            console.log('⚠️ Соединение с Discord потеряно. Переподключаюсь...');

            setTimeout(() => {
                joinVoice();
            }, 5000);
        });

        connection.on(VoiceConnectionStatus.Destroyed, () => {
            console.log('❌ Voice connection уничтожен');
        });

    } catch (error) {
        console.error('Ошибка подключения к войсу:', error);

        setTimeout(() => {
            joinVoice();
        }, 10000);
    }
}

client.once('ready', async () => {
    console.log(`🤖 Бот запущен: ${client.user.tag}`);

    try {
        const clientID = await play.getFreeClientID();
        await play.setToken({ soundcloud: { client_id: clientID } });
        console.log('🎧 SoundCloud client ID получен');
    } catch (error) {
        console.error('Не удалось получить SoundCloud client ID:', error);
    }

    client.user.setPresence({
        status: 'online',
        activities: [{ name: 'в войсе 🎧' }]
    });

    await joinVoice();
});

client.login(TOKEN);

// ==== Ответ на упоминание бота ====
const MENTION_REPLIES = [
    'Чё?',
    'Я тут, слушаю войс.',
    'Опять ты меня зовёшь 👀',
    'Не мешай, я работаю.',
    'Да?',
    'Занят, сижу в канале.'
];

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // ---- Заблокированные пользователи (управляется через веб-панель) ----
    if (blacklist.includes(message.author.id)) {
        return; // просто игнорируем сообщение целиком
    }

    console.log(`📩 Сообщение от ${message.author.tag}: "${message.content}"`);

    // ---- !play <название или ссылка на SoundCloud> ----
    if (message.content.startsWith('!play ')) {
        const query = message.content.slice(6).trim();
        if (!query) {
            message.reply('Напиши так: `!play название песни`, `!play ссылка на SoundCloud` или `!play ссылка на YouTube`');
            return;
        }

        try {
            let url = query;
            let results;
            let source = 'search'; // 'youtube' | 'soundcloud' | 'search'

            const youtubeVideoId = query.startsWith('http') ? extractYoutubeVideoId(query) : null;
            const isYoutubeLink = !!youtubeVideoId;

            if (isYoutubeLink) {
                url = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
            }

            const isSoundcloudLink = !isYoutubeLink && query.startsWith('http') && (await play.so_validate(query)) === 'track';

            if (isYoutubeLink) {
                source = 'youtube';
            } else if (isSoundcloudLink) {
                source = 'soundcloud';
            } else {
                // Это не прямая ссылка — ищем по названию (через SoundCloud, как раньше)
                source = 'search';

                // Защита от полной абракадабры (длинный набор букв без гласных)
                const isGibberish = query.length > 6 && !query.includes(' ') && !/[aeiouyаеиоуыэюяё]/i.test(query);
                if (isGibberish) {
                    message.reply('❌ Похоже на бред. Напиши нормальное название песни!');
                    return;
                }

                results = await play.search(query, { limit: 1, source: { soundcloud: 'tracks' } });
                if (!results.length) {
                    message.reply('Ничего не нашёл 😕');
                    return;
                }

                const foundTitle = results[0].name.toLowerCase();
                const queryWords = query.toLowerCase().split(/\s+/);
                const hasMatch = queryWords.some(word => foundTitle.includes(word));

                if (!hasMatch) {
                    message.reply('❌ SoundCloud выдал случайный трек. Напиши точнее!');
                    return;
                }

                url = results[0].url;
            }

            // Узнаем название трека и длительность для плашки/прогресс-бара
            let trackTitle = 'Музыку';
            let trackDuration = null;

            if (source === 'youtube') {
                try {
                    const info = await play.video_basic_info(url);
                    trackTitle = info.video_details.title;
                    trackDuration = info.video_details.durationInSec || null;
                } catch (e) {
                    console.error('Не удалось получить инфо о YouTube-видео:', e);
                }
            } else {
                try {
                    const trackData = await play.soundcloud(url);
                    trackTitle = trackData.name;
                    trackDuration = trackData.durationInSec || null;
                } catch (e) {
                    if (source === 'search' && results && results[0]) {
                        trackTitle = results[0].name;
                        trackDuration = results[0].durationInSec || null;
                    }
                }
            }

            // Получаем стрим (play-dl сам понимает, YouTube это или SoundCloud, по ссылке)
            const streamInfo = await play.stream(url, {
                discordPlayerCompatible: true
            });

            // Добавляем в очередь
            queue.push({ stream: streamInfo.stream, inputType: streamInfo.type, title: trackTitle, duration: trackDuration, url: url, requestedBy: message.author.id });

            if (player.state.status !== AudioPlayerStatus.Playing) {
                playNext();
            }

            message.reply(`🎵 Добавлено в очередь: ${trackTitle}`);

        } catch (error) {
            console.error('Ошибка воспроизведения:', error);
            message.reply('Не получилось включить это 😕');
        }
        return;
    }

    // ---- !sosi (мем-команда: включает трек и кидает картинку) ----
    if (message.content === '!sosi') {
        try {
            const attachment = new AttachmentBuilder('./assets/sosi.png');
            message.reply({ files: [attachment] });

            const searchQuery = 'MORGENSHTERN Пососи';
            const results = await play.search(searchQuery, { limit: 1, source: { soundcloud: 'tracks' } });

            if (!results.length) {
                message.reply('Трек не нашёл, но картинку кину 🤷');
                return;
            }

            const url = results[0].url;
            const trackTitle = results[0].name;
            const trackDuration = results[0].durationInSec || null;

            const streamInfo = await play.stream(url, { discordPlayerCompatible: true });
            queue.push({ stream: streamInfo.stream, inputType: streamInfo.type, title: trackTitle, duration: trackDuration, url: url });

            if (player.state.status !== AudioPlayerStatus.Playing) {
                playNext();
            }
        } catch (error) {
            console.error('Ошибка команды !sosi:', error);
        }
        return;
    }

    // ---- !test (диагностика: тестовый сигнал, теперь через очередь) ----
    if (message.content === '!test') {
        console.log('🧪 Добавляю тестовый сигнал в очередь...');

        const ffmpegProcess = spawn(ffmpegPath, [
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:duration=5',
            '-c:a', 'libopus',
            '-b:a', '64k',
            '-f', 'ogg',
            'pipe:1'
        ]);

        ffmpegProcess.stderr.on('data', (data) => {
            console.log('🧪 ffmpeg stderr:', data.toString());
        });

        queue.push({ stream: ffmpegProcess.stdout, inputType: StreamType.Arbitrary, title: 'Тестовый сигнал 🧪' });

        if (player.state.status !== AudioPlayerStatus.Playing) {
            playNext();
        }

        message.reply('🧪 Тестовый сигнал добавлен в очередь!');
        return;
    }


    // ---- !queue (список треков в очереди) ----
    if (message.content === '!queue') {
        if (!currentTrackInfo && queue.length === 0) {
            message.reply('Очередь пуста, ничего не играет 😴');
            return;
        }

        let text = '';
        if (currentTrackInfo) {
            text += `▶️ Сейчас играет: **${currentTrackInfo.title}**\n\n`;
        }
        if (queue.length > 0) {
            text += '**Далее в очереди:**\n';
            queue.slice(0, 10).forEach((track, i) => {
                text += `${i + 1}. ${track.title}\n`;
            });
            if (queue.length > 10) {
                text += `...и ещё ${queue.length - 10} треков`;
            }
        } else {
            text += '_(очередь пуста, дальше играть нечему)_';
        }

        message.reply(text);
        return;
    }

    // ---- !pause ----
    if (message.content === '!pause') {
        if (player.state.status !== AudioPlayerStatus.Playing) {
            message.reply('Сейчас ничего не играет 🤷');
            return;
        }
        player.pause();
        message.reply('⏸ Пауза');
        return;
    }

    // ---- !resume ----
    if (message.content === '!resume') {
        player.unpause();
        message.reply('▶️ Продолжаю');
        return;
    }

    // ---- !volume <0-200> ----
    if (message.content.startsWith('!volume')) {
        const arg = message.content.slice(7).trim();
        const value = parseInt(arg, 10);

        if (!arg) {
            message.reply(`Текущая громкость: ${currentVolume}%. Напиши \`!volume 50\`, чтобы изменить.`);
            return;
        }

        if (isNaN(value) || value < 0 || value > 200) {
            message.reply('Укажи число от 0 до 200, например `!volume 80`');
            return;
        }

        currentVolume = value;
        if (currentResource && currentResource.volume) {
            currentResource.volume.setVolume(currentVolume / 100);
        }
        message.reply(`🔊 Громкость: ${currentVolume}%`);
        return;
    }

    // ---- !loop (повтор текущего трека вкл/выкл) ----
    if (message.content === '!loop') {
        loopEnabled = !loopEnabled;
        message.reply(loopEnabled ? '🔁 Повтор трека включён' : '➡️ Повтор трека выключен');
        return;
    }

    // ---- !nowplaying ----
    if (message.content === '!nowplaying') {
        if (!currentTrackInfo || player.state.status !== AudioPlayerStatus.Playing) {
            message.reply('Сейчас ничего не играет 🤷');
            return;
        }

        const elapsedSec = currentResource ? Math.floor(currentResource.playbackDuration / 1000) : 0;
        const totalSec = currentTrackInfo.duration;

        let bar = '';
        if (totalSec) {
            const barLength = 20;
            const filled = Math.min(barLength, Math.round((elapsedSec / totalSec) * barLength));
            bar = '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, barLength - filled));
        } else {
            bar = '▬'.repeat(20);
        }

        message.reply(
            `🎵 **${currentTrackInfo.title}**\n` +
            `${bar}\n` +
            `${formatTime(elapsedSec)} / ${formatTime(totalSec)}  •  🔊 ${currentVolume}%`
        );
        return;
    }

    // ---- !skip ----
    if (message.content === '!skip') {
        const requesterId = currentTrackInfo ? currentTrackInfo.requestedBy : null;
        const requesterIsProtected = requesterId && whitelist.includes(requesterId);

        // Если трек включил человек из белого списка — скипнуть может только он сам
        // Если трек включил обычный человек — скипнуть может кто угодно
        const canSkip = !requesterIsProtected || message.author.id === requesterId;

        if (!canSkip) {
            message.reply('❌ Этот трек защищён — скипнуть его может только тот, кто включил.');
            return;
        }

        player.stop();
        message.reply('⏭ Пропускаю трек');
        return;
    }


    // ---- !stop ----
    if (message.content === '!stop') {
        queue.length = 0;
        currentTrackInfo = null;
        currentResource = null;
        loopEnabled = false;
        player.stop();

        // Сбрасываем статус в исходный
        client.user.setPresence({
            status: 'online',
            activities: [{ name: 'в войсе 🎧' }]
        });

        message.reply('⏹ Останавливаю музыку');
        return;
    }


    // ---- Ответ на упоминание бота ----
    if (message.mentions.has(client.user)) {
        const reply = MENTION_REPLIES[Math.floor(Math.random() * MENTION_REPLIES.length)];
        message.reply(reply);
    }
});

// ==== Веб-панель управления ====
const express = require('express');
const app = express();
app.use(express.json());

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'change_me';
const PANEL_PORT = process.env.PANEL_PORT || 3000;

// Простая проверка логина/пароля (Basic Auth)
function checkAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="Panel"');
        return res.status(401).send('Требуется авторизация');
    }
    const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
    const [user, pass] = decoded.split(':');
    if (user !== PANEL_USER || pass !== PANEL_PASSWORD) {
        res.set('WWW-Authenticate', 'Basic realm="Panel"');
        return res.status(401).send('Неверный логин или пароль');
    }
    next();
}

app.use(checkAuth);

// Главная страница — HTML с кнопками
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>mogster — панель управления</title>
<style>
    body { font-family: -apple-system, sans-serif; background: #0f1115; color: #e5e7eb; padding: 24px; max-width: 480px; margin: 0 auto; }
    h1 { font-size: 20px; }
    .card { background: #1a1d24; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    button { background: #5865F2; color: white; border: none; padding: 10px 16px; border-radius: 8px; margin: 4px; cursor: pointer; font-size: 14px; }
    button:hover { background: #4752c4; }
    button.danger { background: #ed4245; }
    input[type=text] { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #333; background: #0f1115; color: white; margin-bottom: 8px; box-sizing: border-box; }
    input[type=range] { width: 100%; }
    #status { white-space: pre-wrap; font-size: 14px; color: #9ca3af; }
</style>
</head>
<body>
    <h1>🎧 mogster — панель</h1>

    <div class="card">
        <div id="status">Загрузка...</div>
    </div>

    <div class="card">
        <input type="text" id="playInput" placeholder="Название песни или ссылка">
        <button onclick="playTrack()">▶️ Включить</button>
    </div>

    <div class="card">
        <button onclick="cmd('pause')">⏸ Пауза</button>
        <button onclick="cmd('resume')">▶️ Продолжить</button>
        <button onclick="cmd('skip')">⏭ Скип</button>
        <button onclick="cmd('loop')">🔁 Повтор</button>
        <button class="danger" onclick="cmd('stop')">⏹ Стоп</button>
    </div>

    <div class="card">
        <label>Громкость: <span id="volLabel">100</span>%</label>
        <input type="range" min="0" max="200" value="100" id="volSlider" onchange="setVolume(this.value)">
    </div>

    <div class="card">
        <h3 style="margin-top:0">🔀 Переместить в другой канал</h3>
        <input type="text" id="channelInput" placeholder="ID голосового канала">
        <button onclick="moveChannel()">Переместить</button>
    </div>

    <div class="card">
        <h3 style="margin-top:0">🚫 Чёрный список (бан)</h3>
        <input type="text" id="blacklistInput" placeholder="ID пользователя">
        <button onclick="addToList('blacklist')">Добавить</button>
        <div id="blacklistItems"></div>
    </div>

    <div class="card">
        <h3 style="margin-top:0">✅ Белый список (их треки нельзя скипать другим)</h3>
        <input type="text" id="whitelistInput" placeholder="ID пользователя">
        <button onclick="addToList('whitelist')">Добавить</button>
        <div id="whitelistItems"></div>
    </div>

<script>
async function refreshStatus() {
    const res = await fetch('/api/status');
    const data = await res.json();
    document.getElementById('status').textContent =
        (data.playing ? '▶️ Играет: ' + data.title : '🔇 Ничего не играет') +
        '\\nВ очереди: ' + data.queueLength +
        '\\nПовтор: ' + (data.loop ? 'включён' : 'выключен') +
        '\\nГромкость: ' + data.volume + '%';
    document.getElementById('volSlider').value = data.volume;
    document.getElementById('volLabel').textContent = data.volume;
}

async function cmd(action) {
    await fetch('/api/' + action, { method: 'POST' });
    refreshStatus();
}

async function playTrack() {
    const query = document.getElementById('playInput').value;
    if (!query) return;
    await fetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    document.getElementById('playInput').value = '';
    setTimeout(refreshStatus, 1500);
}

async function setVolume(value) {
    document.getElementById('volLabel').textContent = value;
    await fetch('/api/volume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: parseInt(value) })
    });
}

async function moveChannel() {
    const channelId = document.getElementById('channelInput').value.trim();
    if (!channelId) return;
    const res = await fetch('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId })
    });
    if (res.ok) {
        document.getElementById('channelInput').value = '';
        alert('Перемещаюсь в канал ' + channelId);
    } else {
        alert('Не получилось переместиться');
    }
}

async function addToList(listName) {
    const inputId = listName + 'Input';
    const id = document.getElementById(inputId).value.trim();
    if (!id) return;
    try {
        const res = await fetch('/api/' + listName, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        if (!res.ok) {
            alert('Ошибка: ' + res.status);
            return;
        }
        document.getElementById(inputId).value = '';
        await loadLists();
    } catch (err) {
        alert('Ошибка сети: ' + err.message);
    }
}

async function removeFromList(listName, id) {
    await fetch('/api/' + listName + '/' + id, { method: 'DELETE' });
    loadLists();
}

async function loadLists() {
    const res = await fetch('/api/lists');
    const data = await res.json();

    document.getElementById('blacklistItems').innerHTML = data.blacklist.map(id =>
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px;">' +
        '<span>' + id + '</span>' +
        '<button class="danger" onclick="removeFromList(\'blacklist\',\'' + id + '\')">Удалить</button>' +
        '</div>'
    ).join('') || '<span style="color:#6b7280;font-size:13px;">Список пуст</span>';

    document.getElementById('whitelistItems').innerHTML = data.whitelist.map(id =>
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px;">' +
        '<span>' + id + '</span>' +
        '<button class="danger" onclick="removeFromList(\'whitelist\',\'' + id + '\')">Удалить</button>' +
        '</div>'
    ).join('') || '<span style="color:#6b7280;font-size:13px;">Список пуст</span>';
}

refreshStatus();
loadLists();
setInterval(refreshStatus, 5000);
</script>
</body>
</html>`);
});

// API: статус
app.get('/api/status', (req, res) => {
    res.json({
        playing: player.state.status === AudioPlayerStatus.Playing,
        title: currentTrackInfo ? currentTrackInfo.title : null,
        queueLength: queue.length,
        loop: loopEnabled,
        volume: currentVolume
    });
});

// API: включить трек (используем ту же логику поиска, что и !play)
app.post('/api/play', async (req, res) => {
    const query = req.body.query;
    if (!query) return res.status(400).json({ error: 'query required' });

    try {
        let url = query;
        let results;
        let source = 'search';

        const youtubeVideoId = query.startsWith('http') ? extractYoutubeVideoId(query) : null;
        const isYoutubeLink = !!youtubeVideoId;
        if (isYoutubeLink) {
            url = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
            source = 'youtube';
        } else {
            const isSoundcloudLink = query.startsWith('http') && (await play.so_validate(query)) === 'track';
            if (isSoundcloudLink) {
                source = 'soundcloud';
            } else {
                results = await play.search(query, { limit: 1, source: { soundcloud: 'tracks' } });
                if (!results.length) return res.status(404).json({ error: 'not found' });
                url = results[0].url;
            }
        }

        let trackTitle = 'Музыку';
        let trackDuration = null;

        if (source === 'youtube') {
            const info = await play.video_basic_info(url);
            trackTitle = info.video_details.title;
            trackDuration = info.video_details.durationInSec || null;
        } else {
            try {
                const trackData = await play.soundcloud(url);
                trackTitle = trackData.name;
                trackDuration = trackData.durationInSec || null;
            } catch (e) {
                if (source === 'search' && results && results[0]) {
                    trackTitle = results[0].name;
                    trackDuration = results[0].durationInSec || null;
                }
            }
        }

        const streamInfo = await play.stream(url, { discordPlayerCompatible: true });
        queue.push({ stream: streamInfo.stream, inputType: streamInfo.type, title: trackTitle, duration: trackDuration, url });

        if (player.state.status !== AudioPlayerStatus.Playing) {
            playNext();
        }

        res.json({ ok: true, title: trackTitle });
    } catch (error) {
        console.error('Ошибка /api/play:', error);
        res.status(500).json({ error: 'failed' });
    }
});

app.post('/api/pause', (req, res) => { player.pause(); res.json({ ok: true }); });
app.post('/api/resume', (req, res) => { player.unpause(); res.json({ ok: true }); });
app.post('/api/skip', (req, res) => { player.stop(); res.json({ ok: true }); });
app.post('/api/loop', (req, res) => { loopEnabled = !loopEnabled; res.json({ ok: true, loop: loopEnabled }); });
app.post('/api/stop', (req, res) => {
    queue.length = 0;
    currentTrackInfo = null;
    currentResource = null;
    loopEnabled = false;
    player.stop();
    res.json({ ok: true });
});
app.post('/api/volume', (req, res) => {
    const value = req.body.value;
    if (typeof value !== 'number' || value < 0 || value > 200) {
        return res.status(400).json({ error: 'invalid value' });
    }
    currentVolume = value;
    if (currentResource && currentResource.volume) {
        currentResource.volume.setVolume(currentVolume / 100);
    }
    res.json({ ok: true });
});

// API: перемещение в другой голосовой канал
app.post('/api/move', async (req, res) => {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    try {
        currentVoiceChannelId = channelId;
        await joinVoice();
        res.json({ ok: true });
    } catch (error) {
        console.error('Ошибка перемещения канала:', error);
        res.status(500).json({ error: 'failed' });
    }
});

// API: чёрный и белый список
app.get('/api/lists', (req, res) => {
    res.json({ blacklist, whitelist });
});

app.post('/api/blacklist', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!blacklist.includes(id)) blacklist.push(id);
    saveLists();
    res.json({ ok: true });
});

app.delete('/api/blacklist/:id', (req, res) => {
    blacklist = blacklist.filter(uid => uid !== req.params.id);
    saveLists();
    res.json({ ok: true });
});

app.post('/api/whitelist', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!whitelist.includes(id)) whitelist.push(id);
    saveLists();
    res.json({ ok: true });
});

app.delete('/api/whitelist/:id', (req, res) => {
    whitelist = whitelist.filter(uid => uid !== req.params.id);
    saveLists();
    res.json({ ok: true });
});

app.listen(PANEL_PORT, '127.0.0.1', () => {
    console.log(`🖥️ Панель управления запущена на порту ${PANEL_PORT} (только localhost)`);
});
