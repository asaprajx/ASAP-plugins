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
https://asaprajx.github.io/valenced-plugin-template/index.json
```
*(Or the raw fallback link:)*
```text
https://raw.githubusercontent.com/asaprajx/valenced-plugin-template/gh-pages/index.json
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

## ⚠️ Disclaimer & Feedback

> **Notice:** These plugins are created and maintained with the assistance of AI and are developed primarily for **my own personal use and experiments**. 

* **Bug reports & constructive feedback:** If you encounter an error or an issue, feel free to open a detailed issue with error logs or what happened.
* **Unhelpful toxicity:** Talking shit or complaining about AI-generated code will simply be ignored and not acknowledged. If a plugin doesn't suit your needs, you are free to uninstall it or build your own.

---

## 🛠️ Development & Building

Built with the [Valenced Plugin Toolchain](https://valenced.app/docs/plugin-development):
* **TypeScript & React (TSX)** with Discord's Design System primitives.
* Automated release packaging via GitHub Actions to `gh-pages`.
