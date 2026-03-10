const DEFAULT_ALLOWED_CHANNEL_ID = 'C0000000000';
const DEFAULT_ALLOWED_TEAM_ID = 'T0000000000';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_MAX_MEDIA_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TEXT_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_TEXT_FILE_CHARS = 4000;
const DEFAULT_MAX_ATTACHMENTS = 2;
const DEFAULT_SLACK_REPLY_MAX_CHARS = 1500;
const DEFAULT_REQUIRE_MENTION = true;
const EVENT_CACHE_TTL_SECONDS = 60 * 10;
const FILE_RESPONSE_CACHE_TTL_SECONDS = 60;
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com';
const SLACK_API_BASE_URL = 'https://slack.com/api';

function doGet() {
  return jsonOutput_({
    ok: true,
    service: 'Gemini Slack Bot',
    message: 'Send Slack Events API requests to this web app with POST.',
  });
}

function doPost(e) {
  try {
    const payload = parseJsonBody_(e);
    verifyPayload_(payload);

    if (payload.type === 'url_verification') {
      return jsonOutput_({ challenge: payload.challenge });
    }

    if (payload.type === 'event_callback') {
      handleEventCallback_(payload);
      return textOutput_('ok');
    }

    return textOutput_('ignored');
  } catch (error) {
    console.error('[gas-slack-bot-gemini] %s\n%s', error.message, error.stack || '');
    return jsonOutput_({
      ok: false,
      error: error.message,
    });
  }
}

function handleEventCallback_(payload) {
  if (isDuplicateEvent_(payload.event_id)) {
    return;
  }

  const event = payload.event || {};
  try {
    if (event.type === 'message') {
      handleMessageEvent_(payload, event);
      return;
    }

    if (event.type === 'file_shared') {
      handleFileSharedEvent_(payload, event);
    }
  } catch (error) {
    console.error('[event] %s\n%s', error.message, error.stack || '');
    if (!isQuotaExceededError_(error)) {
      postFailureNotice_(event, error);
    }
    throw error;
  }
}

function handleMessageEvent_(payload, event) {
  const requestContext = buildRequestContext_(payload, event, null);
  if (!requestContext) {
    return;
  }

  if (requestContext.supportedFiles.length && !claimFileResponses_(requestContext.supportedFiles)) {
    return;
  }

  processRequestContext_(requestContext);
}

function handleFileSharedEvent_(payload, event) {
  const channelId = event.channel_id || event.channel;
  if (!channelId || !isAllowedChannel_(channelId)) {
    return;
  }

  if (!event.file_id) {
    return;
  }

  const file = fetchSlackFileInfo_(event.file_id);
  if (!file) {
    return;
  }

  if (!claimFileResponses_([file])) {
    return;
  }

  const message = findMessageForSharedFile_(channelId, event.file_id, event.event_ts);
  const syntheticEvent = {
    type: 'message',
    subtype: 'file_share',
    channel: channelId,
    channel_type: 'channel',
    user: message && message.user ? message.user : event.user_id,
    text: message && message.text ? message.text : '',
    files: [file],
    ts: message && message.ts ? message.ts : event.event_ts,
    thread_ts: message && message.thread_ts ? message.thread_ts : '',
  };

  const requestContext = buildRequestContext_(payload, syntheticEvent, [file]);
  if (!requestContext) {
    return;
  }

  processRequestContext_(requestContext);
}

