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
 *  ENV
 *  ========================= */
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

const N8N_DRAFT_WEBHOOK_URL = process.env.N8N_DRAFT_WEBHOOK_URL;
const N8N_APPROVE_WEBHOOK_URL = process.env.N8N_APPROVE_WEBHOOK_URL;

// link-thread workflow (thread_id <-> approval_token)
const N8N_LINK_THREAD_WEBHOOK_URL = process.env.N8N_LINK_THREAD_WEBHOOK_URL || "";

const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;

const DEFAULT_LANGUAGE = (process.env.DEFAULT_LANGUAGE || "it").toLowerCase();
const DEFAULT_TARGET = (process.env.DEFAULT_TARGET || "b2b").toLowerCase();
const DEFAULT_BRAND = process.env.DEFAULT_BRAND || "idrogrow.com";

// Render web service requires a port bind
const PORT = process.env.PORT || 10000;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

requireEnv("DISCORD_BOT_TOKEN", BOT_TOKEN);
requireEnv("DISCORD_CLIENT_ID", CLIENT_ID);
requireEnv("N8N_DRAFT_WEBHOOK_URL", N8N_DRAFT_WEBHOOK_URL);
requireEnv("N8N_APPROVE_WEBHOOK_URL", N8N_APPROVE_WEBHOOK_URL);
requireEnv("ALLOWED_CHANNEL_ID", ALLOWED_CHANNEL_ID);

console.log("✅ Booting Discord AutoPost Bot");
console.log("N8N_DRAFT_WEBHOOK_URL:", N8N_DRAFT_WEBHOOK_URL);
console.log("N8N_APPROVE_WEBHOOK_URL:", N8N_APPROVE_WEBHOOK_URL);
console.log("N8N_LINK_THREAD_WEBHOOK_URL:", N8N_LINK_THREAD_WEBHOOK_URL || "(not set)");
console.log("ALLOWED_CHANNEL_ID:", ALLOWED_CHANNEL_ID);
console.log("DEFAULT_LANGUAGE:", DEFAULT_LANGUAGE);
console.log("DEFAULT_TARGET:", DEFAULT_TARGET);
console.log("DEFAULT_BRAND:", DEFAULT_BRAND);

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
    .setDescription("Crea BOZZA multipiattaforma da immagine + titolo + descrizione post (richiede approvazione)")
    // ✅ REQUIRED FIRST (Discord rule)
    .addStringOption((opt) =>
      opt.setName("titolo").setDescription("Titolo (testo base)").setRequired(true)
    )
    .addAttachmentOption((opt) =>
      opt.setName("immagine").setDescription("Immagine da usare").setRequired(true)
    )
    // ✅ OPTIONAL AFTER REQUIRED
    .addStringOption((opt) =>
      opt
        .setName("descrizione_post")
        .setDescription("Descrizione post / brief (obiettivo, promo, tono, dettagli immagine, ecc.)")
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
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
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
  const isAllowed =
    interaction.channelId === ALLOWED_CHANNEL_ID ||
    (interaction.channel?.isThread?.() && interaction.channel.parentId === ALLOWED_CHANNEL_ID) ||
    interaction.channel?.parentId === ALLOWED_CHANNEL_ID;

  if (!isAllowed) {
    await safeReply(interaction, {
      ephemeral: true,
      content: `⛔ Usa i comandi solo nel canale <#${ALLOWED_CHANNEL_ID}> (o nei suoi thread).`,
    });
    return false;
  }
  return true;
}

function mkTokenButtonsRow(approvalToken) {
  // customId must be <= 100 chars. token is uuid-like => ok.
  const t = String(approvalToken || "").trim();

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`copytoken:${t}`)
      .setLabel("📋 Token")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`approveall:${t}`)
      .setLabel("✅ Approva ALL")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`cancel:${t}`)
      .setLabel("🚫 Annulla")
      .setStyle(ButtonStyle.Danger)
  );
}

