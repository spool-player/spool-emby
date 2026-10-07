// SPDX-License-Identifier: MPL-2.0
// Optional user preferences and application-owned DisplayPreferences documents.
const maxBytes = 65536;
const dataField = 'spool.data.v1';
const preferenceFields = {
    audioLanguage: 'AudioLanguagePreference', audioMode: 'PlayDefaultAudioTrack',
    subtitleLanguage: 'SubtitleLanguagePreference', subtitleMode: 'SubtitleMode'
};
const subtitleModes = ['Default', 'Smart', 'OnlyForced', 'Always', 'None'];
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function boundedText(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; ++i) {
        const code = text.charCodeAt(i);
        if (code < 128)
            ++bytes;
        else if (code < 2048)
            bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
            && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
            bytes += 4;
            ++i;
        } else
            bytes += 3;
        if (bytes > maxBytes)
            throw new Error('data_too_large');
    }
}

function jsonValue(value, depth) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return;
    if (typeof value === 'number' && Number.isFinite(value))
        return;
    if (typeof value !== 'object' || ++depth > 16)
        throw new Error('invalid_data');
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; ++i)
            jsonValue(value[i], depth);
    } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            throw new Error('invalid_data');
        for (const key of Object.keys(value))
            jsonValue(value[key], depth);
    }
}

function encodeValue(value) {
    jsonValue(value, 0);
    const text = JSON.stringify(value);
    boundedText(text);
    return text;
}

function documentValue(dto) {
    if (!object(dto) || typeof dto.Id !== 'string' || !dto.Id
        || (owns(dto, 'CustomPrefs') && !object(dto.CustomPrefs)))
        throw new Error('invalid_data');
    if (!dto.CustomPrefs || !owns(dto.CustomPrefs, dataField))
        return { found: false };
    const text = dto.CustomPrefs[dataField];
    if (typeof text !== 'string')
        throw new Error('invalid_data');
    boundedText(text);
    let value;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new Error('invalid_data');
    }
    jsonValue(value, 0);
    return { found: true, value: value };
}

function preferenceValues(configuration) {
    const values = {};
    for (const field of ['audioLanguage', 'subtitleLanguage']) {
        const raw = configuration[preferenceFields[field]];
        if (typeof raw === 'string' || raw === null)
            values[field] = raw || '';
    }
    if (typeof configuration.PlayDefaultAudioTrack === 'boolean')
        values.audioMode = configuration.PlayDefaultAudioTrack ? 'Default' : 'Smart';
    // Both protocols support all five normalized modes. Unknown server-specific
    // modes remain read-only rather than silently replacing them with a default.
    if (subtitleModes.indexOf(configuration.SubtitleMode) >= 0)
        values.subtitleMode = configuration.SubtitleMode;
    return values;
}

function preferencePatch(values) {
    if (!object(values))
        throw new Error('invalid_preferences');
    const patch = {};
    for (const key of Object.keys(values)) {
        const value = values[key];
        if (!owns(preferenceFields, key))
            throw new Error('invalid_preferences');
        if (key === 'audioLanguage' || key === 'subtitleLanguage') {
            // Qt normalizes ISO-639-1 on reads; writes use the ISO-639-2 contract.
            if (typeof value !== 'string' || (value !== '' && !/^[a-z]{3}$/.test(value)))
                throw new Error('invalid_preferences');
            patch[preferenceFields[key]] = value;
        } else if (key === 'audioMode') {
            if (value !== 'Default' && value !== 'Smart')
                throw new Error('invalid_preferences');
            patch.PlayDefaultAudioTrack = value === 'Default';
        } else {
            if (subtitleModes.indexOf(value) < 0)
                throw new Error('invalid_preferences');
            patch.SubtitleMode = value;
        }
    }
    return patch;
}

export function createSettings({ request, userPath, capabilities, userId, emby = false }) {
    function requireCapability(id) {
        if (capabilities[id] !== true)
            throw new Error('unsupported_capability');
        if (!userId)
            throw new Error('not_signed_in');
    }
    function featureRequest(feature, host, method, path, parameters, body) {
        return request(host, method, path, parameters, body).catch(error => {
            if (error.message === 'http_403')
                throw new Error('permission_denied');
            if (['http_404', 'http_405', 'http_501'].indexOf(error.message) >= 0)
                throw new Error(feature + '_unavailable');
            throw error;
        });
    }
    function currentUser(host) {
        return featureRequest('preferences', host, 'GET', userPath('')).then(user => {
            if (!object(user) || !object(user.Configuration)
                || (owns(user, 'Policy') && !object(user.Policy)))
                throw new Error('invalid_preferences');
            return user;
        });
    }
    function dataKey(args, mutation) {
        requireCapability('settingsStorage');
        // Weak replacement storage must never perform even a read on a CAS call.
        if (mutation && owns(args, 'expectedRevision'))
            throw new Error('unsupported_condition');
        if (typeof args.key !== 'string' || args.key.length !== 36
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args.key))
            throw new Error('invalid_data');
        return '/DisplayPreferences/' + args.key;
    }
    function dataParameters() {
        return emby ? { UserId: userId, Client: 'Spool' } : { userId: userId, client: 'Spool' };
    }
    function fetchDocument(host, path) {
        return featureRequest('storage', host, 'GET', path, dataParameters()).then(dto => {
            // Validate the old document on mutations too: corruption is never a reset.
            return { dto: dto, result: documentValue(dto) };
        });
    }
    function saveDocument(host, path, dto) {
        dto.Client = 'Spool';
        return featureRequest('storage', host, 'POST', path,
            emby ? { UserId: userId } : dataParameters(), dto).then(() => ({}));
    }
    return {
        preferencesRead: (args, host) => {
            requireCapability('playbackPreferences');
            return currentUser(host).then(user => {
                const values = preferenceValues(user.Configuration);
                return { values: values,
                    writable: user.Policy && user.Policy.EnableUserPreferenceAccess === false ? [] : Object.keys(values) };
            });
        },
        preferencesWrite: (args, host) => {
            requireCapability('playbackPreferences');
            const patch = preferencePatch(args.values);
            return currentUser(host).then(user => {
                if (user.Policy && user.Policy.EnableUserPreferenceAccess === false)
                    throw new Error('permission_denied');
                const values = preferenceValues(user.Configuration);
                for (const key of Object.keys(args.values)) {
                    if (!owns(values, key))
                        throw new Error('preference_read_only');
                }
                if (!Object.keys(patch).length)
                    return {};
                Object.assign(user.Configuration, patch);
                return featureRequest('preferences', host, 'POST', userPath('/Configuration'), {}, user.Configuration)
                    .then(() => ({}));
            });
        },
        dataInfo: () => {
            requireCapability('settingsStorage');
            return { maxBytes: maxBytes, conditionalWrites: false };
        },
        dataRead: (args, host) => {
            const path = dataKey(args, false);
            return fetchDocument(host, path).then(document => document.result);
        },
        dataWrite: (args, host) => {
            const path = dataKey(args, true);
            const text = encodeValue(args.value);
            return fetchDocument(host, path).then(document => {
                const dto = document.dto;
                if (!dto.CustomPrefs)
                    dto.CustomPrefs = {};
                dto.CustomPrefs[dataField] = text;
                return saveDocument(host, path, dto);
            });
        },
        dataDelete: (args, host) => {
            const path = dataKey(args, true);
            return fetchDocument(host, path).then(document => {
                if (!document.result.found)
                    return {};
                delete document.dto.CustomPrefs[dataField];
                return saveDocument(host, path, document.dto);
            });
        }
    };
}
