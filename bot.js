// bot.js
// Discord bot: /post (draft) + /approvato (approve)
// Sends image+description to n8n Draft webhook (multipart with binary field "image")
// Sends approval_token + platform to n8n Approve webhook (JSON)
// Restricts usage to one channel: ALLOWED_CHANNEL_ID

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

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

const n8nDraftUrl = process.env.N8N_DRAFT_WEBHOOK_URL;
const n8nApproveUrl = process.env.N8N_APPROVE_WEBHOOK_URL;

const allowedChannelId = process.env.ALLOWED_CHANNEL_ID;

const DEFAULT_LANGUAGE = (process.env.DEFAULT_LANGUAGE || 'it').toLowerCase();
const DEFAULT_TARGET = (process.env.DEFAULT_TARGET || 'b2b').toLowerCase();
const DEFAULT_BRAND = process.env.DEFAULT_BRAND || 'idrogrow.com';

if (!token || !clientId || !n8nDraftUrl || !n8nApproveUrl || !allowedChannelId) {
  throw new Error(
    'Missing required env vars. Required: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, N8N_DRAFT_WEBHOOK_URL, N8N_APPROVE_WEBHOOK_URL, ALLOWED_CHANNEL_ID'
  );
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('post')
    .setDescription('Crea BOZZA multipiattaforma da immagine + descrizione (richiede approvazione)')
    .addStringOption((opt) =>
      opt.setName('descrizione').setDescription('Testo base').setRequired(true)
    )
    .addAttachmentOption((opt) =>
      opt.setName('immagine').setDescription('Immagine da usare').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('lingua').setDescription('it / en').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('target').setDescription('b2b / b2c').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('link').setDescription('Link prodotto/pagina (opzionale)').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('brand').setDescription('Brand/account (opzionale)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('approvato')
    .setDescription('Approva e avvia pubblicazione su una piattaforma o su tutte')
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
    .addStringOption((opt) =>
      opt.setName('token').setDescription('Approval token').setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log('✅ Slash commands registered');
}

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
    await interaction.reply({
      ephemeral: true,
      content: `⛔ Usa i comandi solo nel canale <#${allowedChannelId}>.`,
    });
    return false;
  }
  return true;
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Restrict to the allowed channel
  if (!(await ensureAllowedChannel(interaction))) return;

  // /post
  if (interaction.commandName === 'post') {
    const description = interaction.options.getString('descrizione', true);
    const attachment = interaction.options.getAttachment('immagine', true);

    const language = (interaction.options.getString('lingua') || DEFAULT_LANGUAGE).toLowerCase();
    const target = (interaction.options.getString('target') || DEFAULT_TARGET).toLowerCase();
    const link = interaction.options.getString('link') || '';
    const brand = interaction.options.getString('brand') || DEFAULT_BRAND;

    await interaction.deferReply({ ephemeral: true });

    try {
      // Download the attachment binary from Discord CDN
      const imgResp = await axios.get(attachment.url, { responseType: 'arraybuffer' });
      const imgBuffer = Buffer.from(imgResp.data);

      // Send multipart to n8n
      const form = new FormData();
      form.append('description', description);
      form.append('language', language);
      form.append('target', target);
      form.append('link', link);
      form.append('brand', brand);

      form.append('discord_guild_id', interaction.guildId || '');
      form.append('discord_channel_id', interaction.channelId || '');
      form.append('discord_user', interaction.user?.username || '');

      // IMPORTANT: field name must be "image" (matches n8n webhook binary field)
      form.append('image', imgBuffer, {
        filename: attachment.name || 'image.jpg',
        contentType: attachment.contentType || 'image/jpeg',
      });

      const n8nResp = await axios.post(n8nDraftUrl, form, {
        headers: form.getHeaders(),
        timeout: 90_000,
      });

      const data = n8nResp.data;
      if (!data?.ok) throw new Error(data?.error || 'n8n returned ok=false');

      // Create a thread for the draft
      const threadTitle = `Bozza social • ${new Date().toLocaleDateString('it-IT')} • ${interaction.user.username}`;
      const thread = await interaction.channel.threads.create({
        name: threadTitle.slice(0, 95),
        autoArchiveDuration: 1440, // 24h
        reason: 'Auto post social draft',
      });

      // Header with instructions
      const header =
        `🧾 **BOZZA GENERATA (PENDING APPROVAL)**\n` +
        `👤 Richiesta da: **${interaction.user.username}**\n` +
        `🧩 Token: \`${data.approval_token}\`\n` +
        (data.stable_media_url ? `🖼️ Media: ${data.stable_media_url}\n` : '') +
        `\n✅ Per pubblicare:\n` +
        `- \`/approvato piattaforma:facebook token:${data.approval_token}\`\n` +
        `- \`/approvato piattaforma:instagram token:${data.approval_token}\`\n` +
        `- \`/approvato piattaforma:x token:${data.approval_token}\`\n` +
        `- \`/approvato piattaforma:all token:${data.approval_token}\`\n`;

      await thread.send(header);

      // Send platform copies
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

      await interaction.editReply({
        content: `✅ Bozza creata nel thread: <#${thread.id}> (token: \`${data.approval_token}\`)`,
      });
    } catch (err) {
      console.error(err);
      await interaction.editReply(
        '❌ Errore: bozza non generata. Controlla webhook n8n (Production URL) e workflow Active.'
      );
    }
    return;
  }

  // /approvato
  if (interaction.commandName === 'approvato') {
    const platform = interaction.options.getString('piattaforma', true);
    const approvalToken = interaction.options.getString('token', true).trim();

    await interaction.deferReply({ ephemeral: true });

    try {
      const resp = await axios.post(
        n8nApproveUrl,
        { approval_token: approvalToken, platform },
        { timeout: 60_000 }
      );

      const data = resp.data;
      if (!data?.ok) throw new Error(data?.error || 'n8n returned ok=false');

      await interaction.editReply(
        `✅ Approvazione inviata: **${platform.toUpperCase()}** (token: \`${approvalToken}\`)\nStatus: **${data.status || 'OK'}**`
      );

      // Post a public confirmation in the channel (or current thread)
      await interaction.channel.send(
        `✅ **APPROVATO** → **${platform.toUpperCase()}**\nToken: \`${approvalToken}\`\nStatus: **${data.status || 'OK'}**`
      );
    } catch (err) {
      console.error(err);
      await interaction.editReply(
        '❌ Errore: approvazione fallita. Controlla webhook approve n8n e log.'
      );
    }
  }
});

client.once('ready', () => console.log(`🤖 Logged as ${client.user.tag}`));

await registerCommands();
client.login(token);
