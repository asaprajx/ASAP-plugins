# ASAP Plugins for Valenced

A personal collection of custom plugins, enhancements, and ports for the **[Valenced](https://valenced.app/)** Discord mobile client on Android.

---

## 📌 Repository URL

To add this repository to Valenced:

1. Open Discord on your Android device.
2. Go to **Settings > Valenced > Plugins**.
3. Tap the **Settings Gear** (Repositories).
4. Tap **Add Repository** and enter:

```text
https://raw.githubusercontent.com/asaprajx/ASAP-plugins/gh-pages/index.json
```
*(Or the GitHub Pages link:)*
```text
https://asaprajx.github.io/ASAP-plugins/index.json
```

---

## 🔌 Available Plugins

### 🎮 Minecraft Servers (`asaprajx.minecraft-servers`)
Save and monitor your favorite Minecraft servers directly from Discord.
* **Live Status:** Real-time online/offline indicators, player counts, server software, and MOTD.
* **Ping Estimation:** Measures latency directly from your device.
* **Avatars & Icons:** Dynamic server icons and player head skins.
* **Background Alerts:** Get notified when your watched servers go online or offline.
* **Easy Access:** Quick access from Discord's `+` action menu.
* *Credits: Original concept & logic by [MarkLong0467](https://github.com/MarkLong0467).*

---

### 🦖 Pterodactyl Controller (`asaprajx.pterodactyl`)
Control and monitor your Pterodactyl game servers directly from Discord mobile with a modern Discord Mobile UI.
* **Live Server Metrics:** Real-time CPU load %, RAM usage (used/max), Disk storage, uptime counter, and dynamic status pills (`ONLINE`, `STARTING`, `STOPPING`, `OFFLINE`).
* **Power Controls:** 1-tap Start, Restart, Graceful Stop, and Emergency Kill buttons with tactile status colors.
* **Minecraft Players Hub:** View online players with 3D skin heads (`mc-heads.net`), role tags (`👑 OP`, `✓ Whitelist`), and full-height in-sheet moderation actions (`/op`, `/deop`, `/whitelist`, `/kick`, `/ban`, `/pardon`, `/tp`, `/gamemode`).
* **Console & Terminal:** Execute commands with 1-tap quick command pills (`/list`, `/tps`, `/whitelist list`, `/say`, `/save-all`, etc.) and read live `latest.log` output with chronological/newest-top ordering and auto-scroll.
* **File Explorer:** Browse server directory files with breadcrumb navigation, filetype badges (`📁`, `📄`, `⚙️`, `📦`), size indicators, and a full-height dark file viewer.
* **Modern Design:** Built with modern Discord design tokens, capsule pill tabs, and elevated surface cards. Quick launch from Discord's chat attachment `+` menu.

---

## ⚠️ Disclaimer & Feedback

> **Notice:** These plugins are created and maintained with the assistance of AI and are developed primarily for **my own personal use and experiments**. 

* **Bug reports & constructive feedback:** If you encounter an error or an issue, feel free to open a detailed issue with error logs or what happened.
* **Unhelpful toxicity:** Talking shit or complaining about AI-generated code will simply be ignored and not acknowledged. If a plugin doesn't suit your needs, you are free to uninstall it or build your own.

---

## 🛠️ Development & Building

Built with the [Valenced Plugin Toolchain](https://valenced.app/docs/plugin-development):
* **TypeScript & React (TSX)** with Discord's Design System primitives.
* Automated release packaging via GitHub Actions to `gh-pages`.
