// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';

const extensions = { 'spool.suggestions': 1, 'spool.item-actions': 1,
    'spool.collection-editing': 1, 'spool.playback-queue-reporting': 1 };
function check(value, message) {
    if (!value)
        throw new Error('catalogue contract: ' + message);
}
function fails(operation, code) {
    return Promise.resolve().then(operation).then(() => {
        throw new Error('catalogue contract: expected ' + code);
    }, error => check(error.message === code, 'expected ' + code + ', got ' + error.message));
}
const response = (value, status = 200) => Promise.resolve({ status: status, body: JSON.stringify(value) });
function parameters(url) {
    const result = {};
    for (const pair of (url.split('?')[1] || '').split('&')) {
        const parts = pair.split('=');
        result[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
    }
    return result;
}

export function catalogueContracts() {
    const entries = [
        { Id: 'film', PlaylistItemId: 0, Type: 'Movie', Name: 'First occurrence' },
        { Id: 'film', PlaylistItemId: 'second/opaque', Type: 'Movie', Name: 'Second occurrence' },
        { Id: 'other', PlaylistItemId: 'last', Type: 'Movie', Name: 'Other' }
    ];
    const policy = { EnableCollectionManagement: true, EnableContentDeletion: true, IsAdministrator: false };
    const configuration = { AudioLanguagePreference: 'fra', SubtitleMode: 'OnlyForced', Unrelated: 'keep' };
    let canEdit = true;
    let canDelete;
    let deniedMutation = false;
    let policyReads = 0;
    let entryReads = 0;
    const calls = [];
    const reports = [];
    const sockets = [];
    let searchPending = [];
    const host = {
        device: { id: 'device' }, extensions: extensions, emit: () => {}, delay: () => new Promise(() => {}),
        socket: () => {
            const socket = { send: () => {}, close: () => {} };
            sockets.push(socket);
            return socket;
        },
        http: (url, options) => {
            const path = url.replace(/^https:\/\/media.example\/base(?:\/emby)?/, '').split('?')[0];
            const query = parameters(url);
            const method = options.method;
            calls.push({ path: path, query: query, method: method });
            if (path === '/Sessions/Capabilities/Full')
                return response({});
            if (path === '/Users/u' && method === 'GET') {
                ++policyReads;
                return response({ Policy: policy, Configuration: configuration });
            }
            if (path === '/Users/u/Items/list')
                return response({ Id: 'list', Type: 'Playlist', CanEditItems: canEdit, CanDelete: canDelete });
            if (path === '/Users/u/Items/box')
                return response({ Id: 'box', Type: 'BoxSet' });
            if (path === '/Users/u/Items/film')
                return response({ Id: 'film', Type: 'Movie', CanDelete: canDelete });
            if (path === '/Playlists/list/Items' && method === 'GET') {
                ++entryReads;
                const first = Number(query.StartIndex);
                return response({ Items: entries.slice(first, first + Number(query.Limit)), TotalRecordCount: entries.length });
            }
            if (path === '/Playlists/list/Items' && method === 'DELETE') {
                if (deniedMutation) {
                    policy.EnableContentDeletion = false;
                    policy.EnableCollectionManagement = false;
                    return response({}, 403);
                }
                const id = query.entryIds === undefined ? query.EntryIds : query.entryIds;
                const index = entries.findIndex(row => String(row.PlaylistItemId) === id);
                if (index < 0)
                    return response({}, 404);
                entries.splice(index, 1);
                return response({});
            }
            const move = /^\/Playlists\/list\/Items\/([^/]+)\/Move\/(\d+)$/.exec(path);
            if (move && method === 'POST') {
                const index = entries.findIndex(row => String(row.PlaylistItemId) === decodeURIComponent(move[1]));
                if (index < 0)
                    return response({}, 404);
                const row = entries.splice(index, 1)[0];
                entries.splice(Number(move[2]), 0, row);
                return response({});
            }
            if (path === '/Collections/box/Items' && method === 'DELETE') {
                check((query.ids || query.Ids) === 'film', 'collection removal uses media identity');
                return response({});
            }
            if (path === '/Users/u/Items') {
                if (query.SearchTerm) {
                    return new Promise(resolve => {
                        searchPending.push({ query: query, resolve: resolve });
                        if (searchPending.length === 2) {
                            check(searchPending[0].query.IncludeItemTypes === 'Series', 'dedicated series starts first');
                            check(searchPending[1].query.IncludeItemTypes.indexOf('Season,Folder,Person,Trailer') >= 0,
                                'search includes only supported extra routes');
                            check(searchPending.every(p => Number(p.query.Limit) === 3), 'both parallel queries are bounded');
                            searchPending[0].resolve({ status: 200, body: JSON.stringify({ Items: [
                                { Id: 'series', Type: 'Series' }, { Id: 'second-series', Type: 'Series' }
                            ] }) });
                            searchPending[1].resolve({ status: 200, body: JSON.stringify({ Items: [
                                { Id: 'film', Type: 'Movie' }, { Id: 'series', Type: 'Series' }, { Id: 'person', Type: 'Person' }
                            ] }) });
                            searchPending = [];
                        }
                    });
                }
                if (query.ParentId === 'box')
                    return response({ Items: [{ Id: 'film', Type: 'Movie' }], TotalRecordCount: 1 });
                check(query.Recursive === 'true' && query.IncludeItemTypes === 'Movie,Series'
                    && query.MediaTypes === 'Video' && query.SortBy === 'IsFavoriteOrLiked,Random'
                    && query.EnableTotalRecordCount === 'false', 'suggestions use the recommendation query, not resume');
                const items = [];
                for (let i = 0; i < Number(query.Limit); ++i)
                    items.push({ Id: 'suggestion-' + i, Type: 'Movie' });
                return response({ Items: items });
            }
            if (path.indexOf('/Sessions/Playing') === 0) {
                reports.push(JSON.parse(options.body));
                return response({});
            }
            if (method !== 'GET')
                throw new Error('unexpected_mutation:' + path);
            return response({}, 404);
        }
    };
    const source = createSource({ server: 'https://media.example/base', token: 'token', userId: 'u' }, host);
    check(policyReads === 0, 'startup does not fetch optional permissions');
    sockets[0].onopen();
    let readsBeforeMove;
    let beforeDenial;
    let callsBeforeLegacy;
    const mutationCount = () => calls.filter(call => call.method !== 'GET').length;
    const snapshot = { revision: 'revision-a', items: [
        { itemId: 'film', entryId: '0', mediaType: 'video' },
        { itemId: 'film', entryId: 'second/opaque', mediaType: 'video' }
    ] };
    const legacy = createSource({ server: 'https://media.example/base', token: 't', userId: 'u' }, { device: {} });
    return source.search({ query: 'query', limit: 3 }, host).then(search => {
        check(search.items.map(row => row.id).join(',') === 'series,second-series,film'
            && search.exhausted && search.cursor === null, 'search prioritizes series and deduplicates bounded union');
        return source.suggestions({ limit: 100 }, host);
    }).then(suggestions => {
        check(suggestions.items.length === 60 && suggestions.exhausted && suggestions.cursor === null,
            'suggestions cap at sixty and are a complete top-N set');
        return source.suggestions({ limit: 2 }, host);
    }).then(suggestions => {
        check(suggestions.items.map(row => row.id).join(',') === 'suggestion-0,suggestion-1',
            'suggestions honor smaller requested limits');
        return source.itemActions({ itemId: 'film', itemType: 'Playlist' }, host);
    }).then(menu => {
        check(menu.actions.some(a => a.id === 'collection') && menu.actions.some(a => a.id === 'delete')
            && !menu.actions.some(a => a.id === 'rename'), 'server type and user policy determine actions');
        return source.itemActions({ itemId: 'film' }, host);
    }).then(() => {
        check(policyReads === 1, 'account policy is cached until invalidation');
        return source.collectionInfo({ containerId: 'list' }, host);
    }).then(info => {
        check(info.ordered && info.removable && info.moveMode === 'index', 'editable playlist supports native moves');
        return source.collectionEntries({ containerId: 'list', limit: 2 }, host);
    }).then(page => {
        check(page.items.map(row => row.entryId).join(',') === '0,second/opaque' && page.cursor === '2',
            'numeric zero and opaque entries distinguish duplicate occurrences');
        readsBeforeMove = entryReads;
        return source.collectionMove({ containerId: 'list', entryId: 'second/opaque', index: 0, afterEntryId: null }, host);
    }).then(() => {
        check(entryReads === readsBeforeMove && entries.map(row => String(row.PlaylistItemId)).join(',') === 'second/opaque,0,last',
            'native index move does not fetch the whole container to find an anchor');
        return source.collectionMove({ containerId: 'list', entryId: 'second/opaque', index: 1, afterEntryId: '0' }, host);
    }).then(() => source.collectionRemove({ containerId: 'list', entryId: 'second/opaque' }, host))
        .then(() => source.collectionEntries({ containerId: 'list', limit: 10 }, host)).then(page => {
            check(page.items.map(row => row.entryId).join(',') === '0,last' && page.items[0].id === 'film',
                'removing the second occurrence preserves the first');
            return fails(() => source.collectionRemove({ containerId: 'list', entryId: 'vanished' }, host), 'http_404');
        }).then(() => source.collectionInfo({ containerId: 'box' }, host)).then(box => {
            check(!box.ordered && box.removable && box.moveMode === 'none', 'collection membership has no order controls');
            return source.collectionEntries({ containerId: 'box', limit: 10 }, host);
        }).then(page => {
            check(page.items[0].entryId === 'film', 'collection entries use membership identity');
            return source.collectionRemove({ containerId: 'box', entryId: 'film' }, host);
        }).then(() => fails(() => source.collectionMove({
            containerId: 'box', entryId: 'film', index: 0, afterEntryId: null
        }, host), 'permission_denied')).then(() => {
            deniedMutation = true;
            return fails(() => source.collectionRemove({ containerId: 'list', entryId: '0' }, host), 'http_403');
        }).then(() => source.itemActions({ itemId: 'film' }, host)).then(menu => {
            check(policyReads === 2 && !menu.actions.some(a => a.id === 'delete' || a.id === 'collection'),
                'permission failure invalidates policy before the next menu');
            beforeDenial = mutationCount();
            return fails(() => source.runItemAction({ itemId: 'film', action: 'delete', confirmed: true }, host),
                'permission_denied');
        }).then(() => {
            check(mutationCount() === beforeDenial, 'baseline action cannot bypass known denied policy');
            canEdit = false;
            return source.collectionInfo({ containerId: 'list' }, host);
        }).then(readonly => {
            check(!readonly.removable && readonly.moveMode === 'none', 'CanEditItems=false removes edit controls');
            return fails(() => source.collectionRemove({ containerId: 'list', entryId: '0' }, host), 'permission_denied');
        }).then(() => {
            policy.EnableContentDeletion = true;
            policy.EnableCollectionManagement = true;
            sockets[0].onmessage(JSON.stringify({ MessageType: 'UserUpdated', Data: { Id: 'u' } }));
            canDelete = false;
            return source.itemActions({ itemId: 'film' }, host);
        }).then(menu => {
            check(policyReads === 3 && menu.actions.some(a => a.id === 'collection') && !menu.actions.some(a => a.id === 'delete'),
                'user changes refresh policy but an explicit item deletion denial wins');
            check(configuration.AudioLanguagePreference === 'fra' && configuration.SubtitleMode === 'OnlyForced'
                && configuration.Unrelated === 'keep', 'catalogue operations leave user preferences untouched');
            canEdit = undefined;
            return source.collectionInfo({ containerId: 'list' }, host);
        }).then(info => {
            check(!info.removable, 'missing rights are not administrator access');
            return source.report({
                event: 'start', itemId: 'film', positionTicks: '9007199254740993', queue: snapshot, queueIndex: 0
            }, host);
        }).then(() => {
            snapshot.items[1].itemId = 'mutated-outside';
            return source.report({ event: 'progress', itemId: 'film', positionTicks: '0', queueIndex: 1 }, host);
        }).then(() => {
            check(reports[1].NowPlayingQueue.map(row => row.Id).join(',') === 'film,film'
                && reports[1].NowPlayingQueue[1].PlaylistItemId === 'second/opaque' && reports[1].PlaylistIndex === 1,
                'progress reuses an immutable queue with duplicate occurrence identity');
            return source.report({ event: 'progress', itemId: 'other', positionTicks: '0', queueIndex: 0,
                queue: { revision: 'revision-b', items: [{ itemId: 'other', mediaType: 'audio' }] } }, host);
        }).then(() => {
            check(reports[2].NowPlayingQueue.length === 1 && reports[2].NowPlayingQueue[0].Id === 'other',
                'new membership revision replaces the source snapshot');
            return source.report({ event: 'stop', itemId: 'other', positionTicks: '0' }, host);
        }).then(() => {
            check(reports[3].NowPlayingQueue === undefined && reports[3].PlaylistIndex === undefined,
                'stop reports retain their existing shape');
            callsBeforeLegacy = calls.length;
            return fails(() => legacy.suggestions({ limit: 5 }, host), 'unsupported_extension');
        }).then(() => fails(() => legacy.itemActions({ itemId: 'film' }, host), 'unsupported_extension'))
            .then(() => fails(() => legacy.collectionInfo({ containerId: 'list' }, host), 'unsupported_extension'))
            .then(() => fails(() => legacy.report({ event: 'start', itemId: 'film', positionTicks: '0', queue: snapshot }, host),
                'unsupported_extension'))
            .then(() => check(calls.length === callsBeforeLegacy, 'unnegotiated optional operations never send HTTP'));
}
