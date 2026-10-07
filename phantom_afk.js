'use strict';

/**
 * ============================================================================
 * PhantomAFK: Autonomous 24/7 Minecraft AFK Sentinel & Discord Remote Bridge
 * Tested on: GamerTee Network (play.gamertee.net)
 * Optimized for: Android Termux & Low-Resource Environments
 * Educational Purposes Only
 * ============================================================================
 */

const mineflayer = require('mineflayer');
const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { RealmJoiner } = require('./realm_join');

// ─── CONFIGURATION LOADER ───────────────────────────────────────────────────
// Loads with precedence: config.json -> process.env -> safe empty defaults
let fileConfig = {};
try {
  const cfgPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) {
    fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
} catch (_) {}

const CONFIG = {
  host: process.env.MC_HOST || fileConfig.host || 'play.gamertee.net',
  port: parseInt(process.env.MC_PORT || fileConfig.port || '25565', 10),
  version: process.env.MC_VERSION || fileConfig.version || '1.20.4',
  username: process.env.MC_USERNAME || fileConfig.username || 'PhantomSentinel',
  password: process.env.MC_PASSWORD || fileConfig.password || '',
  compassSlot: parseInt(process.env.COMPASS_SLOT || (fileConfig.compassSlot != null ? fileConfig.compassSlot : 4), 10),
  lifestealSlot: parseInt(process.env.LIFESTEAL_SLOT || (fileConfig.lifestealSlot != null ? fileConfig.lifestealSlot : 15), 10),
  reconnectDelayMs: parseInt(process.env.RECONNECT_DELAY_MS || fileConfig.reconnectDelayMs || '15000', 10),
  discord: {
    token: process.env.DISCORD_TOKEN || fileConfig.discord?.token || '',
    controlChannelId: process.env.DISCORD_CONTROL_CHANNEL || fileConfig.discord?.controlChannelId || '',
    panelMessageId: process.env.DISCORD_PANEL_MESSAGE || fileConfig.discord?.panelMessageId || null,
    chatChannelId: process.env.DISCORD_CHAT_CHANNEL || fileConfig.discord?.chatChannelId || '',
    rosterChannelId: process.env.DISCORD_ROSTER_CHANNEL || fileConfig.discord?.rosterChannelId || '',
    founderChannelId: process.env.DISCORD_FOUNDER_CHANNEL || fileConfig.discord?.founderChannelId || ''
  }
};

