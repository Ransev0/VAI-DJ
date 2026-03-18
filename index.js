require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
} = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType,
} = require('@discordjs/voice');
const play = require('play-dl');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// ── Constants ────────────────────────────────────────────────────────────────

const RECONNECT_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS   = 30_000;
const MAX_QUEUE_DISPLAY    = 10;
const MAX_PLAYLIST_SONGS   = 50;

// ── Env validation ───────────────────────────────────────────────────────────

const { TOKEN, CLIENT_ID, GUILD_ID, PROXY_URL } = process.env;
const YTDLP_BIN     = process.env.YTDLP_PATH    || 'yt-dlp';
const YTDLP_COOKIES = process.env.YTDLP_COOKIES || null;

// Build common yt-dlp base args (proxy + cookies when configured)
function ytdlpBaseArgs() {
    const args = [];
    if (PROXY_URL)     args.push('--proxy',   PROXY_URL);
    if (YTDLP_COOKIES) args.push('--cookies', YTDLP_COOKIES);
    return args;
}

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error('Erro: TOKEN, CLIENT_ID e GUILD_ID devem estar configurados no .env');
    process.exit(1);
}

if (PROXY_URL) console.log(`[proxy] Usando proxy: ${PROXY_URL.replace(/:([^:@]+)@/, ':***@')}`);

// ── Guild state ──────────────────────────────────────────────────────────────
// Map<guildId, { connection, player, queue: Song[], current: Song|null, textChannel }>

const guilds = new Map();

// ── Voice helpers ────────────────────────────────────────────────────────────

async function connectToVoice(guild, voiceChannel, textChannel) {
    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
    });

    const player = createAudioPlayer();

    player.on(AudioPlayerStatus.Idle, () => playNext(guild.id));

    player.on('error', (error) => {
        console.error(`[${guild.id}] Erro no player:`, error.message);
        const state = guilds.get(guild.id);
        if (state?.current) {
            state.textChannel.send(`Erro ao tocar **${state.current.title}**. Pulando...`).catch(() => {});
        }
        playNext(guild.id);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_TIMEOUT_MS),
                entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_TIMEOUT_MS),
            ]);
        } catch {
            destroyGuild(guild.id);
        }
    });

    connection.subscribe(player);
    await entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);

    guilds.set(guild.id, { connection, player, queue: [], current: null, textChannel });
}

function destroyGuild(guildId) {
    const state = guilds.get(guildId);
    if (!state) return;
    state.player.stop(true);
    state.connection.destroy();
    guilds.delete(guildId);
}

async function playNext(guildId) {
    const state = guilds.get(guildId);
    if (!state) return;

    state.current = null;

    if (state.queue.length === 0) {
        state.textChannel.send('Fila vazia! Use `/play` para adicionar músicas.').catch(() => {});
        return;
    }

    const song = state.queue.shift();
    state.current = song;

    try {
        const source   = await getAudioStream(song.url);
        const resource = createAudioResource(source.stream, { inputType: source.type });
        state.player.play(resource);

        const embed = new EmbedBuilder()
            .setTitle('Tocando Agora')
            .setDescription(`**${song.title}**`)
            .addFields(
                { name: 'Solicitado por', value: song.requestedBy, inline: true },
                { name: 'Na fila',        value: `${state.queue.length}`,       inline: true },
            )
            .setColor(0x00ff00);

        if (song.thumbnail) embed.setThumbnail(song.thumbnail);

        state.textChannel.send({ embeds: [embed] }).catch(() => {});
    } catch (error) {
        console.error(`[${guildId}] Erro ao tocar "${song.title}":`, error.message);
        state.textChannel.send(`Não foi possível tocar **${song.title}**. Pulando...`).catch(() => {});
        state.current = null;
        playNext(guildId);
    }
}

// ── Audio stream via yt-dlp + ffmpeg ─────────────────────────────────────────

