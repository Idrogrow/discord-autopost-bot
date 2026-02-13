import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import axios from 'axios';
import FormData from 'form-data';
import http from 'http';

/** =========================
 *  Global crash protection
 *  ========================= */
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err);
});

/** =========================
 *  ENV
 *  ========================= */
const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

const n8nDraftUrl = process.env.N8N_DRAFT_WEBHOOK_URL;
const n8nApproveUrl = process.env.N8N_APPROVE_WEBHOOK_URL;
const n8nLinkThreadUrl = process.env.N8N_LINK_THREAD_WEBHOOK_URL;

const allowedChannelId = process.env.ALLOWED_CHANNEL_ID;

const DEFAULT_LANGUAGE = (process.env.DEFAULT_LANGUAGE || 'it').toLowerCase();
const DEFAULT_TARGET = (process.env.DEFAULT_TARGET || 'b2b').toLowerCase();
const DEFAULT_BRAND = process.env.DEFAULT_BRAND || 'idrogrow.com';

// Render Web Service requires a port bind
const PORT = process.env.PORT || 10000;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

requireEnv('DISCORD_BOT_TOKEN', token);
requireEnv('DISCORD_CLIENT_ID', clientId);
requireEnv('N8N_DRAFT_WEBHOOK_URL', n8nDraftUrl);
requireEnv('N8N_APPROVE_WEBHOOK_URL', n8nApproveUrl);
requireEnv('N8N_LINK_THREAD_WEBHOOK_URL', n8nLinkThreadUrl);
requireEnv('ALLOWED_CHANNEL_ID', allowedChannelId);

console.log('✅ Booting Discord AutoPost Bot');
console.log('N8N_DRAFT_WEBHOOK_URL:', n8nDraftUrl);
console.log('N8N_APPROVE_WEBHOOK_URL:', n8nApproveUrl);
console.log('N8N_LINK_THREAD_WEBHOOK_URL:', n8nLinkThreadUrl);
console.log('ALLOWED_CHANNEL_ID:', allowedChannelId);

/** =========================
 *  DISCORD CLIENT
 *  ========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('error', (e) => console.error('Discord client error:', e));
client.on('shardError', (e) => console.error('Discord shard error:', e));

/** =========================
 *  SLASH COMMANDS
 *  ========================= */
const commands = [
  new SlashCommandBuilder()
    .setName('post')
    .setDescription(
      'Crea BOZZA multipiattaforma da immagine + descrizione (richiede approvazione)'
    )
    .addStringOption((opt) =>
      opt.setName('descrizione').setDescription('Testo base').setRequired(true)
    )
    .addAttachmentOption((opt) =>
      opt
        .setName('immagine')
        .setDescription('Immagine da usare')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('lingua').setDescription('it / en').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('target').setDescription('b2b / b2c').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('link').setDescription('Link (opzionale)').setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('brand')
        .setDescription('Brand (opzionale)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('approvato')
    .setDescription('Approva e avvia pubblicazione su una piattaforma o su tutte (token automatico nel thread)')
    .addStringOption((opt) =>
      opt
        .setName('piattaforma')
        .setDescription('facebook / instagram / x / tiktok / signal / all')
        .setRequired(true)
        .addChoices(
          { name: 'facebook', value: 'facebook' },
          { name: 'instagram', value: 'instagram' },
          { name: 'x', value: 'x' },
          { name: 'tiktok', value: 'tiktok' },
          { name: 'signal', value: 'signal' },
          { name: 'all', value: 'all' }
        )
    )
    // ✅ token ora NON obbligatorio
    .addStringOption((opt) =>
      opt.setName('token').setDescription('Approval token (opzionale)').setRequired(false)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log('✅ Slash commands registered');
}

/** =========================
 *  HELPERS
 *  ========================= */
function chunkText(text, max = 1800) {
  const chunks = [];
  let s = text || '';
  while (s.length > max) {
    chunks.push(s.slice(0, max));
    s = s.slice(max);
  }
  if (s.length) chunks.push(s);
  return chunks;
}

async function ensureAllowedChannel(interaction) {
  if (interaction.channelId !== allowedChannelId) {
    try {
      await interaction.reply({
        ephemeral: true,
        content: `⛔ Usa i comandi solo nel canale <#${allowedChannelId}>.`,
      });
    } catch (e) {
      console.error('ensureAllowedChannel reply failed:', e?.code || e?.message);
    }
    return false;
  }
  return true;
}

async function safeDefer(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    return true;
  } catch (e) {
    // 10062 = Unknown interaction (expired)
    console.error('safeDefer failed:', e?.code || e?.message, e?.rawError || '');
    return false;
  }
}

async function safeEditReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
    } else {
      await interaction.reply({ ephemeral: true, content });
    }
  } catch (e) {
    console.error('safeEditReply failed:', e?.code || e?.message);
  }
}