function buildRequestContext_(payload, event, providedFiles) {
  const files = providedFiles || resolveSlackFiles_(event);
  if (!shouldReplyToEvent_(event, files.length)) {
    return null;
  }

  const supportedFiles = [];
  const skippedFiles = [];
  const maxAttachments = getMaxAttachments_();

  for (let i = 0; i < files.length; i += 1) {
    if (supportedFiles.length >= maxAttachments) {
      skippedFiles.push({
        name: files[i].name,
        reason: 'attachment limit reached',
      });
      continue;
    }

    if (isTextualSlackFile_(files[i]) || isGeminiMediaFile_(files[i])) {
      supportedFiles.push(files[i]);
      continue;
    }

    skippedFiles.push({
      name: files[i].name,
      reason: 'unsupported file type (' + (files[i].mimeType || 'unknown') + ')',
    });
  }

  const promptText = normalizeUserPrompt_(event.text);
  const effectivePrompt = promptText || defaultPromptForFiles_(supportedFiles);

  if (!effectivePrompt && !supportedFiles.length) {
    return null;
  }

  return {
    payload: payload,
    event: event,
    channel: event.channel,
    messageTs: event.ts || '',
    threadTs: event.thread_ts || event.ts || '',
    userId: event.user || '',
    promptText: effectivePrompt,
    supportedFiles: supportedFiles,
    skippedFiles: skippedFiles,
  };
}

function processRequestContext_(requestContext) {
  const reactionState = markSlackProcessing_(requestContext);

  try {
    const replyText = generateGeminiReply_(requestContext);
    postSlackReply_(requestContext, replyText);
    markSlackSuccess_(requestContext, reactionState);
  } catch (error) {
    markSlackFailure_(requestContext, reactionState);
    throw error;
  }
}

function shouldReplyToEvent_(event, fileCount) {
  if (!event || event.type !== 'message') {
    return false;
  }

  if (!event.channel || !isAllowedChannel_(event.channel)) {
    return false;
  }

  if (event.channel_type && event.channel_type !== 'channel') {
    return false;
  }

  if (event.subtype && event.subtype !== 'file_share') {
    return false;
  }

  if (event.bot_id || event.app_id) {
    return false;
  }

  const botUserId = getBotUserId_();
  if (botUserId && event.user && event.user === botUserId) {
    return false;
  }

  const rawText = normalizeText_(event.text);
  const hasFiles = fileCount > 0;
  const requiresMention = getRequireMention_();

  if (!rawText && !hasFiles) {
    return false;
  }

  if (!requiresMention) {
    return true;
  }

  if (hasFiles && !rawText) {
    return true;
  }

  return containsBotMention_(rawText);
}

function generateGeminiReply_(requestContext) {
  const uploadedFiles = [];
  const skippedFiles = requestContext.skippedFiles.slice();

  try {
    const parts = [{ text: buildGeminiInstructionText_(requestContext) }];

    for (let i = 0; i < requestContext.supportedFiles.length; i += 1) {
      const file = requestContext.supportedFiles[i];
      try {
        if (isTextualSlackFile_(file)) {
          parts.push({
            text: buildTextAttachmentPart_(file),
          });
          continue;
        }

        const uploadedFile = uploadSlackFileToGemini_(file);
        uploadedFiles.push(uploadedFile);
        parts.push({
          file_data: {
            mime_type: uploadedFile.mimeType,
            file_uri: uploadedFile.uri,
          },
        });
      } catch (error) {
        skippedFiles.push({
          name: file.name,
          reason: error.message,
        });
      }
    }

    const body = {
      contents: [{
        role: 'user',
        parts: parts,
      }],
    };

    const response = callGeminiApi_(
      'post',
      '/v1beta/models/' + encodeURIComponent(getGeminiModel_()) + ':generateContent',
      body
    );

    const replyText = extractGeminiText_(response);
    if (!replyText) {
      throw new Error('Gemini returned an empty response.');
    }

    const skippedNotice = buildSkippedFilesNotice_(skippedFiles);
    return truncateSlackText_(skippedNotice ? skippedNotice + '\n\n' + replyText : replyText);
  } finally {
    cleanupUploadedGeminiFiles_(uploadedFiles);
  }
}