function getAudioStream(url) {
    // Pipe yt-dlp download directly into ffmpeg to avoid URL expiry issues
    const ytdlpArgs = [
        '-f', 'bestaudio/best',
        '--no-playlist',
        '-o', '-',
        ...ytdlpBaseArgs(),
        url,
    ];

    const ytdlp = spawn(YTDLP_BIN, ytdlpArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
    ytdlp.on('error', () => {}); // ENOENT treated downstream via ffmpeg closing

    const ffmpeg = spawn(ffmpegPath, [
        '-i', 'pipe:0',
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    const cleanup = () => {
        ytdlp.stdout.unpipe();
        if (!ytdlp.killed)  ytdlp.kill('SIGKILL');
        if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
    };

    // Suppress EPIPE/errors on both sides — they are expected on skip/stop
    ytdlp.stdout.on('error', () => {});
    ffmpeg.stdin.on('error',  () => {});
    ffmpeg.stdout.on('error', () => {});

    ytdlp.stdout.pipe(ffmpeg.stdin);

    ytdlp.on('close', (code) => {
        if (code !== 0) ffmpeg.stdin.destroy();
    });

    // When the consumer (discord player) stops reading, clean up child processes
    ffmpeg.stdout.on('close', cleanup);

    return { stream: ffmpeg.stdout, type: StreamType.Raw };
}

// ── URL / search resolution ───────────────────────────────────────────────────

// Extract playlist/mix videos via yt-dlp (handles regular playlists and RD mixes)
function fetchPlaylistVideos(url) {
    return new Promise((resolve, reject) => {
        const ytdlpArgs = [
            '--flat-playlist', '--dump-json', '--no-warnings',
            '--playlist-end', String(MAX_PLAYLIST_SONGS),
            ...ytdlpBaseArgs(),
            url,
        ];

        const ytdlp = spawn(YTDLP_BIN, ytdlpArgs, { stdio: ['ignore', 'pipe', 'ignore'] });        ytdlp.on('error', (err) => reject(new Error(`yt-dlp não encontrado: ${err.message}`)));
        let buf = '';
        ytdlp.stdout.on('data', d => { buf += d; });
        ytdlp.on('close', (code) => {
            if (!buf && code !== 0) return reject(new Error('yt-dlp não conseguiu carregar a playlist.'));
            const videos = buf.trim().split('\n').filter(Boolean).map(line => {
                try {
                    const j = JSON.parse(line);
                    return {
                        url:       `https://www.youtube.com/watch?v=${j.id}`,
                        title:     j.title ?? j.id,
                        thumbnail: j.thumbnails?.[0]?.url ?? null,
                    };
                } catch { return null; }
            }).filter(Boolean);
            resolve(videos);
        });
    });
}

async function resolve(input) {
    if (!input) throw new Error('Nenhuma entrada fornecida.');

    // Not a URL → search YouTube
    if (!input.startsWith('http')) {
        const results = await play.search(input, { source: { youtube: 'video' }, limit: 1 });
        if (!results.length) throw new Error(`Nenhum resultado para "${input}"`);
        const v = results[0];
        return { isPlaylist: false, url: v.url, title: v.title, thumbnail: v.thumbnails?.[0]?.url ?? null };
    }

    const hasListParam = /[?&]list=/.test(input);

    // URL has a playlist/mix list param → load as playlist via yt-dlp
    if (hasListParam) {
        const videos = await fetchPlaylistVideos(input);
        if (videos.length === 0) throw new Error('Playlist/mix sem vídeos acessíveis.');
        // Use the first video title as a fallback playlist name
        const listId = input.match(/list=([^&]+)/)?.[1] ?? 'Mix';
        const playlistTitle = listId.startsWith('RD') ? `Mix: ${videos[0].title}` : listId;
        return { isPlaylist: true, title: playlistTitle, videos };
    }

    // Single video URL
    const videoIdMatch = input.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (videoIdMatch) {
        const cleanUrl = `https://www.youtube.com/watch?v=${videoIdMatch[1]}`;
        const info = await play.video_info(cleanUrl);
        const d    = info.video_details;
        return { isPlaylist: false, url: d.url, title: d.title, thumbnail: d.thumbnails?.[0]?.url ?? null };
    }

    throw new Error('Apenas links do YouTube ou nomes de músicas são suportados.');
}

// ── Slash commands ────────────────────────────────────────────────────────────

const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Toca música do YouTube (URL ou nome)')
        .addStringOption(o =>
            o.setName('url').setDescription('URL ou nome da música').setRequired(true)),

    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Pula a música atual'),

    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Para a música e desconecta'),

    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pausa a música'),

    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Retoma a música'),

    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Mostra a fila de músicas'),

].map(c => c.toJSON());

// ── Client ────────────────────────────────────────────────────────────────────

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', async () => {
    console.log(`${client.user.tag} online!`);
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Comandos registrados.');
});

