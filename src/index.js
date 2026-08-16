const express = require("express");
const Database = require("better-sqlite3");

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");

const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 10000;

// 指定 Discord 频道
const CHANNEL_ID = "1538392351926394963";

if (!TOKEN) {
    console.error("缺少 TOKEN 环境变量");
    process.exit(1);
}

/* =========================
   Database
========================= */

const db = new Database("whitelist.db");

db.exec(`
CREATE TABLE IF NOT EXISTS bindings (
    discord_id TEXT PRIMARY KEY,
    roblox_id TEXT UNIQUE NOT NULL,
    roblox_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blacklist (
    roblox_id TEXT PRIMARY KEY,
    roblox_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS panel (
    guild_id TEXT PRIMARY KEY,
    message_id TEXT
);
`);

/* =========================
   Discord
========================= */

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

/* =========================
   Slash Commands
========================= */

const commands = [

    new SlashCommandBuilder()
        .setName("bind")
        .setDescription("绑定 Roblox 账号")
        .addStringOption(option =>
            option
                .setName("username")
                .setDescription("Roblox 用户名")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("unbind")
        .setDescription("解除 Roblox 绑定")

].map(command => command.toJSON());

/* =========================
   Roblox API
========================= */

async function getRobloxUser(username) {

    const response = await fetch(
        "https://users.roblox.com/v1/usernames/users",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                usernames: [username],
                excludeBannedUsers: false
            })
        }
    );

    if (!response.ok) {
        throw new Error("Roblox API 错误");
    }

    const data = await response.json();

    if (!data.data || !data.data[0]) {
        return null;
    }

    return data.data[0];
}

/* =========================
   权限
========================= */

function isServerOwner(interaction) {

    if (!interaction.guild) {
        return false;
    }

    return interaction.guild.ownerId === interaction.user.id;
}

/* =========================
   查询
========================= */

function getWhitelist() {

    return db.prepare(`
        SELECT roblox_id, roblox_name
        FROM bindings
        ORDER BY roblox_name COLLATE NOCASE
    `).all();
}

function getBinding(robloxId) {

    return db.prepare(`
        SELECT *
        FROM bindings
        WHERE roblox_id = ?
    `).get(String(robloxId));
}

function isBlacklisted(robloxId) {

    return !!db.prepare(`
        SELECT roblox_id
        FROM blacklist
        WHERE roblox_id = ?
    `).get(String(robloxId));
}

/* =========================
   白名单面板
========================= */

function createPanelEmbed() {

    const players = getWhitelist();

    let text = "";

    if (players.length === 0) {

        text = "暂无白名单用户";

    } else {

        text = players
            .map((player, index) =>
                `**${index + 1}.** ${player.roblox_name}`
            )
            .join("\n");
    }

    return new EmbedBuilder()
        .setTitle("📋 白名单 White List")
        .setDescription(text)
        .addFields({
            name: "当前白名单用户",
            value: String(players.length),
            inline: true
        })
        .setFooter({
            text: "只有社区 Owner 可以管理白名单"
        })
        .setTimestamp();
}

function createPanelButtons() {

    return [

        new ActionRowBuilder().addComponents(

            new ButtonBuilder()
                .setCustomId("whitelist_players")
                .setLabel("玩家名单")
                .setEmoji("👥")
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId("whitelist_add")
                .setLabel("添加白名单")
                .setEmoji("➕")
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId("whitelist_manage")
                .setLabel("管理玩家")
                .setEmoji("⚙️")
                .setStyle(ButtonStyle.Secondary)

        )

    ];
}

/* =========================
   更新面板
========================= */

async function updatePanel(guild) {

    const channel = await guild.channels
        .fetch(CHANNEL_ID)
        .catch(() => null);

    if (!channel || !channel.isTextBased()) {
        return;
    }

    const saved = db.prepare(`
        SELECT message_id
        FROM panel
        WHERE guild_id = ?
    `).get(guild.id);

    let message = null;

    if (saved) {

        message = await channel.messages
            .fetch(saved.message_id)
            .catch(() => null);
    }

    if (!message) {

        const messages = await channel.messages
            .fetch({ limit: 50 })
            .catch(() => null);

        if (messages) {

            message = messages.find(
                msg =>
                    msg.author.id === client.user.id &&
                    msg.embeds.length &&
                    msg.embeds[0].title === "📋 白名单 White List"
            );
        }
    }

    if (message) {

        await message.edit({
            embeds: [createPanelEmbed()],
            components: createPanelButtons()
        });

    } else {

        message = await channel.send({
            embeds: [createPanelEmbed()],
            components: createPanelButtons()
        });
    }

    db.prepare(`
        INSERT OR REPLACE INTO panel
        (guild_id, message_id)
        VALUES (?, ?)
    `).run(guild.id, message.id);
}

