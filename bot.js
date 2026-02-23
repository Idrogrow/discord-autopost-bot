import "dotenv/config";
import http from "http";
import axios from "axios";
import FormData from "form-data";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

/** =========================
 *  Crash protection
 *  ========================= */
process.on("unhandledRejection", (reason) => console.error("UnhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));

/** =========================
 *  ENV (ONLY THESE)
 *  ========================= */
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;

const N8N_DRAFT_WEBHOOK_URL = process.env.N8N_DRAFT_WEBHOOK_URL;
const N8N_APPROVE_WEBHOOK_URL = process.env.N8N_APPROVE_WEBHOOK_URL;
const N8N_LINK_THREAD_WEBHOOK_URL = process.env.N8N_LINK_THREAD_WEBHOOK_URL;

const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;

const DEFAULT_BRAND = process.env.DEFAULT_BRAND || "idrogrow.com";
const DEFAULT_LANGUAGE = (process.env.DEFAULT_LANGUAGE || "it").toLowerCase();
const DEFAULT_TARGET = (process.env.DEFAULT_TARGET || "b2b").toLowerCase();

const PORT = Number(process.env.PORT || 10000);

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}
requireEnv("DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN);
requireEnv("DISCORD_CLIENT_ID", DISCORD_CLIENT_ID);
requireEnv("N8N_DRAFT_WEBHOOK_URL", N8N_DRAFT_WEBHOOK_URL);
requireEnv("N8N_APPROVE_WEBHOOK_URL", N8N_APPROVE_WEBHOOK_URL);
requireEnv("N8N_LINK_THREAD_WEBHOOK_URL", N8N_LINK_THREAD_WEBHOOK_URL);
requireEnv("ALLOWED_CHANNEL_ID", ALLOWED_CHANNEL_ID);

console.log("✅ Booting Discord AutoPost Bot");
console.log("N8N_DRAFT_WEBHOOK_URL:", N8N_DRAFT_WEBHOOK_URL);
console.log("N8N_APPROVE_WEBHOOK_URL:", N8N_APPROVE_WEBHOOK_URL);
console.log("N8N_LINK_THREAD_WEBHOOK_URL:", N8N_LINK_THREAD_WEBHOOK_URL);
console.log("ALLOWED_CHANNEL_ID:", ALLOWED_CHANNEL_ID);

/** =========================
 *  Render Web Service: fake port
 *  ========================= */
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("running");
  })
  .listen(PORT, "0.0.0.0", () => console.log(`✅ Health server listening on ${PORT}`));

/** =========================
 *  Discord client
 *  ========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("error", (e) => console.error("Discord client error:", e));
client.on("shardError", (e) => console.error("Discord shard error:", e));

/** =========================
 *  Slash commands
 *  IMPORTANT: required options FIRST
 *  ========================= */