// ── Interaction handler ───────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, member, guild } = interaction;

    const needsVoice = ['play', 'skip', 'stop', 'pause', 'resume'];
    if (needsVoice.includes(commandName) && !member.voice.channel) {
        return interaction.reply({ content: 'Entre em um canal de voz primeiro!', ephemeral: true });
    }

    try {
        // ── /play ────────────────────────────────────────────────────────────
        if (commandName === 'play') {
            await interaction.deferReply();

            const input    = interaction.options.getString('url') ?? interaction.options.getString('musica');
            const resolved = await resolve(input);

            if (!guilds.has(guild.id)) {
                await connectToVoice(guild, member.voice.channel, interaction.channel);
            }

            const state = guilds.get(guild.id);

            if (resolved.isPlaylist) {
                const songs = resolved.videos.map(v => ({ ...v, requestedBy: member.user.tag }));
                state.queue.push(...songs);
                if (!state.current) playNext(guild.id);
                await interaction.editReply(`**${resolved.title}**\n${songs.length} músicas adicionadas à fila.`);
                return;
            }

            const song = { ...resolved, requestedBy: member.user.tag };
            state.queue.push(song);

            if (!state.current) {
                playNext(guild.id);
                await interaction.editReply(`A tocar **${song.title}**`);
            } else {
                const embed = new EmbedBuilder()
                    .setTitle('Adicionado à Fila')
                    .setDescription(`**${song.title}**`)
                    .addFields(
                        { name: 'Posição', value: `${state.queue.length}`, inline: true },
                        { name: 'Por',     value: member.user.tag,         inline: true },
                    )
                    .setColor(0x00aaff);
                if (song.thumbnail) embed.setThumbnail(song.thumbnail);
                await interaction.editReply({ embeds: [embed] });
            }
        }

        // ── /skip ────────────────────────────────────────────────────────────
        else if (commandName === 'skip') {
            const state = guilds.get(guild.id);
            if (!state?.current) {
                return interaction.reply({ content: 'Nenhuma música tocando.', ephemeral: true });
            }
            state.player.stop();
            await interaction.reply('Pulado!');
        }

        // ── /stop ────────────────────────────────────────────────────────────
        else if (commandName === 'stop') {
            if (!guilds.has(guild.id)) {
                return interaction.reply({ content: 'Bot não está conectado.', ephemeral: true });
            }
            const state = guilds.get(guild.id);
            state.queue   = [];
            state.current = null;
            destroyGuild(guild.id);
            await interaction.reply('Parado e desconectado.');
        }

        // ── /pause ───────────────────────────────────────────────────────────
        else if (commandName === 'pause') {
            const state = guilds.get(guild.id);
            if (!state?.current) {
                return interaction.reply({ content: 'Nada tocando.', ephemeral: true });
            }
            state.player.pause();
            await interaction.reply('Pausado.');
        }

        // ── /resume ──────────────────────────────────────────────────────────
        else if (commandName === 'resume') {
            const state = guilds.get(guild.id);
            if (!state) {
                return interaction.reply({ content: 'Bot não está conectado.', ephemeral: true });
            }
            state.player.unpause();
            await interaction.reply('Retomado!');
        }

        // ── /queue ───────────────────────────────────────────────────────────
        else if (commandName === 'queue') {
            const state = guilds.get(guild.id);
            if (!state?.current && !state?.queue.length) {
                return interaction.reply({ content: 'Fila vazia!', ephemeral: true });
            }

            let description = '';
            if (state.current) description += `**Tocando:**\n${state.current.title}\n\n`;

            if (state.queue.length > 0) {
                description += `**Próximas:**\n`;
                description += state.queue
                    .slice(0, MAX_QUEUE_DISPLAY)
                    .map((s, i) => `${i + 1}. ${s.title}`)
                    .join('\n');
                if (state.queue.length > MAX_QUEUE_DISPLAY) {
                    description += `\n... e mais ${state.queue.length - MAX_QUEUE_DISPLAY}`;
                }
            }

            const total = (state.current ? 1 : 0) + state.queue.length;
            const embed = new EmbedBuilder()
                .setTitle('Fila de Músicas')
                .setDescription(description)
                .setFooter({ text: `${total} música(s) no total` })
                .setColor(0x00ff00);

            await interaction.reply({ embeds: [embed] });
        }

    } catch (error) {
        console.error(`[/${commandName}]`, error.message);
        const msg = `Erro: ${error.message}`;
        if (interaction.deferred) {
            await interaction.editReply(msg).catch(() => {});
        } else {
            await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        }
    }
});

// ── Detect manual disconnect from voice ──────────────────────────────────────

client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.member?.id !== client.user.id) return;
    if (oldState.channel && !newState.channel) {
        destroyGuild(oldState.guild.id);
    }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
    for (const guildId of guilds.keys()) destroyGuild(guildId);
    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
