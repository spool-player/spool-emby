// SPDX-License-Identifier: MPL-2.0
// The provider against a scripted Emby, in Qt's own JS engine
// (sdk/provider-contract-runner). Covers what Spool relies on: the /emby
// prefix and its headers, paging, per-account state, exact editions, stream
// safety, chapter markers, sign-in results, item actions and websocket
// translation.

import { createSource, normalizeServer } from '../logic/provider.mjs';
import { translate } from '../logic/events.mjs';

let step = 'start';
function check(value, message) {
    if (!value)
        throw new Error('contract: ' + step + ': ' + message);
}
function respond(value, status) {
    return Promise.resolve({ status: status || 200, body: value === undefined ? '' : JSON.stringify(value) });
}
// Operations may throw at once or reject later; Spool treats both alike.
function fails(operation, code) {
    return Promise.resolve().then(operation).then(() => check(false, 'expected ' + code), error => check(error.message === code,
        'expected ' + code + ', got ' + error.message));
}

const device = { id: 'device-1', name: 'Living "Room"', app: 'Spool', version: '1.0', platform: 'test', locale: 'en' };

// A server keyed by "METHOD path" (below /emby), recording every request.
function server(routes) {
    const calls = [];
    return {
        calls: calls,
        host: {
            device: device, delay: () => new Promise(() => {}),
            http: (url, options) => {
                const method = (options && options.method) || 'GET';
                const prefixed = /^https?:\/\/[^/]+\/emby\//.test(url);
                const path = url.replace(/^https?:\/\/[^/]+\/emby/, '').split('?')[0];
                calls.push({ method: method, url: url, path: path, options: options,
                    body: options && options.body ? JSON.parse(options.body) : undefined });
                const route = prefixed ? routes[method + ' ' + path] : undefined;
                if (route === undefined)
                    return respond({}, 404);
                return typeof route === 'function' ? route(calls[calls.length - 1]) : respond(route);
            }
        }
    };
}

function account(user, token) {
    return createSource({ server: 'https://media.example', userId: user, token: token }, { device: device });
}

