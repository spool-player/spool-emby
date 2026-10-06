// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';

function check(value, message) {
    if (!value)
        throw new Error('settings contract: ' + message);
}
function fails(operation, code) {
    return Promise.resolve().then(operation).then(() => check(false, 'expected ' + code),
        error => check(error.message === code, 'expected ' + code + ', got ' + error.message));
}
const clone = value => JSON.parse(JSON.stringify(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const documentKey = '12345678-1234-4567-89ab-0123456789ab';
const secondKey = '12345678-1234-4567-89ab-0123456789ac';
const dataField = 'spool.data.v1';
const extensions = { 'spool.playback-preferences': 1, 'spool.settings-storage': 1 };
function nested(depth) {
    let value = null;
    for (let i = 0; i < depth; ++i)
        value = { child: value };
    return value;
}

function fixture(emby) {
    const base = 'https://media.example/proxy';
    const prefix = base + (emby ? '/emby' : '');
    const users = {};
    const documents = {};
    const calls = [];
    let failure = null;
    function user(id) {
        if (!users[id])
            users[id] = { Id: id, Policy: { EnableUserPreferenceAccess: true, EnableContentDeletion: false },
                Configuration: { AudioLanguagePreference: 'en', PlayDefaultAudioTrack: true,
                    SubtitleLanguagePreference: null, SubtitleMode: 'Smart', RememberAudioSelections: true,
                    OrderedViews: ['view-2', 'view-1'], Future: { untouched: ['nested', 3] } } };
        return users[id];
    }
    function document(id, key) {
        const identity = id + ':' + key;
        if (!documents[identity])
            documents[identity] = { Id: key, Client: 'Spool', SortBy: 'DateCreated', SortOrder: 'Descending',
                ShowBackdrop: true, Future: { preserve: 7 }, CustomPrefs: { unrelated: 'keep', homesection0: 'library' } };
        return documents[identity];
    }
    const host = {
        isLogEnabled: () => false, log: () => {},
        http: (url, options) => {
            check(url.indexOf(prefix + '/') === 0, 'base path and protocol prefix are preserved');
            const parts = url.slice(prefix.length).split('?');
            const parameters = {};
            for (const part of (parts[1] || '').split('&')) {
                if (!part)
                    continue;
                const pair = part.split('=');
                parameters[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1]);
            }
            const token = emby ? options.headers['X-Emby-Token']
                : /Token="([^"]+)"/.exec(options.headers.Authorization)[1];
            check(token === 'token-ua' || token === 'token-ub', 'request uses signed-in account credentials');
            const id = token.slice(6);
            const path = parts[0];
            const body = options.body ? JSON.parse(options.body) : undefined;
            calls.push({ path: path, method: options.method, body: body });
            if (failure && failure.method === options.method) {
                const status = failure.status;
                failure = null;
                return Promise.resolve({ status: status, body: '{}' });
            }
            let result;
            if (path === '/Users/' + id && options.method === 'GET')
                result = user(id);
            else if (path === '/Users/' + id + '/Configuration' && options.method === 'POST') {
                user(id).Configuration = clone(body);
                result = undefined;
            } else if (path.indexOf('/DisplayPreferences/') === 0) {
                const key = path.slice('/DisplayPreferences/'.length);
                check(parameters[emby ? 'UserId' : 'userId'] === id, 'document partition uses the signed-in user');
                check(!Object.prototype.hasOwnProperty.call(parameters, emby ? 'userId' : 'UserId'),
                    'user query spelling matches the protocol');
                if (!emby || options.method === 'GET')
                    check(parameters[emby ? 'Client' : 'client'] === 'Spool', 'client query matches the protocol');
                if (options.method === 'GET')
                    result = document(id, key);
                else {
                    check(options.method === 'POST' && body.Client === 'Spool', 'writes keep the client in the complete DTO');
                    documents[id + ':' + key] = clone(body);
                    result = undefined;
                }
            } else
                throw new Error('unexpected request ' + options.method + ' ' + path);
            return Promise.resolve({ status: 200, body: result === undefined ? '' : JSON.stringify(result) });
        }
    };
    return {
        host: host, calls: calls, user: user, document: document,
        fail: (method, status) => { failure = { method: method, status: status }; },
        source: (id, offered) => createSource({ server: base, userId: id, token: 'token-' + id },
            { extensions: offered, device: { id: 'test' } })
    };
}

