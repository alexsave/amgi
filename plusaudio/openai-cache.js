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

function parseFunctionCallArguments(raw) {
    if (!raw) {
        return {};
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch (error) {
            return {};
        }
    }
    if (typeof raw === 'object') {
        return raw;
    }
    return {};
}

function mapFunctionCallOutput(source, transform) {
    if (!source || !Array.isArray(source.output)) {
        return { output: [] };
    }

    const output = source.output
        .filter(item => item && item.type === 'function_call')
        .map(item => {
            const args = clone(parseFunctionCallArguments(item.arguments));
            return transform(item, args);
        })
        .filter(Boolean);

    return { output };
}

function setNested(target, path, value) {
    const parts = path.split('.').filter(Boolean);
    if (parts.length === 0) {
        return;
    }
    let current = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part] || typeof current[part] !== 'object') {
            current[part] = {};
        }
        current = current[part];
    }
    current[parts[parts.length - 1]] = value;
}

function extractOutputSelection(source, selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    return mapFunctionCallOutput(source, (call, args) => {
        const parsedArgs = parseFunctionCallArguments(args);
        const entry = {};
        const ensureArgs = () => {
            if (!entry.arguments) {
                entry.arguments = {};
            }
            return entry.arguments;
        };

        for (const selector of list) {
            const parts = selector.split('.').slice(1); // remove leading 'output'
            if (parts.length === 0) continue;

            if (parts[0] === 'arguments') {
                const argPath = parts.slice(1).join('.');
                const value = argPath ? getByPath(parsedArgs, argPath) : clone(parsedArgs);
                if (value !== undefined && value !== null) {
                    if (!argPath) {
                        entry.arguments = clone(value);
                    } else {
                        setNested(ensureArgs(), argPath, value);
                    }
                }
            } else {
                const callPath = parts.join('.');
                const value = getByPath(call, callPath);
                if (value !== undefined && value !== null) {
                    setNested(entry, callPath, value);
                }
            }
        }

        if (Object.keys(entry).length === 0) {
            return null;
        }
        if (entry.arguments && Object.keys(entry.arguments).length === 0) {
            delete entry.arguments;
        }
        return entry;
    });
}

function extractBySpec(data, selection) {
    if (selection === undefined) {
        return data ?? null;
    }

    const visit = (source, spec) => {
        if (spec === true) {
            return source;
        }

        if (source == null) {
            return undefined;
        }

        if (typeof spec === 'string') {
            if (spec.startsWith('output.')) {
                return extractOutputSelection(source, spec);
            }
            return getByPath(source, spec);
        }

        if (Array.isArray(spec)) {
            const outputSelectors = spec.filter(selector => typeof selector === 'string' && selector.startsWith('output.'));
            if (outputSelectors.length === spec.length && outputSelectors.length > 0) {
                return extractOutputSelection(source, spec);
            }

            return spec
                .map(selector => visit(source, selector))
                .filter(value => value !== undefined);
        }

        if (typeof spec === 'object') {
            if (Array.isArray(source)) {
                const mapped = source
                    .map(item => visit(item, spec))
                    .filter(value => value !== undefined);
                return mapped.length > 0 ? mapped : undefined;
            }

            const result = {};
            for (const [key, childSpec] of Object.entries(spec)) {
                const value = visit(source[key], childSpec);
                if (value !== undefined) {
                    result[key] = value;
                }
            }
            return Object.keys(result).length > 0 ? result : undefined;
        }

        return undefined;
    };

    const extracted = visit(data, selection);
    return extracted === undefined ? null : extracted;
}

function getByPath(source, pathSpec) {
    if (!pathSpec || !pathSpec.trim()) {
        return source;
    }
    const parts = pathSpec
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .map(part => part.trim())
        .filter(Boolean);

    let current = source;
    for (const part of parts) {
        if (current == null) {
            return undefined;
        }
        if (Array.isArray(current)) {
            const index = Number(part);
            if (Number.isNaN(index) || index < 0 || index >= current.length) {
                return undefined;
            }
            current = current[index];
        } else {
            if (part === 'arguments' && current.arguments !== undefined) {
                current = parseFunctionCallArguments(current.arguments);
            } else {
                current = current[part];
            }
        }
    }
    return current;
}

function makeCacheKey(method, payload) {
    const serializedPayload = stableStringify(payload || {});
    const hash = crypto
        .createHash('sha256')
        .update(`${method}|${serializedPayload}`)
        .digest('hex');
    return hash.slice(0, 16);
}

let sharedCache = null;

function getSharedOpenAICache(cacheFilePath) {
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
                    const { cache, changed } = migrateCache(parsed);
                    if (changed) {
                        try {
                            ensureDirSync(this.cacheFilePath);
                            fs.writeFileSync(this.cacheFilePath, JSON.stringify(cache));
                        } catch (error) {
                            console.error('⚠️ Failed to migrate OpenAI cache:', error.message);
                        }
                    }
                    return cache;
                }
            }
        } catch (error) {
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

                const data = JSON.stringify(this.cache);
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
            fs.writeFileSync(this.cacheFilePath, JSON.stringify(this.cache));
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
        return { cache: {}, changed: true };
    }

    let changed = false;
    const migrated = {};

    for (const [rawKey, value] of Object.entries(existing)) {
        if (!value || typeof value !== 'object') {
            changed = true;
            continue;
        }

        const keyString = typeof rawKey === 'string' ? rawKey : String(rawKey);
        const newKey = keyString.length > 16 ? keyString.slice(0, 16) : keyString;
        if (newKey !== keyString) {
            changed = true;
        }

        const method = value.method || 'responses.create';
        if (method !== value.method) {
            changed = true;
        }

        const extracted = extractBySpec(value.response, value.selection ?? null);
        if (JSON.stringify(extracted) !== JSON.stringify(value.response || null)) {
            changed = true;
        }

        if (migrated[newKey]) {
            changed = true;
            continue;
        }

        migrated[newKey] = {
            //method,
            createdAt: value.createdAt || new Date().toISOString(),
            response: extracted,
            //selection: value.selection ?? null
        };

        if (!value.createdAt) {
            changed = true;
        }
    }

    return { cache: migrated, changed };
}

module.exports = {
    OpenAICache,
    getSharedOpenAICache,
    cachedOpenAICall,
    cachedChatCompletion,
    cachedResponsesCreate,
    stableStringify
};