function parseN8nResponse(data) {
  // n8n a volte risponde con TEXT contenente JSON (stringa)
  if (typeof data === 'string') {
    const s = data.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        return JSON.parse(s);
      } catch {
        // fallthrough
      }
    }
    return { ok: false, error: `n8n returned non-JSON text: ${s.slice(0, 200)}` };
  }
  return data;
}

/** =========================
 *  MAIN HANDLER
 *  ========================= */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!(await ensureAllowedChannel(interaction))) return;

  /** -------- /post -------- */
  if (interaction.commandName === 'post') {
    const ok = await safeDefer(interaction);
    if (!ok) return;

    const description = interaction.options.getString('descrizione', true);
    const attachment = interaction.options.getAttachment('immagine', true);

    const language = (
      interaction.options.getString('lingua') || DEFAULT_LANGUAGE
    ).toLowerCase();
    const target = (
      interaction.options.getString('target') || DEFAULT_TARGET
    ).toLowerCase();
    const link = interaction.options.getString('link') || '';
    const brand = interaction.options.getString('brand') || DEFAULT_BRAND;

    try {
      console.log('➡️ /post received:', {
        user: interaction.user?.username,
        channelId: interaction.channelId,
        attachmentUrl: attachment?.url,
        proxyUrl: attachment?.proxyURL,
        filename: attachment?.name,
      });

      // 1) download attachment (proxyURL is often more stable)
      const downloadUrl = attachment.proxyURL || attachment.url;
      console.log('Downloading image from:', downloadUrl);

      const imgResp = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 10_000,
        maxBodyLength: Infinity,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const imgBuffer = Buffer.from(imgResp.data);

      // 2) send multipart to n8n (draft)
      const form = new FormData();
      form.append('description', description);
      form.append('language', language);
      form.append('target', target);
      form.append('link', link);
      form.append('brand', brand);
      form.append('discord_guild_id', interaction.guildId || '');
      form.append('discord_channel_id', interaction.channelId || '');
      form.append('discord_user', interaction.user?.username || '');

      // IMPORTANT: field name must be "image"
      form.append('image', imgBuffer, {
        filename: attachment.name || 'image.jpg',
        contentType: attachment.contentType || 'image/jpeg',
      });

      const n8nResp = await axios.post(n8nDraftUrl, form, {
        headers: form.getHeaders(),
        timeout: 90_000,
        maxBodyLength: Infinity,
      });

      const data = parseN8nResponse(n8nResp.data);
      console.log('⬅️ n8n draft response:', data);

      if (!data?.ok) {
        throw new Error(data?.error || 'n8n returned ok=false');
      }

      // 3) create thread
      const threadTitle = `Bozza social • ${new Date().toLocaleDateString(
        'it-IT'
      )} • ${interaction.user.username}`;

      const thread = await interaction.channel.threads.create({
        name: threadTitle.slice(0, 95),
        autoArchiveDuration: 1440,
        reason: 'Auto post social draft',
      });

      // 4) link token ↔ thread in sheet (NEW)
      try {
        await axios.post(
          n8nLinkThreadUrl,
          {
            approval_token: data.approval_token,
            discord_thread_id: thread.id,
            discord_guild_id: interaction.guildId || '',
            discord_channel_id: interaction.channelId || '',
            discord_user: interaction.user?.username || '',
          },
          { timeout: 20_000 }
        );
      } catch (e) {
        console.error('⚠️ link-thread failed (non blocco la bozza):', e?.message);
      }

      const header =
        `🧾 **BOZZA GENERATA (PENDING APPROVAL)**\n` +
        `👤 Richiesta da: **${interaction.user.username}**\n` +
        `🧩 Token: \`${data.approval_token}\`\n` +
        (data.stable_media_url ? `🖼️ Media: ${data.stable_media_url}\n` : '') +
        `\n✅ Per pubblicare (nel thread, token automatico):\n` +
        `- \`/approvato piattaforma:facebook\`\n` +
        `- \`/approvato piattaforma:instagram\`\n` +
        `- \`/approvato piattaforma:x\`\n` +
        `- \`/approvato piattaforma:all\`\n` +
        `\n(Se vuoi forzare: \`/approvato piattaforma:x token:${data.approval_token}\`)\n`;

      await thread.send(header);

      const blocks = [
        { title: 'INSTAGRAM', body: data.ig_caption },
        { title: 'FACEBOOK', body: data.fb_text },
        { title: 'X', body: data.x_text },
        { title: 'TIKTOK', body: data.tiktok_caption },
        { title: 'SIGNAL', body: data.signal_text },
      ];

      for (const b of blocks) {
        const txt = `**${b.title}**\n${b.body || '(vuoto)'}`;
        for (const part of chunkText(txt)) {
          await thread.send(part);
        }
      }

      await safeEditReply(interaction, `✅ Bozza creata nel thread: <#${thread.id}>`);
      return;
    } catch (err) {
      const status = err?.response?.status;
      const respData = err?.response?.data;
      const msg = err?.message;

      console.error('❌ /post failed:', { status, respData, msg });

      await safeEditReply(
        interaction,
        `❌ Errore generazione bozza.\n` +
          `status: ${status ?? 'n/a'}\n` +
          `msg: ${msg ?? 'n/a'}\n` +
          `data: ${respData ? JSON.stringify(respData).slice(0, 800) : 'n/a'}`
      );
      return;
    }
  }

  /** -------- /approvato -------- */
  if (interaction.commandName === 'approvato') {
    const ok = await safeDefer(interaction);
    if (!ok) return;

    const platform = interaction.options.getString('piattaforma', true);
    const approvalToken = (interaction.options.getString('token') || '').trim();

    // Se NON metti token, devi lanciare il comando nel thread della bozza
    const payload =
      approvalToken
        ? { approval_token: approvalToken, platform }
        : {
            platform,
            discord_thread_id: interaction.channelId, // nel thread = threadId
            discord_guild_id: interaction.guildId || '',
            discord_user: interaction.user?.username || '',
          };

    try {
      const resp = await axios.post(n8nApproveUrl, payload, { timeout: 60_000 });
      const data = parseN8nResponse(resp.data);

      console.log('⬅️ n8n approve response:', data);

      if (!data?.ok) {
        throw new Error(data?.error || 'n8n returned ok=false');
      }

      await safeEditReply(
        interaction,
        `✅ Approvazione inviata → **${platform.toUpperCase()}**`
      );
    } catch (err) {
      const status = err?.response?.status;
      const respData = err?.response?.data;
      const msg = err?.message;

      console.error('❌ /approvato failed:', { status, respData, msg });

      await safeEditReply(
        interaction,
        `❌ Errore approvazione.\n` +
          `status: ${status ?? 'n/a'}\n` +
          `msg: ${msg ?? 'n/a'}\n` +
          `data: ${respData ? JSON.stringify(respData).slice(0, 800) : 'n/a'}`
      );
    }
  }
});

/** =========================
 *  READY
 *  ========================= */
client.once('clientReady', () => {
  console.log(`🤖 Logged as ${client.user.tag}`);
});

await registerCommands();
client.login(token);

/** =========================
 *  HEALTH SERVER (Render)
 *  ========================= */
http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Idrogrow Discord bot running');
  })
  .listen(PORT, () => {
    console.log(`🌐 Health server listening on ${PORT}`);
  });
