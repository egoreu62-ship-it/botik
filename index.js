require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    ChannelType,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder
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
        return {
            blacklist: parsed.blacklist || [],
            whitelist: parsed.whitelist || [],
            likes: parsed.likes || {}, // { userId: [{ title, url }] }
            balances: parsed.balances || {},// { userId: number }
            lastDaily: parsed.lastDaily || {},
            redeemedPromo: parsed.redeemedPromo || [],
            shopItems: parsed.shopItems || []
        };
    } catch (e) {
        return { blacklist: [], whitelist: [], likes: {}, balances: {}, lastDaily: {}, shopItems: {} };
    }
}

function saveLists() {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ blacklist, whitelist, likes, balances, lastDaily,  redeemedPromo, shopItems }, null, 2));
}

let { blacklist, whitelist, likes, balances, lastDaily, redeemedPromo, shopItems } = loadLists();

function getBalance(userId) {
    if (typeof balances[userId] !== 'number') balances[userId] = 1000;
    return balances[userId];
}

function setBalance(userId, value) {
    balances[userId] = value;
    saveLists();
}

// ==== Казино: символы слотов и гифки ====
// Замени на свои ссылки/эмодзи. Для кастомных эмодзи Discord формат: '<:название:ID>' или '<a:название:ID>' для анимированных
const SLOT_SYMBOLS = [
    '🍒', // замени
    '🍋', // замени
    '🔔', // замени
    '⭐', // замени
    '💎', // замени
    '7️⃣' // замени
];

// Вставь сюда 10+ ссылок на гифки для победы
const WIN_GIFS = [
    'https://cdn.discordapp.com/emojis/1540807221707939860.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540806818282995834.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540806712230027344.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540807016753406003.webp?size=32',
    'https://cdn.discordapp.com/emojis/1540806857701199883.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540805879639707678.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540807138421776494.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540806953335259247.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540807186060677220.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540813642587578538.webp?size=96'
];

// Вставь сюда 10+ ссылок на гифки для проигрыша
const LOSE_GIFS = [
    'https://cdn.discordapp.com/emojis/1540813742600753152.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540813775303737485.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540813851711512596.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540813882606624909.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540814213570895922.webp?size=96',
    'https://cdn.discordapp.com/emojis/1540813692525084772.webp?size=96',
    
];

// ==== Блэкджек: вспомогательные функции для карт ====
function drawCard() {
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const suits = ['♠', '♥', '♦', '♣'];
    return {
        rank: ranks[Math.floor(Math.random() * ranks.length)],
        suit: suits[Math.floor(Math.random() * suits.length)]
    };
}

function cardValue(card) {
    if (['J', 'Q', 'K'].includes(card.rank)) return 10;
    if (card.rank === 'A') return 11;
    return parseInt(card.rank);
}

function handValue(hand) {
    let value = hand.reduce((sum, c) => sum + cardValue(c), 0);
    let aces = hand.filter(c => c.rank === 'A').length;
    while (value > 21 && aces > 0) {
        value -= 10;
        aces--;
    }
    return value;
}

