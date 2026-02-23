import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import axios from "axios";
import FormData from "form-data";
import http from "http";

/** =========================
 *  Global crash protection
 *  ========================= */
process.on("unhandledRejection", (reason) => {
  console.error("UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
});

/** =========================
 *  ENV (ONLY THESE)
 *  ========================= */
function cleanEnv(v) {
  return String(v ?? "").trim();
}
function normalizeDiscordToken(v) {
  // Render/env UI a volte incolla "Bot xxxxx" o spazi/newline
  let t = cleanEnv(v);
  if (t.toLowerCase().startsWith("bot ")) t = t.slice(4).trim();
  return t;
}
function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

const token = normalizeDiscordToken(process.env.DISCORD_BOT_TOKEN);
const clientId = cleanEnv(process.env.DISCORD_CLIENT_ID);

const n8nDraftUrl = cleanEnv(process.env.N8N_DRAFT_WEBHOOK_URL);
const n8nApproveUrl = cleanEnv(process.env.N8N_APPROVE_WEBHOOK_URL);
const n8nLinkThreadUrl = cleanEnv(process.env.N8N_LINK_THREAD_WEBHOOK_URL);

const allowedChannelId = cleanEnv(process.env.ALLOWED_CHANNEL_ID);

const DEFAULT_LANGUAGE = (cleanEnv(process.env.DEFAULT_LANGUAGE) || "it").toLowerCase();
const DEFAULT_TARGET = (cleanEnv(process.env.DEFAULT_TARGET) || "b2b").toLowerCase();
const DEFAULT_BRAND = cleanEnv(process.env.DEFAULT_BRAND) || "idrogrow.com";

// Render Web Service requires a port bind
const PORT = cleanEnv(process.env.PORT) ? Number(cleanEnv(process.env.PORT)) : 10000;

requireEnv("DISCORD_BOT_TOKEN", token);
requireEnv("DISCORD_CLIENT_ID", clientId);
requireEnv("N8N_DRAFT_WEBHOOK_URL", n8nDraftUrl);
requireEnv("N8N_APPROVE_WEBHOOK_URL", n8nApproveUrl);
requireEnv("ALLOWED_CHANNEL_ID", allowedChannelId);

console.log("✅ Booting Discord AutoPost Bot");
console.log("N8N_DRAFT_WEBHOOK_URL:", n8nDraftUrl);
console.log("N8N_APPROVE_WEBHOOK_URL:", n8nApproveUrl);
console.log("N8N_LINK_THREAD_WEBHOOK_URL:", n8nLinkThreadUrl || "(not set)");
console.log("ALLOWED_CHANNEL_ID:", allowedChannelId);
console.log("PORT:", PORT);

/** =========================
 *  DISCORD CLIENT
 *  ========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("error", (e) => console.error("Discord client error:", e));
client.on("shardError", (e) => console.error("Discord shard error:", e));

/** =========================
 *  SLASH COMMANDS
 *  ========================= */
const platformChoices = [
  { name: "facebook", value: "facebook" },
  { name: "instagram", value: "instagram" },
  { name: "x", value: "x" },
  { name: "tiktok", value: "tiktok" },
  { name: "signal", value: "signal" },
  { name: "all", value: "all" },
];

const confirmChoices = [
  { name: "si", value: "si" },
  { name: "no", value: "no" },
];

const commands = [
  new SlashCommandBuilder()
    .setName("post")
    .setDescription("Crea BOZZA multipiattaforma da immagine + descrizione + brief (richiede approvazione)")
    // REQUIRED FIRST
    .addStringOption((opt) =>
      opt.setName("descrizione").setDescription("Testo base").setRequired(true)
    )
    .addAttachmentOption((opt) =>
      opt.setName("immagine").setDescription("Immagine da usare").setRequired(true)
    )
    // OPTIONAL AFTER REQUIRED
    .addStringOption((opt) =>
      opt
        .setName("descrizione_post")
        .setDescription("Brief/contesto per personalizzare il post (obiettivo, promo, tono, ecc.)")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("lingua").setDescription("it / en").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("target").setDescription("b2b / b2c").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("link").setDescription("Link (opzionale)").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("brand").setDescription("Brand (opzionale)").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("approva")
    .setDescription("Approva e avvia pubblicazione (richiede conferma si/no)")
    .addStringOption((opt) =>
      opt
        .setName("piattaforma")
        .setDescription("facebook / instagram / x / tiktok / signal / all")
        .setRequired(true)
        .addChoices(...platformChoices)
    )
    .addStringOption((opt) =>
      opt
        .setName("conferma")
        .setDescription("Conferma pubblicazione: si / no")
        .setRequired(true)
        .addChoices(...confirmChoices)
    )
    .addStringOption((opt) =>
      opt.setName("token").setDescription("Approval token (opzionale)").setRequired(false)
    ),

  // Compat vecchio comando
  new SlashCommandBuilder()
    .setName("approvato")
    .setDescription("Compat: Approva e avvia pubblicazione su una piattaforma o su tutte")
    .addStringOption((opt) =>
      opt
        .setName("piattaforma")
        .setDescription("facebook / instagram / x / tiktok / signal / all")
        .setRequired(true)
        .addChoices(...platformChoices)
    )
    .addStringOption((opt) =>
      opt.setName("token").setDescription("Approval token (opzionale)").setRequired(false)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("✅ Slash commands registered");
}

/** =========================
 *  HELPERS
 *  ========================= */
function chunkText(text, max = 1800) {
  const chunks = [];
  let s = text || "";
  while (s.length > max) {
    chunks.push(s.slice(0, max));
    s = s.slice(max);
  }
  if (s.length) chunks.push(s);
  return chunks;
}

function tryParseJsonString(s) {
  if (typeof s !== "string") return null;
  let t = s.trim();
  // a volte arriva tipo "= { ... }"
  if (t.startsWith("=")) t = t.slice(1).trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function normalizeN8nResponse(payload) {
  if (payload == null) return null;

  if (typeof payload === "string") return tryParseJsonString(payload);

  if (Array.isArray(payload)) {
    const first = payload[0] ?? null;
    if (typeof first === "string") return tryParseJsonString(first);
    if (first && typeof first === "object") return first;
    return null;
  }

  if (typeof payload === "object") return payload;
  return null;
}

async function safeDefer(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      // IMPORTANT: entro 3s, evita "L'applicazione non ha risposto"
      await interaction.deferReply({ ephemeral: true });
    }
    return true;
  } catch (e) {
    console.error("safeDefer failed:", e?.code || e?.message, e?.rawError || "");
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
    console.error("safeReply failed:", e?.code || e?.message);
    return null;
  }
}

async function safeEdit(interaction, contentOrPayload) {
  try {
    if (!interaction.deferred && !interaction.replied) return null;
    return await interaction.editReply(contentOrPayload);
  } catch (e) {
    console.error("safeEdit failed:", e?.code || e?.message);
    return null;
  }
}

async function ensureAllowedChannel(interaction) {
  const ch = interaction.channel;

  const isAllowed =
    interaction.channelId === allowedChannelId ||
    (ch?.isThread?.() && ch.parentId === allowedChannelId) ||
    ch?.parentId === allowedChannelId;

  if (!isAllowed) {
    await safeReply(interaction, {
      ephemeral: true,
      content: `⛔ Usa i comandi solo nel canale <#${allowedChannelId}> (o nei suoi thread).`,
    });
    return false;
  }
  return true;
}

/** link thread <-> token via n8n (facoltativo ma utile per /approva senza token) */
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

async function resolveApprovalToken(interaction, tokenMaybe) {
  const raw = (tokenMaybe || "").trim();
  if (raw) return raw;

  const ch = interaction.channel;
  const isThread = !!(ch && typeof ch.isThread === "function" && ch.isThread());
  if (!isThread) return "";

  if (!n8nLinkThreadUrl) return "";

  try {
    const resp = await axios.post(
      n8nLinkThreadUrl,
      { action: "get", thread_id: ch.id },
      { timeout: 20_000, validateStatus: () => true }
    );

    const data = normalizeN8nResponse(resp.data);
    if (data?.approval_token) return String(data.approval_token).trim();
  } catch (e) {
    console.error("resolveApprovalToken failed:", e?.response?.status, e?.message);
  }

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
      const downloadUrl = attachment.proxyURL || attachment.url;

      const imgResp = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
        timeout: 15_000,
        maxBodyLength: Infinity,
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const imgBuffer = Buffer.from(imgResp.data);

      const form = new FormData();
      form.append("description", description);
      // ✅ nuovo campo brief
      form.append("post_description", postDescription);
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

      if (!data) throw new Error(`n8n non-JSON: ${String(rawPayload).slice(0, 500)}`);
      if (!data.ok) throw new Error(data.error || "n8n returned ok=false");

      const threadTitle = `Bozza social • ${new Date().toLocaleDateString("it-IT")} • ${interaction.user.username}`;
      const thread = await interaction.channel.threads.create({
        name: threadTitle.slice(0, 95),
        autoArchiveDuration: 1440,
        reason: "Auto post social draft",
      });

      // Header nel thread (come nel bot vecchio)
      const header =
        `🧾 **BOZZA GENERATA (PENDING APPROVAL)**\n` +
        `👤 Richiesta da: **${interaction.user.username}**\n` +
        `🧩 Token: \`${data.approval_token}\`\n` +
        (data.stable_media_url ? `🖼️ Media: ${data.stable_media_url}\n` : "") +
        `• Brand: **${brand}**\n` +
        `• Target: **${target}**\n` +
        `• Lingua: **${language}**\n` +
        (postDescription ? `• Descrizione post: ${postDescription}\n` : "") +
        `\n✅ Per pubblicare (nel thread):\n` +
        `- \`/approva piattaforma:facebook conferma:si\`\n` +
        `- \`/approva piattaforma:instagram conferma:si\`\n` +
        `- \`/approva piattaforma:x conferma:si\`\n` +
        `- \`/approva piattaforma:tiktok conferma:si\`\n` +
        `- \`/approva piattaforma:signal conferma:si\`\n` +
        `- \`/approva piattaforma:all conferma:si\`\n` +
        `\n❌ Per annullare:\n` +
        `- \`/approva piattaforma:all conferma:no\``;

      const headerMsg = await thread.send(header);
      const draftMessageId = headerMsg?.id || "";

      // salva mapping thread<->token in Sheets via n8n (se attivo)
      await linkThreadToToken({
        threadId: thread.id,
        approvalToken: data.approval_token,
        draftMessageId,
        stableMediaUrl: data.stable_media_url,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        user: interaction.user?.username,
      });

      // Blocchi bozze (come nel bot vecchio)
      const blocks = [
        { title: "FACEBOOK", body: data.fb_text },
        { title: "INSTAGRAM", body: data.ig_caption },
        { title: "X", body: data.x_text },
        { title: "TIKTOK", body: data.tiktok_caption },
        { title: "SIGNAL", body: data.signal_text },
      ];

      for (const b of blocks) {
        const txt = `**${b.title}**\n${b.body || "(vuoto)"}`;
        for (const part of chunkText(txt)) await thread.send(part);
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
        `❌ Errore bozza.\nstatus: ${status ?? "n/a"}\nmsg: ${msg ?? "n/a"}\ndata: ${
          respData ? String(respData).slice(0, 800) : "n/a"
        }`
      );
      return;
    }
  }

  /** -------- /approva + /approvato -------- */
  if (interaction.commandName === "approva" || interaction.commandName === "approvato") {
    const ok = await safeDefer(interaction);
    if (!ok) return;

    const platform = interaction.options.getString("piattaforma", true);
    const tokenOpt = interaction.options.getString("token", false);

    // /approvato compat => conferma forzata "si"
    const conferma =
      interaction.commandName === "approva"
        ? interaction.options.getString("conferma", true)
        : "si";

    if (String(conferma).toLowerCase() === "no") {
      await safeEdit(interaction, `🚫 Operazione annullata. Nessuna pubblicazione avviata.`);
      return;
    }

    const approvalToken = await resolveApprovalToken(interaction, tokenOpt);

    if (!approvalToken) {
      await safeEdit(
        interaction,
        `❌ Token mancante.\nUsa il comando nel thread della bozza (consigliato) oppure passa il token:\n` +
          `\`/approva piattaforma:${platform} conferma:si token:XXXX\``
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

      if (!data) throw new Error(`n8n non-JSON: ${String(rawPayload).slice(0, 500)}`);
      if (!data.ok) throw new Error(data.error || "n8n returned ok=false");

      await safeEdit(
        interaction,
        `✅ Approvazione inviata → **${platform.toUpperCase()}** (token: \`${approvalToken}\`)`
      );

      // opzionale: messaggio nel canale/thread
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

      console.error("❌ approve failed:", { status, respData, msg });

      await safeEdit(
        interaction,
        `❌ Errore approvazione.\nstatus: ${status ?? "n/a"}\nmsg: ${msg ?? "n/a"}\ndata: ${
          respData ? String(respData).slice(0, 800) : "n/a"
        }`
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
 *  STARTUP
 *  ========================= */
await registerCommands();
await client.login(token);

/** =========================
 *  HEALTH SERVER (Render)
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
  .listen(PORT, () => {
    console.log(`🌐 Health server listening on ${PORT}`);
  });