function buildGeminiInstructionText_(requestContext) {
  const lines = [
    'You are a helpful Slack assistant powered by Gemini.',
    'Reply in natural Japanese unless the user clearly asks for another language.',
    'Keep the final Slack answer concise and practical.',
    'Format for Slack, not generic Markdown.',
    'Do not use Markdown headings like #, ##, or ###, and do not use tables.',
    'Prefer this structure: one short summary sentence, blank line, *bold section labels*, and bullets starting with "•".',
    'Avoid decorative formatting and keep spacing clean.',
    'Use the attached files and images as primary evidence when they are relevant.',
    'If a file could not be fully inspected, say so briefly and continue with the best available answer.',
    '',
    'Slack context:',
    'channel_id=' + (requestContext.channel || ''),
    'user_id=' + (requestContext.userId || ''),
    'message_ts=' + ((requestContext.event && requestContext.event.ts) || ''),
    '',
    'User request:',
    requestContext.promptText,
  ];

  if (requestContext.supportedFiles.length) {
    lines.push('');
    lines.push('Attached files:');
    for (let i = 0; i < requestContext.supportedFiles.length; i += 1) {
      lines.push('- ' + summarizeSlackFile_(requestContext.supportedFiles[i]));
    }
  }

  if (requestContext.skippedFiles.length) {
    lines.push('');
    lines.push('Skipped files:');
    for (let i = 0; i < requestContext.skippedFiles.length; i += 1) {
      lines.push('- ' + requestContext.skippedFiles[i].name + ': ' + requestContext.skippedFiles[i].reason);
    }
  }

  return lines.join('\n');
}

function buildTextAttachmentPart_(file) {
  const text = downloadSlackTextFile_(file);
  return [
    'Attached text file:',
    'name=' + file.name,
    'mime_type=' + file.mimeType,
    'content:',
    text,
  ].join('\n');
}

function buildSkippedFilesNotice_(skippedFiles) {
  if (!skippedFiles || !skippedFiles.length) {
    return '';
  }

  const fragments = [];
  for (let i = 0; i < skippedFiles.length; i += 1) {
    fragments.push(skippedFiles[i].name + ' (' + skippedFiles[i].reason + ')');
  }

  return '注: 一部の添付は解析対象外でした。' + fragments.join(', ');
}

function defaultPromptForFiles_(supportedFiles) {
  if (!supportedFiles || !supportedFiles.length) {
    return '';
  }

  return '添付された画像やファイルの内容を確認し、日本語で要点を整理して回答してください。必要なら読み取れたテキストや注意点も添えてください。';
}

function resolveSlackFiles_(event) {
  const results = [];
  const seen = {};
  const files = event && event.files ? event.files : [];

  for (let i = 0; i < files.length; i += 1) {
    let file = files[i];
    if (!file || !file.id) {
      continue;
    }

    if (file.file_access === 'check_file_info' || !file.url_private_download) {
      file = fetchSlackFileInfo_(file.id);
    }

    const normalized = normalizeSlackFile_(file);
    if (!normalized || seen[normalized.id]) {
      continue;
    }

    seen[normalized.id] = true;
    results.push(normalized);
  }

  return results;
}

function normalizeSlackFile_(file) {
  if (!file || !file.id) {
    return null;
  }

  const name = file.name || file.title || ('file-' + file.id);
  const mimeType = normalizeMimeType_(file.mimetype, file.filetype, name);

  return {
    id: file.id,
    name: name,
    title: file.title || '',
    mimeType: mimeType,
    size: Number(file.size || 0),
    urlPrivate: file.url_private || '',
    urlPrivateDownload: file.url_private_download || file.url_private || '',
    mode: file.mode || '',
    filetype: file.filetype || '',
    isExternal: Boolean(file.is_external),
  };
}

function normalizeMimeType_(mimeType, filetype, name) {
  const normalized = String(mimeType || '').toLowerCase();
  const extension = getFileExtension_(name || filetype || '');
  const inferred = inferMimeTypeFromExtension_(extension);

  // Slack sometimes uploads text files like README.md as hosted binaries
  // with application/octet-stream. Prefer a known text/media type from the
  // filename extension in that case so the bot can still inspect the file.
  if (normalized && normalized !== 'application/octet-stream') {
    return normalized;
  }

  if (inferred) {
    return inferred;
  }

  return 'application/octet-stream';
}