function formatHand(hand) {
    return hand.map(c => c.rank + c.suit).join(' ');
}

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

    // Сбрасываем голоса за voteskip — они относятся к предыдущему треку
    if (global.voteskipVotes) global.voteskipVotes.clear();

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

    // ---- !help ----
    if (message.content === '!help') {
                const helpText =
            '**🎵 Музыка**\n' +
            '`!play <название/ссылка>` — включить трек (SoundCloud или YouTube)\n' +
            '`!skip` — пропустить трек\n' +
            '`!voteskip` — голосование за пропуск\n' +
            '`!pause` / `!resume` — пауза/продолжить\n' +
            '`!stop` — остановить и очистить очередь\n' +
            '`!queue` — очередь треков\n' +
            '`!nowplaying` — текущий трек\n' +
            '`!volume <0-200>` — громкость\n' +
            '`!loop` — повтор трека вкл/выкл\n' +
            '`!like` — лайкнуть текущий трек\n' +
            '`!radio` — играть твои лайкнутые треки по кругу\n' +
            '`!anime` — случайный опенинг аниме\n\n' +
            '**🎲 Игры и развлечения**\n' +
            '`!kubik` — бросить кубик\n' +
            '`!коктель <ингредиенты>` — узнать коктейль по составу\n' +
            '`!67` — не спрашивай просто попробуй\n' +
            '`!ttt @соперник [ставка]` — крестики-нолики (можно на фишки)\n' +
            '`!battleship @соперник` — морской бой\n' +
            '`!casino <ставка>` — слоты 777\n' +
            '`!casino bonus <ставка>` — бонус-бай (дороже, но выше шанс крупного куша)\n' +
            '`!blackjack <ставка>` — блэкджек\n' +
            '`!duel @соперник <ставка>` — дуэль на фишки\n\n' +
            '`!shop` — список ролей в магазине\n' +
            '`!buy <номер>` — купить роль из магазина\n' +
            '`!auction <номер> <цена> <минуты>` — начать аукцион на роль\n' +
            '`!bid <сумма>` — сделать ставку на аукционе\n\n' +     
            '**💰 Экономика**\n' +
            '`!balance` — узнать баланс фишек\n' +
            '`!daily` — ежедневный бонус 2000 🪙\n' +
            '`!pay @человек <сумма>` — перевести фишки\n' +
            '`!promo <код>` — активировать промокод\n\n' +
            '**🔧 Другое**\n' +
            '`!test` — тестовый сигнал (диагностика звука)';
             
        message.reply(helpText);
        return;
    }

    // ---- !kubik ----
    if (message.content === '!kubik') {
        const roll = Math.floor(Math.random() * 6) + 1;
        const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
        message.reply(`🎲 Выпало: ${diceEmojis[roll - 1]} **${roll}**`);
        return;
    }

    // ---- !like (лайкнуть текущий трек) ----
    if (message.content === '!like') {
        if (!currentTrackInfo || !currentTrackInfo.url) {
            message.reply('Сейчас ничего не играет, нечего лайкать 🤷');
            return;
        }

        const userId = message.author.id;
        if (!likes[userId]) likes[userId] = [];

        const alreadyLiked = likes[userId].some(t => t.url === currentTrackInfo.url);
        if (alreadyLiked) {
            message.reply('Этот трек уже у тебя в лайках ❤️');
            return;
        }

        likes[userId].push({ title: currentTrackInfo.title, url: currentTrackInfo.url });
        saveLists();
        message.reply(`❤️ Добавлено в лайки: **${currentTrackInfo.title}**`);
        return;
    }

    // ---- !radio (проигрывает лайкнутые треки по кругу) ----
    if (message.content === '!radio') {
        const userId = message.author.id;
        const userLikes = likes[userId] || [];

        if (userLikes.length === 0) {
            message.reply('У тебя пока нет лайкнутых треков. Полайкай что-нибудь через `!like`!');
            return;
        }

        try {
            // Перемешиваем и добавляем все лайкнутые треки в очередь
            const shuffled = [...userLikes].sort(() => Math.random() - 0.5);

            for (const track of shuffled) {
                const streamInfo = await play.stream(track.url, { discordPlayerCompatible: true });
                queue.push({
                    stream: streamInfo.stream,
                    inputType: streamInfo.type,
                    title: track.title,
                    url: track.url,
                    requestedBy: userId
                });
            }

            if (player.state.status !== AudioPlayerStatus.Playing) {
                playNext();
            }

            message.reply(`📻 Радио запущено: ${shuffled.length} твоих любимых треков в очереди`);
        } catch (error) {
            console.error('Ошибка !radio:', error);
            message.reply('Не получилось запустить радио 😕');
        }
        return;
    }

    // ---- !anime (случайный опенинг аниме) ----
    if (message.content === '!anime') {
        try {
            const results = await play.search('anime opening', { limit: 20, source: { soundcloud: 'tracks' } });
            if (!results.length) {
                message.reply('Ничего не нашёл 😕');
                return;
            }

            const pick = results[Math.floor(Math.random() * results.length)];
            const streamInfo = await play.stream(pick.url, { discordPlayerCompatible: true });
            queue.push({
                stream: streamInfo.stream,
                inputType: streamInfo.type,
                title: pick.name,
                duration: pick.durationInSec || null,
                url: pick.url,
                requestedBy: message.author.id
            });

            if (player.state.status !== AudioPlayerStatus.Playing) {
                playNext();
            }

            message.reply(`🎌 Добавлено: ${pick.name}`);
        } catch (error) {
            console.error('Ошибка !anime:', error);
            message.reply('Не получилось найти опенинг 😕');
        }
        return;
    }

    // ---- !voteskip ----
    if (message.content === '!voteskip') {
        if (!currentTrackInfo) {
            message.reply('Сейчас ничего не играет 🤷');
            return;
        }

        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) {
            message.reply('Ты должен быть в голосовом канале, чтобы голосовать 🎙️');
            return;
        }

        const humansInChannel = voiceChannel.members.filter(m => !m.user.bot).size;
        if (humansInChannel === 0) {
            message.reply('В канале никого нет 🤷');
            return;
        }

        if (!global.voteskipVotes) global.voteskipVotes = new Set();
        global.voteskipVotes.add(message.author.id);

        const votesNeeded = Math.ceil(humansInChannel * 0.5); // больше половины
        const currentVotes = global.voteskipVotes.size;

        if (currentVotes >= votesNeeded) {
            global.voteskipVotes.clear();
            player.stop();
            message.reply(`⏭ Голосование прошло (${currentVotes}/${humansInChannel}) — пропускаю трек`);
        } else {
            message.reply(`🗳️ Голос учтён: ${currentVotes}/${votesNeeded} нужно для пропуска`);
        }
        return;
    }

    // ---- !коктель <ингредиенты через запятую> ----
    if (message.content.startsWith('!коктель')) {
        const ingredientsRaw = message.content.slice(8).trim();
        if (!ingredientsRaw) {
            message.reply('Напиши так: `!коктель водка, лайм, мята`');
            return;
        }

        const firstIngredient = ingredientsRaw.split(',')[0].trim();

        try {
            const searchRes = await fetch(
                `https://www.thecocktaildb.com/api/json/v1/1/filter.php?i=${encodeURIComponent(firstIngredient)}`
            );
            const searchData = await searchRes.json();

            if (!searchData.drinks || searchData.drinks.length === 0) {
                message.reply(`Не нашёл коктейлей с ингредиентом "${firstIngredient}" 😕`);
                return;
            }

            const pick = searchData.drinks[Math.floor(Math.random() * searchData.drinks.length)];

            const detailsRes = await fetch(
                `https://www.thecocktaildb.com/api/json/v1/1/lookup.php?i=${pick.idDrink}`
            );
            const detailsData = await detailsRes.json();
            const drink = detailsData.drinks[0];

            let ingredientsList = '';
            for (let i = 1; i <= 15; i++) {
                const ing = drink[`strIngredient${i}`];
                const measure = drink[`strMeasure${i}`];
                if (ing) {
                    ingredientsList += `• ${measure ? measure.trim() + ' ' : ''}${ing}\n`;
                }
            }

            message.reply(
                `🍹 **${drink.strDrink}**\n\n` +
                `**Ингредиенты:**\n${ingredientsList}\n` +
                `**Инструкция:** ${drink.strInstructions}`
            );
        } catch (error) {
            console.error('Ошибка !коктель:', error);
            message.reply('Не получилось найти коктейль 😕');
        }
        return;
    }

    // ---- !67 (мем) ----
    if (message.content === '!67') {
        try {
            message.channel.send('67');

            const results = await play.search('Газан 67', { limit: 1, source: { soundcloud: 'tracks' } });
            if (!results.length) return;

            const pick = results[0];
            const streamInfo = await play.stream(pick.url, { discordPlayerCompatible: true });
            queue.push({
                stream: streamInfo.stream,
                inputType: streamInfo.type,
                title: pick.name,
                duration: pick.durationInSec || null,
                url: pick.url,
                requestedBy: message.author.id
            });

            if (player.state.status !== AudioPlayerStatus.Playing) {
                playNext();
            }
        } catch (error) {
            console.error('Ошибка !67:', error);
        }
        return;
    }

    // ---- !balance (баланс фишек) ----
    if (message.content === '!balance') {
        message.reply(`🪙 Твой баланс: ${getBalance(message.author.id)} фишек`);
        return;
    }

    // ---- !ttt @соперник (крестики-нолики) ----
    if (message.content.startsWith('!ttt')) {
    const opponent = message.mentions.users.first();
    const args = message.content.split(' ');
    const bet = parseInt(args[args.length - 1]) || 0; // ставка необязательна

    if (!opponent || opponent.bot || opponent.id === message.author.id) {
        message.reply('Напиши так: `!ttt @человек` (без ставки) или `!ttt @человек 100` (на фишки)');
        return;
    }

    if (bet > 0) {
        const challengerBalance = getBalance(message.author.id);
        const opponentBalance = getBalance(opponent.id);

        if (bet > challengerBalance) {
            message.reply(`У тебя недостаточно фишек! Баланс: ${challengerBalance} 🪙`);
            return;
        }
        if (bet > opponentBalance) {
            message.reply(`У ${opponent} недостаточно фишек для такой ставки`);
            return;
        }
    }

            // ---- Подтверждение участия (чтобы нельзя было красть очки у афк) ----
    const challengeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ttt_accept').setLabel('Принять').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ttt_decline').setLabel('Отклонить').setStyle(ButtonStyle.Danger)
    );

    const challengeMsg = await message.reply({
        content: `⚔️ ${message.author} вызывает ${opponent} на крестики-нолики${bet > 0 ? ` на ставку ${bet} 🪙` : ''}!`,
        components: [challengeRow]
    });

    try {
        const confirmation = await challengeMsg.awaitMessageComponent({
            componentType: ComponentType.Button,
            time: 30000,
            filter: (i) => i.user.id === opponent.id
        });

        if (confirmation.customId === 'ttt_decline') {
            await confirmation.update({ content: `${opponent} отклонил вызов 🏳️`, components: [] });
            return;
        }

        await confirmation.update({ content: `✅ Вызов принят! Начинаем игру...`, components: [] });
    } catch (e) {
        await challengeMsg.edit({ content: '⏱️ Вызов не был принят вовремя', components: [] }).catch(() => {});
        return;
    }

        const players = [message.author, opponent];
        const symbols = ['❌', '⭕'];
        let board = Array(9).fill(null);
        let turn = 0;

        function buildTttRows(disabled) {
            const rows = [];
            for (let start = 0; start < 9; start += 3) {
                const row = new ActionRowBuilder();
                for (let i = start; i < start + 3; i++) {
                    row.addComponents(
                        new ButtonBuilder()
                            .setCustomId('ttt_' + i)
                            .setLabel(board[i] || '\u200b')
                            .setStyle(board[i] === '❌' ? ButtonStyle.Danger : board[i] === '⭕' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                            .setDisabled(disabled || !!board[i])
                    );
                }
                rows.push(row);
            }
            return rows;
        }

        function checkTttWin() {
            const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
            for (const [a, b, c] of lines) {
                if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];
            }
            if (board.every(cell => cell)) return 'draw';
            return null;
        }

        const gameMsg = await message.reply({
            content: `❌ ${players[0]} vs ⭕ ${players[1]} — ходит ${players[0]}`,
            components: buildTttRows(false)
        });

        const collector = gameMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

