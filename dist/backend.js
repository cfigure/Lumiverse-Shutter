// @bun
// src/settings.ts
var SHUTTER_ICON_IDS = ["aperture", "cherry_blossom", "cat_lotus"];
var DEFAULT_SETTINGS = {
  showFloatWidget: false,
  toastOnInsert: true,
  generationHistory: false,
  gestureNavigation: false,
  afterGenerate: "ask_to_insert",
  widgetSize: "small",
  widgetStyle: "color",
  iconTheme: "aperture",
  autoGenerate: "off",
  autoGenerateInterval: 3,
  autoGenerateRandomMin: 3,
  autoGenerateRandomMax: 7,
  autoGenerateAfter: "auto_insert",
  autoPreviewPrompt: false,
  defaultAction: "append",
  deleteConfirmation: "bulk_only",
  removeImageTagsFromContext: true,
  showPromptInLightbox: false,
  shutterImageLayout: "off",
  shutterImageWidth: 50,
  shutterImageAlign: "center"
};
function clampShutterImageWidth(value) {
  if (!Number.isFinite(value))
    return 100;
  return Math.max(1, Math.min(100, Math.round(value * 10) / 10));
}
function validateSettings(s) {
  const out = { ...s };
  delete out.forceGeneration;
  if (!SHUTTER_ICON_IDS.includes(out.iconTheme)) {
    out.iconTheme = "aperture";
  }
  out.autoGenerateInterval = Math.max(1, Math.round(out.autoGenerateInterval));
  out.autoGenerateRandomMin = Math.max(1, Math.round(out.autoGenerateRandomMin));
  out.autoGenerateRandomMax = Math.max(out.autoGenerateRandomMin, Math.round(out.autoGenerateRandomMax));
  if (out.shutterImageLayout !== "off" && out.shutterImageLayout !== "custom") {
    out.shutterImageLayout = "off";
  }
  if (out.shutterImageAlign !== "left" && out.shutterImageAlign !== "center" && out.shutterImageAlign !== "right") {
    out.shutterImageAlign = "center";
  }
  out.shutterImageWidth = clampShutterImageWidth(Number(out.shutterImageWidth) || 100);
  return out;
}

