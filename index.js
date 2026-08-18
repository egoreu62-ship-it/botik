require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    ChannelType
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

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const TOKEN = process.env.TOKEN;

let connection;

// ==== Музыка ====
const player = createAudioPlayer();
const queue = [];
let currentResource = null;
let currentTrackInfo = null; // { title, duration (сек) }
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
    console.log('▶️ Пытаюсь запустить ресурс, тип:', next.type);

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
    currentTrackInfo = { title: next.title, duration: next.duration };

    const subscribeResult = connection ? connection.subscribe(player) : null;
    console.log('🔗 Подписка на плеер:', subscribeResult ? 'успешно' : 'ПРОВАЛ (connection нет или уже уничтожен)');
    player.play(resource);
    console.log('📊 Статус плеера после play():', player.state.status);
}


player.on(AudioPlayerStatus.Idle, () => {
    console.log('⏹ Плеер перешёл в Idle');
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

        const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

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

    console.log(`📩 Сообщение от ${message.author.tag}: "${message.content}"`);

    // ---- !play <название или ссылка на SoundCloud> ----
    if (message.content.startsWith('!play ')) {
        const query = message.content.slice(6).trim();
        if (!query) {
            message.reply('Напиши так: `!play название песни` или `!play ссылка на SoundCloud`');
            return;
        }

        try {
            let url = query;
            let results;

            const isDirectLink = query.startsWith('http') && (await play.so_validate(query)) === 'track';

            if (!isDirectLink) {
                // Защита от полной абракадабры (длинный набор букв без гласных)
                const isGibberish = query.length > 6 && !query.includes(' ') && !/[aeiouyаеиоуыэюяё]/i.test(query);
                if (isGibberish) {
                    message.reply('❌ Похоже на бред. Напиши нормальное название песни!');
                    return;
                }

                // Ищем по названию
                results = await play.search(query, { limit: 1, source: { soundcloud: 'tracks' } });
                if (!results.length) {
                    message.reply('Ничего не нашёл 😕');
                    return;
                }

                // Проверяем, совпадает ли хоть одно слово из запроса с названием найденного трека
                const foundTitle = results[0].name.toLowerCase();
                const queryWords = query.toLowerCase().split(/\s+/);
                const hasMatch = queryWords.some(word => foundTitle.includes(word));

                // Если совпадений по словам вообще нет — значит SoundCloud подсунул левый рандом
                if (!hasMatch) {
                    message.reply('❌ SoundCloud выдал случайный трек. Напиши точнее!');
                    return;
                }

                url = results[0].url;
            }

            // Узнаем красивое название трека и длительность для плашки/прогресс-бара
            let trackTitle = 'Музыку';
            let trackDuration = null;
            try {
                const trackData = await play.soundcloud(url);
                trackTitle = trackData.name;
                trackDuration = trackData.durationInSec || null;
            } catch (e) {
                if (!isDirectLink && results && results[0]) {
                    trackTitle = results[0].name;
                    trackDuration = results[0].durationInSec || null;
                }
            }

            // Получаем стрим из SoundCloud
            const streamInfo = await play.stream(url, {
                discordPlayerCompatible: true
            });

            // Добавляем в очередь
            queue.push({ stream: streamInfo.stream, type: streamInfo.type, title: trackTitle, duration: trackDuration });

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
        player.stop();
        message.reply('⏭ Пропускаю трек');
        return;
    }


    // ---- !stop ----
    if (message.content === '!stop') {
        queue.length = 0;
        currentTrackInfo = null;
        currentResource = null;
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
