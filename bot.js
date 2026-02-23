/**
 * Idrogrow Discord AutoPost Bot
 * - /post: crea bozza (manda immagine + dati a n8n draft webhook)
 * - /approvato: approva pubblicazione (manda token + piattaforma a n8n approve webhook)
 * - Link thread <-> token via n8n link-thread webhook (action link/get)
 *
 * IMPORTANT (Render):
 * - avviamo subito un server HTTP su PORT per evitare "no open ports detected".
 */

import "dotenv/config";
import http from "http";
import axios from "axios";
import FormData from "form-data";

import {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
} from "discord.js";
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";

/** =========================
 *  ENV
 *  ========================= */
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

const n8nDraftUrl = process.env.N8N_DRAFT_WEBHOOK_URL || "";
const n8nApproveUrl = process.env.N8N_APPROVE_WEBHOOK_URL || "";
const n8nLinkThreadUrl = process.env.N8N_LINK_THREAD_WEBHOOK_URL || "";

const allowedChannelId = process.env.ALLOWED_CHANNEL_ID || ""; // canale dove ascoltare
const PORT = Number(process.env.PORT || 10000);

const DEFAULT_LANGUAGE = "it";
const DEFAULT_TARGET = "b2b";
const DEFAULT_BRAND = "idrogrow.com";