const LOG_FILE = path.join(__dirname, 'phantom_runtime.log');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(tag, message) {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] [PHANTOM] [${tag}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

// ─── DISCORD REST API DISPATCHER (ZERO EXTERNAL DISCORD LIBS) ───────────────
function discordApiRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve) => {
    if (!CONFIG.discord.token) return resolve({ ok: false, error: 'No token configured' });
    try {
      const payload = body ? JSON.stringify(body) : '';
      const req = https.request({
        hostname: 'discord.com',
        port: 443,
        path: '/api/v10' + endpoint,
        method: method,
        headers: {
          'Authorization': `Bot ${CONFIG.discord.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'PhantomAFK-Sentinel/1.0'
        },
        timeout: 10000
      }, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { if (responseData) parsed = JSON.parse(responseData); } catch (_) {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      if (body) req.write(payload);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

// ─── LOGGING BATCH QUEUES (JOIN/LEAVE & CHAT BRIDGE) ─────────────────────────
let chatBatch = [];
let chatFlushTimer = null;
let rosterBatch = [];
let rosterFlushTimer = null;

function queueChatLog(text) {
  if (!CONFIG.discord.chatChannelId || !text || text.length < 2) return;
  chatBatch.push(text);
  if (!chatFlushTimer) {
    chatFlushTimer = setTimeout(flushChatBatch, 2000);
  }
}

async function flushChatBatch() {
  chatFlushTimer = null;
  if (chatBatch.length === 0) return;
  const lines = chatBatch.splice(0, 15);
  const content = lines.join('\n').slice(0, 1950);
  await discordApiRequest(`/channels/${CONFIG.discord.chatChannelId}/messages`, 'POST', { content });
  if (chatBatch.length > 0) {
    chatFlushTimer = setTimeout(flushChatBatch, 1500);
  }
}

function queueRosterLog(text) {
  if (!CONFIG.discord.rosterChannelId || !text) return;
  rosterBatch.push(text);
  if (!rosterFlushTimer) {
    rosterFlushTimer = setTimeout(flushRosterBatch, 2500);
  }
}

async function flushRosterBatch() {
  rosterFlushTimer = null;
  if (rosterBatch.length === 0) return;
  const lines = rosterBatch.splice(0, 15);
  const content = lines.join('\n').slice(0, 1950);
  await discordApiRequest(`/channels/${CONFIG.discord.rosterChannelId}/messages`, 'POST', { content });
  if (rosterBatch.length > 0) {
    rosterFlushTimer = setTimeout(flushRosterBatch, 2000);
  }
}

// ─── STATE MANAGEMENT ───────────────────────────────────────────────────────
let bot = null;
let realmJoiner = null;
let inLifesteal = false;
let isEating = false;
let afkInterval = null;
let lastWhisperSender = null;
let botStartTime = Date.now();

// ─── DISCORD GATEWAY WEBSOCKET CLIENT ───────────────────────────────────────
class DiscordGatewayClient {
  constructor() {
    this.ws = null;
    this.heartbeatTimer = null;
    this.botUserId = null;
    this.reconnectAttempts = 0;
    this.isGatewayRunning = false;
  }

  start() {
    if (this.isGatewayRunning || !CONFIG.discord.token) return;
    this.isGatewayRunning = true;

    const connect = () => {
      try {
        log('GATEWAY', 'Connecting to Discord Gateway WebSocket...');
        this.ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

        this.ws.on('open', () => {
          log('GATEWAY', 'WebSocket connected to Discord Gateway.');
          this.reconnectAttempts = 0;
        });

        this.ws.on('message', (raw) => {
          try {
            const packet = JSON.parse(raw);
            this._handlePacket(packet);
          } catch (_) {}
        });

        this.ws.on('close', (code) => {
          log('GATEWAY', `Gateway closed (code: ${code}). Reconnecting...`);
          this._cleanupHeartbeat();
          const delay = Math.min(30000, (2 ** this.reconnectAttempts) * 1500);
          this.reconnectAttempts++;
          setTimeout(connect, delay);
        });

        this.ws.on('error', (err) => {
          log('GATEWAY_ERR', `Gateway socket error: ${err.message}`);
          try { this.ws.close(); } catch (_) {}
        });
      } catch (err) {
        log('GATEWAY_ERR', err.message);
        setTimeout(connect, 5000);
      }
    };

    connect();
  }

  _cleanupHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _handlePacket(packet) {
    const { op, d, t } = packet;

    if (op === 10) {
      const interval = d.heartbeat_interval;
      this._cleanupHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: 1, d: null }));
        }
      }, interval);

      this.ws.send(JSON.stringify({
        op: 2,
        d: {
          token: CONFIG.discord.token,
          intents: 37377, // Guilds + GuildMessages + MessageContent + DirectMessages
          properties: {
            os: 'android',
            browser: 'PhantomAFK Sentinel',
            device: 'termux'
          }
        }
      }));
      return;
    }

    if (op === 0) {
      if (t === 'READY') {
        this.botUserId = d.user?.id;
        log('GATEWAY', `Authenticated as Discord Bot: ${d.user?.username} (${this.botUserId})`);
        return;
      }

      if (t === 'MESSAGE_CREATE') {
        this._handleMessage(d);
        return;
      }
    }
  }

  async _handleMessage(msg) {
    if (!msg || msg.author?.bot) return;
    if (CONFIG.discord.controlChannelId && msg.channel_id !== CONFIG.discord.controlChannelId) return;

    const content = (msg.content || '').trim();
    if (!content.startsWith('!')) return;

    const parts = content.slice(1).trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    const channelId = msg.channel_id;

    log('DISCORD_CMD', `Received command "!${cmd}" from ${msg.author.username}`);

    switch (cmd) {
      case 'help':
        await discordApiRequest(`/channels/${channelId}/messages`, 'POST', {
          embeds: [{
            title: '👻 PhantomAFK Remote Commands',
            description: [
              '`!status` — View uptime, health, coordinates & server state',
              '`!afk` — Send `/warp afk` to position at AFK arena',
              '`!coords` — Get exact in-game XYZ coordinates',
              '`!inv` — List hotbar and inventory summary',
              '`!eat` — Force consumption of food from inventory',
              '`!jump` — Trigger micro-jump packet',
              '`!sneak` / `!unsneak` — Toggle sneak state',
              '`!say <msg>` — Broadcast message in server chat',
              '`!whisper <player> <msg>` — Send private whisper',
              '`!reply <msg>` — Reply to last whisper sender'
            ].join('\n'),
            color: 0x5865F2,
            footer: { text: 'PhantomAFK Sentinel • GamerTee Network' }
          }]
        });
        break;

      case 'status': {
        const uptimeSec = Math.floor((Date.now() - botStartTime) / 1000);
        const hours = Math.floor(uptimeSec / 3600);
        const mins = Math.floor((uptimeSec % 3600) / 60);
        const secs = uptimeSec % 60;
        const pos = bot?.entity?.position ? `${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}` : 'Unknown';

        await discordApiRequest(`/channels/${channelId}/messages`, 'POST', {
          embeds: [{
            title: `📊 ${CONFIG.username} Live Status`,
            fields: [
              { name: 'State', value: inLifesteal ? '🟢 In Lifesteal Realm' : '🟡 In Lobby / Transfer', inline: true },
              { name: 'Uptime', value: `${hours}h ${mins}m ${secs}s`, inline: true },
              { name: 'Ping', value: `${bot?.player?.ping || 0}ms`, inline: true },
              { name: 'Health', value: `${bot?.health != null ? Math.round(bot.health) : 'N/A'} / 20 ❤️`, inline: true },
              { name: 'Hunger', value: `${bot?.food != null ? Math.round(bot.food) : 'N/A'} / 20 🍗`, inline: true },
              { name: 'Coordinates', value: `\`${pos}\``, inline: true }
            ],
            color: inLifesteal ? 0x2ECC71 : 0xF1C40F,
            timestamp: new Date().toISOString()
          }]
        });
        break;
      }

      case 'afk':
        if (bot && bot.entity) {
          bot.chat('/warp afk');
          await discordApiRequest(`/channels/${channelId}/messages`, 'POST', {
            content: '🟢 Issued `/warp afk`. Moving to AFK Arena.'
          });
        }
        break;

      case 'coords':
        if (bot?.entity?.position) {
          const p = bot.entity.position;
          await discordApiRequest(`/channels/${channelId}/messages`, 'POST', {
            content: `📍 Current coordinates: \`X: ${p.x.toFixed(2)}, Y: ${p.y.toFixed(2)}, Z: ${p.z.toFixed(2)}\``
          });
        } else {
          await discordApiRequest(`/channels/${channelId}/messages`, 'POST', { content: '⚠️ Bot entity position not available.' });
        }
        break;

      case 'say':
        if (args.length > 0 && bot) {
          bot.chat(args.join(' '));
          await discordApiRequest(`/channels/${channelId}/messages`, 'POST', { content: `💬 Sent: "${args.join(' ')}"` });
        }
        break;

      case 'whisper':
      case 'msg':
        if (args.length >= 2 && bot) {
          const target = args[0];
          const text = args.slice(1).join(' ');
          bot.chat(`/msg ${target} ${text}`);
          await discordApiRequest(`/channels/${channelId}/messages`, 'POST', { content: `📨 Whispered to **${target}**: "${text}"` });
        }
        break;

      case 'reply':
        if (args.length > 0 && bot && lastWhisperSender) {
          const text = args.join(' ');
          bot.chat(`/msg ${lastWhisperSender} ${text}`);
          await discordApiRequest(`/channels/${channelId}/messages`, 'POST', { content: `↩️ Replied to **${lastWhisperSender}**: "${text}"` });
        }
        break;

      case 'eat':
        await performAutoEat(true);
        await discordApiRequest(`/channels/${channelId}/messages`, 'POST', { content: '🍗 Eating cycle executed.' });
        break;

      case 'jump':
        if (bot && bot.entity) {
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 400);
          await discordApiRequest(`/channels/${channelId}/messages`, 'POST', { content: '🦘 Jumped.' });
        }
        break;

      case 'sneak':
        if (bot && bot.entity) {
          bot.setControlState('sneak', true);
          await discordApiRequest(`/channels/${channelId}/messages`, 'POST', { content: '🔻 Sneaking enabled.' });
        }
        break;

      case 'unsneak':
        if (bot && bot.entity) {
          bot.setControlState('sneak', false);
          await discordApiRequest(`/channels/${channelId}/messages`, 'POST', { content: '🔺 Sneaking disabled.' });
        }
        break;
    }
  }
}