async function linkThreadToToken({
  threadId,
  approvalToken,
  draftMessageId,
  stableMediaUrl,
  guildId,
  channelId,
  user,
}) {
  if (!N8N_LINK_THREAD_WEBHOOK_URL) return;

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

  if (!N8N_LINK_THREAD_WEBHOOK_URL) return "";

  try {
    const resp = await axios.post(
      N8N_LINK_THREAD_WEBHOOK_URL,
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

async function callApproveWebhook({ approvalToken, platform, confirm }) {
  // confirm optional: useful if you want to implement cancel in n8n
  const payload = confirm
    ? { approval_token: approvalToken, platform, confirm }
    : { approval_token: approvalToken, platform };

  const resp = await axios.post(N8N_APPROVE_WEBHOOK_URL, payload, {
    timeout: 90_000,
    validateStatus: () => true,
  });

  const data = normalizeN8nResponse(resp.data);
  if (!data) throw new Error(`n8n non-JSON: ${String(resp.data).slice(0, 500)}`);
  if (!data.ok) throw new Error(data.error || "n8n returned ok=false");
  return data;
}

/** =========================
 *  MAIN HANDLER
 *  ========================= */
client.on("interactionCreate", async (interaction) => {
  // Buttons
  if (interaction.isButton()) {
    try {
      const id = interaction.customId || "";

      if (id.startsWith("copytoken:")) {
        const token = id.slice("copytoken:".length).trim();
        await interaction.reply({
          ephemeral: true,
          content: `Token:\n\`\`\`text\n${token}\n\`\`\``,
        });
        return;
      }

      if (id.startsWith("approveall:")) {
        const token = id.slice("approveall:".length).trim();
        if (!token) {
          await interaction.reply({ ephemeral: true, content: "❌ Token mancante nel bottone." });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        await callApproveWebhook({ approvalToken: token, platform: "all" });

        await interaction.editReply(`✅ Approvazione inviata → **ALL** (token: \`${token}\`)`);
        return;
      }

      if (id.startsWith("cancel:")) {
        const token = id.slice("cancel:".length).trim();
        if (!token) {
          await interaction.reply({ ephemeral: true, content: "❌ Token mancante nel bottone." });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        // Tentativo di annullo lato n8n (se il tuo workflow lo gestisce).
        // Se n8n lo ignora non fa danni: almeno lato Discord consideriamo annullato.
        try {
          await callApproveWebhook({ approvalToken: token, platform: "all", confirm: "no" });
        } catch (e) {
          // Non bloccare: annullo "logico" comunque
          console.warn("Cancel webhook returned error (ignored):", e?.message);
        }

        await interaction.editReply(`🚫 Operazione annullata. Token: \`${token}\``);
        return;
      }
    } catch (e) {
      console.error("Button handler error:", e?.message, e?.response?.data);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("❌ Errore durante l’azione del bottone.");
        } else {
          await interaction.reply({ ephemeral: true, content: "❌ Errore durante l’azione del bottone." });
        }
      } catch {}
      return;
    }
  }

  // Slash commands
  if (!interaction.isChatInputCommand()) return;
  if (!(await ensureAllowedChannel(interaction))) return;

  /** -------- /post -------- */
  if (interaction.commandName === "post") {
    const ok = await safeDefer(interaction);
    if (!ok) return;

    // ✅ UPDATED: "descrizione" -> "titolo"
    const title = interaction.options.getString("titolo", true);
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

      // ✅ UPDATED payload keys for n8n
      form.append("title", title);
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

      const n8nResp = await axios.post(N8N_DRAFT_WEBHOOK_URL, form, {
        headers: form.getHeaders(),
        timeout: 120_000,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });

      const data = normalizeN8nResponse(n8nResp.data);
      if (!data) throw new Error(`n8n non-JSON: ${String(n8nResp.data).slice(0, 500)}`);
      if (!data.ok) throw new Error(data.error || "n8n returned ok=false");

      const approvalToken = String(data.approval_token || "").trim();

      // Create thread
      const threadTitle = `Bozza social • ${new Date().toLocaleDateString("it-IT")} • ${interaction.user.username}`;
      const thread = await interaction.channel.threads.create({
        name: threadTitle.slice(0, 95),
        autoArchiveDuration: 1440,
        reason: "Auto post social draft",
      });

      // Thread header (testo pulito)
      const header =
        `🧾 **BOZZA GENERATA (PENDING APPROVAL)**\n` +
        `👤 Richiesta da: **${interaction.user.username}**\n` +
        `🧩 Token: \`${approvalToken}\`\n` +
        (data.stable_media_url ? `🖼️ Media: ${data.stable_media_url}\n` : "") +
        `• Brand: **${brand}**\n` +
        `• Target: **${target}**\n` +
        `• Lingua: **${language}**\n` +
        `• Titolo: **${title}**\n` +
        (postDescription ? `• Descrizione post: **${postDescription}**\n` : "") +
        `\n✅ Per pubblicare: usa \`/approva\` nel thread.\n`;

      const headerMsg = await thread.send(header);
      const draftMessageId = headerMsg?.id || "";

      // Link thread<->token in sheet
      await linkThreadToToken({
        threadId: thread.id,
        approvalToken,
        draftMessageId,
        stableMediaUrl: data.stable_media_url,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        user: interaction.user?.username,
      });

      // Send platform texts in thread
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

      // ✅ Ephemeral response WITH buttons (token/approve all/cancel)
      const buttons = mkTokenButtonsRow(approvalToken);

      const ephText =
        `✅ Bozza creata nel thread: <#${thread.id}>\n\n` +
        `🧩 Token:\n\`\`\`text\n${approvalToken}\n\`\`\`\n` +
        `Usa i bottoni qui sotto per velocizzare:`;

      await safeEdit(interaction, {
        content: ephText,
        components: [buttons],
      });

      return;
    } catch (err) {
      const status = err?.response?.status;
      const respData = err?.response?.data;
      const msg = err?.message;

      console.error("❌ /post failed:", { status, respData, msg });

      await safeEdit(interaction, {
        content:
          `❌ Errore bozza.\nstatus: ${status ?? "n/a"}\nmsg: ${msg ?? "n/a"}\n` +
          `data: ${respData ? String(respData).slice(0, 800) : "n/a"}`,
        components: [],
      });
      return;
    }
  }

  /** -------- /approva -------- */
  if (interaction.commandName === "approva") {
    const ok = await safeDefer(interaction);
    if (!ok) return;

    const platform = interaction.options.getString("piattaforma", true);
    const conferma = interaction.options.getString("conferma", true);
    const tokenOpt = interaction.options.getString("token", false);

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
      await callApproveWebhook({ approvalToken, platform });

      const btnRow = mkTokenButtonsRow(approvalToken);

      await safeEdit(interaction, {
        content: `✅ Approvazione inviata → **${platform.toUpperCase()}** (token: \`${approvalToken}\`)`,
        components: [btnRow],
      });

      // opzionale: ping nel canale/thread
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

      await safeEdit(interaction, {
        content:
          `❌ Errore approvazione.\nstatus: ${status ?? "n/a"}\nmsg: ${msg ?? "n/a"}\n` +
          `data: ${respData ? String(respData).slice(0, 800) : "n/a"}`,
        components: [],
      });
    }
  }
});

/** =========================
 *  READY
 *  ========================= */
client.once("ready", () => {
  console.log(`🤖 Logged as ${client.user.tag}`);
});

await registerCommands();
client.login(BOT_TOKEN);

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
