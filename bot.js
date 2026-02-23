import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import axios from "axios";
import FormData from "form-data";
import http from "http";

/* =========================
   Global crash protection
========================= */
process.on("unhandledRejection", (reason) => {
  console.error("UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
});

/* =========================
   ENV
========================= */
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

const N8N_DRAFT_WEBHOOK_URL = process.env.N8N_DRAFT_WEBHOOK_URL;
const N8N_APPROVE_WEBHOOK_URL = process.env.N8N_APPROVE_WEBHOOK_URL;
const N8N_LINK_THREAD_WEBHOOK_URL = process.env.N8N_LINK_THREAD_WEBHOOK_URL || "";

const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;

const DEFAULT_LANGUAGE = (process.env.DEFAULT_LANGUAGE || "it").toLowerCase();
const DEFAULT_TARGET = (process.env.DEFAULT_TARGET || "b2b").toLowerCase();
const DEFAULT_BRAND = process.env.DEFAULT_BRAND || "idrogrow.com";

const PORT = process.env.PORT || 10000;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

requireEnv("DISCORD_BOT_TOKEN", BOT_TOKEN);
requireEnv("DISCORD_CLIENT_ID", CLIENT_ID);
requireEnv("N8N_DRAFT_WEBHOOK_URL", N8N_DRAFT_WEBHOOK_URL);
requireEnv("N8N_APPROVE_WEBHOOK_URL", N8N_APPROVE_WEBHOOK_URL);
requireEnv("ALLOWED_CHANNEL_ID", ALLOWED_CHANNEL_ID);

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* =========================
   SLASH COMMANDS
========================= */

const commands = [
  new SlashCommandBuilder()
    .setName("post")
    .setDescription("crea bozza multipiattaforma (richiede approvazione)")
    .addStringOption((opt) =>
      opt.setName("titolo").setDescription("titolo del contenuto").setRequired(true)
    )
    .addAttachmentOption((opt) =>
      opt.setName("immagine").setDescription("immagine del post").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("descrizione_post")
        .setDescription("brief / contesto del post")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("lingua").setDescription("it / en").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("target").setDescription("b2b / b2c").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("link").setDescription("link opzionale").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("brand").setDescription("brand opzionale").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("approva")
    .setDescription("approva e pubblica")
    .addStringOption((opt) =>
      opt
        .setName("piattaforma")
        .setDescription("facebook / instagram / x / tiktok / signal / all")
        .setRequired(true)
        .addChoices(
          { name: "facebook", value: "facebook" },
          { name: "instagram", value: "instagram" },
          { name: "x", value: "x" },
          { name: "tiktok", value: "tiktok" },
          { name: "signal", value: "signal" },
          { name: "all", value: "all" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("conferma")
        .setDescription("si / no")
        .setRequired(true)
        .addChoices(
          { name: "si", value: "si" },
          { name: "no", value: "no" }
        )
    )
    .addStringOption((opt) =>
      opt.setName("token").setDescription("approval token opzionale").setRequired(false)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
}

/* =========================
   HELPERS
========================= */

function mkTokenButtonsRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`copytoken:${token}`)
      .setLabel("token")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`approveall:${token}`)
      .setLabel("approva all")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`cancel:${token}`)
      .setLabel("annulla")
      .setStyle(ButtonStyle.Danger)
  );
}

/* =========================
   MAIN HANDLER
========================= */

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === "post") {
      await interaction.deferReply({ ephemeral: true });

      const titolo = interaction.options.getString("titolo", true);
      const descrizione_post = interaction.options.getString("descrizione_post") || "";
      const attachment = interaction.options.getAttachment("immagine", true);

      const language = (interaction.options.getString("lingua") || DEFAULT_LANGUAGE).toLowerCase();
      const target = (interaction.options.getString("target") || DEFAULT_TARGET).toLowerCase();
      const link = interaction.options.getString("link") || "";
      const brand = interaction.options.getString("brand") || DEFAULT_BRAND;

      try {
        const imgResp = await axios.get(attachment.url, {
          responseType: "arraybuffer",
        });

        const form = new FormData();
        form.append("title", titolo);
        form.append("post_description", descrizione_post);
        form.append("language", language);
        form.append("target", target);
        form.append("link", link);
        form.append("brand", brand);
        form.append("discord_user", interaction.user.username);
        form.append("discord_channel_id", interaction.channelId);
        form.append("discord_guild_id", interaction.guildId);

        form.append("image", imgResp.data, {
          filename: attachment.name || "image.jpg",
        });

        const resp = await axios.post(N8N_DRAFT_WEBHOOK_URL, form, {
          headers: form.getHeaders(),
        });

        const data = resp.data;
        const token = data.approval_token;

        const thread = await interaction.channel.threads.create({
          name: `bozza • ${interaction.user.username}`,
          autoArchiveDuration: 1440,
        });

        const header =
          `bozza generata\n` +
          `utente: ${interaction.user.username}\n` +
          `token: ${token}\n\n` +
          `titolo: ${titolo}\n` +
          (descrizione_post ? `descrizione_post: ${descrizione_post}\n` : "");

        await thread.send(header);

        await interaction.editReply({
          content: `bozza creata nel thread <#${thread.id}>`,
          components: [mkTokenButtonsRow(token)],
        });

      } catch (err) {
        await interaction.editReply("errore durante creazione bozza");
      }
    }

    if (interaction.commandName === "approva") {
      await interaction.deferReply({ ephemeral: true });

      const piattaforma = interaction.options.getString("piattaforma", true);
      const conferma = interaction.options.getString("conferma", true);
      const token = interaction.options.getString("token", false);

      if (conferma === "no") {
        await interaction.editReply("operazione annullata");
        return;
      }

      try {
        await axios.post(N8N_APPROVE_WEBHOOK_URL, {
          approval_token: token,
          platform: piattaforma,
        });

        await interaction.editReply(`approvato su ${piattaforma}`);
      } catch {
        await interaction.editReply("errore approvazione");
      }
    }
  }
});

/* =========================
   READY
========================= */

client.once("ready", () => {
  console.log(`logged as ${client.user.tag}`);
});

await registerCommands();
client.login(BOT_TOKEN);

/* =========================
   HEALTH SERVER
========================= */
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("bot running");
  })
  .listen(PORT);