// ─── AUTO EATING LOGIC ──────────────────────────────────────────────────────
const FOOD_NAMES = [
  'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton',
  'cooked_chicken', 'bread', 'baked_potato', 'cooked_cod', 'cooked_salmon',
  'golden_apple', 'enchanted_golden_apple', 'apple'
];

async function performAutoEat(force = false) {
  if (!bot || !bot.entity || isEating) return;
  if (!force && (bot.food == null || bot.food > 14)) return;

  const item = bot.inventory.items().find(i => FOOD_NAMES.includes(i.name));
  if (!item) return;

  isEating = true;
  try {
    log('EAT', `Equipping ${item.name} to eat...`);
    await bot.equip(item, 'hand');
    await bot.consume();
    log('EAT', 'Food consumed successfully.');
  } catch (err) {
    log('EAT_ERR', `Could not eat: ${err.message}`);
  } finally {
    isEating = false;
  }
}

// ─── ANTI-KICK MICRO KEEPALIVE ──────────────────────────────────────────────
function startAfkKeepAlive() {
  if (afkInterval) clearInterval(afkInterval);
  afkInterval = setInterval(async () => {
    if (!bot || !bot.entity || !inLifesteal) return;
    try {
      // Gentle micro-rotation without moving position
      const yaw = bot.entity.yaw + (Math.random() * 0.1 - 0.05);
      const pitch = bot.entity.pitch + (Math.random() * 0.1 - 0.05);
      await bot.look(yaw, pitch, true);
      await performAutoEat(false);
    } catch (_) {}
  }, 45000);
}