function inferMimeTypeFromExtension_(extension) {
  const value = String(extension || '').toLowerCase();
  if (value === 'md' || value === 'markdown') {
    return 'text/markdown';
  }
  if (value === 'json') {
    return 'application/json';
  }
  if (value === 'xml') {
    return 'application/xml';
  }
  if (value === 'yaml' || value === 'yml') {
    return 'application/x-yaml';
  }
  if (value === 'csv') {
    return 'text/csv';
  }
  if (value === 'txt' || value === 'log') {
    return 'text/plain';
  }
  if (value === 'js' || value === 'jsx' || value === 'ts' || value === 'tsx' || value === 'py' || value === 'java' || value === 'go' || value === 'rb' || value === 'sh') {
    return 'text/plain';
  }
  if (value === 'pdf') {
    return 'application/pdf';
  }

  return '';
}

function getFileExtension_(name) {
  const value = String(name || '').toLowerCase();
  const index = value.lastIndexOf('.');
  return index >= 0 ? value.substring(index + 1) : value;
}

function isTextualSlackFile_(file) {
  if (!file || file.isExternal) {
    return false;
  }

  const mimeType = file.mimeType || '';
  if (mimeType.indexOf('text/') === 0) {
    return true;
  }

  return mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/x-yaml' ||
    mimeType === 'text/csv' ||
    mimeType === 'text/markdown';
}

function isGeminiMediaFile_(file) {
  if (!file || file.isExternal) {
    return false;
  }

  const mimeType = file.mimeType || '';
  return mimeType.indexOf('image/') === 0 ||
    mimeType.indexOf('audio/') === 0 ||
    mimeType.indexOf('video/') === 0 ||
    mimeType === 'application/pdf';
}

function uploadSlackFileToGemini_(file) {
  if (file.size > getMaxMediaFileBytes_()) {
    throw new Error('File is too large for Gemini upload: ' + summarizeSlackFile_(file));
  }

  const response = UrlFetchApp.fetch(file.urlPrivateDownload, {
    method: 'get',
    headers: buildSlackAuthHeaders_(),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Failed to download Slack attachment: ' + file.name);
  }

  const blob = response.getBlob().setName(file.name);
  const startResponse = UrlFetchApp.fetch(
    buildGeminiUrl_('/upload/v1beta/files'),
    {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(blob.getBytes().length),
        'X-Goog-Upload-Header-Content-Type': file.mimeType,
      },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        file: {
          display_name: file.name,
        },
      }),
    }
  );

  if (startResponse.getResponseCode() >= 300) {
    throw new Error('Failed to start Gemini file upload: ' + startResponse.getContentText());
  }

  const uploadUrl = findHeaderValue_(startResponse, 'x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini upload URL was not returned.');
  }

  const uploadResponse = UrlFetchApp.fetch(uploadUrl, {
    method: 'post',
    contentType: file.mimeType,
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    muteHttpExceptions: true,
    payload: blob.getBytes(),
  });

  if (uploadResponse.getResponseCode() >= 300) {
    throw new Error('Failed to finalize Gemini file upload: ' + uploadResponse.getContentText());
  }

  const uploadedFile = extractGeminiFileResource_(parseJsonText_(uploadResponse.getContentText()));
  return waitForGeminiFileReady_(uploadedFile);
}

function waitForGeminiFileReady_(uploadedFile) {
  const resource = uploadedFile || {};
  const name = resource.name;
  if (!name) {
    throw new Error('Gemini upload response did not include a file name.');
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = getGeminiFileState_(resource);
    if (!state || state === 'ACTIVE') {
      return {
        name: name,
        uri: resource.uri,
        mimeType: resource.mimeType || resource.mime_type,
      };
    }

    if (state !== 'PROCESSING') {
      throw new Error('Gemini file entered unexpected state: ' + state);
    }

    Utilities.sleep(1500);
    const refreshed = callGeminiApi_('get', '/v1beta/' + name, null);
    const refreshedResource = extractGeminiFileResource_(refreshed);
    resource.state = refreshedResource.state;
    resource.uri = refreshedResource.uri;
    resource.mimeType = refreshedResource.mimeType || refreshedResource.mime_type;
  }

  throw new Error('Timed out while waiting for Gemini to process a file.');
}