let turnTimer = null;

function startTurnTimer() {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(async () => {
        collector.stop('timeout_move');

        const winner = players[1 - turn];
        const loser = players[turn];
        let resultText = `⏱️ ${loser} не сходил за 30 секунд — поражение! Победил ${winner}.`;

        if (bet > 0) {
            setBalance(winner.id, getBalance(winner.id) + bet);
            setBalance(loser.id, getBalance(loser.id) - bet);
            resultText += ` Забирает ${bet} 🪙. Баланс: ${getBalance(winner.id)} 🪙`;
        }

        await gameMsg.edit({ content: resultText, components: buildTttRows(true) }).catch(() => {});
    }, 30000);
}

startTurnTimer(); // запускаем таймер на самый первый ход

        collector.on('collect', async (interaction) => {
            if (interaction.user.id !== players[turn].id) {
                await interaction.reply({ content: 'Сейчас не твой ход!', ephemeral: true });
                return;
            }

            const idx = parseInt(interaction.customId.split('_')[1]);
            if (board[idx]) return;

            board[idx] = symbols[turn];
            const result = checkTttWin();

            if (result) {
    collector.stop();
    clearTimeout(turnTimer);
    let resultText;
    if (result === 'draw') {
        resultText = '🤝 Ничья!' + (bet > 0 ? ' Ставки возвращены, фишки не потеряны.' : '');
    } else {
        const winner = result === '❌' ? players[0] : players[1];
        const loser = result === '❌' ? players[1] : players[0];
        resultText = `🎉 Победил ${winner}!`;
        if (bet > 0) {
            setBalance(winner.id, getBalance(winner.id) + bet);
            setBalance(loser.id, getBalance(loser.id) - bet);
            resultText += ` Забирает ${bet} 🪙 у ${loser}. Баланс: ${getBalance(winner.id)} 🪙`;
        }
    }
    await interaction.update({ content: resultText, components: buildTttRows(true) });
    return;
}
            turn = 1 - turn;
            startTurnTimer();
            await interaction.update({
                content: `❌ ${players[0]} vs ⭕ ${players[1]} — ходит ${players[turn]}`,
                components: buildTttRows(false)
            });
        });
        collector.on('end', (collected, reason) => {
    clearTimeout(turnTimer);
    if (reason === 'time') {
        gameMsg.edit({ content: '⏱️ Общее время игры вышло, игра отменена', components: [] }).catch(() => {});
    }
});
        return;
    }

    // ---- !battleship @соперник (морской бой, упрощённый) ----
    if (message.content.startsWith('!battleship')) {
        const opponent = message.mentions.users.first();
        if (!opponent || opponent.bot || opponent.id === message.author.id) {
            message.reply('Упомяни соперника: `!battleship @человек`');
            return;
        }

        const SIZE = 5;
        const SHIPS_COUNT = 3;

        function generateShips() {
            const ships = new Set();
            while (ships.size < SHIPS_COUNT) {
                ships.add(Math.floor(Math.random() * SIZE * SIZE));
            }
            return ships;
        }

        const players = [message.author, opponent];
        const ships = { [players[0].id]: generateShips(), [players[1].id]: generateShips() };
        const hits = { [players[0].id]: new Set(), [players[1].id]: new Set() };
        let turn = 0;

        function buildBsBoard(attackerId, disabled) {
            const opponentId = players.find(p => p.id !== attackerId).id;
            const rows = [];
            for (let r = 0; r < SIZE; r++) {
                const row = new ActionRowBuilder();
                for (let c = 0; c < SIZE; c++) {
                    const idx = r * SIZE + c;
                    const wasHit = hits[attackerId].has(idx);
                    let style = ButtonStyle.Secondary;
                    let label = '\u200b';
                    if (wasHit) {
                        const isShip = ships[opponentId].has(idx);
                        style = isShip ? ButtonStyle.Danger : ButtonStyle.Primary;
                        label = isShip ? '💥' : '🌊';
                    }
                    row.addComponents(
                        new ButtonBuilder()
                            .setCustomId('bs_' + idx)
                            .setLabel(label)
                            .setStyle(style)
                            .setDisabled(disabled || wasHit)
                    );
                }
                rows.push(row);
            }
            return rows;
        }

        const gameMsg = await message.reply({
            content: `🚢 ${players[0]} vs ${players[1]} — ходит ${players[0]}. У каждого спрятано ${SHIPS_COUNT} корабля на поле ${SIZE}x${SIZE}.`,
            components: buildBsBoard(players[0].id, false)
        });

        const collector = gameMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });

        collector.on('collect', async (interaction) => {
            const attacker = players[turn];
            if (interaction.user.id !== attacker.id) {
                await interaction.reply({ content: 'Сейчас не твой ход!', ephemeral: true });
                return;
            }

            const idx = parseInt(interaction.customId.split('_')[1]);
            if (hits[attacker.id].has(idx)) return;

            hits[attacker.id].add(idx);
            const opponentPlayer = players.find(p => p.id !== attacker.id);
            const isHitShip = ships[opponentPlayer.id].has(idx);
            const allSunk = [...ships[opponentPlayer.id]].every(shipIdx => hits[attacker.id].has(shipIdx));

            if (allSunk) {
                collector.stop();
                await interaction.update({
                    content: `🎉 ${attacker} потопил все корабли и победил!`,
                    components: buildBsBoard(attacker.id, true)
                });
                return;
            }

            turn = 1 - turn;
            await interaction.update({
                content: `${isHitShip ? '💥 Попадание!' : '🌊 Мимо!'} Теперь ходит ${players[turn]}.`,
                components: buildBsBoard(players[turn].id, false)
            });
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time') {
                gameMsg.edit({ content: '⏱️ Время вышло, игра отменена', components: [] }).catch(() => {});
            }
        });
        return;
    }

    // ---- !casino <ставка> ----

        // ---- !casino bonus <ставка> (бонус-бай) ----
    const BONUS_BUY_COST_MULTIPLIER = 20; // цена входа = ставка × 20
    const BONUS_BUY_MIN_MULTIPLIER = 5;
    const BONUS_BUY_MAX_MULTIPLIER = 100;

    if (message.content.startsWith('!casino bonus')) {
        const args = message.content.split(' ');
        const bet = parseInt(args[2]);

        if (!bet || bet <= 0) {
            message.reply('Напиши так: `!casino bonus 100` (ставка фишками)');
            return;
        }

        const cost = bet * BONUS_BUY_COST_MULTIPLIER;
        const balance = getBalance(message.author.id);

        if (cost > balance) {
            message.reply(`Бонус-бай стоит ${cost} 🪙 (ставка × ${BONUS_BUY_COST_MULTIPLIER}). У тебя: ${balance} 🪙`);
            return;
        }

        setBalance(message.author.id, balance - cost);

        // Взвешенный рандом: чаще небольшой множитель, редко — джекпот
        const roll = Math.random();
        let multiplier;
        if (roll < 0.60) {
            multiplier = BONUS_BUY_MIN_MULTIPLIER + Math.random() * 5; // 5x-10x, часто
        } else if (roll < 0.90) {
            multiplier = 10 + Math.random() * 15; // 10x-25x
        } else {
            multiplier = 25 + Math.random() * (BONUS_BUY_MAX_MULTIPLIER - 25); // 25x-50x, редкий джекпот
        }

        const winnings = Math.floor(bet * multiplier);
        setBalance(message.author.id, getBalance(message.author.id) + winnings);

        const net = winnings - cost;
        const isProfit = net > 0;

        const gif = isProfit
            ? WIN_GIFS[Math.floor(Math.random() * WIN_GIFS.length)]
            : LOSE_GIFS[Math.floor(Math.random() * LOSE_GIFS.length)];

        const embed = new EmbedBuilder()
            .setColor(isProfit ? 0x00ff00 : 0xff0000)
            .setTitle('🎰💰 Бонус-бай')
            .setDescription(
                `Заплачено за вход: ${cost} 🪙\n` +
                `Выигрыш в бонусе: ${winnings} 🪙 (×${multiplier.toFixed(1)})\n\n` +
                `${isProfit ? '🎉 В плюсе на' : '😔 В минусе на'} ${Math.abs(net)} 🪙\n\n` +
                `Баланс: ${getBalance(message.author.id)} 🪙`
            )
            .setImage(gif);

        message.reply({ embeds: [embed] });
        return;
    }
    if (message.content.startsWith('!casino')) {
        const args = message.content.split(' ');
        const bet = parseInt(args[1]);

        if (!bet || bet <= 0) {
            message.reply('Напиши так: `!casino 100` (ставка фишками)');
            return;
        }

        const balance = getBalance(message.author.id);
        if (bet > balance) {
            message.reply(`Недостаточно фишек! У тебя: ${balance} 🪙`);
            return;
        }

        const houseEdgeRoll = Math.random();
let reels, winnings, resultText;

if (houseEdgeRoll < 0.65) {
    // Принудительный проигрыш — генерируем барабаны так, чтобы точно НЕ было совпадений
    do {
        reels = [
            SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
            SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
            SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]
        ];
    } while (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]); 
    {
    // 65% случаев — гарантированный проигрыш, как в реальном казино
    winnings = -bet;
    resultText = `😔 Проигрыш: ${bet} 🪙`;
} 
    } else {
    reels = [
        SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
        SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
        SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]
    ];

    if (reels[0] === reels[1] && reels[1] === reels[2]) {
        winnings = bet * 5;
        resultText = `🎉 ДЖЕКПОТ! Выигрыш: ${winnings} 🪙`;
    } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
        winnings = bet * 2;
        resultText = `✨ Две одинаковые! Выигрыш: ${winnings} 🪙`;
    } else {
        winnings = -bet;
        resultText = `😔 Проигрыш: ${bet} 🪙`;
    }
}