// src/history.ts
var SHUTTER_IMAGE_GLOBAL_RE = /\n*!\[shutter\]\(\/api\/v1\/(?:images|image-gen\/results)\/[a-f0-9-]+\)/gi;
function normaliseSwipeContent(content) {
  return content.replace(SHUTTER_IMAGE_GLOBAL_RE, "").replace(/\r\n?/g, `
`).trim();
}
function fingerprintSwipeContent(content) {
  const value = normaliseSwipeContent(content);
  let hash = 2166136261;
  for (let i = 0;i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// src/history-store.ts
var HISTORY_STORE_PREFIX = "history/v1";
var HISTORY_STATE_PATH = `${HISTORY_STORE_PREFIX}/state.json`;
function encodeHistoryPathSegment(value) {
  const bytes = new TextEncoder().encode(value);
  let encoded = "";
  for (const byte of bytes)
    encoded += byte.toString(16).padStart(2, "0");
  return encoded || "00";
}
function historyEpochPrefix(epoch) {
  return `${HISTORY_STORE_PREFIX}/epochs/${epoch}/`;
}
function historyChatSnapshotPath(chatId, epoch, slot) {
  return `${historyEpochPrefix(epoch)}chats/${encodeHistoryPathSegment(chatId)}.${slot}.json`;
}
function isHistoryStateV1(value) {
  const state = value;
  return !!state && state.schemaVersion === 1 && Number.isInteger(state.epoch) && state.epoch > 0;
}
function isGenerationTarget(value) {
  const target = value;
  return !!target && typeof target.chatId === "string" && target.chatId.length > 0 && typeof target.messageId === "string" && target.messageId.length > 0 && Number.isInteger(target.swipeId) && target.swipeId >= 0 && (target.swipeDate === null || Number.isFinite(target.swipeDate) && target.swipeDate > 0) && typeof target.swipeFingerprint === "string" && /^[a-f0-9]{8}$/i.test(target.swipeFingerprint) && typeof target.duplicateSwipeDate === "boolean" && Number.isInteger(target.historyEpoch) && target.historyEpoch > 0;
}
function isGenerationHistoryRecord(value) {
  const record = value;
  return !!record && record.version === 1 && typeof record.imageId === "string" && record.imageId.length > 0 && Number.isFinite(record.createdAt) && record.createdAt > 0 && typeof record.prompt === "string" && typeof record.negativePrompt === "string" && typeof record.promptMode === "string" && ["manual", "auto", "regenerate", "rebuild", "preview"].includes(record.origin) && (record.provider === undefined || typeof record.provider === "string") && (record.model === undefined || typeof record.model === "string") && isGenerationTarget(record.target);
}
function parseChatHistorySnapshotV1(value, expected) {
  const raw = value;
  if (!raw || raw.schemaVersion !== 1 || !Number.isInteger(raw.epoch) || raw.epoch <= 0 || typeof raw.chatId !== "string" || raw.chatId.length === 0 || !Number.isInteger(raw.revision) || raw.revision < 0 || !Number.isFinite(raw.createdAt) || raw.createdAt <= 0 || !Number.isFinite(raw.updatedAt) || raw.updatedAt <= 0 || raw.updatedAt < raw.createdAt || !Array.isArray(raw.records))
    return null;
  if (expected?.epoch !== undefined && raw.epoch !== expected.epoch)
    return null;
  if (expected?.chatId !== undefined && raw.chatId !== expected.chatId)
    return null;
  const records = [];
  const imageIds = new Set;
  let malformedRecordCount = 0;
  for (const value of raw.records) {
    if (isGenerationHistoryRecord(value) && value.target.chatId === raw.chatId && value.target.historyEpoch === raw.epoch && !imageIds.has(value.imageId)) {
      imageIds.add(value.imageId);
      records.push(value);
    } else {
      malformedRecordCount++;
    }
  }
  return {
    snapshot: {
      schemaVersion: 1,
      epoch: raw.epoch,
      chatId: raw.chatId,
      revision: raw.revision,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      records
    },
    malformedRecordCount
  };
}
function selectNewestSnapshot(candidates) {
  if (candidates.length === 0)
    return null;
  return [...candidates].sort((left, right) => right.parsed.snapshot.revision - left.parsed.snapshot.revision || right.parsed.snapshot.updatedAt - left.parsed.snapshot.updatedAt || left.slot.localeCompare(right.slot))[0] ?? null;
}
function recordMatchesTarget(record, target) {
  if (record.target.historyEpoch !== target.historyEpoch)
    return false;
  if (record.target.chatId !== target.chatId || record.target.messageId !== target.messageId)
    return false;
  if (record.target.swipeDate !== null && target.swipeDate !== null) {
    if (record.target.swipeDate !== target.swipeDate)
      return false;
    if (record.target.duplicateSwipeDate || target.duplicateSwipeDate) {
      return record.target.swipeFingerprint === target.swipeFingerprint;
    }
    return true;
  }
  return record.target.swipeId === target.swipeId && record.target.swipeFingerprint === target.swipeFingerprint;
}
function optionalEqual(left, right) {
  return (left ?? "") === (right ?? "");
}
function recordMatchesInput(record, target, input) {
  return record.imageId === input.imageId && record.prompt === input.prompt && record.negativePrompt === input.negativePrompt && record.promptMode === input.promptMode && record.origin === input.origin && optionalEqual(record.provider, input.provider) && optionalEqual(record.model, input.model) && record.target.chatId === target.chatId && record.target.messageId === target.messageId && record.target.swipeId === target.swipeId && record.target.swipeDate === target.swipeDate && record.target.swipeFingerprint === target.swipeFingerprint && record.target.duplicateSwipeDate === target.duplicateSwipeDate && record.target.historyEpoch === target.historyEpoch;
}
function createHistoryRecord(target, input, createdAt = Date.now()) {
  return {
    version: 1,
    imageId: input.imageId,
    createdAt,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    promptMode: input.promptMode,
    origin: input.origin,
    provider: input.provider,
    model: input.model,
    target
  };
}
function createChatSnapshot(chatId, epoch, records, revision = records.length > 0 ? 1 : 0, timestamp = Date.now()) {
  return {
    schemaVersion: 1,
    epoch,
    chatId,
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
    records: [...records]
  };
}
function appendRecordToSnapshot(current, record, timestamp = Date.now()) {
  if (!current)
    return createChatSnapshot(record.target.chatId, record.target.historyEpoch, [record], 1, timestamp);
  return {
    ...current,
    revision: current.revision + 1,
    updatedAt: timestamp,
    records: [...current.records, record]
  };
}

// src/backend.ts
async function loadSettings(userId) {
  const saved = await spindle.userStorage.getJson("settings.json", { fallback: {}, userId });
  return validateSettings({ ...DEFAULT_SETTINGS, ...saved });
}
async function saveSettings(patch, userId) {
  const current = await loadSettings(userId);
  const merged = validateSettings({ ...current, ...patch });
  await spindle.userStorage.setJson("settings.json", merged, { indent: 2, userId });
  return merged;
}
var historyQueues = new Map;
function historyQueueKey(userId) {
  return userId || "__extension_owner__";
}
function withHistoryQueue(userId, operation) {
  const key = historyQueueKey(userId);
  const previous = historyQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  const settled = next.then(() => {
    return;
  }, () => {
    return;
  });
  historyQueues.set(key, settled);
  settled.finally(() => {
    if (historyQueues.get(key) === settled)
      historyQueues.delete(key);
  });
  return next;
}
async function readStoredJson(path, userId) {
  if (!await spindle.userStorage.exists(path, userId))
    return { status: "absent" };
  try {
    return { status: "valid", value: await spindle.userStorage.getJson(path, { userId }) };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}
async function writeAndVerifyState(state, userId) {
  await spindle.userStorage.setJson(HISTORY_STATE_PATH, state, { indent: 2, userId });
  const stored = await readStoredJson(HISTORY_STATE_PATH, userId);
  if (stored.status !== "valid" || !isHistoryStateV1(stored.value) || stored.value.epoch !== state.epoch) {
    throw new Error("Generation History state could not be verified after writing.");
  }
}
async function writeAndVerifySnapshot(snapshot, slot, userId) {
  const path = historyChatSnapshotPath(snapshot.chatId, snapshot.epoch, slot);
  try {
    await spindle.userStorage.setJson(path, snapshot, { indent: 2, userId });
    const stored = await readStoredJson(path, userId);
    const parsed = stored.status === "valid" ? parseChatHistorySnapshotV1(stored.value, { epoch: snapshot.epoch, chatId: snapshot.chatId }) : null;
    if (!parsed || parsed.malformedRecordCount > 0 || JSON.stringify(parsed.snapshot) !== JSON.stringify(snapshot)) {
      throw new Error(`Generation History snapshot ${slot.toUpperCase()} could not be verified after writing.`);
    }
  } catch (error) {
    await spindle.userStorage.delete(path, userId).catch(() => {});
    throw error;
  }
}
async function loadHistoryStateUnlocked(userId) {
  const stored = await readStoredJson(HISTORY_STATE_PATH, userId);
  if (stored.status === "valid") {
    if (isHistoryStateV1(stored.value))
      return stored.value;
    throw new Error("Generation History state has an unsupported or malformed schema.");
  }
  if (stored.status === "invalid") {
    throw new Error("Generation History state is corrupt and was not overwritten.");
  }
  const existingFiles = await spindle.userStorage.list(HISTORY_STORE_PREFIX, userId);
  if (existingFiles.length > 0) {
    throw new Error("Generation History files exist without a readable state file and were not overwritten.");
  }
  const state = { schemaVersion: 1, epoch: 1 };
  await writeAndVerifyState(state, userId);
  return state;
}
function loadHistoryState(userId) {
  return withHistoryQueue(userId, () => loadHistoryStateUnlocked(userId));
}
async function loadChatHistoryUnlocked(chatId, epoch, userId) {
  const validCandidates = [];
  const invalidSlots = [];
  for (const slot of ["a", "b"]) {
    const stored = await readStoredJson(historyChatSnapshotPath(chatId, epoch, slot), userId);
    if (stored.status === "absent")
      continue;
    const parsed = stored.status === "valid" ? parseChatHistorySnapshotV1(stored.value, { chatId, epoch }) : null;
    if (!parsed || parsed.malformedRecordCount > 0) {
      invalidSlots.push(slot);
      if (parsed?.malformedRecordCount) {
        spindle.log.warn(`[history] Snapshot ${slot.toUpperCase()} for chat ${chatId} contains ${parsed.malformedRecordCount} malformed record(s); using a complete alternate snapshot when available.`);
      }
      continue;
    }
    validCandidates.push({ slot, parsed });
  }
  const current = selectNewestSnapshot(validCandidates);
  if (!current && invalidSlots.length > 0) {
    throw new Error(`No complete Generation History snapshot is readable for this chat (invalid slot${invalidSlots.length === 1 ? "" : "s"}: ${invalidSlots.join(", ")}).`);
  }
  if (current && invalidSlots.length > 0) {
    spindle.log.warn(`[history] Recovered chat ${chatId} from snapshot ${current.slot.toUpperCase()}; invalid slot: ${invalidSlots.join(", ")}.`);
  }
  return { current, validCandidates, invalidSlots };
}
function sortedTargetHistory(records, target) {
  return records.filter((record) => recordMatchesTarget(record, target)).sort((a, b) => a.createdAt - b.createdAt || a.imageId.localeCompare(b.imageId));
}
async function loadGenerationHistory(target, userId) {
  return withHistoryQueue(userId, async () => {
    const state = await loadHistoryStateUnlocked(userId);
    if (target.historyEpoch !== state.epoch)
      return [];
    const chat = await loadChatHistoryUnlocked(target.chatId, state.epoch, userId);
    return sortedTargetHistory(chat.current?.parsed.snapshot.records ?? [], target);
  });
}
async function appendGenerationHistory(target, input, userId) {
  const settings = await loadSettings(userId);
  if (!settings.generationHistory)
    return [];
  return withHistoryQueue(userId, async () => {
    const state = await loadHistoryStateUnlocked(userId);
    if (target.historyEpoch !== state.epoch)
      return [];
    const loaded = await loadChatHistoryUnlocked(target.chatId, state.epoch, userId);
    const current = loaded.current?.parsed.snapshot ?? null;
    if (loaded.current?.parsed.malformedRecordCount) {
      throw new Error("Generation History contains malformed records and was not rewritten automatically.");
    }
    const records = current?.records ?? [];
    const existing = records.find((record) => record.imageId === input.imageId);
    if (existing) {
      if (!recordMatchesInput(existing, target, input)) {
        throw new Error(`Generation History integrity conflict for image ${input.imageId}.`);
      }
      return sortedTargetHistory(records, target);
    }
    const record = createHistoryRecord(target, input);
    const next = appendRecordToSnapshot(current, record);
    const targetSlot = loaded.current?.slot === "a" ? "b" : "a";
    await writeAndVerifySnapshot(next, targetSlot, userId);
    const stateAfter = await loadHistoryStateUnlocked(userId);
    if (stateAfter.epoch !== target.historyEpoch)
      return [];
    return sortedTargetHistory(next.records, target);
  });
}
async function getGenerationRecord(chatId, imageId, userId) {
  return withHistoryQueue(userId, async () => {
    const state = await loadHistoryStateUnlocked(userId);
    const loaded = await loadChatHistoryUnlocked(chatId, state.epoch, userId);
    return loaded.current?.parsed.snapshot.records.find((record) => record.imageId === imageId && record.target.historyEpoch === state.epoch) ?? null;
  });
}
async function highestStoredHistoryEpochUnlocked(userId) {
  let highest = 0;
  const state = await readStoredJson(HISTORY_STATE_PATH, userId);
  if (state.status === "valid") {
    if (isHistoryStateV1(state.value)) {
      highest = Math.max(highest, state.value.epoch);
    }
  }
  const paths = await spindle.userStorage.list(`${HISTORY_STORE_PREFIX}/epochs/`, userId);
  for (const relativePath of paths) {
    const epoch = Number.parseInt(relativePath.split("/")[0] ?? "", 10);
    if (Number.isInteger(epoch) && epoch > highest)
      highest = epoch;
  }
  return highest;
}
async function clearGenerationHistory(userId) {
  await withHistoryQueue(userId, async () => {
    const highestEpoch = await highestStoredHistoryEpochUnlocked(userId);
    const next = { schemaVersion: 1, epoch: Math.max(1, highestEpoch + 1) };
    await writeAndVerifyState(next, userId);
    const epochsPrefix = `${HISTORY_STORE_PREFIX}/epochs/`;
    const paths = await spindle.userStorage.list(epochsPrefix, userId);
    const staleEpochs = new Set;
    for (const relativePath of paths) {
      const storedEpoch = Number.parseInt(relativePath.split("/")[0] ?? "", 10);
      if (Number.isInteger(storedEpoch) && storedEpoch < next.epoch)
        staleEpochs.add(storedEpoch);
    }
    for (const epoch of staleEpochs) {
      await spindle.userStorage.delete(historyEpochPrefix(epoch), userId).catch(() => {});
    }
  });
}
var SHUTTER_IMAGE_SOURCE = String.raw`\n*!\[shutter\]\(/api/v1/(?:images|image-gen/results)/[a-f0-9-]+\)`;
var SHUTTER_IMAGE_RE = new RegExp(`${SHUTTER_IMAGE_SOURCE}$`, "i");
var SHUTTER_IMAGE_GLOBAL_RE2 = new RegExp(SHUTTER_IMAGE_SOURCE, "gi");
function stripLastShutterImage(content) {
  const match = content.match(SHUTTER_IMAGE_RE);
  if (!match)
    return { content, found: false };
  return { content: content.slice(0, match.index), found: true };
}
function shutterImageIdPattern(imageId) {
  const escaped = imageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`\n*!\[shutter\]\(/api/v1/(?:images|image-gen/results)/${escaped}\)`, "i");
}
function stripShutterImageById(content, imageId) {
  const re = shutterImageIdPattern(imageId);
  if (!re.test(content))
    return { content, found: false };
  return { content: content.replace(re, ""), found: true };
}
function containsShutterImageId(content, imageId) {
  return shutterImageIdPattern(imageId).test(content);
}
function stripAllShutterImages(content) {
  let count = 0;
  const stripped = content.replace(SHUTTER_IMAGE_GLOBAL_RE2, () => {
    count++;
    return "";
  });
  return { content: stripped, count };
}
function stripShutterFromLlmMessage(message) {
  const { content } = message;
  if (typeof content === "string") {
    return { ...message, content: content.replace(SHUTTER_IMAGE_GLOBAL_RE2, "") };
  }
  return {
    ...message,
    content: content.map((part) => part.type === "text" ? { ...part, text: part.text.replace(SHUTTER_IMAGE_GLOBAL_RE2, "") } : part)
  };
}
function orderedMessages(messages) {
  return [...messages].sort((a, b) => a.index_in_chat - b.index_in_chat);
}
function resolveTarget(messages, messageId) {
  if (messageId === "__last__") {
    const ordered = orderedMessages(messages);
    const target = ordered[ordered.length - 1];
    return target ? { target } : { error: "No messages in chat." };
  }
  const target = messages.find((m) => m.id === messageId);
  return target ? { target } : { error: "Message not found." };
}
function buildGenerationTarget(chatId, message, historyEpoch) {
  const swipeId = Number.isFinite(message.swipe_id) ? message.swipe_id : 0;
  const swipeContent = message.swipes?.[swipeId] ?? message.content;
  const rawDate = message.swipe_dates?.[swipeId];
  const swipeDate = Number.isFinite(rawDate) && rawDate > 0 ? rawDate : null;
  const duplicateSwipeDate = swipeDate !== null && message.swipe_dates.filter((value) => value === swipeDate).length > 1;
  return {
    chatId,
    messageId: message.id,
    swipeId,
    swipeDate,
    swipeFingerprint: fingerprintSwipeContent(swipeContent),
    duplicateSwipeDate,
    historyEpoch
  };
}
function resolvePinnedSwipeIndex(message, target) {
  const swipes = Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes : [message.content];
  const dates = Array.isArray(message.swipe_dates) ? message.swipe_dates : [];
  if (target.swipeDate !== null) {
    const candidates = [];
    for (let i = 0;i < dates.length; i++)
      if (dates[i] === target.swipeDate)
        candidates.push(i);
    if (candidates.length === 1)
      return candidates[0];
    if (candidates.length > 1) {
      const byFingerprint = candidates.filter((i) => fingerprintSwipeContent(swipes[i] ?? "") === target.swipeFingerprint);
      if (byFingerprint.length === 1)
        return byFingerprint[0];
    }
  }
  if (target.swipeId >= 0 && target.swipeId < swipes.length) {
    const content = swipes[target.swipeId] ?? "";
    if (fingerprintSwipeContent(content) === target.swipeFingerprint)
      return target.swipeId;
  }
  return null;
}
spindle.onFrontendMessage(async (raw, userId) => {
  const payload = raw;
  try {
    switch (payload.type) {
      case "request_settings": {
        const settings = await loadSettings(userId);
        spindle.sendToFrontend({ type: "settings", settings }, userId);
        break;
      }
      case "update_settings": {
        const settings = await saveSettings(payload.settings, userId);
        spindle.sendToFrontend({ type: "settings", settings }, userId);
        break;
      }
      case "show_toast": {
        spindle.toast[payload.level](payload.message, { userId });
        break;
      }
      case "resolve_generation_target": {
        if (!spindle.permissions.has("chat_mutation")) {
          spindle.sendToFrontend({
            type: "generation_target",
            requestId: payload.requestId,
            target: null,
            error: 'Grant the "Chat Mutation" permission to resolve chat messages.'
          }, userId);
          break;
        }
        const messages = await spindle.chat.getMessages(payload.chatId);
        const { target: message, error } = resolveTarget(messages, payload.messageId);
        let historyEpoch = 1;
        try {
          historyEpoch = (await loadHistoryState(userId)).epoch;
        } catch (historyError) {
          spindle.log.warn(`[history] Target resolved without readable history state: ${historyError instanceof Error ? historyError.message : String(historyError)}`);
        }
        spindle.sendToFrontend({
          type: "generation_target",
          requestId: payload.requestId,
          target: message ? buildGenerationTarget(payload.chatId, message, historyEpoch) : null,
          error
        }, userId);
        break;
      }
      case "append_generation_history": {
        const history = await appendGenerationHistory(payload.target, payload.entry, userId);
        spindle.sendToFrontend({ type: "generation_history", requestId: payload.requestId, history }, userId);
        break;
      }
      case "get_generation_history": {
        const history = await loadGenerationHistory(payload.target, userId);
        spindle.sendToFrontend({ type: "generation_history", requestId: payload.requestId, history }, userId);
        break;
      }
      case "get_generation_record": {
        const record = await getGenerationRecord(payload.chatId, payload.imageId, userId);
        spindle.sendToFrontend({ type: "generation_record", requestId: payload.requestId, record }, userId);
        break;
      }
      case "clear_generation_history": {
        await clearGenerationHistory(userId);
        spindle.sendToFrontend({ type: "history_cleared", requestId: payload.requestId }, userId);
        spindle.sendToFrontend({ type: "generation_history_cleared" }, userId);
        break;
      }
      case "resolve_shutter_tag": {
        let imageId = null;
        let path = null;
        try {
          if (spindle.permissions.has("chat_mutation")) {
            const messages = await spindle.chat.getMessages(payload.chatId);
            const { target: message } = resolveTarget(messages, payload.messageId);
            if (message && typeof message.content === "string") {
              const tagRe = new RegExp(String.raw`!\[shutter\]\((/api/v1/(?:images|image-gen/results)/([a-f0-9-]+))\)`, "gi");
              const tags = [];
              let match;
              while ((match = tagRe.exec(message.content)) !== null) {
                tags.push({ path: match[1], imageId: match[2] });
              }
              const tag = payload.index < 0 ? tags[tags.length + payload.index] ?? null : tags[payload.index] ?? tags[0] ?? null;
              if (tag) {
                imageId = tag.imageId;
                path = tag.path;
              }
            }
          }
        } catch (err) {
          spindle.log.warn(`[lightbox] resolve_shutter_tag failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        spindle.sendToFrontend({ type: "shutter_tag", requestId: payload.requestId, imageId, path }, userId);
        break;
      }
      case "insert_into_message": {
        const reply = (success, changed, reason) => {
          if (!payload.requestId)
            return;
          spindle.sendToFrontend({
            type: "insert_result",
            requestId: payload.requestId,
            success,
            changed,
            reason
          }, userId);
        };
        if (!spindle.permissions.has("chat_mutation")) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to insert images into messages.', { userId });
          reply(false, false, "permission");
          break;
        }
        try {
          const messages = await spindle.chat.getMessages(payload.chatId);
          const requestedId = payload.target?.messageId ?? payload.messageId;
          const { target: message, error } = resolveTarget(messages, requestedId);
          if (!message) {
            spindle.toast.error(error || "Message not found.", { userId });
            reply(false, false, "target_missing");
            break;
          }
          const swipeIndex = payload.target ? resolvePinnedSwipeIndex(message, payload.target) : message.swipe_id;
          if (swipeIndex === null || swipeIndex < 0 || swipeIndex >= message.swipes.length) {
            spindle.toast.error("The message response used for this generation no longer exists.", { userId });
            reply(false, false, "target_missing");
            break;
          }
          const imageUrl = `/api/v1/image-gen/results/${payload.imageId}`;
          let baseContent = message.swipes[swipeIndex] ?? message.content;
          let didReplace = false;
          if (payload.replace) {
            const targetId = payload.replaceImageId;
            if (targetId && !containsShutterImageId(baseContent, targetId)) {
              spindle.toast.error("The image selected for replacement is no longer in that message response.", { userId });
              reply(false, false, "target_missing");
              break;
            }
            if (targetId && targetId === payload.imageId) {
              spindle.toast.info("This image is already in that position.", { userId });
              reply(false, false, "same_image");
              break;
            }
            if (containsShutterImageId(baseContent, payload.imageId)) {
              spindle.toast.info("That image is already in this response, so nothing was replaced.", { userId });
              reply(false, false, "duplicate");
              break;
            }
            const stripped = targetId ? stripShutterImageById(baseContent, targetId) : stripLastShutterImage(baseContent);
            if (!stripped.found) {
              spindle.toast.error("The image selected for replacement is no longer in that message response.", { userId });
              reply(false, false, "target_missing");
              break;
            }
            baseContent = stripped.content;
            didReplace = true;
          } else if (containsShutterImageId(baseContent, payload.imageId)) {
            spindle.log.info(`[insert_into_message] skipped duplicate image insert for ${payload.imageId}`);
            spindle.toast.info("That image is already in this response.", { userId });
            reply(false, false, "duplicate");
            break;
          }
          baseContent += `

![shutter](${imageUrl})`;
          const swipes = [...message.swipes];
          swipes[swipeIndex] = baseContent;
          await spindle.chat.updateMessage(payload.chatId, message.id, {
            swipes,
            swipe_dates: [...message.swipe_dates],
            swipe_id: message.swipe_id
          });
          const settings = await loadSettings(userId);
          if (settings.toastOnInsert) {
            spindle.toast.success(didReplace ? "Image replaced." : "Image inserted into message.", { userId });
          }
          reply(true, true);
        } catch (err) {
          spindle.log.error(`[insert_into_message] ${err instanceof Error ? err.message : String(err)}`);
          reply(false, false, "failed");
        }
        break;
      }
      case "delete_image": {
        if (!spindle.permissions.has("chat_mutation")) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to remove images from messages.', { userId });
          return;
        }
        const messages = await spindle.chat.getMessages(payload.chatId);
        const { target, error } = resolveTarget(messages, payload.messageId);
        if (!target) {
          spindle.toast.error(error || "Message not found.", { userId });
          return;
        }
        const stripped = stripLastShutterImage(target.content);
        if (!stripped.found) {
          spindle.toast.warning("No Shutter image found in message.", { userId });
          return;
        }
        await spindle.chat.updateMessage(payload.chatId, target.id, { content: stripped.content });
        spindle.toast.success("Image removed from message.", { userId });
        break;
      }
      case "delete_all_images": {
        if (!spindle.permissions.has("chat_mutation")) {
          spindle.toast.warning('Grant the "Chat Mutation" permission to remove images from messages.', { userId });
          return;
        }
        const messages = await spindle.chat.getMessages(payload.chatId);
        const { target, error } = resolveTarget(messages, payload.messageId);
        if (!target) {
          spindle.toast.error(error || "Message not found.", { userId });
          return;
        }
        const stripped = stripAllShutterImages(target.content);
        if (stripped.count === 0) {
          spindle.toast.warning("No Shutter images found in message.", { userId });
          return;
        }
        await spindle.chat.updateMessage(payload.chatId, target.id, { content: stripped.content });
        spindle.toast.success(`Removed ${stripped.count} image${stripped.count > 1 ? "s" : ""} from message.`, { userId });
        break;
      }
    }
  } catch (error) {
    const msgType = payload && typeof payload === "object" && "type" in payload ? payload.type : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    spindle.log.error(`[${msgType}] ${message}`);
    const requestId = payload && typeof payload === "object" && "requestId" in payload && typeof payload.requestId === "string" ? payload.requestId : null;
    if (requestId) {
      spindle.sendToFrontend({
        type: "request_failed",
        requestId,
        operation: msgType,
        error: message
      }, userId);
    }
  }
});
var disposeImageTagInterceptor = null;
function ensureImageTagInterceptor() {
  if (disposeImageTagInterceptor || !spindle.permissions.has("interceptor"))
    return;
  const dispose = spindle.registerInterceptor(async (messages, context) => {
    if (disposeImageTagInterceptor !== dispose || !spindle.permissions.has("interceptor"))
      return messages;
    const settings = await loadSettings(context.userId);
    if (disposeImageTagInterceptor !== dispose || !spindle.permissions.has("interceptor") || !settings.removeImageTagsFromContext)
      return messages;
    return messages.map(stripShutterFromLlmMessage);
  });
  disposeImageTagInterceptor = dispose;
  spindle.log.info("[context-tags] Image-tag interceptor registered.");
}
ensureImageTagInterceptor();
spindle.permissions.onChanged(({ permission, granted }) => {
  if (permission !== "interceptor")
    return;
  if (granted) {
    ensureImageTagInterceptor();
  } else {
    disposeImageTagInterceptor?.();
    disposeImageTagInterceptor = null;
    spindle.log.warn('[context-tags] "interceptor" permission revoked; Shutter image tags will remain in context.');
  }
});
spindle.permissions.onDenied(({ permission, operation }) => {
  if (permission !== "interceptor" || operation !== "registerInterceptor")
    return;
  disposeImageTagInterceptor?.();
  disposeImageTagInterceptor = null;
  spindle.log.warn("[context-tags] Image-tag interceptor registration was denied.");
});
if (!spindle.permissions.has("interceptor")) {
  spindle.log.warn('[context-tags] "interceptor" permission not granted; Shutter image tags will remain in context.');
}
spindle.log.info("Shutter loaded!");