function cleanupUploadedGeminiFiles_(uploadedFiles) {
  for (let i = 0; i < uploadedFiles.length; i += 1) {
    if (!uploadedFiles[i] || !uploadedFiles[i].name) {
      continue;
    }

    try {
      callGeminiApi_('delete', '/v1beta/' + uploadedFiles[i].name, null);
    } catch (error) {
      console.warn('Failed to delete Gemini file %s: %s', uploadedFiles[i].name, error.message);
    }
  }
}

function extractGeminiFileResource_(payload) {
  return payload && payload.file ? payload.file : payload;
}

function getGeminiFileState_(resource) {
  if (!resource || !resource.state) {
    return '';
  }

  if (typeof resource.state === 'string') {
    return resource.state;
  }

  return resource.state.name || '';
}

function downloadSlackTextFile_(file) {
  const byteLimit = getMaxTextFileBytes_();

  const response = UrlFetchApp.fetch(file.urlPrivateDownload, {
    method: 'get',
    headers: buildSlackDownloadHeaders_({
      Range: 'bytes=0-' + Math.max(0, byteLimit - 1),
    }),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200 && response.getResponseCode() !== 206) {
    throw new Error('Failed to download text attachment: ' + file.name);
  }

  const text = response.getContentText();
  return truncateText_(text, getMaxTextFileChars_());
}

function buildGeminiUrl_(path) {
  return GEMINI_API_BASE_URL + path + '?key=' + encodeURIComponent(getRequiredProperty_('GEMINI_API_KEY'));
}

function callGeminiApi_(method, path, body) {
  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: {},
  };

  if (body !== null && body !== undefined) {
    options.contentType = 'application/json; charset=utf-8';
    options.payload = JSON.stringify(body);
  }

  const response = UrlFetchApp.fetch(buildGeminiUrl_(path), options);
  const statusCode = response.getResponseCode();
  const contentText = response.getContentText();

  if (statusCode >= 300) {
    throw new Error('Gemini API call failed: ' + contentText);
  }

  return contentText ? parseJsonText_(contentText) : {};
}

function extractGeminiText_(response) {
  const candidates = response && response.candidates ? response.candidates : [];
  for (let i = 0; i < candidates.length; i += 1) {
    const content = candidates[i].content || {};
    const parts = content.parts || [];
    const fragments = [];
    for (let j = 0; j < parts.length; j += 1) {
      if (parts[j].text) {
        fragments.push(parts[j].text);
      }
    }

    if (fragments.length) {
      return fragments.join('\n').trim();
    }
  }

  return '';
}

function postSlackReply_(requestContext, text) {
  const formattedText = formatSlackReply_(text);
  const payload = {
    channel: requestContext.channel,
    text: truncateSlackText_(formattedText),
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateSlackText_(formattedText),
      },
    }],
  };

  if (requestContext.threadTs) {
    payload.thread_ts = requestContext.threadTs;
  }

  callSlackApiJson_('chat.postMessage', payload);
}

function markSlackProcessing_(requestContext) {
  const state = { pending: false };
  if (!canReactToSlackMessage_(requestContext)) {
    return state;
  }

  state.pending = callSlackReactionSafe_('reactions.add', {
    channel: requestContext.channel,
    timestamp: requestContext.messageTs,
    name: 'hourglass_flowing_sand',
  });

  return state;
}

function markSlackSuccess_(requestContext, reactionState) {
  if (!canReactToSlackMessage_(requestContext)) {
    return;
  }

  if (reactionState && reactionState.pending) {
    callSlackReactionSafe_('reactions.remove', {
      channel: requestContext.channel,
      timestamp: requestContext.messageTs,
      name: 'hourglass_flowing_sand',
    });
  }

  callSlackReactionSafe_('reactions.add', {
    channel: requestContext.channel,
    timestamp: requestContext.messageTs,
    name: 'white_check_mark',
  });
}

