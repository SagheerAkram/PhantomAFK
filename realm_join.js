'use strict';

/**
 * ============================================================================
 * PhantomAFK: Queue-Safe Lobby & Realm Navigator
 * Tested on GamerTee Network (play.gamertee.net)
 * ============================================================================
 * - Fast DNS: Enforces IPv4 and public nameservers to avoid DNS lookup stalls.
 * - Handles Velocity proxy hops without resetting state.
 * - Selects & activates Hotbar Slot 4 (compass).
 * - Paced transfer: Locks click and gives the server time to complete backend hop.
 * - PROTECTS QUEUE STATE: When queued, halts compass spam to preserve queue spot.
 * - Detects Realm entry via 4 independent signals (backend switch, scoreboards,
 *   coordinates, and realm chat triggers).
 * ============================================================================
 */

const dns = require('dns');
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['1.1.1.1', '8.8.8.8']);
} catch (_) {}

const EventEmitter = require('events');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RealmJoiner extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.password = cfg.password || null;
    this.keyword = (cfg.keyword || 'lifesteal').toLowerCase();
    this.compassSlot = cfg.compassSlot != null ? cfg.compassSlot : 4;
    this.targetSlot = cfg.targetSlot != null ? cfg.targetSlot : 15;
    this.targetItem = (cfg.targetItem || 'netherite_chestplate').toLowerCase();

    this.inRealm = false;
    this.inQueue = false;
    this.clicked = false;
    this.bot = null;
    this._checkingRealm = null;
    this._spawnHandled = false;
    this._destroyed = false;
    this._logins = 0;
    this._queueWaits = 0;
  }

  destroy() {
    this._destroyed = true;
    if (this._checkingRealm) {
      clearInterval(this._checkingRealm);
      this._checkingRealm = null;
    }
  }

  reset() {
    this._destroyed = false;
    this._logins = 0;
    this._queueWaits = 0;
    this.inRealm = false;
    this.inQueue = false;
    this.clicked = false;
    this._spawnHandled = false;
  }

  attach(bot) {
    this.bot = bot;
    this.reset();

    bot.on('messagestr', (raw) => this._onMessage(String(raw || '')));

    bot.on('windowOpen', (win) => {
      this._onWindow(win).catch((err) => {
        this.emit('log', `Window handler error: ${err.message}`);
      });
    });

    if (bot._client) {
      bot._client.on('login', () => {
        this._logins = (this._logins || 0) + 1;
        if (this._logins > 1) {
          this._enteredRealm(`backend switch (login #${this._logins})`);
        }
      });
      bot._client.on('respawn', () => {
        this._respawns = (this._respawns || 0) + 1;
        this.emit('log', `Velocity respawn/transfer packet detected (#${this._respawns})`);
        if (this.clicked || this._respawns > 0) {
          this._enteredRealm(`proxy transfer (respawn #${this._respawns})`);
        }
      });
    }

    bot.on('scoreboardTitleChanged', (sb) => {
      this._checkScoreboardTitle(sb.title);
    });

    bot.on('scoreUpdated', (item) => {
      const name = String(item.displayName || item.name || '').toLowerCase();
      if (name.includes(this.keyword) || name.includes('strength')) {
        this._enteredRealm('score-item');
      }
    });

    bot.on('spawn', () => {
      this._onSpawn().catch((err) => {
        this.emit('log', `Spawn handler error: ${err.message}`);
      });
    });

    if (this._checkingRealm) clearInterval(this._checkingRealm);
    this._checkingRealm = setInterval(() => {
      if (!this.bot || !this.bot.entity || this.inRealm) return;
      this._checkRealmState('timer');
    }, 2500);
  }

  _checkScoreboardTitle(title) {
    const t = String(title || '').replace(/§[0-9a-fk-or]/gi, '').toLowerCase();
    if (t.includes(this.keyword) || t.includes('strength') || t.includes('tab-scoreboard')) {
      this._enteredRealm('scoreboard');
    }
  }

  _checkRealmState(via = 'state-check') {
    if (this.inRealm || !this.bot || !this.bot.entity) return;

    const pos = this.bot.entity.position;
    if (pos.x < -500 || pos.x > 500 || pos.z < -500 || pos.z > 500) {
      this._enteredRealm(`coordinates (${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)})`);
      return;
    }

    const boards = this.bot.scoreboards || {};
    for (const name of Object.keys(boards)) {
      const t = String(boards[name].title || '').replace(/§[0-9a-fk-or]/gi, '').toLowerCase();
      if (t.includes(this.keyword) || t.includes('strength') || t.includes('tab-scoreboard')) {
        this._enteredRealm(`scoreboard (${name})`);
        return;
      }
    }
  }

  _enteredRealm(via) {
    if (this.inRealm) return;
    this.inRealm = true;
    this.inQueue = false;
    this.clicked = false;
    if (this._checkingRealm) {
      clearInterval(this._checkingRealm);
      this._checkingRealm = null;
    }
    this.emit('log', `Entered target realm! (via ${via})`);
    this.emit('realm', { via });
  }

  _onMessage(raw) {
    const msg = raw.replace(/§[0-9a-fk-or]/gi, '');
    const low = msg.toLowerCase();

    if (this.password) {
      if (low.includes('please login') || low.includes('use /login') || low.includes('/login <password>')) {
        this.emit('log', 'Server requested authentication, sending /login...');
        try { this.bot.chat(`/login ${this.password}`); } catch (_) {}
        return;
      }
      if (low.includes('please register') || low.includes('use /register') || low.includes('/register <password>')) {
        this.emit('log', 'Server requested registration, sending /register...');
        try { this.bot.chat(`/register ${this.password} ${this.password}`); } catch (_) {}
        return;
      }
    }

    if (msg.includes('You are in Queue') || /in queue/i.test(low)) {
      this.inQueue = true;
      this.emit('log', `Queue detected: ${msg.trim()}`);
      this.emit('queue', msg.trim());
      return;
    }

    if (!this.inRealm && (
      low.includes(this.keyword) ||
      msg.includes('TELEPORT ➟') ||
      msg.includes('LAG ➟') ||
      msg.includes('Available Warps') ||
      msg.includes('has claimed') ||
      low.includes('welcome to lifesteal')
    )) {
      this._enteredRealm('chat');
    }
  }

  async _onSpawn() {
    if (this._spawnHandled) {
      this.emit('log', 'Subsequent spawn event (proxy hop)');
      if (this.clicked) {
        this._enteredRealm('spawn event after menu click');
      }
      return;
    }
    this._spawnHandled = true;
    this.clicked = false;

    // Allow lobby hotbar items to fully initialize
    await sleep(3500);
    if (this._destroyed || this.inRealm || !this.bot || !this.bot.entity) return;

    this._checkRealmState('spawn');
    if (this.inRealm) return;

    const RETRY_INTERVAL_MS = 32000;

    while (!this._destroyed && !this.inRealm && this.bot && this.bot.entity) {
      if (this.inQueue) {
        this.emit('log', 'In transfer queue — waiting patiently (preserving queue position)...');
        await sleep(15000);
        if (this._destroyed || this.inRealm || !this.bot || !this.bot.entity) return;
        this._queueWaits = (this._queueWaits || 0) + 1;
        if (this._queueWaits > 20) {
          this.emit('log', 'Queue wait timeout — refreshing selector');
          this.inQueue = false;
          this.clicked = false;
          this._queueWaits = 0;
        }
        continue;
      }

      if (this.clicked) {
        this._pendingWaits = (this._pendingWaits || 0) + 1;
        if (this._pendingWaits < 6) {
          this.emit('log', 'Transfer pending — awaiting proxy transfer...');
          await sleep(6000);
          continue;
        } else {
          this.emit('log', 'Transfer wait elapsed — re-opening selector...');
          this.clicked = false;
          this._pendingWaits = 0;
        }
      }

      await this._activateCompass();

      await sleep(RETRY_INTERVAL_MS);
      if (this._destroyed || this.inRealm || !this.bot || !this.bot.entity) return;

      const pos = this.bot.entity.position;
      const inLobby = pos.x > -500 && pos.x < 500 && pos.z > -500 && pos.z < 500;
      if (!inLobby) {
        this._enteredRealm(`coords (${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)})`);
        return;
      }
    }
  }

  async _activateCompass() {
    if (this._destroyed || this.inRealm || !this.bot || !this.bot.entity) return;

    let compassIndex = this.compassSlot;
    if (this.bot.inventory) {
      for (let i = 0; i < 9; i++) {
        const it = this.bot.inventory.slots[36 + i];
        if (it && it.name && it.name.toLowerCase().includes('compass')) {
          compassIndex = i;
          break;
        }
      }
    }

    this.emit('log', `Selecting compass hotbar slot ${compassIndex}...`);
    try {
      this.bot.setQuickBarSlot(compassIndex);
      await sleep(500);
      this.emit('log', 'Activating compass to open Server Selector GUI...');
      this.bot.activateItem();
    } catch (e) {
      this.emit('log', `Could not activate compass: ${e.message}`);
    }
  }

  async _onWindow(win) {
    if (this._destroyed || this.inRealm || this.clicked) return;

    await sleep(650);
    if (this._destroyed || !this.bot || !this.bot.entity || this.inRealm || this.clicked) return;

    let slot = -1;
    let why = '';

    slot = win.slots.findIndex((it) => it && JSON.stringify(it).toLowerCase().includes(this.keyword));
    if (slot !== -1) why = `keyword "${this.keyword}"`;

    if (slot === -1 && Number.isInteger(this.targetSlot) && win.slots[this.targetSlot]) {
      slot = this.targetSlot;
      why = `configured slot ${this.targetSlot}`;
    }

    if (slot === -1) {
      slot = win.slots.findIndex((it) => it && it.name && it.name.toLowerCase().includes(this.targetItem));
      if (slot !== -1) why = `item type "${this.targetItem}"`;
    }

    if (slot === -1) {
      this.emit('log', `Could not find "${this.keyword}" in menu.`);
      return;
    }

    this.clicked = true;
    this.emit('log', `Clicking slot ${slot} (${win.slots[slot].name}) — ${why}`);
    try {
      await sleep(350);
      await this.bot.clickWindow(slot, 0, 0);
      this.emit('log', 'Slot clicked successfully! Waiting for realm transfer...');
    } catch (e) {
      this.clicked = false;
      this.emit('log', `Click window failed: ${e.message}`);
    }
  }
}

module.exports = { RealmJoiner };
