/**
 * Discord AutoPost Bot (Render-ready)
 * - ESM module
 * - Health server on PORT (Render needs a bound port for Web Service)
 * - Robust token env: DISCORD_BOT_TOKEN || DISCORD_TOKEN
 * - Commands:
 *    /post (image required) + descrizione_post (optional)
 *    /approvato piattaforma conferma token(optional)
 */

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
 *  ENV / CONSTANTS
 *  ========================= */
const requireEnv = (name, value) => {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

const DISCORD_TOKEN_RAW =
  (process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || "").trim();
const DISCORD_APP_ID = (process.env.DISCORD_APP_ID || "").trim();

const N8N_DRAFT_WEBHOOK_URL = (process.env.N8N_DRAFT_WEBHOOK_URL || "").trim();
const N8N_APPROVE_WEBHOOK_URL = (process.env.N8N_APPROVE_WEBHOOK_URL || "").trim();
const N8N_LINK_THREAD_WEBHOOK_URL = (process.env.N8N_LINK_THREAD_WEBHOOK_URL || "").trim();

const ALLOWED_CHANNEL_ID = (process.env.ALLOWED_CHANNEL_ID || "").trim();

// Defaults
const DEFAULT_BRAND = (process.env.DEFAULT_BRAND || "idrogrow.com").trim();
const DEFAULT_LANGUAGE = (process.env.DEFAULT_LANGUAGE || "it").trim();
const DEFAULT_TARGET = (process.env.DEFAULT_TARGET || "b2b").trim();

requireEnv("DISCORD_BOT_TOKEN or DISCORD_TOKEN", DISCORD_TOKEN_RAW);
requireEnv("DISCORD_APP_ID", DISCORD_APP_ID);
requireEnv("N8N_DRAFT_WEBHOOK_URL", N8N_DRAFT_WEBHOOK_URL);
requireEnv("N8N_APPROVE_WEBHOOK_URL", N8N_APPROVE_WEBHOOK_URL);
requireEnv("N8N_LINK_THREAD_WEBHOOK_URL", N8N_LINK_THREAD_WEBHOOK_URL);
requireEnv("ALLOWED_CHANNEL_ID", ALLOWED_CHANNEL_ID);

const mask = (s) => {
  const v = String(s || "");
  if (v.length <= 10) return "***";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
};

console.log("✅ Booting Discord AutoPost Bot");
console.log("N8N_DRAFT_WEBHOOK_URL:", N8N_DRAFT_WEBHOOK_URL);
console.log("N8N_APPROVE_WEBHOOK_URL:", N8N_APPROVE_WEBHOOK_URL);
console.log("N8N_LINK_THREAD_WEBHOOK_URL:", N8N_LINK_THREAD_WEBHOOK_URL);
console.log("ALLOWED_CHANNEL_ID:", ALLOWED_CHANNEL_ID);
console.log("DISCORD_TOKEN (masked):", mask(DISCORD_TOKEN_RAW));

/* =========================
 *  HEALTH SERVER (Render)
 *  ========================= */
const PORT = Number(process.env.PORT || 10000);
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("running");
  })
  .listen(PORT, () => console.log(`🌐 Health server listening on ${PORT}`));

/* =========================
 *  DISCORD CLIENT
 *  ========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

/* =========================
 *  HELPERS
 *  ========================= */
const normalizeN8nResponse = (data) => {
  // n8n can return object OR [{json:{...}}] OR [{...}]
  if (!data) return null;
  if (Array.isArray(data)) {
    const first = data[0];
    if (!first) return null;
    return first.json ? first.json : first;
  }
  return data;
};

async function safeDefer(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    return true;
  } catch (e) {
    console.error("safeDefer failed:", e?.message);
    return false;
  }
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp(payload);
    }
    return await interaction.reply(payload);
  } catch (e) {
    console.error("safeReply failed:", e?.message);
    return null;
  }
}

async function safeEdit(interaction, payload) {
  try {
    if (!interaction.deferred && !interaction.replied) return null;
    return await interaction.editReply(payload);
  } catch (e) {
    console.error("safeEdit failed:", e?.message);
    return null;
  }
}

async function ensureAllowedChannel(interaction) {
  const allowed = ALLOWED_CHANNEL_ID;

  const isAllowed =
    interaction.channelId === allowed ||
    (interaction.channel?.isThread?.() && interaction.channel.parentId === allowed) ||
    interaction.channel?.parentId === allowed;

  if (!isAllowed) {
    await safeReply(interaction, {
      ephemeral: true,
      content: `⛔ Usa i comandi solo nel canale <#${allowed}> (o nei suoi thread).`,
    });
    return false;
  }
  return true;
}

/**
 * Link thread -> approval_token (e salva draft_message_id)
 * n8n link-thread webhook: action "link"
 */