function markSlackFailure_(requestContext, reactionState) {
  if (!canReactToSlackMessage_(requestContext)) {
    return;
  }

  if (reactionState && reactionState.pending) {
    callSlackReactionSafe_('reactions.remove', {
      channel: requestContext.channel,
      timestamp: requestContext.messageTs,
      name: 'hourglass_flowing_sand',
    });
  }

  callSlackReactionSafe_('reactions.add', {
    channel: requestContext.channel,
    timestamp: requestContext.messageTs,
    name: 'x',
  });
}

function postFailureNotice_(event, error) {
  const channel = event && (event.channel || event.channel_id);
  if (!channel || !isAllowedChannel_(channel)) {
    return;
  }

  const payload = {
    channel: channel,
    text: truncateSlackText_('処理中にエラーが発生しました。' + error.message),
  };

  const threadTs = event.thread_ts || event.ts || '';
  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  try {
    callSlackApiJson_('chat.postMessage', payload);
  } catch (secondaryError) {
    console.warn('[failure-notice] %s', secondaryError.message);
  }
}

function findMessageForSharedFile_(channelId, fileId, eventTs) {
  if (!channelId || !fileId || !eventTs) {
    return null;
  }

  const eventTime = Number(eventTs);
  const oldest = String(Math.max(0, eventTime - 120));
  const latest = String(eventTime + 120);
  const response = callSlackApiForm_('conversations.history', {
    channel: channelId,
    oldest: oldest,
    latest: latest,
    inclusive: 'true',
    limit: '10',
  });

  const messages = response && response.messages ? response.messages : [];
  for (let i = 0; i < messages.length; i += 1) {
    const files = messages[i].files || [];
    for (let j = 0; j < files.length; j += 1) {
      if (files[j].id === fileId) {
        return messages[i];
      }
    }
  }

  return null;
}

function fetchSlackFileInfo_(fileId) {
  const response = callSlackApiForm_('files.info', { file: fileId });
  return normalizeSlackFile_(response.file);
}

function callSlackApiJson_(method, payload) {
  const response = UrlFetchApp.fetch(SLACK_API_BASE_URL + '/' + method, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: buildSlackAuthHeaders_(),
    muteHttpExceptions: true,
    payload: JSON.stringify(payload),
  });

  return parseSlackApiResponse_(method, response);
}

function callSlackApiForm_(method, payload) {
  const response = UrlFetchApp.fetch(SLACK_API_BASE_URL + '/' + method, {
    method: 'post',
    headers: buildSlackAuthHeaders_(),
    muteHttpExceptions: true,
    payload: payload,
  });

  return parseSlackApiResponse_(method, response);
}

function callSlackReactionSafe_(method, payload) {
  try {
    callSlackApiForm_(method, payload);
    return true;
  } catch (error) {
    const message = String(error && error.message ? error.message : error || '');
    if (message.indexOf('already_reacted') >= 0 ||
        message.indexOf('no_reaction') >= 0 ||
        message.indexOf('missing_scope') >= 0 ||
        message.indexOf('not_reactable') >= 0 ||
        isQuotaExceededError_(error)) {
      console.warn('[slack-reaction] %s', message);
      return false;
    }

    throw error;
  }
}

function parseSlackApiResponse_(method, response) {
  const statusCode = response.getResponseCode();
  const bodyText = response.getContentText();
  const body = bodyText ? parseJsonText_(bodyText) : {};

  if (statusCode !== 200 || !body.ok) {
    throw new Error('Slack API call failed: ' + method + ' ' + bodyText);
  }

  return body;
}

function buildSlackAuthHeaders_() {
  return {
    Authorization: 'Bearer ' + getRequiredProperty_('SLACK_BOT_TOKEN'),
  };
}

function canReactToSlackMessage_(requestContext) {
  return Boolean(
    requestContext &&
    requestContext.channel &&
    requestContext.messageTs
  );
}

