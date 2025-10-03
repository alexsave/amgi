const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fsPromises = fs.promises;

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        const mapped = value.map(item => stableStringify(item));
        return `[${mapped.join(',')}]`;
    }

    const keys = Object.keys(value).sort();
    const parts = keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${parts.join(',')}}`;
}

function clone(obj) {
    return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

function isLikelyJsonString(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const trimmed = value.trim();
    if (trimmed.length < 2) {
        return false;
    }
    const start = trimmed[0];
    const end = trimmed[trimmed.length - 1];
    return (start === '{' && end === '}') || (start === '[' && end === ']');
}

function coerceValue(value) {
    if (!isLikelyJsonString(value)) {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch (error) {
        return value;
    }
}

function parseSelector(selector) {
    if (typeof selector !== 'string') {
        return [];
    }
    return selector
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => (/^\d+$/.test(part) ? Number(part) : part));
}

function buildSelectionTree(selectors) {
    const root = {};
    for (const selector of selectors) {
        const path = parseSelector(selector);
        if (path.length === 0) {
            continue;
        }
        let node = root;
        for (let i = 0; i < path.length; i++) {
            const segment = path[i];
            if (!Object.prototype.hasOwnProperty.call(node, segment)) {
                node[segment] = {};
            }
            if (i === path.length - 1) {
                node[segment].__copy = true;
            }
            node = node[segment];
        }
    }
    return root;
}

function extractValue(source, selectorNode) {
    if (source === undefined) {
        return undefined;
    }

    const keys = Object.keys(selectorNode).filter(key => key !== '__copy');
    const hasCopy = !!selectorNode.__copy;

    let materialized = source;
    if (hasCopy || keys.length > 0) {
        materialized = coerceValue(source);
    }

    if (Array.isArray(materialized)) {
        const numericSelectors = [];
        const structuralSelectors = [];

        for (const key of keys) {
            const index = Number(key);
            if (!Number.isNaN(index) && (typeof key === 'number' || key === index.toString())) {
                numericSelectors.push({ key, index });
            } else {
                structuralSelectors.push(key);
            }
        }

        if (numericSelectors.length === 0 && structuralSelectors.length > 0) {
            const elementSelectors = {};
            for (const key of structuralSelectors) {
                elementSelectors[key] = selectorNode[key];
            }

            const collected = [];
            let hasCollected = false;
            for (let i = 0; i < materialized.length; i++) {
                const extracted = extractValue(materialized[i], elementSelectors);
                if (extracted !== undefined) {
                    collected[i] = extracted;
                    hasCollected = true;
                }
            }

            if (hasCollected) {
                return collected;
            }

            return hasCopy ? clone(materialized) : undefined;
        }

        const result = [];
        let hasResult = false;

        for (const { key, index } of numericSelectors) {
            if (index >= 0 && index < materialized.length) {
                const extracted = extractValue(materialized[index], selectorNode[key]);
                if (extracted !== undefined) {
                    result[index] = extracted;
                    hasResult = true;
                }
            }
        }

        if (hasResult) {
            return result;
        }

        return hasCopy ? clone(materialized) : undefined;
    }

    if (keys.length === 0) {
        return hasCopy ? clone(materialized) : undefined;
    }

    if (materialized === null || typeof materialized !== 'object') {
        return hasCopy ? clone(materialized) : undefined;
    }

    const result = {};
    for (const key of keys) {
        const extracted = extractValue(materialized[key], selectorNode[key]);
        if (extracted !== undefined) {
            result[key] = extracted;
        }
    }

    if (Object.keys(result).length === 0) {
        return hasCopy ? clone(materialized) : undefined;
    }

    if (hasCopy) {
        const merged = clone(materialized);
        for (const [key, value] of Object.entries(result)) {
            merged[key] = value;
        }
        return merged;
    }

    return result;
}

function extractBySpec(data, selection) {
    if (selection === undefined) {
        return data ?? null;
    }

    const stack = Array.isArray(selection) ? [...selection] : [selection];
    const normalized = [];

    while (stack.length > 0) {
        const current = stack.pop();
        if (Array.isArray(current)) {
            stack.push(...current);
            continue;
        }
        if (typeof current === 'string') {
            const trimmed = current.trim();
            if (trimmed) {
                normalized.push(trimmed);
            }
        }
    }

    if (normalized.length === 0) {
        return data ?? null;
    }

    const tree = buildSelectionTree(normalized);
    const extracted = extractValue(data, tree);
    return extracted === undefined ? null : extracted;
}

function makeCacheKey(method, payload) {
    const serializedPayload = stableStringify(payload || {});
    const hash = crypto
        .createHash('sha256')
        .update(`${method}|${serializedPayload}`)
        .digest('hex');
    return hash.slice(0, 16);
}

function serializeCache(cache) {
    const entries = Object.entries(cache || {});
    if (entries.length === 0) {
        return '{}';
    }
    const lines = entries.map(([key, value]) => `"${key}":${JSON.stringify(value)}`);
    return `{
${lines.join(',\n')}
}`;
}

let sharedCache = null;

function getSharedOpenAICache(cacheFilePath) {
    console.log(cacheFilePath);
    if (!sharedCache) {
        sharedCache = new OpenAICache(cacheFilePath);
        const flush = () => {
            try {
                sharedCache?.flush();
            } catch (error) {
                console.error('⚠️ Failed to flush OpenAI cache on exit:', error.message);
            }
        };
        process.once('exit', flush);
        process.once('beforeExit', flush);
    } else if (cacheFilePath && cacheFilePath !== sharedCache.cacheFilePath) {
        // If a different path is requested after initialization, warn and reuse existing cache.
        console.log(`ℹ️ OpenAI cache already initialized at ${sharedCache.cacheFilePath}; ignoring new path ${cacheFilePath}`);
    }
    return sharedCache;
}

async function cachedOpenAICall(cache, method, payload, executor, options = {}) {
    const force = !!options.force;
    if (!force) {
        const cached = cache.get(method, payload);
        if (cached) {
            return cached;
        }
    }

    const response = await executor();
    cache.set(method, payload, response, options.select);
    const key = makeCacheKey(method, payload);
    const entry = cache.cache[key];
    return entry ? clone(entry.response) : null;
}

async function cachedChatCompletion(openaiClient, cache, payload, options = {}) {
    return cachedOpenAICall(
        cache,
        'chat.completions.create',
        payload,
        () => openaiClient.chat.completions.create(payload),
        options
    );
}

async function cachedResponsesCreate(openaiClient, cache, payload, options = {}) {
    return cachedOpenAICall(
        cache,
        'responses.create',
        payload,
        () => openaiClient.responses.create(payload),
        options
    );
}

class OpenAICache {
    constructor(cacheFilePath) {
        this.cacheFilePath = cacheFilePath || path.resolve(__dirname, 'openai_response_cache.json');
        this.cache = this.load();
        this.changeCounter = 0;
        this.lastPersistedCounter = 0;
        this.writePromise = null;
        this.writeRequested = false;
    }

    makeKey(method, payload) {
        return makeCacheKey(method, payload);
    }

    load() {
        try {
            if (fs.existsSync(this.cacheFilePath)) {
                const raw = fs.readFileSync(this.cacheFilePath, 'utf8');
                if (raw && raw.trim().length > 0) {
                    const parsed = JSON.parse(raw);
                    const { cache } = migrateCache(parsed);
                    return cache;
                }
            }
        } catch (error) {
            console.log(error);
            console.log('⚠️ Unable to load OpenAI cache, starting empty');
        }
        return {};
    }

    get(method, payload) {
        const key = makeCacheKey(method, payload);
        const entry = this.cache[key];
        if (!entry || !entry.response) {
            return null;
        }
        return clone(entry.response);
    }

    set(method, payload, response, selection) {
        const key = makeCacheKey(method, payload);
        const extracted = extractBySpec(response, selection);
        this.cache[key] = {
            //method,
            createdAt: new Date().toISOString(),
            //selection: selection ? clone(selection) : undefined,
            response: extracted
        };
        this.changeCounter++;
        this.save();
    }

    save(force = false) {
        if (!force && this.changeCounter <= this.lastPersistedCounter) {
            return;
        }

        if (force) {
            this.writeRequested = false;
            this.performWriteSync();
            return;
        }

        this.scheduleAsyncWrite();
    }

    scheduleAsyncWrite() {
        if (this.writePromise) {
            this.writeRequested = true;
            return;
        }
        this.writePromise = this.performWriteAsync();
    }

    async performWriteAsync() {
        try {
            this.writeRequested = false;
            while (true) {
                const targetVersion = this.changeCounter;
                if (targetVersion <= this.lastPersistedCounter) {
                    break;
                }

                const data = serializeCache(this.cache);
                await ensureDirAsync(this.cacheFilePath);
                await fsPromises.writeFile(this.cacheFilePath, data);
                this.lastPersistedCounter = targetVersion;

                if (this.changeCounter === targetVersion) {
                    break;
                }
            }
        } catch (error) {
            console.error('⚠️ Failed to save OpenAI cache (async):', error.message);
        } finally {
            this.writePromise = null;
            if (this.changeCounter > this.lastPersistedCounter || this.writeRequested) {
                this.scheduleAsyncWrite();
            }
        }
    }

    performWriteSync() {
        if (this.changeCounter <= this.lastPersistedCounter) {
            return;
        }
        try {
            ensureDirSync(this.cacheFilePath);
            fs.writeFileSync(this.cacheFilePath, serializeCache(this.cache));
            this.lastPersistedCounter = this.changeCounter;
        } catch (error) {
            console.error('⚠️ Failed to save OpenAI cache:', error.message);
        }
    }

    flush() {
        this.performWriteSync();
    }
}

function ensureDirSync(filePath) {
    const dir = path.dirname(filePath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

async function ensureDirAsync(filePath) {
    const dir = path.dirname(filePath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
        await fsPromises.mkdir(dir, { recursive: true }).catch(error => {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        });
    }
}

function migrateCache(existing) {
    if (!existing || typeof existing !== 'object') {
        return { cache: {} };
    }

    const migrated = {};

    for (const [rawKey, value] of Object.entries(existing)) {
        if (!value || typeof value !== 'object') {
            continue;
        }

        const keyString = typeof rawKey === 'string' ? rawKey : String(rawKey);
        const newKey = keyString.length > 16 ? keyString.slice(0, 16) : keyString;

        if (migrated[newKey]) {
            continue;
        }

        migrated[newKey] = {
            createdAt: value.createdAt || new Date().toISOString(),
            response: value.response
        };

    }

    return { cache: migrated };
}

module.exports = {
    cachedResponsesCreate,
    cachedChatCompletion,
    getSharedOpenAICache,
};