// ─── MINEFLAYER BOT FACTORY & LIFECYCLE ──────────────────────────────────────
function startBot() {
  log('INIT', `Connecting to ${CONFIG.host}:${CONFIG.port} as ${CONFIG.username}...`);

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: 'offline',
    checkTimeoutInterval: 60000
  });

  inLifesteal = false;
  isEating = false;

  realmJoiner = new RealmJoiner({
    password: CONFIG.password,
    keyword: 'lifesteal',
    compassSlot: CONFIG.compassSlot,
    targetSlot: CONFIG.lifestealSlot
  });

  realmJoiner.on('log', (msg) => log('NAV', msg));

  realmJoiner.on('realm', async ({ via }) => {
    inLifesteal = true;
    log('REALM', `Entered Lifesteal realm via ${via}!`);
    startAfkKeepAlive();

    await sleep(4000);
    if (bot && bot.entity) {
      log('REALM', 'Sending /warp afk to station at AFK Arena...');
      bot.chat('/warp afk');
    }
  });

  bot.on('login', () => {
    log('LOGIN', `Logged in. Entity ID: ${bot.entity?.id}`);
    realmJoiner.attach(bot);
  });

  bot.on('messagestr', (raw) => {
    const clean = String(raw || '').replace(/§[0-9a-fk-or]/gi, '').trim();
    if (!clean) return;

    // Track whisper sender for Discord !reply
    if (/whispers to you|whispers:|\[.+-> me\]/i.test(clean)) {
      const match = clean.match(/^([A-Za-z0-9_]{3,16})\s+whispers/i) || clean.match(/^\[([A-Za-z0-9_]{3,16})\s*->\s*me\]/i);
      if (match) lastWhisperSender = match[1];
    }

    queueChatLog(clean);
  });

  bot.on('playerJoined', (player) => {
    if (player && player.username && inLifesteal) {
      queueRosterLog(`📥 **${player.username}** joined the realm.`);
    }
  });

  bot.on('playerLeft', (player) => {
    if (player && player.username && inLifesteal) {
      queueRosterLog(`📤 **${player.username}** left the realm.`);
    }
  });

  bot.on('kicked', (reason) => {
    log('KICKED', `Bot was kicked: ${JSON.stringify(reason)}`);
  });

  bot.on('end', () => {
    log('END', `Connection terminated. Reconnecting in ${CONFIG.reconnectDelayMs / 1000}s...`);
    inLifesteal = false;
    if (afkInterval) clearInterval(afkInterval);
    if (realmJoiner) realmJoiner.destroy();
    setTimeout(startBot, CONFIG.reconnectDelayMs);
  });

  bot.on('error', (err) => {
    log('ERR', `Bot error: ${err.message}`);
  });
}

// ─── PROCESS ENTRYPOINT ─────────────────────────────────────────────────────
const gatewayClient = new DiscordGatewayClient();
gatewayClient.start();
startBot();
