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

// ===== ENV VARS =====
const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

const n8nDraftUrl = process.env.N8N_DRAFT_WEBHOOK_URL;
const n8nApproveUrl = process.env.N8N_APPROVE_WEBHOOK_URL;

const allowedChannelId = process.env.ALLOWED_CHANNEL_ID;

const DEFAULT_LANGUAGE = (process.env.DEFAULT_LANGUAGE || 'it').toLowerCase();
const DEFAULT_TARGET = (process.env.DEFAULT_TARGET || 'b2b').toLowerCase();
const DEFAULT_BRAND = process.env.DEFAULT_BRAND || 'idrogrow.com';

// ===== VALIDATION =====
if (!token || !clientId || !n8nDraftUrl || !n8nApproveUrl || !allowedChannelId) {
  throw new Error(
    'Missing required environment variables. Check Render settings.'
  );
}

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ===== SLASH COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName('post')
    .setDescription('Crea BOZZA multipiattaforma da immagine + descrizione')
    .addStringOption(opt =>
      opt.setName('descrizione').setDescription('Testo base').setRequired(true)
    )
    .addAttachmentOption(opt =>
      opt.setName('immagine').setDescription('Immagine da usare').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('lingua').setDescription('it / en').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('target').setDescription('b2b / b2c').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('link').setDescription('Link (opzionale)').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('brand').setDescription('Brand (opzionale)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('approvato')
    .setDescription('Approva e pubblica su una piattaforma o su tutte')
    .addStringOption(opt =>
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
    .addStringOption(opt =>
      opt.setName('token').setDescription('Approval token').setRequired(true)
    ),
].map(c => c.toJSON());

// ===== REGISTER COMMANDS =====
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log('✅ Slash commands registered');
}

// ===== UTILS =====
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

// ===== INTERACTIONS =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!(await ensureAllowedChannel(interaction))) return;

  // ===== /POST =====
  if (interaction.commandName === 'post') {
    const description = interaction.options.getString('descrizione', true);
    const attachment = interaction.options.getAttachment('immagine', true);

    const language =
      (interaction.options.getString('lingua') || DEFAULT_LANGUAGE).toLowerCase();
    const target =
      (interaction.options.getString('target') || DEFAULT_TARGET).toLowerCase();
    const link = interaction.options.getString('link') || '';
    const brand = interaction.options.getString('brand') || DEFAULT_BRAND;

    await interaction.deferReply({ ephemeral: true });

    try {
      const imgResp = await axios.get(attachment.url, {
        responseType: 'arraybuffer',
      });
      const imgBuffer = Buffer.from(imgResp.data);

      const form = new FormData();
      form.append('description', description);
      form.append('language', language);
      form.append('target', target);
      form.append('link', link);
      form.append('brand', brand);
      form.append('discord_guild_id', interaction.guildId || '');
      form.append('discord_channel_id', interaction.channelId || '');
      form.append('discord_user', interaction.user?.username || '');

      form.append('image', imgBuffer, {
        filename: attachment.name || 'image.jpg',
        contentType: attachment.contentType || 'image/jpeg',
      });

      const n8nResp = await axios.post(n8nDraftUrl, form, {
        headers: form.getHeaders(),
        timeout: 90000,
      });

      const data = n8nResp.data;
      if (!data?.ok) throw new Error(data?.error || 'n8n returned ok=false');

      const thread = await interaction.channel.threads.create({
        name: `Bozza social • ${interaction.user.username}`,
        autoArchiveDuration: 1440,
      });

      await thread.send(
        `🧾 **BOZZA GENERATA (PENDING APPROVAL)**\n🧩 Token: \`${data.approval_token}\`\n\n` +
          `Per pubblicare:\n` +
          `\`/approvato piattaforma:facebook token:${data.approval_token}\`\n` +
          `\`/approvato piattaforma:all token:${data.approval_token}\`\n`
      );

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

      await interaction.editReply(`✅ Bozza creata nel thread <#${thread.id}>`);
    } catch (err) {
      console.error(err);
      await interaction.editReply('❌ Errore generazione bozza.');
    }
  }

  // ===== /APPROVATO =====
  if (interaction.commandName === 'approvato') {
    const platform = interaction.options.getString('piattaforma', true);
    const approvalToken = interaction.options.getString('token', true);

    await interaction.deferReply({ ephemeral: true });

    try {
      const resp = await axios.post(n8nApproveUrl, {
        approval_token: approvalToken,
        platform,
      });

      const data = resp.data;

      await interaction.editReply(
        `✅ Approvazione inviata → ${platform.toUpperCase()}`
      );

      await interaction.channel.send(
        `✅ APPROVATO → ${platform.toUpperCase()} | Token: \`${approvalToken}\``
      );
    } catch (err) {
      console.error(err);
      await interaction.editReply('❌ Errore approvazione.');
    }
  }
});

// ===== READY =====
client.once('clientReady', () => {
  console.log(`🤖 Logged as ${client.user.tag}`);
});

await registerCommands();
client.login(token);

// ===== HEALTH SERVER FOR RENDER =====
const PORT = process.env.PORT || 10000;

http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('OK');
      return;
    }
    res.writeHead(200);
    res.end('Discord bot running');
  })
  .listen(PORT, () =>
    console.log(`🌐 Health server listening on port ${PORT}`)
  );