async function linkThreadToToken({
  threadId,
  approvalToken,
  draftMessageId,
  stableMediaUrl,
  guildId,
  channelId,
  user,
}) {
  try {
    await axios.post(
      N8N_LINK_THREAD_WEBHOOK_URL,
      {
        action: "link",
        thread_id: String(threadId || ""),
        approval_token: String(approvalToken || ""),
        draft_message_id: String(draftMessageId || ""),
        stable_media_url: String(stableMediaUrl || ""),
        discord_guild_id: String(guildId || ""),
        discord_channel_id: String(channelId || ""),
        discord_user: String(user || ""),
      },
      { timeout: 20000, validateStatus: () => true }
    );
  } catch (e) {
    console.error("linkThreadToToken failed:", e?.response?.status, e?.message);
  }
}

/**
 * Resolve approval_token:
 * - explicit token option
 * - else lookup by thread_id via link-thread webhook action "get"
 */
async function resolveApprovalToken(interaction, tokenMaybe) {
  const direct = String(tokenMaybe || "").trim();
  if (direct) return direct;

  const ch = interaction.channel;
  const isThread = !!(ch && typeof ch.isThread === "function" && ch.isThread());
  if (!isThread) return "";

  try {
    const resp = await axios.post(
      N8N_LINK_THREAD_WEBHOOK_URL,
      { action: "get", thread_id: ch.id },
      { timeout: 20000, validateStatus: () => true }
    );
    const data = normalizeN8nResponse(resp.data);
    return data?.approval_token ? String(data.approval_token) : "";
  } catch (e) {
    console.error("resolveApprovalToken failed:", e?.response?.status, e?.message);
    return "";
  }
}

/* =========================
 *  SLASH COMMANDS (IMPORTANT: required options FIRST)
 *  ========================= */
