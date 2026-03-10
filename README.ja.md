# Gemini Slack Bot for GAS

<p align="center">
  <img src="./assets/gemini-slack-bot.svg" alt="Gemini Slack Bot icon" width="180">
</p>

<p align="center">
  <a href="./README.md">English README</a>
  <a href="https://github.com/Sunwood-ai-labs/gas-slack-bot-gemini/actions/workflows/ci.yml"><img src="https://github.com/Sunwood-ai-labs/gas-slack-bot-gemini/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-ISC-0f766e.svg" alt="ISC License"></a>
</p>

Google Apps Script だけで動く Slack Events API Bot です。公開チャンネルのメッセージや対応添付ファイルを Gemini に渡し、専用サーバーを用意せずに Slack へ返信できます。

## ✨ 特徴

- 外部ランタイム不要の Google Apps Script 構成
- 公開チャンネル向けの `message.channels` / `file_shared` イベントに対応
- 画像、PDF、音声、動画、テキスト添付を Gemini で解析
- `CacheService` と `LockService` による重複イベント抑止
- 既定では日本語で自然に返答
- Apps Script の `Script Properties` に秘密情報を分離

## 🚀 クイックスタート

1. `npm install` で依存関係を入れます。
2. `.clasp.json.example` を `.clasp.json` にコピーします。
3. `clasp` でスタンドアロンの Apps Script プロジェクトを作成するか、既存プロジェクトに紐付けます。
4. `npx clasp push` でソースを反映します。
5. 下記の必須 `Script Properties` を設定します。
6. Apps Script を Web アプリとしてデプロイし、`/exec` URL を控えます。
7. `__REQUEST_URL__` を置き換えた [`slack-app-manifest.json`](./slack-app-manifest.json) をインポートするか、同等の権限とイベントを手動設定します。
8. Slack 側で Event Subscriptions を有効化し、リクエスト URL に `/exec` URL を設定して、対象公開チャンネルへ Bot を招待して動作確認します。

## 🔐 Script Properties

必須:

| 名前 | 用途 |
| --- | --- |
| `GEMINI_API_KEY` | `generateContent` とファイル upload に使う Gemini API キー |
| `SLACK_BOT_TOKEN` | 返信投稿とファイル取得に使う Slack Bot User OAuth token |
| `SLACK_VERIFICATION_TOKEN` | `doPost` で照合する Slack Events API verification token |

任意:

| 名前 | 既定値 | 用途 |
| --- | --- | --- |
| `SLACK_ALLOWED_CHANNEL_ID` | 未設定 | 返信先を 1 つの公開チャンネルに制限 |
| `SLACK_TEAM_ID` | 未設定 | 許可する Slack ワークスペースを制限 |
| `SLACK_API_APP_ID` | 未設定 | 想定外の Slack App からのイベントを拒否 |
| `SLACK_BOT_USER_ID` | 自動解決 | `auth.test` を省略し、メンション検出を安定化 |
| `SLACK_REQUIRE_MENTION` | `true` | `false` にすると対象公開チャンネルの通常投稿にも応答 |
| `GEMINI_MODEL` | `gemini-2.5-flash` | 返信生成に使う Gemini モデル |
| `GEMINI_MAX_ATTACHMENTS` | `4` | 1 メッセージで処理する添付数の上限 |
| `GEMINI_MAX_MEDIA_FILE_BYTES` | `20971520` | 画像、PDF、音声、動画の最大サイズ |
| `GEMINI_MAX_TEXT_FILE_BYTES` | `1048576` | ダウンロード対象にするテキスト添付の最大サイズ |
| `GEMINI_MAX_TEXT_FILE_CHARS` | `12000` | 1 ファイルから Gemini に渡す最大文字数 |

## 📎 対応添付

| 種別 | MIME types | 処理方法 |
| --- | --- | --- |
| 画像 | `image/*` | Gemini Files API へアップロード |
| PDF | `application/pdf` | Gemini Files API へアップロード |
| 音声 | `audio/*` | Gemini Files API へアップロード |
| 動画 | `video/*` | Gemini Files API へアップロード |
| テキスト系 | `text/*`, `application/json`, `application/xml`, `text/csv`, `text/markdown` | Slack から取得してプロンプトへ直接埋め込み |

`docx` や `xlsx` などのバイナリ Office ファイルは現状スキップします。

## 🧱 動作の流れ

1. Slack が Apps Script Web アプリへイベントを送ります。
2. [`Code.js`](./Code.js) が verification token、任意の team/app 制限、メンション条件を確認します。
3. 対応ファイルは Gemini Files API へアップロードするか、テキストとして直接プロンプトへ埋め込みます。
4. Gemini の返答を同じメッセージスレッドへ投稿します。

## 🛠 Slack App 設定

同梱の [`slack-app-manifest.json`](./slack-app-manifest.json) をそのまま編集できるようにしています。最低限必要なのは次の通りです。

- Bot scopes: `chat:write`, `channels:history`, `files:read`
- Bot events: `message.channels`, `file_shared`

manifest を取り込む前に `__REQUEST_URL__` をデプロイ済み Apps Script の `/exec` URL に置き換えてください。

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
- `npm run clasp:open` で紐付け済み Apps Script プロジェクトを開く

## ⚠️ 注意点

- GAS Web アプリでは Slack の署名ヘッダーを通常通り扱いにくいため、この実装では verification token を利用します。
- 応答対象は `message.channels` を購読した公開チャンネルです。
- 対応ファイルだけが投稿された場合は、本文がなくても解析して返答できます。
- 一部添付を処理できなかった場合は、Gemini の返答前に短い skipped-file 通知を追加します。

## 📄 ライセンス

ISC License で公開しています。詳細は [`LICENSE`](./LICENSE) を参照してください。
