// Generated bundle for Lumiverse Shutter 1.0.7.
const __modules = Object.create(null);

__modules["./backend"] = function(module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const settings_1 = require("./settings");
const history_1 = require("./history");
// Current settings used by backend features that run outside a frontend action.
let liveSettings = { ...settings_1.DEFAULT_SETTINGS };
// ── Storage ──
async function loadSettings(userId) {
    const saved = await spindle.userStorage.getJson('settings.json', { fallback: {}, userId });
    return (0, settings_1.validateSettings)({ ...settings_1.DEFAULT_SETTINGS, ...saved });
}
async function saveSettings(patch, userId) {
    const current = await loadSettings(userId);
    const merged = (0, settings_1.validateSettings)({ ...current, ...patch });
    await spindle.userStorage.setJson('settings.json', merged, { indent: 2, userId });
    return merged;
}
void loadSettings()
    .then(settings => {
    liveSettings = settings;
})
    .catch(error => {
    spindle.log.warn(`[settings] Failed to load saved settings; using defaults: ${error instanceof Error ? error.message : String(error)}`);
});
// ── Durable generation history ──
const HISTORY_PREFIX = 'history/v1';
const HISTORY_STATE_PATH = `${HISTORY_PREFIX}/state.json`;
function safePathSegment(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
function historyEpochPrefix(epoch) {
    return `${HISTORY_PREFIX}/epochs/${epoch}/`;
}
function historyTargetPrefix(target) {
    return `${historyEpochPrefix(target.historyEpoch)}targets/${safePathSegment(target.chatId)}/${safePathSegment(target.messageId)}/`;
}
function historyTargetRecordPath(record) {
    return `${historyTargetPrefix(record.target)}${record.createdAt}-${safePathSegment(record.imageId)}.json`;
}
function historyImageRecordPath(imageId, epoch) {
    return `${historyEpochPrefix(epoch)}records/${safePathSegment(imageId)}.json`;
}
async function loadHistoryState(userId) {
    const state = await spindle.userStorage.getJson(HISTORY_STATE_PATH, {
        fallback: { version: 1, epoch: 1 },
        userId,
    });
    const epoch = Number.isFinite(state?.epoch) && state.epoch > 0 ? Math.floor(state.epoch) : 1;
    return { version: 1, epoch };
}
function isHistoryRecord(value) {
    const record = value;
    return !!record
        && record.version === 1
        && typeof record.imageId === 'string'
        && typeof record.createdAt === 'number'
        && typeof record.prompt === 'string'
        && typeof record.negativePrompt === 'string'
        && typeof record.promptMode === 'string'
        && (record.provider === undefined || typeof record.provider === 'string')
        && (record.model === undefined || typeof record.model === 'string')
        && !!record.target
        && typeof record.target.chatId === 'string'
        && typeof record.target.messageId === 'string';
}
function isHistoryPointer(value) {
    const pointer = value;
    return !!pointer
        && pointer.version === 1
        && typeof pointer.imageId === 'string'
        && typeof pointer.createdAt === 'number'
        && typeof pointer.recordPath === 'string';
}
function recordMatchesTarget(record, target) {
    if (record.target.historyEpoch !== target.historyEpoch)
        return false;
    if (record.target.chatId !== target.chatId || record.target.messageId !== target.messageId)
        return false;
    if (record.target.swipeDate !== null && target.swipeDate !== null) {
        if (record.target.swipeDate !== target.swipeDate)
            return false;
        // Timestamps are normally unique. When either side observed a duplicate,
        // use the stripped-content fingerprint to avoid merging two same-second swipes.
        if (record.target.duplicateSwipeDate || target.duplicateSwipeDate) {
            return record.target.swipeFingerprint === target.swipeFingerprint;
        }
        return true;
    }
    return record.target.swipeId === target.swipeId
        && record.target.swipeFingerprint === target.swipeFingerprint;
}
async function loadGenerationHistory(target, userId) {
    const state = await loadHistoryState(userId);
    if (target.historyEpoch !== state.epoch)
        return [];
    const prefix = historyTargetPrefix(target);
    const paths = await spindle.userStorage.list(prefix, userId);
    const records = [];
    for (let offset = 0; offset < paths.length; offset += 32) {
        const batch = await Promise.all(paths.slice(offset, offset + 32).map((relativePath) => spindle.userStorage.getJson(`${prefix}${relativePath}`, { fallback: null, userId })));
        for (const record of batch) {
            if (isHistoryRecord(record) && recordMatchesTarget(record, target))
                records.push(record);
        }
    }
    records.sort((a, b) => a.createdAt - b.createdAt || a.imageId.localeCompare(b.imageId));
    return records;
}
async function appendGenerationHistory(target, input, userId) {
    const settings = await loadSettings(userId);
    if (!settings.generationHistory)
        return [];
    const stateBefore = await loadHistoryState(userId);
    if (target.historyEpoch !== stateBefore.epoch)
        return [];
    const canonicalPath = historyImageRecordPath(input.imageId, target.historyEpoch);
    const existingPointer = await spindle.userStorage.getJson(canonicalPath, {
        fallback: null,
        userId,
    });
    const existingRecord = isHistoryPointer(existingPointer)
        && existingPointer.recordPath.startsWith(historyEpochPrefix(target.historyEpoch))
        ? await spindle.userStorage.getJson(existingPointer.recordPath, { fallback: null, userId })
        : null;
    const record = isHistoryRecord(existingRecord)
        ? existingRecord
        : {
            version: 1,
            imageId: input.imageId,
            createdAt: Date.now(),
            prompt: input.prompt,
            negativePrompt: input.negativePrompt,
            promptMode: input.promptMode,
            origin: input.origin,
            provider: input.provider,
            model: input.model,
            target,
        };
    const targetPath = historyTargetRecordPath(record);
    const pointer = {
        version: 1,
        imageId: record.imageId,
        createdAt: record.createdAt,
        recordPath: targetPath,
    };
    // Store the full prompt once. The image-ID index is a small pointer used by
    // Prompt View, avoiding a second copy of every potentially long prompt.
    await spindle.userStorage.setJson(targetPath, record, { indent: 2, userId });
    await spindle.userStorage.setJson(canonicalPath, pointer, { indent: 2, userId });
    // A clear can race an in-flight generation from another device. Re-check
    // the epoch after writing and remove the stale files if the clear won.
    const stateAfter = await loadHistoryState(userId);
    if (stateAfter.epoch !== target.historyEpoch) {
        await spindle.userStorage.delete(canonicalPath, userId).catch(() => { });
        await spindle.userStorage.delete(targetPath, userId).catch(() => { });
        return [];
    }
    return loadGenerationHistory(target, userId);
}
async function getGenerationRecord(imageId, userId) {
    const state = await loadHistoryState(userId);
    const pointer = await spindle.userStorage.getJson(historyImageRecordPath(imageId, state.epoch), {
        fallback: null,
        userId,
    });
    if (!isHistoryPointer(pointer) || !pointer.recordPath.startsWith(historyEpochPrefix(state.epoch)))
        return null;
    const record = await spindle.userStorage.getJson(pointer.recordPath, { fallback: null, userId });
    return isHistoryRecord(record) && record.target.historyEpoch === state.epoch ? record : null;
}
async function clearGenerationHistory(userId) {
    const current = await loadHistoryState(userId);
    const next = { version: 1, epoch: current.epoch + 1 };
    // Publish the new epoch first. Any old in-flight generation now fails its
    // post-write epoch check, while a genuinely new generation writes beneath
    // the new epoch and is not swept by this clear operation.
    await spindle.userStorage.setJson(HISTORY_STATE_PATH, next, { indent: 2, userId });
    const epochsPrefix = `${HISTORY_PREFIX}/epochs/`;
    const paths = await spindle.userStorage.list(epochsPrefix, userId);
    const stalePaths = paths.filter((relativePath) => {
        const storedEpoch = Number.parseInt(relativePath.split('/')[0] ?? '', 10);
        // Delete only epochs that existed before this clear began. A concurrent
        // clear may already have advanced the state again; its newer epoch must
        // never be swept by this operation.
        return Number.isFinite(storedEpoch) && storedEpoch <= current.epoch;
    });
    for (let offset = 0; offset < stalePaths.length; offset += 32) {
        await Promise.all(stalePaths.slice(offset, offset + 32).map((relativePath) => spindle.userStorage.delete(`${epochsPrefix}${relativePath}`, userId).catch(() => { })));
    }
}
// ── Image manipulation ──
// The 'Remove Image Tags from Context' setting controls whether these tags are stripped from
// the prompt natively via the interceptor below. Shutter-regex-scripts.json is
// the legacy equivalent (same unanchored 'gi' pattern) for installs on a
// Lumiverse old enough to lack the 'interceptor' permission; keep them in sync.
const SHUTTER_IMAGE_SOURCE = String.raw `\n*!\[shutter\]\(/api/v1/(?:images|image-gen/results)/[a-f0-9-]+\)`;
const SHUTTER_IMAGE_RE = new RegExp(`${SHUTTER_IMAGE_SOURCE}$`, 'i');
const SHUTTER_IMAGE_GLOBAL_RE = new RegExp(SHUTTER_IMAGE_SOURCE, 'gi');
function stripLastShutterImage(content) {
    const match = content.match(SHUTTER_IMAGE_RE);
    if (!match)
        return { content, found: false };
    return { content: content.slice(0, match.index), found: true };
}
function shutterImageIdPattern(imageId) {
    const escaped = imageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(String.raw `\n*!\[shutter\]\(/api/v1/(?:images|image-gen/results)/${escaped}\)`, 'i');
}
function stripShutterImageById(content, imageId) {
    const re = shutterImageIdPattern(imageId);
    if (!re.test(content))
        return { content, found: false };
    return { content: content.replace(re, ''), found: true };
}
function containsShutterImageId(content, imageId) {
    return shutterImageIdPattern(imageId).test(content);
}
function stripAllShutterImages(content) {
    let count = 0;
    const stripped = content.replace(SHUTTER_IMAGE_GLOBAL_RE, () => { count++; return ''; });
    return { content: stripped, count };
}
function stripShutterFromLlmMessage(message) {
    const { content } = message;
    if (typeof content === 'string') {
        return { ...message, content: content.replace(SHUTTER_IMAGE_GLOBAL_RE, '') };
    }
    return {
        ...message,
        content: content.map((part) => part.type === 'text'
            ? { ...part, text: part.text.replace(SHUTTER_IMAGE_GLOBAL_RE, '') }
            : part),
    };
}
function orderedMessages(messages) {
    return [...messages].sort((a, b) => a.index_in_chat - b.index_in_chat);
}
function resolveTarget(messages, messageId) {
    if (messageId === '__last__') {
        const ordered = orderedMessages(messages);
        const target = ordered[ordered.length - 1];
        return target ? { target } : { error: 'No messages in chat.' };
    }
    const target = messages.find(m => m.id === messageId);
    return target ? { target } : { error: 'Message not found.' };
}
function buildGenerationTarget(chatId, message, historyEpoch) {
    const swipeId = Number.isFinite(message.swipe_id) ? message.swipe_id : 0;
    const swipeContent = message.swipes?.[swipeId] ?? message.content;
    const rawDate = message.swipe_dates?.[swipeId];
    const swipeDate = Number.isFinite(rawDate) && rawDate > 0 ? rawDate : null;
    const duplicateSwipeDate = swipeDate !== null
        && message.swipe_dates.filter(value => value === swipeDate).length > 1;
    return {
        chatId,
        messageId: message.id,
        swipeId,
        swipeDate,
        swipeFingerprint: (0, history_1.fingerprintSwipeContent)(swipeContent),
        duplicateSwipeDate,
        historyEpoch,
    };
}
function resolvePinnedSwipeIndex(message, target) {
    const swipes = Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes : [message.content];
    const dates = Array.isArray(message.swipe_dates) ? message.swipe_dates : [];
    if (target.swipeDate !== null) {
        const candidates = [];
        for (let i = 0; i < dates.length; i++)
            if (dates[i] === target.swipeDate)
                candidates.push(i);
        if (candidates.length === 1)
            return candidates[0];
        if (candidates.length > 1) {
            const byFingerprint = candidates.filter(i => (0, history_1.fingerprintSwipeContent)(swipes[i] ?? '') === target.swipeFingerprint);
            if (byFingerprint.length === 1)
                return byFingerprint[0];
        }
    }
    if (target.swipeId >= 0 && target.swipeId < swipes.length) {
        const content = swipes[target.swipeId] ?? '';
        if ((0, history_1.fingerprintSwipeContent)(content) === target.swipeFingerprint)
            return target.swipeId;
    }
    return null;
}
// ── Frontend messages ──
spindle.onFrontendMessage(async (raw, userId) => {
    const payload = raw;
    try {
        switch (payload.type) {
            case 'request_settings': {
                const settings = await loadSettings(userId);
                liveSettings = settings;
                spindle.sendToFrontend({ type: 'settings', settings }, userId);
                break;
            }
            case 'update_settings': {
                const settings = await saveSettings(payload.settings, userId);
                liveSettings = settings;
                spindle.sendToFrontend({ type: 'settings', settings }, userId);
                break;
            }
            case 'show_toast': {
                spindle.toast[payload.level](payload.message, { userId });
                break;
            }
            case 'resolve_generation_target': {
                if (!spindle.permissions.has('chat_mutation')) {
                    spindle.sendToFrontend({
                        type: 'generation_target',
                        requestId: payload.requestId,
                        target: null,
                        error: 'Grant the "Chat Mutation" permission to resolve chat messages.',
                    }, userId);
                    break;
                }
                const messages = await spindle.chat.getMessages(payload.chatId);
                const { target: message, error } = resolveTarget(messages, payload.messageId);
                const state = await loadHistoryState(userId);
                spindle.sendToFrontend({
                    type: 'generation_target',
                    requestId: payload.requestId,
                    target: message ? buildGenerationTarget(payload.chatId, message, state.epoch) : null,
                    error,
                }, userId);
                break;
            }
            case 'append_generation_history': {
                const history = await appendGenerationHistory(payload.target, payload.entry, userId);
                spindle.sendToFrontend({ type: 'generation_history', requestId: payload.requestId, history }, userId);
                break;
            }
            case 'get_generation_history': {
                const history = await loadGenerationHistory(payload.target, userId);
                spindle.sendToFrontend({ type: 'generation_history', requestId: payload.requestId, history }, userId);
                break;
            }
            case 'get_generation_record': {
                const record = await getGenerationRecord(payload.imageId, userId);
                spindle.sendToFrontend({ type: 'generation_record', requestId: payload.requestId, record }, userId);
                break;
            }
            case 'clear_generation_history': {
                await clearGenerationHistory(userId);
                spindle.sendToFrontend({ type: 'history_cleared', requestId: payload.requestId }, userId);
                spindle.sendToFrontend({ type: 'generation_history_cleared' }, userId);
                break;
            }
            case 'resolve_shutter_tag': {
                let imageId = null;
                let path = null;
                try {
                    if (spindle.permissions.has('chat_mutation')) {
                        const messages = await spindle.chat.getMessages(payload.chatId);
                        const { target: message } = resolveTarget(messages, payload.messageId);
                        if (message && typeof message.content === 'string') {
                            const tagRe = new RegExp(String.raw `!\[shutter\]\((/api/v1/(?:images|image-gen/results)/([a-f0-9-]+))\)`, 'gi');
                            const tags = [];
                            let match;
                            while ((match = tagRe.exec(message.content)) !== null) {
                                tags.push({ path: match[1], imageId: match[2] });
                            }
                            const tag = payload.index < 0
                                ? (tags[tags.length + payload.index] ?? null)
                                : (tags[payload.index] ?? tags[0] ?? null);
                            if (tag) {
                                imageId = tag.imageId;
                                path = tag.path;
                            }
                        }
                    }
                }
                catch (err) {
                    spindle.log.warn(`[lightbox] resolve_shutter_tag failed: ${err instanceof Error ? err.message : String(err)}`);
                }
                spindle.sendToFrontend({ type: 'shutter_tag', requestId: payload.requestId, imageId, path }, userId);
                break;
            }
            case 'insert_into_message': {
                const reply = (success, changed, reason) => {
                    if (!payload.requestId)
                        return;
                    spindle.sendToFrontend({
                        type: 'insert_result',
                        requestId: payload.requestId,
                        success,
                        changed,
                        reason,
                    }, userId);
                };
                if (!spindle.permissions.has('chat_mutation')) {
                    spindle.toast.warning('Grant the "Chat Mutation" permission to insert images into messages.', { userId });
                    reply(false, false, 'permission');
                    break;
                }
                try {
                    const messages = await spindle.chat.getMessages(payload.chatId);
                    const requestedId = payload.target?.messageId ?? payload.messageId;
                    const { target: message, error } = resolveTarget(messages, requestedId);
                    if (!message) {
                        spindle.toast.error(error || 'Message not found.', { userId });
                        reply(false, false, 'target_missing');
                        break;
                    }
                    const swipeIndex = payload.target ? resolvePinnedSwipeIndex(message, payload.target) : message.swipe_id;
                    if (swipeIndex === null || swipeIndex < 0 || swipeIndex >= message.swipes.length) {
                        spindle.toast.error('The message response used for this generation no longer exists.', { userId });
                        reply(false, false, 'target_missing');
                        break;
                    }
                    const imageUrl = `/api/v1/image-gen/results/${payload.imageId}`;
                    let baseContent = message.swipes[swipeIndex] ?? message.content;
                    let didReplace = false;
                    // Guard before mutation so rejected replacements remain atomic.
                    if (payload.replace) {
                        const targetId = payload.replaceImageId;
                        if (targetId && !containsShutterImageId(baseContent, targetId)) {
                            spindle.toast.error('The image selected for replacement is no longer in that message response.', { userId });
                            reply(false, false, 'target_missing');
                            break;
                        }
                        if (targetId && targetId === payload.imageId) {
                            spindle.toast.info('This image is already in that position.', { userId });
                            reply(false, false, 'same_image');
                            break;
                        }
                        if (containsShutterImageId(baseContent, payload.imageId)) {
                            spindle.toast.info('That image is already in this response, so nothing was replaced.', { userId });
                            reply(false, false, 'duplicate');
                            break;
                        }
                        const stripped = targetId
                            ? stripShutterImageById(baseContent, targetId)
                            : stripLastShutterImage(baseContent);
                        if (!stripped.found) {
                            spindle.toast.error('The image selected for replacement is no longer in that message response.', { userId });
                            reply(false, false, 'target_missing');
                            break;
                        }
                        baseContent = stripped.content;
                        didReplace = true;
                    }
                    else if (containsShutterImageId(baseContent, payload.imageId)) {
                        spindle.log.info(`[insert_into_message] skipped duplicate image insert for ${payload.imageId}`);
                        spindle.toast.info('That image is already in this response.', { userId });
                        reply(false, false, 'duplicate');
                        break;
                    }
                    baseContent += `

![shutter](${imageUrl})`;
                    const swipes = [...message.swipes];
                    swipes[swipeIndex] = baseContent;
                    await spindle.chat.updateMessage(payload.chatId, message.id, {
                        swipes,
                        swipe_dates: [...message.swipe_dates],
                        swipe_id: message.swipe_id,
                    });
                    const settings = await loadSettings(userId);
                    if (settings.toastOnInsert) {
                        spindle.toast.success(didReplace ? 'Image replaced.' : 'Image inserted into message.', { userId });
                    }
                    reply(true, true);
                }
                catch (err) {
                    spindle.log.error(`[insert_into_message] ${err instanceof Error ? err.message : String(err)}`);
                    reply(false, false, 'failed');
                }
                break;
            }
            case 'delete_image': {
                if (!spindle.permissions.has('chat_mutation')) {
                    spindle.toast.warning('Grant the "Chat Mutation" permission to remove images from messages.', { userId });
                    return;
                }
                const messages = await spindle.chat.getMessages(payload.chatId);
                const { target, error } = resolveTarget(messages, payload.messageId);
                if (!target) {
                    spindle.toast.error(error || 'Message not found.', { userId });
                    return;
                }
                const stripped = stripLastShutterImage(target.content);
                if (!stripped.found) {
                    spindle.toast.warning('No Shutter image found in message.', { userId });
                    return;
                }
                await spindle.chat.updateMessage(payload.chatId, target.id, { content: stripped.content });
                spindle.toast.success('Image removed from message.', { userId });
                break;
            }
            case 'delete_all_images': {
                if (!spindle.permissions.has('chat_mutation')) {
                    spindle.toast.warning('Grant the "Chat Mutation" permission to remove images from messages.', { userId });
                    return;
                }
                const messages = await spindle.chat.getMessages(payload.chatId);
                const { target, error } = resolveTarget(messages, payload.messageId);
                if (!target) {
                    spindle.toast.error(error || 'Message not found.', { userId });
                    return;
                }
                const stripped = stripAllShutterImages(target.content);
                if (stripped.count === 0) {
                    spindle.toast.warning('No Shutter images found in message.', { userId });
                    return;
                }
                await spindle.chat.updateMessage(payload.chatId, target.id, { content: stripped.content });
                spindle.toast.success(`Removed ${stripped.count} image${stripped.count > 1 ? 's' : ''} from message.`, { userId });
                break;
            }
        }
    }
    catch (err) {
        const msgType = (payload && typeof payload === 'object' && 'type' in payload) ? payload.type : 'unknown';
        spindle.log.error(`[${msgType}] ${err.message}`);
    }
});
// ── Image-tag context interceptor ──
let imageTagInterceptorRegistered = false;
function ensureImageTagInterceptor() {
    if (imageTagInterceptorRegistered || !spindle.permissions.has('interceptor'))
        return;
    spindle.registerInterceptor(async (messages) => {
        if (!liveSettings.removeImageTagsFromContext)
            return messages;
        return messages.map(stripShutterFromLlmMessage);
    });
    imageTagInterceptorRegistered = true;
    spindle.log.info('[context-tags] Image-tag interceptor registered.');
}
ensureImageTagInterceptor();
spindle.permissions.onChanged(({ permission, granted }) => {
    if (permission !== 'interceptor')
        return;
    if (granted) {
        ensureImageTagInterceptor();
    }
    else {
        imageTagInterceptorRegistered = false;
        spindle.log.warn('[context-tags] "interceptor" permission revoked; Shutter image tags will remain in context.');
    }
});
spindle.permissions.onDenied(({ permission, operation }) => {
    if (permission !== 'interceptor' || operation !== 'registerInterceptor')
        return;
    imageTagInterceptorRegistered = false;
    spindle.log.warn('[context-tags] Image-tag interceptor registration was denied.');
});
if (!spindle.permissions.has('interceptor')) {
    spindle.log.warn('[context-tags] "interceptor" permission not granted; Shutter image tags will remain in context.');
}
spindle.log.info('Shutter loaded!');

};

__modules["./comms"] = function(module, exports, require) {
"use strict";
// Spindle message-channel round-trips, correlated by requestId with timeout
// fallbacks. The entry owns the single ctx.onBackendMessage subscription.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createComms = createComms;
function createComms(ctx) {
    const pending = new Map();
    function request(kind, type, payload, fallback, timeoutMs = 5000) {
        const requestId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                pending.delete(requestId);
                resolve(fallback);
            }, timeoutMs);
            pending.set(requestId, { kind, resolve, timeout });
            ctx.sendToBackend({ type, requestId, ...payload });
        });
    }
    function resolveGenerationTarget(chatId, messageId) {
        return request('target', 'resolve_generation_target', { chatId, messageId }, null);
    }
    function resolveShutterTag(chatId, messageId, index) {
        return request('tag', 'resolve_shutter_tag', { chatId, messageId, index }, null, 4000);
    }
    function appendGenerationHistory(target, entry) {
        return request('history', 'append_generation_history', { target, entry }, []);
    }
    function getGenerationHistory(target) {
        return request('history', 'get_generation_history', { target }, []);
    }
    function getGenerationRecord(imageId) {
        return request('record', 'get_generation_record', { imageId }, null);
    }
    function clearGenerationHistory() {
        return request('clear', 'clear_generation_history', {}, false, 15000);
    }
    function insertIntoMessage(payload) {
        return request('insert', 'insert_into_message', payload, { success: false, changed: false, reason: 'failed' }, 15000);
    }
    // Returns true when the payload was a comms round-trip reply (consumed).
    function handleBackendMessage(payload) {
        if (!payload || typeof payload.requestId !== 'string')
            return false;
        const entry = pending.get(payload.requestId);
        if (!entry)
            return false;
        const matches = (payload.type === 'generation_target' && entry.kind === 'target')
            || (payload.type === 'shutter_tag' && entry.kind === 'tag')
            || (payload.type === 'generation_history' && entry.kind === 'history')
            || (payload.type === 'generation_record' && entry.kind === 'record')
            || (payload.type === 'history_cleared' && entry.kind === 'clear')
            || (payload.type === 'insert_result' && entry.kind === 'insert');
        if (!matches)
            return false;
        clearTimeout(entry.timeout);
        pending.delete(payload.requestId);
        if (payload.type === 'generation_target') {
            entry.resolve(payload.target ?? null);
        }
        else if (payload.type === 'shutter_tag') {
            entry.resolve(payload.imageId && payload.path ? { imageId: payload.imageId, path: payload.path } : null);
        }
        else if (payload.type === 'generation_history') {
            entry.resolve(Array.isArray(payload.history) ? payload.history : []);
        }
        else if (payload.type === 'generation_record') {
            entry.resolve(payload.record ?? null);
        }
        else if (payload.type === 'insert_result') {
            entry.resolve({ success: payload.success === true, changed: payload.changed === true, reason: payload.reason });
        }
        else {
            entry.resolve(true);
        }
        return true;
    }
    function dispose() {
        for (const [requestId, entry] of pending) {
            clearTimeout(entry.timeout);
            if (entry.kind === 'history')
                entry.resolve([]);
            else if (entry.kind === 'clear')
                entry.resolve(false);
            else if (entry.kind === 'insert')
                entry.resolve({ success: false, changed: false, reason: 'failed' });
            else
                entry.resolve(null);
            pending.delete(requestId);
        }
    }
    return {
        resolveGenerationTarget,
        resolveShutterTag,
        appendGenerationHistory,
        getGenerationHistory,
        getGenerationRecord,
        clearGenerationHistory,
        insertIntoMessage,
        handleBackendMessage,
        dispose,
    };
}

};

__modules["./frontend"] = function(module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setup = setup;
const icons_1 = require("./icons");
const settings_1 = require("./settings");
const styles_1 = require("./styles");
const comms_1 = require("./comms");
const lightbox_1 = require("./lightbox");
const modals_1 = require("./modals");
const settings_panel_1 = require("./settings-panel");
// ── Constants ──
const WIDGET_SIZES = { small: 44, medium: 56, large: 72, xlarge: 96 };
const DRAG_THRESHOLD_PX = 5;
const DRAG_THRESHOLD_MS = 300;
const LONG_PRESS_MS = 500;
// ── Helpers ──
function parseErrorMessage(raw) {
    try {
        const parsed = JSON.parse(raw);
        const msg = parsed.message || parsed.error?.message || (typeof parsed.error === 'string' ? parsed.error : null);
        if (msg)
            return msg;
    }
    catch { /* not full JSON — try substring */ }
    try {
        const i = raw.indexOf('{');
        if (i >= 0) {
            const parsed = JSON.parse(raw.slice(i));
            const msg = parsed.message || parsed.error?.message || (typeof parsed.error === 'string' ? parsed.error : null);
            if (msg)
                return msg;
        }
    }
    catch { /* not JSON at all */ }
    return raw;
}
// ── Setup ──
function setup(ctx) {
    let settings = null;
    let generating = false;
    const comms = (0, comms_1.createComms)(ctx);
    let floatWidget = null;
    let inputAction = null;
    let removeShutterImageLayoutStyle = null;
    function syncShutterImageLayoutStyle() {
        removeShutterImageLayoutStyle?.();
        removeShutterImageLayoutStyle = null;
        if (!settings || settings.shutterImageLayout === 'off')
            return;
        const width = (0, settings_1.clampShutterImageWidth)(settings.shutterImageWidth);
        const align = settings.shutterImageAlign === 'left' || settings.shutterImageAlign === 'right'
            ? settings.shutterImageAlign
            : 'center';
        const textAlign = align;
        const marginLeft = align === 'right' || align === 'center' ? 'auto' : '0';
        const marginRight = align === 'left' || align === 'center' ? 'auto' : '0';
        removeShutterImageLayoutStyle = ctx.dom.addStyle(`
      [data-component="MessageContent"] p:has(img[alt="shutter"]) {
        --shutter-image-width: ${width}%;
        --prose-image-max-width: var(--shutter-image-width);
        --prose-image-max-height: none;
        text-align: ${textAlign} !important;
        overflow: visible !important;
      }
      [data-component="MessageContent"] p:has(img[alt="shutter"]) > span:has(> img[alt="shutter"]),
      [data-component="MessageContent"] p:has(img[alt="shutter"]) > a:has(img[alt="shutter"]) {
        display: block !important;
        width: var(--shutter-image-width) !important;
        max-width: 100% !important;
        max-height: none !important;
        overflow: visible !important;
        margin-left: ${marginLeft} !important;
        margin-right: ${marginRight} !important;
      }
      [data-component="MessageContent"] p:has(img[alt="shutter"]) img[alt="shutter"] {
        display: block !important;
        width: 100% !important;
        height: auto !important;
        max-height: none !important;
        object-fit: contain !important;
        border-radius: 10px !important;
      }
    `);
    }
    // ── Auto-generate state ──
    let autoGenCounter = 0;
    let autoGenTarget = 1;
    function rollAutoGenTarget() {
        if (!settings)
            return;
        switch (settings.autoGenerate) {
            case 'every':
                autoGenTarget = 1;
                break;
            case 'interval':
                autoGenTarget = Math.max(1, settings.autoGenerateInterval);
                break;
            case 'random': {
                const min = Math.max(1, settings.autoGenerateRandomMin);
                const max = Math.max(min, settings.autoGenerateRandomMax);
                autoGenTarget = min + Math.floor(Math.random() * (max - min + 1));
                break;
            }
            default:
                autoGenTarget = Infinity;
        }
    }
    function resetAutoGenCounter() {
        autoGenCounter = 0;
        rollAutoGenTarget();
    }
    // ── Settings change logic (single source of truth) ──
    function applySettingsChange(prev, next) {
        settings = next;
        lightboxPromptLabel.sync();
        syncShutterImageLayoutStyle();
        if (next.showFloatWidget && !prev?.showFloatWidget)
            setupFloatWidget();
        else if (!next.showFloatWidget && prev?.showFloatWidget)
            destroyFloatWidget();
        else if (next.showFloatWidget && prev && next.widgetSize !== prev.widgetSize)
            resizeFloatWidget();
        if (next.showFloatWidget && prev && next.widgetStyle !== prev.widgetStyle)
            updateFloatIcon();
        if (!prev || next.iconTheme !== prev.iconTheme) {
            if (next.showFloatWidget)
                updateFloatIcon();
            updateInputActionIcon();
        }
        if (!prev ||
            next.autoGenerate !== prev.autoGenerate ||
            next.autoGenerateInterval !== prev.autoGenerateInterval ||
            next.autoGenerateRandomMin !== prev.autoGenerateRandomMin ||
            next.autoGenerateRandomMax !== prev.autoGenerateRandomMax) {
            resetAutoGenCounter();
        }
    }
    // ── Optimistic settings update ──
    function updateSettings(patch) {
        if (!settings)
            return;
        const prev = { ...settings };
        const next = { ...settings, ...patch };
        applySettingsChange(prev, next);
        ctx.sendToBackend({ type: 'update_settings', settings: patch });
    }
    // ── Permissions ──
    let grantedPermissions = new Set();
    function applyGrantedPermissions(granted) {
        const hadInterceptor = grantedPermissions.has('interceptor');
        const hadAppManipulation = grantedPermissions.has('app_manipulation');
        grantedPermissions = new Set(granted);
        const hasInterceptor = grantedPermissions.has('interceptor');
        const hasAppManipulation = grantedPermissions.has('app_manipulation');
        // Refresh the permission-sensitive rows if their effective state changed.
        if ((hadInterceptor !== hasInterceptor || hadAppManipulation !== hasAppManipulation) && settings && settingsPanel.isMounted()) {
            settingsPanel.destroy();
            settingsPanel.mount(settings);
        }
        lightboxPromptLabel.sync();
    }
    ctx.permissions.getGranted().then((granted) => {
        applyGrantedPermissions(granted);
        const needed = ['chat_mutation', 'ui_panels', 'interceptor', 'app_manipulation'];
        const missing = needed.filter(p => !granted.includes(p));
        if (missing.length === 0)
            return;
        ctx.ui.showConfirm({
            title: 'Permissions Required',
            message: `Shutter needs: ${missing.join(', ')}. Interceptor access removes Shutter Markdown image tags from model prompts. App Manipulation access shows the generation prompt below Shutter images in the native lightbox.`,
            variant: 'info',
            confirmLabel: 'Grant',
            cancelLabel: 'Not Now',
        }).then(async ({ confirmed }) => {
            if (!confirmed)
                return;
            try {
                const updated = await ctx.permissions.request(missing, {
                    reason: 'Shutter uses chat and panel access for image insertion, interceptor access to remove Shutter Markdown image tags from model prompts, and app manipulation access to show generation prompts in the native image lightbox.',
                });
                applyGrantedPermissions(updated);
            }
            catch {
                ctx.ui.showConfirm({
                    title: 'Permissions Not Granted',
                    message: 'Shutter can still run with limited functionality. Without Interceptor permission, Shutter image tags cannot be removed from model prompts. Without App Manipulation permission, prompts cannot be shown in the image lightbox.',
                    variant: 'info',
                    confirmLabel: 'OK',
                    cancelLabel: 'Dismiss',
                });
            }
        }).catch(() => { });
    });
    // ── Styles ── (static rules live in styles.ts)
    const removeStyle = ctx.dom.addStyle(styles_1.SHUTTER_CSS);
    // ── Settings panel ── moved whole to settings-panel.ts
    const settingsPanel = (0, settings_panel_1.createSettingsPanel)({
        ctx,
        updateSettings,
        hasPermission: (p) => grantedPermissions.has(p),
        clearGenerationHistory: () => comms.clearGenerationHistory(),
    });
    // ── Native ImageGen ──
    let cachedNativeSettings = null;
    let cachedImageProviderLabels = null;
    async function fetchJsonBestEffort(url, timeoutMs = 2000) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok)
                return null;
            return await response.json();
        }
        catch {
            return null;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async function getImageProviderLabels() {
        if (cachedImageProviderLabels)
            return cachedImageProviderLabels;
        const data = await fetchJsonBestEffort('/api/v1/image-gen-connections/providers');
        const labels = new Map();
        if (Array.isArray(data?.providers)) {
            for (const provider of data.providers) {
                if (typeof provider?.id === 'string' && typeof provider?.name === 'string') {
                    labels.set(provider.id, provider.name);
                }
            }
        }
        if (labels.size > 0)
            cachedImageProviderLabels = labels;
        return labels;
    }
    async function resolveImageGenerationSource(connectionId) {
        if (typeof connectionId !== 'string' || !connectionId)
            return null;
        const connection = await fetchJsonBestEffort(`/api/v1/image-gen-connections/${encodeURIComponent(connectionId)}`);
        if (!connection || typeof connection.provider !== 'string')
            return null;
        return {
            providerId: connection.provider,
            model: typeof connection.model === 'string' ? connection.model : '',
        };
    }
    // Raw fetch is deliberate; see the note above callImageGen below.
    async function fetchNativeSettings() {
        try {
            const resp = await fetch('/api/v1/settings/imageGeneration');
            if (!resp.ok)
                throw new Error(await resp.text());
            const data = await resp.json();
            const s = data?.value;
            if (!s || typeof s !== 'object')
                throw new Error('Native ImageGen settings were not returned.');
            cachedNativeSettings = s;
            return s;
        }
        catch (err) {
            if (cachedNativeSettings !== null)
                return cachedNativeSettings;
            const details = err?.message ? ` ${parseErrorMessage(err.message)}` : '';
            throw new Error(`Native ImageGen settings could not be loaded. Make sure Lumiverse ImageGen is available and configured.${details}`);
        }
    }
    // Deliberate raw fetch, and it must stay frontend-side: these are the
    // native scene-pipeline routes, which have no Spindle API equivalent
    // (spindle.imageGen is the connection-profile API, a different pipeline),
    // and they authenticate via the user's browser session, which the backend
    // subprocess does not have.
    async function callImageGen(chatId, overrides, target) {
        const native = await fetchNativeSettings();
        const sourcePromise = resolveImageGenerationSource(native.activeImageGenConnectionId);
        const providerLabelsPromise = getImageProviderLabels();
        const body = {
            ...native,
            ...overrides,
            chatId,
        };
        // Pin native attach-to-message mode to the same response that owns the
        // Shutter history. This prevents a new trailing message from retargeting
        // an in-flight generation.
        if (body.outputTarget === 'attach_to_message' && target) {
            body.attachToMessageId = target.messageId;
        }
        const resp = await fetch('/api/v1/image-gen/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok)
            throw new Error(await resp.text());
        const result = await resp.json();
        if (!result.generated) {
            return { skipped: true, reason: result.reason || 'Scene has not changed enough' };
        }
        if (!result.imageId)
            throw new Error('Image generated but not persisted');
        const providerId = typeof result.provider === 'string' ? result.provider : '';
        const [source, providerLabels] = await Promise.all([sourcePromise, providerLabelsPromise]);
        const provider = providerId ? (providerLabels.get(providerId) || '') : '';
        const model = source && source.providerId === providerId ? source.model : '';
        return {
            imageId: result.imageId,
            imageUrl: result.imageUrl || `/api/v1/image-gen/results/${result.imageId}`,
            handledByNative: !!result.message,
            prompt: typeof result.prompt === 'string' ? result.prompt : (typeof overrides?.prompt === 'string' ? overrides.prompt : ''),
            negativePrompt: typeof result.negativePrompt === 'string' ? result.negativePrompt : (typeof overrides?.negativePrompt === 'string' ? overrides.negativePrompt : ''),
            promptMode: overrides?.skipParse ? 'custom' : (typeof body.promptMode === 'string' ? body.promptMode : 'scene'),
            provider: provider || undefined,
            model: model || undefined,
        };
    }
    async function callPreviewPrompt(chatId) {
        const native = await fetchNativeSettings();
        const resp = await fetch('/api/v1/image-gen/preview-prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId,
                promptMode: native.promptMode,
                prompt: native.customPrompt,
                negativePrompt: native.customNegativePrompt,
                promptPresetId: native.activePromptPresetId,
                promptGenerationTimeoutSeconds: native.promptGenerationTimeoutSeconds,
            }),
        });
        if (!resp.ok)
            throw new Error(await resp.text());
        const result = await resp.json();
        return {
            prompt: result.prompt || '',
            negativePrompt: result.negativePrompt || '',
        };
    }
    // ── Lightbox prompt label (1.0.6) ── moved whole to lightbox.ts
    // The lightbox is constructed before the modal factory below. Keep a tiny
    // indirection so its expanded View History action can open the shared
    // history viewer without changing the compact mobile pill or construction
    // order.
    let openHistoryFromLightbox = () => { };
    const lightboxPromptLabel = (0, lightbox_1.createLightboxPromptLabel)({
        ctx,
        comms,
        getSettings: () => settings,
        hasPermission: (p) => grantedPermissions.has(p),
        openHistory: (records, imageId, closeUnderlyingLightbox) => openHistoryFromLightbox(records, imageId, closeUnderlyingLightbox),
    });
    // ── Post-generation handling ──
    // Native parity note: when a generation is skipped (scene unchanged), the
    // native ImageGenPanel shows the reason as a passive inline banner in the
    // panel. Shutter has no panel surface at trigger time, so the nearest
    // equivalent weight is a toast — passive and non-interrupting, unlike the
    // error modal, which is reserved for genuine failures. Toasts are
    // backend-only in Spindle, hence the message round-trip.
    function notifyGenerationSkipped(reason) {
        ctx.sendToBackend({ type: 'show_toast', level: 'info', message: `${reason} — generation skipped.` });
    }
    function setGeneratingState(active) {
        generating = active;
        updateFloatBtnState();
    }
    async function handleGenerationResult(result, target, isAuto, replace = false, origin = isAuto ? 'auto' : 'manual') {
        setGeneratingState(false);
        resetAutoGenCounter();
        let history = [];
        if (settings?.generationHistory) {
            history = await comms.appendGenerationHistory(target, {
                imageId: result.imageId,
                prompt: result.prompt,
                negativePrompt: result.negativePrompt,
                promptMode: result.promptMode,
                origin,
                provider: result.provider,
                model: result.model,
            });
        }
        // Native output modes own their own UI/insertion, but their successful
        // generations are still useful to Prompt View and cross-device history.
        if (result.handledByNative)
            return;
        const afterAction = isAuto ? settings?.autoGenerateAfter : settings?.afterGenerate;
        if (afterAction === 'auto_insert') {
            ctx.sendToBackend({
                type: 'insert_into_message',
                imageId: result.imageId,
                messageId: target.messageId,
                chatId: target.chatId,
                target,
                replace,
            });
        }
        else {
            modals.openDestinationModal(result, target, isAuto, replace, history);
        }
    }
    // ── Generate ──
    async function triggerGenerate(messageId, chatId, isAuto = false, replace = false, force = false, pinnedTarget, origin = isAuto ? 'auto' : 'manual') {
        if (generating || modals.isPromptPreviewOpen())
            return;
        if (!chatId) {
            const active = ctx.getActiveChat();
            chatId = active.chatId ?? undefined;
            if (!chatId)
                return;
        }
        setGeneratingState(true);
        try {
            const target = pinnedTarget ?? await comms.resolveGenerationTarget(chatId, messageId || '__last__');
            if (!target)
                throw new Error('No message response is available for this generation.');
            const native = await fetchNativeSettings();
            const outputTarget = native.outputTarget || 'background';
            if (isAuto && (outputTarget === 'chat_attachment' || outputTarget === 'attach_to_message')) {
                setGeneratingState(false);
                return;
            }
            const showPreview = native.previewPromptBeforeGenerate
                && (!isAuto || settings?.autoPreviewPrompt);
            if (showPreview) {
                try {
                    const preview = await callPreviewPrompt(chatId);
                    setGeneratingState(false);
                    modals.openPromptPreviewModal(preview.prompt, preview.negativePrompt, target, isAuto, replace, origin);
                }
                catch (err) {
                    setGeneratingState(false);
                    if (!isAuto)
                        modals.showErrorModal(parseErrorMessage(err.message));
                }
                return;
            }
            const result = await callImageGen(chatId, force ? { forceGeneration: true } : undefined, target);
            if ('skipped' in result) {
                setGeneratingState(false);
                if (!isAuto)
                    notifyGenerationSkipped(result.reason);
                return;
            }
            await handleGenerationResult(result, target, isAuto, replace, origin);
        }
        catch (err) {
            setGeneratingState(false);
            if (!isAuto)
                modals.showErrorModal(parseErrorMessage(err.message));
        }
    }
    function updateFloatBtnState() {
        if (!floatWidget)
            return;
        const btn = floatWidget.root.querySelector('.sh-float-btn');
        if (btn) {
            btn.disabled = generating;
            btn.classList.toggle('sh-generating', generating);
        }
    }
    // ── Chat visibility: CHAT_SWITCHED event ──
    const unsubChatSwitched = ctx.events.on('CHAT_SWITCHED', (event) => {
        if (!floatWidget)
            return;
        floatWidget.setVisible(event.chatId !== null);
    });
    // ── Delete image ──
    async function deleteImage() {
        const active = ctx.getActiveChat();
        const chatId = active.chatId ?? undefined;
        if (!chatId)
            return;
        if (settings?.deleteConfirmation === 'always') {
            const { confirmed } = await ctx.ui.showConfirm({
                title: 'Remove Image',
                message: 'Remove the last Shutter image from the last message?',
                variant: 'danger',
                confirmLabel: 'Remove',
            });
            if (!confirmed)
                return;
        }
        ctx.sendToBackend({ type: 'delete_image', messageId: '__last__', chatId });
    }
    async function deleteAllImages() {
        const active = ctx.getActiveChat();
        const chatId = active.chatId ?? undefined;
        if (!chatId)
            return;
        if (settings?.deleteConfirmation !== 'never') {
            const { confirmed } = await ctx.ui.showConfirm({
                title: 'Remove All Images',
                message: 'Remove all Shutter images from the last message? This cannot be undone.',
                variant: 'danger',
                confirmLabel: 'Remove All',
            });
            if (!confirmed)
                return;
        }
        ctx.sendToBackend({ type: 'delete_all_images', messageId: '__last__', chatId });
    }
    // ── Widget context menu ──
    async function showWidgetMenu(x, y) {
        // Consistency with the widget lock: while a generation is in flight the
        // widget is disabled and spinning, so the advanced menu (both long-press
        // and right-click paths route through here) is locked too.
        if (generating)
            return;
        // "Force Generate" is shown only when the native scene gate is live —
        // scene prompt mode with the native forceGeneration setting off (its UI
        // label in the ImageGen panel is "Ignore Scene Change Detection"; the
        // panel's per-press "Force Generate" *button* is the thing this menu item
        // mirrors). That is the only configuration in which the flag is ever
        // consulted server-side: custom and parsed_custom modes never produce a
        // scene (the gate is bypassed entirely), and with the toggle on every
        // press is already forced. In every hidden case the item would be
        // indistinguishable from Append. If native settings can't be read,
        // default to showing it — a redundant menu row is harmless, a missing
        // one isn't recoverable from inside the menu.
        let showForce = true;
        try {
            const native = await fetchNativeSettings();
            const promptMode = native.promptMode || 'scene'; // server defaults absent promptMode to 'scene'
            showForce = promptMode === 'scene' && !native.forceGeneration;
        }
        catch { /* keep showForce = true */ }
        const { selectedKey } = await ctx.ui.showContextMenu({
            position: { x, y },
            items: [
                { key: '_header', label: 'Last Message', disabled: true },
                { key: 'div0', label: '', type: 'divider' },
                { key: 'append', label: 'Append' },
                { key: 'replace', label: 'Replace' },
                ...(showForce ? [{ key: 'force', label: 'Force Generate' }] : []),
                { key: 'div_vp', label: '', type: 'divider' },
                { key: 'view_prompt', label: 'View Prompt' },
                { key: 'div1', label: '', type: 'divider' },
                { key: 'delete', label: 'Remove', danger: true },
                { key: 'delete_all', label: 'Remove All', danger: true },
            ],
        });
        if (selectedKey === 'append')
            triggerGenerate();
        else if (selectedKey === 'replace')
            triggerGenerate(undefined, undefined, false, true);
        else if (selectedKey === 'force')
            triggerGenerate(undefined, undefined, false, settings?.defaultAction === 'replace', true);
        else if (selectedKey === 'view_prompt')
            modals.viewLastPrompt();
        else if (selectedKey === 'delete')
            deleteImage();
        else if (selectedKey === 'delete_all')
            deleteAllImages();
    }
    // ── Float widget ──
    function setupFloatWidget() {
        if (floatWidget)
            return;
        if (!settings)
            return;
        const size = WIDGET_SIZES[settings.widgetSize] || 44;
        floatWidget = ctx.ui.createFloatWidget({
            width: size, height: size,
            initialPosition: { x: 60, y: window.innerHeight - 140 },
            snapToEdge: true, tooltip: 'Shutter', chromeless: true,
        });
        const btn = document.createElement('button');
        btn.className = 'sh-float-btn';
        const icon = (0, icons_1.getIconSet)(settings.iconTheme);
        btn.innerHTML = settings.widgetStyle === 'mono' ? icon.floatingMono : icon.floatingColor;
        let pointerStart = null;
        let longPressTimer = null;
        let longPressFired = false;
        btn.addEventListener('pointerdown', (e) => {
            // Primary button / touch only. Right-click is handled exclusively by
            // the contextmenu listener, so it must not arm the tap or long-press
            // tracker (misc: right-click was triggering a generation AND the menu).
            if (e.button !== 0)
                return;
            pointerStart = { x: e.clientX, y: e.clientY, time: Date.now() };
            longPressFired = false;
            longPressTimer = setTimeout(() => {
                longPressFired = true;
                longPressTimer = null;
                navigator.vibrate?.(50);
                showWidgetMenu(e.clientX, e.clientY);
            }, LONG_PRESS_MS);
        });
        btn.addEventListener('pointermove', (e) => {
            if (!pointerStart || !longPressTimer)
                return;
            const dx = Math.abs(e.clientX - pointerStart.x);
            const dy = Math.abs(e.clientY - pointerStart.y);
            if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        });
        btn.addEventListener('pointerup', (e) => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            if (e.button !== 0) {
                pointerStart = null;
                return;
            }
            if (!pointerStart || longPressFired) {
                pointerStart = null;
                return;
            }
            const dx = Math.abs(e.clientX - pointerStart.x);
            const dy = Math.abs(e.clientY - pointerStart.y);
            const dt = Date.now() - pointerStart.time;
            pointerStart = null;
            if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX && dt < DRAG_THRESHOLD_MS) {
                triggerGenerate(undefined, undefined, false, settings?.defaultAction === 'replace');
            }
        });
        btn.addEventListener('pointercancel', () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            pointerStart = null;
        });
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showWidgetMenu(e.clientX, e.clientY);
        });
        floatWidget.root.appendChild(btn);
        const active = ctx.getActiveChat();
        floatWidget.setVisible(!!active.chatId);
    }
    function destroyFloatWidget() {
        if (!floatWidget)
            return;
        floatWidget.destroy();
        floatWidget = null;
    }
    function resizeFloatWidget() {
        if (!floatWidget)
            return;
        if (!settings)
            return;
        const size = WIDGET_SIZES[settings.widgetSize] || 44;
        floatWidget.setSize(size, size);
    }
    function updateFloatIcon() {
        if (!floatWidget)
            return;
        if (!settings)
            return;
        const svg = floatWidget.root.querySelector('svg');
        if (svg) {
            const btn = svg.parentElement;
            if (btn) {
                const icon = (0, icons_1.getIconSet)(settings.iconTheme);
                btn.innerHTML = settings.widgetStyle === 'mono' ? icon.floatingMono : icon.floatingColor;
            }
        }
    }
    // ── Input bar action ──
    function updateInputActionIcon() {
        const icon = (0, icons_1.getIconSet)(settings?.iconTheme ?? 'aperture');
        inputAction?.destroy();
        inputAction = ctx.ui.registerInputBarAction({
            id: 'shutter-generate',
            label: 'Generate Image',
            iconSvg: icon.inputBar,
        });
        inputAction.onClick(() => triggerGenerate(undefined, undefined, false, settings?.defaultAction === 'replace'));
    }
    updateInputActionIcon();
    // ── Auto-generate: listen for AI messages ──
    // Frontend event listening rides the user's own WebSocket and is ungated.
    // Backend subscriptions to generation lifecycle events require the
    // 'generation' permission. If this listener ever moves server-side,
    // 'generation' goes back into spindle.json.  
    const unsubCharMsg = ctx.events.on('GENERATION_ENDED', (event) => {
        if (!settings || settings.autoGenerate === 'off')
            return;
        if (event.error || event.impersonateDraft)
            return;
        autoGenCounter++;
        if (autoGenCounter >= autoGenTarget) {
            // Auto-insert is anchored to the AI message that triggered it. The
            // image illustrates that response's scene. If the event ever arrives
            // without a messageId, downstream falls back to '__last__' (the
            // literal newest message at insert time).
            triggerGenerate(event.messageId, event.chatId, true);
        }
    });
    // ── Modals ── moved whole to modals.ts
    const modals = (0, modals_1.createModals)({
        ctx,
        comms,
        getSettings: () => settings,
        triggerGenerate,
        handleGenerationResult,
        setGeneratingState,
        callImageGen,
        callPreviewPrompt,
        notifyGenerationSkipped,
        parseErrorMessage,
    });
    openHistoryFromLightbox = (records, imageId, closeUnderlyingLightbox) => modals.openHistoryViewer(records, imageId, closeUnderlyingLightbox);
    // ── Backend messages ──
    const unsubBackend = ctx.onBackendMessage((payload) => {
        // Round-trip replies are consumed by comms.
        if (comms.handleBackendMessage(payload))
            return;
        if (payload.type === 'generation_history_cleared') {
            lightboxPromptLabel.onHistoryCleared();
            modals.onHistoryCleared();
            return;
        }
        if (payload.type !== 'settings')
            return;
        const incoming = payload.settings;
        const isFirstLoad = settings === null;
        const changed = isFirstLoad || Object.keys(incoming).some(key => settings[key] !== incoming[key]);
        if (changed) {
            const prev = settings ? { ...settings } : null;
            applySettingsChange(prev, incoming);
            settingsPanel.applyIncoming(incoming);
        }
    });
    // ── Init ──
    ctx.sendToBackend({ type: 'request_settings' });
    // ── Cleanup ──
    return () => {
        lightboxPromptLabel.dispose();
        comms.dispose();
        unsubBackend();
        unsubCharMsg();
        unsubChatSwitched();
        inputAction?.destroy();
        destroyFloatWidget();
        settingsPanel.destroy();
        modals.dispose();
        removeShutterImageLayoutStyle?.();
        removeShutterImageLayoutStyle = null;
        removeStyle();
        ctx.dom.cleanup();
    };
}

};

__modules["./history"] = function(module, exports, require) {
"use strict";
// Durable Shutter generation-history data shared by the frontend and backend.
// Keep this module environment-neutral: it is bundled into both entries.
Object.defineProperty(exports, "__esModule", { value: true });
exports.normaliseSwipeContent = normaliseSwipeContent;
exports.fingerprintSwipeContent = fingerprintSwipeContent;
exports.imageUrlForHistoryRecord = imageUrlForHistoryRecord;
exports.promptViewFromRecord = promptViewFromRecord;
exports.promptViewFromEmbedded = promptViewFromEmbedded;
exports.humanisePromptMode = humanisePromptMode;
exports.humaniseGenerationOrigin = humaniseGenerationOrigin;
exports.formatPromptMetadataLine = formatPromptMetadataLine;
exports.formatPromptMetadataForClipboard = formatPromptMetadataForClipboard;
const SHUTTER_IMAGE_GLOBAL_RE = /\n*!\[shutter\]\(\/api\/v1\/(?:images|image-gen\/results)\/[a-f0-9-]+\)/gi;
function normaliseSwipeContent(content) {
    return content
        .replace(SHUTTER_IMAGE_GLOBAL_RE, '')
        .replace(/\r\n?/g, '\n')
        .trim();
}
// A small deterministic fingerprint. It is an identity hint, not a security
// primitive; swipe_dates remains the primary durable swipe identity.
function fingerprintSwipeContent(content) {
    const value = normaliseSwipeContent(content);
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
function imageUrlForHistoryRecord(record) {
    return `/api/v1/image-gen/results/${record.imageId}`;
}
function promptViewFromRecord(record) {
    return {
        source: 'shutter',
        prompt: record.prompt,
        negativePrompt: record.negativePrompt,
        createdAt: record.createdAt,
        promptMode: record.promptMode,
        origin: record.origin,
        provider: record.provider,
        model: record.model,
    };
}
function promptViewFromEmbedded(prompt, negativePrompt) {
    return { source: 'embedded', prompt, negativePrompt };
}
function humanisePromptMode(mode) {
    if (!mode)
        return '';
    return mode
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}
function humaniseGenerationOrigin(origin) {
    if (!origin)
        return '';
    switch (origin) {
        case 'auto': return 'Automatic generation';
        case 'regenerate': return 'Regenerate image';
        case 'rebuild': return 'Rebuild prompt';
        case 'preview': return 'Prompt preview';
        default: return 'Manual generation';
    }
}
function formatPromptMetadataLine(view) {
    const details = [view.source === 'shutter' ? 'Saved by Shutter' : 'Embedded in image'];
    if (view.createdAt)
        details.push(new Date(view.createdAt).toLocaleString());
    if (view.provider)
        details.push(`Provider: ${view.provider}`);
    if (view.model)
        details.push(`Model: ${view.model}`);
    return details.join(' · ');
}
function formatPromptMetadataForClipboard(view) {
    const lines = ['Positive Prompt', view.prompt];
    if (view.negativePrompt)
        lines.push('', 'Negative Prompt', view.negativePrompt);
    return lines.join('\n');
}

};

__modules["./icons"] = function(module, exports, require) {
"use strict";
// Shutter icon SVG paths. The mono and colour variants share identical geometry
// but differ in stroke/fill treatment. The input bar icon is a compact version
// sized for the 14x14 action slot.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ICON_SETS = exports.CAT_LOTUS_INPUT_BAR = exports.CAT_LOTUS_FLOAT_COLOR = exports.CAT_LOTUS_FLOAT_MONO = exports.CHERRY_BLOSSOM_INPUT_BAR = exports.CHERRY_BLOSSOM_FLOAT_COLOR = exports.CHERRY_BLOSSOM_FLOAT_MONO = exports.ICON_INPUT_BAR = exports.ICON_FLOAT_COLOR = exports.ICON_FLOAT_MONO = void 0;
exports.getIconSet = getIconSet;
// ── Shared path data ──
const PATHS = {
    hexagon: 'M57.65 36.75h-15.3L34.7 50l7.65 13.25h15.3L65.3 50z',
    right: 'M89.992 49.167c-.003-.134-.009-.268-.013-.401a40.189 40.189 0 0 0-2.25-12.015 40.21 40.21 0 0 0-1.519-3.728l-.078-.168a40.19 40.19 0 0 0-.526-1.061c-.064-.125-.126-.25-.191-.374a38.856 38.856 0 0 0-.449-.826c-.11-.197-.218-.395-.331-.59-.113-.196-.23-.389-.346-.583a40.789 40.789 0 0 0-.49-.801c-.075-.118-.152-.235-.228-.352a38.403 38.403 0 0 0-.657-.987l-.106-.15a40.274 40.274 0 0 0-2.47-3.18L72.95 36.75 65.3 50l-7.65 13.25h30.079a40.189 40.189 0 0 0 2.25-12.015c.004-.134.01-.268.013-.401.006-.277.005-.555.005-.833 0-.279.001-.557-.005-.834z',
    bottomRight: 'M72.95 63.25h-30.6L50 76.5l7.39 12.799a40.164 40.164 0 0 0 11.533-4.061c.116-.063.234-.123.35-.187.244-.134.485-.274.727-.414.24-.139.482-.277.719-.421.114-.069.226-.141.339-.21a40.194 40.194 0 0 0 9.282-7.957 40.274 40.274 0 0 0 2.47-3.18l.106-.15c.224-.325.442-.655.657-.987.076-.117.153-.234.228-.352.167-.264.329-.533.49-.801.116-.194.234-.387.346-.583.113-.195.221-.392.331-.589.152-.275.304-.549.45-.827.065-.123.127-.248.19-.371.18-.353.358-.706.527-1.064l.077-.165a40.135 40.135 0 0 0 1.519-3.73H72.95z',
    bottom: 'M50 76.5l-7.65-13.25L34.7 50l-7.65 13.25-7.39 12.799a40.17 40.17 0 0 0 9.282 7.957c.113.07.225.142.339.21.237.144.478.282.719.421.242.139.483.28.727.414.116.064.233.125.35.187a40.205 40.205 0 0 0 11.533 4.061c1.319.248 2.65.434 3.99.549l.181.016c.393.032.787.055 1.181.075.141.007.282.016.423.021.311.013.623.019.935.024.227.004.453.009.68.008.226 0 .453-.005.68-.008.312-.005.623-.011.935-.024l.423-.021c.394-.02.788-.043 1.181-.075l.181-.016a40.191 40.191 0 0 0 3.99-.549L50 76.5z',
    topRight: 'M71.057 15.994c-.113-.07-.225-.142-.339-.21-.237-.144-.478-.282-.719-.421-.242-.139-.483-.28-.727-.414-.116-.064-.234-.125-.35-.188a40.192 40.192 0 0 0-11.533-4.06 40.132 40.132 0 0 0-3.987-.549c.192.016.384.032.576.051a42.327 42.327 0 0 0-1.013-.091c-.202-.015-.406-.025-.608-.036-.131-.008-.263-.013-.394-.02-.116-.006-.232-.013-.349-.018-.069-.003-.137-.008-.206-.01-.199-.007-.399-.008-.598-.012l-.13-.002c-.227-.004-.453-.009-.68-.008-.226 0-.453.005-.68.008a36.27 36.27 0 0 0-.934.024c-.142.006-.284.015-.426.022-.393.02-.786.043-1.177.075l-.185.017c-1.339.115-2.67.301-3.987.549L50 23.5l7.65 13.25L65.3 50l7.65-13.25 7.39-12.799a40.196 40.196 0 0 0-9.283-7.957z',
    topLeft: 'M50 23.5l-7.39-12.799a40.202 40.202 0 0 0-11.533 4.06c-.117.063-.234.124-.35.188-.244.134-.485.274-.727.414-.24.139-.482.277-.719.421-.114.069-.226.14-.339.21a39.7 39.7 0 0 0-9.288 7.946l-.001-.002-.083.1c-.282.331-.558.665-.828 1.004-.076.095-.15.192-.225.288-.235.3-.467.603-.693.909-.101.138-.2.278-.3.417-.197.275-.393.55-.584.831-.114.168-.224.339-.336.509-.1.151-.197.305-.296.457-.036.055-.072.109-.107.165-.037.059-.077.117-.114.176-.105.167-.205.339-.307.509-.054.089-.109.178-.162.268-.053.089-.108.176-.16.265-.032.055-.066.107-.098.163-.032.055-.06.111-.092.167-.052.09-.099.182-.15.272l-.149.27.065-.116c-.152.274-.304.548-.449.826-.065.124-.128.25-.191.374-.18.352-.357.704-.526 1.061l-.078.168a40.49 40.49 0 0 0-1.519 3.728H57.65L50 23.5z',
    left: 'M27.05 36.75H12.271a40.189 40.189 0 0 0-2.25 12.015c-.004.134-.01.268-.013.401-.006.277-.005.555-.005.833 0 .278-.001.556.005.833.003.134.009.268.013.401a40.189 40.189 0 0 0 2.25 12.015 40.135 40.135 0 0 0 1.519 3.73l.077.165c.169.357.347.711.527 1.064.063.124.125.248.19.371.146.278.298.553.45.827.109.197.218.394.331.589.113.196.23.389.346.583.161.268.323.537.49.801.075.118.152.235.228.352.215.332.432.662.657.987l.106.15a40.274 40.274 0 0 0 2.47 3.18l7.39-12.799L34.7 50l7.65-13.25h-15.3z',
};
const SEGMENT_FILLS = {
    right: '#f47e60',
    bottomRight: '#e15b64',
    bottom: '#77a4bd',
    topRight: '#f8b26a',
    topLeft: '#abbd81',
    left: '#a0c8d7',
};
// ── Builders ──
function buildSegment(key, stroke, fill, strokeWidth) {
    return `<path stroke-miterlimit="10" stroke-width="${strokeWidth}" stroke="${stroke}" fill="${fill}" d="${PATHS[key]}"/>`;
}
function buildShutter(stroke, fills, hexStrokeWidth, segStrokeWidth, wrapper) {
    const hexagon = `<path d="${PATHS.hexagon}" stroke-miterlimit="10" stroke="${stroke}" fill="none" stroke-width="${hexStrokeWidth}"/>`;
    const segments = Object.keys(SEGMENT_FILLS)
        .map(k => buildSegment(k, stroke, fills[k], segStrokeWidth))
        .join('');
    return wrapper(`${hexagon}${segments}`);
}
const NO_FILLS = Object.fromEntries(Object.keys(SEGMENT_FILLS).map(k => [k, 'none']));
// ── Exports ──
/** Monochrome shutter icon for the float widget — inherits colour from context. */
exports.ICON_FLOAT_MONO = buildShutter('currentColor', NO_FILLS, '0.5', '2.412', inner => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid" style="width:60%;height:60%"><g>${inner}</g></svg>`);
/** Colour shutter icon for the float widget. */
exports.ICON_FLOAT_COLOR = buildShutter('#333', SEGMENT_FILLS, '0.5', '2.412', inner => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid" style="width:60%;height:60%"><g>${inner}</g></svg>`);
/** Compact monochrome icon for the input bar action (14×14, inherits currentColor). */
exports.ICON_INPUT_BAR = buildShutter('currentColor', NO_FILLS, '3', '4.824', inner => `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 100 100" fill="none">${inner}</svg>`);
// ── Cherry blossom icon ──
// Normalized directly from the supplied 1010 x 1010 square source SVG into
// Shutter's native 0 0 100 100 coordinate space using one uniform scale.
// All three surfaces share the same baked path geometry.
const CHERRY_BLOSSOM_PATH = 'M39.901 4.208 C39.713 4.317 39.485 4.396 39.396 4.406 C39.267 4.406 38.604 4.723 37.792 5.168 C37.396 5.386 36.238 6.525 35.891 7.03 C35.564 7.495 35.376 7.772 34.653 8.782 C33.99 9.713 33.356 10.673 32.99 11.297 C32.495 12.149 32.426 12.277 32.079 13.02 C31.911 13.376 31.683 13.832 31.574 14.03 C31.475 14.228 31.386 14.475 31.386 14.574 C31.386 14.673 31.297 14.881 31.188 15.05 C31.079 15.208 30.99 15.436 30.99 15.545 C30.99 15.653 30.901 15.911 30.792 16.119 C30.683 16.317 30.594 16.584 30.594 16.703 C30.584 16.832 30.505 17.109 30.396 17.327 C30.287 17.545 30.208 17.842 30.198 18 C30.198 18.149 30.109 18.525 30 18.832 C29.891 19.149 29.802 19.574 29.802 19.802 C29.802 20.02 29.713 20.535 29.604 20.941 C29.495 21.347 29.406 21.802 29.406 21.95 C29.406 22.287 29.198 22.307 28.455 22.069 C28.188 21.99 27.663 21.881 27.277 21.832 C26.901 21.782 26.277 21.683 25.891 21.594 C24.881 21.366 19.267 21.366 18.267 21.594 C17.891 21.683 17.238 21.782 16.832 21.832 C16.426 21.871 15.921 21.98 15.723 22.069 C15.515 22.158 15.208 22.228 15.03 22.228 C14.851 22.228 14.505 22.317 14.267 22.426 C14.03 22.535 13.733 22.624 13.604 22.624 C13.465 22.624 13.188 22.713 12.97 22.822 C12.752 22.931 12.495 23.02 12.386 23.02 C12.277 23.02 12.04 23.109 11.861 23.218 C11.683 23.327 11.455 23.416 11.356 23.416 C11.248 23.416 11.059 23.505 10.921 23.614 C10.782 23.723 10.614 23.812 10.545 23.812 C10.129 23.812 8.02 25.921 8.02 26.337 C8.02 26.406 7.931 26.574 7.822 26.713 C7.713 26.851 7.624 27.03 7.624 27.119 C7.624 27.208 7.535 27.455 7.426 27.673 C7.129 28.248 7.129 31.089 7.426 31.832 C7.535 32.109 7.624 32.436 7.624 32.554 C7.624 32.673 7.713 32.901 7.822 33.069 C7.931 33.228 8.02 33.455 8.02 33.564 C8.02 33.673 8.109 33.891 8.218 34.059 C8.327 34.218 8.416 34.446 8.416 34.554 C8.416 34.663 8.505 34.881 8.614 35.05 C8.723 35.208 8.812 35.436 8.812 35.545 C8.812 35.653 8.901 35.871 9.01 36.04 C9.119 36.198 9.208 36.426 9.208 36.535 C9.208 36.644 9.297 36.861 9.406 37.03 C9.515 37.188 9.604 37.416 9.604 37.525 C9.604 37.634 9.673 37.832 9.762 37.95 C9.931 38.198 9.891 38.465 9.673 38.465 C9.594 38.465 9.455 38.554 9.356 38.663 C9.257 38.772 9.129 38.861 9.059 38.861 C8.99 38.861 8.861 38.95 8.762 39.059 C8.663 39.168 8.535 39.257 8.465 39.257 C8.396 39.257 8.267 39.347 8.168 39.455 C8.069 39.564 7.941 39.653 7.871 39.653 C7.802 39.653 7.673 39.743 7.574 39.851 C7.475 39.96 7.347 40.05 7.277 40.05 C7.208 40.05 7.079 40.139 6.98 40.248 C6.881 40.356 6.752 40.446 6.683 40.446 C6.614 40.446 6.485 40.535 6.386 40.644 C6.287 40.752 6.158 40.842 6.089 40.842 C6.02 40.842 5.891 40.931 5.792 41.04 C5.693 41.149 5.564 41.238 5.495 41.238 C5.426 41.238 5.297 41.327 5.198 41.436 C5.099 41.545 4.97 41.634 4.901 41.634 C4.832 41.634 4.703 41.723 4.604 41.832 C4.505 41.941 4.386 42.03 4.337 42.03 C4.218 42.03 2.99 43.02 2.663 43.376 C2.129 43.96 1.287 45.297 1.287 45.574 C1.277 45.663 1.198 45.921 1.089 46.139 C0.802 46.743 0.802 49.485 1.089 50.02 C1.198 50.228 1.287 50.475 1.287 50.584 C1.287 50.851 2.149 52.257 2.594 52.723 C2.723 52.861 3.743 53.99 4.851 55.248 C7.208 57.911 8.594 59.307 9.96 60.406 C10.99 61.228 12.129 62.03 12.267 62.03 C12.317 62.03 12.406 62.099 12.475 62.188 C12.554 62.267 12.743 62.406 12.911 62.475 C13.228 62.624 13.426 62.743 13.881 63.04 C14.03 63.139 14.218 63.218 14.287 63.218 C14.366 63.218 14.545 63.307 14.683 63.416 C14.822 63.525 15 63.614 15.089 63.614 C15.376 63.614 15.366 63.881 15.079 64.327 C14.653 64.99 14.574 65.119 14.356 65.545 C14.248 65.762 14.05 66.119 13.911 66.337 C13.782 66.554 13.644 66.802 13.614 66.881 C13.495 67.158 13.366 67.426 13.287 67.574 C13.238 67.653 13.109 67.921 13 68.168 C12.891 68.416 12.703 68.812 12.584 69.059 C12.475 69.307 12.376 69.574 12.376 69.653 C12.376 69.733 12.287 69.95 12.178 70.129 C12.069 70.307 11.98 70.545 11.98 70.673 C11.98 70.792 11.891 71.02 11.782 71.188 C11.673 71.347 11.584 71.614 11.584 71.782 C11.584 71.941 11.495 72.257 11.386 72.475 C11.277 72.693 11.198 73.01 11.188 73.168 C11.188 73.337 11.099 73.723 10.99 74.04 C10.881 74.347 10.792 74.792 10.792 75.03 C10.792 75.267 10.723 75.683 10.624 75.95 C10.495 76.337 10.455 76.97 10.426 79.02 C10.386 81.495 10.386 81.624 10.584 82.01 C10.703 82.238 10.792 82.505 10.792 82.604 C10.792 82.713 10.861 82.851 10.941 82.921 C11.02 82.98 11.109 83.129 11.149 83.238 C11.376 83.97 13.01 85.604 13.743 85.832 C13.851 85.871 14 85.96 14.059 86.04 C14.129 86.119 14.267 86.188 14.376 86.188 C14.475 86.188 14.733 86.277 14.95 86.386 C15.317 86.574 15.535 86.584 19.545 86.584 L23.752 86.584 L23.98 86.901 C24.109 87.079 24.257 87.297 24.307 87.386 C24.366 87.475 24.535 87.743 24.703 87.98 C24.861 88.218 25.04 88.485 25.099 88.574 C25.149 88.663 25.327 88.931 25.495 89.168 C25.653 89.406 25.832 89.673 25.891 89.762 C25.941 89.851 26.119 90.119 26.287 90.356 C26.446 90.594 26.624 90.861 26.683 90.95 C26.733 91.04 26.911 91.307 27.079 91.545 C27.238 91.782 27.416 92.05 27.475 92.139 C28.376 93.594 29.713 94.911 30.713 95.327 C30.901 95.406 31.099 95.525 31.129 95.584 C31.168 95.644 31.307 95.693 31.426 95.693 C31.554 95.693 31.851 95.782 32.089 95.891 C32.733 96.178 35.386 96.178 36.03 95.891 C36.267 95.782 36.515 95.693 36.594 95.693 C36.871 95.693 38.248 94.842 39.554 93.861 C39.881 93.614 40.218 93.386 40.297 93.347 C40.376 93.317 40.515 93.228 40.594 93.149 C40.772 92.99 41.376 92.535 41.683 92.327 C43.614 91.03 46.772 87.95 48.416 85.752 C48.772 85.277 49.218 84.673 49.416 84.416 C49.614 84.158 49.812 83.851 49.842 83.733 C49.941 83.446 50.267 83.455 50.356 83.733 C50.396 83.861 50.505 84.069 50.614 84.208 C50.713 84.347 51.119 84.881 51.515 85.396 C51.911 85.911 52.307 86.455 52.396 86.594 C52.485 86.733 53.287 87.604 54.178 88.515 C55.614 90 57.683 91.782 59.059 92.723 C59.257 92.861 59.475 93.02 59.535 93.069 C59.604 93.129 59.762 93.248 59.901 93.337 C60.04 93.436 60.396 93.683 60.693 93.901 C60.99 94.129 61.485 94.465 61.782 94.673 C62.079 94.881 62.347 95.069 62.376 95.099 C62.475 95.208 63.485 95.693 63.624 95.693 C63.703 95.693 63.941 95.782 64.158 95.891 C64.743 96.188 67.535 96.188 68.119 95.891 C68.337 95.782 68.614 95.693 68.752 95.693 C68.891 95.693 69.03 95.644 69.069 95.584 C69.099 95.525 69.287 95.406 69.475 95.337 C70.495 94.901 71.772 93.653 72.723 92.139 C72.782 92.05 72.96 91.782 73.119 91.545 C73.287 91.307 73.465 91.03 73.525 90.931 C73.584 90.822 73.703 90.663 73.792 90.564 C73.891 90.465 73.96 90.337 73.96 90.277 C73.96 90.228 74.05 90.099 74.158 90 C74.267 89.901 74.356 89.772 74.356 89.703 C74.356 89.634 74.446 89.505 74.554 89.406 C74.663 89.307 74.752 89.178 74.752 89.109 C74.752 89.04 74.842 88.911 74.95 88.812 C75.059 88.713 75.149 88.584 75.149 88.515 C75.149 88.446 75.238 88.317 75.347 88.218 C75.455 88.119 75.545 87.99 75.545 87.921 C75.545 87.851 75.634 87.723 75.743 87.624 C75.851 87.525 75.941 87.406 75.941 87.356 C75.941 87.307 76.059 87.109 76.198 86.921 L76.455 86.584 L80.663 86.584 C84.663 86.584 84.881 86.574 85.248 86.386 C85.465 86.277 85.723 86.188 85.822 86.188 C85.931 86.188 86.069 86.119 86.139 86.04 C86.198 85.96 86.347 85.871 86.465 85.832 C87.178 85.604 88.822 83.96 89.05 83.238 C89.089 83.129 89.178 82.98 89.257 82.921 C89.337 82.851 89.406 82.713 89.406 82.604 C89.406 82.505 89.495 82.238 89.614 82.01 C89.812 81.624 89.812 81.495 89.772 79.02 C89.743 76.97 89.703 76.337 89.574 75.95 C89.475 75.683 89.406 75.267 89.406 75.03 C89.406 74.792 89.317 74.347 89.208 74.04 C89.099 73.723 89.01 73.337 89.01 73.168 C89 73.01 88.921 72.693 88.812 72.475 C88.703 72.257 88.624 71.96 88.614 71.812 C88.614 71.663 88.525 71.396 88.416 71.218 C88.307 71.04 88.218 70.792 88.218 70.673 C88.218 70.545 88.129 70.307 88.02 70.129 C87.911 69.95 87.822 69.733 87.822 69.653 C87.822 69.574 87.723 69.307 87.614 69.059 C87.495 68.812 87.307 68.416 87.198 68.168 C87.089 67.921 86.96 67.653 86.911 67.574 C86.832 67.426 86.703 67.158 86.584 66.881 C86.554 66.802 86.416 66.554 86.287 66.337 C86.149 66.119 85.95 65.762 85.842 65.545 C85.624 65.119 85.545 64.99 85.119 64.327 C84.842 63.901 84.822 63.614 85.059 63.614 C85.188 63.614 85.95 63.238 86.584 62.861 C86.802 62.733 87.119 62.564 87.287 62.485 C87.455 62.406 87.644 62.267 87.723 62.188 C87.792 62.099 87.881 62.03 87.931 62.03 C88.069 62.03 89.208 61.238 90.198 60.436 C91.436 59.446 92.931 57.97 94.554 56.139 C95.673 54.881 96.475 53.97 97.475 52.861 C97.861 52.436 98.01 52.238 98.129 52.01 C98.188 51.881 98.277 51.762 98.317 51.733 C98.436 51.634 98.911 50.713 98.911 50.554 C98.921 50.465 99 50.218 99.109 50 C99.277 49.663 99.297 49.386 99.297 48.069 C99.297 46.752 99.277 46.475 99.109 46.139 C99 45.921 98.921 45.644 98.911 45.535 C98.911 45.416 98.842 45.267 98.762 45.198 C98.683 45.139 98.594 44.99 98.554 44.881 C98.287 44.04 96.871 42.614 95.356 41.683 C95.267 41.624 95 41.446 94.762 41.287 C94.525 41.119 94.257 40.941 94.168 40.891 C94.079 40.832 93.812 40.653 93.574 40.495 C93.337 40.327 93.069 40.149 92.98 40.099 C92.891 40.04 92.624 39.861 92.386 39.703 C92.149 39.535 91.881 39.356 91.792 39.307 C91.703 39.248 91.436 39.069 91.198 38.911 C90.96 38.743 90.663 38.554 90.535 38.485 C90.267 38.337 90.228 38.149 90.446 37.97 C90.525 37.901 90.594 37.752 90.594 37.634 C90.594 37.515 90.683 37.257 90.792 37.05 C90.901 36.851 90.99 36.604 90.99 36.515 C90.99 36.416 91.079 36.198 91.188 36.04 C91.297 35.871 91.386 35.673 91.386 35.594 C91.386 35.515 91.475 35.277 91.584 35.069 C91.693 34.871 91.782 34.624 91.782 34.535 C91.782 34.436 91.871 34.218 91.98 34.059 C92.089 33.891 92.178 33.693 92.178 33.614 C92.178 33.535 92.267 33.297 92.376 33.089 C92.485 32.891 92.574 32.634 92.574 32.525 C92.574 32.426 92.663 32.109 92.772 31.832 C92.941 31.406 92.97 31.099 92.97 29.693 C92.97 28.257 92.95 28.02 92.772 27.673 C92.663 27.455 92.574 27.198 92.574 27.089 C92.574 26.98 92.525 26.861 92.465 26.822 C92.406 26.792 92.277 26.564 92.178 26.337 C91.861 25.594 90.188 23.98 89.525 23.772 C89.416 23.733 89.267 23.644 89.208 23.564 C89.139 23.485 88.99 23.416 88.871 23.416 C88.762 23.416 88.515 23.327 88.337 23.218 C88.158 23.109 87.921 23.02 87.812 23.02 C87.703 23.02 87.446 22.931 87.228 22.822 C87.01 22.713 86.733 22.624 86.594 22.624 C86.465 22.624 86.168 22.535 85.931 22.426 C85.693 22.317 85.356 22.228 85.198 22.228 C85.03 22.228 84.644 22.139 84.327 22.03 C84.02 21.921 83.594 21.832 83.376 21.832 C83.158 21.832 82.594 21.743 82.119 21.624 C81.317 21.436 81.04 21.426 77.832 21.465 C75.03 21.495 74.307 21.535 73.861 21.673 C73.564 21.762 73.139 21.832 72.921 21.832 C72.703 21.832 72.238 21.921 71.901 22.03 C70.861 22.356 70.693 22.297 70.693 21.604 C70.693 21.426 70.624 21.069 70.545 20.802 C70.465 20.535 70.396 20.099 70.396 19.842 C70.396 19.574 70.307 19.139 70.198 18.861 C70.089 18.584 70 18.228 70 18.059 C70 17.901 69.911 17.594 69.802 17.376 C69.693 17.158 69.604 16.871 69.604 16.733 C69.604 16.594 69.515 16.317 69.406 16.119 C69.297 15.911 69.208 15.653 69.208 15.545 C69.208 15.436 69.119 15.208 69.01 15.05 C68.901 14.881 68.812 14.663 68.812 14.554 C68.812 14.446 68.723 14.218 68.614 14.059 C68.505 13.891 68.416 13.703 68.416 13.634 C68.416 13.554 68.327 13.386 68.218 13.248 C68.109 13.109 68.02 12.931 68.02 12.851 C68.02 12.772 67.931 12.594 67.822 12.455 C67.713 12.317 67.624 12.119 67.624 12.03 C67.624 11.931 67.554 11.802 67.465 11.733 C67.386 11.653 67.248 11.465 67.168 11.297 C66.99 10.921 66.901 10.772 66.317 9.901 C65.881 9.248 65.713 9.01 64.95 7.941 C64.782 7.713 64.525 7.347 64.386 7.129 C64.069 6.653 62.792 5.366 62.446 5.188 C61.416 4.634 60.941 4.406 60.822 4.406 C60.743 4.406 60.515 4.317 60.297 4.208 C59.723 3.911 56.97 3.911 56.327 4.208 C56.089 4.317 55.812 4.406 55.713 4.406 C55.604 4.406 55.416 4.495 55.277 4.604 C55.139 4.713 54.95 4.802 54.851 4.802 C54.762 4.802 54.604 4.891 54.505 5 C54.406 5.109 54.287 5.198 54.238 5.198 C54.188 5.198 53.931 5.366 53.663 5.564 C53.396 5.772 52.822 6.208 52.386 6.535 C51.941 6.861 51.287 7.366 50.921 7.644 C50.545 7.931 50.178 8.168 50.099 8.168 C50.02 8.168 49.653 7.931 49.277 7.644 C48.911 7.366 48.257 6.861 47.812 6.535 C47.376 6.208 46.802 5.772 46.535 5.564 C46.267 5.366 46.01 5.198 45.96 5.198 C45.911 5.198 45.792 5.109 45.693 5 C45.594 4.891 45.436 4.802 45.347 4.802 C45.248 4.802 45.059 4.713 44.921 4.604 C44.782 4.495 44.594 4.406 44.485 4.406 C44.386 4.406 44.109 4.317 43.871 4.208 C43.248 3.921 40.426 3.921 39.901 4.208 M42.921 7.673 C43.673 7.861 43.901 7.98 44.802 8.663 C46.663 10.069 48.287 11.287 48.901 11.733 C49.406 12.099 49.495 12.129 50.099 12.129 C50.703 12.129 50.792 12.099 51.297 11.733 C51.911 11.287 53.535 10.069 55.396 8.663 C56.297 7.98 56.525 7.861 57.277 7.673 C58.099 7.455 58.495 7.446 59.01 7.614 C59.277 7.703 59.564 7.772 59.653 7.772 C59.911 7.772 60.644 8.248 61.079 8.693 C61.584 9.208 63.069 11.267 63.069 11.436 C63.069 11.485 63.129 11.564 63.208 11.604 C63.277 11.644 63.416 11.812 63.505 11.98 C63.594 12.139 63.752 12.406 63.861 12.574 C63.97 12.733 64.129 13 64.218 13.168 C64.297 13.327 64.515 13.733 64.703 14.059 C64.881 14.386 65.04 14.713 65.04 14.782 C65.05 14.861 65.139 15.03 65.248 15.168 C65.356 15.307 65.446 15.515 65.446 15.634 C65.446 15.743 65.535 15.97 65.644 16.139 C65.752 16.297 65.842 16.515 65.842 16.614 C65.842 16.713 65.931 16.96 66.04 17.178 C66.149 17.396 66.238 17.673 66.238 17.812 C66.238 17.941 66.327 18.238 66.436 18.475 C66.545 18.713 66.634 19.05 66.634 19.218 C66.634 19.386 66.723 19.782 66.832 20.099 C66.941 20.416 67.03 20.911 67.03 21.188 C67.03 21.475 67.099 22.079 67.198 22.535 C67.416 23.663 67.416 26.139 67.198 27.267 C67.099 27.723 67.03 28.337 67.03 28.624 C67.03 28.921 66.941 29.416 66.832 29.723 C66.723 30.04 66.634 30.426 66.634 30.594 C66.634 30.752 66.545 31.089 66.436 31.327 C66.327 31.564 66.238 31.851 66.238 31.97 C66.228 32.079 66.149 32.356 66.04 32.574 C65.931 32.792 65.851 33.05 65.842 33.158 C65.842 33.257 65.752 33.485 65.653 33.653 C65.554 33.822 65.436 34.099 65.396 34.277 C65.366 34.446 65.267 34.644 65.188 34.713 C65.109 34.772 65.05 34.901 65.05 35 C65.05 35.089 64.96 35.287 64.851 35.426 C64.743 35.564 64.653 35.743 64.653 35.822 C64.653 35.901 64.574 36.069 64.475 36.198 C64.376 36.327 64.248 36.545 64.178 36.683 C63.99 37.05 63.802 37.337 63.069 38.416 C62.99 38.535 62.832 38.762 62.723 38.921 C62.614 39.079 62.505 39.228 62.475 39.257 C62.446 39.287 62.099 39.683 61.723 40.149 C60.901 41.139 59.366 42.614 58.317 43.426 C57.119 44.356 57.05 44.406 56.95 44.406 C56.901 44.406 56.782 44.495 56.683 44.604 C56.416 44.891 56.297 44.851 55.713 44.277 C54.812 43.396 53.475 42.594 52.455 42.327 C52.198 42.257 51.941 42.149 51.881 42.079 C51.812 42 51.792 39.832 51.802 35.584 L51.832 29.208 L52.089 29.178 C52.238 29.158 52.436 29.059 52.535 28.95 C52.624 28.851 52.752 28.762 52.822 28.762 C53.089 28.762 54.554 27.089 54.554 26.772 C54.554 26.723 54.644 26.505 54.752 26.287 C54.921 25.96 54.95 25.703 54.95 24.663 C54.95 23.416 54.891 23.158 54.446 22.426 C54.396 22.347 54.277 22.119 54.168 21.931 C53.812 21.287 52.921 20.564 51.941 20.119 C51.406 19.871 51.257 19.851 50.099 19.851 C48.941 19.851 48.792 19.871 48.257 20.119 C47.277 20.564 46.386 21.287 46.03 21.931 C45.921 22.119 45.802 22.347 45.752 22.426 C45.307 23.158 45.248 23.416 45.248 24.703 C45.248 25.812 45.277 26.03 45.446 26.307 C45.554 26.485 45.644 26.683 45.644 26.752 C45.644 26.931 46.228 27.762 46.653 28.188 C47.109 28.644 47.782 29.089 48.119 29.158 L48.366 29.208 L48.396 35.079 C48.406 38.297 48.386 40.941 48.337 40.941 C48.267 40.941 47.822 39.673 47.822 39.455 C47.822 39.396 47.733 39.228 47.624 39.089 C47.515 38.95 47.426 38.752 47.426 38.644 C47.426 38.545 47.347 38.287 47.238 38.089 C47.139 37.891 46.96 37.525 46.851 37.277 C46.188 35.812 45.436 34.376 45.198 34.109 C45.119 34.02 45.05 33.921 45.05 33.881 C45.05 33.822 44.901 33.604 44.149 32.535 C42.802 30.604 40.485 28.218 38.673 26.881 C38.416 26.693 37.99 26.366 37.723 26.158 C37.455 25.96 37.188 25.792 37.139 25.792 C37.089 25.792 36.98 25.733 36.911 25.653 C36.832 25.584 36.644 25.446 36.485 25.356 C36.317 25.267 36.01 25.089 35.792 24.96 C35.168 24.594 33.634 23.832 33.386 23.762 C33.01 23.653 32.842 23.297 32.96 22.851 C33.02 22.644 33.109 22 33.158 21.436 C33.208 20.861 33.327 20.198 33.406 19.96 C33.495 19.723 33.564 19.396 33.564 19.238 C33.564 19.079 33.644 18.743 33.752 18.485 C33.851 18.228 33.98 17.842 34.04 17.624 C34.178 17.05 34.347 16.584 34.564 16.168 C34.663 15.97 34.752 15.713 34.752 15.614 C34.752 15.505 34.842 15.307 34.95 15.168 C35.059 15.03 35.149 14.861 35.158 14.782 C35.158 14.713 35.317 14.386 35.495 14.059 C35.683 13.733 35.901 13.327 35.98 13.168 C36.069 13 36.228 12.733 36.337 12.574 C36.446 12.406 36.604 12.139 36.693 11.98 C36.782 11.812 36.921 11.644 36.99 11.604 C37.069 11.564 37.129 11.485 37.129 11.436 C37.129 11.267 38.614 9.208 39.119 8.693 C39.564 8.238 40.287 7.772 40.564 7.772 C40.663 7.772 40.921 7.703 41.139 7.624 C41.574 7.455 42.178 7.475 42.921 7.673 M50.921 23.337 C52.287 24.228 51.713 26.287 50.109 26.287 C48.505 26.287 47.921 24.257 49.248 23.337 C49.673 23.05 50.485 23.04 50.921 23.337 M24.604 25.05 C25.04 25.129 25.644 25.188 25.941 25.198 C26.248 25.198 26.743 25.287 27.059 25.396 C27.366 25.505 27.792 25.594 27.99 25.594 C28.198 25.594 28.535 25.683 28.743 25.792 C28.941 25.901 29.228 25.99 29.386 25.99 C29.535 25.99 29.822 26.079 30.03 26.188 C30.228 26.297 30.465 26.386 30.554 26.386 C30.644 26.386 30.931 26.475 31.178 26.594 C31.426 26.713 31.832 26.891 32.079 27.01 C32.713 27.297 33.149 27.505 33.465 27.693 C33.545 27.743 33.752 27.842 33.921 27.921 C34.089 27.99 34.277 28.129 34.356 28.208 C34.426 28.297 34.525 28.366 34.584 28.366 C34.95 28.366 37.535 30.366 38.812 31.644 C39.921 32.762 41.683 34.931 41.683 35.178 C41.683 35.228 41.752 35.337 41.842 35.406 C41.931 35.475 42.04 35.624 42.099 35.743 C42.149 35.851 42.297 36.119 42.426 36.337 C42.554 36.554 42.891 37.198 43.168 37.772 C43.446 38.347 43.762 38.98 43.871 39.178 C43.97 39.376 44.059 39.614 44.059 39.703 C44.059 39.782 44.149 40.02 44.257 40.218 C44.366 40.426 44.455 40.663 44.455 40.743 C44.455 40.822 44.545 41.02 44.653 41.188 C44.762 41.347 44.851 41.574 44.851 41.683 C44.851 41.792 44.911 41.97 44.99 42.079 C45.059 42.188 45.198 42.545 45.297 42.861 C45.475 43.436 45.475 43.455 45.297 43.554 C44.941 43.752 43.812 44.95 43.436 45.515 C43.079 46.059 43.059 46.079 42.693 46.02 C42.495 45.99 42.129 45.881 41.891 45.782 C41.653 45.673 41.347 45.594 41.198 45.594 C41.059 45.584 40.762 45.505 40.545 45.396 C40.327 45.287 40.02 45.208 39.871 45.198 C39.723 45.198 39.426 45.109 39.208 45 C38.99 44.891 38.693 44.802 38.545 44.802 C38.396 44.802 38.069 44.713 37.832 44.604 C37.594 44.495 37.287 44.406 37.139 44.406 C37 44.406 36.713 44.317 36.505 44.208 C36.307 44.099 36.02 44.01 35.871 44.01 C35.713 44.01 35.396 43.921 35.158 43.812 C34.921 43.703 34.614 43.614 34.465 43.614 C34.327 43.604 34.03 43.525 33.812 43.416 C33.594 43.307 33.287 43.228 33.139 43.218 C32.99 43.218 32.693 43.129 32.475 43.02 C32.257 42.911 31.96 42.822 31.812 42.822 C31.663 42.822 31.337 42.733 31.099 42.624 C30.861 42.515 30.564 42.426 30.436 42.426 C30.297 42.426 30.03 42.347 29.822 42.238 C29.624 42.139 29.267 42.03 29.05 42.01 C28.307 41.911 28.079 41.743 28.02 41.238 C27.99 40.99 27.891 40.683 27.792 40.545 C27.703 40.416 27.624 40.208 27.624 40.089 C27.624 39.98 27.535 39.802 27.426 39.703 C27.317 39.604 27.228 39.475 27.228 39.406 C27.228 39.149 25.535 37.673 25.238 37.673 C25.188 37.673 24.97 37.584 24.752 37.475 C24.426 37.307 24.168 37.277 23.129 37.277 C21.881 37.277 21.624 37.337 20.891 37.782 C20.812 37.832 20.584 37.95 20.396 38.059 C20.01 38.267 19.257 39.01 19.05 39.366 C18.376 40.574 18.297 40.842 18.297 42.129 C18.297 43.416 18.376 43.683 19.05 44.881 C19.386 45.465 20.594 46.455 21.188 46.634 C21.327 46.673 21.525 46.772 21.634 46.842 C21.97 47.079 24.267 47.03 24.752 46.782 C24.97 46.673 25.188 46.584 25.238 46.584 C25.416 46.584 26.208 46 26.663 45.535 C27.109 45.089 27.109 45.089 27.416 45.238 C27.574 45.327 27.842 45.396 27.99 45.396 C28.139 45.406 28.446 45.485 28.663 45.594 C28.881 45.703 29.188 45.782 29.337 45.792 C29.485 45.792 29.782 45.881 30 45.99 C30.218 46.099 30.515 46.188 30.663 46.188 C30.812 46.188 31.139 46.277 31.376 46.386 C31.614 46.495 31.921 46.584 32.069 46.584 C32.208 46.594 32.505 46.673 32.723 46.782 C32.941 46.891 33.248 46.97 33.396 46.98 C33.545 46.98 33.842 47.069 34.059 47.178 C34.277 47.287 34.574 47.376 34.723 47.376 C34.871 47.386 35.178 47.465 35.396 47.574 C35.614 47.683 35.921 47.762 36.069 47.772 C36.218 47.772 36.515 47.861 36.733 47.97 C36.95 48.079 37.198 48.168 37.297 48.168 C37.574 48.168 39.109 48.604 39.109 48.683 C39.109 48.733 38.832 48.762 38.485 48.762 C38.119 48.762 37.634 48.842 37.297 48.96 C36.99 49.069 36.574 49.158 36.366 49.158 C36.158 49.158 35.861 49.228 35.703 49.307 C35.545 49.386 35.238 49.485 35.01 49.525 C34.792 49.554 34.426 49.663 34.208 49.762 C33.99 49.861 33.713 49.95 33.584 49.95 C33.465 49.95 33.188 50.04 32.97 50.149 C32.752 50.257 32.495 50.347 32.386 50.347 C32.277 50.347 32.04 50.436 31.861 50.545 C31.683 50.653 31.465 50.743 31.386 50.743 C31.307 50.743 31.04 50.842 30.792 50.95 C30.545 51.069 30.149 51.257 29.901 51.366 C29.653 51.475 29.386 51.604 29.307 51.653 C29.228 51.693 29.05 51.782 28.911 51.842 C28.772 51.901 28.594 51.99 28.515 52.04 C28.436 52.089 28.188 52.218 27.97 52.337 C27.436 52.604 26.941 52.881 26.584 53.119 C26.426 53.228 26.149 53.386 25.98 53.455 C25.812 53.535 25.624 53.673 25.545 53.752 C25.475 53.842 25.366 53.911 25.297 53.911 C25.238 53.911 25.099 54 25 54.109 C24.901 54.218 24.782 54.307 24.733 54.307 C24.683 54.307 24.446 54.465 24.208 54.653 C23.98 54.842 23.604 55.129 23.386 55.277 C22.337 55.98 19.356 58.782 18.178 60.178 C17.713 60.733 17.663 60.752 17.337 60.693 C17.149 60.653 16.812 60.535 16.594 60.416 C16.366 60.307 16.109 60.178 16.01 60.129 C15.465 59.861 14.485 59.317 14.347 59.198 C14.267 59.119 14.168 59.059 14.129 59.059 C14.099 59.059 13.881 58.931 13.644 58.762 C13.406 58.604 13.01 58.317 12.743 58.139 C11.812 57.485 10.337 56.109 9.02 54.653 C8.287 53.832 7.634 53.119 7.574 53.059 C7.525 53 7.208 52.644 6.881 52.267 C6.554 51.891 6.109 51.386 5.881 51.139 C5.198 50.386 4.653 49.644 4.653 49.475 C4.653 49.376 4.574 49.168 4.485 49.01 C4.297 48.663 4.257 47.465 4.426 47.267 C4.485 47.188 4.584 46.941 4.653 46.703 C4.772 46.248 5.891 45 6.168 45 C6.248 45 6.386 44.911 6.485 44.802 C6.584 44.693 6.713 44.604 6.782 44.604 C6.851 44.604 6.98 44.515 7.079 44.406 C7.178 44.297 7.307 44.208 7.376 44.208 C7.446 44.208 7.574 44.119 7.673 44.01 C7.772 43.901 7.901 43.812 7.97 43.812 C8.04 43.812 8.168 43.723 8.267 43.614 C8.366 43.505 8.495 43.416 8.564 43.416 C8.634 43.416 8.762 43.327 8.861 43.218 C8.96 43.109 9.089 43.02 9.158 43.02 C9.228 43.02 9.356 42.931 9.455 42.822 C9.554 42.713 9.683 42.624 9.752 42.624 C9.822 42.624 9.95 42.535 10.05 42.426 C10.149 42.317 10.277 42.228 10.347 42.228 C10.416 42.228 10.545 42.139 10.644 42.03 C10.743 41.921 10.871 41.832 10.941 41.832 C11.01 41.832 11.139 41.743 11.238 41.634 C11.337 41.525 11.465 41.436 11.515 41.436 C11.574 41.436 11.703 41.366 11.802 41.267 C11.901 41.178 12.059 41.059 12.168 41 C12.752 40.653 13.178 40.317 13.455 39.98 C13.733 39.644 13.762 39.545 13.762 38.911 C13.762 38.386 13.713 38.149 13.564 37.921 C13.455 37.752 13.366 37.535 13.366 37.426 C13.366 37.317 13.277 37.089 13.168 36.931 C13.059 36.762 12.97 36.545 12.97 36.436 C12.97 36.327 12.881 36.099 12.772 35.941 C12.663 35.772 12.574 35.554 12.574 35.446 C12.574 35.337 12.485 35.109 12.376 34.95 C12.267 34.782 12.178 34.564 12.178 34.455 C12.178 34.347 12.089 34.119 11.98 33.96 C11.871 33.792 11.782 33.574 11.782 33.465 C11.782 33.356 11.693 33.129 11.584 32.97 C11.475 32.802 11.386 32.584 11.386 32.475 C11.386 32.366 11.317 32.168 11.228 32.04 C11.079 31.832 10.95 31.386 10.683 30.119 C10.574 29.614 10.634 29.228 10.941 28.347 C11.139 27.812 11.97 26.911 12.366 26.812 C12.505 26.782 12.782 26.673 12.97 26.564 C13.158 26.465 13.396 26.386 13.485 26.386 C13.584 26.386 13.832 26.297 14.03 26.188 C14.238 26.079 14.525 25.99 14.663 25.99 C14.812 25.99 15.119 25.901 15.356 25.792 C15.594 25.683 15.931 25.594 16.099 25.594 C16.267 25.594 16.693 25.505 17.03 25.396 C17.366 25.287 17.881 25.198 18.158 25.198 C18.446 25.198 18.941 25.149 19.267 25.089 C20.861 24.782 23.05 24.772 24.604 25.05 M80.366 25 C80.594 25.059 81.257 25.139 81.851 25.188 C82.436 25.248 83.089 25.356 83.287 25.436 C83.495 25.525 83.822 25.594 84.03 25.594 C84.238 25.594 84.604 25.683 84.842 25.792 C85.079 25.901 85.386 25.99 85.535 25.99 C85.673 25.99 85.96 26.079 86.168 26.188 C86.366 26.297 86.614 26.386 86.713 26.386 C86.802 26.386 87.05 26.475 87.257 26.584 C87.455 26.693 87.693 26.782 87.772 26.782 C87.851 26.782 88.178 27.03 88.505 27.327 C89.475 28.238 89.822 29.663 89.347 30.802 C89.267 30.98 89.208 31.257 89.208 31.406 C89.208 31.554 89.119 31.812 89.01 31.98 C88.901 32.139 88.812 32.366 88.812 32.475 C88.812 32.584 88.723 32.802 88.614 32.97 C88.505 33.129 88.416 33.356 88.416 33.465 C88.416 33.574 88.327 33.792 88.218 33.96 C88.109 34.119 88.02 34.347 88.02 34.455 C88.02 34.564 87.931 34.782 87.822 34.95 C87.713 35.109 87.624 35.337 87.624 35.446 C87.624 35.554 87.535 35.772 87.426 35.941 C87.317 36.099 87.228 36.327 87.228 36.436 C87.228 36.545 87.139 36.762 87.03 36.931 C86.921 37.089 86.832 37.317 86.832 37.426 C86.832 37.535 86.743 37.752 86.634 37.921 C86.485 38.149 86.436 38.386 86.436 38.911 C86.436 39.545 86.465 39.644 86.743 39.98 C87.02 40.317 87.446 40.653 88.03 41 C88.139 41.059 88.297 41.178 88.396 41.267 C88.495 41.366 88.624 41.436 88.683 41.436 C88.733 41.436 88.861 41.525 88.96 41.634 C89.059 41.743 89.188 41.832 89.257 41.832 C89.327 41.832 89.455 41.921 89.554 42.03 C89.653 42.139 89.782 42.228 89.851 42.228 C89.921 42.228 90.05 42.317 90.149 42.426 C90.248 42.535 90.376 42.624 90.446 42.624 C90.515 42.624 90.644 42.713 90.743 42.822 C90.842 42.931 90.97 43.02 91.04 43.02 C91.109 43.02 91.238 43.109 91.337 43.218 C91.436 43.327 91.564 43.416 91.634 43.416 C91.703 43.416 91.832 43.505 91.931 43.614 C92.03 43.723 92.158 43.812 92.228 43.812 C92.297 43.812 92.426 43.901 92.525 44.01 C92.624 44.119 92.752 44.208 92.822 44.208 C92.891 44.208 93.02 44.297 93.119 44.406 C93.218 44.515 93.347 44.604 93.416 44.604 C93.485 44.604 93.614 44.693 93.713 44.802 C93.812 44.911 93.95 45 94.03 45 C94.099 45 94.446 45.277 94.782 45.624 C95.347 46.188 95.436 46.327 95.683 47.109 C95.97 48.02 95.97 48.485 95.683 49.04 C95.604 49.188 95.545 49.376 95.545 49.475 C95.545 49.644 95 50.386 94.317 51.139 C94.089 51.386 93.644 51.891 93.317 52.267 C92.99 52.644 92.653 53.02 92.564 53.109 C92.485 53.198 91.881 53.871 91.218 54.604 C89.376 56.663 87.653 58.178 86.139 59.059 C85.95 59.168 85.663 59.347 85.495 59.455 C85.337 59.554 84.733 59.871 84.158 60.149 C83.584 60.426 82.95 60.743 82.752 60.851 C82.554 60.95 82.317 61.04 82.228 61.04 C82.149 61.04 81.911 61.129 81.713 61.238 C81.505 61.347 81.248 61.436 81.129 61.436 C81.01 61.436 80.723 61.525 80.485 61.634 C80.248 61.743 79.911 61.832 79.752 61.832 C79.584 61.832 79.198 61.921 78.881 62.03 C78.574 62.139 78.099 62.228 77.832 62.228 C77.564 62.228 76.98 62.297 76.525 62.396 C75.416 62.614 73.02 62.614 71.891 62.386 C71.436 62.297 70.861 62.228 70.604 62.228 C70.347 62.228 69.891 62.139 69.574 62.03 C69.267 61.921 68.881 61.832 68.713 61.832 C68.545 61.832 68.238 61.743 68.02 61.634 C67.802 61.525 67.525 61.436 67.406 61.436 C67.277 61.436 67.01 61.347 66.802 61.238 C66.604 61.129 66.356 61.04 66.267 61.04 C66.168 61.04 65.941 60.95 65.762 60.842 C65.584 60.733 65.356 60.644 65.257 60.644 C65.158 60.644 64.96 60.554 64.822 60.446 C64.683 60.337 64.505 60.248 64.426 60.248 C64.347 60.248 64.168 60.158 64.03 60.05 C63.891 59.941 63.752 59.851 63.723 59.851 C63.663 59.851 62.743 59.327 62.327 59.059 C61.743 58.673 60.931 58.109 60.822 58.02 C60.762 57.97 60.495 57.743 60.238 57.525 C59.426 56.861 58.703 56.188 57.772 55.277 C57.02 54.525 56.911 54.366 57.01 54.228 C57.663 53.287 58.119 51.782 58.119 50.584 C58.119 49.485 58.178 49.356 58.683 49.356 C58.871 49.356 59.188 49.267 59.406 49.158 C59.624 49.05 59.921 48.96 60.069 48.96 C60.218 48.95 60.525 48.871 60.743 48.762 C60.96 48.653 61.257 48.574 61.396 48.564 C61.545 48.564 61.851 48.475 62.089 48.366 C62.327 48.257 62.653 48.168 62.802 48.168 C62.95 48.168 63.248 48.079 63.465 47.97 C63.683 47.861 63.96 47.772 64.099 47.772 C64.228 47.772 64.525 47.683 64.762 47.574 C65 47.465 65.327 47.376 65.475 47.376 C65.624 47.376 65.921 47.287 66.139 47.178 C66.356 47.069 66.653 46.98 66.802 46.98 C66.95 46.97 67.257 46.891 67.475 46.782 C67.693 46.673 67.99 46.594 68.129 46.584 C68.277 46.584 68.584 46.495 68.822 46.386 C69.059 46.277 69.386 46.188 69.535 46.188 C69.683 46.188 69.98 46.099 70.198 45.99 C70.416 45.881 70.693 45.792 70.832 45.792 C70.96 45.792 71.257 45.703 71.495 45.594 C71.733 45.485 72.059 45.396 72.208 45.396 C72.356 45.396 72.614 45.327 72.782 45.248 C73.069 45.089 73.079 45.089 73.525 45.535 C74 46.02 74.792 46.584 74.98 46.584 C75.05 46.584 75.248 46.673 75.426 46.782 C75.703 46.95 75.921 46.98 77.03 46.98 C78.317 46.98 78.574 46.921 79.307 46.475 C79.386 46.426 79.614 46.307 79.802 46.198 C80.446 45.842 81.168 44.95 81.614 43.97 C81.861 43.436 81.881 43.287 81.881 42.089 C81.881 41.149 81.842 40.733 81.743 40.594 C81.673 40.485 81.574 40.287 81.535 40.149 C81.347 39.505 80.406 38.396 79.743 38.03 C79.584 37.941 79.386 37.832 79.307 37.782 C78.574 37.337 78.317 37.277 77.069 37.277 C76.03 37.277 75.772 37.307 75.446 37.475 C75.228 37.584 75.01 37.673 74.96 37.673 C74.802 37.673 73.95 38.277 73.564 38.663 C73.158 39.069 72.574 39.901 72.574 40.079 C72.574 40.149 72.495 40.327 72.406 40.495 C72.317 40.653 72.218 40.99 72.188 41.238 C72.119 41.743 71.891 41.911 71.149 42.01 C70.931 42.03 70.574 42.139 70.376 42.238 C70.168 42.347 69.901 42.426 69.762 42.426 C69.634 42.426 69.337 42.515 69.099 42.624 C68.861 42.733 68.535 42.822 68.386 42.822 C68.238 42.822 67.941 42.911 67.723 43.02 C67.505 43.129 67.208 43.218 67.059 43.218 C66.911 43.228 66.604 43.307 66.386 43.416 C66.168 43.525 65.871 43.604 65.733 43.614 C65.584 43.614 65.277 43.703 65.04 43.812 C64.802 43.921 64.475 44.01 64.327 44.01 C64.178 44.01 63.891 44.089 63.683 44.198 C63.277 44.396 62.545 44.545 62.594 44.416 C62.614 44.366 62.941 44 63.317 43.584 C64.733 42.079 66.436 39.941 66.436 39.673 C66.436 39.624 66.505 39.515 66.594 39.446 C66.683 39.376 66.792 39.228 66.842 39.109 C66.891 39 67.059 38.683 67.218 38.416 C67.386 38.139 67.574 37.782 67.653 37.614 C67.733 37.446 67.851 37.267 67.911 37.238 C67.97 37.198 68.02 37.089 68.02 36.99 C68.02 36.891 68.109 36.693 68.218 36.554 C68.327 36.416 68.416 36.218 68.416 36.109 C68.416 36.01 68.505 35.802 68.614 35.663 C68.723 35.525 68.812 35.337 68.812 35.228 C68.812 35.129 68.901 34.901 69.01 34.723 C69.119 34.545 69.208 34.307 69.208 34.178 C69.208 34.059 69.297 33.822 69.406 33.663 C69.515 33.495 69.604 33.248 69.604 33.109 C69.604 32.96 69.693 32.653 69.802 32.416 C69.911 32.178 70 31.861 70 31.703 C70 31.554 70.089 31.178 70.198 30.871 C70.307 30.554 70.396 30.099 70.396 29.842 C70.396 29.594 70.465 29.168 70.554 28.901 C70.634 28.634 70.733 27.901 70.762 27.277 C70.822 26.109 70.881 25.891 71.188 25.891 C71.287 25.891 71.495 25.822 71.644 25.743 C71.802 25.663 72.069 25.594 72.238 25.594 C72.406 25.594 72.802 25.505 73.119 25.396 C73.436 25.287 73.921 25.198 74.188 25.198 C74.455 25.198 75.109 25.129 75.634 25.05 C77.277 24.802 79.347 24.782 80.366 25 M23.98 40.762 C25.356 41.673 24.792 43.713 23.168 43.713 C21.564 43.713 20.98 41.683 22.317 40.762 C22.752 40.475 23.535 40.465 23.98 40.762 M77.851 40.762 C79.218 41.653 78.644 43.713 77.04 43.713 C75.436 43.713 74.851 41.683 76.178 40.762 C76.604 40.475 77.416 40.465 77.851 40.762 M51.584 45.525 C55.95 47.069 55.95 53.03 51.584 54.574 C50.723 54.881 49.267 54.891 48.624 54.604 C48.386 54.495 48.158 54.406 48.109 54.406 C47.97 54.406 47.099 53.782 46.733 53.416 C46.366 53.05 45.743 52.178 45.743 52.04 C45.743 51.99 45.653 51.762 45.545 51.525 C45.099 50.535 45.347 48.634 46.069 47.495 C47.238 45.673 49.604 44.822 51.584 45.525 M42.366 52.426 C42.634 53.257 43.119 54.178 43.683 54.911 L44.05 55.386 L43.634 55.931 C43.406 56.238 42.97 56.822 42.673 57.228 C42.376 57.644 41.941 58.218 41.713 58.515 C41.475 58.802 41.287 59.079 41.287 59.109 C41.287 59.139 41.099 59.416 40.871 59.703 C40.634 60 40.267 60.485 40.05 60.792 C39.832 61.099 39.584 61.426 39.505 61.535 C39.426 61.644 39.248 61.891 39.109 62.079 C38.743 62.614 37.782 63.891 37.337 64.475 C37.109 64.752 36.931 65.02 36.931 65.05 C36.931 65.089 36.743 65.347 36.515 65.644 C36.277 65.931 35.911 66.426 35.693 66.733 C35.475 67.05 35.228 67.386 35.149 67.485 C35.069 67.584 34.891 67.832 34.752 68.03 C34.614 68.228 34.396 68.525 34.257 68.683 L34 68.98 L32.703 68.97 C31.564 68.95 31.356 68.98 31.03 69.158 C30.812 69.267 30.614 69.356 30.574 69.356 C30.485 69.356 29.941 69.723 29.436 70.129 C29.02 70.455 28.287 71.446 28.168 71.842 C28.129 71.97 28.03 72.168 27.96 72.277 C27.861 72.416 27.822 72.842 27.822 73.812 C27.822 74.782 27.861 75.208 27.96 75.347 C28.03 75.455 28.129 75.653 28.168 75.772 C28.426 76.614 29.871 78.059 30.713 78.317 C30.832 78.356 31.03 78.455 31.139 78.525 C31.475 78.762 33.871 78.713 34.277 78.465 C34.455 78.356 34.653 78.267 34.723 78.267 C34.901 78.267 35.733 77.683 36.139 77.277 C36.545 76.871 37.129 76.04 37.129 75.861 C37.129 75.792 37.218 75.594 37.327 75.416 C37.614 74.941 37.624 72.693 37.327 72.149 C37.228 71.95 37.119 71.713 37.089 71.634 C37.059 71.554 36.98 71.416 36.921 71.327 C36.812 71.178 37.089 70.683 37.762 69.842 C37.881 69.703 38.04 69.485 38.119 69.356 C38.198 69.238 38.446 68.901 38.663 68.624 C38.881 68.347 39.198 67.921 39.356 67.673 C39.525 67.426 39.683 67.178 39.733 67.129 C39.772 67.069 40.01 66.762 40.248 66.436 C41.436 64.822 42.624 63.218 43.069 62.624 C44.089 61.248 45.04 59.941 45.446 59.337 C45.693 58.97 45.941 58.663 46 58.663 C46.129 58.663 46.02 59.406 45.802 60 C45.723 60.218 45.653 60.624 45.644 60.891 C45.644 61.168 45.574 61.634 45.485 61.931 C45.228 62.772 45.168 69.287 45.396 70.347 C45.485 70.752 45.604 71.446 45.644 71.881 C45.693 72.317 45.802 72.851 45.881 73.069 C45.96 73.287 46.03 73.624 46.04 73.812 C46.04 74 46.109 74.287 46.188 74.436 C46.267 74.584 46.376 74.921 46.426 75.178 C46.535 75.703 46.772 76.436 47.04 77.059 C47.149 77.287 47.228 77.554 47.228 77.653 C47.228 77.743 47.317 77.95 47.426 78.119 C47.535 78.277 47.624 78.505 47.624 78.604 C47.624 78.713 47.693 78.871 47.782 78.97 C48.04 79.257 48.079 79.99 47.861 80.317 C47.644 80.644 47.376 81.109 47.248 81.386 C47.188 81.505 47.079 81.653 46.99 81.723 C46.901 81.792 46.832 81.891 46.832 81.941 C46.832 82.04 46.485 82.564 46.04 83.119 C45.851 83.356 45.584 83.723 45.446 83.931 C45.059 84.505 43.089 86.564 41.901 87.644 C41 88.455 39.931 89.287 37.95 90.713 C37.663 90.921 37.178 91.267 36.881 91.485 C36.069 92.079 35.653 92.327 35.455 92.327 C35.356 92.327 35.079 92.396 34.851 92.475 C34.069 92.752 33.069 92.584 31.96 91.97 C31.624 91.792 30.792 90.941 30.792 90.792 C30.792 90.723 30.703 90.594 30.594 90.495 C30.485 90.396 30.396 90.267 30.396 90.198 C30.396 90.129 30.307 90 30.198 89.901 C30.089 89.802 30 89.673 30 89.604 C30 89.535 29.911 89.406 29.802 89.307 C29.693 89.208 29.604 89.079 29.604 89.01 C29.604 88.941 29.515 88.812 29.406 88.713 C29.297 88.614 29.208 88.485 29.208 88.416 C29.208 88.347 29.119 88.218 29.01 88.119 C28.901 88.02 28.812 87.891 28.812 87.822 C28.812 87.752 28.723 87.624 28.614 87.525 C28.505 87.426 28.416 87.297 28.416 87.228 C28.416 87.158 28.327 87.03 28.218 86.931 C28.109 86.832 28.02 86.703 28.02 86.634 C28.02 86.564 27.931 86.436 27.822 86.337 C27.713 86.238 27.624 86.109 27.624 86.04 C27.624 85.97 27.535 85.842 27.426 85.743 C27.317 85.644 27.228 85.515 27.228 85.446 C27.228 85.376 27.139 85.248 27.03 85.149 C26.921 85.05 26.832 84.921 26.832 84.851 C26.832 84.782 26.743 84.653 26.634 84.554 C26.525 84.455 26.436 84.317 26.436 84.248 C26.436 84.178 26.198 83.921 25.921 83.673 L25.396 83.218 L20.99 83.218 C17.297 83.208 16.525 83.188 16.188 83.059 C15.97 82.98 15.703 82.881 15.594 82.851 C15.426 82.802 15.079 82.564 14.703 82.238 C14.475 82.04 14.228 81.693 14.149 81.446 C14.109 81.307 14 80.99 13.911 80.743 C13.723 80.238 13.762 79.01 14.02 77.634 C14.099 77.208 14.158 76.624 14.158 76.337 C14.158 76.05 14.248 75.535 14.356 75.198 C14.465 74.861 14.554 74.436 14.554 74.267 C14.564 74.099 14.644 73.782 14.752 73.564 C14.861 73.347 14.941 73.059 14.95 72.921 C14.95 72.782 15.04 72.505 15.149 72.297 C15.257 72.099 15.347 71.832 15.347 71.713 C15.347 71.584 15.436 71.347 15.545 71.188 C15.653 71.02 15.743 70.792 15.743 70.683 C15.743 70.564 15.832 70.356 15.941 70.218 C16.05 70.079 16.139 69.891 16.139 69.802 C16.139 69.713 16.228 69.525 16.337 69.386 C16.446 69.248 16.535 69.059 16.535 68.96 C16.535 68.861 16.624 68.673 16.733 68.535 C16.842 68.396 16.931 68.218 16.931 68.139 C16.931 68.05 16.98 67.95 17.04 67.911 C17.099 67.881 17.218 67.703 17.297 67.535 C17.584 66.911 18.436 65.545 18.941 64.891 C19.139 64.634 19.307 64.386 19.307 64.356 C19.307 64.238 21.297 61.861 22.01 61.139 C23.198 59.921 25.069 58.287 25.941 57.713 C26.129 57.584 26.475 57.347 26.713 57.178 C26.941 57.02 27.168 56.881 27.218 56.881 C27.267 56.881 27.366 56.812 27.436 56.723 C27.505 56.634 27.653 56.525 27.772 56.465 C27.881 56.416 28.149 56.267 28.366 56.139 C28.584 56 28.871 55.842 29.01 55.772 C29.149 55.703 29.366 55.574 29.495 55.475 C29.624 55.376 29.792 55.297 29.871 55.297 C29.95 55.297 30.129 55.208 30.267 55.099 C30.406 54.99 30.584 54.901 30.663 54.901 C30.743 54.901 30.921 54.812 31.059 54.703 C31.198 54.594 31.416 54.505 31.535 54.505 C31.653 54.505 31.812 54.446 31.871 54.366 C31.941 54.287 32.139 54.188 32.307 54.158 C32.485 54.119 32.762 54 32.931 53.901 C33.099 53.802 33.337 53.713 33.455 53.713 C33.564 53.713 33.832 53.624 34.03 53.515 C34.238 53.406 34.505 53.317 34.634 53.317 C34.752 53.317 35.03 53.228 35.248 53.119 C35.465 53.01 35.772 52.921 35.931 52.921 C36.099 52.921 36.455 52.832 36.733 52.723 C37.01 52.614 37.406 52.525 37.614 52.525 C37.822 52.525 38.277 52.436 38.614 52.327 C38.97 52.208 39.525 52.129 39.941 52.119 C40.327 52.119 40.871 52.079 41.139 52.03 C42.079 51.881 42.208 51.921 42.366 52.426 M53.842 58.139 C54.119 58.515 54.535 59.059 54.752 59.356 C54.97 59.653 55.406 60.248 55.723 60.663 C56.03 61.079 56.396 61.584 56.535 61.782 C56.673 61.97 56.851 62.218 56.931 62.327 C57.01 62.436 57.257 62.762 57.475 63.069 C58.178 64.04 59.069 65.248 59.931 66.406 C60.158 66.713 60.416 67.059 60.495 67.178 C60.574 67.307 60.743 67.525 60.871 67.673 C60.99 67.822 61.089 67.98 61.089 68.02 C61.089 68.05 61.277 68.317 61.515 68.604 C61.743 68.891 62 69.238 62.079 69.356 C62.158 69.485 62.317 69.703 62.436 69.842 C63.099 70.663 63.386 71.178 63.287 71.327 C62.446 72.564 62.277 74.683 62.901 75.99 C63.376 76.95 64.465 78.267 64.802 78.267 C64.871 78.267 65 78.356 65.099 78.465 C65.198 78.574 65.337 78.663 65.416 78.663 C65.495 78.663 65.723 78.752 65.941 78.861 C66.515 79.149 68.733 79.149 69.307 78.861 C69.525 78.752 69.743 78.663 69.792 78.663 C70.158 78.663 71.772 77.208 72.03 76.644 C72.109 76.475 72.218 76.267 72.267 76.188 C72.317 76.109 72.446 75.792 72.564 75.495 C72.95 74.475 72.812 72.743 72.267 71.832 C72.218 71.752 72.109 71.545 72.03 71.376 C71.772 70.812 70.158 69.356 69.792 69.356 C69.743 69.356 69.515 69.267 69.297 69.158 C68.95 68.98 68.733 68.95 67.545 68.97 L66.198 68.98 L65.941 68.683 C65.802 68.525 65.584 68.228 65.446 68.03 C65.129 67.574 65.04 67.455 64.525 66.762 C64.297 66.455 63.931 65.95 63.713 65.644 C63.495 65.337 63.129 64.851 62.901 64.554 C62.663 64.267 62.475 63.99 62.475 63.95 C62.475 63.911 62.406 63.812 62.327 63.723 C61.733 63.099 61.505 62.584 61.96 62.891 C62.218 63.079 64.079 63.98 64.356 64.059 C64.495 64.099 64.693 64.198 64.802 64.267 C64.911 64.347 65.089 64.406 65.198 64.406 C65.307 64.406 65.535 64.495 65.693 64.604 C65.861 64.713 66.099 64.802 66.238 64.802 C66.376 64.802 66.663 64.891 66.881 65 C67.099 65.109 67.396 65.188 67.554 65.198 C67.703 65.198 68.079 65.287 68.386 65.396 C68.703 65.505 69.109 65.594 69.307 65.594 C69.495 65.594 70.01 65.683 70.446 65.792 C71.634 66.089 76.832 66.089 77.931 65.792 C78.337 65.683 78.851 65.594 79.079 65.594 C79.307 65.594 79.713 65.515 79.97 65.406 C80.614 65.158 81.356 65.069 81.485 65.228 C81.752 65.535 82.475 66.713 82.475 66.822 C82.475 66.891 82.564 67.03 82.673 67.129 C82.782 67.228 82.871 67.366 82.871 67.426 C82.871 67.495 82.96 67.663 83.069 67.802 C83.178 67.941 83.267 68.119 83.267 68.198 C83.267 68.267 83.356 68.436 83.465 68.564 C83.574 68.693 83.663 68.871 83.663 68.96 C83.663 69.059 83.752 69.248 83.861 69.386 C83.97 69.525 84.059 69.723 84.059 69.832 C84.059 69.941 84.119 70.079 84.198 70.139 C84.277 70.208 84.376 70.406 84.406 70.574 C84.446 70.752 84.564 71.03 84.663 71.198 C84.762 71.366 84.851 71.604 84.851 71.723 C84.851 71.832 84.941 72.099 85.05 72.297 C85.158 72.505 85.248 72.782 85.248 72.921 C85.257 73.059 85.337 73.347 85.446 73.564 C85.554 73.782 85.634 74.119 85.644 74.317 C85.644 74.515 85.733 74.931 85.842 75.248 C85.95 75.564 86.04 76.05 86.04 76.327 C86.04 76.604 86.099 77.208 86.178 77.673 C86.386 78.881 86.465 80.248 86.347 80.594 C85.822 82.188 85.376 82.634 83.812 83.129 C83.644 83.178 81.624 83.218 79.178 83.218 L74.832 83.218 L74.436 83.525 C74.099 83.802 73.851 84.099 73.416 84.792 C73.356 84.881 73.178 85.149 73.02 85.386 C72.851 85.624 72.673 85.891 72.624 85.98 C72.564 86.069 72.386 86.337 72.228 86.574 C72.059 86.812 71.881 87.079 71.832 87.168 C71.772 87.257 71.594 87.525 71.436 87.762 C71.267 88 71.089 88.277 71.03 88.376 C70.97 88.485 70.851 88.644 70.762 88.743 C70.663 88.842 70.594 88.97 70.594 89.03 C70.594 89.079 70.505 89.208 70.396 89.307 C70.287 89.406 70.198 89.535 70.188 89.594 C70.188 89.653 70.03 89.901 69.842 90.149 C69.663 90.396 69.465 90.683 69.416 90.792 C69.297 91.059 68.564 91.792 68.228 91.98 C67.139 92.574 66.129 92.752 65.347 92.475 C65.119 92.396 64.842 92.327 64.743 92.327 C64.505 92.327 63.812 91.871 62.228 90.693 C61.941 90.475 61.604 90.228 61.485 90.149 C61.109 89.901 60.554 89.465 60.386 89.307 C60.297 89.228 60.198 89.158 60.158 89.158 C59.98 89.158 58.059 87.505 56.98 86.436 C55.931 85.386 54.663 83.921 54.208 83.228 C54.069 83.03 53.832 82.683 53.663 82.446 C53.505 82.218 53.366 81.99 53.366 81.941 C53.366 81.901 53.277 81.782 53.168 81.683 C53.059 81.584 52.97 81.455 52.97 81.386 C52.97 81.327 52.911 81.218 52.851 81.158 C52.723 81.03 52.059 79.881 51.871 79.455 C51.812 79.317 51.723 79.139 51.673 79.059 C51.584 78.911 51.505 78.743 51.158 77.97 C51.05 77.723 50.881 77.356 50.782 77.158 C50.673 76.96 50.594 76.723 50.594 76.634 C50.594 76.545 50.505 76.307 50.396 76.089 C50.287 75.871 50.198 75.604 50.198 75.495 C50.198 75.386 50.109 75.119 50 74.901 C49.891 74.683 49.802 74.406 49.802 74.267 C49.802 74.129 49.713 73.792 49.604 73.515 C49.495 73.238 49.406 72.861 49.406 72.683 C49.406 72.505 49.317 72.069 49.208 71.733 C49.099 71.396 49.01 70.881 49.01 70.604 C49.01 70.327 48.931 69.673 48.842 69.158 C48.624 67.871 48.624 64.891 48.842 63.673 C48.941 63.188 49.01 62.564 49.01 62.277 C49.01 61.99 49.099 61.465 49.208 61.119 C49.317 60.782 49.406 60.337 49.406 60.139 C49.406 59.941 49.485 59.604 49.574 59.396 C49.663 59.178 49.762 58.812 49.792 58.564 L49.851 58.119 L50.891 58.059 C51.594 58.03 52.03 57.95 52.228 57.842 C52.396 57.752 52.644 57.673 52.792 57.673 C52.941 57.673 53.089 57.624 53.119 57.574 C53.238 57.386 53.347 57.475 53.842 58.139 M33.485 72.446 C34.861 73.356 34.297 75.396 32.673 75.396 C31.069 75.396 30.485 73.366 31.822 72.446 C32.257 72.158 33.04 72.149 33.485 72.446 M68.347 72.446 C69.713 73.337 69.139 75.396 67.525 75.396 C65.921 75.396 65.337 73.366 66.673 72.446 C67.099 72.158 67.911 72.149 68.347 72.446';
const CHERRY_BLOSSOM_PINK_DETAILS = [
    '<circle cx="50.045" cy="50.005" r="4.7" fill="#f0b0a0"/>',
    '<circle cx="50.05" cy="24.65" r="1.5" fill="#f0b0a0"/>',
    '<circle cx="23.11" cy="42.08" r="1.5" fill="#f0b0a0"/>',
    '<circle cx="76.98" cy="42.08" r="1.5" fill="#f0b0a0"/>',
    '<circle cx="32.61" cy="73.77" r="1.5" fill="#f0b0a0"/>',
    '<circle cx="67.47" cy="73.76" r="1.5" fill="#f0b0a0"/>',
].join('');
// The blossom is a single filled trace (no per-segment strokes to tune), so unlike
// buildShutter it only varies by fill colour and an optional details layer. The mono
// and input-bar variants rely on fill-rule="evenodd" to carve the centre disc and
// tip-dots out as negative space; the colour variant adds them back as pink circles.
function buildCherryBlossom(fill, details, wrapper) {
    return wrapper(`<path fill="${fill}" fill-rule="evenodd" d="${CHERRY_BLOSSOM_PATH}"/>${details}`);
}
exports.CHERRY_BLOSSOM_FLOAT_MONO = buildCherryBlossom('currentColor', '', inner => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid" style="width:60%;height:60%"><g>${inner}</g></svg>`);
exports.CHERRY_BLOSSOM_FLOAT_COLOR = buildCherryBlossom('#b04040', CHERRY_BLOSSOM_PINK_DETAILS, inner => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid" style="width:60%;height:60%"><g>${inner}</g></svg>`);
exports.CHERRY_BLOSSOM_INPUT_BAR = buildCherryBlossom('currentColor', '', inner => `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 100 100">${inner}</svg>`);
// ── Cat lotus icon ──
// Two representations, both in Shutter's native 0 0 100 100 space, cropped tight,
// centred and squared:
//
//   • CAT_LOTUS_LAYERS — the three-tone purple fill stack (darkest first), painted with
//     fill-rule="evenodd". This is the colour variant.
//   • CAT_LOTUS_LINEWORK — the artist's own line strokes isolated as 12 filled
//     paths. Rendered with fill="currentColor" and fill-rule="evenodd" they read as clean
//     single-weight outlines (face, ears, eye/wink/nose and every lotus petal), matching
//     how the shutter and cherry-blossom mono icons read as line art rather than as a
//     doubled trace of each colour region.
// Colour fill stack — [fill, pathData] in paint order, do not reorder.
// Trace-noise micro-fragments (<1 viewBox unit) stripped; verified near-pixel-identical
// to the original render (≤4 differing channel values at widget sizes).
const CAT_LOTUS_LAYERS = [
    ['#2D085A', 'M 26.69,8.32 C 26.79,7.79 26.89,7.36 26.92,7.36 C 27.29,7.36 32.12,12.05 34.1,14.33 C 36.55,17.14 39.35,20.82 41.58,24.14 C 42.68,25.77 42.8,25.91 43.06,25.86 C 43.21,25.82 43.89,25.68 44.56,25.52 C 48.32,24.67 52.09,24.69 55.72,25.59 C 56.53,25.79 57.11,25.89 57.13,25.82 C 57.22,25.58 59.14,22.78 60.35,21.14 C 63.79,16.5 67.99,11.78 71.49,8.62 C 72.68,7.56 72.89,7.4 72.95,7.58 C 73.07,7.88 73.57,11.17 73.73,12.74 C 73.95,14.82 73.92,21.54 73.68,23.57 C 73.15,27.85 72.49,31.05 71.14,35.72 L 70.7,37.26 L 70.92,38.55 C 71.06,39.26 71.26,40.41 71.37,41.09 C 71.49,41.78 71.68,42.53 71.79,42.75 C 72.01,43.2 72.59,43.65 73.08,43.75 C 73.21,43.78 73.3,43.78 73.33,43.83 C 73.38,43.9 73.31,44.06 73.11,44.58 C 72.51,46.18 71.59,47.68 70.64,48.58 L 70.22,49 L 70.72,49 C 71,49 71.48,48.92 71.78,48.83 C 72.08,48.75 72.33,48.67 72.35,48.67 C 72.55,48.66 70.67,51.75 69.79,52.85 C 68.23,54.82 67.44,55.61 66.29,56.31 C 62.55,58.61 57.76,63.25 56.35,65.94 L 56.19,66.26 L 55.8,65.47 C 54.83,63.56 52.7,60.75 50.94,59.06 C 50.46,58.6 50.22,58.34 49.96,58.32 C 49.64,58.31 49.3,58.68 48.46,59.54 C 46.78,61.24 45.41,63.08 44.21,65.28 C 43.94,65.79 43.69,66.21 43.68,66.21 C 43.66,66.21 43.43,65.88 43.17,65.47 C 41.18,62.4 37.57,58.91 34.03,56.63 C 32.44,55.61 30.6,53.69 29.21,51.61 C 28.83,51.04 27.51,48.7 27.51,48.6 C 27.51,48.58 27.68,48.63 27.89,48.72 C 28.1,48.81 28.54,48.92 28.89,48.96 L 29.5,49.03 L 29.07,48.57 C 28.22,47.68 27.33,46.19 26.78,44.69 C 26.57,44.15 26.49,43.94 26.56,43.84 C 26.6,43.77 26.69,43.74 26.83,43.69 C 27.38,43.5 28.05,42.81 28.27,42.19 C 28.39,41.87 28.59,40.96 28.72,40.17 C 28.86,39.37 29.04,38.45 29.13,38.11 L 29.31,37.5 L 28.79,35.72 C 26.79,28.82 26.09,24.55 25.99,18.62 C 25.91,14.5 26.12,11.52 26.69,8.32 M 30.33,15.19 C 29.64,14.26 28.78,13.2 28.42,12.8 L 27.76,12.09 L 27.68,13.94 C 27.42,19.72 28.47,27.21 30.3,32.76 L 30.75,34.13 L 31.25,33.25 C 32.19,31.6 33.91,29.72 35.23,28.9 L 35.67,28.63 L 35.23,28.5 C 34.99,28.42 34.66,28.36 34.51,28.34 C 34.38,28.34 34.31,28.34 34.31,28.32 C 34.3,28.3 34.38,28.25 34.56,28.16 C 34.75,28.06 35.43,27.79 36.07,27.57 L 37.25,27.17 L 36.02,24.62 C 34.03,20.56 32.6,18.18 30.33,15.19 M 72.21,16.76 C 72.24,15.53 72.23,13.97 72.19,13.3 L 72.1,12.09 L 71.22,13.13 C 69.09,15.67 67.18,18.46 65.5,21.46 C 64.5,23.24 62.56,27.12 62.63,27.17 C 62.65,27.19 63.16,27.37 63.77,27.57 C 64.96,27.96 65.78,28.33 65.47,28.34 C 65.37,28.34 65.01,28.4 64.69,28.47 C 64.18,28.58 64.14,28.61 64.31,28.72 C 66.01,29.71 67.58,31.39 68.63,33.34 C 68.95,33.9 69.17,34.21 69.2,34.12 C 69.23,34.03 69.46,33.25 69.7,32.4 C 71.37,26.53 72.05,22.23 72.21,16.76 M 34.23,42.06 C 33.56,41.74 32.84,41.36 32.65,41.23 C 32.45,41.09 32.29,41.03 32.29,41.08 C 32.29,41.34 33.03,42.43 33.55,42.93 C 34.1,43.46 34.15,43.57 34.29,44.28 C 34.84,47.31 36.45,49.28 39.17,50.24 C 39.65,50.42 40.24,50.49 41.84,50.56 C 43.98,50.64 44.91,50.83 45.36,51.29 C 45.66,51.58 45.65,51.32 45.35,50.4 C 44.07,46.61 41.78,44.63 36.93,43.1 C 36.12,42.86 34.91,42.38 34.23,42.06 M 66.14,46.5 C 65.07,46.25 62.48,46.18 61.49,46.38 C 59.84,46.72 58.15,47.58 56.56,48.88 C 55.8,49.51 54.35,51.01 54.44,51.09 C 54.46,51.11 54.89,50.81 55.37,50.41 C 57.23,48.96 59.59,47.85 61.49,47.55 C 62.58,47.38 64.15,47.49 65.49,47.83 C 66.07,47.98 66.56,48.09 66.58,48.07 C 66.61,48.03 65.99,47.61 65.25,47.17 L 64.88,46.95 L 65.91,46.91 C 66.47,46.9 66.94,46.84 66.94,46.79 C 66.94,46.74 66.57,46.6 66.14,46.5 M 38.81,44.74 C 38.93,44.61 39.36,44.76 40.15,45.15 C 41.27,45.71 41.33,45.79 41.25,46.71 C 41.15,47.78 40.46,49.78 40.18,49.78 C 39.87,49.78 39.18,48.36 38.91,47.15 C 38.73,46.34 38.66,44.88 38.81,44.74 M 51.93,54.6 C 51.62,54.32 48.53,54.24 48.03,54.51 C 47.46,54.81 47.48,55.44 48.08,55.75 C 48.28,55.85 48.7,56.2 49,56.51 C 49.31,56.82 49.64,57.11 49.76,57.14 C 50.02,57.24 50.53,56.97 50.77,56.62 C 50.87,56.46 51.22,56.13 51.55,55.89 C 52.24,55.37 52.35,54.99 51.93,54.6 M 38.55,39.12 C 37.98,38.97 37.62,38.87 37.6,38.92 C 37.57,38.99 38.2,39.37 39.83,40.36 C 41.37,41.3 43.1,42.69 44.48,44.08 C 45.1,44.71 45.61,45.21 45.61,45.19 C 45.61,45 45.24,44.16 44.88,43.56 C 43.73,41.57 41.16,39.77 38.55,39.12 M 61.88,40.44 C 62.04,40.29 61.75,40.33 60.91,40.57 C 58.15,41.36 56,43.15 54.68,45.76 C 54.29,46.52 54.36,46.59 54.9,45.98 C 56.17,44.53 57.75,43.2 60.27,41.53 C 61.09,40.98 61.82,40.49 61.88,40.44'],
    ['#7024D4', 'M 64.66,79.18 C 64.96,79.14 65.87,79.13 66.66,79.16 C 69.8,79.26 73.2,80.33 76.25,82.19 C 77.32,82.85 78.48,83.73 78.48,83.87 C 78.48,84.25 75.42,86.28 73.14,87.41 C 70.43,88.77 67.95,89.47 64.83,89.76 C 60.45,90.17 55.41,88.71 52.91,86.34 C 52.37,85.81 52.12,85.57 52.17,85.43 C 52.21,85.3 52.46,85.25 52.92,85.15 C 56.22,84.45 59.88,82.68 62.65,80.44 C 63.07,80.1 63.57,79.7 63.76,79.54 C 63.96,79.37 64.31,79.23 64.66,79.18 M 32.23,79.22 C 33.53,79.1 33.95,79.1 34.9,79.18 C 35.65,79.26 35.72,79.3 36.51,79.94 C 39.91,82.7 42.68,84.12 46.52,85.05 C 47.21,85.22 47.56,85.29 47.6,85.45 C 47.64,85.62 47.35,85.88 46.75,86.44 C 45.17,87.89 43.01,88.88 40.15,89.47 C 34.39,90.66 27.99,88.95 22.41,84.71 L 21.38,83.93 L 21.86,83.5 C 24.36,81.35 28.7,79.55 32.23,79.22 M 84.83,54.41 C 84.83,54.32 84.85,54.31 84.88,54.4 C 84.95,54.56 84.35,57.27 83.98,58.45 C 81.97,64.89 79.06,69.35 74.49,72.94 C 72.85,74.23 70.13,75.82 68.52,76.43 C 67.25,76.92 66.11,77.31 66.09,77.29 C 66.07,77.26 66.31,76.96 66.62,76.6 C 70.02,72.61 72.32,67.17 72.83,61.9 L 72.97,60.54 L 73.75,59.79 C 76.23,57.45 79.8,55.53 83.23,54.71 C 83.87,54.55 84.49,54.45 84.6,54.48 C 84.73,54.51 84.81,54.48 84.83,54.41 M 15.14,54.84 L 15.1,54.36 L 16.05,54.58 C 19.61,55.35 23.46,57.4 26.36,60.03 L 27.03,60.65 L 27.11,61.74 C 27.5,67.11 30.24,73.52 33.71,77.13 L 34.01,77.44 L 33.45,77.21 C 33.14,77.07 32.42,76.8 31.84,76.57 C 28.7,75.4 25.36,73.2 22.85,70.67 C 20.07,67.86 17.93,64.28 16.52,60.11 C 15.98,58.52 15.21,55.57 15.14,54.84 M 17.13,72.62 C 18.13,72.53 19.76,72.55 21.22,72.68 C 22.74,72.8 22.77,72.81 23.23,73.19 C 24.14,73.96 26.15,75.41 27.08,75.98 C 28.11,76.59 30.51,77.76 30.75,77.76 C 31.08,77.77 30.5,78 29.72,78.15 C 26.83,78.75 23.88,80.14 21.2,82.16 C 20.68,82.55 20.22,82.87 20.17,82.87 C 19.78,82.87 17.04,80.02 15.68,78.2 C 14.6,76.74 12.75,73.72 12.88,73.6 C 13.06,73.41 16.06,72.72 17.13,72.62 M 79.32,72.61 C 80.39,72.5 83.45,72.65 84.49,72.88 C 85.71,73.13 87.04,73.52 87.04,73.62 C 87.04,73.99 84.88,77.31 83.64,78.86 C 82.79,79.92 80.51,82.32 80.02,82.66 L 79.71,82.88 L 78.67,82.13 C 75.85,80.02 72.81,78.64 69.81,78.09 L 69.07,77.95 L 70.7,77.15 C 72.49,76.27 74.22,75.15 75.92,73.78 L 77.04,72.87 L 77.95,72.77 C 78.46,72.71 79.07,72.63 79.32,72.61 M 49.9,85.63 C 49.9,85.6 49.94,85.66 50,85.75 C 50.78,86.82 52.08,88.02 52.95,88.48 C 53.13,88.58 53.28,88.69 53.28,88.75 C 53.28,89.23 50.32,92.75 49.91,92.75 C 49.62,92.75 47.55,90.45 47.03,89.57 L 46.51,88.66 L 47.26,88.16 C 48.17,87.55 49.99,85.8 49.9,85.63 M 25.89,17.52 C 25.89,16.54 25.91,16.13 25.92,16.6 C 25.95,17.06 25.95,17.86 25.92,18.37 C 25.91,18.88 25.89,18.49 25.89,17.52 M 73.98,17.79 C 73.98,17.03 73.99,16.72 74.01,17.1 C 74.03,17.48 74.03,18.11 74.01,18.48 C 73.99,18.87 73.98,18.56 73.98,17.79'],
    ['#AA50F4', 'M 13.49,52.83 C 13.73,52.58 14.82,52.69 16.68,53.16 C 19.95,54 23.25,55.64 26.37,57.97 L 27.07,58.5 L 27.07,60.67 L 26.16,59.86 C 23.21,57.25 19.56,55.34 16.05,54.56 C 15.53,54.45 15.26,54.37 15.15,54.47 C 15.02,54.59 15.13,54.98 15.35,55.94 C 16.75,62.13 19.24,67 22.85,70.67 C 25.37,73.21 28.7,75.4 31.88,76.59 C 34.7,77.64 34.86,77.82 33.03,77.83 C 32.29,77.83 31.43,77.87 31.12,77.92 C 30.73,77.97 30.61,77.96 30.73,77.89 C 30.85,77.8 30.87,77.76 30.75,77.76 C 30.51,77.76 28.11,76.59 27.08,75.98 C 26.15,75.41 24.14,73.96 23.21,73.19 L 22.75,72.8 L 20.95,72.65 C 18.97,72.5 17.17,72.55 15.75,72.82 C 14.89,72.99 12.96,73.51 12.88,73.6 C 12.75,73.72 14.6,76.74 15.68,78.2 C 17.21,80.25 19.88,82.97 20.24,82.83 C 20.32,82.8 20.37,82.84 20.36,82.92 C 20.35,83.12 21.28,83.89 21.43,83.79 C 21.49,83.76 21.52,83.78 21.48,83.84 C 21.44,83.9 21.87,84.3 22.44,84.73 C 27.99,88.95 34.4,90.66 40.15,89.47 C 43.17,88.85 45.29,87.84 46.9,86.26 L 47.81,85.37 L 49.91,85.38 L 52,85.38 L 52.67,86.08 C 55.08,88.6 60.28,90.18 64.83,89.76 C 67.95,89.47 70.43,88.77 73.14,87.41 C 75.44,86.27 78.48,84.25 78.48,83.87 C 78.48,83.8 78.53,83.77 78.57,83.79 C 78.62,83.8 78.87,83.63 79.14,83.4 C 79.57,83.03 79.61,82.97 79.47,82.79 C 79.33,82.62 79.34,82.6 79.51,82.74 C 79.77,82.95 80.05,82.74 81.62,81.12 C 83.14,79.54 84.08,78.37 85.25,76.65 C 86.04,75.5 87.04,73.8 87.04,73.62 C 87.04,73.52 85.73,73.13 84.44,72.85 C 83.14,72.58 79.6,72.51 77.95,72.74 L 77.03,72.88 L 75.92,73.78 C 74.16,75.2 72.45,76.29 70.66,77.15 L 68.99,77.94 L 67.24,77.89 L 65.47,77.82 L 65.74,77.59 C 65.87,77.45 66.41,77.2 66.94,77.01 C 68.68,76.4 69.16,76.2 70.34,75.59 C 77.66,71.83 82.58,65.08 84.59,56.04 C 84.78,55.22 84.93,54.51 84.93,54.45 C 84.93,54.4 84.7,54.4 84.4,54.46 C 84.1,54.51 83.75,54.58 83.59,54.6 C 83.44,54.62 83.24,54.66 83.15,54.69 C 83.06,54.72 82.4,54.93 81.71,55.15 C 78.84,56.06 75.84,57.82 73.75,59.79 L 72.97,60.55 L 72.9,59.52 L 72.83,58.5 L 73.29,58.11 C 76.37,55.44 81.81,53.04 85.48,52.71 C 86.66,52.61 86.68,52.65 86.44,54.2 C 85.5,60.05 83.19,65.54 79.81,69.94 L 78.94,71.08 L 80.79,71.02 C 82.78,70.96 84.28,71.13 86.15,71.66 C 87.32,71.99 88.86,72.77 88.9,73.04 C 88.93,73.32 88.28,74.69 87.35,76.26 C 83.25,83.15 76.65,88.49 69.8,90.48 C 67.49,91.16 65.99,91.36 63.38,91.36 C 60.34,91.36 58.6,91.04 55.94,90 C 55.36,89.78 54.85,89.59 54.81,89.59 C 54.76,89.59 54.39,90.11 53.96,90.76 C 53.53,91.4 52.92,92.22 52.6,92.58 C 51.89,93.37 50.49,94.5 50.11,94.6 C 49.32,94.8 46.52,92.09 45.42,90.07 C 45.21,89.69 45.07,89.53 44.96,89.58 C 44.86,89.6 44.36,89.81 43.84,90.02 C 39.78,91.7 34.84,91.86 30.16,90.47 C 22.61,88.24 15.4,82.05 11.73,74.71 C 10.9,73.03 10.89,72.91 11.46,72.58 C 12.18,72.18 13.6,71.7 15.09,71.37 C 16.34,71.08 16.67,71.06 18.72,71.04 C 19.95,71.04 20.96,71.01 20.96,70.98 C 20.96,70.94 20.86,70.82 20.73,70.7 C 20.33,70.34 18.72,68.1 17.98,66.88 C 15.85,63.35 14.22,58.56 13.35,53.31 C 13.32,53.12 13.38,52.94 13.49,52.83 M 26.15,5.56 C 26.24,5.45 26.29,5.39 26.35,5.37 C 26.43,5.36 26.52,5.41 26.77,5.53 C 27.55,5.93 29.4,7.54 31.77,9.89 C 35.35,13.44 38.5,17.21 42.06,22.27 L 43.45,24.25 L 43.84,24.2 C 44.05,24.17 44.7,24.05 45.28,23.93 C 48.25,23.27 51.63,23.28 55,23.96 C 55.72,24.1 56.33,24.21 56.34,24.2 C 56.34,24.19 56.9,23.43 57.56,22.51 C 62.33,15.94 67.11,10.53 71.49,6.76 C 72.93,5.52 73.39,5.25 73.64,5.46 C 74.01,5.76 74.55,8.23 74.92,11.19 C 75.8,18.34 75.39,24.58 73.53,32.51 C 72.71,35.99 72.53,36.71 72.5,37.44 C 72.49,37.64 72.49,37.85 72.49,38.12 C 72.49,39.39 72.73,41.18 72.98,41.65 C 73.3,42.26 73.55,42.39 74.43,42.38 L 75.23,42.37 L 75.08,43.1 C 74.85,44.06 74.22,45.79 73.81,46.52 C 73.63,46.85 73.49,47.15 73.49,47.18 C 73.49,47.26 73.96,47.18 74.29,47.06 C 74.58,46.95 74.54,47.19 74.14,48.19 C 73.62,49.5 72.78,51.14 72.13,52.09 C 70.99,53.76 69.93,54.61 67.93,55.46 L 67.22,55.77 L 67.89,55.08 C 68.97,53.98 70.01,52.7 70.78,51.53 C 71.58,50.32 72.43,48.79 72.35,48.71 C 72.32,48.69 72.01,48.73 71.64,48.83 C 71.29,48.92 70.86,49 70.69,49 L 70.38,49 L 70.73,48.59 C 70.93,48.37 71.21,48.07 71.34,47.92 C 71.48,47.78 71.57,47.67 71.54,47.67 C 71.52,47.67 71.68,47.41 71.89,47.09 C 72.24,46.57 73.17,44.77 73.22,44.5 C 73.23,44.44 73.28,44.26 73.32,44.08 C 73.39,43.85 73.37,43.78 73.22,43.78 C 73.12,43.78 73.04,43.74 73.04,43.67 C 73.04,43.61 72.98,43.59 72.89,43.63 C 72.8,43.66 72.63,43.59 72.53,43.46 C 72.42,43.34 72.3,43.26 72.24,43.29 C 72.02,43.44 71.52,42.22 71.42,41.29 C 71.4,41.04 71.26,40.17 71.11,39.35 C 70.96,38.53 70.84,37.83 70.84,37.8 C 70.86,37.76 70.82,37.65 70.78,37.55 C 70.73,37.44 70.89,36.71 71.14,35.83 C 71.38,34.97 71.72,33.76 71.89,33.12 C 72.04,32.48 72.21,31.91 72.24,31.85 C 72.28,31.8 72.31,31.58 72.33,31.37 C 72.35,31.14 72.41,30.94 72.45,30.91 C 72.5,30.88 72.55,30.68 72.58,30.47 C 72.59,30.25 72.65,30.02 72.71,29.96 C 72.77,29.88 72.8,29.8 72.77,29.77 C 72.74,29.74 72.84,29.08 73,28.29 C 73.3,26.72 73.8,23.09 73.87,21.85 C 73.94,20.75 74.06,17.89 74.05,17.62 C 74.05,17.48 74,16.53 73.94,15.51 C 73.89,14.47 73.85,13.5 73.88,13.33 C 73.9,13.15 73.87,12.99 73.81,12.95 C 73.75,12.92 73.71,12.73 73.71,12.54 C 73.72,12.03 73.63,11.11 73.57,10.91 C 73.53,10.82 73.4,10.02 73.27,9.13 L 73.26,9.1 C 72.98,7.29 72.98,7.28 72.72,7.51 C 72.61,7.61 72.5,7.67 72.47,7.63 C 72.44,7.6 72.2,7.82 71.94,8.13 C 71.69,8.43 71.43,8.69 71.38,8.69 C 71.26,8.69 66.72,13.22 66.79,13.28 C 66.81,13.31 66.58,13.55 66.27,13.83 C 65.97,14.11 65.71,14.39 65.71,14.45 C 65.71,14.51 65.54,14.71 65.33,14.87 C 65.11,15.04 64.94,15.24 64.94,15.32 C 64.94,15.39 64.78,15.55 64.6,15.68 C 64.41,15.82 64.29,15.96 64.33,16.02 C 64.36,16.06 64.21,16.25 64.03,16.42 C 63.83,16.58 63.67,16.75 63.68,16.8 C 63.69,16.84 63.47,17.12 63.18,17.42 C 62.89,17.72 62.66,18.01 62.66,18.05 C 62.66,18.11 62.57,18.21 62.47,18.28 C 62.36,18.36 62.27,18.48 62.27,18.55 C 62.27,18.62 62.17,18.73 62.05,18.79 C 61.93,18.86 61.85,18.95 61.87,19.01 C 61.9,19.05 61.74,19.28 61.52,19.53 C 61.29,19.76 61.11,19.98 61.11,20.02 C 61.11,20.14 60.34,21.13 60.25,21.13 C 60.21,21.13 60.16,21.2 60.16,21.29 C 60.16,21.39 60.08,21.49 59.99,21.53 C 59.91,21.57 59.83,21.67 59.83,21.75 C 59.83,21.84 59.75,21.94 59.66,21.97 C 59.57,22.01 59.52,22.08 59.55,22.14 C 59.58,22.18 59.51,22.28 59.38,22.35 C 59.26,22.41 59.18,22.51 59.22,22.57 C 59.25,22.63 59.22,22.7 59.14,22.76 C 59.06,22.8 58.92,22.99 58.83,23.16 C 58.74,23.34 58.56,23.6 58.42,23.75 C 58.28,23.89 58.2,24.01 58.23,24.01 C 58.25,24.01 58.14,24.21 57.98,24.46 C 57.82,24.7 57.64,24.9 57.58,24.9 C 57.53,24.9 57.51,24.95 57.54,25 C 57.57,25.06 57.53,25.14 57.43,25.17 C 57.34,25.2 57.3,25.28 57.33,25.35 C 57.36,25.4 57.34,25.46 57.27,25.46 C 57.21,25.46 57.17,25.5 57.21,25.55 C 57.23,25.59 57.16,25.69 57.04,25.77 C 56.93,25.85 56.83,25.86 56.83,25.8 C 56.83,25.75 56.73,25.72 56.61,25.76 C 56.47,25.79 56.39,25.76 56.39,25.69 C 56.39,25.61 56.34,25.59 56.27,25.62 C 56.22,25.66 56.1,25.66 56.03,25.6 C 55.95,25.56 55.84,25.51 55.77,25.51 C 55.43,25.49 53.98,25.19 53.88,25.11 C 53.82,25.06 53.66,25.05 53.53,25.08 C 53.41,25.11 53.26,25.09 53.23,25.04 C 53.19,24.97 53,24.95 52.79,24.98 C 52.59,25.01 52.39,24.99 52.35,24.94 C 52.22,24.71 46.72,24.94 46.15,25.18 C 46.04,25.22 45.87,25.24 45.78,25.2 C 45.69,25.16 45.59,25.18 45.56,25.22 C 45.49,25.34 44.45,25.52 44.15,25.48 C 44.04,25.47 43.95,25.51 43.95,25.58 C 43.95,25.65 43.85,25.68 43.73,25.65 C 43.6,25.61 43.5,25.64 43.5,25.7 C 43.5,25.77 43.44,25.79 43.35,25.76 C 43.26,25.72 43.16,25.72 43.13,25.77 C 43,25.88 42.71,25.89 42.79,25.78 C 42.83,25.72 42.77,25.65 42.68,25.61 C 42.58,25.58 42.5,25.48 42.5,25.39 C 42.5,25.3 42.46,25.24 42.42,25.24 C 42.34,25.24 42.02,24.77 41.93,24.51 C 41.92,24.46 41.78,24.29 41.65,24.14 C 41.5,23.99 41.39,23.8 41.39,23.73 C 41.39,23.64 41.34,23.57 41.27,23.57 C 41.22,23.57 41.19,23.51 41.23,23.46 C 41.26,23.39 41.22,23.31 41.13,23.28 C 41.03,23.25 40.97,23.17 41,23.11 C 41.04,23.07 40.96,22.97 40.83,22.9 C 40.7,22.83 40.62,22.75 40.65,22.73 C 40.68,22.69 40.58,22.54 40.44,22.38 C 40.29,22.23 40.17,22.03 40.17,21.96 C 40.17,21.88 40.09,21.78 39.99,21.75 C 39.91,21.72 39.85,21.64 39.89,21.58 C 39.93,21.52 39.85,21.42 39.73,21.35 C 39.61,21.28 39.53,21.18 39.56,21.14 C 39.59,21.08 39.54,21 39.44,20.97 C 39.35,20.94 39.29,20.86 39.34,20.8 C 39.37,20.74 39.29,20.64 39.17,20.57 C 39.05,20.5 38.97,20.4 39.01,20.35 C 39.04,20.29 38.96,20.19 38.84,20.13 C 38.72,20.06 38.64,19.96 38.67,19.9 C 38.71,19.85 38.63,19.75 38.51,19.68 C 38.38,19.62 38.28,19.49 38.28,19.41 C 38.28,19.32 38.24,19.24 38.18,19.24 C 38.14,19.24 37.95,19.03 37.77,18.76 C 37.6,18.51 37.38,18.25 37.31,18.21 C 37.23,18.15 37.2,18.07 37.23,18.02 C 37.26,17.96 37.18,17.86 37.06,17.79 C 36.94,17.73 36.85,17.64 36.88,17.6 C 36.91,17.55 36.78,17.4 36.61,17.25 C 36.43,17.11 36.31,16.95 36.34,16.91 C 36.37,16.86 36.27,16.74 36.12,16.64 C 35.96,16.54 35.84,16.41 35.84,16.35 C 35.84,16.3 35.73,16.13 35.6,15.97 C 35.45,15.82 35.17,15.51 34.97,15.27 C 34.77,15.04 34.44,14.69 34.25,14.47 C 34.05,14.27 33.98,14.14 34.06,14.19 C 34.15,14.24 33.91,13.96 33.51,13.59 C 33.11,13.21 32.85,12.93 32.93,12.96 C 33.01,13.01 32.11,12.09 30.93,10.92 C 29.76,9.75 28.76,8.8 28.72,8.8 C 28.68,8.8 28.48,8.6 28.29,8.36 C 28.09,8.1 27.9,7.92 27.88,7.96 C 27.85,7.99 27.6,7.84 27.35,7.62 C 27.11,7.43 26.98,7.32 26.9,7.35 C 26.79,7.39 26.76,7.67 26.67,8.33 C 26.62,8.66 26.56,8.94 26.5,8.98 C 26.45,9 26.43,9.18 26.48,9.36 C 26.51,9.58 26.49,9.69 26.41,9.69 C 26.32,9.69 26.3,9.78 26.35,9.9 C 26.38,10.02 26.36,10.43 26.29,10.82 C 26.22,11.2 26.15,11.96 26.11,12.52 C 26.09,13.06 26.04,13.64 26,13.8 C 25.72,15.01 25.79,19.41 26.13,22.63 C 26.22,23.48 26.31,24.47 26.32,24.81 C 26.33,25.17 26.39,25.46 26.45,25.46 C 26.5,25.46 26.51,25.6 26.48,25.79 C 26.43,25.97 26.46,26.15 26.52,26.19 C 26.59,26.22 26.62,26.37 26.61,26.49 C 26.6,26.62 26.62,26.81 26.66,26.9 C 26.72,27.09 26.97,28.38 27.01,28.79 C 27.02,28.94 27.07,29.14 27.1,29.23 C 27.15,29.32 27.19,29.6 27.2,29.84 C 27.22,30.09 27.27,30.31 27.31,30.34 C 27.36,30.38 27.41,30.58 27.43,30.79 C 27.46,31 27.51,31.25 27.56,31.35 C 27.6,31.45 27.65,31.65 27.67,31.8 C 27.69,31.94 27.73,32.14 27.77,32.23 C 27.88,32.49 28.32,34.15 28.34,34.34 C 28.34,34.44 28.39,34.56 28.43,34.64 C 28.48,34.71 28.52,34.91 28.53,35.09 C 28.54,35.25 28.6,35.43 28.66,35.46 C 28.72,35.51 28.77,35.7 28.78,35.89 C 28.78,36.07 28.83,36.23 28.89,36.23 C 28.93,36.23 28.96,36.31 28.91,36.4 C 28.88,36.48 28.9,36.56 28.97,36.56 C 29.03,36.56 29.06,36.66 29.01,36.78 C 28.97,36.92 28.99,37.01 29.07,37.01 C 29.13,37.01 29.16,37.06 29.12,37.12 C 29.08,37.18 29.11,37.32 29.19,37.41 C 29.28,37.51 29.29,37.61 29.22,37.65 C 29.17,37.7 29.11,37.83 29.1,37.95 C 29.02,38.83 28.41,41.79 28.26,41.97 C 28.2,42.05 28.18,42.12 28.22,42.12 C 28.27,42.12 28.21,42.28 28.11,42.47 C 27.89,42.93 27.2,43.59 27.07,43.5 C 27,43.46 26.96,43.48 26.96,43.54 C 26.96,43.6 26.83,43.68 26.68,43.71 L 26.4,43.78 L 26.62,44.36 C 26.73,44.67 26.81,44.97 26.78,45.02 C 26.75,45.07 26.78,45.11 26.85,45.11 C 26.91,45.11 26.93,45.16 26.9,45.22 C 26.87,45.28 26.89,45.34 26.96,45.34 C 27.02,45.34 27.06,45.38 27.02,45.44 C 26.98,45.49 27.01,45.56 27.07,45.58 C 27.13,45.6 27.2,45.72 27.21,45.87 C 27.21,46 27.28,46.11 27.33,46.11 C 27.39,46.11 27.41,46.15 27.37,46.18 C 27.33,46.21 27.4,46.34 27.52,46.46 C 27.65,46.58 27.71,46.72 27.68,46.78 C 27.63,46.85 27.67,46.89 27.73,46.89 C 27.8,46.89 27.83,46.93 27.8,46.99 C 27.77,47.05 27.81,47.11 27.9,47.16 C 27.99,47.19 28.07,47.29 28.07,47.39 C 28.07,47.48 28.12,47.56 28.19,47.56 C 28.24,47.56 28.28,47.6 28.23,47.66 C 28.2,47.72 28.28,47.82 28.41,47.89 C 28.53,47.97 28.61,48.05 28.58,48.08 C 28.54,48.11 28.67,48.26 28.86,48.41 C 29.03,48.57 29.16,48.73 29.12,48.78 C 29.09,48.83 29.12,48.89 29.2,48.92 C 29.28,48.95 29.24,48.95 29.12,48.91 C 29,48.89 28.77,48.87 28.6,48.87 C 28.42,48.88 28.29,48.83 28.29,48.77 C 28.29,48.7 28.22,48.67 28.16,48.7 C 28.08,48.72 27.9,48.7 27.77,48.66 C 27.42,48.53 27.43,48.58 28.01,49.64 C 29.17,51.8 30.44,53.49 32.14,55.12 L 33.24,56.16 L 31.73,55.41 C 30.03,54.54 29.26,53.99 28.56,53.13 C 27.59,51.95 26.35,49.73 25.64,47.92 C 25.52,47.63 25.39,47.3 25.35,47.18 C 25.27,47.01 25.3,46.99 25.47,47.03 C 25.58,47.07 25.84,47.12 26.02,47.17 L 26.38,47.23 L 25.96,46.36 C 25.49,45.38 24.87,43.56 24.78,42.85 L 24.71,42.39 L 25.51,42.39 C 26.27,42.39 26.32,42.37 26.62,42.04 C 27.05,41.57 27.3,40.42 27.37,38.62 C 27.43,37.16 27.3,36.12 26.89,34.62 C 26.39,32.79 25.39,27.82 25.07,25.57 C 24.4,20.92 24.37,15.31 24.96,10.8 C 25.39,7.58 25.75,6 26.15,5.56 M 70.64,55.56 L 71.1,55.36 L 71.18,55.76 C 71.47,57.26 71.52,61.83 71.26,62.16 C 71.21,62.23 71.17,62.45 71.17,62.66 C 71.18,63.27 71.04,64.23 70.92,64.46 C 70.87,64.57 70.84,64.71 70.88,64.77 C 70.91,64.83 70.89,64.89 70.83,64.94 C 70.78,64.97 70.72,65.08 70.72,65.19 C 70.72,65.37 70.63,65.82 70.6,65.82 C 70.59,65.82 70.56,65.97 70.53,66.16 C 70.5,66.34 70.4,66.65 70.31,66.85 C 70.21,67.04 70.12,67.29 70.1,67.4 C 70.08,67.51 70.06,67.6 70.04,67.6 C 70.03,67.6 70.01,67.72 69.98,67.87 C 69.96,68.02 69.88,68.2 69.82,68.27 C 69.77,68.35 69.75,68.43 69.79,68.47 C 69.82,68.51 69.79,68.55 69.71,68.55 C 69.63,68.55 69.59,68.58 69.62,68.61 C 69.66,68.65 69.57,68.98 69.41,69.36 C 68.59,71.39 67.02,73.96 65.54,75.76 C 64.9,76.53 62.04,79.32 61.94,79.26 C 61.89,79.23 61.83,79.27 61.79,79.35 C 61.73,79.52 60.02,80.76 59.84,80.76 C 59.77,80.76 59.72,80.81 59.72,80.85 C 59.72,80.95 58.28,81.77 57.72,81.99 C 57.51,82.07 57.26,82.21 57.19,82.28 C 57.1,82.36 56.99,82.4 56.93,82.37 C 56.87,82.33 56.83,82.35 56.83,82.39 C 56.83,82.45 56.72,82.49 56.59,82.5 C 56.46,82.52 56.31,82.59 56.26,82.67 C 56.21,82.75 56.16,82.77 56.16,82.72 C 56.16,82.66 56.1,82.68 56.02,82.75 C 55.93,82.82 55.83,82.84 55.8,82.79 C 55.75,82.76 55.72,82.78 55.72,82.85 C 55.72,82.92 55.64,82.95 55.55,82.92 C 55.46,82.87 55.39,82.9 55.39,82.99 C 55.39,83.07 55.35,83.09 55.31,83.06 C 55.27,83.02 55.19,83.03 55.12,83.08 C 55.04,83.15 54.86,83.22 54.72,83.25 C 54.22,83.35 54,83.4 53.78,83.49 C 53.58,83.56 53.59,83.54 53.83,83.25 C 54.26,82.75 54.61,82.36 54.84,82.11 C 54.95,81.97 55.05,81.82 55.05,81.76 C 55.05,81.69 55.13,81.62 55.22,81.58 C 55.31,81.54 55.36,81.48 55.33,81.43 C 55.31,81.38 55.4,81.23 55.53,81.08 C 55.66,80.94 55.77,80.79 55.77,80.76 C 55.77,80.62 56.09,79.98 56.16,79.98 C 56.2,79.98 56.24,79.92 56.24,79.84 C 56.25,79.63 56.76,78.5 56.89,78.41 C 56.95,78.36 56.95,78.32 56.91,78.32 C 56.85,78.32 56.85,78.25 56.9,78.18 C 56.95,78.11 57,77.97 57.01,77.87 C 57.01,77.79 57.1,77.41 57.2,77.04 C 57.7,75.15 57.73,72.04 57.27,69.82 C 57.13,69.15 57.02,68.52 57.01,68.43 C 57,68.33 56.94,68.2 56.9,68.12 C 56.8,67.96 57.38,66.94 58.34,65.58 C 59.55,63.89 61.35,61.97 63.05,60.54 C 63.69,59.99 64.3,59.47 64.41,59.38 C 64.51,59.3 64.66,59.22 64.71,59.22 C 64.78,59.22 64.83,59.16 64.83,59.11 C 64.83,59.04 64.9,59 64.99,59 C 65.08,59 65.16,58.95 65.16,58.9 C 65.16,58.78 67.19,57.44 67.36,57.44 C 67.42,57.44 67.49,57.4 67.51,57.34 C 67.56,57.23 70,55.83 70.64,55.56 M 28.8,55.85 C 28.83,55.69 28.89,55.55 28.91,55.55 C 29.41,55.55 34.95,58.92 34.95,59.23 C 34.95,59.28 35,59.32 35.05,59.31 C 35.25,59.24 37.07,60.77 38.56,62.27 C 40.14,63.84 41.59,65.66 42.55,67.24 L 43.07,68.08 L 42.84,68.89 C 42.49,70.13 42.29,71.8 42.29,73.32 C 42.29,74.63 42.34,75.42 42.39,75.54 C 42.4,75.58 42.44,75.72 42.46,75.88 C 42.47,76.03 42.57,76.47 42.67,76.87 C 42.78,77.27 42.87,77.64 42.88,77.71 C 42.91,77.82 43.01,78.07 43.43,79.1 C 43.56,79.43 43.66,79.74 43.64,79.78 C 43.63,79.84 43.67,79.87 43.74,79.87 C 43.79,79.87 43.83,79.92 43.79,79.97 C 43.75,80.03 43.77,80.1 43.83,80.12 C 43.88,80.13 43.95,80.23 43.97,80.32 C 43.99,80.41 44.03,80.51 44.07,80.54 C 44.1,80.57 44.25,80.79 44.39,81.04 C 44.74,81.62 45.56,82.72 45.99,83.18 L 46.34,83.55 L 46,83.47 C 45.82,83.43 45.65,83.36 45.61,83.32 C 45.58,83.28 45.46,83.24 45.34,83.24 C 45.21,83.23 44.97,83.16 44.78,83.08 C 44.6,83 44.37,82.94 44.28,82.92 C 43.94,82.85 42.43,82.18 41.55,81.72 C 38.59,80.14 35.49,77.47 33.68,74.96 C 33.4,74.58 33.13,74.21 33.06,74.13 C 32.83,73.85 31.85,72.25 31.82,72.1 C 31.8,72.01 31.72,71.87 31.64,71.79 C 31.57,71.7 31.47,71.48 31.43,71.3 C 31.4,71.12 31.3,70.94 31.22,70.91 C 31.13,70.88 31.07,70.8 31.07,70.74 C 31.07,70.69 30.89,70.28 30.68,69.83 C 30.47,69.39 30.29,68.91 30.29,68.78 C 30.29,68.66 30.24,68.55 30.2,68.55 C 30.11,68.55 29.8,67.75 29.79,67.49 C 29.79,67.42 29.74,67.35 29.7,67.31 C 29.64,67.28 29.6,67.09 29.6,66.9 C 29.59,66.7 29.54,66.55 29.5,66.55 C 29.44,66.55 29.43,66.48 29.47,66.39 C 29.5,66.3 29.47,66.2 29.41,66.16 C 29.34,66.12 29.31,66.04 29.36,65.98 C 29.39,65.92 29.36,65.8 29.29,65.71 C 29.21,65.63 29.19,65.55 29.22,65.55 C 29.27,65.55 29.24,65.46 29.19,65.34 C 29.12,65.23 29.06,64.97 29.03,64.76 C 29.01,64.55 28.96,64.3 28.91,64.2 C 28.87,64.1 28.84,63.98 28.86,63.93 C 28.87,63.87 28.84,63.7 28.81,63.55 C 28.48,62.23 28.47,57.41 28.8,55.85 M 49.14,60.81 C 49.61,60.28 49.91,60.03 50,60.08 C 50.48,60.36 52.7,63.17 53.54,64.56 C 54.14,65.56 55.13,67.6 55.21,67.99 C 55.23,68.15 55.26,68.28 55.29,68.29 C 55.3,68.31 55.31,68.36 55.33,68.4 C 55.34,68.46 55.41,68.62 55.47,68.79 C 55.54,68.96 55.57,69.18 55.54,69.27 C 55.5,69.36 55.52,69.43 55.57,69.43 C 55.63,69.43 55.69,69.5 55.7,69.57 C 55.71,69.65 55.8,70.06 55.9,70.49 C 56.07,71.26 56.14,73.92 56.01,75.1 C 55.97,75.38 55.94,75.68 55.94,75.76 C 55.93,75.85 55.9,76.01 55.85,76.1 C 55.82,76.19 55.77,76.34 55.76,76.43 C 55.69,76.86 55.64,76.99 55.59,77.05 C 55.54,77.09 55.54,77.19 55.57,77.27 C 55.61,77.36 55.57,77.43 55.5,77.43 C 55.42,77.43 55.39,77.5 55.42,77.59 C 55.45,77.67 55.45,77.77 55.41,77.82 C 55.36,77.86 55.32,77.94 55.32,78 C 55.31,78.05 55.3,78.11 55.27,78.12 C 55.26,78.14 55.24,78.23 55.22,78.32 C 55.15,78.7 54.69,79.65 54.58,79.65 C 54.51,79.65 54.49,79.68 54.53,79.72 C 54.61,79.8 54.36,80.32 54.14,80.56 C 54.06,80.64 53.92,80.84 53.83,81.01 C 53.33,81.88 51.8,83.44 50.73,84.16 C 50.12,84.57 49.99,84.61 49.77,84.51 C 49.62,84.45 49.5,84.35 49.5,84.29 C 49.5,84.25 49.44,84.2 49.37,84.2 C 49.1,84.2 47.56,82.9 46.9,82.14 C 45.75,80.79 44.37,78.17 44.37,77.34 C 44.37,77.21 44.33,77.1 44.28,77.1 C 44.05,77.1 43.78,74.9 43.79,73.1 C 43.8,71.06 44.01,69.78 44.63,68.03 C 45.01,66.94 46.1,64.73 46.41,64.41 C 46.52,64.3 46.58,64.21 46.55,64.21 C 46.46,64.21 46.96,63.53 47.17,63.36 C 47.26,63.28 47.29,63.22 47.23,63.22 C 47.18,63.22 47.25,63.12 47.39,62.99 C 47.53,62.87 47.61,62.77 47.57,62.77 C 47.47,62.77 48.09,61.99 49.14,60.81 M 27.96,12.41 C 27.95,12.34 27.98,12.34 28.03,12.39 C 28.08,12.44 28.12,12.53 28.12,12.6 C 28.12,12.65 28.32,12.89 28.57,13.11 C 28.82,13.33 28.94,13.46 28.84,13.41 C 28.74,13.34 28.89,13.52 29.17,13.79 C 29.44,14.06 29.58,14.21 29.47,14.12 C 29.29,14 29.3,14.03 29.51,14.32 C 29.78,14.69 29.93,14.82 29.78,14.54 C 29.73,14.46 29.74,14.44 29.8,14.5 C 29.86,14.55 29.88,14.6 29.86,14.61 C 29.83,14.62 29.87,14.74 29.94,14.89 C 30.02,15.02 30.12,15.11 30.19,15.07 C 30.24,15.03 30.29,15.04 30.28,15.1 C 30.23,15.27 30.42,15.57 30.54,15.5 C 30.6,15.46 30.62,15.47 30.59,15.54 C 30.54,15.61 30.6,15.75 30.69,15.86 C 30.79,15.97 30.82,16 30.78,15.91 C 30.73,15.81 30.74,15.77 30.8,15.83 C 30.85,15.88 30.91,15.97 30.91,16.03 C 30.92,16.08 30.93,16.18 30.94,16.25 C 30.94,16.31 31.02,16.33 31.1,16.28 C 31.17,16.24 31.2,16.24 31.15,16.3 C 31.04,16.42 31.28,16.82 31.41,16.74 C 31.47,16.7 31.51,16.71 31.5,16.76 C 31.45,17 31.52,17.14 31.64,17.06 C 31.72,17.02 31.73,17.03 31.69,17.11 C 31.64,17.18 31.73,17.36 31.89,17.52 C 32.04,17.67 32.14,17.79 32.11,17.79 C 32.08,17.79 32.14,17.94 32.24,18.12 C 32.35,18.31 32.48,18.43 32.53,18.39 C 32.59,18.36 32.62,18.37 32.61,18.43 C 32.56,18.66 32.63,18.81 32.75,18.73 C 32.83,18.68 32.84,18.69 32.8,18.77 C 32.71,18.92 32.99,19.38 33.1,19.29 C 33.14,19.26 33.15,19.27 33.12,19.31 C 33.05,19.41 33.39,20.02 33.51,20.02 C 33.58,20.02 33.61,20.05 33.61,20.09 C 33.58,20.32 33.63,20.47 33.73,20.4 C 33.8,20.36 33.81,20.42 33.76,20.53 C 33.72,20.66 33.73,20.69 33.82,20.64 C 33.91,20.58 33.93,20.63 33.88,20.75 C 33.83,20.88 33.84,20.92 33.94,20.86 C 34.01,20.82 34.05,20.82 34.04,20.87 C 34,21.05 34.2,21.46 34.3,21.4 C 34.35,21.37 34.36,21.42 34.33,21.5 C 34.3,21.59 34.38,21.77 34.5,21.89 C 34.63,22.03 34.73,22.15 34.73,22.18 L 34.73,22.35 C 34.73,22.4 34.84,22.56 34.99,22.69 C 35.12,22.83 35.16,22.9 35.09,22.86 C 34.97,22.79 34.97,22.84 35.07,23.06 C 35.15,23.21 35.25,23.31 35.3,23.28 C 35.35,23.25 35.36,23.31 35.32,23.41 C 35.27,23.55 35.29,23.58 35.37,23.53 C 35.46,23.47 35.49,23.51 35.43,23.64 C 35.39,23.77 35.4,23.8 35.49,23.75 C 35.57,23.69 35.6,23.74 35.54,23.86 C 35.5,23.99 35.51,24.02 35.6,23.97 C 35.69,23.91 35.71,23.96 35.65,24.08 C 35.61,24.21 35.62,24.25 35.71,24.19 C 35.8,24.14 35.82,24.17 35.77,24.28 C 35.74,24.38 35.76,24.46 35.83,24.46 C 35.9,24.46 35.94,24.49 35.93,24.54 C 35.89,24.68 36.2,25.35 36.3,25.35 C 36.35,25.35 36.36,25.42 36.33,25.51 C 36.29,25.6 36.34,25.7 36.44,25.75 C 36.54,25.78 36.6,25.86 36.56,25.9 C 36.47,26.04 36.63,26.36 36.74,26.28 C 36.8,26.25 36.81,26.31 36.76,26.41 C 36.72,26.55 36.73,26.58 36.82,26.52 C 36.91,26.47 36.93,26.51 36.87,26.63 C 36.83,26.75 36.85,26.8 36.91,26.76 C 36.96,26.72 37.02,26.79 37.02,26.91 C 37.02,27.02 36.95,27.12 36.86,27.12 C 36.78,27.12 36.75,27.18 36.8,27.25 C 36.84,27.33 36.8,27.35 36.63,27.29 C 36.5,27.25 36.4,27.27 36.4,27.33 C 36.4,27.4 36.32,27.42 36.23,27.39 C 36.14,27.35 36.06,27.38 36.06,27.45 C 36.06,27.51 35.99,27.53 35.87,27.49 C 35.76,27.45 35.72,27.47 35.76,27.53 C 35.82,27.61 35.75,27.63 35.6,27.59 C 35.45,27.56 35.39,27.58 35.43,27.65 C 35.47,27.71 35.44,27.77 35.36,27.76 C 35.01,27.75 34.83,27.8 34.9,27.9 C 34.94,27.97 34.89,27.98 34.77,27.93 C 34.64,27.89 34.61,27.9 34.66,27.99 C 34.71,28.08 34.69,28.1 34.59,28.06 C 34.5,28.02 34.4,28.08 34.36,28.17 C 34.31,28.29 34.36,28.34 34.51,28.34 C 34.63,28.34 34.73,28.4 34.73,28.47 C 34.73,28.53 34.82,28.56 34.94,28.51 C 35.09,28.47 35.16,28.51 35.21,28.67 C 35.24,28.79 35.22,28.88 35.17,28.87 C 35.12,28.86 35,28.94 34.9,29.07 C 34.8,29.19 34.75,29.22 34.79,29.13 C 34.84,29.03 34.77,29.04 34.57,29.18 C 34.42,29.28 34.32,29.41 34.35,29.47 C 34.39,29.52 34.38,29.56 34.32,29.54 C 34.16,29.49 33.18,30.37 33.25,30.49 C 33.29,30.54 33.26,30.57 33.2,30.52 C 33.1,30.47 32.56,31.07 32.56,31.25 C 32.56,31.29 32.52,31.37 32.46,31.42 C 32.41,31.48 32.4,31.44 32.44,31.34 C 32.49,31.25 32.43,31.3 32.31,31.45 C 32.19,31.6 32.11,31.78 32.14,31.84 C 32.19,31.9 32.18,31.92 32.12,31.88 C 32.03,31.8 31.63,32.25 31.38,32.72 C 31.29,32.88 31.3,32.91 31.42,32.84 C 31.5,32.8 31.44,32.86 31.3,32.99 C 31.13,33.12 31.07,33.25 31.12,33.34 C 31.19,33.44 31.17,33.46 31.07,33.4 C 30.95,33.33 30.93,33.35 31,33.52 C 31.04,33.63 31.04,33.69 31,33.64 C 30.95,33.6 30.85,33.62 30.78,33.69 C 30.67,33.78 30.65,33.74 30.7,33.55 C 30.74,33.39 30.73,33.33 30.64,33.39 C 30.55,33.44 30.53,33.41 30.58,33.3 C 30.61,33.2 30.59,33.12 30.52,33.12 C 30.45,33.12 30.43,33.04 30.47,32.95 C 30.51,32.86 30.48,32.79 30.41,32.79 C 30.34,32.79 30.32,32.71 30.35,32.62 C 30.4,32.53 30.37,32.45 30.3,32.45 C 30.23,32.45 30.21,32.38 30.24,32.29 C 30.29,32.2 30.27,32.12 30.2,32.12 C 30.13,32.12 30.11,32.01 30.16,31.88 C 30.19,31.73 30.17,31.67 30.1,31.71 C 30.02,31.77 30,31.7 30.04,31.54 C 30.08,31.38 30.07,31.33 29.97,31.39 C 29.87,31.45 29.86,31.39 29.91,31.17 C 29.96,30.98 29.94,30.89 29.88,30.93 C 29.81,30.98 29.79,30.89 29.82,30.71 C 29.86,30.53 29.83,30.44 29.77,30.49 C 29.7,30.53 29.68,30.44 29.71,30.27 C 29.74,30.07 29.72,30 29.63,30.06 C 29.53,30.12 29.52,30.06 29.58,29.83 C 29.62,29.64 29.61,29.56 29.54,29.6 C 29.48,29.64 29.46,29.56 29.49,29.38 C 29.52,29.18 29.5,29.11 29.41,29.17 C 29.31,29.23 29.3,29.17 29.36,28.94 C 29.41,28.73 29.4,28.67 29.3,28.72 C 29.2,28.79 29.19,28.72 29.24,28.5 C 29.3,28.29 29.29,28.22 29.19,28.28 C 29.09,28.34 29.08,28.28 29.13,28.06 C 29.19,27.85 29.18,27.78 29.09,27.83 C 29,27.89 28.98,27.81 29.02,27.57 C 29.07,27.38 29.04,27.23 28.99,27.23 C 28.92,27.23 28.9,27.1 28.93,26.95 C 28.97,26.73 28.94,26.67 28.87,26.72 C 28.78,26.78 28.76,26.7 28.81,26.45 C 28.86,26.19 28.84,26.11 28.76,26.17 C 28.67,26.22 28.64,26.15 28.7,25.89 C 28.74,25.62 28.73,25.56 28.63,25.61 C 28.53,25.68 28.51,25.6 28.58,25.29 C 28.62,25 28.61,24.89 28.53,24.95 C 28.46,24.99 28.44,24.86 28.48,24.55 C 28.51,24.19 28.5,24.11 28.41,24.24 C 28.32,24.36 28.31,24.26 28.36,23.85 C 28.4,23.43 28.39,23.34 28.3,23.46 C 28.2,23.58 28.19,23.5 28.24,23.14 C 28.3,22.79 28.29,22.67 28.2,22.73 C 28.12,22.77 28.1,22.6 28.14,22.16 C 28.18,21.68 28.17,21.56 28.08,21.68 C 27.99,21.8 27.97,21.68 28.02,21.18 C 28.07,20.75 28.05,20.57 27.98,20.66 C 27.91,20.76 27.89,20.43 27.91,19.72 C 27.93,18.99 27.91,18.76 27.86,19.02 C 27.8,19.24 27.79,18.68 27.82,17.75 C 27.87,16.51 27.85,16.12 27.76,16.17 C 27.66,16.23 27.62,16.07 27.63,15.61 L 27.63,15.59 C 27.66,15.02 27.66,15 27.75,15.35 C 27.8,15.6 27.82,15.13 27.8,14.15 C 27.78,13.24 27.8,12.62 27.86,12.71 C 27.96,12.85 28.01,12.69 27.96,12.41 M 71.62,12.88 C 71.84,12.65 72.03,12.46 72.05,12.46 C 72.08,12.46 72.1,13.94 72.1,15.74 C 72.1,17.54 72.07,18.93 72.01,18.82 C 71.97,18.72 71.95,19.05 71.98,19.56 C 72.01,20.2 71.99,20.45 71.91,20.34 C 71.84,20.24 71.83,20.4 71.88,20.88 C 71.93,21.43 71.91,21.57 71.81,21.5 C 71.71,21.45 71.7,21.57 71.76,22.03 C 71.81,22.48 71.8,22.58 71.7,22.46 C 71.61,22.34 71.6,22.44 71.64,22.9 C 71.69,23.35 71.68,23.47 71.59,23.35 C 71.5,23.23 71.49,23.33 71.54,23.73 C 71.6,24.11 71.58,24.24 71.49,24.18 C 71.4,24.12 71.39,24.22 71.44,24.51 C 71.5,24.85 71.49,24.91 71.38,24.85 C 71.27,24.78 71.26,24.85 71.31,25.18 C 71.38,25.49 71.36,25.57 71.26,25.5 C 71.16,25.45 71.14,25.51 71.19,25.78 C 71.24,26.04 71.22,26.11 71.13,26.06 C 71.04,26 71.03,26.08 71.08,26.33 C 71.13,26.59 71.11,26.67 71.02,26.61 C 70.93,26.56 70.92,26.63 70.97,26.89 C 71.02,27.15 71,27.22 70.91,27.17 C 70.82,27.11 70.81,27.19 70.86,27.45 C 70.91,27.7 70.89,27.78 70.8,27.72 C 70.72,27.67 70.7,27.73 70.73,27.95 C 70.77,28.1 70.74,28.23 70.69,28.23 C 70.62,28.23 70.61,28.36 70.64,28.52 C 70.7,28.72 70.68,28.79 70.59,28.73 C 70.5,28.68 70.49,28.72 70.54,28.89 C 70.59,29.03 70.57,29.12 70.49,29.12 C 70.41,29.12 70.38,29.21 70.41,29.34 C 70.44,29.48 70.42,29.54 70.36,29.5 C 70.28,29.44 70.26,29.52 70.29,29.72 C 70.32,29.88 70.3,30.01 70.23,30.01 C 70.18,30.01 70.16,30.11 70.19,30.23 C 70.22,30.37 70.2,30.43 70.13,30.39 C 70.06,30.33 70.03,30.41 70.09,30.61 C 70.14,30.83 70.13,30.9 70.03,30.83 C 69.93,30.78 69.92,30.82 69.96,30.99 C 70,31.12 69.98,31.23 69.91,31.23 C 69.84,31.23 69.82,31.33 69.86,31.45 C 69.89,31.58 69.87,31.68 69.8,31.68 C 69.75,31.68 69.73,31.79 69.77,31.91 C 69.82,32.09 69.81,32.12 69.7,32.07 C 69.6,32 69.58,32.04 69.62,32.21 C 69.67,32.36 69.65,32.43 69.58,32.39 C 69.5,32.33 69.48,32.41 69.53,32.61 C 69.59,32.83 69.58,32.9 69.48,32.83 C 69.38,32.78 69.37,32.82 69.4,32.99 C 69.45,33.14 69.42,33.21 69.35,33.15 C 69.28,33.11 69.26,33.18 69.29,33.32 C 69.33,33.45 69.31,33.56 69.25,33.56 C 69.19,33.56 69.18,33.68 69.21,33.81 C 69.26,33.99 69.25,34.02 69.18,33.92 C 69.12,33.83 69.03,33.76 68.98,33.75 C 68.92,33.74 68.89,33.66 68.91,33.59 C 68.93,33.5 68.9,33.46 68.83,33.51 C 68.76,33.54 68.75,33.51 68.78,33.41 C 68.81,33.32 68.75,33.15 68.63,33.03 C 68.52,32.92 68.42,32.76 68.4,32.69 C 68.36,32.45 67.87,31.79 67.8,31.85 C 67.77,31.88 67.7,31.78 67.67,31.62 C 67.62,31.44 67.55,31.37 67.47,31.41 C 67.39,31.45 67.38,31.44 67.42,31.35 C 67.52,31.2 65.99,29.63 65.84,29.72 C 65.78,29.77 65.69,29.73 65.65,29.67 C 65.59,29.58 65.61,29.57 65.72,29.62 C 65.94,29.74 65.75,29.56 65.34,29.26 C 65.17,29.12 64.97,29.04 64.9,29.09 C 64.84,29.12 64.83,29.1 64.87,29.03 C 64.91,28.96 64.89,28.89 64.84,28.89 C 64.77,28.88 64.67,28.87 64.61,28.86 C 64.56,28.86 64.47,28.8 64.41,28.76 C 64.37,28.7 64.38,28.67 64.44,28.68 C 64.5,28.69 64.63,28.7 64.71,28.69 C 64.86,28.68 64.86,28.67 64.71,28.57 C 64.59,28.49 64.66,28.48 64.93,28.53 C 65.18,28.58 65.28,28.57 65.24,28.48 C 65.18,28.41 65.24,28.39 65.38,28.42 C 65.61,28.49 65.66,28.39 65.5,28.13 C 65.45,28.05 65.35,28.02 65.27,28.07 C 65.17,28.13 65.15,28.11 65.21,28.01 C 65.28,27.9 65.26,27.88 65.11,27.93 C 65,27.98 64.95,27.97 64.99,27.9 C 65.06,27.8 64.88,27.75 64.53,27.76 C 64.45,27.77 64.38,27.71 64.38,27.66 C 64.38,27.59 64.3,27.58 64.2,27.61 C 64.09,27.66 64.06,27.63 64.11,27.55 C 64.17,27.47 64.11,27.45 63.96,27.48 C 63.8,27.52 63.74,27.5 63.79,27.42 C 63.84,27.36 63.77,27.33 63.63,27.37 C 63.47,27.41 63.4,27.39 63.46,27.31 C 63.5,27.25 63.44,27.22 63.29,27.26 C 63.16,27.3 63.05,27.28 63.05,27.21 C 63.05,27.15 62.98,27.12 62.9,27.16 C 62.82,27.19 62.75,27.15 62.75,27.06 C 62.75,26.97 62.8,26.9 62.86,26.9 C 62.93,26.9 62.95,26.87 62.9,26.83 C 62.87,26.79 62.92,26.69 63,26.6 C 63.09,26.5 63.15,26.36 63.12,26.27 C 63.07,26.17 63.09,26.15 63.18,26.19 C 63.27,26.25 63.28,26.21 63.24,26.08 C 63.18,25.96 63.2,25.91 63.29,25.97 C 63.38,26.02 63.39,25.99 63.35,25.86 C 63.3,25.76 63.32,25.69 63.37,25.72 C 63.49,25.8 63.63,25.48 63.54,25.34 C 63.5,25.28 63.53,25.24 63.58,25.24 C 63.67,25.24 64.14,24.34 64.08,24.27 C 64.06,24.25 64.15,24.14 64.28,24 C 64.4,23.88 64.48,23.7 64.45,23.61 C 64.4,23.5 64.43,23.48 64.51,23.53 C 64.6,23.58 64.61,23.55 64.57,23.41 C 64.51,23.29 64.54,23.25 64.63,23.3 C 64.71,23.36 64.73,23.33 64.68,23.19 C 64.63,23.07 64.65,23.03 64.74,23.08 C 64.83,23.14 64.84,23.1 64.79,22.97 C 64.75,22.87 64.76,22.81 64.81,22.85 C 64.91,22.9 65.05,22.66 65.05,22.43 C 65.05,22.38 65.15,22.25 65.28,22.11 C 65.4,21.99 65.48,21.82 65.45,21.73 C 65.4,21.62 65.43,21.59 65.51,21.64 C 65.6,21.69 65.61,21.66 65.57,21.53 C 65.53,21.43 65.54,21.37 65.59,21.4 C 65.69,21.46 65.89,21.05 65.85,20.87 C 65.84,20.82 65.88,20.82 65.95,20.86 C 66.05,20.92 66.06,20.88 66.01,20.75 C 65.97,20.64 65.98,20.58 66.05,20.63 C 66.15,20.69 66.2,20.54 66.17,20.32 C 66.17,20.27 66.2,20.24 66.27,20.24 C 66.39,20.24 66.72,19.63 66.66,19.53 C 66.62,19.49 66.64,19.48 66.68,19.52 C 66.79,19.61 67.07,19.14 66.98,18.99 C 66.94,18.93 66.95,18.91 67.01,18.94 C 67.07,18.97 67.2,18.86 67.31,18.67 C 67.41,18.49 67.48,18.35 67.45,18.35 C 67.41,18.35 67.51,18.23 67.67,18.07 C 67.82,17.92 67.91,17.74 67.87,17.66 C 67.82,17.58 67.83,17.57 67.91,17.62 C 68.03,17.7 68.1,17.55 68.06,17.32 C 68.05,17.26 68.08,17.25 68.13,17.28 C 68.18,17.31 68.29,17.24 68.37,17.11 C 68.48,16.93 68.48,16.9 68.36,16.97 C 68.28,17.02 68.38,16.9 68.58,16.71 C 68.79,16.52 68.92,16.31 68.89,16.25 C 68.85,16.2 68.88,16.11 68.95,16.06 C 69.03,16.02 69.05,16.03 69,16.11 C 68.83,16.37 69.02,16.23 69.21,15.95 C 69.33,15.76 69.35,15.68 69.26,15.75 C 69.17,15.8 69.29,15.65 69.52,15.43 C 69.76,15.2 69.9,14.95 69.87,14.89 C 69.82,14.82 69.83,14.8 69.9,14.83 C 70,14.9 70.17,14.67 70.2,14.44 C 70.21,14.41 70.26,14.33 70.31,14.27 C 70.37,14.22 70.38,14.24 70.33,14.32 C 70.18,14.59 70.33,14.46 70.59,14.12 C 70.73,13.92 70.78,13.8 70.7,13.85 C 70.61,13.9 70.71,13.8 70.91,13.63 C 71.11,13.46 71.24,13.3 71.21,13.24 C 71.18,13.2 71.24,13.09 71.36,13.01 C 71.53,12.86 71.53,12.88 71.39,13.08 C 71.3,13.2 71.4,13.11 71.62,12.88 M 50.53,86.45 C 50.3,86.15 50.07,85.81 50,85.71 C 49.9,85.55 49.87,85.56 49.7,85.85 C 49.38,86.38 48.15,87.56 47.3,88.12 L 46.51,88.66 L 47.03,89.57 C 47.55,90.45 49.62,92.75 49.91,92.75 C 50.32,92.75 53.28,89.23 53.28,88.75 C 53.28,88.69 53.13,88.58 52.95,88.48 C 52.37,88.18 50.96,86.99 50.53,86.45 M 35.23,44.2 L 35.15,43.47 L 35.63,43.61 C 35.9,43.7 36.7,43.94 37.4,44.14 L 38.67,44.51 L 38.65,45.65 C 38.65,46.28 38.68,46.76 38.74,46.71 C 38.79,46.68 38.81,46.81 38.76,47.01 C 38.72,47.28 38.73,47.35 38.83,47.29 C 38.93,47.22 38.94,47.29 38.88,47.51 C 38.83,47.71 38.85,47.79 38.93,47.73 C 38.99,47.69 39.02,47.76 38.97,47.91 C 38.93,48.09 38.95,48.12 39.06,48.06 C 39.16,48 39.18,48.01 39.13,48.1 C 39.03,48.27 39.16,48.69 39.29,48.61 C 39.35,48.58 39.36,48.63 39.32,48.73 C 39.27,48.87 39.28,48.9 39.37,48.85 C 39.46,48.79 39.48,48.83 39.43,48.96 C 39.38,49.09 39.39,49.12 39.48,49.07 C 39.57,49.01 39.59,49.06 39.54,49.18 C 39.49,49.31 39.51,49.34 39.61,49.29 C 39.67,49.24 39.73,49.24 39.72,49.3 C 39.68,49.51 39.74,49.68 39.83,49.61 C 39.88,49.58 39.96,49.6 40.01,49.67 C 40.11,49.83 39.92,49.8 39.21,49.54 C 37,48.72 35.5,46.71 35.23,44.2 M 41.34,46.62 L 41.26,45.85 L 41.96,46.46 C 42.88,47.25 43.49,48.05 44.05,49.17 C 44.61,50.3 44.61,50.34 44.09,50.17 C 43.86,50.09 42.93,49.99 42,49.94 C 40.28,49.87 40.12,49.83 40.39,49.67 C 40.48,49.6 40.53,49.56 40.48,49.56 C 40.43,49.56 40.49,49.46 40.63,49.32 C 40.75,49.2 40.83,49.02 40.79,48.93 C 40.76,48.85 40.78,48.78 40.85,48.78 C 40.92,48.78 40.94,48.7 40.9,48.6 C 40.86,48.5 40.88,48.46 40.96,48.51 C 41.05,48.56 41.06,48.5 41,48.33 C 40.95,48.18 40.97,48.11 41.04,48.16 C 41.18,48.25 41.32,47.65 41.23,47.31 C 41.17,47.1 41.18,47.09 41.28,47.22 C 41.38,47.35 41.39,47.2 41.34,46.62 M 48.83,54.45 L 48.45,54.36 L 48.92,54.34 C 49.19,54.34 49.38,54.38 49.34,54.43 C 49.31,54.49 49.6,54.52 50,54.52 C 50.4,54.52 50.69,54.49 50.66,54.43 C 50.62,54.38 50.79,54.33 51.02,54.33 C 51.35,54.33 51.41,54.36 51.28,54.45 C 51.14,54.54 51.18,54.56 51.41,54.52 C 51.6,54.5 51.69,54.52 51.64,54.59 C 51.6,54.65 51.64,54.68 51.75,54.63 C 51.85,54.6 51.97,54.62 52.01,54.69 C 52.07,54.76 52.03,54.78 51.93,54.73 C 51.82,54.66 51.82,54.69 51.94,54.8 C 52.03,54.88 52.11,55.05 52.12,55.19 C 52.12,55.33 52.11,55.42 52.08,55.4 C 52.01,55.32 51.73,55.6 51.8,55.69 C 51.82,55.73 51.77,55.74 51.68,55.71 C 51.53,55.65 50.12,56.92 50.22,57.02 C 50.24,57.04 50.12,57.05 49.94,57.05 C 49.78,57.05 49.66,57.01 49.69,56.96 C 49.72,56.91 49.66,56.89 49.54,56.91 C 49.42,56.93 49.34,56.89 49.36,56.81 C 49.4,56.57 48.53,55.74 48.33,55.82 C 48.23,55.85 48.19,55.84 48.22,55.77 C 48.29,55.67 48.13,55.62 47.92,55.65 C 47.87,55.65 47.85,55.63 47.85,55.57 C 47.86,55.53 47.86,55.42 47.85,55.33 C 47.83,55.19 47.82,55.19 47.72,55.33 C 47.65,55.46 47.61,55.42 47.61,55.16 C 47.61,54.96 47.65,54.89 47.7,54.96 C 47.76,55.05 47.82,55 47.92,54.8 C 48.03,54.52 48.1,54.5 48.63,54.52 C 49.16,54.53 49.18,54.53 48.83,54.45 M 38.32,39.28 C 38.32,39.19 38.42,39.12 38.53,39.12 C 38.64,39.12 38.73,39.16 38.73,39.23 C 38.73,39.28 38.79,39.31 38.88,39.27 C 38.97,39.24 39.07,39.27 39.12,39.33 C 39.15,39.39 39.24,39.43 39.29,39.39 C 39.35,39.35 39.39,39.37 39.39,39.44 C 39.39,39.51 39.47,39.53 39.56,39.49 C 39.65,39.45 39.73,39.48 39.73,39.55 C 39.73,39.62 39.81,39.64 39.89,39.61 C 39.98,39.56 40.06,39.59 40.06,39.67 C 40.06,39.74 40.11,39.77 40.16,39.73 C 40.22,39.69 40.33,39.73 40.42,39.81 C 40.49,39.88 40.64,39.96 40.73,39.98 C 40.82,40.01 40.93,40.08 40.97,40.15 C 41.02,40.23 41.06,40.25 41.06,40.19 C 41.06,40.05 41.92,40.54 41.99,40.73 C 42.03,40.83 42.1,40.88 42.16,40.84 C 42.23,40.8 42.33,40.88 42.39,41 C 42.46,41.13 42.56,41.2 42.62,41.17 C 42.67,41.14 42.8,41.24 42.9,41.39 C 43,41.54 43.11,41.65 43.16,41.62 C 43.2,41.59 43.47,41.8 43.74,42.08 C 44,42.36 44.15,42.56 44.06,42.52 C 43.97,42.47 44.05,42.56 44.23,42.71 C 44.41,42.87 44.51,43 44.46,43 C 44.39,43 44.45,43.08 44.57,43.17 C 44.68,43.26 44.75,43.34 44.7,43.34 C 44.65,43.34 44.71,43.44 44.84,43.56 C 44.97,43.69 45.04,43.84 45,43.89 C 44.96,43.96 44.99,44 45.06,44 C 45.12,44 45.15,44.05 45.11,44.11 C 45.08,44.17 45.1,44.23 45.17,44.23 C 45.24,44.23 45.26,44.27 45.22,44.34 C 45.19,44.39 45.2,44.45 45.26,44.45 C 45.31,44.45 45.39,44.55 45.42,44.67 C 45.51,45.01 45.45,44.96 44.36,43.91 C 42.84,42.45 42.71,42.34 42.62,42.34 C 42.56,42.34 42.42,42.2 42.28,42.03 C 42.15,41.86 42,41.73 41.97,41.73 C 41.85,41.73 41.13,41.2 40.92,40.96 C 40.8,40.83 40.74,40.8 40.78,40.89 C 40.83,40.98 40.77,40.96 40.67,40.84 C 40.57,40.72 40.44,40.63 40.38,40.64 C 40.33,40.66 40.28,40.62 40.28,40.55 C 40.28,40.49 40.23,40.47 40.17,40.51 C 40.11,40.54 40.03,40.49 39.99,40.41 C 39.96,40.31 39.89,40.25 39.84,40.28 C 39.79,40.31 39.66,40.23 39.53,40.12 C 39.39,39.99 39.24,39.89 39.18,39.89 C 39.12,39.89 38.96,39.78 38.83,39.64 C 38.69,39.51 38.62,39.47 38.66,39.56 C 38.72,39.66 38.68,39.66 38.58,39.54 C 38.5,39.43 38.41,39.36 38.37,39.39 C 38.35,39.43 38.32,39.37 38.32,39.28 M 61.08,40.53 C 61.22,40.51 61.36,40.47 61.41,40.46 C 61.45,40.46 61.52,40.51 61.56,40.58 C 61.6,40.65 61.59,40.67 61.53,40.64 C 61.46,40.59 61.37,40.64 61.34,40.74 C 61.31,40.83 61.23,40.88 61.17,40.84 C 61.11,40.8 61.02,40.87 60.95,40.97 C 60.88,41.08 60.83,41.12 60.83,41.06 C 60.83,40.99 60.77,41.03 60.72,41.12 C 60.66,41.2 60.57,41.28 60.53,41.28 C 60.47,41.28 60.32,41.39 60.17,41.53 C 60.03,41.66 59.87,41.75 59.83,41.73 C 59.77,41.69 59.71,41.75 59.67,41.84 C 59.64,41.93 59.57,41.99 59.53,41.98 C 59.47,41.96 59.28,42.08 59.11,42.25 C 58.93,42.42 58.75,42.53 58.71,42.49 C 58.65,42.47 58.56,42.55 58.5,42.67 C 58.43,42.79 58.33,42.87 58.27,42.84 C 58.22,42.8 58.13,42.87 58.06,42.97 C 58,43.08 57.94,43.13 57.94,43.08 C 57.94,43.03 57.81,43.15 57.65,43.34 C 57.48,43.53 57.33,43.66 57.31,43.63 C 57.27,43.59 57.13,43.71 56.97,43.9 C 56.82,44.08 56.65,44.23 56.6,44.23 C 56.47,44.23 55.1,45.59 55.13,45.68 C 55.19,45.85 54.74,46.14 54.65,45.99 C 54.6,45.9 54.62,45.88 54.72,45.95 C 54.82,46 54.83,45.97 54.79,45.81 C 54.74,45.69 54.8,45.51 54.91,45.38 C 55.02,45.26 55.12,45.09 55.14,45 C 55.16,44.91 55.25,44.78 55.33,44.71 C 55.42,44.65 55.46,44.56 55.42,44.53 C 55.39,44.48 55.44,44.43 55.54,44.38 C 55.64,44.35 55.69,44.27 55.65,44.21 C 55.62,44.16 55.67,44.08 55.76,44.05 C 55.86,44.01 55.94,43.93 55.94,43.85 C 55.94,43.78 56.24,43.43 56.61,43.06 C 56.97,42.69 57.27,42.44 57.27,42.47 C 57.27,42.52 57.43,42.4 57.63,42.23 C 57.82,42.05 58.01,41.93 58.03,41.95 C 58.06,41.98 58.15,41.92 58.24,41.8 C 58.35,41.68 58.37,41.67 58.33,41.78 C 58.28,41.87 58.34,41.85 58.43,41.74 C 58.53,41.62 58.61,41.55 58.61,41.59 C 58.61,41.64 58.72,41.58 58.85,41.45 C 58.98,41.33 59.14,41.23 59.21,41.23 C 59.26,41.23 59.53,41.13 59.79,40.99 C 60.06,40.86 60.41,40.75 60.55,40.74 C 60.71,40.74 60.83,40.69 60.83,40.65 C 60.83,40.61 60.94,40.55 61.08,40.53 M 72.19,15.63 C 72.19,15.26 72.21,15.1 72.23,15.26 C 72.25,15.43 72.25,15.73 72.23,15.93 C 72.21,16.13 72.19,16 72.19,15.63'],
];
// Single-weight centerline strokes for currentColor surfaces (mono + input bar).
// Extracted from the artist's traced linework by skeletonizing a 1600px raster of the
// original ribbons down to 1px centerlines, then smoothing and refitting as beziers
// (verified: 100% of the centerline lies within the original artwork; 97.8% of the
// artwork is covered). One path, 234 subpaths; round caps/joins keep junctions clean.
// Because these are true strokes, line weight is a free parameter per surface.
const CAT_LOTUS_CENTERLINES = 'M 73.56,43.19 C 73.39,43.13 72.77,43.02 72.50,42.83 C 72.23,42.64 72.13,42.91 71.94,42.06 C 71.75,41.22 71.12,40.08 71.36,37.75 C 71.59,35.42 72.89,30.85 73.36,28.06 C 73.83,25.27 74.10,23.71 74.18,21.00 C 74.27,18.29 74.02,13.96 73.86,11.81 C 73.69,9.67 73.36,8.83 73.17,8.13 C 72.99,7.42 72.82,7.66 72.75,7.56 M 73.56,43.19 L 73.62,43.19 M 73.56,43.19 L 73.62,43.25 M 27.44,60.50 C 27.31,60.19 27.30,59.29 26.67,58.63 C 26.03,57.98 24.79,57.25 23.62,56.58 C 22.46,55.90 20.92,55.06 19.69,54.58 C 18.46,54.09 16.82,53.84 16.25,53.69 M 44.38,81.56 C 44.03,80.46 42.64,76.56 42.28,74.94 C 41.91,73.31 42.12,72.98 42.20,71.81 C 42.27,70.65 42.69,68.72 42.74,67.94 C 42.79,67.16 42.94,67.81 42.49,67.12 C 42.04,66.44 41.06,64.96 40.04,63.81 C 39.02,62.66 37.67,61.30 36.38,60.22 C 35.08,59.13 33.38,58.01 32.25,57.33 C 31.12,56.64 30.06,56.33 29.62,56.12 M 44.38,81.56 C 44.06,81.50 43.53,81.73 42.50,81.19 C 41.47,80.66 39.40,79.31 38.19,78.36 C 36.97,77.41 36.13,76.55 35.21,75.50 C 34.30,74.45 33.51,73.44 32.71,72.06 C 31.92,70.69 31.00,68.65 30.46,67.25 C 29.93,65.85 29.72,65.07 29.50,63.69 C 29.28,62.30 29.11,60.20 29.12,58.94 C 29.14,57.68 29.49,56.59 29.56,56.12 M 44.38,81.56 L 46.31,82.88 M 24.06,72.12 L 24.06,72.06 M 24.06,72.12 L 24.00,72.12 M 24.06,72.12 L 24.12,72.12 M 56.38,25.31 C 55.33,25.19 52.27,24.59 50.12,24.58 C 47.98,24.57 44.60,25.14 43.50,25.25 M 56.38,25.31 L 56.44,25.31 M 56.38,25.31 L 56.44,25.31 M 21.75,69.69 L 21.69,69.62 M 21.75,69.69 L 21.69,69.69 M 21.75,69.69 C 21.98,69.81 22.74,70.04 23.12,70.44 C 23.51,70.83 23.91,71.79 24.06,72.06 M 21.75,69.69 L 21.69,69.75 M 53.31,86.94 L 53.25,86.94 M 53.31,86.94 L 53.38,86.94 M 53.31,86.94 L 53.31,87.00 M 78.19,69.69 C 78.59,69.11 79.88,67.46 80.61,66.25 C 81.35,65.04 81.99,63.83 82.60,62.44 C 83.21,61.04 83.92,59.15 84.29,57.88 C 84.65,56.60 84.72,55.32 84.81,54.81 M 78.19,69.69 L 78.12,69.75 M 78.19,69.69 L 78.19,69.75 M 73.62,43.25 L 73.62,43.19 M 73.62,43.25 L 73.62,43.19 M 73.62,43.25 L 72.62,46.69 M 41.88,47.19 L 41.38,45.94 M 41.88,47.19 L 41.88,47.25 M 41.88,47.19 L 41.94,47.25 M 38.69,48.38 L 38.62,48.31 M 38.69,48.38 L 38.69,48.31 M 38.69,48.38 L 40.19,49.62 M 46.25,89.00 L 46.19,88.94 M 46.25,89.00 L 46.25,88.94 M 46.25,89.00 C 46.61,89.47 47.81,91.19 48.44,91.81 C 49.06,92.43 49.50,92.70 50.00,92.71 C 50.50,92.72 50.83,92.48 51.44,91.88 C 52.04,91.27 53.26,89.53 53.62,89.06 M 16.25,53.69 L 16.19,53.62 M 16.25,53.69 L 16.19,53.69 M 34.38,77.19 L 31.50,76.69 M 83.56,53.69 L 83.62,53.62 M 83.56,53.69 C 83.04,53.82 81.69,53.98 80.44,54.46 C 79.19,54.95 77.27,55.88 76.06,56.59 C 74.86,57.29 73.78,58.07 73.19,58.69 C 72.61,59.31 72.67,60.04 72.56,60.31 M 83.56,53.69 L 83.62,53.69 M 83.62,53.62 C 83.75,53.52 84.09,53.09 84.38,52.99 C 84.66,52.89 85.16,52.86 85.34,53.04 C 85.52,53.23 85.53,53.84 85.46,54.12 C 85.38,54.41 84.97,54.65 84.88,54.75 M 83.62,53.62 L 83.62,53.69 M 41.94,47.25 L 41.88,47.25 M 41.94,47.25 C 42.13,47.36 42.78,47.57 43.07,47.94 C 43.36,48.30 43.66,49.13 43.66,49.43 C 43.66,49.72 43.44,49.69 43.06,49.69 C 42.68,49.69 41.66,49.48 41.38,49.44 M 27.12,7.44 L 27.06,7.50 M 27.12,7.44 L 27.12,7.50 M 27.12,7.44 L 27.19,7.50 M 27.06,7.50 L 27.12,7.50 M 27.06,7.50 C 26.98,7.58 26.83,7.20 26.59,8.00 C 26.36,8.80 25.84,10.45 25.65,12.31 C 25.46,14.18 25.36,16.92 25.44,19.19 C 25.52,21.46 25.60,22.77 26.12,25.94 C 26.64,29.10 28.26,35.51 28.57,38.19 C 28.88,40.86 28.17,41.23 27.98,42.00 C 27.79,42.77 27.71,42.57 27.44,42.78 C 27.16,43.00 26.50,43.22 26.31,43.31 M 27.50,49.12 L 27.44,49.06 M 27.50,49.12 L 27.50,49.06 M 27.50,49.12 C 27.89,49.77 28.88,51.90 29.84,53.00 C 30.80,54.10 32.68,55.29 33.25,55.75 M 29.62,56.12 L 29.56,56.12 M 29.62,56.12 L 29.56,56.12 M 68.81,33.75 L 68.69,32.62 M 72.62,46.69 L 72.56,46.75 M 72.62,46.69 L 72.62,46.75 M 55.44,88.25 C 55.29,88.08 54.91,87.44 54.56,87.22 C 54.22,87.01 53.57,86.99 53.38,86.94 M 55.44,88.25 L 55.44,88.31 M 55.44,88.25 L 55.50,88.31 M 71.19,14.69 L 71.50,13.44 M 71.19,14.69 L 71.12,14.75 M 71.19,14.69 L 71.19,14.75 M 65.38,29.06 C 65.36,28.93 65.63,28.55 65.29,28.25 C 64.94,27.95 63.64,27.42 63.31,27.25 M 65.38,29.06 L 65.31,29.12 M 65.38,29.06 L 65.38,29.12 M 71.12,14.75 L 71.19,14.75 M 71.12,14.75 C 70.85,14.97 70.25,15.09 69.47,16.06 C 68.69,17.03 67.39,18.97 66.43,20.56 C 65.47,22.16 64.25,24.52 63.72,25.62 C 63.19,26.73 63.33,26.93 63.25,27.19 M 44.56,88.25 L 44.56,88.19 M 44.56,88.25 L 44.50,88.25 M 44.56,88.25 L 46.19,88.94 M 28.38,48.19 C 28.32,48.04 28.22,47.55 28.03,47.33 C 27.85,47.11 27.38,46.95 27.25,46.88 M 28.38,48.19 L 28.38,48.25 M 28.38,48.19 L 28.38,48.25 M 15.19,54.81 L 16.19,53.69 M 15.19,54.81 L 15.12,54.81 M 15.19,54.81 L 15.19,54.88 M 53.31,87.00 L 53.25,86.94 M 53.31,87.00 L 53.38,86.94 M 53.31,87.00 L 53.62,88.94 M 12.94,72.94 C 13.04,72.85 12.99,72.62 13.56,72.40 C 14.14,72.19 15.15,71.83 16.38,71.66 C 17.60,71.48 20.18,71.42 20.94,71.38 M 12.94,72.94 L 12.94,73.00 M 12.94,72.94 L 12.94,73.00 M 27.19,7.50 L 27.12,7.50 M 27.19,7.50 C 27.41,7.59 27.38,7.05 28.50,8.03 C 29.62,9.01 31.45,10.51 33.92,13.38 C 36.40,16.24 41.80,23.27 43.38,25.25 M 45.50,44.75 C 44.98,44.21 43.50,42.42 42.38,41.53 C 41.25,40.65 39.35,39.79 38.75,39.44 M 64.12,29.12 L 65.31,29.12 M 71.38,48.38 L 71.44,48.31 M 71.38,48.38 L 71.44,48.38 M 71.38,48.38 L 70.19,48.94 M 51.12,55.00 L 51.06,54.94 M 51.12,55.00 L 51.06,55.00 M 51.12,55.00 L 51.06,55.06 M 50.00,56.38 L 49.94,56.38 M 50.00,56.38 L 51.06,55.06 M 50.00,56.38 L 49.94,56.38 M 34.62,29.06 C 34.65,28.92 34.45,28.47 34.77,28.18 C 35.09,27.88 36.28,27.65 36.55,27.30 C 36.82,26.95 37.05,27.40 36.41,26.06 C 35.77,24.72 33.75,20.98 32.71,19.25 C 31.67,17.52 30.82,16.44 30.17,15.69 C 29.52,14.94 29.04,14.91 28.81,14.75 M 34.62,29.06 L 34.62,29.12 M 34.62,29.06 L 34.69,29.12 M 72.69,7.56 L 72.75,7.56 M 68.69,32.56 L 68.62,32.56 M 68.69,32.56 L 68.75,32.56 M 68.69,32.56 L 68.69,32.62 M 48.81,55.00 L 48.81,54.94 M 48.81,55.00 L 48.81,54.94 M 48.81,55.00 C 48.89,55.17 49.09,55.76 49.27,55.99 C 49.46,56.22 49.83,56.31 49.94,56.38 M 70.31,56.00 L 70.38,56.00 M 70.31,56.00 C 69.90,56.19 68.95,56.45 67.81,57.14 C 66.68,57.83 64.78,59.11 63.50,60.15 C 62.22,61.19 61.14,62.25 60.14,63.38 C 59.14,64.50 57.99,66.10 57.50,66.88 C 57.01,67.65 57.15,67.12 57.19,68.00 C 57.23,68.88 57.66,70.94 57.74,72.12 C 57.82,73.31 58.01,73.56 57.66,75.12 C 57.31,76.69 55.96,80.44 55.62,81.50 M 70.31,56.00 L 70.38,56.00 M 21.69,69.62 C 21.32,69.10 20.15,67.61 19.46,66.50 C 18.78,65.39 18.16,64.24 17.59,62.94 C 17.02,61.64 16.43,60.03 16.03,58.69 C 15.63,57.34 15.33,55.51 15.19,54.88 M 21.69,69.62 L 21.69,69.69 M 63.25,27.25 L 63.25,27.19 M 63.25,27.25 L 63.25,27.19 M 63.25,27.25 L 63.31,27.25 M 26.56,47.56 L 26.50,47.62 M 16.19,53.62 C 16.06,53.53 15.71,53.11 15.44,53.04 C 15.16,52.97 14.68,53.02 14.53,53.20 C 14.37,53.38 14.40,53.86 14.50,54.12 C 14.60,54.39 15.02,54.70 15.12,54.81 M 16.19,53.62 L 16.19,53.69 M 84.81,54.75 L 83.62,53.69 M 84.81,54.75 L 84.88,54.75 M 84.81,54.75 L 84.81,54.81 M 41.31,49.38 L 41.88,47.25 M 41.31,49.38 L 41.31,49.44 M 41.31,49.38 L 41.31,49.44 M 41.31,49.38 L 41.38,49.44 M 55.44,88.31 L 55.50,88.31 M 55.44,88.31 L 53.69,89.00 M 71.50,48.38 L 71.44,48.31 M 71.50,48.38 L 71.44,48.38 M 71.50,48.38 L 72.50,48.81 M 31.19,34.25 L 31.19,32.62 M 75.88,72.06 L 75.88,72.00 M 75.88,72.06 L 75.81,72.06 M 75.88,72.06 L 75.94,72.06 M 55.62,81.56 L 55.62,81.50 M 55.62,81.56 L 55.69,81.56 M 55.62,81.56 L 53.81,82.81 M 28.75,14.69 L 28.38,13.00 M 28.75,14.69 L 28.75,14.75 M 28.75,14.69 L 28.81,14.75 M 34.69,29.12 L 34.62,29.12 M 34.69,29.12 L 34.62,29.19 M 15.19,54.88 L 15.12,54.81 M 31.25,32.56 L 31.19,32.56 M 31.25,32.56 L 34.62,29.19 M 31.25,32.56 L 31.19,32.62 M 21.00,71.31 L 21.69,69.75 M 21.00,71.31 L 20.94,71.38 M 21.00,71.31 L 21.00,71.38 M 27.44,49.06 C 27.32,48.98 26.90,48.80 26.75,48.56 C 26.59,48.32 26.54,47.78 26.50,47.62 M 27.44,49.06 L 27.50,49.06 M 21.00,71.44 L 20.94,71.38 M 21.00,71.44 L 21.00,71.38 M 21.00,71.44 C 21.14,71.53 21.31,71.86 21.81,71.97 C 22.31,72.09 23.64,72.10 24.00,72.12 M 26.25,43.31 L 26.25,43.38 M 26.25,43.31 L 26.31,43.31 M 26.25,43.31 L 26.25,43.38 M 41.38,49.44 L 41.31,49.44 M 27.19,46.88 L 27.19,46.81 M 27.19,46.88 L 27.25,46.88 M 27.19,46.88 L 26.56,47.56 M 28.81,14.75 L 28.75,14.75 M 53.62,89.00 L 53.62,88.94 M 53.62,89.00 L 53.69,89.00 M 53.62,89.00 L 53.62,89.06 M 78.19,69.75 L 78.12,69.75 M 78.19,69.75 L 78.19,69.81 M 46.56,86.94 L 46.50,86.94 M 46.56,86.94 L 46.62,86.94 M 46.56,86.94 L 46.56,87.00 M 72.69,7.56 L 72.75,7.56 M 72.69,7.56 C 72.45,7.68 72.28,7.38 71.25,8.28 C 70.22,9.17 68.98,10.10 66.51,12.94 C 64.04,15.78 58.12,23.25 56.44,25.31 M 26.25,43.38 L 26.31,43.31 M 26.25,43.38 L 27.19,46.81 M 46.25,88.94 L 46.56,87.00 M 46.25,88.94 L 46.19,88.94 M 38.69,48.31 C 38.64,47.74 38.83,45.58 38.43,44.90 C 38.03,44.23 36.72,44.22 36.31,44.27 C 35.91,44.32 35.96,44.76 36.02,45.19 C 36.08,45.61 36.39,46.35 36.65,46.81 C 36.92,47.28 37.30,47.73 37.62,47.98 C 37.95,48.23 38.46,48.26 38.62,48.31 M 43.38,25.25 L 43.44,25.25 M 43.38,25.25 L 43.44,25.31 M 31.44,76.62 C 30.79,76.29 28.78,75.35 27.56,74.60 C 26.34,73.85 24.70,72.54 24.12,72.12 M 31.44,76.62 L 31.50,76.69 M 31.44,76.62 L 31.50,76.69 M 43.44,25.31 L 43.44,25.25 M 43.44,25.31 L 43.50,25.25 M 34.62,29.19 L 34.62,29.12 M 38.62,48.31 L 38.69,48.31 M 31.19,32.62 L 31.19,32.56 M 20.94,71.38 L 21.00,71.38 M 44.56,88.19 C 44.69,88.03 44.99,87.43 45.31,87.22 C 45.64,87.01 46.30,86.98 46.50,86.94 M 44.56,88.19 L 44.50,88.25 M 51.06,55.00 L 51.06,54.94 M 51.06,55.00 L 51.06,55.06 M 53.62,89.06 L 53.69,89.00 M 46.56,87.00 L 46.50,86.94 M 46.56,87.00 L 46.62,86.94 M 72.62,46.75 L 72.56,46.75 M 72.62,46.75 L 73.19,47.62 M 43.50,25.25 L 43.44,25.25 M 71.19,14.75 C 71.24,15.04 71.54,14.91 71.50,16.50 C 71.45,18.09 71.26,21.90 70.92,24.31 C 70.58,26.73 69.84,29.62 69.48,31.00 C 69.12,32.38 68.87,32.30 68.75,32.56 M 65.38,29.12 L 65.31,29.12 M 65.38,29.12 L 68.62,32.56 M 28.38,48.25 L 27.50,49.06 M 73.19,47.69 L 73.19,47.62 M 73.19,47.69 L 73.19,47.62 M 73.19,47.69 L 72.50,48.81 M 48.81,54.94 L 51.06,54.94 M 63.25,27.19 L 63.31,27.25 M 75.88,72.00 C 75.98,71.79 76.12,71.12 76.50,70.75 C 76.88,70.38 77.85,69.92 78.12,69.75 M 75.88,72.00 L 75.81,72.06 M 75.88,72.00 L 75.94,72.06 M 75.81,72.06 C 75.35,72.42 74.14,73.48 73.06,74.19 C 71.99,74.89 70.64,75.78 69.38,76.29 C 68.11,76.80 66.15,77.09 65.50,77.25 M 24.00,72.12 L 24.06,72.06 M 70.38,56.00 C 70.43,56.15 70.63,56.02 70.68,56.88 C 70.74,57.73 70.74,59.94 70.69,61.12 C 70.63,62.31 70.59,62.92 70.36,64.00 C 70.13,65.08 69.81,66.31 69.30,67.62 C 68.79,68.94 67.98,70.67 67.29,71.88 C 66.60,73.08 66.07,73.81 65.16,74.88 C 64.25,75.94 63.08,77.25 61.81,78.28 C 60.55,79.32 58.58,80.56 57.56,81.10 C 56.54,81.65 56.00,81.49 55.69,81.56 M 21.69,69.69 L 21.69,69.75 M 53.25,86.94 C 52.94,86.68 51.94,85.71 51.38,85.37 C 50.81,85.03 50.36,84.87 49.88,84.88 C 49.39,84.89 48.98,85.08 48.44,85.42 C 47.90,85.76 46.93,86.68 46.62,86.94 M 26.50,47.62 L 26.56,47.56 M 55.62,81.50 L 55.69,81.56 M 55.50,88.31 C 56.38,88.54 58.89,89.46 60.75,89.67 C 62.61,89.87 64.83,89.82 66.69,89.54 C 68.54,89.27 70.15,88.78 71.88,88.04 C 73.60,87.29 75.23,86.47 77.06,85.10 C 78.89,83.73 81.32,81.49 82.85,79.81 C 84.38,78.14 85.55,76.17 86.23,75.06 C 86.92,73.96 86.89,73.62 86.95,73.19 C 87.02,72.75 86.95,72.66 86.62,72.44 C 86.28,72.22 86.20,72.06 84.94,71.89 C 83.68,71.72 80.04,71.51 79.06,71.44 M 75.94,72.06 C 76.30,72.05 77.60,72.10 78.12,72.00 C 78.65,71.90 78.91,71.53 79.06,71.44 M 28.75,14.75 C 28.69,15.25 28.38,16.26 28.41,17.75 C 28.45,19.24 28.64,21.52 28.96,23.69 C 29.28,25.85 29.96,29.27 30.34,30.75 C 30.71,32.23 31.05,32.26 31.19,32.56 M 24.12,72.12 L 24.06,72.06 M 78.12,69.75 L 78.19,69.81 M 44.50,88.25 C 43.81,88.46 41.75,89.22 40.38,89.48 C 39.00,89.74 37.57,89.83 36.25,89.81 C 34.93,89.79 33.94,89.73 32.44,89.37 C 30.94,89.00 28.75,88.27 27.25,87.61 C 25.75,86.95 24.80,86.36 23.44,85.42 C 22.07,84.47 20.47,83.32 19.06,81.94 C 17.66,80.56 16.04,78.61 15.02,77.12 C 14.00,75.64 13.28,73.69 12.94,73.00 M 71.44,48.31 C 71.50,48.14 71.63,47.52 71.82,47.26 C 72.00,47.00 72.44,46.83 72.56,46.75 M 71.44,48.31 L 71.44,48.38 M 53.62,88.94 L 53.69,89.00 M 27.25,46.88 L 27.19,46.81 M 68.62,32.56 L 68.69,32.62 M 78.19,69.81 L 79.06,71.44 M 67.19,55.44 C 67.67,55.04 69.32,53.89 70.09,53.06 C 70.87,52.24 71.45,51.21 71.85,50.50 C 72.25,49.79 72.39,49.09 72.50,48.81 M 68.69,32.62 L 68.75,32.56 M 84.81,54.81 L 84.88,54.75 M 54.62,45.88 C 55.19,45.31 56.83,43.37 58.00,42.50 C 59.17,41.64 61.02,40.99 61.62,40.69 M 55.75,71.56 C 55.68,70.30 55.33,69.28 55.04,68.31 C 54.74,67.34 54.78,67.03 53.98,65.75 C 53.19,64.47 50.96,61.48 50.25,60.62 C 49.54,59.76 49.90,60.50 49.70,60.60 C 49.49,60.71 49.65,60.42 49.03,61.25 C 48.40,62.08 46.74,64.03 45.96,65.56 C 45.18,67.09 44.59,68.76 44.34,70.44 C 44.09,72.11 44.13,74.03 44.44,75.62 C 44.75,77.22 45.39,78.73 46.21,80.00 C 47.03,81.27 48.72,82.68 49.38,83.25 C 50.03,83.83 49.85,83.49 50.12,83.45 C 50.40,83.40 50.38,83.61 51.00,83.01 C 51.62,82.40 53.11,81.00 53.85,79.81 C 54.59,78.62 55.13,77.25 55.44,75.88 C 55.76,74.50 55.82,72.82 55.75,71.56 Z';
// The mono form strokes CAT_LOTUS_CENTERLINES (true centerline geometry), matching how
// buildShutter strokes the aperture icon; monoStrokeWidth is in viewBox units and can be
// tuned per surface. The colour variant paints the traced fill stack unchanged.
function buildCatLotus(monoStrokeWidth, wrapper) {
    const inner = monoStrokeWidth !== null
        ? `<path fill="none" stroke="currentColor" stroke-width="${monoStrokeWidth}" stroke-linecap="round" stroke-linejoin="round" d="${CAT_LOTUS_CENTERLINES}"/>`
        : CAT_LOTUS_LAYERS.map(([fill, d]) => `<path fill="${fill}" fill-rule="evenodd" d="${d}"/>`).join('');
    return wrapper(inner);
}
exports.CAT_LOTUS_FLOAT_MONO = buildCatLotus(2, inner => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid" style="width:60%;height:60%"><g>${inner}</g></svg>`);
exports.CAT_LOTUS_FLOAT_COLOR = buildCatLotus(null, inner => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid" style="width:60%;height:60%"><g>${inner}</g></svg>`);
exports.CAT_LOTUS_INPUT_BAR = buildCatLotus(3, inner => `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 100 100">${inner}</svg>`);
exports.ICON_SETS = {
    aperture: {
        label: 'Aperture',
        floatingMono: exports.ICON_FLOAT_MONO,
        floatingColor: exports.ICON_FLOAT_COLOR,
        inputBar: exports.ICON_INPUT_BAR,
    },
    cherry_blossom: {
        label: 'Cherry Blossom',
        floatingMono: exports.CHERRY_BLOSSOM_FLOAT_MONO,
        floatingColor: exports.CHERRY_BLOSSOM_FLOAT_COLOR,
        inputBar: exports.CHERRY_BLOSSOM_INPUT_BAR,
    },
    cat_lotus: {
        label: 'Kitty Lotus',
        floatingMono: exports.CAT_LOTUS_FLOAT_MONO,
        floatingColor: exports.CAT_LOTUS_FLOAT_COLOR,
        inputBar: exports.CAT_LOTUS_INPUT_BAR,
    },
};
function getIconSet(iconId) {
    return exports.ICON_SETS[iconId] ?? exports.ICON_SETS.aperture;
}

};

__modules["./lightbox"] = function(module, exports, require) {
"use strict";
// The lightbox prompt label: click-driven detection of the native image
// lightbox, caption-strip reservation, the body-level prompt pill, and all
// of its geometry/lifecycle machinery. Moved whole from frontend.ts —
// comments and all — because this is the most carefully-tuned code in the
// extension; see the inline notes before changing anything.
//
// Everything below closes over the deps passed to the factory:
//  - ctx            Spindle frontend context (dom, components, getActiveChat)
//  - comms          resolveShutterTag round-trip (comms.ts)
//  - getSettings    live settings (entry owns settings state)
//  - hasPermission  live granted-permissions lookup (entry owns the set)
//
// The entry calls sync() whenever settings or permissions change, and
// dispose() from its cleanup function.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLightboxPromptLabel = createLightboxPromptLabel;
const metadata_1 = require("./metadata");
const styles_1 = require("./styles");
const history_1 = require("./history");
function createLightboxPromptLabel(deps) {
    const { ctx, comms } = deps;
    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    // ── Lightbox prompt label (1.0.6) ──
    //
    // Shows the generation prompt below Shutter images opened in the native
    // image lightbox. Gated on the 'app_manipulation' permission and the
    // 'Show Prompt in Lightbox' setting, degrading silently without either
    // (same pattern as the interceptor feature).
    //
    // The native ImageLightbox uses build-hashed class names and no stable
    // component hook, so Shutter identifies lightbox images by matching them
    // back to a clicked chat image rendered from Shutter's ![shutter](...) markdown.
    //
    // Prompt sources:
    //   1. Shutter's durable generation record, when available.
    //   2. Provider-embedded PNG metadata from the original image
    //      (A1111/Forge 'parameters', NovelAI 'Comment'/'Description',
    //      ComfyUI workflow text — best effort).
    // Both are retained independently so the expanded view can switch between
    // exactly what Shutter submitted and what the provider embedded.
    // ── Lightbox detection and label injection ──
    //
    // Detection is click-driven: the only way a Shutter image reaches the
    // native lightbox is the user clicking its chat render, and that click is
    // itself proof of ownership (the handler only fires on img[alt="shutter"],
    // Shutter's stable markdown fingerprint). A short retry sweep then locates
    // the lightbox portal. A MutationObserver was tried first and dropped:
    // host builds can mount the lightbox img with an empty src and set it
    // post-insertion, which childList observation never sees.
    let lightboxWatcherActive = false;
    // Caption geometry, shared by the reserve rules and positionLabel.
    // Desktop prompt width is image-aware but clamped, so landscape images can
    // carry a wider label while portrait images still get a readable minimum.
    // Mobile is capped to image width once the image is laid out.
    //
    // RESERVE = strip height (panel + gap + edge). HYBRID model, decided per
    // image per state:
    //  - If the untouched, centered image already leaves a full strip below
    //    (free height ≤ V − 2R), it is left exactly where native centers it —
    //    no shift, no shrink. This is the common case on phones (width-bound
    //    images), zoomed-out windows, and small gens, where an unconditional
    //    shift bought nothing and read as a pointless nudge.
    //  - Only when the image is genuinely too tall does it pay: the cap is
    //    charged ONCE (V − R) with margin-block-end = reserve, so flex centers
    //    the outer box and the image shifts up rather than shrinking about its
    //    center — keeping ~R more height than a symmetric cap would. The
    //    deliberate, user-initiated shift was judged better than the smaller
    //    centered image (both were built and compared; the symmetric variant
    //    is in git history if the judgment ever flips).
    // The min(imageCase, boundCase) crossover in getPromptMaxHeight falls at
    // exactly the image height where the margin cap starts binding, so panel
    // sizing and mode selection share one boundary.
    const CAPTION_GAP = 8;
    const CAPTION_EDGE = 12;
    const PROMPT_DESKTOP_MIN_WIDTH = 520;
    const PROMPT_DESKTOP_MAX_WIDTH = 860;
    const PROMPT_MOBILE_MAX_WIDTH = 520;
    const PROMPT_MAX_HEIGHT = 156;
    const PROMPT_MOBILE_MAX_HEIGHT = 144;
    // Adaptive expanded-height caps (see getPromptMaxHeight); the *_MAX_HEIGHT
    // constants above remain as the floors so small screens keep the legacy
    // panel size exactly.
    const PROMPT_EXPANDED_MAX = 480;
    const PROMPT_MOBILE_EXPANDED_MAX = 260;
    const PROMPT_PILL_HEIGHT = 44;
    const PROMPT_PILL_DESKTOP_WIDTH = 360;
    const PROMPT_PILL_MOBILE_WIDTH = 320;
    // Seed value for the expanded reserve only — the live value is measured
    // from the panel's actual rendered height (content-aware) at expand time.
    const CAPTION_RESERVE = PROMPT_MAX_HEIGHT + CAPTION_GAP + CAPTION_EDGE; // 176
    const CAPTION_PILL_RESERVE = PROMPT_PILL_HEIGHT + CAPTION_GAP + CAPTION_EDGE; // 64
    // The host zooms every direct body child (`body > * { zoom: var(--lumiverse-ui-scale) }`,
    // reset.css), which includes both the native lightbox portal and our
    // body-injected pill. getBoundingClientRect / window.innerWidth report
    // VISUAL pixels, but any px length written inside the zoom layer renders
    // multiplied by the scale — so all geometry math is done in LOCAL (zoomed)
    // pixels: measurements are divided by the scale on the way in, and the
    // constants above (pill height/widths, prompt heights) are already local
    // px matching the stylesheet. Re-read per call: the user can change the
    // scale live in settings.
    function getUiScale() {
        const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale'));
        return Number.isFinite(raw) && raw > 0 ? raw : 1;
    }
    function isCompactPromptLayout() {
        return (window.innerWidth / getUiScale()) <= 560 ||
            (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
    }
    // The expanded panel is sized against the IMAGE, not the viewport: a
    // caption should read as subordinate to what it captions. Panel height ≤
    // PROMPT_IMAGE_RATIO × the image's rendered height. Two cases:
    //  - Image smaller than the viewport allows (zoomed-out windows, low-res
    //    gens): the image won't move, so the ratio applies to its current
    //    height directly. A viewport-relative rule fails exactly here — the
    //    panel would size against empty space and dwarf a small image.
    //  - Height-bound image: expanding shrinks the image, so k × (current
    //    height) would overshoot the final ratio. Solving the feedback —
    //    panel = k(V − gaps)/(1 + k) — lands at exactly k after the image
    //    yields the reserve, and recomputing post-shrink returns the same
    //    value (k·(V − R) = boundCase when R = boundCase + gaps), so the
    //    positioning passes are stable.
    // The floor keeps tiny viewports readable; the cap is a rare absolute
    // ceiling for enormous screens.
    const PROMPT_IMAGE_RATIO = 0.35;
    function getPromptMaxHeight(imgLocalHeight) {
        const localViewportH = window.innerHeight / getUiScale();
        const compact = isCompactPromptLayout();
        const floor = compact ? PROMPT_MOBILE_MAX_HEIGHT : PROMPT_MAX_HEIGHT;
        const cap = compact ? PROMPT_MOBILE_EXPANDED_MAX : PROMPT_EXPANDED_MAX;
        const k = PROMPT_IMAGE_RATIO;
        const boundCase = k * (localViewportH - CAPTION_GAP - CAPTION_EDGE) / (1 + k);
        const imageCase = imgLocalHeight && imgLocalHeight > 0 ? k * imgLocalHeight : Infinity;
        return Math.round(Math.min(Math.max(Math.min(boundCase, imageCase), floor), cap));
    }
    // iOS Safari/webviews compute `vh` against the LARGEST viewport (toolbars
    // ignored), inflating viewport-relative sizes on exactly the devices with
    // dynamic chrome. Prefer `dvh` where supported; stylesheet rules use
    // double declarations for the same fallback.
    const VIEWPORT_HEIGHT_UNIT = (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('height', '100dvh'))
        ? 'dvh'
        : 'vh';
    // Pre-reservation: a stylesheet rule applied AT CLICK TIME, before the
    // lightbox exists, capping any img that shows the clicked src. CSS binds
    // the instant the lightbox img mounts, so even a fully cached image lays
    // out with the caption strip already reserved — there is never a visible
    // resize. (It also matches the chat copy, where the cap is far above its
    // rendered size and therefore inert.) The inline max-block-size in
    // decorateLightbox remains as a backstop for builds that normalize the
    // lightbox URL away from the clicked src.
    let removeReserveStyle = null;
    function clearReserveStyle() {
        if (removeReserveStyle) {
            removeReserveStyle();
            removeReserveStyle = null;
        }
    }
    function applyReserveStyle(src) {
        clearReserveStyle();
        const escaped = src.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        removeReserveStyle = ctx.dom.addStyle(
        // Single reserve + bottom margin (see the caption geometry comment):
        // the margin shifts the centered image up so the whole reserve lands
        // below it — no doubled cap. The lightbox img lives inside the host's
        // `body > *` zoom layer, so the px lengths are LOCAL — the viewport
        // term must be too. The host pre-divides it as
        // --app-scaled-viewport-height (see reset.css); raw 100vh/100dvh
        // double declarations remain as fallbacks for builds without the var
        // (they are exact at scale 1). The var fallback uses the
        // feature-detected unit: an unsupported unit inside var() is invalid at
        // computed-value time and would void the declaration instead of falling
        // back to the earlier ones.
        `img[src="${escaped}"]:not([data-component="MessageContent"] img) { max-block-size: calc(100vh - ${CAPTION_PILL_RESERVE}px); max-block-size: calc(100dvh - ${CAPTION_PILL_RESERVE}px); max-block-size: calc(var(--app-scaled-viewport-height, 100${VIEWPORT_HEIGHT_UNIT}) - ${CAPTION_PILL_RESERVE}px); margin-block-end: ${CAPTION_PILL_RESERVE}px; }`);
    }
    // The one live label, with its tether and dismisser. A new decoration
    // dismisses the previous label unconditionally (unless it is the same
    // lightbox image, in which case the existing label stands) — so no
    // stale or mis-tethered label can ever block subsequent clicks.
    let activeLabel = null;
    function hasShutterClass(el) {
        // Token-prefix check, not substring: native CSS-module hashes could
        // coincidentally contain 'sh-'.
        for (const c of Array.from(el.classList)) {
            if (c.startsWith('sh-'))
                return true;
        }
        return false;
    }
    function findOpenLightbox(clickedSrc, expectedId) {
        // A lightbox render lives in a body-level, fixed full-viewport portal.
        // That lets us find it before the image has finished loading and before
        // it has a large measured rect. The previous version waited for a large,
        // visible image, which meant the metadata lookup could finish first and
        // skip the visible "Reading prompt…" shell entirely.
        function intersectsViewport(rect) {
            return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
        }
        function looksLikeNativePortal(root) {
            if (root.parentElement !== document.body)
                return false;
            if (hasShutterClass(root))
                return false;
            const rect = root.getBoundingClientRect();
            if (rect.width < window.innerWidth * 0.5 || rect.height < window.innerHeight * 0.5)
                return false;
            const pos = getComputedStyle(root).position;
            return pos === 'fixed' || pos === 'absolute';
        }
        function pick(match) {
            let best = null;
            for (const img of Array.from(document.images)) {
                if (!metadata_1.IMAGE_URL_RE.test(img.src))
                    continue;
                if (!match(img))
                    continue;
                if (img.closest('[data-component="MessageContent"]'))
                    continue;
                if (img.closest('.sh-lightbox, .sh-preview'))
                    continue;
                let portalRoot = img;
                while (portalRoot.parentElement && portalRoot.parentElement !== document.body) {
                    portalRoot = portalRoot.parentElement;
                }
                if (!looksLikeNativePortal(portalRoot))
                    continue;
                const rect = img.getBoundingClientRect();
                const area = rect.width * rect.height;
                const visible = area >= 10000 && intersectsViewport(rect);
                // Prefer the fully laid-out lightbox image, but accept the pre-load
                // <img> too so the loading shell can appear during the native spinner.
                const score = (visible ? 1000000000 : 0) + area;
                if (!best || score > best.score)
                    best = { portalRoot, img, score };
            }
            return best ? { portalRoot: best.portalRoot, img: best.img } : null;
        }
        const exact = pick(img => img.src === clickedSrc);
        if (exact)
            return exact;
        if (!expectedId)
            return null;
        return pick(img => (0, metadata_1.extractImageId)(img.src) === expectedId && !/[?&]size=/.test(img.src));
    }
    function waitMs(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    function nextFrame() {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }
    // Resolves once the lightbox image has finished downloading, decoding,
    // and holding a stable layout for a few frames. Mobile WebViews/Safari can
    // report `complete`/`load` while the visible image is still settling into
    // its final painted state, especially with large/progressive images. The
    // metadata fetch waits for this stricter gate so Shutter never competes
    // with the native viewer before the image feels visually done.
    async function waitForLightboxImageSettled(img) {
        if (!(img.complete && img.naturalWidth > 0)) {
            await new Promise((resolve) => {
                let interval = null;
                const done = () => {
                    img.removeEventListener('load', done);
                    img.removeEventListener('error', done);
                    if (interval !== null)
                        clearInterval(interval);
                    resolve();
                };
                img.addEventListener('load', done);
                img.addEventListener('error', done);
                interval = setInterval(() => {
                    if ((img.complete && img.naturalWidth > 0) || !img.isConnected)
                        done();
                }, 250);
            });
        }
        if (!img.isConnected)
            return;
        // `decode()` waits for the image to be ready for painting. It can reject
        // for cross-browser edge cases or if the image was detached; rejection is
        // non-fatal because the load/error gate above already did the bandwidth
        // protection work.
        try {
            if (typeof img.decode === 'function')
                await img.decode();
        }
        catch {
            // ignore decode failures; continue with frame/geometry settling
        }
        await nextFrame();
        await nextFrame();
        let stableFrames = 0;
        let last = null;
        const started = performance.now();
        const MAX_SETTLE_MS = 700;
        while (img.isConnected && performance.now() - started < MAX_SETTLE_MS) {
            const rect = img.getBoundingClientRect();
            const current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            if (current.width > 0 && current.height > 0 && last &&
                Math.abs(current.left - last.left) < 1 &&
                Math.abs(current.top - last.top) < 1 &&
                Math.abs(current.width - last.width) < 1 &&
                Math.abs(current.height - last.height) < 1) {
                stableFrames++;
                if (stableFrames >= 3)
                    break;
            }
            else {
                stableFrames = 0;
            }
            last = current;
            await nextFrame();
        }
        // A tiny paint cushion helps mobile browsers finish compositing the
        // decoded image before the prompt swap/fetch work begins. Keep desktop
        // almost unchanged; use the longer cushion only for coarse pointers.
        const isLikelyMobile = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
        await waitMs(isLikelyMobile ? 180 : 50);
        await nextFrame();
    }
    async function decorateLightbox(portalRoot, img, promptPromise) {
        if (activeLabel) {
            if (activeLabel.img === img && img.isConnected && document.querySelector('.sh-lightbox-prompt'))
                return;
            activeLabel.dismiss();
        }
        // The pill is injected unconditionally and immediately. An earlier
        // iteration raced promptPromise against a short grace window here so
        // already-settled metadata could skip the loading state — but the byte
        // fetch is gated on the image's visual-settle gate (decode + frame
        // stability + paint cushion), whose floor exceeds any sane grace window,
        // so the race could never be won and only added latency to every open.
        // Settled null (no readable metadata) is handled after the fact: the
        // pill dismisses cleanly via dismissLabel.
        // Reserve the caption strip NOW — the lightbox image is typically still
        // loading (hidden behind native's spinner), so it lays out already sized
        // with room below and is never visibly resized. max-block-size constrains
        // height ALONGSIDE the native class's own max-height (both caps apply;
        // the smaller wins), so native sizing is added to, never replaced.
        let promptExpanded = false;
        // Content-aware expanded reserve: measured from the panel's real rendered
        // height (clamped to the adaptive cap) by refreshExpandedReserve, so a
        // four-line prompt barely costs the image anything and only a genuinely
        // long prompt spends the full cap. CAPTION_RESERVE is just the seed.
        let expandedReserve = CAPTION_RESERVE;
        const originalMaxBlockSize = img.style.maxBlockSize;
        const originalMarginBlockEnd = img.style.marginBlockEnd;
        // px term of the inline cap currently applied (subtracted from the scaled
        // viewport). Used to tell whether the measured rect is our own cap
        // echoing back (rect ≈ V − term ⇒ free height unknown, assume bound)
        // versus the image's true free height (cap inert ⇒ rect is authoritative).
        let lastReserveCapTerm = null;
        const applyImageReserve = (expanded = promptExpanded) => {
            if (!img.isConnected)
                return;
            const reserve = expanded ? expandedReserve : CAPTION_PILL_RESERVE;
            const localViewportH = window.innerHeight / getUiScale();
            const rectH = img.getBoundingClientRect().height / getUiScale();
            const capBinding = lastReserveCapTerm !== null && rectH >= (localViewportH - lastReserveCapTerm) - 1;
            // Centered-fit test: the rect is a LOWER bound on the free height, so
            // it can only prove fitting when no cap of ours is binding. Unloaded
            // images (rect 0) default to bound, matching the click-time stylesheet.
            const centeredFits = rectH > 0 && !capBinding && rectH <= localViewportH - 2 * reserve;
            if (centeredFits) {
                // Native centering already leaves a full strip below — no shift, no
                // shrink. The symmetric cap stays on as an inert guarantee in case
                // anything resizes underneath us.
                img.style.maxBlockSize = `calc(var(--app-scaled-viewport-height, 100${VIEWPORT_HEIGHT_UNIT}) - ${reserve * 2}px)`;
                img.style.marginBlockEnd = originalMarginBlockEnd;
                lastReserveCapTerm = reserve * 2;
            }
            else {
                // Bound (or unknowable): single cap + bottom margin — the image
                // shifts up and keeps its size instead of shrinking about center.
                img.style.maxBlockSize = `calc(var(--app-scaled-viewport-height, 100${VIEWPORT_HEIGHT_UNIT}) - ${reserve}px)`;
                img.style.marginBlockEnd = `${reserve}px`;
                lastReserveCapTerm = reserve;
            }
        };
        applyImageReserve(false);
        // The click-time pre-reserve stylesheet is a module-level singleton; a
        // rapid follow-up click on another image swaps it before this label is
        // dismissed. Snapshot the remover installed for THIS image so teardown
        // never clears a successor's rule.
        const ownedReserveRemover = removeReserveStyle;
        const clearOwnedReserveStyle = () => {
            if (ownedReserveRemover && removeReserveStyle === ownedReserveRemover)
                clearReserveStyle();
        };
        // Releasing the caption reserve has two shapes, matching the two ways a
        // label dies:
        //  - 'now' (prompt hidden via its own ✕, viewer stays open): the strip is
        //    gone, so the image should reclaim the space immediately.
        //  - 'after-close' (the NATIVE VIEWER is closing: backdrop tap, Escape,
        //    route change, portal unmount): the image is about to disappear —
        //    restoring its size first makes it visibly grow for the duration of
        //    the close animation. Leave the cap in place, and release state once
        //    the img actually disconnects. If the close never lands (e.g. Escape
        //    was consumed by a nested dialog), a short grace timeout restores the
        //    size then — at that point the grow-back is correct, the prompt is gone.
        const restoreImageInlineStyles = () => {
            if (!img.isConnected)
                return;
            img.style.maxBlockSize = originalMaxBlockSize;
            img.style.marginBlockEnd = originalMarginBlockEnd;
        };
        const restoreReserve = (mode) => {
            if (mode === 'now') {
                restoreImageInlineStyles();
                clearOwnedReserveStyle();
                return;
            }
            const SETTLE_TIMEOUT_MS = 500;
            let settled = false;
            const finish = (restoreImage) => {
                if (settled)
                    return;
                settled = true;
                settleWatcher.disconnect();
                clearTimeout(settleTimer);
                if (restoreImage)
                    restoreImageInlineStyles();
                clearOwnedReserveStyle();
            };
            // subtree: the img can disconnect via an intermediate container, not
            // only via the body-level portal's removal.
            const settleWatcher = new MutationObserver(() => { if (!img.isConnected)
                finish(false); });
            settleWatcher.observe(document.body, { childList: true, subtree: true });
            const settleTimer = setTimeout(() => finish(img.isConnected), SETTLE_TIMEOUT_MS);
            if (!img.isConnected)
                finish(false);
        };
        // NOTE: an earlier iteration force-elevated the native portal's z-index
        // (to 2147483645, with isolation) while the prompt was open, to stop the
        // background chat layer from momentarily painting over the lightbox
        // during nested scroll gestures. The boundary wheel/touch containment on
        // the scroll region below addresses the CAUSE of that artifact — scroll
        // gestures can no longer chain into the chat, so its layer never repaints
        // mid-gesture — and the elevation buried host toasts behind the portal
        // for the prompt's lifetime. If the paint-over artifact ever reappears,
        // re-adding the elevation here is the known workaround.
        // Shared markup for the resolved label — used both by the fast path
        // (metadata settled before decoration) and the shell's in-place swap.
        // Function declaration so it hoists above the injection below. Builds
        // only the swappable body — the heading (title, copy button, and the
        // shared close-button slot) lives OUTSIDE .sh-lightbox-prompt-content
        // so the host-mounted close button and the copy listener survive the
        // shell → prompt swap without any destroy/remount or rewiring.
        function bodyContentHtml(view, sources) {
            const selector = sources.shutter && sources.embedded
                ? `<div class="sh-prompt-source-tabs" role="tablist" aria-label="Prompt metadata source">
            <button type="button" class="sh-prompt-source-btn${view.source === 'shutter' ? ' sh-active' : ''}" data-source="shutter" role="tab" aria-selected="${view.source === 'shutter'}">Shutter</button>
            <button type="button" class="sh-prompt-source-btn${view.source === 'embedded' ? ' sh-active' : ''}" data-source="embedded" role="tab" aria-selected="${view.source === 'embedded'}">Embedded</button>
          </div>`
                : '';
            const details = (0, history_1.formatPromptMetadataLine)(view);
            const negativeBlock = view.negativePrompt
                ? `<div class="sh-lightbox-prompt-heading">Negative Prompt</div><div class="sh-lightbox-prompt-text">${escapeHtml(view.negativePrompt)}</div>`
                : '';
            return `${selector}<div class="sh-prompt-source-meta">${escapeHtml(details)}</div><div class="sh-lightbox-prompt-text">${escapeHtml(view.prompt)}</div>${negativeBlock}`;
        }
        // Inject a stable shell immediately — or, when metadata already settled,
        // the finished label directly. The shell avoids the jarring delayed box
        // pop-in while metadata is fetched/parsing, without blocking the native
        // lightbox image or storing any prompt data. The ✕ is Lumiverse's shared
        // close button and the loading indicator its shared spinner, mounted
        // into the slot spans below so the label tracks native design.
        //
        // BODY-LEVEL ON PURPOSE — do not move this back inside the portal. In
        // glass mode the native backdrop carries backdrop-filter: blur(), and in
        // Chromium ANY painting inside a backdrop-filtered subtree (scrolling
        // this label, its scrollbar, opacity transitions) forces the filter
        // surface to re-capture — which intermittently drops the blur for a
        // frame, flashing the unblurred chat through. Injecting the label as a
        // body-level sibling of the portal keeps its painting out of the filter
        // surface entirely. app_manipulation covers body-level portals, and the
        // label is position:fixed, so geometry is unaffected.
        const wrapper = ctx.dom.inject(document.body, `
      <div class="sh-lightbox-prompt sh-pill sh-loading" aria-live="polite">
        <div class="sh-lightbox-prompt-heading">
          <span class="sh-lightbox-prompt-status"><span class="sh-lightbox-prompt-spinner-slot" aria-hidden="true"></span><span>Reading prompt…</span></span>
          <span class="sh-lightbox-prompt-actions">
            <button class="sh-lightbox-prompt-history" type="button" title="View generation history" aria-label="View generation history" hidden disabled>History</button>
            <button class="sh-lightbox-prompt-view" type="button" title="View prompt" aria-label="View prompt" hidden disabled>Prompt</button>
            <button class="sh-lightbox-prompt-collapse" type="button" title="Collapse prompt" aria-label="Collapse prompt" hidden disabled>Collapse</button>
            <button class="sh-lightbox-prompt-copy" type="button" title="Copy prompt" aria-label="Copy prompt" hidden disabled>Copy</button>
            <span class="sh-lightbox-prompt-close-slot"></span>
          </span>
        </div>
        <div class="sh-lightbox-prompt-scroll" hidden>
          <div class="sh-lightbox-prompt-content"></div>
        </div>
      </div>
    `, 'beforeend');
        // Placement is measured, not laid out: the label is fixed-positioned to
        // the lightbox image's bounding rect — directly below it, at its width —
        // so it is independent of how any host build structures the portal. A
        // periodic tick re-measures (covering image load, zoom, and window
        // changes) and doubles as the lifecycle tether: some host builds mount
        // the lightbox inside a persistent overlay container, so DOM ancestry
        // can't be trusted for lifetime — but the lightbox <img> disconnecting
        // is definitive. If the gap under the image is too small for a minimum
        // caption strip, the image's max-height is shaved just enough to create
        // one, and restored on dismiss.
        const ws = wrapper.style;
        ws.position = 'fixed';
        // Same z-index as the native backdrop (10003): as a LATER body sibling
        // the label paints above the backdrop by document order, while host
        // layers at 10004+ (menus, dialogs, toasts) still cover it.
        ws.zIndex = '10003';
        let labelEl = wrapper.querySelector('.sh-lightbox-prompt');
        // Body-level injection means the portal's unmount no longer removes the
        // wrapper for us, and the lifecycle tick is a slow 1s fallback — without
        // this, a dismissed lightbox would leave the label floating over the
        // chat for up to a second. Watching body childList catches the portal's
        // removal the moment it happens.
        const portalWatcher = new MutationObserver(() => {
            if (!portalRoot.isConnected || !img.isConnected) {
                dismissLabel();
                return;
            }
            // The label paints above the backdrop purely by DOCUMENT ORDER (same
            // z-index, later body sibling). If the host re-appends/remounts the
            // portal after us — menus, confirm dialogs, and React remounts can —
            // that invariant silently flips and the backdrop buries the pill.
            // Moving the wrapper back to the end restores it: a move preserves
            // listeners, inline styles, and the host-mounted close button/spinner,
            // and only fires when order is actually wrong, so the mutation this
            // move itself triggers can't loop.
            if (wrapper.isConnected && (wrapper.compareDocumentPosition(portalRoot) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                document.body.appendChild(wrapper);
            }
        });
        portalWatcher.observe(document.body, { childList: true });
        function setStyleIfChanged(style, prop, value) {
            if (style.getPropertyValue(prop) !== value) {
                style.setProperty(prop, value);
            }
        }
        const GAP = CAPTION_GAP;
        const EDGE = CAPTION_EDGE;
        const MIN_LOADING_MS = 220;
        const shellShownAt = performance.now();
        const cleanupFns = [];
        cleanupFns.push(() => portalWatcher.disconnect());
        let dismissed = false;
        let promptSources = null;
        let resolvedPrompt = null;
        const promptEl = labelEl;
        const scrollEl = wrapper.querySelector('.sh-lightbox-prompt-scroll');
        const contentEl = wrapper.querySelector('.sh-lightbox-prompt-content');
        const statusEl = wrapper.querySelector('.sh-lightbox-prompt-status');
        const historyBtn = wrapper.querySelector('.sh-lightbox-prompt-history');
        const viewBtn = wrapper.querySelector('.sh-lightbox-prompt-view');
        const collapseBtn = wrapper.querySelector('.sh-lightbox-prompt-collapse');
        let suppressPositionUntil = 0;
        const suppressPositionBriefly = () => {
            suppressPositionUntil = performance.now() + 180;
        };
        // 'closing' is the default on purpose: every dismissal except the pill's
        // own ✕ is a teardown where the native viewer is going (or already gone)
        // away, and eagerly restoring the image size there is exactly the
        // grow-then-vanish flash. restoreReserve('after-close') handles the "the
        // close never actually landed" edge with its grace timeout.
        function dismissLabel(reason = 'closing') {
            if (dismissed)
                return;
            dismissed = true;
            if (activeLabel && activeLabel.dismiss === dismissLabel)
                activeLabel = null;
            for (const fn of cleanupFns)
                fn();
            restoreReserve(reason === 'hide' ? 'now' : 'after-close');
            ctx.dom.uninject(wrapper);
        }
        activeLabel = { img, dismiss: dismissLabel };
        // Body-level injection means the prompt no longer disappears just
        // because the native portal starts its close animation. On mobile that
        // can leave the prompt visually trailing the viewer by a beat, so remove
        // it on the same user action that is likely to close the native viewer
        // instead of waiting for the DOM-removal watcher or lifecycle tether.
        const dismissOnNativeCloseInteraction = (event) => {
            if (dismissed)
                return;
            const target = event.target;
            if (!target)
                return;
            if (wrapper.contains(target))
                return;
            if (!portalRoot.isConnected || !img.isConnected) {
                dismissLabel();
                return;
            }
            if (!portalRoot.contains(target))
                return;
            const targetEl = target instanceof Element ? target : target.parentElement;
            if (!targetEl)
                return;
            // Tapping the image itself should keep the prompt.
            const touchedImage = targetEl.closest?.('img');
            if (touchedImage && touchedImage === img)
                return;
            // Only a tap on the backdrop itself closes the native viewer — and the
            // backdrop is recognizable as the element that CONTAINS the image (it
            // is the flex container centering it). Menu items and confirm-dialog
            // buttons live inside the portal but are NOT ancestors of the image,
            // so interacting with them no longer dismisses the prompt. Closes
            // triggered from inside those layers (e.g. delete → confirm) are
            // caught by the Escape/route listeners and the portal state watcher.
            if (!targetEl.contains(img))
                return;
            dismissLabel();
        };
        const dismissOnEscape = (event) => {
            if (event.key === 'Escape')
                dismissLabel();
        };
        const dismissOnRouteClose = () => dismissLabel();
        document.addEventListener('pointerdown', dismissOnNativeCloseInteraction, true);
        document.addEventListener('touchstart', dismissOnNativeCloseInteraction, true);
        document.addEventListener('mousedown', dismissOnNativeCloseInteraction, true);
        document.addEventListener('click', dismissOnNativeCloseInteraction, true);
        document.addEventListener('keydown', dismissOnEscape, true);
        window.addEventListener('popstate', dismissOnRouteClose);
        window.addEventListener('hashchange', dismissOnRouteClose);
        cleanupFns.push(() => {
            document.removeEventListener('pointerdown', dismissOnNativeCloseInteraction, true);
            document.removeEventListener('touchstart', dismissOnNativeCloseInteraction, true);
            document.removeEventListener('mousedown', dismissOnNativeCloseInteraction, true);
            document.removeEventListener('click', dismissOnNativeCloseInteraction, true);
            document.removeEventListener('keydown', dismissOnEscape, true);
            window.removeEventListener('popstate', dismissOnRouteClose);
            window.removeEventListener('hashchange', dismissOnRouteClose);
        });
        const portalStateWatcher = new MutationObserver(() => {
            requestAnimationFrame(() => {
                if (dismissed)
                    return;
                if (!portalRoot.isConnected || !img.isConnected) {
                    dismissLabel();
                    return;
                }
                if (portalRoot instanceof HTMLElement) {
                    const computed = getComputedStyle(portalRoot);
                    if (computed.display === 'none' || computed.visibility === 'hidden' || Number(computed.opacity) <= 0.01) {
                        dismissLabel();
                    }
                }
            });
        });
        portalStateWatcher.observe(portalRoot, { attributes: true, attributeFilter: ['class', 'style', 'aria-hidden', 'data-state'] });
        cleanupFns.push(() => portalStateWatcher.disconnect());
        // Pure placement: the caption strip was reserved before the image became
        // visible, so this never writes to the image. It keeps the label glued to
        // the image's measured rect while sizing it with an image-aware desktop
        // width and a stable mobile width.
        function positionLabel() {
            if (!img.isConnected || !wrapper.isConnected) {
                dismissLabel();
                return;
            }
            if (performance.now() < suppressPositionUntil)
                return;
            const rect = img.getBoundingClientRect();
            // gBCR and window.innerWidth report VISUAL pixels, but every px we
            // write below is interpreted inside the host's `body > *` zoom layer
            // (LOCAL pixels, multiplied by --lumiverse-ui-scale on render). Convert
            // the measurements once; the PROMPT_*/PILL_* constants are already
            // local px matching the stylesheet, so the rest of the math needs no
            // per-site adjustment. At scale 1 this is a no-op.
            const uiScale = getUiScale();
            const rectLeft = rect.left / uiScale;
            const rectBottom = rect.bottom / uiScale;
            const rectWidth = rect.width / uiScale;
            const rectHeight = rect.height / uiScale;
            const viewportWidthLocal = window.innerWidth / uiScale;
            const isExpanded = labelEl?.classList.contains('sh-expanded') ?? promptExpanded;
            const promptMaxHeight = isExpanded ? getPromptMaxHeight(rectHeight > 0 ? rectHeight : undefined) : PROMPT_PILL_HEIGHT;
            const isCompact = isCompactPromptLayout();
            const viewportMax = viewportWidthLocal - EDGE * 2;
            const expandedWidth = rect.width === 0 || rect.height === 0
                ? (isCompact
                    ? Math.min(PROMPT_MOBILE_MAX_WIDTH, viewportMax)
                    : Math.min(PROMPT_DESKTOP_MIN_WIDTH, viewportMax))
                : (isCompact
                    ? Math.min(rectWidth, PROMPT_MOBILE_MAX_WIDTH, viewportMax)
                    : Math.min(Math.max(rectWidth, PROMPT_DESKTOP_MIN_WIDTH), PROMPT_DESKTOP_MAX_WIDTH, viewportMax));
            // Restore the stable 1.0.6 collapsed width so different action
            // combinations and the temporary Copied state never resize the bar.
            // Expanded prompt sizing remains image-aware.
            const collapsedWidth = Math.min(isCompact ? PROMPT_PILL_MOBILE_WIDTH : PROMPT_PILL_DESKTOP_WIDTH, viewportMax);
            const toolbarWidth = isExpanded ? expandedWidth : collapsedWidth;
            setStyleIfChanged(ws, 'width', `${toolbarWidth}px`);
            setStyleIfChanged(ws, 'min-width', '0px');
            setStyleIfChanged(ws, 'max-width', `${viewportMax}px`);
            if (rect.width === 0 || rect.height === 0) {
                // Native lightbox mounts the <img> before it has natural dimensions.
                // Keep the loading shell visible near the spinner until the image has
                // a real rect, then snap it under the image.
                setStyleIfChanged(ws, 'top', 'calc(50% + 48px)');
                setStyleIfChanged(ws, 'left', '50%');
                setStyleIfChanged(ws, 'transform', 'translateX(-50%)');
                if (labelEl) {
                    setStyleIfChanged(labelEl.style, 'max-height', `${promptMaxHeight}px`);
                }
                return;
            }
            const measuredWidth = toolbarWidth;
            const left = Math.max(EDGE, Math.min(rectLeft + (rectWidth - measuredWidth) / 2, viewportWidthLocal - measuredWidth - EDGE));
            setStyleIfChanged(ws, 'top', `${rectBottom + GAP}px`);
            setStyleIfChanged(ws, 'left', `${left}px`);
            setStyleIfChanged(ws, 'transform', '');
            if (labelEl) {
                setStyleIfChanged(labelEl.style, 'max-height', `${promptMaxHeight}px`);
            }
        }
        // Coalesce all triggers into one measurement per frame.
        let rafId = 0;
        function schedulePosition() {
            if (rafId)
                return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                positionLabel();
            });
        }
        cleanupFns.push(() => { if (rafId)
            cancelAnimationFrame(rafId); });
        // Frame-accurate tracking of the image's rect (load, native responsive
        // sizing, the CSS cap responding to window resizes). The slow tick is
        // purely the lifecycle tether for host builds with persistent overlay
        // containers.
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(schedulePosition);
            ro.observe(img);
            cleanupFns.push(() => ro.disconnect());
        }
        const lifecycleTick = setInterval(() => {
            if (!img.isConnected || !wrapper.isConnected)
                dismissLabel();
            else
                schedulePosition();
        }, 1000);
        cleanupFns.push(() => clearInterval(lifecycleTick));
        // Resize changes the adaptive expanded cap (viewport-fraction) and moves
        // the hybrid centered/bound boundary — re-measure and re-apply the image
        // reserve in BOTH states before the scheduled reposition reads the image
        // rect. refreshExpandedReserve is hoisted (declared below).
        const onWindowResize = () => {
            if (promptExpanded)
                refreshExpandedReserve();
            applyImageReserve();
            schedulePosition();
        };
        window.addEventListener('resize', onWindowResize);
        cleanupFns.push(() => window.removeEventListener('resize', onWindowResize));
        // The hybrid mode decision needs real dimensions: before load the rect is
        // 0 and the reserve defaults to bound (margin model, matching the
        // click-time stylesheet). Re-decide the moment dimensions exist — the
        // native viewer keeps the img at opacity 0 until load, so a correction
        // here lands before the reveal.
        const onImgLoad = () => {
            applyImageReserve();
            schedulePosition();
        };
        img.addEventListener('load', onImgLoad);
        cleanupFns.push(() => img.removeEventListener('load', onImgLoad));
        positionLabel();
        // The lightbox closes on backdrop click; interactions with the label
        // (selecting/copying text, scrolling) must not bubble into that handler.
        // Wheel/touchmove are non-passive so boundary gestures are consumed
        // instead of scroll-chaining into the background virtualized chat, which
        // can provoke Chrome to repaint that chat layer over the lightbox.
        const stopLabelEvent = (event) => event.stopPropagation();
        for (const eventName of ['click', 'pointerdown', 'mousedown', 'touchstart']) {
            wrapper.addEventListener(eventName, stopLabelEvent, { passive: true });
        }
        // Event (not WheelEvent/TouchEvent): `wrapper` is typed Element, whose
        // addEventListener overloads reject narrower handler signatures — and
        // stopPropagation is all these need.
        wrapper.addEventListener('wheel', stopLabelEvent, { passive: false });
        wrapper.addEventListener('touchmove', stopLabelEvent, { passive: false });
        if (scrollEl) {
            let lastTouchY = null;
            const consumeBoundaryWheel = (event) => {
                suppressPositionBriefly();
                event.stopPropagation();
                const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
                if (maxScrollTop <= 0) {
                    event.preventDefault();
                    return;
                }
                const atTop = scrollEl.scrollTop <= 0;
                const atBottom = scrollEl.scrollTop >= maxScrollTop - 1;
                if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
                    event.preventDefault();
                }
            };
            const rememberTouchY = (event) => {
                stopLabelEvent(event);
                lastTouchY = event.touches[0]?.clientY ?? null;
            };
            const consumeBoundaryTouchMove = (event) => {
                suppressPositionBriefly();
                event.stopPropagation();
                const y = event.touches[0]?.clientY ?? null;
                if (y === null || lastTouchY === null) {
                    lastTouchY = y;
                    return;
                }
                const deltaY = lastTouchY - y;
                lastTouchY = y;
                const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
                if (maxScrollTop <= 0) {
                    event.preventDefault();
                    return;
                }
                const atTop = scrollEl.scrollTop <= 0;
                const atBottom = scrollEl.scrollTop >= maxScrollTop - 1;
                if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
                    event.preventDefault();
                }
            };
            scrollEl.addEventListener('scroll', suppressPositionBriefly, { passive: true });
            scrollEl.addEventListener('wheel', consumeBoundaryWheel, { passive: false });
            scrollEl.addEventListener('touchstart', rememberTouchY, { passive: true });
            scrollEl.addEventListener('touchmove', consumeBoundaryTouchMove, { passive: false });
            scrollEl.addEventListener('touchend', () => { lastTouchY = null; }, { passive: true });
            scrollEl.addEventListener('touchcancel', () => { lastTouchY = null; }, { passive: true });
        }
        // Measure what the expanded panel ACTUALLY uses and reserve exactly that.
        // Requires the expanded classes and content to be in the DOM already, so
        // call sites toggle state first, refresh second, applyImageReserve third.
        // Function declaration on purpose: the resize handler above registers
        // before this point in source order and relies on hoisting.
        function refreshExpandedReserve() {
            if (!promptEl)
                return;
            // Size the cap against the image itself (see getPromptMaxHeight). For
            // height-bound images the pill-state height feeds the min() but the
            // solved bound-case term wins, so pre- vs post-shrink measurement
            // yields the same cap — no oscillation.
            const imgLocalH = img.isConnected ? img.getBoundingClientRect().height / getUiScale() : 0;
            const maxH = getPromptMaxHeight(imgLocalH > 0 ? imgLocalH : undefined);
            setStyleIfChanged(promptEl.style, 'max-height', `${maxH}px`);
            // offsetHeight is border-box (host resets to border-box globally), so
            // this is the panel's full rendered height, already clamped by maxH.
            expandedReserve = Math.min(promptEl.offsetHeight, maxH) + CAPTION_GAP + CAPTION_EDGE;
        }
        function renderPromptSource(view) {
            if (!contentEl || !promptSources)
                return;
            resolvedPrompt = view;
            contentEl.innerHTML = bodyContentHtml(view, promptSources);
            contentEl.querySelectorAll('.sh-prompt-source-btn').forEach(button => {
                button.addEventListener('click', () => {
                    const next = button.dataset.source === 'embedded'
                        ? promptSources?.embedded
                        : promptSources?.shutter;
                    if (!next || next.source === resolvedPrompt?.source)
                        return;
                    renderPromptSource(next);
                    if (scrollEl)
                        scrollEl.scrollTop = 0;
                    if (promptExpanded) {
                        refreshExpandedReserve();
                        applyImageReserve(true);
                        suppressPositionUntil = 0;
                        positionLabel();
                    }
                });
            });
        }
        const openHistoryFromToolbar = () => {
            if (!promptSources || promptSources.history.length === 0 || !promptSources.imageId)
                return;
            // The history viewer is a Spindle modal layered above Lumiverse's
            // native image lightbox. Insert/Replace should commit the selected
            // image and then close that exact underlying viewer as one action.
            // Capture this portal/image pair so a delayed close can never affect
            // a different lightbox opened afterwards.
            const closeUnderlyingLightbox = () => {
                if (!portalRoot.isConnected || !img.isConnected)
                    return;
                dismissLabel();
                setTimeout(() => {
                    if (!portalRoot.isConnected || !img.isConnected)
                        return;
                    document.dispatchEvent(new KeyboardEvent('keydown', {
                        key: 'Escape',
                        code: 'Escape',
                        bubbles: true,
                        cancelable: true,
                    }));
                }, 0);
            };
            deps.openHistory(promptSources.history, promptSources.imageId, closeUnderlyingLightbox);
        };
        historyBtn?.addEventListener('click', openHistoryFromToolbar);
        function setPromptExpanded(expanded) {
            if (!promptEl || !contentEl || !scrollEl || !resolvedPrompt)
                return;
            promptExpanded = expanded;
            promptEl.classList.toggle('sh-pill', !expanded);
            promptEl.classList.toggle('sh-expanded', expanded);
            scrollEl.hidden = !expanded;
            if (statusEl)
                statusEl.hidden = true;
            if (viewBtn) {
                viewBtn.hidden = expanded;
                viewBtn.disabled = expanded;
            }
            if (collapseBtn) {
                collapseBtn.hidden = !expanded;
                collapseBtn.disabled = !expanded;
            }
            if (expanded)
                refreshExpandedReserve();
            applyImageReserve(expanded);
            // Synchronous, not scheduled: the class toggles above and the image's
            // new reserve just changed layout in THIS frame — waiting a rAF leaves
            // one visible frame of expanded content clipped inside 44px pill
            // geometry (and the image jumping a frame ahead of the panel).
            // positionLabel's gBCR forces layout, so it reads the post-reserve
            // rect. Scroll suppression is cleared first: a touch-scroll followed
            // within 180ms by a Collapse tap must still reposition.
            suppressPositionUntil = 0;
            positionLabel();
        }
        viewBtn?.addEventListener('click', () => setPromptExpanded(true));
        collapseBtn?.addEventListener('click', () => setPromptExpanded(false));
        // Heading chrome is stable across the shell → prompt swap (only
        // .sh-lightbox-prompt-content is replaced), so copy is wired exactly
        // once and the host-mounted close button is never torn down mid-life.
        const copyBtn = wrapper.querySelector('.sh-lightbox-prompt-copy');
        copyBtn?.addEventListener('click', () => {
            if (!copyBtn || !resolvedPrompt)
                return;
            const text = (0, history_1.formatPromptMetadataForClipboard)(resolvedPrompt);
            // Mirrors native's code-copy confirmation: label swap + success color
            // for 2000ms, with a checkmark inheriting the success color.
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.innerHTML = `${styles_1.COPY_CHECK_SVG} Copied`;
                copyBtn.classList.add('sh-copied');
                setTimeout(() => {
                    if (!copyBtn.isConnected)
                        return;
                    copyBtn.textContent = 'Copy';
                    copyBtn.classList.remove('sh-copied');
                }, 2000);
            }).catch(() => {
                copyBtn.textContent = 'Failed';
                setTimeout(() => { if (copyBtn.isConnected)
                    copyBtn.textContent = 'Copy'; }, 1200);
            });
        });
        // Shared components (native design parity). destroy() unmounts the
        // component but leaves the slot spans in place, so cleanup is safe in
        // any order relative to ctx.dom.uninject(wrapper).
        const closeSlot = wrapper.querySelector('.sh-lightbox-prompt-close-slot');
        const closeButtonHandle = closeSlot
            // The one 'hide' dismissal: the viewer stays open, so the image should
            // reclaim the caption space immediately. Wrapped so the handler's click
            // event can't be forwarded into dismissLabel's reason parameter.
            ? ctx.components.mountCloseButton(closeSlot, { onClick: () => dismissLabel('hide'), size: 'sm', variant: 'subtle', ariaLabel: 'Hide prompt' })
            : null;
        if (closeButtonHandle)
            cleanupFns.push(() => closeButtonHandle.destroy());
        // Spinner lives inside the swappable content region, so it is destroyed
        // explicitly before the swap replaces its DOM (and via cleanup if the
        // label is dismissed while still loading). Nullable guard keeps the two
        // destruction paths from double-destroying.
        const spinnerSlot = wrapper.querySelector('.sh-lightbox-prompt-spinner-slot');
        let spinnerHandle = spinnerSlot
            ? ctx.components.mountSpinner(spinnerSlot, { size: 12, fast: true })
            : null;
        const destroySpinner = () => {
            spinnerHandle?.destroy();
            spinnerHandle = null;
        };
        cleanupFns.push(destroySpinner);
        // Resolution was kicked off at click time, in parallel with the lightbox
        // opening. The already-mounted shell is updated in place when metadata
        // arrives; if no readable metadata exists, it is removed cleanly.
        const resolved = await promptPromise;
        const loadingElapsed = performance.now() - shellShownAt;
        if (loadingElapsed < MIN_LOADING_MS) {
            await new Promise(resolve => setTimeout(resolve, MIN_LOADING_MS - loadingElapsed));
        }
        if (dismissed)
            return;
        if (!portalRoot.isConnected || !img.isConnected || !wrapper.isConnected) {
            dismissLabel();
            return;
        }
        if (!resolved || (!resolved.shutter && !resolved.embedded)) {
            // No saved or readable embedded metadata but the viewer is still open:
            // the pill leaves quietly and the image reclaims the strip immediately.
            dismissLabel('hide');
            return;
        }
        promptSources = resolved;
        resolvedPrompt = resolved.shutter ?? resolved.embedded;
        if (!promptEl || !contentEl || !scrollEl || !resolvedPrompt) {
            dismissLabel();
            return;
        }
        promptEl.classList.add('sh-swapping');
        await new Promise(resolve => setTimeout(resolve, 120));
        if (dismissed || !promptEl.isConnected)
            return;
        destroySpinner();
        promptEl.classList.remove('sh-loading');
        promptEl.classList.add('sh-ready', 'sh-pill');
        promptEl.classList.remove('sh-expanded');
        renderPromptSource(resolvedPrompt);
        scrollEl.hidden = true;
        if (statusEl)
            statusEl.hidden = true;
        if (historyBtn) {
            historyBtn.hidden = resolved.history.length === 0;
            historyBtn.disabled = resolved.history.length === 0;
            historyBtn.textContent = resolved.history.length > 0
                ? `History · ${resolved.history.length}`
                : 'History';
        }
        if (viewBtn) {
            viewBtn.hidden = false;
            viewBtn.disabled = false;
        }
        if (collapseBtn) {
            collapseBtn.hidden = true;
            collapseBtn.disabled = true;
        }
        if (copyBtn) {
            copyBtn.hidden = false;
            copyBtn.disabled = false;
        }
        promptExpanded = false;
        applyImageReserve(false);
        promptEl.classList.remove('sh-swapping');
        labelEl = promptEl;
        schedulePosition();
    }
    function onDocumentClick(e) {
        if (!lightboxWatcherActive)
            return;
        const target = e.target;
        const img = target?.closest?.('img[alt="shutter"]');
        if (!img)
            return;
        if (img.closest('.sh-lightbox, .sh-preview'))
            return;
        // Resolve the authoritative tag from the message markdown, in parallel
        // with the lightbox opening. The clicked image's position among the
        // message's Shutter images maps it to the matching markdown tag.
        const messageId = ctx.dom.getMessageId(img);
        const chatId = ctx.getActiveChat()?.chatId;
        let index = 0;
        if (messageId) {
            const bubble = ctx.dom.findMessageElement(messageId);
            if (bubble) {
                const siblings = Array.from(bubble.querySelectorAll('img[alt="shutter"]'));
                const found = siblings.indexOf(img);
                if (found >= 0)
                    index = found;
            }
        }
        const clickedId = (0, metadata_1.extractImageId)(img.src);
        applyReserveStyle(img.src);
        const tagPromise = (messageId && chatId)
            ? comms.resolveShutterTag(chatId, messageId, index)
            : Promise.resolve(null);
        // Start the small userStorage lookup immediately. Embedded metadata still
        // waits for the native image to settle so it cannot compete with the
        // lightbox's image download on constrained mobile connections.
        const recordPromise = tagPromise.then(tag => {
            const imageId = tag?.imageId ?? clickedId;
            return imageId ? comms.getGenerationRecord(imageId) : Promise.resolve(null);
        });
        const historyPromise = recordPromise.then(record => record ? comms.getGenerationHistory(record.target) : Promise.resolve([]));
        // The tag round-trip starts NOW (Spindle message channel — no HTTP
        // contention), but the metadata BYTE fetch is gated on the lightbox
        // image finishing download/decode/visual settling: both requests pull
        // large originals over the same connection pool, and racing them can
        // visibly stall the native image on slow links. The loading shell covers
        // the gate.
        const clickedSrc = img.src;
        let attempts = 0;
        let located = false;
        let retryTimer = null;
        let mountWatcher = null;
        const stopLooking = () => {
            if (retryTimer !== null)
                clearTimeout(retryTimer);
            retryTimer = null;
            mountWatcher?.disconnect();
            mountWatcher = null;
        };
        const tryLocate = () => {
            if (located)
                return true;
            const found = findOpenLightbox(clickedSrc, clickedId);
            if (!found)
                return false;
            located = true;
            stopLooking();
            const promptPromise = Promise.all([tagPromise, waitForLightboxImageSettled(found.img)])
                .then(async ([tag]) => {
                const [record, history, embedded] = await Promise.all([
                    recordPromise,
                    historyPromise,
                    (0, metadata_1.resolveEmbeddedPromptForImage)(tag, clickedSrc),
                ]);
                const sources = {
                    shutter: record ? (0, history_1.promptViewFromRecord)(record) : null,
                    embedded: embedded
                        ? (0, history_1.promptViewFromEmbedded)(embedded.prompt, embedded.negativePrompt)
                        : null,
                    history,
                    imageId: tag?.imageId ?? clickedId ?? '',
                };
                return sources.shutter || sources.embedded ? sources : null;
            });
            void decorateLightbox(found.portalRoot, found.img, promptPromise);
            return true;
        };
        // Mount-driven discovery: the native portal is a direct body child, so a
        // body childList observer catches it the frame it mounts — the pill no
        // longer waits out the remainder of a 250ms polling slot when the portal
        // appears just after a tick. The interval remains as a fallback (e.g. a
        // host build mounting the <img> a beat after the portal) and still owns
        // the ~2.5s give-up.
        const tick = () => {
            attempts++;
            if (tryLocate())
                return;
            if (attempts < 10)
                retryTimer = setTimeout(tick, 250);
            else {
                stopLooking();
                clearReserveStyle();
            }
        };
        mountWatcher = new MutationObserver(() => { tryLocate(); });
        mountWatcher.observe(document.body, { childList: true });
        requestAnimationFrame(() => requestAnimationFrame(tick));
    }
    function syncLightboxObserver() {
        const shouldRun = Boolean(deps.getSettings()?.showPromptInLightbox) && deps.hasPermission('app_manipulation');
        if (shouldRun && !lightboxWatcherActive) {
            document.addEventListener('click', onDocumentClick, true);
            lightboxWatcherActive = true;
        }
        else if (!shouldRun && lightboxWatcherActive) {
            document.removeEventListener('click', onDocumentClick, true);
            lightboxWatcherActive = false;
            activeLabel?.dismiss();
            clearReserveStyle();
        }
    }
    // Entry cleanup: identical teardown to the pre-split cleanup fragment.
    function dispose() {
        document.removeEventListener('click', onDocumentClick, true);
        lightboxWatcherActive = false;
        activeLabel?.dismiss();
        clearReserveStyle();
    }
    return {
        sync: syncLightboxObserver,
        onHistoryCleared: () => activeLabel?.dismiss(),
        dispose,
    };
}

};

__modules["./metadata"] = function(module, exports, require) {
"use strict";
// Image-metadata resolution: PNG text-chunk parsing and provider prompt
// decoding (A1111/Forge, NovelAI, ComfyUI), plus the tag/URL helpers built
// on them. Everything here is pure of extension state — no ctx, no settings,
// only browser globals (fetch, DecompressionStream) — so it is safe to use
// from any module.
//
// The Spindle round-trip that RESOLVES a ShutterTag from message markdown
// (resolveShutterTag) is deliberately NOT here: it is message-channel
// plumbing and lives in comms.ts. This module only defines the data shape
// and consumes it.
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePromptForImage = exports.IMAGE_URL_RE = void 0;
exports.resolveEmbeddedPromptForImage = resolveEmbeddedPromptForImage;
exports.extractImageId = extractImageId;
exports.IMAGE_URL_RE = /\/api\/v1\/(?:images|image-gen\/results)\/([a-f0-9-]+)/i;
// ── PNG text-chunk parsing ──
// PNG layout: 8-byte signature, then chunks of [len u32][type 4ch][data][crc u32].
// tEXt: keyword\0text (latin-1). zTXt: keyword\0compressionMethod, zlib data.
// iTXt: keyword\0compFlag\0compMethod\0lang\0translatedKeyword\0text (utf-8,
// zlib-compressed when compFlag=1). Compressed streams are zlib-wrapped,
// which DecompressionStream('deflate') handles natively.
async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return await new Response(stream).text();
}
async function readPngTextChunks(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const chunks = {};
    // PNG signature
    if (view.byteLength < 8 || view.getUint32(0) !== 0x89504e47)
        return chunks;
    const latin1 = new TextDecoder('latin1');
    const utf8 = new TextDecoder('utf-8');
    let offset = 8;
    while (offset + 8 <= view.byteLength) {
        const length = view.getUint32(offset);
        const type = latin1.decode(bytes.subarray(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > view.byteLength)
            break;
        if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
            const data = bytes.subarray(dataStart, dataEnd);
            const nul = data.indexOf(0);
            if (nul > 0) {
                const keyword = latin1.decode(data.subarray(0, nul));
                try {
                    if (type === 'tEXt') {
                        chunks[keyword] = latin1.decode(data.subarray(nul + 1));
                    }
                    else if (type === 'zTXt') {
                        // keyword \0 compressionMethod(1) zlibData
                        chunks[keyword] = await inflate(data.subarray(nul + 2));
                    }
                    else {
                        // iTXt: keyword \0 compFlag(1) compMethod(1) lang \0 translated \0 text
                        const compFlag = data[nul + 1];
                        let p = nul + 3;
                        while (p < data.length && data[p] !== 0)
                            p++; // language tag
                        p++;
                        while (p < data.length && data[p] !== 0)
                            p++; // translated keyword
                        p++;
                        const text = data.subarray(p);
                        chunks[keyword] = compFlag === 1 ? await inflate(text) : utf8.decode(text);
                    }
                }
                catch { /* skip malformed/incompressible chunk */ }
            }
        }
        if (type === 'IEND')
            break;
        offset = dataEnd + 4; // skip CRC
    }
    return chunks;
}
function decodeProviderMetadata(chunks) {
    // A1111 / Forge: single 'parameters' chunk, plaintext with a
    // 'Negative prompt:' line followed by a settings line.
    if (chunks.parameters) {
        const text = chunks.parameters;
        const negIdx = text.indexOf('\nNegative prompt:');
        if (negIdx !== -1) {
            const rest = text.slice(negIdx + '\nNegative prompt:'.length);
            const settingsIdx = rest.search(/\nSteps: /);
            return {
                prompt: text.slice(0, negIdx).trim(),
                negativePrompt: (settingsIdx === -1 ? rest : rest.slice(0, settingsIdx)).trim(),
            };
        }
        const settingsIdx = text.search(/\nSteps: /);
        return { prompt: (settingsIdx === -1 ? text : text.slice(0, settingsIdx)).trim(), negativePrompt: '' };
    }
    // NovelAI: 'Comment' chunk with JSON ({ prompt, uc, ... }); 'Description'
    // carries the positive prompt as plain text.
    if (chunks.Software === 'NovelAI' || chunks.Comment) {
        try {
            const meta = JSON.parse(chunks.Comment || '{}');
            const prompt = typeof meta.prompt === 'string' ? meta.prompt : (chunks.Description || '');
            if (prompt) {
                return { prompt: prompt.trim(), negativePrompt: typeof meta.uc === 'string' ? meta.uc.trim() : '' };
            }
        }
        catch { /* fall through */ }
        if (chunks.Description)
            return { prompt: chunks.Description.trim(), negativePrompt: '' };
    }
    // ComfyUI: 'prompt' chunk is the workflow node graph, not a prompt.
    // Best effort: collect text inputs from CLIPTextEncode-style nodes.
    if (chunks.prompt) {
        try {
            const graph = JSON.parse(chunks.prompt);
            const texts = [];
            for (const node of Object.values(graph)) {
                if (node && typeof node === 'object' && typeof node.class_type === 'string'
                    && node.class_type.includes('CLIPTextEncode')
                    && typeof node.inputs?.text === 'string' && node.inputs.text.trim()) {
                    texts.push(node.inputs.text.trim());
                }
            }
            if (texts.length > 0) {
                return { prompt: texts[0], negativePrompt: texts.length > 1 ? texts.slice(1).join('\n---\n') : '' };
            }
        }
        catch { /* fall through */ }
    }
    return null;
}
async function fetchMetadataPrompt(url) {
    try {
        // Strip any thumbnail tier — tiered responses are sharp-re-encoded and
        // metadata-stripped; un-tiered routes serve original provider bytes.
        const resp = await fetch(url.split('?')[0], { credentials: 'include' });
        if (!resp.ok)
            return null;
        return decodeProviderMetadata(await readPngTextChunks(await resp.arrayBuffer()));
    }
    catch {
        return null;
    }
}
async function resolveEmbeddedPromptForImage(tag, lightboxSrc) {
    let resolved = null;
    // 1. Provider-embedded metadata from the original Shutter tag URL.
    if (tag) {
        const decoded = await fetchMetadataPrompt(tag.path);
        if (decoded)
            resolved = decoded;
    }
    // 2. Last resort: metadata from whatever the lightbox is showing.
    if (!resolved) {
        const decoded = await fetchMetadataPrompt(lightboxSrc);
        if (decoded)
            resolved = decoded;
    }
    return resolved;
}
// Backwards-compatible alias for internal callers outside the 1.0.7 source split.
exports.resolvePromptForImage = resolveEmbeddedPromptForImage;
function extractImageId(src) {
    const match = src.match(exports.IMAGE_URL_RE);
    return match ? match[1] : null;
}

};

__modules["./modals"] = function(module, exports, require) {
"use strict";
// Shutter's modal surfaces: the post-generation destination modal, the
// error modal, the mini image lightbox used by the destination preview, the
// View Prompt modal, and the Preview & Edit prompt modal. Moved whole from
// frontend.ts. Generation-flow functions stay in the entry (they call these
// modals and are called BY them — the cycle is broken by routing the
// generation side through the deps object).
Object.defineProperty(exports, "__esModule", { value: true });
exports.createModals = createModals;
const metadata_1 = require("./metadata");
const styles_1 = require("./styles");
const history_1 = require("./history");
function createModals(deps) {
    const { ctx, comms } = deps;
    let promptPreviewOpen = false;
    const modalInputStack = [];
    // ── Modals ──
    // ── Lightbox state (for cleanup) ──
    let activeLightbox = null;
    function dismissLightbox() {
        if (!activeLightbox)
            return;
        window.removeEventListener('keydown', activeLightbox.keyHandler, { capture: true });
        activeLightbox.overlay.remove();
        activeLightbox = null;
    }
    function isEditableTarget(target) {
        const el = target instanceof HTMLElement ? target : document.activeElement;
        return !!el && (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' ||
            el.isContentEditable);
    }
    // Spindle modals are visually foregrounded, but Lumiverse's global chat
    // navigation does not treat them as native active modals. Arrow keys must
    // be isolated at window capture: when no modal control is focused, the key
    // event targets the page and never passes through modal.root. Touch events
    // originate inside the modal, so root-level propagation blocking remains
    // appropriate. Editable controls keep their native caret behaviour because
    // their arrow-key default is not prevented.
    function isolateModalInput(modal, options = {}) {
        const blockArrows = options.blockArrows !== false;
        const stackToken = Symbol('shutter-modal-input');
        modalInputStack.push(stackToken);
        const isTopModal = () => modalInputStack[modalInputStack.length - 1] === stackToken;
        const keyBlocker = (e) => {
            if (!isTopModal())
                return;
            if (e.key === 'Escape') {
                // The preview lightbox is the foreground surface and owns Escape.
                if (activeLightbox)
                    return;
                e.preventDefault();
                e.stopImmediatePropagation();
                if (options.onEscape)
                    options.onEscape();
                else
                    modal.dismiss();
                return;
            }
            if (!blockArrows || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight'))
                return;
            if (e.ctrlKey || e.metaKey || e.altKey)
                return;
            if (!isEditableTarget(e.target))
                e.preventDefault();
            // Capture at window so Lumiverse's document-level chat navigation never
            // sees the key. Not preventing default for editable targets preserves
            // normal caret/selection movement.
            e.stopImmediatePropagation();
        };
        const touchBlocker = (e) => {
            e.stopPropagation();
        };
        modal.root.addEventListener('touchstart', touchBlocker);
        modal.root.addEventListener('touchmove', touchBlocker);
        modal.root.addEventListener('touchend', touchBlocker);
        modal.root.addEventListener('touchcancel', touchBlocker);
        window.addEventListener('keydown', keyBlocker, { capture: true });
        modal.onDismiss(() => {
            modal.root.removeEventListener('touchstart', touchBlocker);
            modal.root.removeEventListener('touchmove', touchBlocker);
            modal.root.removeEventListener('touchend', touchBlocker);
            modal.root.removeEventListener('touchcancel', touchBlocker);
            window.removeEventListener('keydown', keyBlocker, { capture: true });
            const stackIndex = modalInputStack.lastIndexOf(stackToken);
            if (stackIndex >= 0)
                modalInputStack.splice(stackIndex, 1);
        });
    }
    function setImagePromptOverflow(modal, enabled) {
        const hostBody = modal.root.parentElement;
        if (hostBody instanceof HTMLElement)
            hostBody.style.overflowY = enabled ? 'hidden' : 'auto';
        modal.root.classList.toggle('sh-image-prompt-root', enabled);
    }
    function makeReadonlyPromptField(label, text, kind) {
        const field = document.createElement('div');
        field.className = `sh-prompt-field sh-image-prompt-field sh-image-prompt-field-${kind}`;
        const heading = document.createElement('div');
        heading.className = 'sh-prompt-label';
        heading.textContent = label;
        const block = document.createElement('div');
        block.className = 'sh-prompt-readonly sh-image-prompt-readonly';
        block.textContent = text;
        field.append(heading, block);
        return field;
    }
    function setCopyFeedback(button, view) {
        navigator.clipboard.writeText((0, history_1.formatPromptMetadataForClipboard)(view)).then(() => {
            button.innerHTML = `${styles_1.COPY_CHECK_SVG} Copied`;
            button.classList.add('sh-copied');
            setTimeout(() => {
                if (!button.isConnected)
                    return;
                button.textContent = 'Copy Prompt';
                button.classList.remove('sh-copied');
            }, 2000);
        }).catch(() => {
            button.textContent = 'Failed';
            setTimeout(() => { if (button.isConnected)
                button.textContent = 'Copy Prompt'; }, 1200);
        });
    }
    function renderImagePromptSurface(modal, options) {
        modal.setTitle('Image Prompt');
        setImagePromptOverflow(modal, true);
        let activeView = options.initialView;
        const body = document.createElement('div');
        body.className = 'sh-prompt-body sh-image-prompt-body';
        const sourceSlot = document.createElement('div');
        const meta = document.createElement('div');
        meta.className = 'sh-prompt-source-meta sh-image-prompt-meta';
        const fields = document.createElement('div');
        fields.className = 'sh-prompt-source-fields sh-image-prompt-fields';
        const renderView = (view) => {
            activeView = view;
            sourceSlot.querySelectorAll('.sh-prompt-source-btn').forEach(button => {
                const selected = button.dataset.source === view.source;
                button.classList.toggle('sh-active', selected);
                button.setAttribute('aria-selected', String(selected));
            });
            meta.textContent = (0, history_1.formatPromptMetadataLine)(view);
            fields.replaceChildren();
            fields.classList.toggle('sh-no-negative', !view.negativePrompt);
            fields.appendChild(makeReadonlyPromptField('Positive Prompt', view.prompt || 'Prompt unavailable', 'positive'));
            if (view.negativePrompt) {
                fields.appendChild(makeReadonlyPromptField('Negative Prompt', view.negativePrompt, 'negative'));
            }
        };
        const shutterView = options.shutterView ?? null;
        const embeddedView = options.embeddedView ?? null;
        if (shutterView && embeddedView) {
            sourceSlot.className = 'sh-prompt-source-tabs';
            sourceSlot.setAttribute('role', 'tablist');
            sourceSlot.setAttribute('aria-label', 'Prompt metadata source');
            for (const [source, label, view] of [
                ['shutter', 'Shutter', shutterView],
                ['embedded', 'Embedded', embeddedView],
            ]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'sh-prompt-source-btn';
                button.dataset.source = source;
                button.textContent = label;
                button.setAttribute('role', 'tab');
                button.addEventListener('click', () => renderView(view));
                sourceSlot.appendChild(button);
            }
            body.appendChild(sourceSlot);
        }
        body.append(meta, fields);
        const actions = document.createElement('div');
        actions.className = 'sh-prompt-actions sh-image-prompt-actions';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', options.onClose);
        actions.appendChild(closeBtn);
        if (options.onViewHistory && options.historyLabel) {
            const historyBtn = document.createElement('button');
            historyBtn.type = 'button';
            historyBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary';
            historyBtn.textContent = options.historyLabel;
            historyBtn.title = 'View generation history for this message response';
            historyBtn.addEventListener('click', options.onViewHistory);
            actions.appendChild(historyBtn);
        }
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary';
        copyBtn.textContent = 'Copy Prompt';
        copyBtn.addEventListener('click', () => setCopyFeedback(copyBtn, activeView));
        actions.appendChild(copyBtn);
        body.appendChild(actions);
        modal.root.replaceChildren(body);
        renderView(activeView);
    }
    function openLightbox(src) {
        // Dismiss any existing lightbox first
        dismissLightbox();
        const overlay = document.createElement('div');
        overlay.className = 'sh-lightbox';
        const img = document.createElement('img');
        img.src = src;
        overlay.appendChild(img);
        // Mousedown-origin guard — matches native ImageLightbox behavior.
        // Only close if both mousedown and click land on the backdrop itself.
        let mouseDownTarget = null;
        overlay.addEventListener('mousedown', (e) => {
            mouseDownTarget = e.target;
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && mouseDownTarget === overlay)
                dismissLightbox();
        });
        // The preview lightbox is intentionally a static viewer. Consume arrows
        // so neither the Generate Image modal nor the background chat can react.
        const keyHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                dismissLightbox();
                return;
            }
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')
                return;
            if (e.ctrlKey || e.metaKey || e.altKey)
                return;
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        window.addEventListener('keydown', keyHandler, { capture: true });
        // Keep touch gestures inside the lightbox. There is deliberately no
        // swipe navigation here; history remains owned by the underlying modal.
        const stopTouch = (e) => e.stopPropagation();
        overlay.addEventListener('touchstart', stopTouch);
        overlay.addEventListener('touchmove', stopTouch);
        overlay.addEventListener('touchend', stopTouch);
        overlay.addEventListener('touchcancel', stopTouch);
        activeLightbox = { overlay, keyHandler };
        document.body.appendChild(overlay);
    }
    function makeDestBtn(label, tooltip, variant, onClick) {
        const btn = document.createElement('button');
        btn.className = `sh-prompt-btn ${variant}`;
        btn.textContent = label;
        btn.title = tooltip;
        btn.addEventListener('click', onClick);
        return btn;
    }
    // ── Durable generation history (1.0.7) ──
    //
    // The backend/userStorage record is authoritative. The modal receives the
    // complete history for the pinned message swipe, so a fresh widget press,
    // Rebuild Prompt, a browser restart, or another device all reopen the same
    // sequence. The generated image itself is not duplicated in userStorage.
    let activeDestinationModal = null;
    function openDestinationModal(result, target, isAuto, replace = false, storedHistory = []) {
        const settings = deps.getSettings();
        const historyEnabled = settings?.generationHistory === true;
        const gestureEnabled = historyEnabled && settings?.gestureNavigation === true;
        const fallbackRecord = {
            version: 1,
            imageId: result.imageId,
            createdAt: Date.now(),
            prompt: result.prompt,
            negativePrompt: result.negativePrompt,
            promptMode: result.promptMode,
            origin: isAuto ? 'auto' : 'manual',
            provider: result.provider,
            model: result.model,
            target,
        };
        const history = historyEnabled ? [...storedHistory] : [fallbackRecord];
        if (!history.some(entry => entry.imageId === result.imageId))
            history.push(fallbackRecord);
        history.sort((a, b) => a.createdAt - b.createdAt || a.imageId.localeCompare(b.imageId));
        let idx = Math.max(0, history.findIndex(entry => entry.imageId === result.imageId));
        if (idx < 0)
            idx = history.length - 1;
        const current = () => history[idx];
        activeDestinationModal?.dismiss();
        const modal = ctx.ui.showModal({ title: 'Image Generated', width: 640, persistent: true });
        activeDestinationModal = modal;
        isolateModalInput(modal, { blockArrows: !gestureEnabled });
        const container = document.createElement('div');
        container.className = 'sh-modal-body';
        const previewWrap = document.createElement('div');
        previewWrap.className = 'sh-preview';
        const preview = document.createElement('img');
        preview.src = (0, history_1.imageUrlForHistoryRecord)(current());
        preview.addEventListener('click', () => openLightbox((0, history_1.imageUrlForHistoryRecord)(current())));
        previewWrap.appendChild(preview);
        const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
        const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
        const makeNavBtn = (dir) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sh-hist-btn';
            btn.innerHTML = dir === -1 ? CHEVRON_LEFT : CHEVRON_RIGHT;
            btn.title = dir === -1 ? 'Previous generation' : 'Next generation';
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                stepHistory(dir);
            });
            return btn;
        };
        const navPrev = makeNavBtn(-1);
        const navNext = makeNavBtn(1);
        const histCount = document.createElement('span');
        histCount.className = 'sh-hist-counter';
        const histPill = document.createElement('div');
        histPill.className = 'sh-hist-pill';
        histPill.addEventListener('click', event => event.stopPropagation());
        histPill.appendChild(navPrev);
        histPill.appendChild(histCount);
        histPill.appendChild(navNext);
        if (historyEnabled)
            previewWrap.appendChild(histPill);
        container.appendChild(previewWrap);
        function renderHistory() {
            const entry = current();
            const url = (0, history_1.imageUrlForHistoryRecord)(entry);
            preview.src = url;
            if (activeLightbox) {
                const img = activeLightbox.overlay.querySelector('img');
                if (img)
                    img.src = url;
            }
            navPrev.disabled = idx === 0;
            const atEnd = idx === history.length - 1;
            navNext.disabled = atEnd && !entry.prompt.trim();
            navNext.title = atEnd ? 'Regenerate image (same prompt)' : 'Next generation';
            histCount.textContent = `${idx + 1} / ${history.length}`;
        }
        let regenerating = false;
        async function regenerateFromSelected() {
            if (regenerating)
                return;
            const selected = current();
            const resolvedPrompt = selected.prompt.trim();
            if (!resolvedPrompt) {
                modal.dismiss();
                showErrorModal('Cannot regenerate because the submitted prompt was not saved.');
                return;
            }
            regenerating = true;
            modal.dismiss();
            deps.setGeneratingState(true);
            try {
                const next = await deps.callImageGen(target.chatId, {
                    prompt: resolvedPrompt,
                    negativePrompt: selected.negativePrompt,
                    skipParse: true,
                }, target);
                if ('skipped' in next) {
                    deps.setGeneratingState(false);
                    deps.notifyGenerationSkipped(next.reason);
                    return;
                }
                await deps.handleGenerationResult(next, target, isAuto, replaceChecked, 'regenerate');
            }
            catch (err) {
                deps.setGeneratingState(false);
                showErrorModal(deps.parseErrorMessage(err.message));
            }
        }
        function stepHistory(dir) {
            const next = idx + dir;
            if (next >= history.length) {
                void regenerateFromSelected();
                return;
            }
            if (next < 0)
                return;
            idx = next;
            renderHistory();
        }
        const arrowHandler = (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
                return;
            if (event.ctrlKey || event.metaKey || event.altKey)
                return;
            if (activeLightbox)
                return;
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable))
                return;
            event.preventDefault();
            event.stopPropagation();
            stepHistory(event.key === 'ArrowLeft' ? -1 : 1);
        };
        if (gestureEnabled)
            window.addEventListener('keydown', arrowHandler, { capture: true });
        let touchStartX = 0, touchStartY = 0, touchStartT = 0;
        let touchLock = null;
        if (gestureEnabled) {
            previewWrap.addEventListener('touchstart', (event) => {
                if (event.touches.length !== 1) {
                    touchLock = 'v';
                    return;
                }
                const touch = event.touches[0];
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
                touchStartT = Date.now();
                touchLock = null;
            }, { passive: true });
            previewWrap.addEventListener('touchmove', (event) => {
                if (touchLock) {
                    if (touchLock === 'h')
                        event.preventDefault();
                    return;
                }
                const touch = event.touches[0];
                const dx = touch.clientX - touchStartX;
                const dy = touch.clientY - touchStartY;
                if (Math.abs(dx) < 10 && Math.abs(dy) < 10)
                    return;
                touchLock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
                if (touchLock === 'h')
                    event.preventDefault();
            }, { passive: false });
            previewWrap.addEventListener('touchend', (event) => {
                if (touchLock !== 'h')
                    return;
                const touch = event.changedTouches[0];
                const dx = touch.clientX - touchStartX;
                const dt = Math.max(Date.now() - touchStartT, 1);
                if (Math.abs(dx) >= 50 || Math.abs(dx) / dt >= 0.3)
                    stepHistory(dx < 0 ? 1 : -1);
            }, { passive: true });
        }
        let replaceChecked = replace || (deps.getSettings()?.defaultAction === 'replace');
        const replaceSlot = document.createElement('div');
        replaceSlot.className = 'sh-replace-row';
        const replaceCheckbox = ctx.components.mountCheckbox(replaceSlot, {
            checked: replaceChecked,
            label: 'Replace existing image',
            onChange: (on) => { replaceChecked = on; },
        });
        container.appendChild(replaceSlot);
        const choices = document.createElement('div');
        choices.className = 'sh-prompt-actions';
        choices.appendChild(makeDestBtn('Close', 'Close without inserting', 'sh-prompt-btn-cancel', () => modal.dismiss()));
        choices.appendChild(makeDestBtn('Rebuild Prompt', 'Re-parse the chat and generate a new prompt', 'sh-prompt-btn-secondary', () => {
            modal.dismiss();
            deps.triggerGenerate(target.messageId, target.chatId, isAuto, replaceChecked, false, target, 'rebuild');
        }));
        choices.appendChild(makeDestBtn('Regenerate Image', 'Generate again with the selected image’s prompt', 'sh-prompt-btn-secondary', () => {
            void regenerateFromSelected();
        }));
        choices.appendChild(makeDestBtn('Insert', 'Insert the selected image into its message response', 'sh-prompt-btn-primary', () => {
            ctx.sendToBackend({
                type: 'insert_into_message',
                imageId: current().imageId,
                messageId: target.messageId,
                chatId: target.chatId,
                target,
                replace: replaceChecked,
            });
            modal.dismiss();
        }));
        container.appendChild(choices);
        modal.root.appendChild(container);
        renderHistory();
        modal.onDismiss(() => {
            if (activeDestinationModal === modal)
                activeDestinationModal = null;
            dismissLightbox();
            window.removeEventListener('keydown', arrowHandler, { capture: true });
            replaceCheckbox.destroy();
        });
    }
    let activeHistoryViewerModal = null;
    function openHistoryViewer(records, initialImageId, closeUnderlyingLightbox, closeParentPrompt) {
        const history = [...records].sort((a, b) => a.createdAt - b.createdAt || a.imageId.localeCompare(b.imageId));
        if (history.length === 0)
            return;
        activeHistoryViewerModal?.dismiss();
        let idx = history.findIndex(entry => entry.imageId === initialImageId);
        if (idx < 0)
            idx = history.length - 1;
        const current = () => history[idx];
        // Match the Image Generated modal's shell, width, preview sizing, and
        // footer placement. The same modal body is reused for View Prompt so the
        // logical Widget Prompt -> History -> Prompt flow stays within Lumiverse's
        // two-modal extension limit.
        const modal = ctx.ui.showModal({ title: 'Generation History', width: 640, persistent: true });
        activeHistoryViewerModal = modal;
        let surface = 'history';
        let committing = false;
        let promptRenderToken = 0;
        const closeCurrentSurface = () => {
            if (surface === 'prompt')
                renderHistorySurface();
            else
                modal.dismiss();
        };
        isolateModalInput(modal, { blockArrows: false, onEscape: closeCurrentSurface });
        const container = document.createElement('div');
        container.className = 'sh-modal-body sh-history-body';
        const previewWrap = document.createElement('div');
        previewWrap.className = 'sh-preview';
        const preview = document.createElement('img');
        preview.addEventListener('click', () => openLightbox((0, history_1.imageUrlForHistoryRecord)(current())));
        previewWrap.appendChild(preview);
        const nav = document.createElement('div');
        nav.className = 'sh-hist-pill';
        nav.addEventListener('click', event => event.stopPropagation());
        const prev = document.createElement('button');
        const next = document.createElement('button');
        prev.type = next.type = 'button';
        prev.className = next.className = 'sh-hist-btn';
        prev.title = 'Previous generation';
        next.title = 'Next generation';
        prev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
        next.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
        const count = document.createElement('span');
        count.className = 'sh-hist-counter';
        nav.append(prev, count, next);
        previewWrap.appendChild(nav);
        container.appendChild(previewWrap);
        const summary = document.createElement('div');
        summary.className = 'sh-history-summary';
        container.appendChild(summary);
        const actions = document.createElement('div');
        actions.className = 'sh-prompt-actions sh-history-actions';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => modal.dismiss());
        const viewPromptBtn = document.createElement('button');
        viewPromptBtn.type = 'button';
        viewPromptBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary';
        viewPromptBtn.textContent = 'View Prompt';
        viewPromptBtn.title = 'View and copy the prompt saved for this generation';
        const openSelectedPrompt = () => {
            if (committing)
                return;
            const entry = current();
            const shutterView = (0, history_1.promptViewFromRecord)(entry);
            const token = ++promptRenderToken;
            surface = 'prompt';
            renderImagePromptSurface(modal, {
                initialView: shutterView,
                onClose: renderHistorySurface,
            });
            const imageUrl = (0, history_1.imageUrlForHistoryRecord)(entry);
            void (0, metadata_1.resolveEmbeddedPromptForImage)({ imageId: entry.imageId, path: imageUrl }, imageUrl).then(embedded => {
                if (!embedded || surface !== 'prompt' || token !== promptRenderToken || !modal.root.isConnected)
                    return;
                const embeddedView = (0, history_1.promptViewFromEmbedded)(embedded.prompt, embedded.negativePrompt);
                renderImagePromptSurface(modal, {
                    initialView: shutterView,
                    shutterView,
                    embeddedView,
                    onClose: renderHistorySurface,
                });
            });
        };
        viewPromptBtn.addEventListener('click', openSelectedPrompt);
        const replaceBtn = document.createElement('button');
        replaceBtn.type = 'button';
        replaceBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary';
        replaceBtn.textContent = 'Replace';
        replaceBtn.title = 'Replace the image that opened Generation History';
        const insertBtn = document.createElement('button');
        insertBtn.type = 'button';
        insertBtn.className = 'sh-prompt-btn sh-prompt-btn-primary';
        insertBtn.textContent = 'Insert';
        insertBtn.title = 'Insert this image into its original message response';
        const setCommitDisabled = (disabled) => {
            committing = disabled;
            for (const button of [closeBtn, viewPromptBtn, replaceBtn, insertBtn, prev, next])
                button.disabled = disabled;
        };
        const commitSelected = async (replace) => {
            if (committing)
                return;
            setCommitDisabled(true);
            const entry = current();
            const result = await comms.insertIntoMessage({
                imageId: entry.imageId,
                messageId: entry.target.messageId,
                chatId: entry.target.chatId,
                target: entry.target,
                replace,
                // History was opened from a concrete lightbox image. Replace that
                // exact tag, not whichever Shutter image happens to be last now.
                replaceImageId: replace ? initialImageId : undefined,
            });
            if (!modal.root.isConnected)
                return;
            if (!result.success || !result.changed) {
                setCommitDisabled(false);
                render();
                return;
            }
            modal.dismiss();
            closeParentPrompt?.();
            closeUnderlyingLightbox?.();
        };
        replaceBtn.addEventListener('click', () => { void commitSelected(true); });
        insertBtn.addEventListener('click', () => { void commitSelected(false); });
        actions.append(closeBtn, viewPromptBtn, replaceBtn, insertBtn);
        container.appendChild(actions);
        function render() {
            const entry = current();
            preview.src = (0, history_1.imageUrlForHistoryRecord)(entry);
            count.textContent = `${idx + 1} / ${history.length}`;
            prev.disabled = committing || idx === 0;
            next.disabled = committing || idx === history.length - 1;
            summary.textContent = (0, history_1.formatPromptMetadataLine)((0, history_1.promptViewFromRecord)(entry));
            if (activeLightbox) {
                const lightboxImage = activeLightbox.overlay.querySelector('img');
                if (lightboxImage)
                    lightboxImage.src = (0, history_1.imageUrlForHistoryRecord)(entry);
            }
        }
        function renderHistorySurface() {
            promptRenderToken++;
            surface = 'history';
            modal.setTitle('Generation History');
            setImagePromptOverflow(modal, false);
            modal.root.replaceChildren(container);
            render();
        }
        const step = (direction) => {
            if (surface !== 'history' || committing)
                return;
            const nextIndex = idx + direction;
            if (nextIndex < 0 || nextIndex >= history.length)
                return;
            idx = nextIndex;
            render();
        };
        prev.addEventListener('click', event => { event.stopPropagation(); step(-1); });
        next.addEventListener('click', event => { event.stopPropagation(); step(1); });
        const arrowHandler = (event) => {
            if (surface !== 'history')
                return;
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
                return;
            if (event.ctrlKey || event.metaKey || event.altKey || activeLightbox || isEditableTarget(event.target))
                return;
            event.preventDefault();
            event.stopImmediatePropagation();
            step(event.key === 'ArrowLeft' ? -1 : 1);
        };
        window.addEventListener('keydown', arrowHandler, { capture: true });
        let touchStartX = 0;
        let touchStartY = 0;
        previewWrap.addEventListener('touchstart', event => {
            const touch = event.touches[0];
            if (!touch)
                return;
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
        }, { passive: true });
        previewWrap.addEventListener('touchend', event => {
            if (surface !== 'history')
                return;
            const touch = event.changedTouches[0];
            if (!touch)
                return;
            const dx = touch.clientX - touchStartX;
            const dy = touch.clientY - touchStartY;
            if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy))
                step(dx < 0 ? 1 : -1);
        }, { passive: true });
        renderHistorySurface();
        modal.onDismiss(() => {
            promptRenderToken++;
            if (activeHistoryViewerModal === modal)
                activeHistoryViewerModal = null;
            dismissLightbox();
            window.removeEventListener('keydown', arrowHandler, { capture: true });
        });
    }
    function showErrorModal(message) {
        ctx.ui.showConfirm({
            title: 'Generation Failed',
            message,
            variant: 'danger',
            confirmLabel: 'OK',
            cancelLabel: 'Dismiss',
        });
    }
    // ── View Prompt modal (widget advanced menu) ──
    //
    // Read-only viewer for the last Shutter image's prompt in the last
    // message. Resolution goes through the message markdown (tag path), same
    // as the lightbox pill — messageId '__last__' and index -1 are resolved
    // backend-side, so this works even when the message isn't rendered in the
    // (virtualized) chat DOM. It resolves Shutter's durable record and the
    // provider-embedded metadata independently, then shows one source at a time.
    let promptViewerOpen = false;
    let activePromptViewerModal = null;
    function viewLastPrompt() {
        const chatId = ctx.getActiveChat()?.chatId ?? undefined;
        if (!chatId || promptViewerOpen)
            return;
        promptViewerOpen = true;
        const modal = ctx.ui.showModal({ title: 'Image Prompt', width: 640 });
        activePromptViewerModal = modal;
        isolateModalInput(modal);
        setImagePromptOverflow(modal, true);
        let dismissed = false;
        const container = document.createElement('div');
        container.className = 'sh-prompt-body sh-image-prompt-loading';
        const subtitle = document.createElement('p');
        subtitle.className = 'sh-prompt-subtitle';
        subtitle.textContent = 'Reading saved and embedded prompt metadata.';
        container.appendChild(subtitle);
        const status = document.createElement('div');
        status.className = 'sh-prompt-viewer-status';
        const spinnerSlot = document.createElement('span');
        const statusText = document.createElement('span');
        statusText.textContent = 'Reading prompt…';
        status.append(spinnerSlot, statusText);
        container.appendChild(status);
        let spinnerHandle = ctx.components.mountSpinner(spinnerSlot, { size: 14, fast: true });
        const destroySpinner = () => { spinnerHandle?.destroy(); spinnerHandle = null; };
        const loadingActions = document.createElement('div');
        loadingActions.className = 'sh-prompt-actions';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => modal.dismiss());
        loadingActions.appendChild(closeBtn);
        container.appendChild(loadingActions);
        modal.root.appendChild(container);
        modal.onDismiss(() => {
            dismissed = true;
            destroySpinner();
            promptViewerOpen = false;
            if (activePromptViewerModal === modal)
                activePromptViewerModal = null;
        });
        void (async () => {
            const tag = await comms.resolveShutterTag(chatId, '__last__', -1);
            if (dismissed)
                return;
            if (!tag) {
                destroySpinner();
                statusText.textContent = 'No Shutter image found in the last message.';
                return;
            }
            const [record, embedded] = await Promise.all([
                comms.getGenerationRecord(tag.imageId),
                (0, metadata_1.resolveEmbeddedPromptForImage)(tag, tag.path),
            ]);
            const history = record ? await comms.getGenerationHistory(record.target) : [];
            if (dismissed)
                return;
            destroySpinner();
            const shutterView = record ? (0, history_1.promptViewFromRecord)(record) : null;
            const embeddedView = embedded ? (0, history_1.promptViewFromEmbedded)(embedded.prompt, embedded.negativePrompt) : null;
            if (!shutterView && !embeddedView) {
                subtitle.textContent = 'No saved or embedded prompt metadata is available for this image.';
                status.remove();
                return;
            }
            const initialView = shutterView ?? embeddedView;
            renderImagePromptSurface(modal, {
                initialView,
                shutterView,
                embeddedView,
                onClose: () => modal.dismiss(),
                historyLabel: history.length > 0 ? `View History · ${history.length}` : undefined,
                onViewHistory: history.length > 0
                    ? () => openHistoryViewer(history, tag.imageId, undefined, () => modal.dismiss())
                    : undefined,
            });
        })();
    }
    function openPromptPreviewModal(initialPrompt, initialNegative, target, isAuto = false, replace = false, origin = 'preview') {
        if (promptPreviewOpen)
            return;
        promptPreviewOpen = true;
        const modal = ctx.ui.showModal({ title: 'Preview & Edit Image Prompt', width: 640, persistent: true });
        isolateModalInput(modal);
        // Reset the gate on every dismissal path — Cancel, Generate, the header
        // close button, and Escape — so a dismissed preview can never wedge
        // future generations.
        modal.onDismiss(() => { promptPreviewOpen = false; });
        function closePromptModal() {
            modal.dismiss();
        }
        const container = document.createElement('div');
        container.className = 'sh-prompt-body';
        const subtitle = document.createElement('div');
        subtitle.className = 'sh-prompt-subtitle';
        subtitle.textContent = 'This is the prompt that will be sent to the image generator. Edit it freely \u2014 the parser will be skipped on confirm.';
        container.appendChild(subtitle);
        // Prompt field — native textarea matching InputPromptModal
        const promptField = document.createElement('div');
        promptField.className = 'sh-prompt-field';
        const promptLabel = document.createElement('label');
        promptLabel.className = 'sh-prompt-label';
        promptLabel.textContent = 'Prompt';
        const promptTextarea = document.createElement('textarea');
        promptTextarea.className = 'sh-prompt-textarea';
        promptTextarea.value = initialPrompt;
        promptTextarea.placeholder = 'The final image prompt';
        promptField.appendChild(promptLabel);
        promptField.appendChild(promptTextarea);
        container.appendChild(promptField);
        // Negative prompt field
        const negField = document.createElement('div');
        negField.className = 'sh-prompt-field';
        const negLabel = document.createElement('label');
        negLabel.className = 'sh-prompt-label';
        negLabel.textContent = 'Negative Prompt';
        const negTextarea = document.createElement('textarea');
        negTextarea.className = 'sh-prompt-textarea sh-prompt-textarea-short';
        negTextarea.value = initialNegative;
        negTextarea.placeholder = 'Optional negative prompt';
        negField.appendChild(negLabel);
        negField.appendChild(negTextarea);
        container.appendChild(negField);
        const errorEl = document.createElement('div');
        errorEl.className = 'sh-prompt-error';
        errorEl.style.display = 'none';
        container.appendChild(errorEl);
        const actions = document.createElement('div');
        actions.className = 'sh-prompt-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'sh-prompt-btn sh-prompt-btn-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => closePromptModal());
        const rerunBtn = document.createElement('button');
        rerunBtn.className = 'sh-prompt-btn sh-prompt-btn-secondary';
        rerunBtn.textContent = 'Re-run parser';
        const generateBtn = document.createElement('button');
        generateBtn.className = 'sh-prompt-btn sh-prompt-btn-primary';
        generateBtn.textContent = 'Generate';
        generateBtn.disabled = !initialPrompt.trim();
        promptTextarea.addEventListener('input', () => {
            if (!promptTextarea.disabled)
                generateBtn.disabled = !promptTextarea.value.trim();
        });
        rerunBtn.addEventListener('click', async () => {
            closePromptModal();
            deps.setGeneratingState(true);
            try {
                const result = await deps.callPreviewPrompt(target.chatId);
                deps.setGeneratingState(false);
                openPromptPreviewModal(result.prompt, result.negativePrompt, target, isAuto, replace, origin);
            }
            catch (err) {
                deps.setGeneratingState(false);
                showErrorModal(deps.parseErrorMessage(err.message));
            }
        });
        generateBtn.addEventListener('click', async () => {
            const prompt = promptTextarea.value.trim();
            if (!prompt) {
                errorEl.textContent = 'Prompt cannot be empty';
                errorEl.style.display = '';
                return;
            }
            closePromptModal();
            deps.setGeneratingState(true);
            try {
                const result = await deps.callImageGen(target.chatId, {
                    prompt,
                    negativePrompt: negTextarea.value,
                    skipParse: true,
                }, target);
                // skipParse routes to 'custom' prompt mode server-side (no scene, so
                // no skip path), but handle the outcome defensively anyway.
                if ('skipped' in result) {
                    deps.setGeneratingState(false);
                    if (!isAuto)
                        deps.notifyGenerationSkipped(result.reason);
                    return;
                }
                await deps.handleGenerationResult(result, target, isAuto, replace, origin);
            }
            catch (err) {
                deps.setGeneratingState(false);
                showErrorModal(deps.parseErrorMessage(err.message));
            }
        });
        actions.appendChild(cancelBtn);
        actions.appendChild(rerunBtn);
        actions.appendChild(generateBtn);
        container.appendChild(actions);
        modal.root.appendChild(container);
    }
    return {
        openDestinationModal,
        openHistoryViewer,
        openPromptPreviewModal,
        showErrorModal,
        viewLastPrompt,
        isPromptPreviewOpen: () => promptPreviewOpen,
        onHistoryCleared: () => {
            activeDestinationModal?.dismiss();
            activeHistoryViewerModal?.dismiss();
            activePromptViewerModal?.dismiss();
        },
        dispose: () => {
            activeDestinationModal?.dismiss();
            activeHistoryViewerModal?.dismiss();
            activePromptViewerModal?.dismiss();
            dismissLightbox();
        },
    };
}

};

__modules["./settings-panel"] = function(module, exports, require) {
"use strict";
// The extension settings panel (mount-once pattern): host shared components
// (switches, steppers, collapsible section) tracked via a handles record,
// native <select>/<input> refs synced by value, and conditional row
// visibility. Moved whole from frontend.ts.
//
// Ownership: the entry file owns settings STATE and the optimistic-update
// flow; this module owns the panel DOM and the mounted component handles.
// deps.updateSettings is the entry's optimistic updater — every control
// change routes through it, and validated settings echo back through
// applyIncoming.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSettingsPanel = createSettingsPanel;
const icons_1 = require("./icons");
const settings_1 = require("./settings");
function createSettingsPanel(deps) {
    const { ctx } = deps;
    // ── Settings panel (mount-once pattern) ──
    const settingsRoot = ctx.ui.mount('settings_extensions');
    settingsRoot.innerHTML = '<div style="padding:16px;font-size:13px;color:var(--lumiverse-text-muted)">Loading…</div>';
    let handles = null;
    let settingsMounting = false;
    // Conditional rows that show/hide based on other settings
    let rowWidgetSize = null;
    let rowWidgetStyle = null;
    let rowGestureNavigation = null;
    let rowInterval = null;
    let rowRandom = null;
    let rowAutoAfter = null;
    let rowAutoPreview = null;
    let rowShutterImageWidth = null;
    let rowShutterImageAlign = null;
    // Native select element refs for syncing
    let selectWidgetSize = null;
    let selectWidgetStyle = null;
    let selectIconTheme = null;
    let selectAfterGenerate = null;
    let selectAutoGenerate = null;
    let selectAutoGenerateAfter = null;
    let selectDefaultAction = null;
    let selectDeleteConfirmation = null;
    let selectShutterImageLayout = null;
    let inputShutterImageWidth = null;
    let selectShutterImageAlign = null;
    function makeRow(labelText, descText) {
        const row = document.createElement('div');
        row.className = 'sh-setting-row';
        const info = document.createElement('div');
        info.className = 'sh-setting-info';
        const label = document.createElement('div');
        label.className = 'sh-setting-label';
        label.textContent = labelText;
        const desc = document.createElement('div');
        desc.className = 'sh-setting-desc';
        desc.textContent = descText;
        info.appendChild(label);
        info.appendChild(desc);
        const controlSlot = document.createElement('div');
        controlSlot.className = 'sh-setting-control';
        row.appendChild(info);
        row.appendChild(controlSlot);
        return { row, controlSlot };
    }
    function makeSelect(options, current, onChange) {
        const select = document.createElement('select');
        select.className = 'sh-select';
        for (const opt of options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            if (opt.value === current)
                el.selected = true;
            select.appendChild(el);
        }
        select.addEventListener('change', () => onChange(select.value));
        return select;
    }
    function makePercentInput(current, onChange) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.max = '100';
        input.step = '0.1';
        input.inputMode = 'decimal';
        input.className = 'sh-select sh-percent-input';
        input.value = String((0, settings_1.clampShutterImageWidth)(current));
        const commit = () => {
            const next = (0, settings_1.clampShutterImageWidth)(Number(input.value));
            input.value = String(next);
            onChange(next);
        };
        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter')
                input.blur();
        });
        return input;
    }
    function mountSettings(s) {
        settingsRoot.innerHTML = '';
        const container = document.createElement('div');
        container.className = 'sh-settings';
        // Settings title
        const title = document.createElement('div');
        title.className = 'sh-settings-title';
        title.textContent = 'Shutter';
        container.appendChild(title);
        // ── General settings ──
        // Floating Widget toggle
        const floatRow = makeRow('Floating Widget', 'Show a quick-access generate widget on screen.');
        container.appendChild(floatRow.row);
        const showFloatWidget = ctx.components.mountSwitch(floatRow.controlSlot, {
            checked: s.showFloatWidget,
            onChange: (on) => {
                deps.updateSettings({ showFloatWidget: on });
                updateFloatingWidgetRowVisibility(on);
            },
        });
        // Widget Size — native <select>
        const sizeRow = makeRow('Widget Size', 'Size of the floating button.');
        container.appendChild(sizeRow.row);
        rowWidgetSize = sizeRow.row;
        selectWidgetSize = makeSelect([{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }, { value: 'xlarge', label: 'XL' }], s.widgetSize, (v) => deps.updateSettings({ widgetSize: v }));
        sizeRow.controlSlot.appendChild(selectWidgetSize);
        // Widget Style — native <select>
        const styleRow = makeRow('Widget Style', 'Icon style for the floating button.');
        container.appendChild(styleRow.row);
        rowWidgetStyle = styleRow.row;
        selectWidgetStyle = makeSelect([{ value: 'color', label: 'Colour' }, { value: 'mono', label: 'Monochrome' }], s.widgetStyle, (v) => deps.updateSettings({ widgetStyle: v }));
        styleRow.controlSlot.appendChild(selectWidgetStyle);
        // Icon Theme — native <select>
        const iconRow = makeRow('Icon', 'Choose the icon used for the floating widget and input bar action.');
        container.appendChild(iconRow.row);
        selectIconTheme = makeSelect(Object.entries(icons_1.ICON_SETS)
            .map(([value, icon]) => ({ value, label: icon.label })), s.iconTheme, (v) => deps.updateSettings({ iconTheme: v }));
        iconRow.controlSlot.appendChild(selectIconTheme);
        // Generation History (parent)
        const historyRow = makeRow('Generation History', 'Save and sync generated images and their submitted prompts for each message response.');
        container.appendChild(historyRow.row);
        const generationHistory = ctx.components.mountSwitch(historyRow.controlSlot, {
            checked: s.generationHistory,
            onChange: (on) => {
                deps.updateSettings({ generationHistory: on });
                updateGenerationHistoryRowVisibility(on);
            },
        });
        // Swipe & Keyboard Navigation (child — hidden while Generation History is off).
        // Gates input channels only (touch + arrow keys), matching native's
        // swipeGesturesEnabled: the pill chevrons work regardless.
        const gestureNavRow = makeRow('Swipe & Keyboard Navigation', 'Navigate generation history with swipes on mobile or arrow keys on desktop.');
        container.appendChild(gestureNavRow.row);
        rowGestureNavigation = gestureNavRow.row;
        const gestureNavigation = ctx.components.mountSwitch(gestureNavRow.controlSlot, {
            checked: s.gestureNavigation,
            onChange: (on) => deps.updateSettings({ gestureNavigation: on }),
        });
        // Destructive history action. Disabling Generation History only stops new
        // records; it never silently deletes existing cross-device history.
        const clearHistoryRow = makeRow('Clear Generation History', 'Remove saved prompts and history associations from this account. Generated images and message content are not deleted.');
        container.appendChild(clearHistoryRow.row);
        const clearHistoryBtn = document.createElement('button');
        clearHistoryBtn.type = 'button';
        clearHistoryBtn.className = 'sh-settings-danger-btn';
        clearHistoryBtn.textContent = 'Clear History…';
        clearHistoryBtn.addEventListener('click', async () => {
            const { confirmed } = await ctx.ui.showConfirm({
                title: 'Clear Generation History',
                message: 'Delete all saved Shutter generation history across every chat and synced device? Generated images and images already inserted into messages will not be deleted.',
                variant: 'danger',
                confirmLabel: 'Clear History',
                cancelLabel: 'Cancel',
            });
            if (!confirmed)
                return;
            clearHistoryBtn.disabled = true;
            clearHistoryBtn.textContent = 'Clearing…';
            const cleared = await deps.clearGenerationHistory();
            if (!clearHistoryBtn.isConnected)
                return;
            clearHistoryBtn.disabled = false;
            clearHistoryBtn.textContent = cleared ? 'Cleared' : 'Try Again';
            ctx.sendToBackend({
                type: 'show_toast',
                level: cleared ? 'success' : 'error',
                message: cleared ? 'Shutter generation history cleared.' : 'Generation history could not be cleared.',
            });
            setTimeout(() => {
                if (clearHistoryBtn.isConnected)
                    clearHistoryBtn.textContent = 'Clear History…';
            }, 1800);
        });
        clearHistoryRow.controlSlot.appendChild(clearHistoryBtn);
        // Toast on Insert
        const toastRow = makeRow('Toast on Insert', 'Show a notification when an image is inserted into a message.');
        container.appendChild(toastRow.row);
        const toastOnInsert = ctx.components.mountSwitch(toastRow.controlSlot, {
            checked: s.toastOnInsert,
            onChange: (on) => deps.updateSettings({ toastOnInsert: on }),
        });
        const insertionDivider = document.createElement('div');
        insertionDivider.className = 'sh-settings-divider';
        container.appendChild(insertionDivider);
        const insertionNote = document.createElement('div');
        insertionNote.className = 'sh-settings-note';
        insertionNote.textContent = 'The following settings apply only when Shutter handles insertion. They have no effect when ImageGen is set to Insert into Chat or Attach to Last Message.';
        container.appendChild(insertionNote);
        // Remove Image Tags from Context
        const hasInterceptorPermission = deps.hasPermission('interceptor');
        const imageTagContextDescription = 'When enabled, Shutter removes inline-generated ![shutter](...) Markdown tags from prompts sent to the LLM.';
        const imageTagContextRow = makeRow('Remove Image Tags from Context', imageTagContextDescription);
        container.appendChild(imageTagContextRow.row);
        const removeImageTagsFromContext = ctx.components.mountSwitch(imageTagContextRow.controlSlot, {
            checked: s.removeImageTagsFromContext,
            disabled: !hasInterceptorPermission,
            onChange: (on) => deps.updateSettings({ removeImageTagsFromContext: on }),
        });
        // Inline Shutter image layout — native <select> + typeable percentage input
        const imageLayoutRow = makeRow('Shutter Image Layout', 'Optionally resize and align inline Shutter Markdown images. Leave off if you already style Shutter images with custom CSS.');
        container.appendChild(imageLayoutRow.row);
        selectShutterImageLayout = makeSelect([{ value: 'off', label: 'Off' }, { value: 'custom', label: 'Custom' }], s.shutterImageLayout, (v) => {
            const mode = v;
            deps.updateSettings({ shutterImageLayout: mode });
            updateShutterImageLayoutVisibility(mode);
        });
        imageLayoutRow.controlSlot.appendChild(selectShutterImageLayout);
        const imageWidthRow = makeRow('Image Width', 'Width of inline Shutter images, as a percentage of the message area.');
        container.appendChild(imageWidthRow.row);
        rowShutterImageWidth = imageWidthRow.row;
        const widthControl = document.createElement('div');
        widthControl.className = 'sh-percent-control';
        inputShutterImageWidth = makePercentInput(s.shutterImageWidth, (v) => deps.updateSettings({ shutterImageWidth: v }));
        const widthSuffix = document.createElement('span');
        widthSuffix.className = 'sh-percent-suffix';
        widthSuffix.textContent = '%';
        widthControl.appendChild(inputShutterImageWidth);
        widthControl.appendChild(widthSuffix);
        imageWidthRow.controlSlot.appendChild(widthControl);
        const imageAlignRow = makeRow('Image Alignment', 'Alignment for inline Shutter images when width is below 100%.');
        container.appendChild(imageAlignRow.row);
        rowShutterImageAlign = imageAlignRow.row;
        selectShutterImageAlign = makeSelect([{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }], s.shutterImageAlign, (v) => deps.updateSettings({ shutterImageAlign: v }));
        imageAlignRow.controlSlot.appendChild(selectShutterImageAlign);
        // Show Prompt in Lightbox (requires app_manipulation)
        const hasAppManipulationPermission = deps.hasPermission('app_manipulation');
        const lightboxPromptRow = makeRow('Show Prompt in Lightbox', 'Show prompt metadata below Shutter images opened in the native image viewer. Saved Shutter data is preferred, with embedded image metadata available when present.');
        container.appendChild(lightboxPromptRow.row);
        const showPromptInLightbox = ctx.components.mountSwitch(lightboxPromptRow.controlSlot, {
            checked: s.showPromptInLightbox,
            disabled: !hasAppManipulationPermission,
            onChange: (on) => deps.updateSettings({ showPromptInLightbox: on }),
        });
        // After Generation — native <select>
        const afterRow = makeRow('After Generation', 'What to do after a manual generation.');
        container.appendChild(afterRow.row);
        selectAfterGenerate = makeSelect([{ value: 'ask_to_insert', label: 'Ask to insert' }, { value: 'auto_insert', label: 'Auto insert' }], s.afterGenerate, (v) => deps.updateSettings({ afterGenerate: v }));
        afterRow.controlSlot.appendChild(selectAfterGenerate);
        // Default Action — native <select>
        const defaultActionRow = makeRow('Default Widget Action', 'What pressing the widget or the input bar action does. Append inserts a new image; Replace swaps out the last Shutter image first.');
        container.appendChild(defaultActionRow.row);
        selectDefaultAction = makeSelect([{ value: 'append', label: 'Append' }, { value: 'replace', label: 'Replace' }], s.defaultAction, (v) => deps.updateSettings({ defaultAction: v }));
        defaultActionRow.controlSlot.appendChild(selectDefaultAction);
        // Delete Confirmation — native <select>
        const deleteConfirmRow = makeRow('Remove Confirmation', 'When to show a confirmation before removing images.');
        container.appendChild(deleteConfirmRow.row);
        selectDeleteConfirmation = makeSelect([{ value: 'never', label: 'Never' }, { value: 'bulk_only', label: 'Bulk only' }, { value: 'always', label: 'Always' }], s.deleteConfirmation, (v) => deps.updateSettings({ deleteConfirmation: v }));
        deleteConfirmRow.controlSlot.appendChild(selectDeleteConfirmation);
        // ── Auto Generate section (shared collapsible) ──
        const autoSectionSlot = document.createElement('div');
        autoSectionSlot.className = 'sh-auto-section';
        container.appendChild(autoSectionSlot);
        const autoSection = ctx.components.mountCollapsibleSection(autoSectionSlot, {
            title: 'Auto Generate',
            defaultExpanded: s.autoGenerate !== 'off',
        });
        // Auto Generate Mode — native <select>
        const autoModeRow = makeRow('Mode', 'Automatically generate after AI responses. Skipped when ImageGen is set to Insert into Chat or Attach to Last Message.');
        autoSection.body.appendChild(autoModeRow.row);
        selectAutoGenerate = makeSelect([{ value: 'off', label: 'Off' }, { value: 'every', label: 'Every message' }, { value: 'interval', label: 'Every X messages' }, { value: 'random', label: 'Random interval' }], s.autoGenerate, (v) => {
            const mode = v;
            deps.updateSettings({ autoGenerate: mode });
            updateAutoRowVisibility(mode);
        });
        autoModeRow.controlSlot.appendChild(selectAutoGenerate);
        // Interval row — shared number stepper
        const intervalRow = makeRow('Interval', 'Generate every X AI messages.');
        autoSection.body.appendChild(intervalRow.row);
        rowInterval = intervalRow.row;
        const autoGenerateInterval = ctx.components.mountNumberStepper(intervalRow.controlSlot, {
            value: s.autoGenerateInterval,
            min: 1,
            max: 99,
            step: 1,
            onChange: (v) => { if (v !== null)
                deps.updateSettings({ autoGenerateInterval: v }); },
        });
        // Random range row — shared number steppers
        const randomRow = makeRow('Random Range', 'Generate randomly between X and Y AI messages.');
        autoSection.body.appendChild(randomRow.row);
        rowRandom = randomRow.row;
        const rangeContainer = document.createElement('div');
        rangeContainer.className = 'sh-range-row';
        const minSlot = document.createElement('div');
        const rangeSep = document.createElement('span');
        rangeSep.className = 'sh-range-label';
        rangeSep.textContent = 'to';
        const maxSlot = document.createElement('div');
        rangeContainer.appendChild(minSlot);
        rangeContainer.appendChild(rangeSep);
        rangeContainer.appendChild(maxSlot);
        randomRow.controlSlot.appendChild(rangeContainer);
        const autoGenerateRandomMin = ctx.components.mountNumberStepper(minSlot, {
            value: s.autoGenerateRandomMin,
            min: 1, max: 99, step: 1,
            onChange: (v) => { if (v !== null)
                deps.updateSettings({ autoGenerateRandomMin: v }); },
        });
        const autoGenerateRandomMax = ctx.components.mountNumberStepper(maxSlot, {
            value: s.autoGenerateRandomMax,
            min: 1, max: 99, step: 1,
            onChange: (v) => { if (v !== null)
                deps.updateSettings({ autoGenerateRandomMax: v }); },
        });
        // After Auto Generate — native <select>
        const autoAfterRow = makeRow('After Auto Generate', 'What to do after an automatic generation.');
        autoSection.body.appendChild(autoAfterRow.row);
        rowAutoAfter = autoAfterRow.row;
        selectAutoGenerateAfter = makeSelect([{ value: 'auto_insert', label: 'Auto insert' }, { value: 'ask_to_insert', label: 'Ask to insert' }], s.autoGenerateAfter, (v) => deps.updateSettings({ autoGenerateAfter: v }));
        autoAfterRow.controlSlot.appendChild(selectAutoGenerateAfter);
        // Preview Prompt on Auto — shared switch
        const autoPreviewRow = makeRow('Preview Prompt on Auto', 'Show the prompt preview before auto-generated images. Requires "Preview Prompt Before Generating" to be enabled in native ImageGen settings.');
        autoSection.body.appendChild(autoPreviewRow.row);
        rowAutoPreview = autoPreviewRow.row;
        const autoPreviewPrompt = ctx.components.mountSwitch(autoPreviewRow.controlSlot, {
            checked: s.autoPreviewPrompt,
            onChange: (on) => deps.updateSettings({ autoPreviewPrompt: on }),
        });
        settingsRoot.appendChild(container);
        // Set initial visibility of conditional rows
        updateFloatingWidgetRowVisibility(s.showFloatWidget);
        updateShutterImageLayoutVisibility(s.shutterImageLayout);
        updateAutoRowVisibility(s.autoGenerate);
        updateGenerationHistoryRowVisibility(s.generationHistory);
        handles = {
            showFloatWidget,
            toastOnInsert,
            generationHistory,
            gestureNavigation,
            removeImageTagsFromContext,
            showPromptInLightbox,
            autoGenerateInterval,
            autoGenerateRandomMin,
            autoGenerateRandomMax,
            autoPreviewPrompt,
            autoSection,
        };
    }
    function updateFloatingWidgetRowVisibility(show) {
        if (rowWidgetSize)
            rowWidgetSize.style.display = show ? '' : 'none';
        if (rowWidgetStyle)
            rowWidgetStyle.style.display = show ? '' : 'none';
    }
    function updateGenerationHistoryRowVisibility(show) {
        if (rowGestureNavigation)
            rowGestureNavigation.style.display = show ? '' : 'none';
    }
    function updateShutterImageLayoutVisibility(mode) {
        const show = mode !== 'off';
        if (rowShutterImageWidth)
            rowShutterImageWidth.style.display = show ? '' : 'none';
        if (rowShutterImageAlign)
            rowShutterImageAlign.style.display = show ? '' : 'none';
    }
    function updateAutoRowVisibility(mode) {
        const showInterval = mode === 'interval';
        const showRandom = mode === 'random';
        const autoActive = mode !== 'off';
        if (rowInterval)
            rowInterval.style.display = showInterval ? '' : 'none';
        if (rowRandom)
            rowRandom.style.display = showRandom ? '' : 'none';
        if (rowAutoAfter)
            rowAutoAfter.style.display = autoActive ? '' : 'none';
        if (rowAutoPreview)
            rowAutoPreview.style.display = autoActive ? '' : 'none';
    }
    function destroySettingsHandles() {
        if (!handles)
            return;
        handles.showFloatWidget.destroy();
        handles.toastOnInsert.destroy();
        handles.generationHistory.destroy();
        handles.gestureNavigation.destroy();
        handles.removeImageTagsFromContext.destroy();
        handles.showPromptInLightbox.destroy();
        handles.autoGenerateInterval.destroy();
        handles.autoGenerateRandomMin.destroy();
        handles.autoGenerateRandomMax.destroy();
        handles.autoPreviewPrompt.destroy();
        handles.autoSection.destroy();
        handles = null;
        rowWidgetSize = null;
        rowWidgetStyle = null;
        rowGestureNavigation = null;
        rowInterval = null;
        rowRandom = null;
        rowAutoAfter = null;
        rowAutoPreview = null;
        rowShutterImageWidth = null;
        rowShutterImageAlign = null;
        selectWidgetSize = null;
        selectWidgetStyle = null;
        selectIconTheme = null;
        selectAfterGenerate = null;
        selectAutoGenerate = null;
        selectAutoGenerateAfter = null;
        selectDefaultAction = null;
        selectDeleteConfirmation = null;
        selectShutterImageLayout = null;
        inputShutterImageWidth = null;
        selectShutterImageAlign = null;
    }
    function syncSettingsToHandles(s) {
        if (!handles)
            return;
        // Shared components — use update()
        handles.showFloatWidget.update({ checked: s.showFloatWidget });
        handles.toastOnInsert.update({ checked: s.toastOnInsert });
        handles.generationHistory.update({ checked: s.generationHistory });
        handles.gestureNavigation.update({ checked: s.gestureNavigation });
        handles.autoGenerateInterval.update({ value: s.autoGenerateInterval });
        handles.autoGenerateRandomMin.update({ value: s.autoGenerateRandomMin });
        handles.autoGenerateRandomMax.update({ value: s.autoGenerateRandomMax });
        handles.autoPreviewPrompt.update({ checked: s.autoPreviewPrompt });
        handles.showPromptInLightbox.update({ checked: s.showPromptInLightbox });
        // Native selects / inputs — set .value directly
        if (selectWidgetSize)
            selectWidgetSize.value = s.widgetSize;
        if (selectWidgetStyle)
            selectWidgetStyle.value = s.widgetStyle;
        if (selectIconTheme)
            selectIconTheme.value = s.iconTheme;
        if (selectAfterGenerate)
            selectAfterGenerate.value = s.afterGenerate;
        if (selectAutoGenerate)
            selectAutoGenerate.value = s.autoGenerate;
        if (selectAutoGenerateAfter)
            selectAutoGenerateAfter.value = s.autoGenerateAfter;
        if (selectDefaultAction)
            selectDefaultAction.value = s.defaultAction;
        if (selectDeleteConfirmation)
            selectDeleteConfirmation.value = s.deleteConfirmation;
        if (selectShutterImageLayout)
            selectShutterImageLayout.value = s.shutterImageLayout;
        if (inputShutterImageWidth)
            inputShutterImageWidth.value = String((0, settings_1.clampShutterImageWidth)(s.shutterImageWidth));
        if (selectShutterImageAlign)
            selectShutterImageAlign.value = s.shutterImageAlign;
        updateFloatingWidgetRowVisibility(s.showFloatWidget);
        updateGenerationHistoryRowVisibility(s.generationHistory);
        updateShutterImageLayoutVisibility(s.shutterImageLayout);
        updateAutoRowVisibility(s.autoGenerate);
    }
    // Exact logic of the pre-split backend-message branch: first validated
    // settings payload mounts the panel (reentrancy-guarded); later payloads
    // sync the existing handles/controls in place.
    function applyIncoming(s) {
        if (!handles) {
            if (settingsMounting)
                return;
            settingsMounting = true;
            mountSettings(s);
            settingsMounting = false;
        }
        else {
            syncSettingsToHandles(s);
        }
    }
    return {
        applyIncoming,
        isMounted: () => handles !== null,
        // Used by the entry when permission-sensitive rows must be rebuilt:
        // destroy() then mount(s) — same sequence as pre-split.
        mount: mountSettings,
        destroy: destroySettingsHandles,
    };
}

};

__modules["./settings"] = function(module, exports, require) {
"use strict";
// Shared settings model — the single source of truth for Shutter's settings
// shape, defaults, and validation. Imported by BOTH entries (backend.ts and
// frontend.ts); bun bundles it into each dist file, so the host still sees
// exactly two self-contained bundles. Everything here must stay
// environment-neutral: no `spindle`, no DOM, no browser globals.
//
// Adding a setting touches this file only (type + default + validation),
// plus wherever the setting is actually used.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SETTINGS = exports.SHUTTER_ICON_IDS = void 0;
exports.clampShutterImageWidth = clampShutterImageWidth;
exports.validateSettings = validateSettings;
// ── Icon IDs ──
// Defined here (not icons.ts) so backend validation can consume the runtime
// list without pulling the SVG payloads into the backend bundle. icons.ts
// derives its ShutterIconSet record from this same type.
exports.SHUTTER_ICON_IDS = ['aperture', 'cherry_blossom', 'cat_lotus'];
// The runtime source of defaults. There is deliberately NO defaults/*.json
// seed file: `storage_seed_files` copies into extension storage
// ({DATA_DIR}/extensions/shutter/storage/), but settings live in
// spindle.userStorage ({DATA_DIR}/users/{userId}/extensions/shutter/) — so a
// seed was never read. loadSettings() spreads these defaults over whatever
// userStorage returns (fallback {}), which fully covers fresh installs.
exports.DEFAULT_SETTINGS = {
    showFloatWidget: false,
    toastOnInsert: true,
    generationHistory: false,
    gestureNavigation: false,
    afterGenerate: 'ask_to_insert',
    widgetSize: 'small',
    widgetStyle: 'color',
    iconTheme: 'aperture',
    autoGenerate: 'off',
    autoGenerateInterval: 3,
    autoGenerateRandomMin: 3,
    autoGenerateRandomMax: 7,
    autoGenerateAfter: 'auto_insert',
    autoPreviewPrompt: false,
    defaultAction: 'append',
    deleteConfirmation: 'bulk_only',
    removeImageTagsFromContext: true,
    showPromptInLightbox: false,
    shutterImageLayout: 'off',
    shutterImageWidth: 50,
    shutterImageAlign: 'center',
};
// Shared by backend validation, the settings panel's percent input, and the
// frontend's inline image-layout stylesheet.
function clampShutterImageWidth(value) {
    if (!Number.isFinite(value))
        return 100;
    return Math.max(1, Math.min(100, Math.round(value * 10) / 10));
}
// ── Validation ──
// Pure; the backend is the authority (it validates on every load and save),
// the frontend only mirrors validated settings echoed back over the channel.
function validateSettings(s) {
    const out = { ...s };
    // Migration (1.0.6): 'forceGeneration' was removed — Shutter now defers to
    // native ImageGen's scene-change settings ("Ignore Scene Change Detection"
    // and the threshold). 1.0.5 shipped the key in DEFAULT_SETTINGS and
    // saveSettings re-persists the whole merged object on every save, so the
    // stale key never self-cleans from users' settings.json; strip it here on
    // the next write. Safe to delete this line once 1.0.5-era installs have
    // aged out.
    delete out.forceGeneration;
    if (!exports.SHUTTER_ICON_IDS.includes(out.iconTheme)) {
        out.iconTheme = 'aperture';
    }
    out.autoGenerateInterval = Math.max(1, Math.round(out.autoGenerateInterval));
    out.autoGenerateRandomMin = Math.max(1, Math.round(out.autoGenerateRandomMin));
    out.autoGenerateRandomMax = Math.max(out.autoGenerateRandomMin, Math.round(out.autoGenerateRandomMax));
    if (out.shutterImageLayout !== 'off' && out.shutterImageLayout !== 'custom') {
        out.shutterImageLayout = 'off';
    }
    if (out.shutterImageAlign !== 'left' &&
        out.shutterImageAlign !== 'center' &&
        out.shutterImageAlign !== 'right') {
        out.shutterImageAlign = 'center';
    }
    out.shutterImageWidth = clampShutterImageWidth(Number(out.shutterImageWidth) || 100);
    return out;
}

};

__modules["./styles"] = function(module, exports, require) {
"use strict";
// Shutter's static stylesheet and shared presentation constants.
// The CSS string is fully static (no interpolation); the entry file
// installs it once via ctx.dom.addStyle(SHUTTER_CSS). The dynamic inline
// image-layout rules (user-configurable width/alignment) are NOT here —
// they are built per-settings in frontend.ts (syncShutterImageLayoutStyle).
//
// ── Styles ──
//
// Settings selects use native <select> matching SettingsModal.module.css
// Modal textareas and buttons match InputPromptModal.module.css
// Image preview matches ImageGenPanel.module.css
// Lightbox matches ImageLightbox.module.css
Object.defineProperty(exports, "__esModule", { value: true });
exports.COPY_CHECK_SVG = exports.SHUTTER_CSS = void 0;
exports.SHUTTER_CSS = `
    /* ── Float widget ── */
    .sh-float-btn { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border: none; background: var(--lumiverse-accent); color: var(--lumiverse-accent-fg); border-radius: 50%; cursor: pointer; transition: opacity var(--lumiverse-transition-fast); }
    .sh-float-btn:hover { opacity: 0.85; }
    .sh-float-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sh-float-btn svg { transition: transform 0.2s ease; }
    .sh-float-btn.sh-generating svg { animation: sh-spin 1.2s linear infinite; }
    @keyframes sh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

    /* ── Settings panel ── */
    .sh-settings { padding: 8px 16px 16px; }
    .sh-settings-title { font-size: calc(15px * var(--lumiverse-font-scale, 1)); font-weight: 600; color: var(--lumiverse-text); margin-bottom: 8px; }
    .sh-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
    .sh-setting-info { flex: 1; min-width: 0; }
    .sh-setting-label { font-size: calc(13px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text); }
    .sh-setting-desc { font-size: calc(11.5px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); margin-top: 2px; }
    .sh-setting-control { flex-shrink: 0; }
    .sh-settings-divider { border-top: 1px solid var(--lumiverse-border); margin: 10px 0 8px; }
    .sh-settings-note { font-size: calc(11.5px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); line-height: 1.45; margin: 0 0 6px; }
    .sh-settings-danger-btn {
      flex-shrink: 0;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--lumiverse-danger, #e55) 45%, var(--lumiverse-border));
      background: color-mix(in srgb, var(--lumiverse-danger, #e55) 10%, transparent);
      color: var(--lumiverse-danger, #e55);
      font: inherit;
      font-size: calc(12px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      cursor: pointer;
      transition: background var(--lumiverse-transition-fast), border-color var(--lumiverse-transition-fast);
    }
    .sh-settings-danger-btn:hover:not(:disabled) {
      background: color-mix(in srgb, var(--lumiverse-danger, #e55) 18%, transparent);
      border-color: var(--lumiverse-danger, #e55);
    }
    .sh-settings-danger-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sh-auto-section { margin-top: 10px; }
    .sh-range-row { display: flex; align-items: center; gap: 6px; }
    .sh-range-label { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); }
    .sh-percent-control { display: inline-flex; align-items: center; gap: 6px; }
    .sh-percent-input { width: 76px; text-align: right; }
    .sh-percent-suffix { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); }

    /* Native <select> — matches SettingsModal.module.css */
    .sh-select { padding: 6px 10px; border-radius: 8px; background: var(--lumiverse-fill-subtle); border: 1px solid var(--lumiverse-border); color: var(--lumiverse-text); font-size: calc(13px * var(--lumiverse-font-scale, 1)); font-family: inherit; outline: none; cursor: pointer; }
    .sh-select:focus { border-color: var(--lumiverse-primary); }

    /* ── Destination modal ── */
    /* padding 0 is correct: the host modal content area already supplies the
   native 16px padding and 8px gap (SpindleUIManager). Adding more here
   overflows the 520px height cap and brings back the scrollbar. */
    .sh-modal-body { padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .sh-replace-row { padding: 2px 0; }
    .sh-history-body { gap: 10px; }
    .sh-history-body .sh-preview img { max-height: min(36vh, 360px); }
    .sh-history-summary {
      min-width: 0;
      padding: 0 2px 2px;
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(11px * var(--lumiverse-font-scale, 1));
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .sh-history-actions { margin-top: 2px; }

    /* Image preview — matches ImageGenPanel.module.css */
    .sh-preview { position: relative; border: 1px solid var(--lumiverse-border); border-radius: 10px; overflow: hidden; cursor: zoom-in; background: var(--lumiverse-bg-elevated); }
    .sh-preview img { display: block; width: 100%; max-height: min(34vh, 340px); object-fit: contain; }

    /* ── Generation history nav — matches SwipeControls.module.css (.bubble variant) ── */
    .sh-hist-pill { position: absolute; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 2px; padding: 2px 4px; border-radius: 16px; background: var(--lumiverse-fill-heavy); border: 1px solid var(--lumiverse-border); font-family: ui-monospace, 'SF Mono', SFMono-Regular, 'Cascadia Code', Menlo, Consolas, monospace; font-size: calc(11px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-dim); letter-spacing: 0.04em; z-index: 2; cursor: default; }
    .sh-hist-btn { position: relative; display: flex; align-items: center; justify-content: center; width: var(--lumiverse-btn-icon-sm, 24px); height: var(--lumiverse-btn-icon-sm, 24px); padding: 0; background: transparent; border: none; border-radius: 6px; color: var(--lumiverse-text-dim); cursor: pointer; transition: all var(--lumiverse-transition-fast, 0.15s); }
    /* Invisible hit-area extension: ~40px effective touch target while the
       visual stays at native SwipeControls size. */
    .sh-hist-btn::after { content: ''; position: absolute; inset: -8px; }
    .sh-hist-btn:hover:not(:disabled) { background: var(--lumiverse-fill-subtle); color: var(--lumiverse-text); }
    .sh-hist-btn:disabled { color: var(--lumiverse-text-hint); opacity: 1; cursor: default; }
    .sh-hist-btn svg { width: 16px; height: 16px; }
    .sh-hist-counter { min-width: 32px; text-align: center; user-select: none; font-variant-numeric: tabular-nums; }
    /* Mobile: same position, reduced chrome weight (type unchanged — Shutter's
       type scale is universal; layout adapts, fonts don't). Buttons/icons/
       padding shrink ~18%; expanded hit-areas hold ~40px touch targets.
       Breakpoint matches the modal's action-grid pivot below. */
    @media (max-width: 560px) {
      .sh-hist-pill { right: 6px; bottom: 6px; gap: 1px; padding: 2px 3px; border-radius: 14px; }
      .sh-hist-btn { width: 20px; height: 20px; }
      .sh-hist-btn::after { inset: -10px; }
      .sh-hist-btn svg { width: 14px; height: 14px; }
      .sh-hist-counter { min-width: 26px; }
    }

    /* ── Lightbox — matches ImageLightbox.module.css ── */
    .sh-lightbox { position: fixed; inset: 0; width: var(--app-scaled-viewport-width, 100vw); height: var(--app-scaled-viewport-height, 100vh); z-index: 10003; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--lumiverse-modal-backdrop, rgba(0,0,0,0.8)); cursor: pointer; }
    [data-glass] .sh-lightbox { backdrop-filter: blur(var(--lcs-glass-soft-blur, 6px)); }
    .sh-lightbox img { max-width: 90vw; max-height: 90vh; object-fit: contain; border-radius: var(--lcs-radius-sm, 8px); cursor: default; }

    /* ── Prompt preview modal — matches InputPromptModal.module.css ── */
    .sh-prompt-subtitle { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-text-muted); margin: 0; padding: 0; line-height: 1.5; }
    .sh-prompt-body { padding: 0; display: flex; flex-direction: column; gap: 14px; }
    .sh-prompt-field { display: flex; flex-direction: column; gap: 6px; }
    .sh-prompt-label { font-size: calc(11px * var(--lumiverse-font-scale, 1)); font-weight: 600; color: var(--lumiverse-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

    /* Textareas — matches InputPromptModal.module.css .textarea */
    .sh-prompt-textarea { width: 100%; min-height: 120px; max-height: 280px; padding: 12px 14px; border-radius: var(--lcs-radius-sm, 8px); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-bg-dark); color: var(--lumiverse-text); font-size: calc(13px * var(--lumiverse-font-scale, 1)); line-height: 1.5; resize: vertical; font-family: inherit; transition: border-color var(--lumiverse-transition-fast); box-sizing: border-box; }
    .sh-prompt-textarea::placeholder { color: var(--lumiverse-text-dim); }
    .sh-prompt-textarea:focus { outline: none; border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5)); }
    .sh-prompt-textarea-short { min-height: 64px; max-height: 160px }

    .sh-prompt-error { font-size: calc(12px * var(--lumiverse-font-scale, 1)); color: var(--lumiverse-danger, #e55); }

    /* Actions — matches InputPromptModal.module.css .actions / .btn* */
    .sh-prompt-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .sh-prompt-btn { padding: 8px 18px; border-radius: var(--lcs-radius-sm, 8px); font-size: calc(12.5px * var(--lumiverse-font-scale, 1)); font-weight: 600; font-family: inherit; cursor: pointer; border: 1px solid var(--lumiverse-border); transition: all var(--lumiverse-transition-fast); }
    /* Inline-flex so icon + label sit in a row: the host reset makes svg
       display:block, which otherwise stacks the copy checkmark above the
       label. Harmless for text-only buttons (label stays centered). */
    .sh-prompt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    .sh-prompt-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Copy confirmation — same success treatment as the lightbox pill. */
    .sh-prompt-btn.sh-copied,
    .sh-prompt-btn.sh-copied:hover:not(:disabled) {
      color: var(--lumiverse-success, #4ade80);
      border-color: var(--lumiverse-success, #4ade80);
    }

    /* Cancel — matches .btnCancel */
    .sh-prompt-btn-cancel { background: transparent; color: var(--lumiverse-text-muted); }
    .sh-prompt-btn-cancel:hover:not(:disabled) { background: var(--lumiverse-fill-subtle, rgba(255,255,255,0.04)); color: var(--lumiverse-text); }

    /* Secondary (Re-run parser) — matches .btnSecondary / .btnSkip */
    .sh-prompt-btn-secondary { background: var(--lumiverse-bg-dark); color: var(--lumiverse-text-dim); }
    .sh-prompt-btn-secondary:hover:not(:disabled) { background: var(--lumiverse-bg-darker); color: var(--lumiverse-text); }

    /* Primary (Generate) — matches .btnSubmit */
    .sh-prompt-btn-primary { background: var(--lumiverse-primary-015, rgba(147,112,219,0.15)); color: var(--lumiverse-primary-text, #c4b5fd); border-color: var(--lumiverse-primary-020, rgba(147,112,219,0.2)); }
    .sh-prompt-btn-primary:hover:not(:disabled) { background: var(--lumiverse-primary-025, rgba(147,112,219,0.25)); border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5)); }

    /* Mobile: action rows snap to an equal-width grid (native has no mobile treatment) */
    @media (max-width: 560px) {
      .sh-prompt-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
      .sh-prompt-actions > :last-child:nth-child(odd) { grid-column: 1 / -1; }
    }

    /* Read-only prompt block (View Prompt modal) — the textarea's visual
       language without the affordance to edit: same border, background,
       type scale, and radius as .sh-prompt-textarea, and the SAME PINNED
       HEIGHTS (120px / 64px short), so this modal's footprint matches the
       insertion modals regardless of prompt length; content scrolls inside. */
    .sh-prompt-readonly {
      height: 120px;
      padding: 12px 14px;
      border-radius: var(--lcs-radius-sm, 8px);
      border: 1px solid var(--lumiverse-border);
      background: var(--lumiverse-bg-dark);
      color: var(--lumiverse-text);
      font-size: calc(13px * var(--lumiverse-font-scale, 1));
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-y: auto;
      overscroll-behavior: contain;
      user-select: text;
      -webkit-user-select: text;
    }
    .sh-prompt-readonly-short { height: 64px; }
    .sh-prompt-viewer-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(13px * var(--lumiverse-font-scale, 1));
      font-style: italic;
      padding: 8px 0;
    }

    /* Compact source controls shared by the Image Prompt modal and the
       expanded lightbox prompt area. */
    .sh-prompt-source-tabs {
      display: inline-flex;
      align-items: center;
      align-self: flex-start;
      width: fit-content;
      max-width: 100%;
      gap: 6px;
      padding: 0;
      margin: 0;
      border: 0;
      background: transparent;
      flex-wrap: nowrap;
      white-space: nowrap;
    }
    .sh-prompt-source-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      min-width: 0;
      padding: 2px 8px;
      border: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      border-radius: var(--lcs-radius-sm, 6px);
      background: var(--lumiverse-fill-subtle, rgba(255,255,255,0.06));
      color: var(--lumiverse-text-muted, #999);
      font: inherit;
      font-size: calc(10px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      line-height: 1.4;
      cursor: pointer;
      white-space: nowrap;
      transition: background var(--lumiverse-transition-fast), border-color var(--lumiverse-transition-fast), color var(--lumiverse-transition-fast);
    }
    .sh-prompt-source-btn:hover {
      color: var(--lumiverse-text, #eee);
      border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5));
    }
    .sh-prompt-source-btn.sh-active {
      background: var(--lumiverse-fill-heavy, rgba(255,255,255,0.1));
      border-color: var(--lumiverse-primary-020, rgba(147,112,219,0.2));
      color: var(--lumiverse-text, #eee);
    }
    .sh-prompt-source-meta {
      margin-bottom: 8px;
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
      line-height: 1.4;
    }
    .sh-prompt-source-fields { display: flex; flex-direction: column; gap: 12px; }

    /* Image Prompt keeps Shutter's established prompt-modal structure. The
       host body is made non-scrolling in code; only these read-only prompt
       boxes scroll internally, leaving the standard footer visible. */
    .sh-image-prompt-root { width: 100%; min-height: 0; }
    .sh-image-prompt-body { min-height: 0; overflow: hidden; gap: 14px; }
    .sh-image-prompt-meta {
      margin: -2px 0 0;
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(11px * var(--lumiverse-font-scale, 1));
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .sh-image-prompt-fields { min-height: 0; overflow: hidden; gap: 14px; }
    .sh-image-prompt-readonly { box-sizing: border-box; cursor: text; }
    .sh-image-prompt-field-positive .sh-image-prompt-readonly { height: 120px; }
    .sh-image-prompt-field-negative .sh-image-prompt-readonly { height: 64px; }
    .sh-image-prompt-fields.sh-no-negative .sh-image-prompt-field-positive .sh-image-prompt-readonly { height: 196px; }
    .sh-image-prompt-actions { flex: 0 0 auto; }
    @media (max-height: 520px) {
      .sh-image-prompt-field-positive .sh-image-prompt-readonly { height: 92px; }
      .sh-image-prompt-field-negative .sh-image-prompt-readonly { height: 52px; }
      .sh-image-prompt-fields.sh-no-negative .sh-image-prompt-field-positive .sh-image-prompt-readonly { height: 156px; }
    }

    /* ── Lightbox prompt label (injected at BODY level, not into the
       portal) ── The wrapper is fixed-positioned via JS and deliberately
       lives outside the native lightbox subtree: the glass-mode backdrop
       has backdrop-filter, and painting inside a filtered subtree makes
       Chromium re-capture the blur (intermittent unblurred-frame flash).
       See the injection site in decorateLightbox. */
    .sh-lightbox-prompt {
      width: fit-content;
      min-width: 0;
      max-width: calc(var(--app-scaled-viewport-width, 100vw) - 24px);
      max-height: 156px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 10px 14px 12px;
      background: var(--lumiverse-bg-elevated, rgba(20,20,24,0.92));
      background-clip: padding-box;
      border: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      border-radius: var(--lcs-radius-sm, 8px);
      color: var(--lumiverse-text, #eee);
      font-size: calc(13px * var(--lumiverse-font-scale, 1));
      line-height: 1.45;
      z-index: 10;
      user-select: text;
      -webkit-user-select: text;
      cursor: auto;
      contain: layout paint style;
      will-change: auto;
      transform: none;
      transition: opacity var(--lumiverse-transition-fast, 160ms ease), border-color var(--lumiverse-transition-fast, 160ms ease);
    }

    .sh-lightbox-prompt.sh-swapping {
      opacity: 0.86;
    }
    .sh-lightbox-prompt-content {
      opacity: 1;
      transition: opacity 140ms ease;
    }
    .sh-lightbox-prompt.sh-swapping .sh-lightbox-prompt-content {
      opacity: 0;
    }
    .sh-lightbox-prompt.sh-ready .sh-lightbox-prompt-content {
      animation: sh-lightbox-prompt-content-in 180ms ease-out;
    }
    @keyframes sh-lightbox-prompt-content-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .sh-lightbox-prompt.sh-loading {
      color: var(--lumiverse-text-muted, #999);
      border-color: var(--lumiverse-border, rgba(255,255,255,0.08));
      opacity: 0.88;
    }
    .sh-lightbox-prompt.sh-ready { opacity: 1; }
    .sh-lightbox-prompt-heading {
      font-size: calc(11px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--lumiverse-text-muted, #999);
      padding-bottom: 4px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .sh-lightbox-prompt-scroll {
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      overflow-anchor: none;
      scrollbar-gutter: stable;
      -webkit-overflow-scrolling: touch;
      touch-action: pan-y;
      flex: 1 1 auto;
    }
    .sh-lightbox-prompt-copy {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      flex-shrink: 0;
      justify-content: center;
      margin-left: auto;
      padding: 2px 8px;
      background: var(--lumiverse-fill-subtle, rgba(255,255,255,0.06));
      border: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      border-radius: var(--lcs-radius-sm, 6px);
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(10px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      line-height: 1.4;
      cursor: pointer;
    }
    .sh-lightbox-prompt-copy:hover { color: var(--lumiverse-text, #eee); border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5)); }
    .sh-lightbox-prompt-copy.sh-copied,
    .sh-lightbox-prompt-copy.sh-copied:hover {
      color: var(--lumiverse-success, #4ade80);
      border-color: var(--lumiverse-success, #4ade80);
    }
    /* Slots for host-rendered shared components (mountCloseButton /
       mountSpinner) — the components own their internal styling so the
       label tracks native design automatically. */
    .sh-lightbox-prompt-close-slot {
      display: inline-flex;
      align-items: center;
      margin-left: 8px;
    }
    .sh-lightbox-prompt-spinner-slot { display: inline-flex; align-items: center; }
    .sh-lightbox-prompt-content { padding-bottom: 2px; }
    .sh-lightbox-prompt-content .sh-lightbox-prompt-text { margin-bottom: 10px; }
    .sh-lightbox-prompt-text:last-child { margin-bottom: 0; }
    .sh-lightbox-prompt-text { white-space: pre-wrap; word-break: break-word; }
    .sh-lightbox-prompt-loading-text {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--lumiverse-text-muted, #999);
      font-style: italic;
    }

    .sh-lightbox-prompt [hidden] { display: none !important; }
    .sh-lightbox-prompt-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(12px * var(--lumiverse-font-scale, 1));
      font-style: italic;
      font-weight: 600;
      text-transform: none;
      letter-spacing: 0;
      line-height: 1.4;
    }
    .sh-lightbox-prompt-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 0;
      flex: 0 0 auto;
      flex-wrap: nowrap;
      white-space: nowrap;
    }
    .sh-lightbox-prompt-actions .sh-lightbox-prompt-copy {
      margin-left: 0;
    }
    .sh-lightbox-prompt-history,
    .sh-lightbox-prompt-view,
    .sh-lightbox-prompt-collapse {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      flex-shrink: 0;
      margin-left: 0;
      padding: 2px 8px;
      background: var(--lumiverse-fill-subtle, rgba(255,255,255,0.06));
      border: 1px solid var(--lumiverse-border, rgba(255,255,255,0.08));
      border-radius: var(--lcs-radius-sm, 6px);
      color: var(--lumiverse-text-muted, #999);
      font-size: calc(10px * var(--lumiverse-font-scale, 1));
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      line-height: 1.4;
      cursor: pointer;
    }
    .sh-lightbox-prompt-history:hover,
    .sh-lightbox-prompt-view:hover,
    .sh-lightbox-prompt-collapse:hover {
      color: var(--lumiverse-text, #eee);
      border-color: var(--lumiverse-primary-050, rgba(147,112,219,0.5));
    }
    .sh-lightbox-prompt.sh-pill {
      width: 100%;
      min-width: 0;
      height: var(--sh-prompt-pill-height, 44px);
      max-height: var(--sh-prompt-pill-height, 44px);
      min-height: var(--sh-prompt-pill-height, 44px);
      padding: 7px 9px;
      justify-content: center;
      white-space: nowrap;
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-heading {
      width: 100%;
      min-width: 0;
      justify-content: center;
      padding-bottom: 0;
      margin-bottom: 0;
      border-bottom: 0;
      gap: 6px;
      flex-wrap: nowrap;
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-actions {
      width: auto;
      min-width: 0;
      justify-content: center;
      gap: 5px;
      margin-left: 0;
      flex-wrap: nowrap;
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-history,
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-view,
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-collapse,
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-copy {
      padding-inline: 6px;
      font-size: calc(9.5px * var(--lumiverse-font-scale, 1));
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-close-slot {
      margin-left: 2px;
    }
    .sh-lightbox-prompt.sh-pill .sh-lightbox-prompt-scroll {
      display: none !important;
    }
    .sh-lightbox-prompt.sh-expanded {
      width: 100%;
      height: auto;
      min-height: 0;
    }
    .sh-lightbox-prompt-content .sh-prompt-source-tabs { margin-bottom: 8px; }
    .sh-lightbox-prompt.sh-expanded .sh-lightbox-prompt-heading {
      gap: 8px;
    }
`;
// Shared by the lightbox pill's Copy and the View Prompt modal's Copy —
// mirrors native's code-copy confirmation checkmark.
exports.COPY_CHECK_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';

};

const __cache = Object.create(null);
function __normalise(id) {
  let key = id.replace(/\\/g, '/').replace(/\.js$/, '');
  if (!key.startsWith('.')) return key;
  if (!key.startsWith('./')) key = './' + key.replace(/^\.\//, '');
  return key;
}
function __require(id) {
  const key = __normalise(id);
  if (__cache[key]) return __cache[key].exports;
  const factory = __modules[key];
  if (!factory) throw new Error('Module not found in Shutter bundle: ' + id);
  const module = { exports: {} };
  __cache[key] = module;
  factory(module, module.exports, __require);
  return module.exports;
}
const __entry = __require("./frontend");
export const setup = __entry.setup;