/* =========================
   Bot Ready
========================= */

client.once("ready", async () => {

    console.log(`Bot 已上线：${client.user.tag}`);

    const rest = new REST({
        version: "10"
    }).setToken(TOKEN);

    for (const guild of client.guilds.cache.values()) {

        await rest.put(
            Routes.applicationGuildCommands(
                client.user.id,
                guild.id
            ),
            {
                body: commands
            }
        );

        await updatePanel(guild);
    }
});

/* =========================
   新服务器
========================= */

client.on("guildCreate", async guild => {

    const rest = new REST({
        version: "10"
    }).setToken(TOKEN);

    await rest.put(
        Routes.applicationGuildCommands(
            client.user.id,
            guild.id
        ),
        {
            body: commands
        }
    );

    await updatePanel(guild);
});

/* =========================
   指定频道删除普通消息
========================= */

client.on("messageCreate", async message => {

    if (message.author.bot) {
        return;
    }

    if (message.channel.id === CHANNEL_ID) {

        await message.delete().catch(() => {});
    }
});

/* =========================
   Interaction
========================= */

client.on("interactionCreate", async interaction => {

    try {

        /* =====================
           Slash Commands
        ===================== */

        if (interaction.isChatInputCommand()) {

            if (interaction.channelId !== CHANNEL_ID) {

                return interaction.reply({
                    content: "❌ 请在指定白名单频道使用此指令。",
                    ephemeral: true
                });
            }

            /* ========= /bind ========= */

            if (interaction.commandName === "bind") {

                const username =
                    interaction.options
                        .getString("username")
                        .trim();

                const alreadyBound = db.prepare(`
                    SELECT *
                    FROM bindings
                    WHERE discord_id = ?
                `).get(interaction.user.id);

                if (alreadyBound) {

                    return interaction.reply({
                        content:
                            `你已经绑定了 **${alreadyBound.roblox_name}**。\n` +
                            `请先使用 \`/unbind\`。`,
                        ephemeral: true
                    });
                }

                const robloxUser =
                    await getRobloxUser(username);

                if (!robloxUser) {

                    return interaction.reply({
                        content: "❌ 找不到这个 Roblox 用户。",
                        ephemeral: true
                    });
                }

                if (isBlacklisted(robloxUser.id)) {

                    return interaction.reply({
                        content:
                            "🚫 这个 Roblox 账号已经被永久禁止加入，无法绑定。",
                        ephemeral: true
                    });
                }

                const robloxAlreadyBound =
                    getBinding(robloxUser.id);

                if (robloxAlreadyBound) {

                    return interaction.reply({
                        content:
                            "❌ 这个 Roblox 账号已经绑定其他 Discord 账号。",
                        ephemeral: true
                    });
                }

                db.prepare(`
                    INSERT INTO bindings
                    (
                        discord_id,
                        roblox_id,
                        roblox_name,
                        created_at
                    )
                    VALUES (?, ?, ?, ?)
                `).run(
                    interaction.user.id,
                    String(robloxUser.id),
                    robloxUser.name,
                    Date.now()
                );

                await interaction.reply({
                    content:
                        `✅ 绑定成功！\n\n` +
                        `Roblox：**${robloxUser.name}**`,
                    ephemeral: true
                });

                for (const guild of client.guilds.cache.values()) {
                    await updatePanel(guild);
                }

                return;
            }

            /* ========= /unbind ========= */

            if (interaction.commandName === "unbind") {

                const result = db.prepare(`
                    DELETE FROM bindings
                    WHERE discord_id = ?
                `).run(interaction.user.id);

                if (!result.changes) {

                    return interaction.reply({
                        content: "你目前没有绑定 Roblox。",
                        ephemeral: true
                    });
                }

                await interaction.reply({
                    content: "✅ 已解除 Roblox 绑定。",
                    ephemeral: true
                });

                for (const guild of client.guilds.cache.values()) {
                    await updatePanel(guild);
                }

                return;
            }
        }

        /* =====================
           白名单管理权限
        ===================== */

        if (
            interaction.isButton() ||
            interaction.isStringSelectMenu() ||
            interaction.isModalSubmit()
        ) {

            if (interaction.channelId !== CHANNEL_ID) {

                return interaction.reply({
                    content: "❌ 请在指定白名单频道操作。",
                    ephemeral: true
                });
            }

            if (!isServerOwner(interaction)) {

                return interaction.reply({
                    content:
                        "🚫 只有社区 Owner 可以管理白名单。",
                    ephemeral: true
                });
            }
        }

        /* =====================
           添加白名单
        ===================== */

        if (
            interaction.isButton() &&
            interaction.customId === "whitelist_add"
        ) {

            const modal = new ModalBuilder()
                .setCustomId("add_whitelist_modal")
                .setTitle("添加白名单用户");

            const input = new TextInputBuilder()
                .setCustomId("roblox_username")
                .setLabel("Roblox 用户名")
                .setPlaceholder("输入 Roblox 用户名")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(input)
            );

            return interaction.showModal(modal);
        }

        /* =====================
           玩家名单
        ===================== */

        if (
            interaction.isButton() &&
            interaction.customId === "whitelist_players"
        ) {

            const players = getWhitelist();

            if (!players.length) {

                return interaction.reply({
                    content: "📋 当前没有白名单用户。",
                    ephemeral: true
                });
            }

            const options = players
                .slice(0, 25)
                .map(player => ({
                    label: player.roblox_name,
                    description: `Roblox ID: ${player.roblox_id}`,
                    value: player.roblox_id
                }));

            const menu =
                new StringSelectMenuBuilder()
                    .setCustomId("select_whitelist_player")
                    .setPlaceholder("选择一个玩家")
                    .addOptions(options);

            return interaction.reply({

                content:
                    players.length > 25
                        ? `当前有 ${players.length} 名玩家，下面显示前 25 名。`
                        : "请选择玩家：",

                components: [
                    new ActionRowBuilder()
                        .addComponents(menu)
                ],

                ephemeral: true
            });
        }

        /* =====================
           管理玩家
        ===================== */

        if (
            interaction.isButton() &&
            interaction.customId === "whitelist_manage"
        ) {

            const players = getWhitelist();

            if (!players.length) {

                return interaction.reply({
                    content: "当前没有白名单用户。",
                    ephemeral: true
                });
            }

            const menu =
                new StringSelectMenuBuilder()
                    .setCustomId("select_whitelist_player")
                    .setPlaceholder("选择要管理的玩家")
                    .addOptions(
                        players
                            .slice(0, 25)
                            .map(player => ({
                                label: player.roblox_name,
                                description:
                                    `Roblox ID: ${player.roblox_id}`,
                                value: player.roblox_id
                            }))
                    );

            return interaction.reply({

                content: "请选择要管理的玩家：",

                components: [
                    new ActionRowBuilder()
                        .addComponents(menu)
                ],

                ephemeral: true
            });
        }

        /* =====================
           选择玩家
        ===================== */

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId === "select_whitelist_player"
        ) {

            const robloxId = interaction.values[0];

            const player = getBinding(robloxId);

            if (!player) {

                return interaction.update({
                    content: "❌ 玩家已经不在白名单。",
                    components: []
                });
            }

            const buttons =
                new ActionRowBuilder().addComponents(

                    new ButtonBuilder()
                        .setCustomId(
                            `remove_whitelist:${robloxId}`
                        )
                        .setLabel("普通删除")
                        .setEmoji("🗑️")
                        .setStyle(ButtonStyle.Secondary),

                    new ButtonBuilder()
                        .setCustomId(
                            `permanent_ban:${robloxId}`
                        )
                        .setLabel("永久禁止加入")
                        .setEmoji("🚫")
                        .setStyle(ButtonStyle.Danger)
                );

            return interaction.update({

                content:
                    `正在管理：**${player.roblox_name}**\n\n` +
                    `请选择操作：`,

                components: [buttons]
            });
        }

        /* =====================
           删除 / 永久禁止
        ===================== */

        if (
            interaction.isButton() &&
            (
                interaction.customId.startsWith(
                    "remove_whitelist:"
                ) ||
                interaction.customId.startsWith(
                    "permanent_ban:"
                )
            )
        ) {

            const split =
                interaction.customId.split(":");

            const action = split[0];
            const robloxId = split[1];

            const player = getBinding(robloxId);

            if (!player) {

                return interaction.update({
                    content: "❌ 玩家已经不存在。",
                    components: []
                });
            }

            /* 普通删除 */

            if (action === "remove_whitelist") {

                db.prepare(`
                    DELETE FROM bindings
                    WHERE roblox_id = ?
                `).run(robloxId);

                await interaction.update({

                    content:
                        `🗑️ **${player.roblox_name}** 已普通删除。\n\n` +
                        `这个玩家以后可以重新绑定。`,

                    components: []
                });
            }

            /* 永久禁止 */

            else {

                db.prepare(`
                    DELETE FROM bindings
                    WHERE roblox_id = ?
                `).run(robloxId);

                db.prepare(`
                    INSERT OR REPLACE INTO blacklist
                    (
                        roblox_id,
                        roblox_name,
                        created_at
                    )
                    VALUES (?, ?, ?)
                `).run(
                    robloxId,
                    player.roblox_name,
                    Date.now()
                );

                await interaction.update({

                    content:
                        `🚫 **${player.roblox_name}** 已永久禁止加入。\n\n` +
                        `即使以后重新绑定，也无法进入 Roblox 游戏。`,

                    components: []
                });
            }

            for (const guild of client.guilds.cache.values()) {
                await updatePanel(guild);
            }

            return;
        }

        /* =====================
           添加白名单 Modal
        ===================== */

        if (
            interaction.isModalSubmit() &&
            interaction.customId === "add_whitelist_modal"
        ) {

            const username =
                interaction.fields
                    .getTextInputValue("roblox_username")
                    .trim();

            const robloxUser =
                await getRobloxUser(username);

            if (!robloxUser) {

                return interaction.reply({
                    content: "❌ 找不到 Roblox 用户。",
                    ephemeral: true
                });
            }

            if (isBlacklisted(robloxUser.id)) {

                return interaction.reply({
                    content:
                        "🚫 这个账号已经永久禁止加入。",
                    ephemeral: true
                });
            }

            const exists =
                getBinding(robloxUser.id);

            if (exists) {

                return interaction.reply({
                    content:
                        "❌ 这个 Roblox 用户已经在白名单。",
                    ephemeral: true
                });
            }

            /*
             * Owner 手动添加的用户没有 Discord 绑定，
             * 所以使用 owner:<ownerID>:<robloxID>
             * 作为内部唯一 ID。
             */

            db.prepare(`
                INSERT INTO bindings
                (
                    discord_id,
                    roblox_id,
                    roblox_name,
                    created_at
                )
                VALUES (?, ?, ?, ?)
            `).run(
                `owner:${interaction.user.id}:${robloxUser.id}`,
                String(robloxUser.id),
                robloxUser.name,
                Date.now()
            );

            await interaction.reply({

                content:
                    `✅ 已添加白名单：**${robloxUser.name}**`,

                ephemeral: true
            });

            for (const guild of client.guilds.cache.values()) {
                await updatePanel(guild);
            }
        }

    } catch (error) {

        console.error(error);

        if (!interaction.replied) {

            await interaction.reply({
                content:
                    "❌ 操作失败，请查看 Render Logs。",
                ephemeral: true
            }).catch(() => {});
        }
    }
});

/* =========================
   Roblox API
========================= */

const app = express();

app.get("/", (req, res) => {

    res.json({
        ok: true,
        service: "Discord Roblox WhiteList"
    });
});

/*
   Roblox 检测：
   /api/verify/玩家UserId
*/

app.get("/api/verify/:robloxId", (req, res) => {

    const robloxId =
        String(req.params.robloxId);

    /* 永久黑名单 */

    if (isBlacklisted(robloxId)) {

        return res.json({
            bound: false,
            banned: true
        });
    }

    /* 白名单 */

    const player =
        getBinding(robloxId);

    if (!player) {

        return res.json({
            bound: false,
            banned: false
        });
    }

    return res.json({

        bound: true,

        banned: false,

        robloxId: player.roblox_id,

        robloxName: player.roblox_name
    });
});

/* =========================
   HTTP
========================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `HTTP Server running on port ${PORT}`
        );
    }
);

/* =========================
   Login
========================= */

client.login(TOKEN);