/** =========================
 *  RENDER HEALTH SERVER
 *  (AVVIALO SUBITO)
 *  ========================= */
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Idrogrow Discord bot running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Health server listening on ${PORT}`);
  });

/** =========================
 *  BASIC VALIDATION
 *  ========================= */
if (!token) console.warn("⚠️ Missing DISCORD_TOKEN");
if (!clientId) console.warn("⚠️ Missing DISCORD_CLIENT_ID");

console.log("✅ Booting Discord AutoPost Bot");
console.log("N8N_DRAFT_WEBHOOK_URL:", n8nDraftUrl);
console.log("N8N_APPROVE_WEBHOOK_URL:", n8nApproveUrl);
console.log("N8N_LINK_THREAD_WEBHOOK_URL:", n8nLinkThreadUrl);
console.log("ALLOWED_CHANNEL_ID:", allowedChannelId);

/** =========================
 *  DISCORD CLIENT
 *  ========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // utile per fallback token leggendo header
  ],
  partials: [Partials.Channel, Partials.Message],
});

/** =========================
 *  HELPERS
 *  ========================= */
function chunkText(text, maxLen = 1800) {
  const s = String(text ?? "");
  if (s.length <= maxLen) return [s];
  const out = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + maxLen));
    i += maxLen;
  }
  return out;
}

function normalizeN8nResponse(payload) {
  // n8n può ritornare oggetto, stringa JSON, o array con 1 item
  if (!payload) return null;

  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  if (Array.isArray(payload)) {
    // tipico: [{ json: {...}}] o [{...}]
    const first = payload[0];
    if (!first) return null;
    if (first.json && typeof first.json === "object") return first.json;
    if (typeof first === "object") return first;
  }

  if (typeof payload === "object") {
    if (payload.json && typeof payload.json === "object") return payload.json;
    return payload;
  }

  return null;
}

async function safeDefer(interaction) {
  try {
    if (interaction.deferred || interaction.replied) return true;
    await interaction.deferReply({ ephemeral: true });
    return true;
  } catch (e) {
    console.error("safeDefer failed:", e?.message);
    return false;
  }
}

async function safeEdit(interaction, content) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(content);
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (e) {
    console.error("safeEdit failed:", e?.message);
  }
}

async function ensureAllowedChannel(interaction) {
  if (!allowedChannelId) return true; // se non settato, non bloccare
  try {
    const ch = interaction.channel;
    const isThread = !!(ch && typeof ch.isThread === "function" && ch.isThread());
    const parentId = isThread ? ch.parentId : ch.id;

    if (String(parentId) !== String(allowedChannelId)) {
      await interaction.reply({
        content: "⛔ Questo comando è abilitato solo nel canale autorizzato.",
        ephemeral: true,
      });
      return false;
    }
    return true;
  } catch (e) {
    console.error("ensureAllowedChannel failed:", e?.message);
    return true;
  }
}

/** =========================
 *  SLASH COMMANDS
 *  (Required options MUST come first)
 *  ========================= */
const commands = [
  new SlashCommandBuilder()
    .setName("post")
    .setDescription("Crea una bozza social (con immagine) e la invia al workflow n8n")
    // REQUIRED (devono stare prima)
    .addStringOption((o) =>
      o
        .setName("descrizione")
        .setDescription("Testo base / brief generale")
        .setRequired(true)
    )
    .addAttachmentOption((o) =>
      o
        .setName("immagine")
        .setDescription("Immagine del post")
        .setRequired(true)
    )
    // OPTIONAL (dopo i required)
    .addStringOption((o) =>
      o
        .setName("descrizione_post")
        .setDescription("Descrizione/obiettivo per personalizzare il post (opzionale)")
        .setRequired(false)
    )
    .addStringOption((o) =>
      o
        .setName("lingua")
        .setDescription("Lingua (it/en)")
        .setRequired(false)
        .addChoices(
          { name: "Italiano", value: "it" },
          { name: "English", value: "en" }
        )
    )
    .addStringOption((o) =>
      o
        .setName("target")
        .setDescription("Target (b2b/b2c)")
        .setRequired(false)
        .addChoices(
          { name: "B2B", value: "b2b" },
          { name: "B2C", value: "b2c" }
        )
    )
    .addStringOption((o) =>
      o
        .setName("link")
        .setDescription("Link da includere (opzionale)")
        .setRequired(false)
    )
    .addStringOption((o) =>
      o
        .setName("brand")
        .setDescription("Brand/sito (default idrogrow.com)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("approvato")
    .setDescription("Approva (o annulla) la pubblicazione della bozza")
    // REQUIRED (prima)
    .addStringOption((o) =>
      o
        .setName("piattaforma")
        .setDescription("Dove pubblicare")
        .setRequired(true)
        .addChoices(
          { name: "Facebook", value: "facebook" },
          { name: "Instagram", value: "instagram" },
          { name: "X", value: "x" },
          { name: "TikTok", value: "tiktok" },
          { name: "Signal", value: "signal" },
          { name: "Tutte", value: "all" }
        )
    )
    .addStringOption((o) =>
      o
        .setName("conferma")
        .setDescription("Conferma pubblicazione? (si/no)")
        .setRequired(true)
        .addChoices(
          { name: "SI", value: "si" },
          { name: "NO", value: "no" }
        )
    )
    // OPTIONAL (dopo)
    .addStringOption((o) =>
      o
        .setName("token")
        .setDescription("Approval token (opzionale, se sei nel thread lo recupera da solo)")
        .setRequired(false)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  if (!token || !clientId) return;

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("✅ Slash commands registered");
  } catch (e) {
    console.error("❌ registerCommands failed:", e?.message, e?.rawError);
    throw e;
  }
}

/** =========================
 *  LINK THREAD <-> TOKEN
 *  ========================= */
async function linkThreadToToken({
  threadId,
  approvalToken,
  draftMessageId,
  stableMediaUrl,
  guildId,
  channelId,
  user,
}) {
  if (!n8nLinkThreadUrl) return;

  try {
    await axios.post(
      n8nLinkThreadUrl,
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
      { timeout: 20_000, validateStatus: () => true }
    );
  } catch (e) {
    console.error("linkThreadToToken failed:", e?.response?.status, e?.message);
  }
}

/**
 * Fallback: prova a leggere il token dal messaggio header nel thread
 * (quello che contiene: 🧩 Token: `xxxx`)
 */
async function fallbackTokenFromThreadHeader(interaction) {
  try {
    const ch = interaction.channel;
    const isThread = !!(ch && typeof ch.isThread === "function" && ch.isThread());
    if (!isThread) return "";

    // fetch ultimi 50 messaggi
    const msgs = await ch.messages.fetch({ limit: 50 });
    for (const [, m] of msgs) {
      const txt = m?.content || "";
      const match = txt.match(/Token:\s*`([^`]+)`/i);
      if (match?.[1]) return match[1].trim();
    }
    return "";
  } catch (e) {
    console.error("fallbackTokenFromThreadHeader failed:", e?.message);
    return "";
  }
}

