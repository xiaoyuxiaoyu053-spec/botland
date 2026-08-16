const express = require("express");
const Database = require("better-sqlite3");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("Missing TOKEN environment variable.");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 10000);
const BIND_CHANNEL_ID = "1538392351926394963";
const DB = new Database("bindings.db");

DB.exec(`
CREATE TABLE IF NOT EXISTS bindings (
  discord_id TEXT PRIMARY KEY,
  roblox_id TEXT UNIQUE NOT NULL,
  roblox_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "discord-roblox-bind-bot" });
});

app.get("/api/binding/:robloxId", (req, res) => {
  const row = DB.prepare(
    "SELECT discord_id, roblox_id, roblox_name FROM bindings WHERE roblox_id = ?"
  ).get(String(req.params.robloxId));

  res.json({ bound: !!row, binding: row || null });
});

app.get("/api/verify/:robloxId", (req, res) => {
  const row = DB.prepare(
    "SELECT roblox_id, roblox_name FROM bindings WHERE roblox_id = ?"
  ).get(String(req.params.robloxId));

  res.json({
    bound: !!row,
    robloxId: row?.roblox_id || null,
    robloxName: row?.roblox_name || null
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP API listening on 0.0.0.0:${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName("bind")
    .setDescription("绑定 Roblox 账号")
    .addStringOption((o) =>
      o.setName("username").setDescription("Roblox 用户名").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("unbind")
    .setDescription("解除 Roblox 绑定"),
].map((c) => c.toJSON());

async function getRobloxUser(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      usernames: [username],
      excludeBannedUsers: false
    }),
  });

  if (!r.ok) throw new Error(`Roblox API HTTP ${r.status}`);
  const data = await r.json();
  return data.data?.[0] || null;
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands }
      );
    } catch (err) {
      console.error(`Guild setup failed for ${guild.id}:`, err);
    }
  }
});

client.on("guildCreate", async (guild) => {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guild.id),
      { body: commands }
    );
  } catch (err) {
    console.error("Guild create setup failed:", err);
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.GuildText) return;
  if (message.channel.id !== BIND_CHANNEL_ID) return;

  try {
    await message.delete();
  } catch (_) {}
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const channel = interaction.channel;
  if (!channel || channel.id !== BIND_CHANNEL_ID) {
    return interaction.reply({
      content: "请在指定的绑定频道中使用此指令。",
      ephemeral: true,
    });
  }

  if (interaction.commandName === "bind") {
    const username = interaction.options.getString("username", true).trim();

    const current = DB.prepare(
      "SELECT roblox_id, roblox_name FROM bindings WHERE discord_id = ?"
    ).get(interaction.user.id);

    if (current) {
      return interaction.reply({
        content: `你已经绑定了 Roblox：${current.roblox_name}。请先使用 /unbind。`,
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const user = await getRobloxUser(username);

      if (!user) {
        return interaction.editReply("找不到这个 Roblox 用户名。");
      }

      const exists = DB.prepare(
        "SELECT discord_id, roblox_name FROM bindings WHERE roblox_id = ?"
      ).get(String(user.id));

      if (exists) {
        return interaction.editReply("这个 Roblox 账号已经被其他 Discord 账号绑定。");
      }

      DB.prepare(`
        INSERT INTO bindings (discord_id, roblox_id, roblox_name, created_at)
        VALUES (?, ?, ?, ?)
      `).run(
        interaction.user.id,
        String(user.id),
        user.name,
        new Date().toISOString()
      );

      return interaction.editReply(
        `绑定成功：${user.name} (Roblox UserId: ${user.id})`
      );
    } catch (err) {
      console.error(err);
      return interaction.editReply("绑定失败，请稍后再试。");
    }
  }

  if (interaction.commandName === "unbind") {
    const result = DB.prepare(
      "DELETE FROM bindings WHERE discord_id = ?"
    ).run(interaction.user.id);

    return interaction.reply({
      content: result.changes
        ? "已解除 Roblox 绑定，可以重新绑定。"
        : "你目前没有绑定 Roblox 账号。",
      ephemeral: true,
    });
  }
});

client.login(TOKEN);
