const express = require('express');
const Database = require('better-sqlite3');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 3000;
const CHANNEL_ID = '1538392351926394963';

if (!TOKEN) {
  throw new Error('Missing TOKEN environment variable');
}

const db = new Database('data.sqlite');

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS bindings (
  discord_id TEXT PRIMARY KEY,
  discord_name TEXT NOT NULL,
  roblox_id TEXT UNIQUE NOT NULL,
  roblox_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS whitelist (
  roblox_id TEXT PRIMARY KEY,
  roblox_name TEXT NOT NULL,
  discord_id TEXT,
  discord_name TEXT,
  source TEXT NOT NULL DEFAULT 'bind',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_bans (
  discord_id TEXT PRIMARY KEY,
  discord_name TEXT,
  reason TEXT,
  operator_id TEXT,
  operator_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roblox_bans (
  roblox_id TEXT PRIMARY KEY,
  roblox_name TEXT NOT NULL,
  discord_id TEXT,
  discord_name TEXT,
  reason TEXT,
  operator_id TEXT,
  operator_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS managers (
  guild_id TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  discord_name TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(guild_id, discord_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_discord_id TEXT,
  target_discord_name TEXT,
  target_roblox_id TEXT,
  target_roblox_name TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT PRIMARY KEY,
  panel_message_id TEXT
);
`);

db.prepare(`
INSERT OR IGNORE INTO whitelist
(roblox_id, roblox_name, discord_id, discord_name, source, created_at)
SELECT
  roblox_id,
  roblox_name,
  discord_id,
  discord_name,
  'bind',
  created_at
FROM bindings
`).run();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const now = () => Date.now();

function isOwner(i) {
  return i.guild && i.guild.ownerId === i.user.id;
}

function isManager(i) {
  if (isOwner(i)) return true;

  return !!db.prepare(`
    SELECT 1
    FROM managers
    WHERE guild_id = ?
    AND discord_id = ?
  `).get(i.guildId, i.user.id);
}

function log(guildId, actor, action, target = {}, details = '') {
  db.prepare(`
    INSERT INTO audit_logs (
      guild_id,
      actor_id,
      actor_name,
      action,
      target_discord_id,
      target_discord_name,
      target_roblox_id,
      target_roblox_name,
      details,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId,
    actor.id,
    actor.username,
    action,
    target.discord_id || null,
    target.discord_name || null,
    target.roblox_id || null,
    target.roblox_name || null,
    details,
    now()
  );
}

function rows() {
  return db.prepare(`
    SELECT
      w.*,
      COALESCE(w.discord_name, '未绑定') AS shown_discord
    FROM whitelist w
    ORDER BY w.created_at ASC
  `).all();
}

function panelEmbed() {
  const list = rows();

  const text = list.length
    ? list.map((x, i) => {
        return `**${i + 1}. ${x.roblox_name}** | Discord: ${
          x.discord_id ? `<@${x.discord_id}>` : '未绑定'
        }`;
      }).join('\n')
    : '暂无白名单用户';

  return new EmbedBuilder()
    .setTitle('白名单 White List')
    .setDescription(text.slice(0, 3900))
    .setFooter({
      text: `共 ${list.length} 个白名单用户`
    })
    .setTimestamp();
}

function panelButtons() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('players')
      .setLabel('玩家名单')
      .setEmoji('👥')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('add')
      .setLabel('添加白名单')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId('logs')
      .setLabel('删除/解绑记录')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('blacklist')
      .setLabel('黑名单')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('admins')
      .setLabel('管理员')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

async function updatePanel(guild) {
  const channel = await guild.channels
    .fetch(CHANNEL_ID)
    .catch(() => null);

  if (!channel) return;

  const setting = db.prepare(`
    SELECT panel_message_id
    FROM settings
    WHERE guild_id = ?
  `).get(guild.id);

  let message = null;

  if (setting?.panel_message_id) {
    message = await channel.messages
      .fetch(setting.panel_message_id)
      .catch(() => null);
  }

  if (!message) {
    message = await channel.send({
      embeds: [panelEmbed()],
      components: panelButtons()
    });
  } else {
    await message.edit({
      embeds: [panelEmbed()],
      components: panelButtons()
    });
  }

  db.prepare(`
    INSERT INTO settings(guild_id, panel_message_id)
    VALUES (?, ?)
    ON CONFLICT(guild_id)
    DO UPDATE SET panel_message_id = excluded.panel_message_id
  `).run(guild.id, message.id);
}

async function refresh(guild) {
  try {
    await updatePanel(guild);
  } catch (error) {
    console.error('Panel error:', error);
  }
}

function trim(value, max = 1000) {
  return String(value || '').slice(0, max);
}

function fmt(timestamp) {
  return `<t:${Math.floor(timestamp / 1000)}:f>`;
}

const commands = [
  new SlashCommandBuilder()
    .setName('bind')
    .setDescription('绑定 Roblox 账号')
    .addStringOption(option =>
      option
        .setName('username')
        .setDescription('Roblox 用户名')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unbind')
    .setDescription('解绑当前 Discord 账号')
].map(command => command.toJSON());

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({
    version: '10'
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
    ).catch(console.error);
  }

  for (const guild of client.guilds.cache.values()) {
    await refresh(guild);
  }
});

client.on('messageCreate', async message => {
  if (
    message.author.bot ||
    message.channelId !== CHANNEL_ID
  ) {
    return;
  }

  await message.delete().catch(() => {});
});

async function robloxUser(username) {
  const response = await fetch(
    'https://users.roblox.com/v1/usernames/users',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: false
      })
    }
  );

  if (!response.ok) {
    throw new Error('Roblox API error');
  }

  const data = await response.json();

  return data.data?.[0] || null;
}