else if (reels[0] === reels[1] && reels[1] === reels[2]) 

        setBalance(message.author.id, balance + winnings);

        const isWin = winnings > 0;
        const gif = isWin
            ? WIN_GIFS[Math.floor(Math.random() * WIN_GIFS.length)]
            : LOSE_GIFS[Math.floor(Math.random() * LOSE_GIFS.length)];

        const embed = new EmbedBuilder()
            .setColor(isWin ? 0x00ff00 : 0xff0000)
            .setTitle('🎰 Казино')
            .setDescription(`[ ${reels.join(' | ')} ]\n\n${resultText}\n\nБаланс: ${getBalance(message.author.id)} 🪙`)
            .setImage(gif);

        message.reply({ embeds: [embed] });
        return;
    }
          // ---- !daily (ежедневный бонус) ----
    if (message.content === '!daily') {
        const userId = message.author.id;
        const now = Date.now();
        const DAY_MS = 24 * 60 * 60 * 1000;
        const DAILY_AMOUNT = 2000;

        if (!lastDaily[userId] || now - lastDaily[userId] >= DAY_MS) {
            lastDaily[userId] = now;
            saveLists();
            setBalance(userId, getBalance(userId) + DAILY_AMOUNT);
            message.reply(`🎁 Получено ${DAILY_AMOUNT} фишек! Баланс: ${getBalance(userId)} 🪙`);
        } else {
            const remaining = DAY_MS - (now - lastDaily[userId]);
            const hoursLeft = Math.ceil(remaining / (60 * 60 * 1000));
            message.reply(`⏳ Уже получал сегодня. Приходи через ~${hoursLeft} ч.`);
        }
        return;
    }


    // ---- !promo <код> ----
