<div align="center">
  <img src="./assets/gemini-slack-bot.svg" alt="Gemini Slack Bot icon" width="180">
  <h1>Gemini Slack Bot for GAS</h1>
  <p>Google Apps Script だけで動く、Gemini 連携の Slack Events API Bot です。公開チャンネル向けにマルチモーダルな返信フローを構築できます。</p>
</div>

<p align="center">
  <a href="https://github.com/Sunwood-ai-labs/gas-slack-bot-gemini/actions/workflows/ci.yml">
    <img src="https://github.com/Sunwood-ai-labs/gas-slack-bot-gemini/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-ISC-0f766e.svg" alt="ISC License">
  </a>
  <img src="https://img.shields.io/badge/platform-Google%20Apps%20Script-4285F4.svg" alt="Google Apps Script">
  <img src="https://img.shields.io/badge/AI-Gemini-8E75FF.svg" alt="Gemini">
</p>

<p align="center">
  <a href="./README.md">
    <img src="https://img.shields.io/badge/Language-English-2563EB.svg" alt="English README">
  </a>
</p>

Google Apps Script だけで動かせる Slack Events API Bot です。公開チャンネルのメッセージや添付ファイルを受け取り、Gemini に内容を渡して、返答を Slack のスレッドへ投稿します。独自サーバーの常時運用は不要です。

## ✨ 特徴

- Google Apps Script 上で完結するサーバーレス構成
- 公開チャンネル向けの `message.channels` と `file_shared` に対応
- 画像、PDF、音声、動画、テキスト添付を Gemini で解析
- `CacheService` と `LockService` による重複イベント抑止
- 明示がなければ日本語で自然に返信
- Apps Script の `Script Properties` によるシークレット管理

## 🚀 クイックスタート

1. 依存関係をインストールします。

```bash
npm install
```

2. `.clasp.json.example` を `.clasp.json` にコピーします。
3. `clasp` でスタンドアロンの Apps Script プロジェクトを作成するか、既存プロジェクトに関連付けます。
4. ソースを Apps Script に反映します。

```bash
npx clasp push
```

5. 下記の `Script Properties` を設定します。
6. Apps Script を Web アプリとしてデプロイし、発行された `/exec` URL を控えます。
7. [`slack-app-manifest.json`](./slack-app-manifest.json) 内の `__REQUEST_URL__` を置き換えて Slack に import するか、同等の設定を手動で行います。
8. Slack で Event Subscriptions を有効化し、Request URL に `/exec` URL を設定して、Bot を公開チャンネルへ招待し、メンションして動作確認します。

## 🔐 Script Properties

必須:

| 名前 | 用途 |
| --- | --- |
| `GEMINI_API_KEY` | `generateContent` とファイルアップロードに使う Gemini API キー |
| `SLACK_BOT_TOKEN` | 返信投稿と Slack ファイル取得に使う Bot User OAuth トークン |
| `SLACK_VERIFICATION_TOKEN` | `doPost` で検証する Slack Events API の verification token |

任意:

| 名前 | 既定値 | 用途 |
| --- | --- | --- |
| `SLACK_ALLOWED_CHANNEL_ID` | 未設定 | 返信先を 1 つの公開チャンネルに制限 |
| `SLACK_TEAM_ID` | 未設定 | 許可する Slack ワークスペースを制限 |
| `SLACK_API_APP_ID` | 未設定 | 想定外の Slack App からのリクエストを拒否 |
| `SLACK_BOT_USER_ID` | 自動取得 | `auth.test` の問い合わせを省略し、メンション判定を安定化 |
| `SLACK_REQUIRE_MENTION` | `true` | `false` にすると条件を満たす公開チャンネル投稿すべてに応答 |
| `GEMINI_MODEL` | `gemini-2.5-flash` | 返信生成に使う Gemini モデル |
| `GEMINI_MAX_ATTACHMENTS` | `4` | 1 メッセージあたりに処理する添付ファイル数の上限 |
| `GEMINI_MAX_MEDIA_FILE_BYTES` | `20971520` | 画像、PDF、音声、動画の最大サイズ |
| `GEMINI_MAX_TEXT_FILE_BYTES` | `1048576` | ダウンロード対象にするテキスト添付の最大サイズ |
| `GEMINI_MAX_TEXT_FILE_CHARS` | `12000` | 1 ファイルから Gemini に渡す最大文字数 |

## 📎 対応添付ファイル

| 種別 | MIME types | 処理内容 |
| --- | --- | --- |
| 画像 | `image/*` | Gemini Files API にアップロード |
| PDF | `application/pdf` | Gemini Files API にアップロード |
| 音声 | `audio/*` | Gemini Files API にアップロード |
| 動画 | `video/*` | Gemini Files API にアップロード |
| テキスト系 | `text/*`, `application/json`, `application/xml`, `text/csv`, `text/markdown` | Slack から取得してプロンプトへ直接埋め込み |

`docx` や `xlsx` のようなバイナリ Office ファイルは現在スキップされます。

## 🧱 動作の流れ

1. Slack から Apps Script Web アプリへイベントが送信されます。
2. [`Code.js`](./Code.js) が verification token、任意の team/app 制限、メンション条件を確認します。
3. 対応ファイルは Gemini Files API へアップロードするか、テキストとして直接埋め込みます。
4. Gemini が応答を生成し、Bot が Slack スレッドに返信します。

## 🛠 Slack App 設定

同梱の [`slack-app-manifest.json`](./slack-app-manifest.json) は、そのまま編集して使えるテンプレートです。最低限、次の設定が必要です。

- Bot scopes: `chat:write`, `channels:history`, `files:read`, `reactions:write`
- Bot events: `message.channels`, `file_shared`

manifest を import する前に `__REQUEST_URL__` をデプロイ済み Apps Script の `/exec` URL に置き換えてください。

## 🗂 リポジトリ構成

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

## ✅ 検証コマンド

- `npm run check` で `Code.js` の構文と 2 つの JSON manifest を検証
- `npm run clasp:push` で Apps Script に反映
- `npm run clasp:open` で関連付け済み Apps Script プロジェクトを開く

## ⚠️ 補足

- GAS Web アプリでは Slack の signing headers を通常どおり扱いにくいため、この実装では verification token を使っています。
- 返信対象は `message.channels` を購読した公開チャンネルに限定されます。
- テキストがなくても、対応添付ファイルだけで解析して返答できます。
- 一部の添付が処理できなかった場合は、Gemini の返答前に短い skipped-file 通知を追加します。

## 📄 ライセンス

ISC License の下で公開しています。詳細は [`LICENSE`](./LICENSE) を参照してください。
