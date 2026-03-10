# Gemini Slack Bot for GAS

Google Apps Script 上で動く、Gemini API 連携の Slack Bot です。  
Slack Events API で受けたメッセージを Gemini に渡し、画像や PDF、音声/動画、テキスト系ファイルを読み込んで日本語で返答します。

## 特徴

- GAS だけで動くサーバーレス構成
- Slack の `message.channels` / `file_shared` に対応
- Gemini によるマルチモーダル応答
- 画像、PDF、音声、動画、テキスト添付に対応
- 重複イベントを `CacheService` で抑止
- Script Properties に秘密情報を分離

## 対応する添付

- 画像: `image/*`
- PDF: `application/pdf`
- 音声: `audio/*`
- 動画: `video/*`
- テキスト系: `text/*`, `application/json`, `application/xml`, `text/csv`, `text/markdown`

補足:

- 画像/PDF/音声/動画は Gemini Files API にアップロードして解析します。
- テキスト系ファイルは内容を取得してプロンプトに直接埋め込みます。
- `docx`, `xlsx` などの一部バイナリ Office ファイルは現状スキップされます。

## リポジトリ構成

- `Code.js`: Slack Events API の本体
- `appsscript.json`: Apps Script Manifest
- `slack-app-manifest.json`: Slack App Manifest テンプレート
- `.clasp.json.example`: `clasp` 用サンプル設定

## セットアップ

1. `npm install`
2. `.clasp.json.example` を `.clasp.json` にコピー
3. Apps Script プロジェクトを作成するか既存プロジェクトに紐付け
4. `npx clasp push`
5. Apps Script の Script Properties に必要な値を設定
6. Web アプリとしてデプロイ
7. `https://.../exec` を Slack App の Event Subscriptions に設定
8. Bot を対象チャンネルに招待して動作確認

## 必須の Script Properties

- `GEMINI_API_KEY`: Gemini API キー
- `SLACK_BOT_TOKEN`: Slack Bot User OAuth Token
- `SLACK_VERIFICATION_TOKEN`: Slack Events API の verification token

## 推奨の Script Properties

- `SLACK_ALLOWED_CHANNEL_ID`: 応答を許可するチャンネル ID
- `SLACK_TEAM_ID`: 許可する Slack Team ID
- `SLACK_API_APP_ID`: 想定する Slack App ID
- `SLACK_BOT_USER_ID`: Bot の User ID。未設定でも `auth.test` で解決を試みます
- `SLACK_REQUIRE_MENTION`: `true` なら Bot メンション時だけ返答。デフォルトは `true`
- `GEMINI_MODEL`: 既定値は `gemini-2.5-flash`
- `GEMINI_MAX_ATTACHMENTS`: 1 メッセージで処理する添付数上限。既定値は `4`
- `GEMINI_MAX_MEDIA_FILE_BYTES`: 画像/PDF/音声/動画の最大サイズ。既定値は `20971520`
- `GEMINI_MAX_TEXT_FILE_BYTES`: テキスト添付の最大サイズ。既定値は `1048576`
- `GEMINI_MAX_TEXT_FILE_CHARS`: テキスト添付から Gemini に渡す最大文字数。既定値は `12000`

## Slack App 設定

`slack-app-manifest.json` を使う場合は、少なくとも次を含めてください。

- Bot scopes:
  - `chat:write`
  - `channels:history`
  - `files:read`
- Bot events:
  - `message.channels`
  - `file_shared`

## 動作ルール

- 既定では Bot へのメンションがあるときだけ返答します
- ただしファイルだけを投稿した場合は、メンションなしでも添付解析を実行します
- スレッド内メッセージなら同じスレッドへ返答します
- 一部の添付を処理できなかった場合は、回答内で簡単に通知します

## ローカル操作

- `npm run check`: `Code.js` の構文チェック
- `npm run clasp:push`: GAS へ反映
- `npm run clasp:open`: Apps Script エディタを開く

## 注意

- Slack の署名検証ヘッダーは GAS Web App では扱いづらいため、この実装は verification token を使います
- Secret はリポジトリに置かず、必ず Script Properties に保存してください