export function run() {
    step = 'server address';
    check(normalizeServer('emby.local') === 'http://emby.local:8096', 'a bare host gets the default port');
    check(normalizeServer('https://emby.example/emby/') === 'https://emby.example', 'the /emby suffix goes');
    check(normalizeServer('http://emby.local:9000') === 'http://emby.local:9000', 'an explicit port stays');

    const a = account('ua', 'token-a');
    const b = account('ub', 'token-b');
    check(a.describe().artwork.indexOf('https://media.example/emby/Items/{itemId}/Images/{type}?tag={tag}') === 0,
        'artwork template');

    const film = { Id: 'film', Name: 'Film', Type: 'Movie', ProductionYear: 2020, RunTimeTicks: 72000000000,
        ProviderIds: { Imdb: 'tt1' }, UserData: { IsFavorite: true, PlaybackPositionTicks: 500 },
        Chapters: [{ StartPositionTicks: 0 }, { StartPositionTicks: 100, MarkerType: 'IntroStart' },
            { StartPositionTicks: 900, MarkerType: 'IntroEnd' }, { StartPositionTicks: 70000000000, MarkerType: 'CreditsStart' }],
        MediaSources: [
            { Id: 'extended', Name: 'Extended', Path: '/srv/private/Film (Extended).mkv', Size: 9007199254740993,
                Container: 'mkv', MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'hevc', Height: 2160,
                    VideoRange: 'HDR', ExtendedVideoType: 'DolbyVision' }] },
            { Id: 'theatrical', Name: 'Theatrical', Path: 'D:\\media\\Film.mp4', Container: 'mp4' }] };
    const emby = server({
        'GET /Users/ua/Items': () => respond({ TotalRecordCount: 3, Items: [film] }),
        'GET /Users/ub/Items': () => respond({ TotalRecordCount: 3, Items: [film] }),
        'GET /Users/ua/Items/Latest': [film, { Id: 42, Name: 'Show', Type: 'Series' }],
        'GET /Users/ua/Items/film': film,
        'GET /Users/ua/Views': { Items: [{ Id: 'movies', Name: 'Movies', CollectionType: 'movies',
            ImageTags: { Primary: 'p' } }] },
        'GET /Genres': { Items: [{ Name: 'Drama' }] },
        'GET /Years': { Items: [{ Name: '2020' }] },
        'POST /Items/film/PlaybackInfo': call => respond({ PlaySessionId: 'session', MediaSources: [
            { Id: 'theatrical', SupportsDirectPlay: true, Container: 'mp4' },
            { Id: 'extended', SupportsDirectPlay: call.body.MediaSourceId !== 'extended',
                SupportsDirectStream: false, Container: 'mkv',
                TranscodingUrl: call.body.EnableDirectPlay ? '/videos/film/master.m3u8?x=1'
                                                         : 'https://elsewhere.example/steal.m3u8' }] }),
        'POST /Playlists': {},
        'POST /Playlists/list-1/Items': {},
        'POST /Items/film/Delete': {},
        'POST /Sessions/Playing': {}
    });

    step = 'search';
    return Promise.all([a.search({ query: 'Film', limit: 1 }, emby.host), b.search({ query: 'Film', limit: 1 }, emby.host)])
        .then(pages => {
            const page = pages[0];
            check(page.total === 3 && !page.exhausted && page.cursor === '1', 'paging from TotalRecordCount');
            const found = page.items[0];
            check(found.externalIds.Imdb === 'tt1' && found.resumeTicks === '500' && found.favorite, 'user data');
            const first = emby.calls[0].options.headers;
            check(first['X-Emby-Token'] === 'token-a' && emby.calls[1].options.headers['X-Emby-Token'] === 'token-b',
                'each account sends its own token');
            check(first['X-Emby-Authorization'].indexOf('Device="Living Room"') >= 0,
                'header values cannot break out of quotes');
            check(emby.calls[0].url.indexOf('SearchTerm=Film') > 0 && emby.calls[0].url.indexOf('Limit=1') > 0, 'query');
            return a.search({ query: 'Film', limit: 1, cursor: page.cursor }, emby.host);
        }).then(() => {
            check(emby.calls[emby.calls.length - 1].url.indexOf('StartIndex=1') > 0, 'the cursor is the next offset');
            return fails(() => a.search({ query: 'x', cursor: '../1' }, emby.host), 'invalid_cursor');
        }).then(() => {
            step = 'lists';
            return a.latest({ limit: 5 }, emby.host);
        }).then(page => {
            check(page.items.length === 2 && page.exhausted, 'latest is a plain array');
            check(page.items[1].id === '42', 'numeric ids become strings');
            return a.libraries({}, emby.host);
        }).then(result => {
            check(result.items[0].collectionType === 'movies' && result.items[0].posterTag === 'p', 'libraries');
            return a.filterOptions({ parentId: 'movies', collectionType: 'movies' }, emby.host);
        }).then(options => {
            check(options.genres[0] === 'Drama' && options.years[0] === 2020 && options.tags.length === 0,
                'filter options, with the missing ones empty');
            step = 'details';
            return a.details({ itemId: 'film' }, emby.host);
        }).then(result => {
            const variants = result.item.variants;
            check(variants[0].filename === 'Film (Extended).mkv' && variants[1].filename === 'Film.mp4',
                'only file names leave the server');
            check(JSON.stringify(result).indexOf('private') < 0, 'no server paths');
            check(variants[0].sizeBytes === undefined, 'unsafe sizes are dropped, not rounded');
            check(variants[0].streams[0].rangeType === 'DOVI', 'HDR formats in Spool\'s names');
            return fails(() => a.details({ itemId: '' }, emby.host), 'missing_id');
        }).then(() => {
            step = 'resolve';
            return a.resolve({ itemId: 'film', variantId: 'theatrical', positionTicks: '0', maxBitrate: 0,
                videoCodecs: ['h264'], restrictVideoCodecs: true }, emby.host);
        }).then(result => {
            check(result.variantId === 'theatrical' && result.playMethod === 'DirectPlay', 'direct play');
            check(result.url.indexOf('https://media.example/emby/Videos/film/stream?') === 0
                && result.url.indexOf('MediaSourceId=theatrical') > 0, 'stream URL');
            check(result.headers['X-Emby-Token'] === 'token-a', 'stream credentials');
            check(result.segments.length === 2 && result.segments[0].type === 'Intro'
                && result.segments[0].startTicks === '100' && result.segments[0].endTicks === '900'
                && result.segments[1].type === 'Outro' && result.segments[1].endTicks === '72000000000',
                'intro and credits from chapter markers');
            return a.resolve({ itemId: 'film', variantId: 'extended', positionTicks: '0' }, emby.host);
        }).then(result => {
            check(result.playMethod === 'Transcode'
                && result.url === 'https://media.example/emby/videos/film/master.m3u8?x=1', 'relative transcode');
            return fails(() => a.resolve({ itemId: 'film', variantId: 'extended', positionTicks: '0', forceTranscode: true },
                emby.host), 'cross_origin_stream');
        }).then(() => fails(() => a.resolve({ itemId: 'film', variantId: 'missing', positionTicks: '0' }, emby.host),
            'selected_variant_unavailable'))
        .then(() => {
            step = 'report';
            return a.report({ event: 'start', itemId: 'film', variantId: 'theatrical', playSessionId: 'session',
                playMethod: 'DirectPlay', positionTicks: '10', rate: 1, audioStreamIndex: -1,
                subtitleStreamIndex: 2 }, emby.host);
        }).then(() => {
            const body = emby.calls[emby.calls.length - 1].body;
            check(body.PositionTicks === 10 && body.AudioStreamIndex === undefined && body.SubtitleStreamIndex === 2,
                'report body');
            return fails(() => a.report({ event: 'bogus' }, emby.host), 'invalid_report');
        }).then(() => {
            step = 'item actions';
            return a.runItemAction({ action: 'playlist', itemId: 'film', itemType: 'Movie' }, emby.host);
        }).then(result => {
            check(result.pick && result.pick.kind === 'playlist', 'adding asks where first');
            return a.runItemAction({ action: 'playlist', itemId: 'film', newName: 'Weekend' }, emby.host);
        }).then(result => {
            check(result.message === 'Added to Weekend', 'a new playlist');
            check(emby.calls[emby.calls.length - 1].url.indexOf('Ids=film') > 0, 'with the item in it');
            return a.runItemAction({ action: 'playlist', itemId: 'film', targetId: 'list-1', targetName: 'Mine' },
                emby.host);
        }).then(result => {
            check(result.message === 'Added to Mine', 'an existing playlist');
            return a.runItemAction({ action: 'delete', itemId: 'film' }, emby.host);
        }).then(result => {
            check(result.pick && result.pick.kind === 'confirm', 'deleting asks first');
            check(!emby.calls.some(c => c.path === '/Items/film/Delete'), 'and deletes nothing until confirmed');
            return a.runItemAction({ action: 'delete', itemId: 'film', confirmed: true }, emby.host);
        }).then(result => {
            check(result.changed, 'a confirmed delete reports a change');
            return fails(() => a.runItemAction({ action: 'explode', itemId: 'film' }, emby.host), 'unsupported_action');
        }).then(() => {
            step = 'browse filters';
            return a.browse({ parentId: 'movies', collectionType: 'movies', limit: 10, sortBy: 'DateCreated',
                filters: { filters: ['IsUnplayed'], genres: ['Drama', 'Sci-Fi'], years: ['2020', '2021'], isHd: true,
                    is3D: false, alphabet: '#' } }, emby.host);
        }).then(() => {
            const url = emby.calls[emby.calls.length - 1].url;
            check(url.indexOf('filters=IsUnplayed') > 0 && url.indexOf('genres=Drama%7CSci-Fi') > 0
                && url.indexOf('years=2020%2C2021') > 0 && url.indexOf('isHd=true') > 0, 'filters reach the server');
            check(url.indexOf('is3D') < 0 && url.indexOf('NameLessThan=A') > 0 && url.indexOf('SortBy=DateCreated') > 0,
                'unset filters stay off, # is before A');
            step = 'errors';
            return fails(() => a.libraries({}, { device: device, http: () => respond({}, 401) }), 'http_401');
        }).then(() => {
            step = 'sign in';
            const login = createSource({}, { device: device });
            const setup = server({
                'GET /System/Info/Public': { Id: 'server-id', ServerName: 'Home', Version: '4.8.0' },
                'GET /Users/Public': [{ Id: 'u1', Name: 'Ann', HasPassword: false }],
                'POST /Users/AuthenticateByName': call => call.body.Pw === 'right'
                    ? respond({ AccessToken: 'new-token', ServerId: 'server-id', User: { Id: 'u1', Name: 'Ann' } })
                    : respond({}, 401)
            });
            return login.probe({ server: 'emby.local' }, setup.host).then(found => {
                check(found.server === 'http://emby.local:8096' && found.name === 'Home', 'probe finds the server');
                check(found.users[0].hasPassword === false, 'public users');
                check(!setup.calls[0].options.headers['X-Emby-Token'], 'no token before sign-in');
                return fails(() => login.authenticate({ server: 'emby.local', username: 'Ann', password: 'wrong' },
                    setup.host), 'http_401');
            }).then(() => login.authenticate({ server: 'emby.local', username: 'Ann', password: 'right' }, setup.host))
                .then(result => {
                    check(result.account === 'u1@server-id' && result.group === 'server-id', 'account identity');
                    check(result.label === 'Ann' && result.detail === 'Home', 'account label');
                    check(result.configuration.token === 'new-token'
                        && result.configuration.server === 'http://emby.local:8096', 'configuration');
                    const jellyfin = server({ 'GET /System/Info/Public': { Id: 'j', ProductName: 'Jellyfin Server' } });
                    return fails(() => login.probe({ server: 'jf.local' }, jellyfin.host), 'not_emby');
                });
        }).then(() => {
            step = 'events';
            const events = [];
            const emit = (type, payload) => events.push([type, payload]);
            translate({ MessageType: 'Playstate', Data: { Command: 'Seek', SeekPositionTicks: 7 } }, emit);
            translate({ MessageType: 'GeneralCommand', Data: { Name: 'SetVolume', Arguments: { Volume: '40' } } }, emit);
            translate({ MessageType: 'GeneralCommand', Data: { Name: 'Unknown' } }, emit);
            translate({ MessageType: 'Play', Data: { ItemIds: [7], PlayCommand: 'PlayNext' } }, emit);
            translate({ MessageType: 'UserDataChanged', Data: { UserDataList: [{ ItemId: 'film' }] } }, emit);
            translate({ MessageType: 'LibraryChanged', Data: {} }, emit);
            check(events.length === 5, 'unknown commands are dropped');
            check(events[0][1].command === 'seek' && events[0][1].positionTicks === '7', 'remote seek');
            check(events[1][1].command === 'volume' && events[1][1].value === 40, 'remote volume');
            check(events[2][1].itemIds[0] === '7' && events[2][1].mode === 'next', 'remote play');
            check(events[3][0] === 'changed' && events[3][1].itemId === 'film', 'user data changes');
            check(events[4][0] === 'changed', 'library changes');
        });
}