const commands = [
  new SlashCommandBuilder()
    .setName("post")
    .setDescription("Crea una bozza social (testo + immagine) via n8n/AI")
    // REQUIRED (must be before optional)
    .addStringOption((opt) =>
      opt
        .setName("descrizione")
        .setDescription("Descrizione base del post (contesto/brief)")
        .setRequired(true)
    )
    .addAttachmentOption((opt) =>
      opt
        .setName("immagine")
        .setDescription("Immagine del post")
        .setRequired(true)
    )
    // OPTIONAL (after required)
    .addStringOption((opt) =>
      opt
        .setName("descrizione_post")
        .setDescription("Extra: dettagli/obiettivo del post (per personalizzare l'AI)")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("lingua")
        .setDescription("Lingua output")
        .addChoices(
          { name: "Italiano", value: "it" },
          { name: "English", value: "en" }
        )
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("target")
        .setDescription("Target")
        .addChoices({ name: "B2B", value: "b2b" }, { name: "B2C", value: "b2c" })
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("brand")
        .setDescription("Brand / sito (es. idrogrow.com)")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("link")
        .setDescription("Link da includere (opzionale)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("approvato")
    .setDescription("Approva la bozza e (se confermi) avvia il posting")
    // REQUIRED FIRST
    .addStringOption((opt) =>
      opt
        .setName("piattaforma")
        .setDescription("Dove postare")
        .setRequired(true)
        .addChoices(
          { name: "facebook", value: "facebook" },
          { name: "instagram", value: "instagram" },
          { name: "x", value: "x" },
          { name: "tiktok", value: "tiktok" },
          { name: "signal", value: "signal" },
          { name: "tutte", value: "all" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("conferma")
        .setDescription("Confermi il posting?")
        .setRequired(true)
        .addChoices({ name: "si", value: "si" }, { name: "no", value: "no" })
    )
    // OPTIONAL last
    .addStringOption((opt) =>
      opt
        .setName("token")
        .setDescription("Approval token (opzionale, se non sei nel thread)")
        .setRequired(false)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN_RAW);
  await rest.put(Routes.applicationCommands(DISCORD_APP_ID), { body: commands });
  console.log("✅ Slash commands registered");
}

/* =========================
 *  MAIN HANDLER
 *  ========================= */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!(await ensureAllowedChannel(interaction))) return;

  /* -------- /post -------- */
  if (interaction.commandName === "post") {
    const ok = await safeDefer(interaction);
    if (!ok) return;

    const description = interaction.options.getString("descrizione", true);
    const postDescription = interaction.options.getString("descrizione_post") || "";
    const attachment = interaction.options.getAttachment("immagine", true);

    const language = (interaction.options.getString("lingua") || DEFAULT_LANGUAGE)
      .trim()
      .toLowerCase();
    const target = (interaction.options.getString("target") || DEFAULT_TARGET)
      .trim()
      .toLowerCase();
    const link = (interaction.options.getString("link") || "").trim();
    const brand = (interaction.options.getString("brand") || DEFAULT_BRAND).trim();

    try {
      // Download image
      const downloadUrl = attachment.proxyURL || attachment.url;
      const imgResp = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
        timeout: 15000,
        maxBodyLength: Infinity,
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const imgBuffer = Buffer.from(imgResp.data);

      // Multipart -> n8n draft
      const form = new FormData();
      form.append("description", description);
      form.append("post_description", postDescription); // <-- NEW FIELD
      form.append("language", language);
      form.append("target", target);
      form.append("link", link);
      form.append("brand", brand);

      form.append("discord_guild_id", interaction.guildId || "");
      form.append("discord_channel_id", interaction.channelId || "");
      form.append("discord_user", interaction.user?.username || "");

      form.append("image", imgBuffer, {
        filename: attachment.name || "image.jpg",
        contentType: attachment.contentType || "image/jpeg",
      });

      const n8nResp = await axios.post(N8N_DRAFT_WEBHOOK_URL, form, {
        headers: form.getHeaders(),
        timeout: 120000,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });

      const data = normalizeN8nResponse(n8nResp.data) || {};
      const approvalToken = String(data.approval_token || "").trim();
      const stableMediaUrl = String(data.stable_media_url || "").trim();

      // Create thread + message summary
      const parentChannel = interaction.channel?.isThread?.()
        ? interaction.channel.parent
        : interaction.channel;

      const baseName = `Bozza • ${brand} • ${new Date().toLocaleString("it-IT")}`;
      const msg = await parentChannel.send({
        content:
          `🧾 **Bozza pronta**\n` +
          `• Brand: **${brand}**\n` +
          `• Lingua: **${language}**\n` +
          `• Target: **${target}**\n` +
          (link ? `• Link: ${link}\n` : "") +
          (postDescription ? `• Descrizione post: ${postDescription}\n` : "") +
          (stableMediaUrl ? `• Media: ${stableMediaUrl}\n` : "") +
          (approvalToken ? `• Token: \`${approvalToken}\`\n` : ""),
      });

      const thread = await msg.startThread({
        name: baseName.slice(0, 98),
        autoArchiveDuration: 1440,
      });

      // Save link in sheet via n8n link-thread
      await linkThreadToToken({
        threadId: thread.id,
        approvalToken,
        draftMessageId: msg.id,
        stableMediaUrl,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        user: interaction.user?.username,
      });

      await safeEdit(interaction, {
        content:
          `✅ Bozza creata!\n` +
          `Apri il thread: <#${thread.id}>\n` +
          `Per approvare:\n` +
          `\`/approvato piattaforma:instagram conferma:si\` (nel thread)\n` +
          `oppure passa anche \`token:\`${approvalToken}\`\` fuori dal thread.`,
      });
    } catch (e) {
      console.error("/post failed:", e?.response?.status, e?.message);
      await safeEdit(interaction, {
        content: `❌ Errore creando la bozza. Dettaglio: ${e?.message || "unknown"}`,
      });
    }
    return;
  }

  /* -------- /approvato -------- */
  if (interaction.commandName === "approvato") {
    const ok = await safeDefer(interaction);
    if (!ok) return;

    const platform = interaction.options.getString("piattaforma", true);
    const confirm = interaction.options.getString("conferma", true);
    const tokenOpt = interaction.options.getString("token") || "";

    if (confirm === "no") {
      await safeEdit(interaction, { content: "🛑 Operazione annullata (conferma=no)." });
      return;
    }

    const approvalToken = await resolveApprovalToken(interaction, tokenOpt);
    if (!approvalToken) {
      await safeEdit(interaction, {
        content:
          `❌ Token mancante.\n` +
          `Usa il comando **nel thread della bozza** (consigliato) oppure passa il token:\n` +
          `\`/approvato piattaforma:${platform} conferma:si token:XXXX\``,
      });
      return;
    }

    try {
      const resp = await axios.post(
        N8N_APPROVE_WEBHOOK_URL,
        {
          platform,
          approval_token: approvalToken,
          discord_guild_id: interaction.guildId || "",
          discord_channel_id: interaction.channelId || "",
          discord_user: interaction.user?.username || "",
        },
        { timeout: 60000, validateStatus: () => true }
      );

      const data = normalizeN8nResponse(resp.data) || {};
      const okResp = !!data.ok;

      await safeEdit(interaction, {
        content: okResp
          ? `✅ Approvato e inviato a n8n.\nPiattaforma: **${platform}**\nToken: \`${approvalToken}\``
          : `⚠️ n8n ha risposto ma con esito non-ok.\nPiattaforma: **${platform}**\nToken: \`${approvalToken}\`\nDettaglio: ${JSON.stringify(data).slice(0, 1500)}`,
      });
    } catch (e) {
      console.error("/approvato failed:", e?.response?.status, e?.message);
      await safeEdit(interaction, { content: `❌ Errore: ${e?.message || "unknown"}` });
    }
  }
});

/* =========================
 *  BOOT
 *  ========================= */
(async () => {
  await registerCommands();

  client.once("ready", () => {
    console.log(`🤖 Logged in as ${client.user?.tag}`);
  });

  // IMPORTANT: token is trimmed and must be pure token string
  await client.login(DISCORD_TOKEN_RAW);
})();