const PROMO_CODE = 'pidor'; // придумай свой секретный код, например '67лет'
const PROMO_AMOUNT = 6767;

if (message.content.startsWith('!promo')) {
    const args = message.content.split(' ');
    const enteredCode = args[1];

    if (!enteredCode) {
        message.reply('Напиши так: `!promo код`');
        return;
    }

    if (enteredCode !== PROMO_CODE) {
        message.reply('❌ Неверный промокод');
        return;
    }

    if (redeemedPromo.includes(message.author.id)) {
        message.reply('❌ Ты уже активировал этот промокод');
        return;
    }

    redeemedPromo.push(message.author.id);
    setBalance(message.author.id, getBalance(message.author.id) + PROMO_AMOUNT);
    saveLists();

    message.reply(`🎉 Промокод активирован! +${PROMO_AMOUNT} 🪙. Баланс: ${getBalance(message.author.id)} 🪙`);
    return;
} 

    if (message.content === '!shop') {
        if (shopItems.length === 0) {
            message.reply('Магазин пуст. Владелец бота может добавить роли через веб-панель.');
            return;
        }

        let text = '**🛒 Магазин ролей**\n\n';
        shopItems.forEach((item, i) => {
            text += `${i + 1}. **${item.roleName}** — ${item.price} 🪙\n`;
        });
        text += '\nКупить: `!buy <номер>`';

        message.reply(text);
        return;
    }

    // ---- !buy <номер> ----
    if (message.content.startsWith('!buy')) {
        const args = message.content.split(' ');
        const index = parseInt(args[1]) - 1;

        if (isNaN(index) || !shopItems[index]) {
            message.reply('Напиши так: `!buy 1` (номер товара из `!shop`)');
            return;
        }

        const item = shopItems[index];
        const balance = getBalance(message.author.id);

        if (item.price > balance) {
            message.reply(`Недостаточно фишек! Нужно: ${item.price} 🪙, у тебя: ${balance} 🪙`);
            return;
        }

        if (message.member.roles.cache.has(item.roleId)) {
            message.reply('У тебя уже есть эта роль!');
            return;
        }

        try {
            await message.member.roles.add(item.roleId);
            setBalance(message.author.id, balance - item.price);
            message.reply(`✅ Куплено: **${item.roleName}**! Баланс: ${getBalance(message.author.id)} 🪙`);
        } catch (error) {
            console.error('Ошибка выдачи роли:', error);
            message.reply('❌ Не получилось выдать роль. Проверь права бота (Manage Roles) и позицию его роли в списке ролей сервера.');
        }
        return;
    }

    // ---- !auction <номер товара> <стартовая цена> <минуты> ----
    if (message.content.startsWith('!auction')) {
        const args = message.content.split(' ');
        const index = parseInt(args[1]) - 1;
        const startPrice = parseInt(args[2]);
        const minutes = parseInt(args[3]);

        if (isNaN(index) || !shopItems[index] || !startPrice || !minutes) {
            message.reply('Напиши так: `!auction 1 500 5` (номер товара, стартовая цена, минуты)');
            return;
        }

        if (global.activeAuction) {
            message.reply('Уже идёт другой аукцион, дождись его окончания.');
            return;
        }

        const item = shopItems[index];

        global.activeAuction = {
            item,
            highestBid: startPrice,
            highestBidder: null,
            channelId: message.channel.id
        };

        message.reply(
            `🔨 **Аукцион!** Роль: **${item.roleName}**\n` +
            `Стартовая цена: ${startPrice} 🪙\n` +
            `Длительность: ${minutes} мин\n\n` +
            `Ставки: \`!bid <сумма>\``
        );

        setTimeout(async () => {
            const auction = global.activeAuction;
            global.activeAuction = null;

            if (!auction || !auction.highestBidder) {
                message.channel.send(`🔨 Аукцион на **${auction ? auction.item.roleName : '???'}** завершён — ставок не было.`);
                return;
            }

            const winnerBalance = getBalance(auction.highestBidder.id);
            if (winnerBalance < auction.highestBid) {
                message.channel.send(`🔨 Аукцион завершён, но у победителя не хватило фишек в итоге. Никто не получил роль.`);
                return;
            }

            try {
                await auction.highestBidder.roles.add(auction.item.roleId);
                setBalance(auction.highestBidder.id, winnerBalance - auction.highestBid);
                message.channel.send(
                    `🔨 **Аукцион завершён!** Победитель: ${auction.highestBidder} — забирает **${auction.item.roleName}** за ${auction.highestBid} 🪙`
                );
            } catch (error) {
                console.error('Ошибка выдачи роли по итогам аукциона:', error);
                message.channel.send('❌ Не получилось выдать роль победителю аукциона (проверь права бота).');
            }
        }, minutes * 60 * 1000);

        return;
    }

    // ---- !bid <сумма> ----
    if (message.content.startsWith('!bid')) {
        const args = message.content.split(' ');
        const amount = parseInt(args[1]);

        if (!global.activeAuction) {
            message.reply('Сейчас нет активного аукциона.');
            return;
        }

        if (!amount || amount <= global.activeAuction.highestBid) {
            message.reply(`Ставка должна быть больше текущей (${global.activeAuction.highestBid} 🪙)`);
            return;
        }

        if (amount > getBalance(message.author.id)) {
            message.reply(`Недостаточно фишек! У тебя: ${getBalance(message.author.id)} 🪙`);
            return;
        }

        global.activeAuction.highestBid = amount;
        global.activeAuction.highestBidder = message.member;

        message.reply(`💰 Новая ставка: ${amount} 🪙 от ${message.author}`);
        return;
    }










    // ---- !pay @человек <сумма> ----