function buildSlackDownloadHeaders_(extraHeaders) {
  const headers = buildSlackAuthHeaders_();
  const extras = extraHeaders || {};

  for (const key in extras) {
    if (Object.prototype.hasOwnProperty.call(extras, key)) {
      headers[key] = extras[key];
    }
  }

  return headers;
}

function verifyPayload_(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body must be a JSON object.');
  }

  const verificationToken = getRequiredProperty_('SLACK_VERIFICATION_TOKEN');
  if (payload.token !== verificationToken) {
    throw new Error('Slack verification token did not match.');
  }

  const allowedTeamId = getAllowedTeamId_();
  if (allowedTeamId && payload.team_id && payload.team_id !== allowedTeamId) {
    throw new Error('Unexpected Slack team_id: ' + payload.team_id);
  }

  const allowedAppId = getOptionalProperty_('SLACK_API_APP_ID');
  if (allowedAppId && payload.api_app_id && payload.api_app_id !== allowedAppId) {
    throw new Error('Unexpected Slack api_app_id: ' + payload.api_app_id);
  }
}

function parseJsonBody_(e) {
  const rawBody = e && e.postData && e.postData.contents;
  if (!rawBody) {
    throw new Error('POST body was empty.');
  }

  return parseJsonText_(rawBody);
}

function parseJsonText_(text) {
  return JSON.parse(text);
}

function isDuplicateEvent_(eventId) {
  if (!eventId) {
    return false;
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'slack-event:' + eventId;

  if (cache.get(cacheKey)) {
    return true;
  }

  cache.put(cacheKey, '1', EVENT_CACHE_TTL_SECONDS);
  return false;
}

function claimFileResponses_(files) {
  if (!files || !files.length) {
    return true;
  }

  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    for (let i = 0; i < files.length; i += 1) {
      if (!files[i] || !files[i].id) {
        continue;
      }

      if (cache.get('slack-file:' + files[i].id)) {
        return false;
      }
    }

    for (let j = 0; j < files.length; j += 1) {
      if (!files[j] || !files[j].id) {
        continue;
      }

      cache.put('slack-file:' + files[j].id, '1', FILE_RESPONSE_CACHE_TTL_SECONDS);
    }

    return true;
  } finally {
    lock.releaseLock();
  }
}

function normalizeUserPrompt_(text) {
  const rawText = normalizeText_(text);
  const botUserId = getBotUserId_();
  if (!rawText || !botUserId) {
    return rawText;
  }

  const mention = '<@' + botUserId + '>';
  return normalizeText_(rawText.replace(mention, ''));
}

function containsBotMention_(text) {
  const botUserId = getBotUserId_();
  if (!botUserId) {
    return false;
  }

  return String(text || '').indexOf('<@' + botUserId + '>') >= 0;
}

function getBotUserId_() {
  const cached = CacheService.getScriptCache().get('slack-bot-user-id');
  if (cached) {
    return cached;
  }

  const explicit = normalizeText_(getOptionalProperty_('SLACK_BOT_USER_ID'));
  if (explicit) {
    CacheService.getScriptCache().put('slack-bot-user-id', explicit, EVENT_CACHE_TTL_SECONDS);
    return explicit;
  }

  try {
    const authTest = callSlackApiForm_('auth.test', {});
    if (authTest.user_id) {
      CacheService.getScriptCache().put('slack-bot-user-id', authTest.user_id, EVENT_CACHE_TTL_SECONDS);
      return authTest.user_id;
    }
  } catch (error) {
    console.warn('Failed to resolve Slack bot user id: %s', error.message);
  }

  return '';
}

