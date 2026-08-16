const express = require('express');
const Database = require('better-sqlite3');
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 3000;
const CHANNEL_ID = '1538392351926394963';

if (!TOKEN) throw new Error('Missing TOKEN environment variable');

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
(roblox_id,roblox_name,discord_id,discord_name,source,created_at)
SELECT roblox_id,roblox_name,discord_id,discord_name,'bind',created_at
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
  return isOwner(i) ||
    !!db.prepare(
      'SELECT 1 FROM managers WHERE guild_id=? AND discord_id=?'
    ).get(i.guildId, i.user.id);
}

function log(guildId, actor, action, target = {}, details = '') {
  db.prepare(`
    INSERT INTO audit_logs(
      guild_id, actor_id, actor_name, action,
      target_discord_id, target_discord_name,
      target_roblox_id, target_roblox_name,
      details, created_at
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

function rows() {
  return db.prepare(`
    SELECT w.*,
    COALESCE(w.discord_name,'未绑定') AS shown_discord
    FROM whitelist w
    ORDER BY w.created_at ASC
  `).all();
}

function panelEmbed() {
  const list = rows();

  const text = list.length
    ? list.map((x, i) =>
        `**${i + 1}. ${x.roblox_name}** | Discord: ${
          x.discord_id ? `<@${x.discord_id}>` : '未绑定'
        }`
      ).join('\n')
    : '暂无白名单用户';

  return new EmbedBuilder()
    .setTitle('白名单 White List')
    .setDescription(text.slice(0, 3900))
    .setFooter({ text: `共 ${list.length} 个白名单用户` })
    .setTimestamp();
}

function panelButtons(owner) {
  const r1 = new ActionRowBuilder().addComponents(
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

  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('blacklist')
      .setLabel('黑名单')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger)
  );

  if (owner) {
    r2.addComponents(
      new ButtonBuilder()
        .setCustomId('admins')
        .setLabel('管理员')
        .setEmoji('👑')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return [r1, r2];
}

async function updatePanel(guild) {
  const ch = await guild.channels.fetch(CHANNEL_ID).catch(() => null);

  if (!ch) return;

  let msgId = db.prepare(
    'SELECT panel_message_id FROM settings WHERE guild_id=?'
  ).get(guild.id)?.panel_message_id;

  let msg = msgId
    ? await ch.messages.fetch(msgId).catch(() => null)
    : null;

  if (!msg) {
    msg = await ch.send({
      embeds: [panelEmbed()],
      components: panelButtons(true)
    });
  } else {
    await msg.edit({
      embeds: [panelEmbed()],
      components: panelButtons(true)
    });
  }

  db.prepare(`
    INSERT INTO settings(guild_id,panel_message_id)
    VALUES(?,?)
    ON CONFLICT(guild_id)
    DO UPDATE SET panel_message_id=excluded.panel_message_id
  `).run(guild.id, msg.id);
}

async function refresh(g) {
  try {
    await updatePanel(g);
  } catch (e) {
    console.error('panel:', e.message);
  }
}

function trim(s, n = 1000) {
  return String(s || '').slice(0, n);
}

function fmt(t) {
  return `<t:${Math.floor(t / 1000)}:f>`;
}

const commands = [
  new SlashCommandBuilder()
    .setName('bind')
    .setDescription('绑定 Roblox 账号')
    .addStringOption(o =>
      o.setName('username')
        .setDescription('Roblox 用户名')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unbind')
    .setDescription('解绑当前 Discord 账号')
].map(x => x.toJSON());

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  for (const g of client.guilds.cache.values()) {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, g.id),
      { body: commands }
    ).catch(console.error);
  }

  for (const g of client.guilds.cache.values()) {
    await refresh(g);
  }
});

client.on('messageCreate', async m => {
  if (m.author.bot || m.channelId !== CHANNEL_ID) return;

  await m.delete().catch(() => {});
});

async function robloxUser(name) {
  const r = await fetch(
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

  if (!r.ok) throw new Error('Roblox API error');

  const j = await r.json();

  return j.data?.[0] || null;
}

client.on('interactionCreate', async i => {
  try {

    // Slash Commands
    if (i.isChatInputCommand()) {

      if (i.channelId !== CHANNEL_ID) {
        return i.reply({
          content: '请在指定白名单频道使用此指令。',
          ephemeral: true
        });
      }

      // /bind
      if (i.commandName === 'bind') {

        const name = i.options
          .getString('username', true)
          .trim();

        if (
          db.prepare(
            'SELECT 1 FROM discord_bans WHERE discord_id=?'
          ).get(i.user.id)
        ) {
          return i.reply({
            content:
              '🚫 你的 Discord 账号已永久禁止绑定任何 Roblox 账号。',
            ephemeral: true
          });
        }

        const u = await robloxUser(name).catch(() => null);

        if (!u) {
          return i.reply({
            content: '找不到这个 Roblox 用户名。',
            ephemeral: true
          });
        }

        if (
          db.prepare(
            'SELECT 1 FROM roblox_bans WHERE roblox_id=?'
          ).get(String(u.id))
        ) {
          return i.reply({
            content:
              '🚫 这个 Roblox 账号已被永久封禁，无法绑定。',
            ephemeral: true
          });
        }

        const existsD = db.prepare(
          'SELECT * FROM bindings WHERE discord_id=?'
        ).get(i.user.id);

        if (existsD) {
          return i.reply({
            content:
              `你已经绑定 Roblox：${existsD.roblox_name}。请先 /unbind。`,
            ephemeral: true
          });
        }

        const existsR = db.prepare(
          'SELECT * FROM bindings WHERE roblox_id=?'
        ).get(String(u.id));

        if (existsR) {
          return i.reply({
            content:
              '这个 Roblox 账号已经被其他 Discord 账号绑定。',
            ephemeral: true
          });
        }

        const t = now();

        db.transaction(() => {

          db.prepare(
            'INSERT INTO bindings VALUES(?,?,?,?,?)'
          ).run(
            i.user.id,
            i.user.username,
            String(u.id),
            u.name,
            t
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
            String(u.id),
            u.name,
            i.user.id,
            i.user.username,
            'bind',
            t
          );

        })();

        log(
          i.guildId,
          i.user,
          '绑定',
          {
            discord_id: i.user.id,
            discord_name: i.user.username,
            roblox_id: String(u.id),
            roblox_name: u.name
          }
        );

        await i.reply({
          content:
            `✅ 绑定成功\nRoblox：${u.name}\nDiscord：${i.user.username}`,
          ephemeral: true
        });

        await refresh(i.guild);
      }

      // /unbind
      if (i.commandName === 'unbind') {

        const b = db.prepare(
          'SELECT * FROM bindings WHERE discord_id=?'
        ).get(i.user.id);

        if (!b) {
          return i.reply({
            content: '你目前没有绑定账号。',
            ephemeral: true
          });
        }

        db.transaction(() => {

          db.prepare(
            'DELETE FROM bindings WHERE discord_id=?'
          ).run(i.user.id);

          db.prepare(
            'DELETE FROM whitelist WHERE roblox_id=?'
          ).run(b.roblox_id);

        })();

        log(
          i.guildId,
          i.user,
          '解绑',
          {
            discord_id: i.user.id,
            discord_name: i.user.username,
            roblox_id: b.roblox_id,
            roblox_name: b.roblox_name
          }
        );

        await i.reply({
          content: `✅ 已解绑 ${b.roblox_name}`,
          ephemeral: true
        });

        await refresh(i.guild);
      }

      return;
    }

    /*
     * =========================================================
     * 管理员代绑
     * =========================================================
     */

    // 选择代绑的 Discord 用户
    if (
      i.isUserSelectMenu() &&
      i.customId === 'delegate_user'
    ) {

      if (!isManager(i)) {
        return i.reply({
          content: '没有白名单管理权限。',
          ephemeral: true
        });
      }

      const discordId = i.values[0];

      const user = await client.users
        .fetch(discordId)
        .catch(() => null);

      if (!user) {
        return i.update({
          content: '找不到这个 Discord 用户。',
          components: []
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`delegate_bind:${discordId}`)
        .setTitle('管理员代绑 Roblox');

      const robloxInput = new TextInputBuilder()
        .setCustomId('roblox_username')
        .setLabel('Roblox 用户名')
        .setPlaceholder('请输入 Roblox 用户名')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(20);

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          robloxInput
        )
      );

      return i.showModal(modal);
    }

    // 提交管理员代绑
    if (
      i.isModalSubmit() &&
      i.customId.startsWith('delegate_bind:')
    ) {

      if (!isManager(i)) {
        return i.reply({
          content: '没有白名单管理权限。',
          ephemeral: true
        });
      }

      const discordId = i.customId.split(':')[1];

      const robloxName = i.fields
        .getTextInputValue('roblox_username')
        .trim();

      const discordUser = await client.users
        .fetch(discordId)
        .catch(() => null);

      if (!discordUser) {
        return i.reply({
          content: '❌ 找不到目标 Discord 用户。',
          ephemeral: true
        });
      }

      // Discord 黑名单检查
      if (
        db.prepare(
          'SELECT 1 FROM discord_bans WHERE discord_id=?'
        ).get(discordId)
      ) {
        return i.reply({
          content:
            '🚫 该 Discord 账号已被永久禁止绑定任何 Roblox 账号。',
          ephemeral: true
        });
      }

      // Discord 当前绑定检查
      const existingDiscord = db.prepare(
        'SELECT * FROM bindings WHERE discord_id=?'
      ).get(discordId);

      if (existingDiscord) {
        return i.reply({
          content:
            `❌ 该 Discord 已经绑定 Roblox：${existingDiscord.roblox_name}\n` +
            `如需更换，请先解绑。`,
          ephemeral: true
        });
      }

      // 查询 Roblox
      const roblox = await robloxUser(robloxName)
        .catch(() => null);

      if (!roblox) {
        return i.reply({
          content:
            '❌ 找不到这个 Roblox 用户名。',
          ephemeral: true
        });
      }

      const robloxId = String(roblox.id);

      // Roblox 黑名单检查
      if (
        db.prepare(
          'SELECT 1 FROM roblox_bans WHERE roblox_id=?'
        ).get(robloxId)
      ) {
        return i.reply({
          content:
            `🚫 Roblox 账号 ${roblox.name} 已被永久封禁，无法代绑。`,
          ephemeral: true
        });
      }

      // Roblox 当前绑定检查
      const existingRoblox = db.prepare(
        'SELECT * FROM bindings WHERE roblox_id=?'
      ).get(robloxId);

      if (existingRoblox) {
        return i.reply({
          content:
            `❌ Roblox 账号 ${roblox.name} 已经被其他 Discord 账号绑定。`,
          ephemeral: true
        });
      }

      const t = now();

      // 写入绑定和白名单
      db.transaction(() => {

        db.prepare(
          'INSERT INTO bindings VALUES(?,?,?,?,?)'
        ).run(
          discordId,
          discordUser.username,
          robloxId,
          roblox.name,
          t
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
          roblox.name,
          discordId,
          discordUser.username,
          'admin_bind',
          t
        );

      })();

      // 记录操作
      log(
        i.guildId,
        i.user,
        '管理员代绑',
        {
          discord_id: discordId,
          discord_name: discordUser.username,
          roblox_id: robloxId,
          roblox_name: roblox.name
        },
        `管理员 ${i.user.username} 为 ${discordUser.username} 代绑 Roblox`
      );

      await i.reply({
        content:
          `✅ **代绑成功**\n\n` +
          `Discord：<@${discordId}>\n` +
          `Discord 用户名：${discordUser.username}\n` +
          `Roblox：${roblox.name}\n` +
          `Roblox ID：${robloxId}\n` +
          `操作人：<@${i.user.id}>`,
        ephemeral: true
      });

      await refresh(i.guild);

      return;
    }

    if (
      !i.isButton() &&
      !i.isStringSelectMenu() &&
      !i.isUserSelectMenu()
    ) {
      return;
    }

    if (
      !isManager(i) &&
      ['players', 'add', 'logs', 'blacklist', 'admins']
        .includes(i.customId)
    ) {
      return i.reply({
        content: '没有白名单管理权限。',
        ephemeral: true
      });
    }

    // 玩家名单
    if (i.isButton() && i.customId === 'players') {

      const list = rows();

      if (!list.length) {
        return i.reply({
          content: '暂无白名单用户。',
          ephemeral: true
        });
      }

      const opts = list.slice(0, 25).map(x => ({
        label: x.roblox_name.slice(0, 100),
        description:
          x.discord_name
            ? `Discord: ${x.discord_name}`
            : '未绑定 Discord',
        value: x.roblox_id
      }));

      return i.reply({
        content: '选择要管理的白名单用户：',
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('pickplayer')
              .setPlaceholder('选择玩家')
              .addOptions(opts)
          )
        ],
        ephemeral: true
      });
    }

    // 选择玩家
    if (
      i.isStringSelectMenu() &&
      i.customId === 'pickplayer'
    ) {

      const x = db.prepare(
        'SELECT * FROM whitelist WHERE roblox_id=?'
      ).get(i.values[0]);

      if (!x) {
        return i.update({
          content: '用户不存在。',
          components: []
        });
      }

      return i.update({
        content:
          `**白名单管理**\n` +
          `Roblox：${x.roblox_name}\n` +
          `Roblox ID：${x.roblox_id}\n` +
          `绑定 Discord：${
            x.discord_id
              ? `<@${x.discord_id}> (${x.discord_name})`
              : '未绑定'
          }`,

        components: [
          new ActionRowBuilder().addComponents(

            new ButtonBuilder()
              .setCustomId(`remove:${x.roblox_id}`)
              .setLabel('普通删除')
              .setEmoji('🗑️')
              .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
              .setCustomId(`ban:${x.roblox_id}`)
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

    // 普通删除 / 永久封禁
    if (
      i.isButton() &&
      (
        i.customId.startsWith('remove:') ||
        i.customId.startsWith('ban:')
      )
    ) {

      const [action, id] = i.customId.split(':');

      const x = db.prepare(
        'SELECT * FROM whitelist WHERE roblox_id=?'
      ).get(id);

      if (!x) {
        return i.update({
          content: '该白名单已不存在。',
          components: []
        });
      }

      // 普通删除
      if (action === 'remove') {

        db.transaction(() => {

          db.prepare(
            'DELETE FROM whitelist WHERE roblox_id=?'
          ).run(id);

          if (x.discord_id) {
            db.prepare(
              'DELETE FROM bindings WHERE discord_id=?'
            ).run(x.discord_id);
          }

        })();

        log(
          i.guildId,
          i.user,
          '普通删除',
          { ...x },
          '管理员删除白名单'
        );

        await i.update({
          content:
            `🗑️ 已删除白名单\n` +
            `Roblox：${x.roblox_name}\n` +
            `Discord：${
              x.discord_id
                ? `<@${x.discord_id}> (${x.discord_name})`
                : '未绑定'
            }`,
          components: []
        });

        await refresh(i.guild);
        return;
      }

      // 永久封禁
      db.transaction(() => {

        db.prepare(
          'DELETE FROM whitelist WHERE roblox_id=?'
        ).run(id);

        if (x.discord_id) {
          db.prepare(
            'DELETE FROM bindings WHERE discord_id=?'
          ).run(x.discord_id);
        }

        db.prepare(`
          INSERT OR REPLACE INTO roblox_bans
          VALUES(?,?,?,?,?,?,?,?)
        `).run(
          id,
          x.roblox_name,
          x.discord_id || null,
          x.discord_name || null,
          '永久封禁',
          i.user.id,
          i.user.username,
          now()
        );

        if (x.discord_id) {
          db.prepare(`
            INSERT OR REPLACE INTO discord_bans
            VALUES(?,?,?,?,?,?)
          `).run(
            x.discord_id,
            x.discord_name,
            '绑定的 Roblox 账号被永久封禁',
            i.user.id,
            i.user.username,
            now()
          );
        }

      })();

      log(
        i.guildId,
        i.user,
        '永久封禁',
        { ...x },
        '永久封禁 Roblox；同时禁止其绑定 Discord 再绑定任何 Roblox'
      );

      await i.update({
        content:
          `🚫 永久封禁完成\n` +
          `Roblox：${x.roblox_name}\n` +
          `Discord：${
            x.discord_id
              ? `<@${x.discord_id}> (${x.discord_name})`
              : '未绑定'
          }\n` +
          `${
            x.discord_id
              ? '该 Discord 账号以后无法绑定任何 Roblox 账号。'
              : ''
          }`,
        components: []
      });

      await refresh(i.guild);
      return;
    }

    // 管理员代绑入口
    if (i.isButton() && i.customId === 'add') {

      if (!isManager(i)) {
        return i.reply({
          content: '没有白名单管理权限。',
          ephemeral: true
        });
      }

      return i.reply({
        content: '请选择要代绑的 Discord 用户：',
        components: [
          new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId('delegate_user')
              .setPlaceholder('选择 Discord 用户')
              .setMinValues(1)
              .setMaxValues(1)
          )
        ],
        ephemeral: true
      });
    }

    // 日志
    if (i.isButton() && i.customId === 'logs') {

      const a = db.prepare(`
        SELECT * FROM audit_logs
        WHERE guild_id=?
        AND action IN ('普通删除','永久封禁','解绑','管理员代绑')
        ORDER BY id DESC
        LIMIT 20
      `).all(i.guildId);

      const d = a.length
        ? a.map(x => {
            const roblox = x.target_roblox_name || '-';

            const discord = x.target_discord_id
              ? `<@${x.target_discord_id}>`
              : '未绑定';

            return '**' + x.action +
              '** | ' + roblox +
              ' | ' + discord +
              ' | 操作人：<@' + x.actor_id +
              '> | ' + fmt(x.created_at);
          }).join('\n')
        : '暂无记录';

      return i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('📜 删除 / 解绑记录')
            .setDescription(trim(d, 3900))
        ],
        ephemeral: true
      });
    }

    // 黑名单
    if (i.isButton() && i.customId === 'blacklist') {

      const r = db.prepare(`
        SELECT * FROM roblox_bans
        ORDER BY created_at DESC
        LIMIT 20
      `).all();

      const d = r.length
        ? r.map(x =>
            `**${x.roblox_name}** (${x.roblox_id}) | ` +
            `Discord: ${
              x.discord_id
                ? `<@${x.discord_id}>`
                : '无'
            } | 操作人：<@${x.operator_id}> | ${fmt(x.created_at)}`
          ).join('\n')
        : '暂无 Roblox 黑名单';

      const q = db.prepare(`
        SELECT * FROM discord_bans
        ORDER BY created_at DESC
        LIMIT 20
      `).all();

      const d2 = q.length
        ? q.map(x =>
            `<@${x.discord_id}> | 操作人：<@${x.operator_id}> | ${fmt(x.created_at)}`
          ).join('\n')
        : '暂无 Discord 黑名单';

      return i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🚫 黑名单')
            .setDescription(
              `**Roblox 黑名单**\n${trim(d, 1800)}\n\n` +
              `**Discord 黑名单**\n${trim(d2, 1800)}`
            )
        ],
        ephemeral: true
      });
    }

    // 管理员
    if (i.isButton() && i.customId === 'admins') {

      if (!isOwner(i)) {
        return i.reply({
          content: '只有服务器 Owner 可以管理管理员。',
          ephemeral: true
        });
      }

      const a = db.prepare(
        'SELECT * FROM managers WHERE guild_id=?'
      ).all(i.guildId);

      const text = a.length
        ? a.map(x =>
            `<@${x.discord_id}> — 授权人：<@${x.granted_by}>`
          ).join('\n')
        : '暂无管理员';

      return i.reply({
        content: `👑 白名单管理员\n${text}`,
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

    // 选择管理员
    if (
      i.isUserSelectMenu() &&
      i.customId === 'adminuser'
    ) {

      if (!isOwner(i)) {
        return i.reply({
          content: '只有服务器 Owner 可以管理管理员。',
          ephemeral: true
        });
      }

      const id = i.values[0];
      const u = await client.users.fetch(id);

      const exists = db.prepare(
        'SELECT 1 FROM managers WHERE guild_id=? AND discord_id=?'
      ).get(i.guildId, id);

      return i.update({
        content: `管理员操作\n用户：<@${id}>`,
        components: [
          new ActionRowBuilder().addComponents(

            new ButtonBuilder()
              .setCustomId(`grant:${id}`)
              .setLabel(exists ? '已是管理员' : '授予管理权限')
              .setStyle(ButtonStyle.Success)
              .setDisabled(!!exists),

            new ButtonBuilder()
              .setCustomId(`revoke:${id}`)
              .setLabel('撤销管理权限')
              .setStyle(ButtonStyle.Danger)
              .setDisabled(!exists)

          )
        ]
      });
    }

    // 授予 / 撤销管理员
    if (
      i.isButton() &&
      (
        i.customId.startsWith('grant:') ||
        i.customId.startsWith('revoke:')
      )
    ) {

      if (!isOwner(i)) {
        return i.reply({
          content: '只有服务器 Owner 可以管理管理员。',
          ephemeral: true
        });
      }

      const [a, id] = i.customId.split(':');
      const u = await client.users.fetch(id);

      if (a === 'grant') {

        db.prepare(`
          INSERT OR REPLACE INTO managers
          VALUES(?,?,?,?,?)
        `).run(
          i.guildId,
          id,
          u.username,
          i.user.id,
          now()
        );

      } else {

        db.prepare(`
          DELETE FROM managers
          WHERE guild_id=? AND discord_id=?
        `).run(i.guildId, id);

      }

      log(
        i.guildId,
        i.user,
        a === 'grant'
          ? '授予管理员'
          : '撤销管理员',
        {
          discord_id: id,
          discord_name: u.username
        }
      );

      return i.update({
        content:
          `✅ ${
            a === 'grant'
              ? '已授予'
              : '已撤销'
          } <@${id}> 的白名单管理权限。`,
        components: []
      });
    }

    // 取消
    if (
      i.isButton() &&
      i.customId === 'close'
    ) {
      return i.update({
        content: '已取消。',
        components: []
      });
    }

  } catch (e) {

    console.error(e);

    if (!i.replied && !i.deferred) {
      await i.reply({
        content:
          '操作失败，请检查 Bot 权限或 Render 日志。',
        ephemeral: true
      }).catch(() => {});
    }
  }
});

const app = express();

app.get('/', (_, res) =>
  res.json({
    ok: true,
    service: 'discord-roblox-bind'
  })
);

app.get('/api/verify/:userId', (req, res) => {

  const id = String(req.params.userId);

  if (
    db.prepare(
      'SELECT 1 FROM roblox_bans WHERE roblox_id=?'
    ).get(id)
  ) {
    return res.json({
      bound: false,
      banned: true
    });
  }

  const w = db.prepare(
    'SELECT 1 FROM whitelist WHERE roblox_id=?'
  ).get(id);

  res.json({
    bound: !!w
  });
});

app.listen(PORT, () =>
  console.log(`HTTP listening on ${PORT}`)
);

client.login(TOKEN);