if (message.content.startsWith('!pay')) {
    const target = message.mentions.users.first();
    const args = message.content.split(' ');
    const amount = parseInt(args[args.length - 1]);

    if (!target || target.bot || target.id === message.author.id) {
        message.reply('Напиши так: `!pay @человек 100`');
        return;
    }

    if (!amount || amount <= 0) {
        message.reply('Укажи сумму больше нуля: `!pay @человек 100`');
        return;
    }

    const senderBalance = getBalance(message.author.id);
    if (amount > senderBalance) {
        message.reply(`Недостаточно фишек! У тебя: ${senderBalance} 🪙`);
        return;
    }

    setBalance(message.author.id, senderBalance - amount);
    setBalance(target.id, getBalance(target.id) + amount);

    message.reply(`💸 Переведено ${amount} 🪙 пользователю ${target}. Твой баланс: ${getBalance(message.author.id)} 🪙`);
    return;
}



    // ---- !duel @соперник <ставка> ----
if (message.content.startsWith('!duel')) {
    const opponent = message.mentions.users.first();
    const args = message.content.split(' ');
    const bet = parseInt(args[args.length - 1]);

    if (!opponent || opponent.bot || opponent.id === message.author.id) {
        message.reply('Напиши так: `!duel @человек 100`');
        return;
    }

    if (!bet || bet <= 0) {
        message.reply('Укажи ставку больше нуля: `!duel @человек 100`');
        return;
    }

    const challengerBalance = getBalance(message.author.id);
    const opponentBalance = getBalance(opponent.id);

    if (bet > challengerBalance) {
        message.reply(`У тебя недостаточно фишек! Баланс: ${challengerBalance} 🪙`);
        return;
    }
    if (bet > opponentBalance) {
        message.reply(`У ${opponent} недостаточно фишек для такой ставки`);
        return;
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('duel_accept').setLabel('Принять вызов').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('duel_decline').setLabel('Отклонить').setStyle(ButtonStyle.Danger)
    );

    const duelMsg = await message.reply({
        content: `⚔️ ${message.author} вызывает ${opponent} на дуэль! Ставка: ${bet} 🪙 (победитель забирает всё)`,
        components: [row]
    });

    const collector = duelMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

    collector.on('collect', async (interaction) => {
        if (interaction.user.id !== opponent.id) {
            await interaction.reply({ content: 'Это не твой вызов!', ephemeral: true });
            return;
        }

        collector.stop();

        if (interaction.customId === 'duel_decline') {
            await interaction.update({ content: `${opponent} отказался от дуэли 🏳️`, components: [] });
            return;
        }

        // Финальная проверка баланса на случай, если кто-то потратил фишки за время ожидания
        if (getBalance(message.author.id) < bet || getBalance(opponent.id) < bet) {
            await interaction.update({ content: 'У кого-то из вас не хватает фишек прямо сейчас 😕', components: [] });
            return;
        }

        const winner = Math.random() < 0.5 ? message.author : opponent;
        const loser = winner.id === message.author.id ? opponent : message.author;

        setBalance(winner.id, getBalance(winner.id) + bet);
        setBalance(loser.id, getBalance(loser.id) - bet);

        await interaction.update({
            content: `⚔️ Дуэль окончена! 🏆 Победил ${winner} и забирает ${bet} 🪙 у ${loser}.\n` +
                      `Баланс ${winner}: ${getBalance(winner.id)} 🪙`,
            components: []
        });
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time') {
            duelMsg.edit({ content: '⏱️ Дуэль отменена — соперник не ответил', components: [] }).catch(() => {});
        }
    });
    return;
}




    

    // ---- !blackjack <ставка> ----
    if (message.content.startsWith('!blackjack')) {
        const args = message.content.split(' ');
        const bet = parseInt(args[1]);

        if (!bet || bet <= 0) {
            message.reply('Напиши так: `!blackjack 100` (ставка фишками)');
            return;
        }

        const balance = getBalance(message.author.id);
        if (bet > balance) {
            message.reply(`Недостаточно фишек! У тебя: ${balance} 🪙`);
            return;
        }

        let playerHand = [drawCard(), drawCard()];
        let dealerHand = [drawCard(), drawCard()];

        function buildBjEmbed(reveal, extra) {
            return new EmbedBuilder()
                .setColor(0x2b2d31)
                .setTitle('🃏 Блэкджек')
                .setDescription(
                    `**Твои карты:** ${formatHand(playerHand)} (${handValue(playerHand)})\n` +
                    `**Карты дилера:** ${reveal ? formatHand(dealerHand) + ' (' + handValue(dealerHand) + ')' : formatHand([dealerHand[0]]) + ' 🂠'}\n\n` +
                    `Ставка: ${bet} 🪙` + (extra ? `\n\n${extra}` : '')
                );
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('bj_hit').setLabel('Взять карту').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('bj_stand').setLabel('Хватит').setStyle(ButtonStyle.Secondary)
        );

        const gameMsg = await message.reply({ embeds: [buildBjEmbed(false)], components: [row] });

        const collector = gameMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

        async function endBjGame(interaction, resultText, winnings) {
            setBalance(message.author.id, getBalance(message.author.id) + winnings);
            await interaction.update({
                embeds: [buildBjEmbed(true, `${resultText}\nБаланс: ${getBalance(message.author.id)} 🪙`)],
                components: []
            });
        }

        collector.on('collect', async (interaction) => {
            if (interaction.user.id !== message.author.id) {
                await interaction.reply({ content: 'Это не твоя игра!', ephemeral: true });
                return;
            }

            if (interaction.customId === 'bj_hit') {
                playerHand.push(drawCard());
                const value = handValue(playerHand);
                if (value > 21) {
                    collector.stop();
                    await endBjGame(interaction, '💥 Перебор! Ты проиграл.', -bet);
                    return;
                }
                await interaction.update({ embeds: [buildBjEmbed(false)], components: [row] });
            }

            if (interaction.customId === 'bj_stand') {
                collector.stop();
                while (handValue(dealerHand) < 17) {
                    dealerHand.push(drawCard());
                }
                const playerVal = handValue(playerHand);
                const dealerVal = handValue(dealerHand);

                let resultText, winnings;
                if (dealerVal > 21 || playerVal > dealerVal) {
                    resultText = '🎉 Ты выиграл!';
                    winnings = bet;
                } else if (playerVal === dealerVal) {
                    resultText = '🤝 Ничья, ставка возвращена';
                    winnings = 0;
                } else {
                    resultText = '😔 Дилер выиграл';
                    winnings = -bet;
                }
                await endBjGame(interaction, resultText, winnings);
            }
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time') {
                gameMsg.edit({ components: [] }).catch(() => {});
            }
        });
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