/**
 * Resolve approval_token from:
 * - explicit /approvato token:XXXX
 * - OR thread_id lookup via n8nLinkThreadUrl action "get"
 * - OR fallback parse from thread header message
 */
async function resolveApprovalToken(interaction, tokenMaybe) {
  const raw = (tokenMaybe || "").trim();
  if (raw) return raw;

  const ch = interaction.channel;
  const isThread = !!(ch && typeof ch.isThread === "function" && ch.isThread());
  if (!isThread) return "";

  // 1) prova via n8n get
  if (n8nLinkThreadUrl) {
    try {
      const resp = await axios.post(
        n8nLinkThreadUrl,
        { action: "get", thread_id: ch.id },
        { timeout: 20_000, validateStatus: () => true }
      );

      const data = normalizeN8nResponse(resp.data);
      if (data?.approval_token) return String(data.approval_token).trim();
    } catch (e) {
      console.error("resolveApprovalToken(n8n get) failed:", e?.response?.status, e?.message);
    }
  }

  // 2) fallback: leggi dal messaggio header del thread
  const tok2 = await fallbackTokenFromThreadHeader(interaction);
  if (tok2) return tok2;

  return "";
}

/** =========================
 *  MAIN HANDLER
 *  ========================= */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!(await ensureAllowedChannel(interaction))) return;

  /** -------- /post -------- */
  if (interaction.commandName === "post") {
    const ok = await safeDefer(interaction);
    if (!ok) return;

    const description = interaction.options.getString("descrizione", true);
    const postDescription = interaction.options.getString("descrizione_post", false) || "";
    const attachment = interaction.options.getAttachment("immagine", true);

    const language = (interaction.options.getString("lingua") || DEFAULT_LANGUAGE).toLowerCase();
    const target = (interaction.options.getString("target") || DEFAULT_TARGET).toLowerCase();
    const link = interaction.options.getString("link") || "";
    const brand = interaction.options.getString("brand") || DEFAULT_BRAND;

    try {
      // 1) download attachment
      const downloadUrl = attachment.proxyURL || attachment.url;

      const imgResp = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
        timeout: 15_000,
        maxBodyLength: Infinity,
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const imgBuffer = Buffer.from(imgResp.data);

      // 2) multipart to n8n draft
      const form = new FormData();
      form.append("description", description);
      form.append("post_description", postDescription); // NUOVO CAMPO
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

      const n8nResp = await axios.post(n8nDraftUrl, form, {
        headers: form.getHeaders(),
        timeout: 120_000,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });

      const rawPayload = n8nResp.data;
      const data = normalizeN8nResponse(rawPayload);

      if (!data) {
        throw new Error(`n8n returned non-JSON text: ${String(rawPayload).slice(0, 500)}`);
      }
      if (!data.ok) {
        throw new Error(data.error || "n8n returned ok=false");
      }

      // 3) create thread
      const threadTitle = `Bozza social • ${new Date().toLocaleDateString("it-IT")} • ${interaction.user.username}`;
      const thread = await interaction.channel.threads.create({
        name: threadTitle.slice(0, 95),
        autoArchiveDuration: 1440,
        reason: "Auto post social draft",
      });

      // 4) send header message and capture message id (draft_message_id)
      const header =
        `🧾 **BOZZA GENERATA (PENDING APPROVAL)**\n` +
        `👤 Richiesta da: **${interaction.user.username}**\n` +
        `🧩 Token: \`${data.approval_token}\`\n` +
        (data.stable_media_url ? `🖼️ Media: ${data.stable_media_url}\n` : "") +
        `\n✅ Per pubblicare (nel thread):\n` +
        `- \`/approvato piattaforma:facebook conferma:si\`\n` +
        `- \`/approvato piattaforma:instagram conferma:si\`\n` +
        `- \`/approvato piattaforma:x conferma:si\`\n` +
        `- \`/approvato piattaforma:all conferma:si\`\n` +
        `\n⛔ Per annullare:\n` +
        `- \`/approvato piattaforma:all conferma:no\`\n` +
        `\n(Se serve forzare token: \`/approvato piattaforma:all conferma:si token:${data.approval_token}\`)`;

      const headerMsg = await thread.send(header);
      const draftMessageId = headerMsg?.id || "";

      // 5) link thread -> token + save draft_message_id
      await linkThreadToToken({
        threadId: thread.id,
        approvalToken: data.approval_token,
        draftMessageId,
        stableMediaUrl: data.stable_media_url,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        user: interaction.user?.username,
      });

      // 6) send platform blocks
      const blocks = [
        { title: "INSTAGRAM", body: data.ig_caption },
        { title: "FACEBOOK", body: data.fb_text },
        { title: "X", body: data.x_text },
        { title: "TIKTOK", body: data.tiktok_caption },
        { title: "SIGNAL", body: data.signal_text },
      ];

      for (const b of blocks) {
        const txt = `**${b.title}**\n${b.body || "(vuoto)"}`;
        for (const part of chunkText(txt)) {
          await thread.send(part);
        }
      }

      await safeEdit(interaction, `✅ Bozza creata nel thread: <#${thread.id}>`);
      return;
    } catch (err) {
      const status = err?.response?.status;
      const respData = err?.response?.data;
      const msg = err?.message;

      console.error("❌ /post failed:", { status, respData, msg });

      await safeEdit(
        interaction,
        `❌ Errore generazione bozza.\n` +
          `status: ${status ?? "n/a"}\n` +
          `msg: ${msg ?? "n/a"}\n` +
          `data: ${respData ? String(respData).slice(0, 800) : "n/a"}`
      );
      return;
    }
  }

  /** -------- /approvato -------- */
  if (interaction.commandName === "approvato") {
    const ok = await safeDefer(interaction);
    if (!ok) return;

    const platform = interaction.options.getString("piattaforma", true);
    const confirm = (interaction.options.getString("conferma", true) || "no").toLowerCase();
    const tokenOpt = interaction.options.getString("token", false);

    // se conferma = NO, annulla e stop
    if (confirm !== "si") {
      await safeEdit(interaction, `⛔ Operazione annullata (conferma:NO). Nessun post pubblicato.`);
      return;
    }

    const approvalToken = await resolveApprovalToken(interaction, tokenOpt);

    if (!approvalToken) {
      await safeEdit(
        interaction,
        `❌ Token mancante.\n` +
          `Usa il comando *nel thread della bozza* (consigliato) oppure passa il token:\n` +
          `\`/approvato piattaforma:${platform} conferma:si token:XXXX\``
      );
      return;
    }

    try {
      const resp = await axios.post(
        n8nApproveUrl,
        { approval_token: approvalToken, platform },
        { timeout: 90_000, validateStatus: () => true }
      );

      const rawPayload = resp.data;
      const data = normalizeN8nResponse(rawPayload);

      if (!data) {
        throw new Error(`n8n returned non-JSON text: ${String(rawPayload).slice(0, 500)}`);
      }
      if (!data.ok) {
        throw new Error(data.error || "n8n returned ok=false");
      }

      await safeEdit(
        interaction,
        `✅ Approvazione inviata → **${platform.toUpperCase()}** (token: \`${approvalToken}\`)`
      );

      try {
        await interaction.channel.send(
          `✅ **APPROVATO** → **${platform.toUpperCase()}**\nToken: \`${approvalToken}\``
        );
      } catch (e) {
        console.error("channel.send failed:", e?.code || e?.message);
      }
    } catch (err) {
      const status = err?.response?.status;
      const respData = err?.response?.data;
      const msg = err?.message;

      console.error("❌ /approvato failed:", { status, respData, msg });

      await safeEdit(
        interaction,
        `❌ Errore approvazione.\n` +
          `status: ${status ?? "n/a"}\n` +
          `msg: ${msg ?? "n/a"}\n` +
          `data: ${respData ? String(respData).slice(0, 800) : "n/a"}`
      );
    }
  }
});

/** =========================
 *  READY
 *  ========================= */
client.once("ready", () => {
  console.log(`🤖 Logged as ${client.user.tag}`);
});

/** =========================
 *  START
 *  ========================= */
(async () => {
  await registerCommands();
  await client.login(token);
})();