const commands = [
  new SlashCommandBuilder()
    .setName("post")
    .setDescription("Crea BOZZA multipiattaforma da immagine + descrizione (richiede approvazione)")
    // REQUIRED first
    .addStringOption((opt) =>
      opt.setName("descrizione").setDescription("Testo base").setRequired(true)
    )
    .addAttachmentOption((opt) =>
      opt.setName("immagine").setDescription("Immagine da usare").setRequired(true)
    )
    // OPTIONAL after
    .addStringOption((opt) =>
      opt
        .setName("descrizione_post")
        .setDescription("Dettagli/obiettivo del post (opzionale, per personalizzare AI)")
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
    .setName("approvato")
    .setDescription("Approva e avvia pubblicazione su una piattaforma o su tutte")
    // REQUIRED first
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
        .setDescription("Confermi la pubblicazione?")
        .setRequired(true)
        .addChoices({ name: "si", value: "si" }, { name: "no", value: "no" })
    )
    // OPTIONAL after
    .addStringOption((opt) =>
      opt.setName("token").setDescription("Approval token (opzionale)").setRequired(false)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log("✅ Slash commands registered");
}

/** =========================
 *  Helpers
 *  ========================= */
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

async function safeEdit(interaction, payload) {
  try {
    if (!interaction.deferred && !interaction.replied) return null;
    return await interaction.editReply(payload);
  } catch (e) {
    console.error("safeEdit failed:", e?.code || e?.message);
    return null;
  }
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (e) {
    console.error("safeReply failed:", e?.code || e?.message);
    return null;
  }
}

function chunkText(text, max = 1800) {
  const chunks = [];
  let s = String(text || "");
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

/** =========================
 *  N8N calls
 *  ========================= */
async function callN8nDraft({
  description,
  postDescription,
  language,
  target,
  link,
  brand,
  discordGuildId,
  discordChannelId,
  discordUser,
  attachmentUrl,
}) {
  // download image
  const imgResp = await axios.get(attachmentUrl, { responseType: "arraybuffer" });
  const imgBuffer = Buffer.from(imgResp.data);

  const form = new FormData();
  form.append("action", "draft");
  form.append("description", description);
  form.append("post_description", postDescription || "");
  form.append("language", language);
  form.append("target", target);
  form.append("link", link || "");
  form.append("brand", brand);

  form.append("discord_guild_id", discordGuildId || "");
  form.append("discord_channel_id", discordChannelId || "");
  form.append("discord_user", discordUser || "");
  form.append("source", "discord-bot");

  form.append("image", imgBuffer, {
    filename: "image.jpg",
    contentType: "image/jpeg",
  });

  const res = await axios.post(N8N_DRAFT_WEBHOOK_URL, form, {
    headers: form.getHeaders(),
    timeout: 180000,
  });

  return normalizeN8nResponse(res.data);
}

async function linkThreadToToken({
  threadId,
  approvalToken,
  draftMessageId,
  stableMediaUrl,
}) {
  const payload = {
    action: "link",
    thread_id: String(threadId),
    approval_token: String(approvalToken || ""),
    draft_message_id: String(draftMessageId || ""),
    stable_media_url: String(stableMediaUrl || ""),
    discord_guild_id: "",
    discord_channel_id: "",
    discord_user: "",
  };

  const res = await axios.post(N8N_LINK_THREAD_WEBHOOK_URL, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 60000,
  });

  return normalizeN8nResponse(res.data);
}

async function getTokenByThreadId(threadId) {
  const payload = { action: "get", thread_id: String(threadId) };
  const res = await axios.post(N8N_LINK_THREAD_WEBHOOK_URL, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 60000,
  });
  return normalizeN8nResponse(res.data);
}

async function callN8nApprove({ platform, token, threadId }) {
  const payload = {
    platform,
    token,
    thread_id: String(threadId || ""),
    source: "discord-bot",
  };

  const res = await axios.post(N8N_APPROVE_WEBHOOK_URL, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 180000,
  });

  return normalizeN8nResponse(res.data);
}

/** =========================
 *  Draft thread + messages
 *  ========================= */
function buildDraftMessages(draft) {
  // draft expected keys: fb_text, ig_caption, x_text, tiktok_caption, signal_text
  const fb = draft?.fb_text || "";
  const ig = draft?.ig_caption || "";
  const xt = draft?.x_text || "";
  const tt = draft?.tiktok_caption || "";
  const sg = draft?.signal_text || "";

  const blocks = [
    { label: "FACEBOOK", text: fb },
    { label: "INSTAGRAM", text: ig },
    { label: "X", text: xt },
    { label: "TIKTOK", text: tt },
    { label: "SIGNAL", text: sg },
  ];

  return blocks
    .filter((b) => String(b.text || "").trim().length > 0)
    .map((b) => `**${b.label}**\n${b.text}`);
}

async function createDraftThread(interaction, titleBase) {
  // If command invoked in a thread, reuse it; otherwise create a new thread in parent channel
  const ch = interaction.channel;

  if (ch?.isThread?.()) return ch;

  const parent = interaction.channel;
  if (!parent || typeof parent.threads?.create !== "function") {
    throw new Error("Cannot create thread in this channel.");
  }

  const thread = await parent.threads.create({
    name: titleBase,
    autoArchiveDuration: 1440,
    reason: "Social draft thread",
  });

  return thread;
}

