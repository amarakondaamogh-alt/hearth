# Hearth 🔥

A chat app you host yourself, with servers, channels, DMs, voice/video calls, screen sharing, GIFs, stickers, polls, themes and a built-in AI chatbot. People open your link, make an account and start chatting.

## Features

- **Accounts**: sign up with a username and password, then edit your profile (avatar, animated GIF avatars, banner, bio, custom status) and set your status (online, idle, do not disturb, invisible).
- **Servers**: create a server or join one with an invite link, set a server icon, and manage members (kick, ban, admins, transfer ownership).
- **Channels**:
  - text and voice channels
  - topics, slowmode and reordering
  - per-channel **AI auto-reply**
- **Messages**:
  - Markdown: bold, italics, underline, strike, spoilers, code blocks, quotes, headings
  - replies, edits, deletes, reactions and pins
  - @mentions and `:emoji:` autocomplete
  - link embeds (images and YouTube)
  - typing indicators, unread dots and mention badges
- **Uploads**: files, images, video and audio up to 25 MB. Upload with the button, by drag and drop, or by pasting.
- **GIFs**: GIPHY search, and pasted GIF links play inline.
- **Stickers**: 12 built-in stickers, plus custom stickers that admins upload for each server.
- **Polls**: `/poll Question | A | B`.
- **Slash commands**: `/ai /gif /poll /shrug /tableflip /me /spoiler /roll /coin /8ball /nick /status /help`.
- **Friends**: add, accept, remove, block. One-on-one DMs and group DMs of up to 10 people.
- **Voice and video**:
  - voice channels and DM/group calls with ringing
  - camera and screen sharing
  - mute and deafen, per-user volume
  - speaking indicators
  - mic, speaker and camera picker, plus a mic test
- **AI chatbot (Hearth AI)**: mention `@hearthai`, type `/ai <question>`, DM it, or switch on auto-reply in a channel. It reads the recent conversation and can see images you upload.
- **Customization**:
  - 7 themes and any accent color
  - chat backgrounds (gradients, patterns or your own image) and background strength
  - font size, compact mode, reduced motion
  - settings sync across your devices
- **Other**:
  - search (including `from:username`)
  - quick switcher (Ctrl+K) and keyboard shortcuts
  - right-click menus
  - desktop notifications and sounds
  - works on phones

## Put it online for free (about 10 minutes)

You need a free [GitHub](https://github.com) account and a free [Render](https://render.com) account.

1. **Put the code on GitHub.** Create a new repository on github.com, then use "uploading an existing file" and drag in **everything inside this `hearth` folder**: `server.js`, `package.json`, `render.yaml`, the `public` folder and so on.
2. **Deploy on Render.**
   1. In the Render dashboard, choose **New → Blueprint**.
   2. Connect your GitHub account and pick the repository.
   3. Click **Apply**.
3. Wait for the build to finish. Render gives you a link like `https://hearth-chat-abcd.onrender.com`. It's HTTPS by default, so the connection is encrypted. **Send that link to your friends.** That's all they need.

### Turn on the extras (optional)

In Render, open your service and go to **Environment → Add Environment Variable**:

| Variable | What it does | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Turns on the Hearth AI chatbot | [console.anthropic.com](https://console.anthropic.com). This is pay-per-use, so set a spending limit. |
| `GIPHY_API_KEY` | Turns on GIF search | [developers.giphy.com](https://developers.giphy.com). Free. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Makes calls work on strict networks (some school and work Wi-Fi, some mobile data) | A TURN provider such as Metered or Twilio. Many have free tiers. |
| `AI_MODEL` | Changes the AI model (the default is `claude-opus-5-5`) | |

### Important: free-tier limits

- **The free Render plan wipes saved data whenever the server restarts or redeploys.** That includes accounts, messages and uploads. To keep everything, upgrade to a paid instance, add a **Disk** mounted at `/var/data`, and set the environment variable `DATA_DIR=/var/data`.
- Free instances go to sleep after about 15 minutes with no visitors. The first visit after that takes 30–60 seconds to wake up.
- Voice and video calls are peer-to-peer: everyone in a call connects directly to everyone else. That works well for small groups (up to about 6–8 people with video). The limit is 16 people per call.

## Run it on your own computer

Install [Node.js](https://nodejs.org) (version 20 or newer), then:

```bash
cd hearth
npm install
npm start
```

Open http://localhost:3000. Microphone and camera work on `localhost`. On any other address they need HTTPS.

## Files

- `server.js`: the backend. It handles accounts, uploads, realtime chat (Socket.IO), call signaling and the AI bot. Data is saved to `data/db.json`.
- `public/`: the website.
  - `js/util.js`: helpers, emoji, stickers, Markdown, themes
  - `js/voice.js`: voice and video calls
  - `js/actions.js`: buttons, menus, settings
  - `js/app.js`: the main app