function renderListItem(listName, entry) {
    const displayName = entry.tag || ('Неизвестный (' + entry.id + ')');
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;font-size:13px;background:#0f1115;border-radius:8px;margin-bottom:6px;">' +
        '<div><div style="font-weight:600;">' + displayName + '</div><div style="color:#6b7280;font-size:11px;">' + entry.id + '</div></div>' +
        '<button class="danger" onclick="removeFromList(' + "'" + listName + "'" + ',' + "'" + entry.id + "'" + ')">Удалить</button>' +
        '</div>';
}

async function addToList(listName) {
    const inputId = listName + 'Input';
    const input = document.getElementById(inputId);
    const id = input.value.trim();
    if (!id) return;

    const button = event.target;
    button.disabled = true;
    button.textContent = 'Добавляю...';

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
        input.value = '';
        await loadLists();
    } catch (err) {
        alert('Ошибка сети: ' + err.message);
    } finally {
        button.disabled = false;
        button.textContent = 'Добавить';
    }
}

async function removeFromList(listName, id) {
    await fetch('/api/' + listName + '/' + id, { method: 'DELETE' });
    loadLists();
}

async function loadLists() {
    const res = await fetch('/api/lists');
    const data = await res.json();

    document.getElementById('blacklistItems').innerHTML =
        data.blacklist.map(entry => renderListItem('blacklist', entry)).join('') ||
        '<span style="color:#6b7280;font-size:13px;">Список пуст</span>';

    document.getElementById('whitelistItems').innerHTML =
        data.whitelist.map(entry => renderListItem('whitelist', entry)).join('') ||
        '<span style="color:#6b7280;font-size:13px;">Список пуст</span>';
}

