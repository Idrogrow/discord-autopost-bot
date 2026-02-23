import "dotenv/config";
import http from "node:http";
import axios from "axios";
import FormData from "form-data";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

/* =========================
   ENV (SOLO QUELLE PRESENTI SU RENDER)
========================= */

const DISCORD_TOKEN = (process.env.DISCORD_BOT_TOKEN || "").trim();
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || "").trim();

const N8N_DRAFT_WEBHOOK_URL = (process.env.N8N_DRAFT_WEBHOOK_URL || "").trim();
const N8N_APPROVE_WEBHOOK_URL = (process.env.N8N_APPROVE_WEBHOOK_URL || "").trim();
const N8N_LINK_THREAD_WEBHOOK_URL = (process.env.N8N_LINK_THREAD_WEBHOOK_URL || "").trim();

const ALLOWED_CHANNEL_ID = (process.env.ALLOWED_CHANNEL_ID || "").trim();

const DEFAULT_BRAND = process.env.DEFAULT_BRAND || "idrogrow.com";
const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || "it";
const DEFAULT_TARGET = process.env.DEFAULT_TARGET || "b2b";

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_BOT_TOKEN");
if (!DISCORD_CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID");

console.log("✅ Booting Discord AutoPost Bot");
console.log("ALLOWED_CHANNEL_ID:", ALLOWED_CHANNEL_ID);

/* =========================
   RENDER HEALTH SERVER
========================= */

const PORT = Number(process.env.PORT || 10000);

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot running");
  })
  .listen(PORT, () => {
    console.log(`🌐 Health server listening on ${PORT}`);
  });

/* =========================
   DISCORD CLIENT
========================= */

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

/* =========================
   HELPERS
========================= */

const normalizeN8n = (data) => {
  if (!data) return null;
  if (Array.isArray(data)) {
    const first = data[0];
    return first?.json ? first.json : first;
  }
  return data;
};

async function safeDefer(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }
}

async function safeEdit(interaction, content) {
  await interaction.editReply({ content });
}

async function ensureAllowedChannel(interaction) {
  if (!ALLOWED_CHANNEL_ID) return true;

  const isAllowed =
    interaction.channelId === ALLOWED_CHANNEL_ID ||
    (interaction.channel?.isThread?.() &&
      interaction.channel.parentId === ALLOWED_CHANNEL_ID);

  if (!isAllowed) {
    await interaction.reply({
      content: "⛔ Comando consentito solo nel canale autorizzato.",
      ephemeral: true,
    });
    return false;
  }
  return true;
}

/* =========================
   SLASH COMMANDS
   (Required FIRST)
========================= */

const commands = [
  new SlashCommandBuilder()
    .setName("post")
    .setDescription("Crea una bozza social")
    // REQUIRED
    .addStringOption((o) =>
      o.setName("descrizione").setDescription("Testo base").setRequired(true)
    )
    .addAttachmentOption((o) =>
      o.setName("immagine").setDescription("Immagine").setRequired(true)
    )
    // OPTIONAL
    .addStringOption((o) =>
      o
        .setName("descrizione_post")
        .setDescription("Descrizione dettagliata per AI")
        .setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("lingua").setDescription("Lingua").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("target").setDescription("Target").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("brand").setDescription("Brand").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("approvato")
    .setDescription("Approva pubblicazione")
    .addStringOption((o) =>
      o
        .setName("piattaforma")
        .setDescription("Dove pubblicare")
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
    .addStringOption((o) =>
      o
        .setName("conferma")
        .setDescription("Confermi?")
        .setRequired(true)
        .addChoices({ name: "si", value: "si" }, { name: "no", value: "no" })
    )
    .addStringOption((o) =>
      o.setName("token").setDescription("Token (opzionale)").setRequired(false)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
    body: commands,
  });
  console.log("✅ Slash commands registered");
}

/* =========================
   MAIN
========================= */

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!(await ensureAllowedChannel(interaction))) return;

  /* ===== POST ===== */
  if (interaction.commandName === "post") {
    await safeDefer(interaction);

    const description = interaction.options.getString("descrizione", true);
    const postDesc = interaction.options.getString("descrizione_post") || "";
    const attachment = interaction.options.getAttachment("immagine", true);

    const language =
      interaction.options.getString("lingua") || DEFAULT_LANGUAGE;
    const target = interaction.options.getString("target") || DEFAULT_TARGET;
    const brand = interaction.options.getString("brand") || DEFAULT_BRAND;

    try {
      const imgResp = await axios.get(
        attachment.proxyURL || attachment.url,
        { responseType: "arraybuffer" }
      );

      const form = new FormData();
      form.append("description", description);
      form.append("post_description", postDesc);
      form.append("language", language);
      form.append("target", target);
      form.append("brand", brand);
      form.append("image", Buffer.from(imgResp.data), {
        filename: attachment.name,
      });

      const resp = await axios.post(N8N_DRAFT_WEBHOOK_URL, form, {
        headers: form.getHeaders(),
      });

      const data = normalizeN8n(resp.data);

      await safeEdit(
        interaction,
        `✅ Bozza creata.\nToken: \`${data?.approval_token || "n/a"}\``
      );
    } catch (e) {
      await safeEdit(interaction, "❌ Errore creazione bozza.");
    }
  }

  /* ===== APPROVATO ===== */
  if (interaction.commandName === "approvato") {
    await safeDefer(interaction);

    const platform = interaction.options.getString("piattaforma", true);
    const conferma = interaction.options.getString("conferma", true);
    const token = interaction.options.getString("token") || "";

    if (conferma !== "si") {
      await safeEdit(interaction, "⛔ Operazione annullata.");
      return;
    }

    try {
      await axios.post(N8N_APPROVE_WEBHOOK_URL, {
        approval_token: token,
        platform,
      });

      await safeEdit(
        interaction,
        `✅ Approvato per ${platform}.`
      );
    } catch (e) {
      await safeEdit(interaction, "❌ Errore approvazione.");
    }
  }
});

/* =========================
   START
========================= */

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