export function settingsContracts(emby = false) {
    const f = fixture(emby);
    const source = f.source('ua', extensions);
    const other = f.source('ub', extensions);
    const legacy = f.source('ua');
    const wrong = f.source('ua', { 'spool.playback-preferences': 2, 'spool.settings-storage': 2 });
    const operations = { preferencesRead: {}, preferencesWrite: { values: { audioMode: 'Smart' } }, dataInfo: {},
        dataRead: { key: documentKey }, dataWrite: { key: documentKey, value: null }, dataDelete: { key: documentKey } };
    let chain = Promise.resolve();
    for (const operation of Object.keys(operations)) {
        for (const unavailable of [legacy, wrong])
            chain = chain.then(() => fails(() => unavailable[operation](operations[operation], f.host), 'unsupported_extension'));
    }
    chain = chain.then(() => {
        check(f.calls.length === 0, 'unsupported calls do no HTTP');
        check(source.dataInfo().conditionalWrites === false && source.dataInfo().maxBytes === 65536,
            'DisplayPreferences advertises bounded replacement storage, never CAS');
        return source.preferencesRead({}, f.host);
    }).then(result => {
        check(result.values.audioLanguage === 'en' && result.values.subtitleLanguage === ''
            && result.values.audioMode === 'Default' && result.values.subtitleMode === 'Smart'
            && result.writable.length === 4, 'user defaults retain language codes for Qt normalization');
        // A change after the prior read must survive the fresh write-side GET.
        f.user('ua').Configuration.Future = { changedElsewhere: 99 };
        return source.preferencesWrite({ values: { audioLanguage: 'fra', subtitleLanguage: 'eng', audioMode: 'Smart' } }, f.host);
    }).then(() => {
        const configuration = f.user('ua').Configuration;
        check(configuration.AudioLanguagePreference === 'fra' && configuration.SubtitleLanguagePreference === 'eng'
            && configuration.PlayDefaultAudioTrack === false && configuration.SubtitleMode === 'Smart', 'only mapped fields change');
        check(configuration.Future.changedElsewhere === 99 && configuration.RememberAudioSelections === true
            && same(configuration.OrderedViews, ['view-2', 'view-1']) && f.user('ua').Policy.EnableContentDeletion === false,
            'fresh full configuration and policy survive writes');
        return other.preferencesRead({}, f.host);
    }).then(result => check(result.values.audioLanguage === 'en', 'account preferences remain isolated'));
    for (const mode of ['Default', 'Smart', 'OnlyForced', 'Always', 'None']) {
        chain = chain.then(() => source.preferencesWrite({ values: { subtitleMode: mode } }, f.host))
            .then(() => source.preferencesRead({}, f.host))
            .then(result => check(result.values.subtitleMode === mode && result.writable.indexOf('subtitleMode') >= 0,
                'every normalized subtitle mode round-trips'));
    }
    for (const mode of ['Default', 'Smart']) {
        chain = chain.then(() => source.preferencesWrite({ values: { audioMode: mode } }, f.host))
            .then(() => source.preferencesRead({}, f.host))
            .then(result => check(result.values.audioMode === mode, 'both normalized audio modes round-trip'));
    }
    chain = chain.then(() => {
        f.user('ua').Configuration.SubtitleMode = 'HearingImpaired';
        delete f.user('ua').Configuration.PlayDefaultAudioTrack;
        return source.preferencesRead({}, f.host);
    }).then(result => {
        check(!Object.prototype.hasOwnProperty.call(result.values, 'subtitleMode')
            && result.writable.indexOf('subtitleMode') < 0 && result.writable.indexOf('audioMode') < 0,
            'unknown or missing enum fields remain read-only');
        return fails(() => source.preferencesWrite({ values: { subtitleMode: 'None' } }, f.host), 'preference_read_only');
    }).then(() => {
        f.user('ua').Configuration.SubtitleMode = 'Default';
        f.user('ua').Configuration.PlayDefaultAudioTrack = true;
        f.user('ua').Policy.EnableUserPreferenceAccess = false;
        return source.preferencesRead({}, f.host);
    }).then(result => {
        check(result.writable.length === 0 && result.values.audioLanguage === 'fra', 'policy denial allows read-only defaults');
        return fails(() => source.preferencesWrite({ values: { audioLanguage: '' } }, f.host), 'permission_denied');
    }).then(() => {
        check(f.user('ua').Configuration.AudioLanguagePreference === 'fra', 'denied changes never reach configuration');
        f.user('ua').Policy.EnableUserPreferenceAccess = true;
        return source.preferencesWrite({ values: { audioLanguage: '' } }, f.host);
    }).then(() => check(f.user('ua').Configuration.AudioLanguagePreference === '', 'empty language clears preference'));
    for (const values of [{ audioMode: 'Automatic' }, { subtitleMode: 'HearingImpaired' }, { audioLanguage: 'en' },
        { subtitleLanguage: 4 }, { EnableContentDeletion: true }, null]) {
        chain = chain.then(() => {
            const count = f.calls.length;
            return fails(() => source.preferencesWrite({ values: values }, f.host), 'invalid_preferences')
                .then(() => check(f.calls.length === count, 'invalid patches fail before HTTP'));
        });
    }
    chain = chain.then(() => {
        f.fail('POST', 403);
        return fails(() => source.preferencesWrite({ values: { audioMode: 'Smart' } }, f.host), 'permission_denied');
    }).then(() => {
        f.fail('GET', 401);
        return fails(() => source.preferencesRead({}, f.host), 'http_401');
    }).then(() => {
        f.fail('GET', 404);
        return fails(() => source.preferencesRead({}, f.host), 'preferences_unavailable');
    }).then(() => source.dataRead({ key: documentKey }, f.host)).then(result => {
        check(result.found === false && !Object.prototype.hasOwnProperty.call(result, 'value'), 'missing key is absent');
        f.document('ua', documentKey).CustomPrefs.concurrent = 'added before write';
        return source.dataWrite({ key: documentKey, value: null }, f.host);
    }).then(() => source.dataRead({ key: documentKey }, f.host)).then(result => {
        check(result.found === true && result.value === null, 'JSON null is present, not absent');
        const dto = f.document('ua', documentKey);
        check(dto.CustomPrefs.concurrent === 'added before write' && dto.CustomPrefs.unrelated === 'keep'
            && dto.CustomPrefs.homesection0 === 'library' && dto.SortBy === 'DateCreated'
            && dto.SortOrder === 'Descending' && dto.ShowBackdrop === true && dto.Future.preserve === 7,
            'replacement write preserves unrelated CustomPrefs and all DTO fields');
        return other.dataRead({ key: documentKey }, f.host);
    }).then(result => {
        check(result.found === false, 'documents are isolated by signed-in user');
        return source.dataWrite({ key: secondKey, value: { text: 'Unicode \u20ac', choices: [false, 7, null] } }, f.host);
    }).then(() => source.dataDelete({ key: documentKey }, f.host)).then(() => source.dataRead({ key: documentKey }, f.host))
        .then(result => {
            check(result.found === false && f.document('ua', documentKey).CustomPrefs.concurrent === 'added before write'
                && f.document('ua', documentKey).Future.preserve === 7, 'delete removes only the owned data field');
            return source.dataRead({ key: secondKey }, f.host);
        }).then(result => check(same(result.value, { text: 'Unicode \u20ac', choices: [false, 7, null] }),
            'separate UUIDs retain independent arbitrary JSON documents'));
    for (const operation of ['dataWrite', 'dataDelete']) {
        for (const condition of [null, 'revision', undefined]) {
            chain = chain.then(() => {
                const count = f.calls.length;
                return fails(() => source[operation]({ key: documentKey, value: null, expectedRevision: condition }, f.host),
                    'unsupported_condition').then(() => check(f.calls.length === count, 'all conditional calls fail before HTTP'));
            });
        }
    }
    for (const key of ['../path', documentKey.toUpperCase(), documentKey.replace(/-/g, ''), documentKey + '\n', 42]) {
        chain = chain.then(() => {
            const count = f.calls.length;
            return fails(() => source.dataRead({ key: key }, f.host), 'invalid_data')
                .then(() => check(f.calls.length === count, 'noncanonical keys never become server paths'));
        });
    }
    chain = chain.then(() => source.dataWrite({ key: documentKey, value: 'x'.repeat(65534) }, f.host))
        .then(() => source.dataRead({ key: documentKey }, f.host))
        .then(result => check(result.value === 'x'.repeat(65534), 'exact 64KiB document round-trips'))
        .then(() => source.dataWrite({ key: documentKey, value: nested(16) }, f.host))
        .then(() => source.dataRead({ key: documentKey }, f.host))
        .then(result => check(same(result.value, nested(16)), 'depth16 document round-trips'));
    for (const entry of [
        { value: 'x'.repeat(65535), error: 'data_too_large' },
        { value: '\u20ac'.repeat(21845), error: 'data_too_large' },
        { value: nested(17), error: 'invalid_data' },
        { value: undefined, error: 'invalid_data' },
        { value: { nested: Infinity }, error: 'invalid_data' }
    ]) {
        chain = chain.then(() => {
            const count = f.calls.length;
            return fails(() => source.dataWrite({ key: documentKey, value: entry.value }, f.host), entry.error)
                .then(() => check(f.calls.length === count, 'invalid outgoing values fail before HTTP'));
        });
    }
    for (const payload of [
        { text: '{broken', error: 'invalid_data' },
        { text: '1e400', error: 'invalid_data' },
        { text: null, error: 'invalid_data' },
        { text: JSON.stringify(nested(17)), error: 'invalid_data' },
        { text: JSON.stringify('x'.repeat(65535)), error: 'data_too_large' }
    ]) {
        chain = chain.then(() => {
            f.document('ua', documentKey).CustomPrefs[dataField] = payload.text;
            const count = f.calls.filter(call => call.method === 'POST').length;
            return fails(() => source.dataRead({ key: documentKey }, f.host), payload.error)
                .then(() => fails(() => source.dataWrite({ key: documentKey, value: null }, f.host), payload.error))
                .then(() => fails(() => source.dataDelete({ key: documentKey }, f.host), payload.error))
                .then(() => check(f.calls.filter(call => call.method === 'POST').length === count
                    && f.document('ua', documentKey).CustomPrefs[dataField] === payload.text,
                    'malformed stored documents are never overwritten or deleted'));
        });
    }
    for (const failure of [{ status: 403, error: 'permission_denied' }, { status: 404, error: 'storage_unavailable' },
        { status: 405, error: 'storage_unavailable' }, { status: 501, error: 'storage_unavailable' },
        { status: 401, error: 'http_401' }]) {
        chain = chain.then(() => {
            f.fail('GET', failure.status);
            return fails(() => source.dataRead({ key: documentKey }, f.host), failure.error);
        });
    }
    return chain;
}
