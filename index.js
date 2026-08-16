require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    ChannelType
} = require('discord.js');

const {
    joinVoiceChannel,
    VoiceConnectionStatus
} = require('@discordjs/voice');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const TOKEN = process.env.TOKEN;

let connection;

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

            // Бот будет глухим и без микрофона
            selfDeaf: true,
            selfMute: true
        });

        connection.on(VoiceConnectionStatus.Ready, () => {
            console.log(`✅ Бот находится в канале: ${channel.name}`);
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

    await joinVoice();
});

client.login(TOKEN);

// ==== Ответ на упоминание бота ====
const MENTION_REPLIES = [
    'я ебал твою мать',
    
];

client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    if (!message.mentions.has(client.user)) return;

    const reply = MENTION_REPLIES[Math.floor(Math.random() * MENTION_REPLIES.length)];
    message.reply(reply);
});