client.on('interactionCreate', async interaction => {
  try {

    /*
     * =========================
     * Slash Commands
     * =========================
     */

    if (interaction.isChatInputCommand()) {

      if (interaction.channelId !== CHANNEL_ID) {
        return interaction.reply({
          content: '请在指定白名单频道使用此指令。',
          ephemeral: true
        });
      }

      /*
       * /bind
       */

      if (interaction.commandName === 'bind') {

        const username = interaction.options
          .getString('username', true)
          .trim();

        const discordBan = db.prepare(`
          SELECT 1
          FROM discord_bans
          WHERE discord_id = ?
        `).get(interaction.user.id);

        if (discordBan) {
          return interaction.reply({
            content:
              '🚫 你的 Discord 账号已永久禁止绑定任何 Roblox 账号。',
            ephemeral: true
          });
        }

        const user = await robloxUser(username)
          .catch(() => null);

        if (!user) {
          return interaction.reply({
            content: '找不到这个 Roblox 用户名。',
            ephemeral: true
          });
        }

        const robloxId = String(user.id);

        const robloxBan = db.prepare(`
          SELECT 1
          FROM roblox_bans
          WHERE roblox_id = ?
        `).get(robloxId);

        if (robloxBan) {
          return interaction.reply({
            content:
              '🚫 这个 Roblox 账号已被永久封禁，无法绑定。',
            ephemeral: true
          });
        }

        const existingDiscord = db.prepare(`
          SELECT *
          FROM bindings
          WHERE discord_id = ?
        `).get(interaction.user.id);

        if (existingDiscord) {
          return interaction.reply({
            content:
              `你已经绑定 Roblox：${existingDiscord.roblox_name}。请先 /unbind。`,
            ephemeral: true
          });
        }

        const existingRoblox = db.prepare(`
          SELECT *
          FROM bindings
          WHERE roblox_id = ?
        `).get(robloxId);

        if (existingRoblox) {
          return interaction.reply({
            content:
              '这个 Roblox 账号已经被其他 Discord 账号绑定。',
            ephemeral: true
          });
        }

        const timestamp = now();

        const transaction = db.transaction(() => {

          db.prepare(`
            INSERT INTO bindings (
              discord_id,
              discord_name,
              roblox_id,
              roblox_name,
              created_at
            )
            VALUES (?, ?, ?, ?, ?)
          `).run(
            interaction.user.id,
            interaction.user.username,
            robloxId,
            user.name,
            timestamp
          );

          db.prepare(`
            INSERT OR REPLACE INTO whitelist (
              roblox_id,
              roblox_name,
              discord_id,
              discord_name,
              source,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            robloxId,
            user.name,
            interaction.user.id,
            interaction.user.username,
            'bind',
            timestamp
          );
        });

        transaction();

        log(
          interaction.guildId,
          interaction.user,
          '绑定',
          {
            discord_id: interaction.user.id,
            discord_name: interaction.user.username,
            roblox_id: robloxId,
            roblox_name: user.name
          }
        );

        await interaction.reply({
          content:
            `✅ 绑定成功\n` +
            `Roblox：${user.name}\n` +
            `Discord：${interaction.user.username}`,
          ephemeral: true
        });

        await refresh(interaction.guild);
        return;
      }

      /*
       * /unbind
       */

      if (interaction.commandName === 'unbind') {

        const binding = db.prepare(`
          SELECT *
          FROM bindings
          WHERE discord_id = ?
        `).get(interaction.user.id);

        if (!binding) {
          return interaction.reply({
            content: '你目前没有绑定账号。',
            ephemeral: true
          });
        }

        db.transaction(() => {

          db.prepare(`
            DELETE FROM bindings
            WHERE discord_id = ?
          `).run(interaction.user.id);

          db.prepare(`
            DELETE FROM whitelist
            WHERE roblox_id = ?
          `).run(binding.roblox_id);

        })();

        log(
          interaction.guildId,
          interaction.user,
          '解绑',
          {
            discord_id: interaction.user.id,
            discord_name: interaction.user.username,
            roblox_id: binding.roblox_id,
            roblox_name: binding.roblox_name
          }
        );

        await interaction.reply({
          content: `✅ 已解绑 ${binding.roblox_name}`,
          ephemeral: true
        });

        await refresh(interaction.guild);
        return;
      }

      return;
    }

    /*
     * =========================
     * Buttons / Select Menus
     * =========================
     */

    if (
      !interaction.isButton() &&
      !interaction.isStringSelectMenu() &&
      !interaction.isUserSelectMenu()
    ) {
      return;
    }

    /*
     * =========================
     * 玩家名单
     * =========================
     */

    if (
      interaction.isButton() &&
      interaction.customId === 'players'
    ) {

      if (!isManager(interaction)) {
        return interaction.reply({
          content: '没有白名单管理权限。',
          ephemeral: true
        });
      }

      const list = rows();

      if (!list.length) {
        return interaction.reply({
          content: '暂无白名单用户。',
          ephemeral: true
        });
      }

      const options = list
        .slice(0, 25)
        .map(user => ({
          label: user.roblox_name.slice(0, 100),
          description: user.discord_name
            ? `Discord: ${user.discord_name}`
            : '未绑定 Discord',
          value: user.roblox_id
        }));

      return interaction.reply({
        content: '选择要管理的白名单用户：',
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('pickplayer')
              .setPlaceholder('选择玩家')
              .addOptions(options)
          )
        ],
        ephemeral: true
      });
    }

    /*
     * =========================
     * 选择玩家
     * =========================
     */

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'pickplayer'
    ) {

      if (!isManager(interaction)) {
        return interaction.update({
          content: '没有白名单管理权限。',
          components: []
        });
      }

      const robloxId = interaction.values[0];

      const user = db.prepare(`
        SELECT *
        FROM whitelist
        WHERE roblox_id = ?
      `).get(robloxId);

      if (!user) {
        return interaction.update({
          content: '用户不存在。',
          components: []
        });
      }

      return interaction.update({
        content:
          `**白名单管理**\n` +
          `Roblox：${user.roblox_name}\n` +
          `Roblox ID：${user.roblox_id}\n` +
          `绑定 Discord：${
            user.discord_id
              ? `<@${user.discord_id}> (${user.discord_name})`
              : '未绑定'
          }`,

        components: [
          new ActionRowBuilder().addComponents(

            new ButtonBuilder()
              .setCustomId(`remove:${user.roblox_id}`)
              .setLabel('普通删除')
              .setEmoji('🗑️')
              .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
              .setCustomId(`ban:${user.roblox_id}`)
              .setLabel('永久封禁')
              .setEmoji('🚫')
              .setStyle(ButtonStyle.Danger),

            new ButtonBuilder()
              .setCustomId('close')
              .setLabel('取消')
              .setStyle(ButtonStyle.Secondary)

          )
        ]
      });
    }

    /*
     * =========================
     * 普通删除 / 永久封禁
     * =========================
     */

    if (
      interaction.isButton() &&
      (
        interaction.customId.startsWith('remove:') ||
        interaction.customId.startsWith('ban:')
      )
    ) {

      if (!isManager(interaction)) {
        return interaction.reply({
          content: '没有白名单管理权限。',
          ephemeral: true
        });
      }

      const [action, robloxId] =
        interaction.customId.split(':');

      const user = db.prepare(`
        SELECT *
        FROM whitelist
        WHERE roblox_id = ?
      `).get(robloxId);

      if (!user) {
        return interaction.update({
          content: '该白名单已不存在。',
          components: []
        });
      }

      /*
       * 普通删除
       */

      if (action === 'remove') {

        db.transaction(() => {

          db.prepare(`
            DELETE FROM whitelist
            WHERE roblox_id = ?
          `).run(robloxId);

          if (user.discord_id) {
            db.prepare(`
              DELETE FROM bindings
              WHERE discord_id = ?
            `).run(user.discord_id);
          }

        })();

        log(
          interaction.guildId,
          interaction.user,
          '普通删除',
          {
            ...user
          },
          '管理员删除白名单'
        );

        await interaction.update({
          content:
            `🗑️ 已删除白名单\n` +
            `Roblox：${user.roblox_name}\n` +
            `Roblox ID：${user.roblox_id}\n` +
            `Discord：${
              user.discord_id
                ? `<@${user.discord_id}> (${user.discord_name})`
                : '未绑定'
            }`,
          components: []
        });

        await refresh(interaction.guild);
        return;
      }

      /*
       * 永久封禁
       */

      db.transaction(() => {

        db.prepare(`
          DELETE FROM whitelist
          WHERE roblox_id = ?
        `).run(robloxId);

        if (user.discord_id) {
          db.prepare(`
            DELETE FROM bindings
            WHERE discord_id = ?
          `).run(user.discord_id);
        }

        db.prepare(`
          INSERT OR REPLACE INTO roblox_bans (
            roblox_id,
            roblox_name,
            discord_id,
            discord_name,
            reason,
            operator_id,
            operator_name,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          robloxId,
          user.roblox_name,
          user.discord_id || null,
          user.discord_name || null,
          '永久封禁',
          interaction.user.id,
          interaction.user.username,
          now()
        );

        if (user.discord_id) {
          db.prepare(`
            INSERT OR REPLACE INTO discord_bans (
              discord_id,
              discord_name,
              reason,
              operator_id,
              operator_name,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            user.discord_id,
            user.discord_name,
            '绑定的 Roblox 账号被永久封禁',
            interaction.user.id,
            interaction.user.username,
            now()
          );
        }

      })();

      log(
        interaction.guildId,
        interaction.user,
        '永久封禁',
        {
          ...user
        },
        '永久封禁 Roblox；同时禁止其绑定 Discord 再绑定任何 Roblox'
      );

      await interaction.update({
        content:
          `🚫 永久封禁完成\n` +
          `Roblox：${user.roblox_name}\n` +
          `Roblox ID：${user.roblox_id}\n` +
          `Discord：${
            user.discord_id
              ? `<@${user.discord_id}> (${user.discord_name})`
              : '未绑定'
          }\n\n` +
          `${
            user.discord_id
              ? '该 Discord 账号以后无法绑定任何 Roblox 账号。'
              : ''
          }`,
        components: []
      });

      await refresh(interaction.guild);
      return;
    }

    /*
     * =========================
     * 添加白名单
     * =========================
     */

    if (
      interaction.isButton() &&
      interaction.customId === 'add'
    ) {

      if (!isManager(interaction)) {
        return interaction.reply({
          content: '没有白名单管理权限。',
          ephemeral: true
        });
      }

      return interaction.reply({
        content:
          '添加白名单请使用 `/bind Roblox用户名`。',
        ephemeral: true
      });
    }

    /*
     * =========================
     * 删除 / 解绑记录
     * =========================
     */

    if (
      interaction.isButton() &&
      interaction.customId === 'logs'
    ) {

      if (!isManager(interaction)) {
        return interaction.reply({
          content: '没有白名单管理权限。',
          ephemeral: true
        });
      }

      const logs = db.prepare(`
        SELECT *
        FROM audit_logs
        WHERE guild_id = ?
        AND action IN ('普通删除', '永久封禁', '解绑')
        ORDER BY id DESC
        LIMIT 20
      `).all(interaction.guildId);

      const text = logs.length
        ? logs.map(logItem => {
            return (
              `**${logItem.action}** | ` +
              `Roblox：${logItem.target_roblox_name || '-'} | ` +
              `Discord：${
                logItem.target_discord_id
                  ? `<@${logItem.target_discord_id}>`
                  : '未绑定'
              } | ` +
              `操作人：<@${logItem.actor_id}> | ` +
              `${fmt(logItem.created_at)}`
            );
          }).join('\n')
        : '暂无记录';

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('📜 删除 / 解绑记录')
            .setDescription(trim(text, 3900))
        ],
        ephemeral: true
      });
    }

    /*
     * =========================
     * 黑名单
     * =========================
     */

    if (
      interaction.isButton() &&
      interaction.customId === 'blacklist'
    ) {

      if (!isManager(interaction)) {
        return interaction.reply({
          content: '没有白名单管理权限。',
          ephemeral: true
        });
      }

      const robloxBans = db.prepare(`
        SELECT *
        FROM roblox_bans
        ORDER BY created_at DESC
        LIMIT 20
      `).all();

      const robloxText = robloxBans.length
        ? robloxBans.map(x => {
            return (
              `**${x.roblox_name}** (${x.roblox_id}) | ` +
              `Discord：${
                x.discord_id
                  ? `<@${x.discord_id}>`
                  : '无'
              } | ` +
              `操作人：<@${x.operator_id}> | ` +
              `${fmt(x.created_at)}`
            );
          }).join('\n')
        : '暂无 Roblox 黑名单';

      const discordBans = db.prepare(`
        SELECT *
        FROM discord_bans
        ORDER BY created_at DESC
        LIMIT 20
      `).all();

      const discordText = discordBans.length
        ? discordBans.map(x => {
            return (
              `<@${x.discord_id}> | ` +
              `操作人：<@${x.operator_id}> | ` +
              `${fmt(x.created_at)}`
            );
          }).join('\n')
        : '暂无 Discord 黑名单';

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🚫 黑名单')
            .setDescription(
              `**Roblox 黑名单**\n` +
              `${trim(robloxText, 1800)}\n\n` +
              `**Discord 黑名单**\n` +
              `${trim(discordText, 1800)}`
            )
        ],
        ephemeral: true
      });
    }

    /*
     * =========================
     * 管理员
     * =========================
     */

    if (
      interaction.isButton() &&
      interaction.customId === 'admins'
    ) {

      if (!isOwner(interaction)) {
        return interaction.reply({
          content:
            '只有服务器 Owner 可以管理管理员。',
          ephemeral: true
        });
      }

      const managers = db.prepare(`
        SELECT *
        FROM managers
        WHERE guild_id = ?
      `).all(interaction.guildId);

      const text = managers.length
        ? managers.map(manager => {
            return (
              `<@${manager.discord_id}> — ` +
              `授权人：<@${manager.granted_by}>`
            );
          }).join('\n')
        : '暂无管理员';

      return interaction.reply({
        content:
          `👑 白名单管理员\n${text}`,

        components: [
          new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId('adminuser')
              .setPlaceholder('选择 Discord 用户')
          )
        ],

        ephemeral: true
      });
    }

    /*
     * =========================
     * 选择管理员
     * =========================
     */

    if (
      interaction.isUserSelectMenu() &&
      interaction.customId === 'adminuser'
    ) {

      if (!isOwner(interaction)) {
        return interaction.reply({
          content:
            '只有服务器 Owner 可以管理管理员。',
          ephemeral: true
        });
      }

      const discordId = interaction.values[0];

      const user = await client.users.fetch(
        discordId
      );

      const exists = db.prepare(`
        SELECT 1
        FROM managers
        WHERE guild_id = ?
        AND discord_id = ?
      `).get(
        interaction.guildId,
        discordId
      );

      return interaction.update({
        content:
          `管理员操作\n用户：<@${discordId}>`,

        components: [
          new ActionRowBuilder().addComponents(

            new ButtonBuilder()
              .setCustomId(`grant:${discordId}`)
              .setLabel(
                exists
                  ? '已是管理员'
                  : '授予管理权限'
              )
              .setStyle(ButtonStyle.Success)
              .setDisabled(!!exists),

            new ButtonBuilder()
              .setCustomId(`revoke:${discordId}`)
              .setLabel('撤销管理权限')
              .setStyle(ButtonStyle.Danger)
              .setDisabled(!exists)

          )
        ]
      });
    }

    /*
     * =========================
     * 授予 / 撤销管理员
     * =========================
     */

    if (
      interaction.isButton() &&
      (
        interaction.customId.startsWith('grant:') ||
        interaction.customId.startsWith('revoke:')
      )
    ) {

      if (!isOwner(interaction)) {
        return interaction.reply({
          content:
            '只有服务器 Owner 可以管理管理员。',
          ephemeral: true
        });
      }

      const [action, discordId] =
        interaction.customId.split(':');

      const user = await client.users.fetch(
        discordId
      );

      if (action === 'grant') {

        db.prepare(`
          INSERT OR REPLACE INTO managers (
            guild_id,
            discord_id,
            discord_name,
            granted_by,
            created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `).run(
          interaction.guildId,
          discordId,
          user.username,
          interaction.user.id,
          now()
        );

      } else {

        db.prepare(`
          DELETE FROM managers
          WHERE guild_id = ?
          AND discord_id = ?
        `).run(
          interaction.guildId,
          discordId
        );
      }

      log(
        interaction.guildId,
        interaction.user,
        action === 'grant'
          ? '授予管理员'
          : '撤销管理员',
        {
          discord_id: discordId,
          discord_name: user.username
        }
      );

      return interaction.update({
        content:
          `✅ ${
            action === 'grant'
              ? '已授予'
              : '已撤销'
          } <@${discordId}> 的白名单管理权限。`,
        components: []
      });
    }

    /*
     * =========================
     * 关闭
     * =========================
     */

    if (
      interaction.isButton() &&
      interaction.customId === 'close'
    ) {
      return interaction.update({
        content: '已取消。',
        components: []
      });
    }

  } catch (error) {

    console.error(error);

    if (
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content:
          '操作失败，请检查 Bot 权限或 Render 日志。',
        ephemeral: true
      }).catch(() => {});
    }
  }
});

/*
 * =========================
 * HTTP API
 * =========================
 */

const app = express();

app.get('/', (_, res) => {
  res.json({
    ok: true,
    service: 'discord-roblox-bind'
  });
});

app.get('/api/verify/:userId', (req, res) => {

  const robloxId = String(
    req.params.userId
  );

  const banned = db.prepare(`
    SELECT 1
    FROM roblox_bans
    WHERE roblox_id = ?
  `).get(robloxId);

  if (banned) {
    return res.json({
      bound: false,
      banned: true
    });
  }

  const whitelist = db.prepare(`
    SELECT 1
    FROM whitelist
    WHERE roblox_id = ?
  `).get(robloxId);

  return res.json({
    bound: !!whitelist
  });
});

app.listen(PORT, () => {
  console.log(`HTTP listening on ${PORT}`);
});

client.login(TOKEN);
