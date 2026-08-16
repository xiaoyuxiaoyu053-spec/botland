const express = require('express');
const Database = require('better-sqlite3');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 3000;
const CHANNEL_ID = '1538392351926394963';

if (!TOKEN) {
  throw new Error('Missing TOKEN environment variable');
}

const db = new Database('data.sqlite');
db.pragma('journal_mode=WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS bindings(
  discord_id TEXT PRIMARY KEY,
  discord_name TEXT NOT NULL,
  roblox_id TEXT UNIQUE NOT NULL,
  roblox_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS whitelist(
  roblox_id TEXT PRIMARY KEY,
  roblox_name TEXT NOT NULL,
  discord_id TEXT,
  discord_name TEXT,
  source TEXT NOT NULL DEFAULT 'bind',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_bans(
  discord_id TEXT PRIMARY KEY,
  discord_name TEXT,
  reason TEXT,
  operator_id TEXT,
  operator_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roblox_bans(
  roblox_id TEXT PRIMARY KEY,
  roblox_name TEXT NOT NULL,
  discord_id TEXT,
  discord_name TEXT,
  reason TEXT,
  operator_id TEXT,
  operator_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS managers(
  guild_id TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  discord_name TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(guild_id, discord_id)
);

CREATE TABLE IF NOT EXISTS audit_logs(
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

CREATE TABLE IF NOT EXISTS settings(
  guild_id TEXT PRIMARY KEY,
  panel_message_id TEXT
);
`);

db.prepare(`
INSERT OR IGNORE INTO whitelist(
  roblox_id,
  roblox_name,
  discord_id,
  discord_name,
  source,
  created_at
)
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
  ]
});

const now = () => Date.now();

const isOwner = i =>
  i.guild && i.guild.ownerId === i.user.id;

const isManager = i =>
  isOwner(i) ||
  !!db.prepare(`
    SELECT 1
    FROM managers
    WHERE guild_id = ?
    AND discord_id = ?
  `).get(i.guildId, i.user.id);

function log(guildId, actor, action, target = {}, details = '') {
  db.prepare(`
    INSERT INTO audit_logs(
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
    VALUES(?,?,?,?,?,?,?,?,?,?)
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

function getWhitelist() {
  return db.prepare(`
    SELECT *
    FROM whitelist
    ORDER BY created_at ASC
  `).all();
}

function panelEmbed() {
  const list = getWhitelist();

  const description = list.length
    ? list
        .map((x, n) =>
          `**${n + 1}. ${x.roblox_name}** | Discord: ${
            x.discord_id
              ? `<@${x.discord_id}>`
              : '未绑定'
          }`
        )
        .join('\n')
        .slice(0, 3900)
    : '暂无白名单用户';

  return new EmbedBuilder()
    .setTitle('白名单 White List')
    .setDescription(description)
    .setFooter({
      text: `共 ${list.length} 个白名单用户`
    })
    .setTimestamp();
}

function panelButtons() {
  return [
    new ActionRowBuilder().addComponents(
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
        .setLabel('操作记录')
        .setEmoji('📜')
        .setStyle(ButtonStyle.Secondary)
    ),

    new ActionRowBuilder().addComponents(
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
    )
  ];
}

async function refresh(guild) {
  const channel = await guild.channels
    .fetch(CHANNEL_ID)
    .catch(() => null);

  if (!channel) return;

  const saved = db.prepare(`
    SELECT panel_message_id
    FROM settings
    WHERE guild_id = ?
  `).get(guild.id);

  let message = saved?.panel_message_id
    ? await channel.messages
        .fetch(saved.panel_message_id)
        .catch(() => null)
    : null;

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
    INSERT INTO settings(
      guild_id,
      panel_message_id
    )
    VALUES(?,?)
    ON CONFLICT(guild_id)
    DO UPDATE SET
      panel_message_id = excluded.panel_message_id
  `).run(
    guild.id,
    message.id
  );
}

function pageButtons(id, page, maxPage) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${id}:${page - 1}`)
      .setLabel('上一页')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),

    new ButtonBuilder()
      .setCustomId(`${id}:page`)
      .setLabel(`第 ${page + 1}/${maxPage + 1} 页`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),

    new ButtonBuilder()
      .setCustomId(`${id}:${page + 1}`)
      .setLabel('下一页')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= maxPage)
  );
}

async function robloxUser(name) {
  const response = await fetch(
    'https://users.roblox.com/v1/usernames/users',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        usernames: [name],
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

    await refresh(guild).catch(console.error);
  }
});

client.on('messageCreate', message => {
  if (
    !message.author.bot &&
    message.channelId === CHANNEL_ID
  ) {
    message.delete().catch(() => {});
  }
});

client.on('interactionCreate', async interaction => {
  try {

    // =========================
    // Slash Commands
    // =========================

    if (interaction.isChatInputCommand()) {

      if (interaction.channelId !== CHANNEL_ID) {
        return interaction.reply({
          content: '请在指定白名单频道使用。',
          ephemeral: true
        });
      }

      // /bind
      if (interaction.commandName === 'bind') {

        const name = interaction.options
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
              '🚫 你的 Discord 账号已永久禁止绑定任何 Roblox。',
            ephemeral: true
          });
        }

        const user = await robloxUser(name)
          .catch(() => null);

        if (!user) {
          return interaction.reply({
            content:
              '找不到这个 Roblox 用户名。',
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
              '🚫 这个 Roblox 账号已在黑名单。',
            ephemeral: true
          });
        }

        const currentBinding = db.prepare(`
          SELECT *
          FROM bindings
          WHERE discord_id = ?
        `).get(interaction.user.id);

        if (currentBinding) {
          return interaction.reply({
            content:
              `你已经绑定 ${currentBinding.roblox_name}，请先 /unbind。`,
            ephemeral: true
          });
        }

        const robloxBinding = db.prepare(`
          SELECT *
          FROM bindings
          WHERE roblox_id = ?
        `).get(robloxId);

        if (robloxBinding) {
          return interaction.reply({
            content:
              '这个 Roblox 已被其他 Discord 绑定。',
            ephemeral: true
          });
        }

        db.transaction(() => {

          db.prepare(`
            INSERT INTO bindings(
              discord_id,
              discord_name,
              roblox_id,
              roblox_name,
              created_at
            )
            VALUES(?,?,?,?,?)
          `).run(
            interaction.user.id,
            interaction.user.username,
            robloxId,
            user.name,
            now()
          );

          db.prepare(`
            INSERT OR REPLACE INTO whitelist(
              roblox_id,
              roblox_name,
              discord_id,
              discord_name,
              source,
              created_at
            )
            VALUES(?,?,?,?,?,?)
          `).run(
            robloxId,
            user.name,
            interaction.user.id,
            interaction.user.username,
            'bind',
            now()
          );

        })();

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
            `✅ 绑定成功\nRoblox：${user.name}`,
          ephemeral: true
        });

        return refresh(interaction.guild);
      }

      // /unbind
      if (interaction.commandName === 'unbind') {

        const binding = db.prepare(`
          SELECT *
          FROM bindings
          WHERE discord_id = ?
        `).get(interaction.user.id);

        if (!binding) {
          return interaction.reply({
            content:
              '你没有绑定账号。',
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
          binding
        );

        await interaction.reply({
          content:
            `✅ 已解绑 ${binding.roblox_name}`,
          ephemeral: true
        });

        return refresh(interaction.guild);
      }
    }

    // =========================
    // 权限
    // =========================

    if (
      !interaction.isButton() &&
      !interaction.isStringSelectMenu() &&
      !interaction.isUserSelectMenu() &&
      !interaction.isModalSubmit()
    ) {
      return;
    }

    const publicIds = [
      'close',
      'pickplayer',
      'blacklistpick',
      'adminuser'
    ];

    const allowed =
      publicIds.includes(interaction.customId) ||
      interaction.customId.startsWith('players:') ||
      interaction.customId.startsWith('blacklist:');

    if (
      !isManager(interaction) &&
      !allowed
    ) {
      return interaction.reply({
        content:
          '没有白名单管理权限。',
        ephemeral: true
      });
    }

    // =========================
    // 玩家列表
    // =========================

    if (
      interaction.isButton() &&
      (
        interaction.customId === 'players' ||
        interaction.customId.startsWith('players:')
      )
    ) {

      const all = getWhitelist();

      if (!all.length) {
        return interaction.reply({
          content:
            '暂无白名单用户。',
          ephemeral: true
        });
      }

      const page =
        interaction.customId === 'players'
          ? 0
          : Math.max(
              0,
              parseInt(
                interaction.customId.split(':')[1]
              ) || 0
            );

      const pageSize = 25;

      const maxPage =
        Math.max(
          0,
          Math.ceil(
            all.length / pageSize
          ) - 1
        );

      const safePage =
        Math.min(page, maxPage);

      const pageRows =
        all.slice(
          safePage * pageSize,
          safePage * pageSize + pageSize
        );

      const menu =
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('pickplayer')
            .setPlaceholder('选择玩家')
            .addOptions(
              pageRows.map(x => ({
                label:
                  x.roblox_name.slice(0, 100),
                description:
                  x.discord_name
                    ? `Discord: ${x.discord_name}`
                    : '未绑定 Discord',
                value: x.roblox_id
              }))
            )
        );

      const content =
        `选择白名单用户：第 ${
          safePage + 1
        }/${maxPage + 1} 页，共 ${
          all.length
        } 人。`;

      const components = [
        menu,
        pageButtons(
          'players',
          safePage,
          maxPage
        )
      ];

      if (interaction.customId === 'players') {
        return interaction.reply({
          content,
          components,
          ephemeral: true
        });
      }

      return interaction.update({
        content,
        components
      });
    }

    // =========================
    // 选择白名单玩家
    // =========================

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'pickplayer'
    ) {

      const user = db.prepare(`
        SELECT *
        FROM whitelist
        WHERE roblox_id = ?
      `).get(interaction.values[0]);

      if (!user) {
        return interaction.update({
          content:
            '用户不存在。',
          components: []
        });
      }

      return interaction.update({
        content:
          `**白名单管理**\n` +
          `Roblox：${user.roblox_name}\n` +
          `ID：${user.roblox_id}\n` +
          `Discord：${
            user.discord_id
              ? `<@${user.discord_id}> (${user.discord_name})`
              : '未绑定'
          }`,

        components: [
          new ActionRowBuilder().addComponents(

            new ButtonBuilder()
              .setCustomId(
                `remove:${user.roblox_id}`
              )
              .setLabel('普通删除')
              .setStyle(
                ButtonStyle.Secondary
              ),

            new ButtonBuilder()
              .setCustomId(
                `ban:${user.roblox_id}`
              )
              .setLabel('永久封禁')
              .setStyle(
                ButtonStyle.Danger
              ),

            new ButtonBuilder()
              .setCustomId('close')
              .setLabel('取消')
              .setStyle(
                ButtonStyle.Secondary
              )
          )
        ]
      });
    }

    // =========================
    // 删除 / 永久封禁
    // =========================

    if (
      interaction.isButton() &&
      (
        interaction.customId.startsWith('remove:') ||
        interaction.customId.startsWith('ban:')
      )
    ) {

      const [
        action,
        robloxId
      ] = interaction.customId.split(':');

      const user = db.prepare(`
        SELECT *
        FROM whitelist
        WHERE roblox_id = ?
      `).get(robloxId);

      if (!user) {
        return interaction.update({
          content:
            '用户不存在。',
          components: []
        });
      }

      // 普通删除
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
          user
        );

        await interaction.update({
          content:
            `🗑️ 已删除白名单\n` +
            `Roblox：${user.roblox_name}\n` +
            `Discord：${
              user.discord_id
                ? `<@${user.discord_id}>`
                : '未绑定'
            }`,
          components: []
        });

        return refresh(interaction.guild);
      }

      // 永久封禁
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
          INSERT OR REPLACE INTO roblox_bans(
            roblox_id,
            roblox_name,
            discord_id,
            discord_name,
            reason,
            operator_id,
            operator_name,
            created_at
          )
          VALUES(?,?,?,?,?,?,?,?)
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
            INSERT OR REPLACE INTO discord_bans(
              discord_id,
              discord_name,
              reason,
              operator_id,
              operator_name,
              created_at
            )
            VALUES(?,?,?,?,?,?)
          `).run(
            user.discord_id,
            user.discord_name,
            'Roblox 账号永久封禁',
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
        user
      );

      await interaction.update({
        content:
          `🚫 已永久封禁\n` +
          `Roblox：${user.roblox_name}\n` +
          `Discord：${
            user.discord_id
              ? `<@${user.discord_id}>`
              : '未绑定'
          }\n` +
          `${
            user.discord_id
              ? '该 Discord 以后无法绑定任何 Roblox。'
              : ''
          }`,
        components: []
      });

      return refresh(interaction.guild);
    }

    // =========================
    // 管理员直接添加
    // =========================

    if (
      interaction.isButton() &&
      interaction.customId === 'add'
    ) {

      const modal =
        new ModalBuilder()
          .setCustomId('directadd')
          .setTitle(
            '直接添加白名单'
          );

      const input =
        new TextInputBuilder()
          .setCustomId(
            'roblox_username'
          )
          .setLabel(
            'Roblox 用户名'
          )
          .setPlaceholder(
            '输入 Roblox 用户名'
          )
          .setStyle(
            TextInputStyle.Short
          )
          .setRequired(true)
          .setMaxLength(50);

      modal.addComponents(
        new ActionRowBuilder()
          .addComponents(input)
      );

      return interaction.showModal(modal);
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId === 'directadd'
    ) {

      const name =
        interaction.fields
          .getTextInputValue(
            'roblox_username'
          )
          .trim();

      const user =
        await robloxUser(name)
          .catch(() => null);

      if (!user) {
        return interaction.reply({
          content:
            '找不到这个 Roblox 用户。',
          ephemeral: true
        });
      }

      const robloxId =
        String(user.id);

      if (
        db.prepare(`
          SELECT 1
          FROM roblox_bans
          WHERE roblox_id = ?
        `).get(robloxId)
      ) {
        return interaction.reply({
          content:
            '🚫 该 Roblox 在黑名单中，请先解除黑名单。',
          ephemeral: true
        });
      }

      if (
        db.prepare(`
          SELECT 1
          FROM whitelist
          WHERE roblox_id = ?
        `).get(robloxId)
      ) {
        return interaction.reply({
          content:
            '该用户已经在白名单。',
          ephemeral: true
        });
      }

      db.prepare(`
        INSERT INTO whitelist(
          roblox_id,
          roblox_name,
          discord_id,
          discord_name,
          source,
          created_at
        )
        VALUES(?,?,?,?,?,?)
      `).run(
        robloxId,
        user.name,
        null,
        null,
        'admin',
        now()
      );

      log(
        interaction.guildId,
        interaction.user,
        '管理员直接添加',
        {
          roblox_id: robloxId,
          roblox_name: user.name
        }
      );

      await interaction.reply({
        content:
          `✅ 已直接添加白名单\n` +
          `Roblox：${user.name}\n` +
          `Discord：未绑定`,
        ephemeral: true
      });

      return refresh(interaction.guild);
    }

    // =========================
    // 黑名单
    // =========================

    if (
      interaction.isButton() &&
      (
        interaction.customId === 'blacklist' ||
        interaction.customId.startsWith(
          'blacklist:'
        )
      )
    ) {

      const all = db.prepare(`
        SELECT *
        FROM roblox_bans
        ORDER BY created_at DESC
      `).all();

      if (!all.length) {
        return interaction.reply({
          content:
            '暂无黑名单。',
          ephemeral: true
        });
      }

      const page =
        interaction.customId === 'blacklist'
          ? 0
          : Math.max(
              0,
              parseInt(
                interaction.customId.split(':')[1]
              ) || 0
            );

      const pageSize = 25;

      const maxPage =
        Math.max(
          0,
          Math.ceil(
            all.length / pageSize
          ) - 1
        );

      const safePage =
        Math.min(page, maxPage);

      const pageRows =
        all.slice(
          safePage * pageSize,
          safePage * pageSize + pageSize
        );

      const menu =
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(
              'blacklistpick'
            )
            .setPlaceholder(
              '选择黑名单用户'
            )
            .addOptions(
              pageRows.map(x => ({
                label:
                  x.roblox_name.slice(0, 100),
                description:
                  x.discord_name
                    ? `Discord: ${x.discord_name}`
                    : '未绑定 Discord',
                value: x.roblox_id
              }))
            )
        );

      const content =
        `🚫 黑名单：第 ${
          safePage + 1
        }/${maxPage + 1} 页，共 ${
          all.length
        } 人。`;

      const components = [
        menu,
        pageButtons(
          'blacklist',
          safePage,
          maxPage
        )
      ];

      if (
        interaction.customId === 'blacklist'
      ) {
        return interaction.reply({
          content,
          components,
          ephemeral: true
        });
      }

      return interaction.update({
        content,
        components
      });
    }

    // =========================
    // 选择黑名单
    // =========================

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'blacklistpick'
    ) {

      const user = db.prepare(`
        SELECT *
        FROM roblox_bans
        WHERE roblox_id = ?
      `).get(interaction.values[0]);

      if (!user) {
        return interaction.update({
          content:
            '已经解除黑名单。',
          components: []
        });
      }

      return interaction.update({
        content:
          `🚫 **黑名单用户**\n` +
          `Roblox：${user.roblox_name}\n` +
          `ID：${user.roblox_id}\n` +
          `Discord：${
            user.discord_id
              ? `<@${user.discord_id}> (${user.discord_name || ''})`
              : '未绑定'
          }\n` +
          `原因：${user.reason || '永久封禁'}`,

        components: [
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `unban:${user.roblox_id}`
                )
                .setLabel(
                  '解除黑名单'
                )
                .setEmoji('🔓')
                .setStyle(
                  ButtonStyle.Success
                ),

              new ButtonBuilder()
                .setCustomId('close')
                .setLabel('取消')
                .setStyle(
                  ButtonStyle.Secondary
                )
            )
        ]
      });
    }

    // =========================
    // 解除黑名单
    // =========================

    if (
      interaction.isButton() &&
      interaction.customId.startsWith(
        'unban:'
      )
    ) {

      const robloxId =
        interaction.customId.split(':')[1];

      const user = db.prepare(`
        SELECT *
        FROM roblox_bans
        WHERE roblox_id = ?
      `).get(robloxId);

      if (!user) {
        return interaction.update({
          content:
            '已经解除黑名单。',
          components: []
        });
      }

      db.transaction(() => {

        db.prepare(`
          DELETE FROM roblox_bans
          WHERE roblox_id = ?
        `).run(robloxId);

        if (user.discord_id) {
          db.prepare(`
            DELETE FROM discord_bans
            WHERE discord_id = ?
          `).run(user.discord_id);
        }

      })();

      log(
        interaction.guildId,
        interaction.user,
        '解除黑名单',
        user,
        '管理员解除永久黑名单'
      );

      await interaction.update({
        content:
          `🔓 **已解除黑名单**\n` +
          `Roblox：${user.roblox_name}\n` +
          `ID：${user.roblox_id}\n` +
          `Discord：${
            user.discord_id
              ? `<@${user.discord_id}>`
              : '未绑定'
          }\n\n` +
          `该 Roblox 账号现在可以重新绑定。` +
          `${
            user.discord_id
              ? '\n该 Discord 账号也已经解除绑定限制。'
              : ''
          }`,
        components: []
      });

      return refresh(interaction.guild);
    }

    // =========================
    // 操作记录
    // =========================

    if (
      interaction.isButton() &&
      interaction.customId === 'logs'
    ) {

      const logs =
        db.prepare(`
          SELECT *
          FROM audit_logs
          WHERE guild_id = ?
          ORDER BY id DESC
          LIMIT 20
        `).all(
          interaction.guildId
        );

      const text = logs.length
        ? logs.map(x =>
            `${x.action} | ` +
            `${x.target_roblox_name || '-'} | ` +
            `${
              x.target_discord_id
                ? `<@${x.target_discord_id}>`
                : '未绑定'
            } | ` +
            `操作人：<@${x.actor_id}>`
          ).join('\n')
        : '暂无记录';

      return interaction.reply({
        content: text.slice(0, 3900),
        ephemeral: true
      });
    }

    // =========================
    // 管理员
    // =========================

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

      return interaction.reply({
        content:
          '选择要授权的 Discord 用户：',

        components: [
          new ActionRowBuilder()
            .addComponents(
              new UserSelectMenuBuilder()
                .setCustomId(
                  'adminuser'
                )
                .setPlaceholder(
                  '选择用户'
                )
            )
        ],

        ephemeral: true
      });
    }

    if (
      interaction.isUserSelectMenu() &&
      interaction.customId === 'adminuser'
    ) {

      if (!isOwner(interaction)) {
        return interaction.reply({
          content:
            '只有 Owner 可以管理管理员。',
          ephemeral: true
        });
      }

      const id =
        interaction.values[0];

      const user =
        await client.users.fetch(id);

      const exists =
        db.prepare(`
          SELECT 1
          FROM managers
          WHERE guild_id = ?
          AND discord_id = ?
        `).get(
          interaction.guildId,
          id
        );

      return interaction.update({
        content:
          `用户：<@${id}>`,

        components: [
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `grant:${id}`
                )
                .setLabel(
                  '授予管理权限'
                )
                .setStyle(
                  ButtonStyle.Success
                )
                .setDisabled(
                  !!exists
                ),

              new ButtonBuilder()
                .setCustomId(
                  `revoke:${id}`
                )
                .setLabel(
                  '撤销管理权限'
                )
                .setStyle(
                  ButtonStyle.Danger
                )
                .setDisabled(
                  !exists
                )
            )
        ]
      });
    }

    // =========================
    // 授予 / 撤销管理员
    // =========================

    if (
      interaction.isButton() &&
      (
        interaction.customId.startsWith(
          'grant:'
        ) ||
        interaction.customId.startsWith(
          'revoke:'
        )
      )
    ) {

      if (!isOwner(interaction)) {
        return interaction.reply({
          content:
            '只有 Owner 可以管理管理员。',
          ephemeral: true
        });
      }

      const [
        action,
        id
      ] = interaction.customId.split(':');

      const user =
        await client.users.fetch(id);

      if (action === 'grant') {

        db.prepare(`
          INSERT OR REPLACE INTO managers(
            guild_id,
            discord_id,
            discord_name,
            granted_by,
            created_at
          )
          VALUES(?,?,?,?,?)
        `).run(
          interaction.guildId,
          id,
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
          id
        );
      }

      log(
        interaction.guildId,
        interaction.user,
        action === 'grant'
          ? '授予管理员'
          : '撤销管理员',
        {
          discord_id: id,
          discord_name: user.username
        }
      );

      return interaction.update({
        content:
          `✅ 已${
            action === 'grant'
              ? '授予'
              : '撤销'
          } <@${id}> 管理权限。`,
        components: []
      });
    }

    // =========================
    // 关闭
    // =========================

    if (
      interaction.isButton() &&
      interaction.customId === 'close'
    ) {
      return interaction.update({
        content:
          '已取消。',
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
          '操作失败，请查看 Render 日志。',
        ephemeral: true
      }).catch(() => {});
    }
  }
});

// =========================
// HTTP
// =========================

const app = express();

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'discord-roblox-bind'
  });
});

// =========================
// Roblox 白名单验证
// =========================

app.get(
  '/api/verify/:userId',
  (req, res) => {

    const userId =
      String(req.params.userId);

    const banned =
      db.prepare(`
        SELECT 1
        FROM roblox_bans
        WHERE roblox_id = ?
      `).get(userId);

    if (banned) {
      return res.json({
        bound: false,
        banned: true
      });
    }

    const whitelist =
      db.prepare(`
        SELECT 1
        FROM whitelist
        WHERE roblox_id = ?
      `).get(userId);

    return res.json({
      bound: !!whitelist,
      banned: false
    });
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `HTTP listening on ${PORT}`
    );
  }
);

client.login(TOKEN);