async function addShopItem() {
    const roleId = document.getElementById('shopRoleIdInput').value.trim();
    const roleName = document.getElementById('shopRoleNameInput').value.trim();
    const price = parseInt(document.getElementById('shopPriceInput').value);

    if (!roleId || !roleName || !price) {
        alert('Заполни все поля');
        return;
    }

    await fetch('/api/shop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId, roleName, price })
    });

    document.getElementById('shopRoleIdInput').value = '';
    document.getElementById('shopRoleNameInput').value = '';
    document.getElementById('shopPriceInput').value = '';
    loadShopItems();
}

async function removeShopItem(index) {
    await fetch('/api/shop/' + index, { method: 'DELETE' });
    loadShopItems();
}

async function loadShopItems() {
    const res = await fetch('/api/shop');
    const data = await res.json();

    document.getElementById('shopItems').innerHTML = data.map((item, i) =>
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;font-size:13px;background:#0f1115;border-radius:8px;margin-bottom:6px;">' +
        '<div><div style="font-weight:600;">' + item.roleName + '</div><div style="color:#6b7280;font-size:11px;">' + item.price + ' 🪙 — ID: ' + item.roleId + '</div></div>' +
        '<button class="danger" onclick="removeShopItem(' + i + ')">Удалить</button>' +
        '</div>'
    ).join('') || '<span style="color:#6b7280;font-size:13px;">Магазин пуст</span>';
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
app.get('/api/shop', (req, res) => {
    res.json(shopItems);
});

app.post('/api/shop', (req, res) => {
    const { roleId, roleName, price } = req.body;
    if (!roleId || !roleName || !price) return res.status(400).json({ error: 'missing fields' });
    shopItems.push({ roleId, roleName, price });
    saveLists();
    res.json({ ok: true });
});

app.delete('/api/shop/:index', (req, res) => {
    const index = parseInt(req.params.index);
    shopItems.splice(index, 1);
    saveLists();
    res.json({ ok: true });
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
// Достаёт никнейм пользователя по ID (если не получилось — вернёт сам ID)
async function resolveUserTag(id) {
    try {
        const user = await client.users.fetch(id);
        return user.tag;
    } catch (e) {
        return null;
    }
}

app.get('/api/lists', async (req, res) => {
    const blacklistResolved = await Promise.all(
        blacklist.map(async (id) => ({ id, tag: await resolveUserTag(id) }))
    );
    const whitelistResolved = await Promise.all(
        whitelist.map(async (id) => ({ id, tag: await resolveUserTag(id) }))
    );
    res.json({ blacklist: blacklistResolved, whitelist: whitelistResolved });
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
 
<div class="card">
    <h3 style="margin-top:0">🛒 Магазин ролей</h3>
    <input type="text" id="shopRoleIdInput" placeholder="ID роли Discord">
    <input type="text" id="shopRoleNameInput" placeholder="Название (для отображения)">
    <input type="text" id="shopPriceInput" placeholder="Цена в фишках">
    <button onclick="addShopItem()">Добавить товар</button>
    <div id="shopItems"></div>
</div>



app.listen(PANEL_PORT, '127.0.0.1', () => {
    console.log(`🖥️ Панель управления запущена на порту ${PANEL_PORT} (только localhost)`);
});
