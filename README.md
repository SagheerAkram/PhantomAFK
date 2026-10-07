# 👻 PhantomAFK

> **Autonomous 24/7 Minecraft AFK Sentinel & Real-Time Discord Remote Bridge**  
> *Tested extensively on GamerTee Network (`play.gamertee.net`) via Android Termux.*

[![Platform: Termux / Android](https://img.shields.io/badge/Platform-Android%20Termux-brightgreen.svg)](#-why-run-on-phone-via-termux)
[![Runtime: Node.js](https://img.shields.io/badge/Runtime-Node.js%20v18%2B-blue.svg)](https://nodejs.org/)
[![License: Custom Strict](https://img.shields.io/badge/License-Non--Commercial%20%2F%20No--Sale-red.svg)](./LICENSE)
[![Purpose: Educational](https://img.shields.io/badge/Purpose-Educational%20Only-orange.svg)](./EDUCATIONAL_PURPOSE.md)

---

## 📌 Notice & Educational Disclaimer

> **This project is strictly for educational, research, and server administration monitoring purposes.**  
> Complete terms, guidelines, and compliance details are documented in [**EDUCATIONAL_PURPOSE.md**](./EDUCATIONAL_PURPOSE.md).  
> PhantomAFK was built to explore lightweight headless client architectures, automated proxy transfer protocol handling, and decentralized mobile daemons. Please always review and respect the rules and terms of service of any Minecraft network before connecting automated clients.

---

## 💡 The Philosophy: Why Run on Phone via Termux?

Most people attempting 24/7 Minecraft AFK run a full client or a headless process on a desktop PC. In practice, this introduces major real-world friction:

* **150+ Active Windows Background Tasks:** Operating systems like Windows constantly consume 4–8 GB of RAM and 15–30% idle CPU running background telemetry, updates, indexers, and antivirus scans.
* **Energy Consumption & Wear:** Leaving a 400W–850W PC running 24 hours a day generates heat, fan noise, and high electric bills.
* **Random System Restarts:** Windows forced reboots and update interruptions routinely terminate AFK sessions overnight.

### The Mobile Alternative
By migrating the Node.js headless runtime to **Android via Termux**:
* **< 50 MB RAM Usage:** Total memory footprint is negligible.
* **Virtually Zero Power Draw:** A phone consumes ~2–5W, staying cool and silent.
* **True 24/7 Resilience:** Paired with `termux-wake-lock` and a lightweight bash supervisor loop, the bot stays online uninterrupted for weeks.

---

## ⚙️ How It Works (Under the Hood)

PhantomAFK is engineered specifically around the multi-server proxy architecture used by networks like **GamerTee Network** (`play.gamertee.net`):

```
       [ Client Connect ]
               │
               ▼
      [ GamerTee Lobby ]  ───► Auto /login or /register (if required)
               │
      [ Hotbar Slot 4 ]   ───► Selects Compass & triggers Server Selector GUI
               │
      [ Window GUI ]      ───► Finds "Lifesteal" / Slot 15 & single-click locks
               │
    ┌──────────┴──────────┐
    ▼                     ▼
[ In Queue ]         [ Transferred ]
Pauses compass spam    4-factor verification:
to keep queue spot     • Scoreboard title
                       • Coordinates (|X| or |Z| > 500)
                       • Proxy respawn / backend hop packet
                       • Chat welcome trigger
                          │
                          ▼
                 [ Lifesteal Realm ]
                 • Issues /warp afk
                 • Starts micro-keepalive loop (yaw/pitch drift)
                 • Auto-eats food from inventory (hunger <= 14)
                 • Relays join/leave events & chat to Discord
                 • Listens for Discord Gateway commands (!afk, !status, etc.)
```

### 1. Queue-Safe Navigation (`realm_join.js`)
Most public Minecraft networks use Velocity or BungeeCord proxies with server selector menus. When a target sub-server has a queue, typical bot scripts repeatedly spam the menu item, which constantly resets their queue position or causes the proxy to kick them. 
PhantomAFK detects `You are in Queue`, freezes menu interactions to protect the queue spot, and waits for the backend handoff.

### 2. Micro-Keepalive & Anti-Kick
Rather than erratic movements that flag anti-cheat heuristics, PhantomAFK performs micro-yaw/pitch drift packets at spaced intervals. It monitors hunger levels and automatically consumes food from inventory when hunger falls below 14.

### 3. Native Discord Gateway Integration (Zero Webhooks)
PhantomAFK does not rely on third-party heavy Discord wrappers or fragile webhooks. It establishes a raw WebSocket connection directly to the official **Discord Gateway v10** (`wss://gateway.discord.gg`), consuming minimal resources while providing full bidirectional remote control and real-time event streaming.

---

## 📜 Version History & Engineering Failures

Building a 24/7 headless bot is an iterative process of finding and fixing subtle edge cases. Here is the complete evolution from early prototypes to current release:

### **v0.1.0 — The Naïve PC Prototype**
* **Approach:** Basic Mineflayer script run locally in Windows Command Prompt.
* **Failures Encountered:**
  * Windows sleep modes and power states suspended the network stack.
  * Windows forced updates rebooted the host machine, terminating sessions.
  * Running alongside 150+ daily desktop tasks caused unnecessary CPU spikes and memory bloat.

### **v0.2.0 — The Hardcoded TCPShield Pitfall**
* **Approach:** Hardcoded a resolved server IP (`50.114.4.122`) to bypass DNS lookup delays.
* **Failures Encountered:**
  * GamerTee Network utilizes TCPShield DDoS mitigation proxies. When TCPShield rotated backend edge nodes, the hardcoded IP became invalid, resulting in immediate handshake drops and connection timeouts.
  * **Fix:** Enforced domain-based resolution (`play.gamertee.net`) with forced IPv4 preference and custom Cloudflare/Google DNS resolvers (`1.1.1.1`, `8.8.8.8`).

### **v0.3.0 — The Velocity Queue Reset Loop & Double-Click Crash**
* **Approach:** Simple interval timer that clicked the lobby compass every 15 seconds until in realm.
* **Failures Encountered:**
  * *Queue Reset:* Clicking the compass while in a Velocity queue reset the bot's queue ticket back to the end of the line.
  * *Duplicate Window Kick:* Velocity fired multiple `windowOpen` events in quick succession. The bot sent consecutive click packets on slot 15, causing Velocity to drop the connection with the error: *"An internal error occurred in your connection."*
  * **Fix:** Built `RealmJoiner` with stateful queue detection (`inQueue`), single-click locking (`this.clicked = true`), and 4-factor realm entry confirmation (scoreboards, coordinates, chat triggers, and proxy respawn packets).

### **v0.4.0 — Scope Hoisting & Uncaught Exceptions**
* **Approach:** Extended chat and combat listeners directly inside the main loop.
* **Failures Encountered:**
  * A `ReferenceError: lower is not defined` occurred inside chat message string parsing on specific formatted messages, causing unhandled process termination.
  * An `isEating` variable was referenced before initialization during sudden reconnect sequences, leading to crashes in the reconnect loop.
  * **Fix:** Relocated and normalized all state variables, wrapped chat parsing in defensive null checks, and isolated event emitters.

### **v1.0.0 (Current) — The Termux Sentinel Architecture**
* **Milestone:** Complete migration to Android Termux daemon supervised by `phone_runner.sh`.
* **Current Capabilities:**
  * Automated queue-aware lobby navigation for GamerTee Network.
  * Direct Discord Gateway v10 WebSocket remote control (`!status`, `!afk`, `!coords`, `!inv`, etc.).
  * Real-time join/leave logging and server chat bridge.
  * Bounded log rotation (`tail -n 5000`) to preserve phone storage.
  * Memory footprint stabilized under 50 MB.

---

## 🎮 Remote Discord Commands

When the bot is connected, send any of the following commands in your configured control channel:

| Command | Description |
|---|---|
| `!help` | Displays the list of available commands and formatting. |
| `!status` | Returns live embed with uptime, realm status, ping, health, hunger, and XYZ coordinates. |
| `!afk` | Sends `/warp afk` to reposition at the AFK arena. |
| `!coords` | Reports current precise in-game XYZ coordinates. |
| `!inv` | Inspects current hotbar and inventory contents. |
| `!eat` | Forces the bot to equip and consume food from its inventory. |
| `!jump` | Sends a short jump packet. |
| `!sneak` / `!unsneak` | Toggles sneaking state. |
| `!say <message>` | Broadcasts a message in server chat through the bot. |
| `!whisper <player> <msg>` | Sends a private in-game message (`/msg`). |
| `!reply <message>` | Replies to the last player who whispered the bot. |

---

## 🚀 Quickstart Guide

### Option A: Run on Phone via Termux (Recommended)

1. **Install Termux** from [F-Droid](https://f-droid.org/en/packages/com.termux/) (do not use the deprecated Google Play version).
2. Open Termux and install dependencies:
   ```bash
   pkg update && pkg upgrade -y
   pkg install git nodejs-lts termux-api -y
   ```
3. Clone the repository:
   ```bash
   git clone https://github.com/SagheerAkram/PhantomAFK.git
   cd PhantomAFK
   npm install
   ```
4. Configure credentials:
   ```bash
   cp config.example.json config.json
   nano config.json
   ```
   *(Fill in your username, server password, and Discord bot token / channel IDs)*
5. Launch the 24/7 background daemon:
   ```bash
   chmod +x phone_runner.sh
   ./phone_runner.sh
   ```
   *To run completely in the background without keeping the terminal open:*
   ```bash
   nohup ./phone_runner.sh > /dev/null 2>&1 &
   ```

---

### Option B: Run on Windows PC (Testing)

1. Ensure **Node.js 18+** is installed on your computer.
2. Clone or download the repository into a folder.
3. Open PowerShell or Command Prompt in the folder:
   ```powershell
   npm install
   copy config.example.json config.json
   ```
4. Edit `config.json` with your credentials.
5. Double-click `run_pc.bat` or run:
   ```powershell
   node phantom_afk.js
   ```

---

## ⚙️ Configuration Reference (`config.json`)

```json
{
  "host": "play.gamertee.net",
  "port": 25565,
  "version": "1.20.4",
  "username": "YourBotUsername",
  "password": "YourBotPassword",
  "compassSlot": 4,
  "lifestealSlot": 15,
  "reconnectDelayMs": 15000,
  "discord": {
    "token": "YOUR_DISCORD_BOT_TOKEN",
    "controlChannelId": "123456789012345678",
    "panelMessageId": null,
    "chatChannelId": "123456789012345678",
    "rosterChannelId": "123456789012345678",
    "founderChannelId": "123456789012345678"
  }
}
```

> **Note:** `config.json` is explicitly ignored by `.gitignore` to ensure your account passwords and Discord tokens are never committed to version control.

---

## 🧩 Current Limitations & Future Roadmap

PhantomAFK is intentionally lightweight and focused on **rock-solid 24/7 AFK stability and logging**. It is not overly complex yet, but improvements are continuously being made:

- [x] Queue-safe lobby navigation for GamerTee Network
- [x] Auto-reconnect with exponential backoff
- [x] Real-time join/leave logger
- [x] Server chat relay
- [x] Bi-directional Discord Gateway remote control
- [ ] Adaptive pathfinding and auto-stuck resolution
- [ ] Multi-server profile configuration system
- [ ] Web-based telemetry dashboard for real-time mobile monitoring

---

## 🤝 Custom Server Adaptation & Contact

> **Important:** PhantomAFK currently contains navigation and slot detection logic tailored specifically for the **GamerTee Network** (`play.gamertee.net`) lobby layout.  
> If you need a customized version adapted for another network, different game modes, custom authentication plugins, or unique GUI menus, feel free to get in touch!

* **GitHub:** [@SagheerAkram](https://github.com/SagheerAkram)


---

## 📄 License & Restrictions

This project is licensed under the **Source-Available Educational & Non-Commercial License**.  
See the full [**LICENSE**](./LICENSE) for details.

* ❌ **No Resale:** You may NOT sell, bundle, or monetize this software in any paid package or service.
* ❌ **No Plagiarism / Re-branding:** You may NOT re-upload or publish this project under your own name or claim original authorship.
* ✅ **Educational Use:** You may freely view, inspect, and test the software for personal academic and research purposes.

---

> **P.S.** Yes, parts of this README and docs were formatted with AI. So what? The bot, the code, the bugs, and the Termux battle scars are 100% real. 🦾