/** =========================
 *  Interaction handler
 *  ========================= */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const okChannel = await ensureAllowedChannel(interaction);
    if (!okChannel) return;

    if (interaction.commandName === "post") {
      // IMPORTANT: defer immediately to avoid "L'applicazione non ha risposto"
      const deferred = await safeDefer(interaction);
      if (!deferred) return;

      const descrizione = interaction.options.getString("descrizione", true);
      const immagine = interaction.options.getAttachment("immagine", true);

      const descrizionePost = interaction.options.getString("descrizione_post", false) || "";
      const lingua = (interaction.options.getString("lingua", false) || DEFAULT_LANGUAGE).toLowerCase();
      const target = (interaction.options.getString("target", false) || DEFAULT_TARGET).toLowerCase();
      const link = interaction.options.getString("link", false) || "";
      const brand = interaction.options.getString("brand", false) || DEFAULT_BRAND;

      // call n8n draft workflow
      const draft = await callN8nDraft({
        description: descrizione,
        postDescription: descrizionePost,
        language: lingua,
        target,
        link,
        brand,
        discordGuildId: String(interaction.guildId || ""),
        discordChannelId: String(interaction.channelId || ""),
        discordUser: interaction.user?.username || "",
        attachmentUrl: immagine.url,
      });

      if (!draft) {
        await safeEdit(interaction, {
          content: "❌ Errore: risposta n8n vuota/non valida.",
        });
        return;
      }

      const approvalToken = draft.approval_token || draft.token || "";
      const stableMediaUrl = draft.stable_media_url || draft.image_url || immagine.url;

      // create thread + post drafts
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, "0");
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const yyyy = now.getFullYear();
      const title = `Bozza social · ${dd}/${mm}/${yyyy} · ${interaction.user?.username || "user"}`;

      const thread = await createDraftThread(interaction, title);

      const msgs = buildDraftMessages(draft);

      // First message: context + token
      const headerLines = [
        `🧾 **Bozza generata**`,
        `• Brand: **${brand}**`,
        `• Target: **${target}**`,
        `• Lingua: **${lingua}**`,
      ];
      if (descrizionePost.trim()) headerLines.push(`• Descrizione post: ${descrizionePost.trim()}`);
      if (link.trim()) headerLines.push(`• Link: ${link.trim()}`);
      if (approvalToken) headerLines.push(`\n🔑 **Token:** \`${approvalToken}\``);

      const headerMsg = await thread.send(headerLines.join("\n"));

      // Draft messages
      for (const m of msgs) {
        const parts = chunkText(m, 1800);
        for (const p of parts) await thread.send(p);
      }

      // Link thread->token into sheet (also store draft_message_id)
      try {
        await linkThreadToToken({
          threadId: thread.id,
          approvalToken,
          draftMessageId: headerMsg?.id || "",
          stableMediaUrl,
        });
      } catch (e) {
        console.error("linkThreadToToken failed:", e?.message || e);
      }

      await safeEdit(interaction, {
        content: `✅ Bozza creata nel thread: ${thread.url}${approvalToken ? `\nToken: \`${approvalToken}\`` : ""}`,
      });

      return;
    }

    if (interaction.commandName === "approvato") {
      const deferred = await safeDefer(interaction);
      if (!deferred) return;

      const platform = interaction.options.getString("piattaforma", true);
      const conferma = interaction.options.getString("conferma", true);
      let tokenOpt = interaction.options.getString("token", false) || "";

      if (conferma === "no") {
        await safeEdit(interaction, { content: "❎ Pubblicazione annullata." });
        return;
      }

      // Determine thread id: if command is invoked inside thread use that, else cannot
      const ch = interaction.channel;
      const threadId = ch?.isThread?.() ? ch.id : "";

      if (!tokenOpt) {
        if (!threadId) {
          await safeEdit(interaction, {
            content:
              "❌ Token mancante.\nUsa il comando **nel thread della bozza** (consigliato) oppure passa il token: `/approvato piattaforma:instagram conferma:si token:XXXX`",
          });
          return;
        }

        const got = await getTokenByThreadId(threadId);
        tokenOpt = got?.approval_token || got?.token || "";
      }

      if (!tokenOpt) {
        await safeEdit(interaction, {
          content:
            "❌ Token mancante.\nUsa il comando **nel thread della bozza** (consigliato) oppure passa il token: `/approvato piattaforma:instagram conferma:si token:XXXX`",
        });
        return;
      }

      const result = await callN8nApprove({
        platform,
        token: tokenOpt,
        threadId,
      });

      if (!result) {
        await safeEdit(interaction, { content: "❌ Errore: risposta n8n vuota/non valida." });
        return;
      }

      // Build a compact response
      const lines = [`✅ Pubblicazione avviata: **${platform}**`];
      if (result?.status) lines.push(`Status: **${result.status}**`);
      if (result?.posted_at) lines.push(`Posted at: ${result.posted_at}`);

      // urls (optional)
      const urlFields = [
        ["Facebook", result?.fb_post_url],
        ["Instagram", result?.ig_post_url],
        ["X", result?.x_post_url],
        ["TikTok", result?.tiktok_post_url],
        ["Signal", result?.signal_post_url],
      ];
      for (const [name, url] of urlFields) {
        if (url) lines.push(`${name}: ${url}`);
      }

      await safeEdit(interaction, { content: lines.join("\n") });
      return;
    }
  } catch (e) {
    console.error("interaction error:", e);
    await safeReply(interaction, {
      ephemeral: true,
      content: `❌ Errore: ${e?.message || "unknown"}`,
    });
  }
});

/** =========================
 *  Boot
 *  ========================= */
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
});

await registerCommands();
await client.login(DISCORD_BOT_TOKEN);