function getGeminiModel_() {
  return getOptionalProperty_('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
}

function getAllowedChannelId_() {
  return sanitizePlaceholderValue_(getOptionalProperty_('SLACK_ALLOWED_CHANNEL_ID') || DEFAULT_ALLOWED_CHANNEL_ID);
}

function getAllowedTeamId_() {
  return sanitizePlaceholderValue_(getOptionalProperty_('SLACK_TEAM_ID') || DEFAULT_ALLOWED_TEAM_ID);
}

function isAllowedChannel_(channelId) {
  const allowedChannelId = getAllowedChannelId_();
  return !allowedChannelId || channelId === allowedChannelId;
}

function sanitizePlaceholderValue_(value) {
  const normalized = normalizeText_(value);
  if (normalized === 'C0000000000' || normalized === 'T0000000000') {
    return '';
  }

  return normalized;
}

function getRequireMention_() {
  const value = normalizeText_(getOptionalProperty_('SLACK_REQUIRE_MENTION'));
  if (!value) {
    return DEFAULT_REQUIRE_MENTION;
  }

  return value !== 'false' && value !== '0' && value !== 'no';
}

function getMaxMediaFileBytes_() {
  return getNumericProperty_('GEMINI_MAX_MEDIA_FILE_BYTES', DEFAULT_MAX_MEDIA_FILE_BYTES);
}

function getMaxTextFileBytes_() {
  return getNumericProperty_('GEMINI_MAX_TEXT_FILE_BYTES', DEFAULT_MAX_TEXT_FILE_BYTES);
}

function getMaxTextFileChars_() {
  return getNumericProperty_('GEMINI_MAX_TEXT_FILE_CHARS', DEFAULT_MAX_TEXT_FILE_CHARS);
}

function getMaxAttachments_() {
  return getNumericProperty_('GEMINI_MAX_ATTACHMENTS', DEFAULT_MAX_ATTACHMENTS);
}

function getNumericProperty_(name, fallbackValue) {
  const value = normalizeText_(getOptionalProperty_(name));
  const parsed = Number(value);
  return value && !isNaN(parsed) ? parsed : fallbackValue;
}

function getRequiredProperty_(name) {
  const value = getOptionalProperty_(name);
  if (!value) {
    throw new Error('Missing script property: ' + name);
  }

  return value;
}

function getOptionalProperty_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function summarizeSlackFile_(file) {
  return file.name + ' [' + file.mimeType + ', ' + file.size + ' bytes]';
}

function formatSlackReply_(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .split('\n');

  const normalized = [];
  let previousBlank = false;

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].trim();

    if (!line) {
      if (!previousBlank && normalized.length) {
        normalized.push('');
      }
      previousBlank = true;
      continue;
    }

    line = line
      .replace(/^#{1,6}\s+(.+)$/, '*$1*')
      .replace(/^\*\s+\*\*(.+?)\*\*\s*:\s*/, '• *$1*: ')
      .replace(/^\*\s+\*\*(.+?)\*\*\s*$/, '• *$1*')
      .replace(/^[-*]\s+/, '• ')
      .replace(/^(\d+)\)\s+/, '$1. ')
      .replace(/[ \t]{2,}/g, ' ');

    normalized.push(line);
    previousBlank = false;
  }

  return normalized.join('\n').trim();
}

function truncateSlackText_(text) {
  return truncateText_(text, getSlackReplyMaxChars_());
}

function truncateText_(text, maxChars) {
  const value = String(text || '').trim();
  if (value.length <= maxChars) {
    return value;
  }

  return value.substring(0, maxChars - 1) + '…';
}

function findHeaderValue_(response, headerName) {
  const headers = response.getAllHeaders ? response.getAllHeaders() : {};
  const target = String(headerName || '').toLowerCase();

  for (const key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key) && String(key).toLowerCase() === target) {
      return headers[key];
    }
  }

  return '';
}

function normalizeText_(text) {
  return String(text || '').trim();
}

function getSlackReplyMaxChars_() {
  return getNumericProperty_('SLACK_REPLY_MAX_CHARS', DEFAULT_SLACK_REPLY_MAX_CHARS);
}

function isQuotaExceededError_(error) {
  const message = String(error && error.message ? error.message : error || '');
  return message.indexOf('Bandwidth quota exceeded') >= 0 ||
    message.indexOf('Service invoked too many times') >= 0 ||
    message.indexOf('Limit exceeded') >= 0;
}

function jsonOutput_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function textOutput_(value) {
  return ContentService
    .createTextOutput(String(value))
    .setMimeType(ContentService.MimeType.TEXT);
}
