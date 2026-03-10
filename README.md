# Gemini Slack Bot for GAS

<p align="center">
  <img src="./assets/gemini-slack-bot.svg" alt="Gemini Slack Bot icon" width="180">
</p>

<p align="center">
  <a href="https://github.com/Sunwood-ai-labs/gas-slack-bot-gemini/actions/workflows/ci.yml"><img src="https://github.com/Sunwood-ai-labs/gas-slack-bot-gemini/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-ISC-0f766e.svg" alt="ISC License"></a>
  <a href="./README.ja.md">日本語版 README</a>
</p>

Run a Slack Events API bot entirely on Google Apps Script. This project receives public-channel Slack events, sends the message and supported attachments to Gemini, and posts the reply back to Slack without managing your own server.

## ✨ Highlights

- Serverless Google Apps Script deployment with no external runtime
- Slack `message.channels` and `file_shared` event handling for public channels
- Gemini-powered analysis for images, PDFs, audio, video, and text attachments
- Duplicate event suppression with `CacheService` and `LockService`
- Japanese replies by default unless the user explicitly asks for another language
- Secret management through Apps Script `Script Properties`

## 🚀 Quick Start

1. Install dependencies with `npm install`.
2. Copy `.clasp.json.example` to `.clasp.json`.
3. Create a standalone Apps Script project or link an existing one with `clasp`.
4. Push the source with `npx clasp push`.
5. Add the required `Script Properties` listed below.
6. Deploy the Apps Script project as a web app and copy the `/exec` URL.
7. Import [`slack-app-manifest.json`](./slack-app-manifest.json) after replacing `__REQUEST_URL__`, or configure the same scopes and events manually.
8. Enable Event Subscriptions in Slack, set the request URL to the web app `/exec` URL, invite the bot to a public channel, and mention it to verify the reply flow.

## 🔐 Script Properties

Required properties:

| Name | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini API key used for `generateContent` and file uploads |
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth token used for replies and file downloads |
| `SLACK_VERIFICATION_TOKEN` | Slack Events API verification token checked by `doPost` |

Optional properties:

| Name | Default | Purpose |
| --- | --- | --- |
| `SLACK_ALLOWED_CHANNEL_ID` | unset | Restrict replies to one public channel |
| `SLACK_TEAM_ID` | unset | Restrict requests to one Slack workspace |
| `SLACK_API_APP_ID` | unset | Reject requests from unexpected Slack apps |
| `SLACK_BOT_USER_ID` | auto-detected | Skip the `auth.test` lookup and stabilize mention detection |
| `SLACK_REQUIRE_MENTION` | `true` | Set to `false` to answer every eligible public-channel message |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model used for replies |
| `GEMINI_MAX_ATTACHMENTS` | `4` | Maximum number of attachments processed per message |
| `GEMINI_MAX_MEDIA_FILE_BYTES` | `20971520` | Maximum size for image, PDF, audio, and video files |
| `GEMINI_MAX_TEXT_FILE_BYTES` | `1048576` | Maximum size for textual attachments before download |
| `GEMINI_MAX_TEXT_FILE_CHARS` | `12000` | Maximum extracted text sent to Gemini from one text file |

## 📎 Supported Attachments

| Category | MIME types | Handling |
| --- | --- | --- |
| Images | `image/*` | Uploaded to Gemini Files API |
| PDFs | `application/pdf` | Uploaded to Gemini Files API |
| Audio | `audio/*` | Uploaded to Gemini Files API |
| Video | `video/*` | Uploaded to Gemini Files API |
| Text-like files | `text/*`, `application/json`, `application/xml`, `text/csv`, `text/markdown` | Downloaded from Slack and embedded directly into the prompt |

Binary Office files such as `docx` and `xlsx` are currently skipped.

## 🧱 How It Works

1. Slack sends an event payload to the Apps Script web app.
2. [`Code.js`](./Code.js) validates the verification token, optional team/app restrictions, and mention rules.
3. Supported Slack files are either uploaded to the Gemini Files API or inlined as text.
4. Gemini generates a response and the bot posts it back to the message thread.

## 🛠 Slack App Setup

The included [`slack-app-manifest.json`](./slack-app-manifest.json) is a ready-to-edit template. At minimum, your Slack app needs:

- Bot scopes: `chat:write`, `channels:history`, `files:read`
- Bot events: `message.channels`, `file_shared`

Replace `__REQUEST_URL__` with your deployed Apps Script `/exec` URL before importing the manifest.

## 🗂 Repository Layout

```text
.
|-- Code.js
|-- appsscript.json
|-- slack-app-manifest.json
|-- .clasp.json.example
|-- assets/
|   `-- gemini-slack-bot.svg
`-- .github/workflows/ci.yml
```

## ✅ Verification

- `npm run check` validates `Code.js` syntax and both JSON manifests
- `npm run clasp:push` deploys the current source to Apps Script
- `npm run clasp:open` opens the linked Apps Script project in the browser

## ⚠️ Notes

- This implementation uses the Slack verification token because GAS web apps do not expose Slack's signing headers cleanly enough for the usual signature flow.
- Replies are limited to public channels because the bot subscribes to `message.channels`.
- When a supported file is posted without text, the bot can still analyze the attachment and answer.
- If some attachments cannot be processed, the bot adds a short skipped-file notice before the Gemini reply.

## 📄 License

Released under the ISC License. See [`LICENSE`](./LICENSE).
