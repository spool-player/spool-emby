// SPDX-License-Identifier: MPL-2.0
// The provider against a scripted Emby, in Qt's own JS engine
// (sdk/provider-contract-runner). Covers what Spool relies on: the /emby
// prefix and its headers, paging, per-account state, exact editions, stream
// safety, chapter markers, sign-in results, item actions and websocket
// translation.

import { createSource, normalizeServer } from '../logic/provider.mjs';
import { translate } from '../logic/events.mjs';
import { canCopySource, deviceProfile, maxBitrate, maxHeight } from '../logic/profile.mjs';
import { item } from '../logic/items.mjs';

import { catalogueContracts } from './catalogue.mjs';
import { settingsContracts } from './settings.mjs';
import { remoteContracts } from './remote.mjs';
import { connectContracts } from './connect.mjs';
import { downloadContracts } from './downloads.mjs';
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
            isLogEnabled: () => false, log: () => {},
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

function account(user, token, extensions) {
    const host = { device: device };
    if (extensions !== undefined)
        host.extensions = extensions;
    return createSource({ server: 'https://media.example', userId: user, token: token }, host);
}

function extensionCompatibility() {
    step = 'optional extensions and legacy artwork';
    const legacy = account('ua', 'token');
    const declared = { 'spool.artwork-owners': 1, 'spool.speed-test': 1, 'spool.lan-probe': 1,
        'spool.suggestions': 1, 'spool.item-actions': 1, 'spool.collection-editing': 1,
        'spool.playback-queue-reporting': 1, 'spool.playback-preferences': 1, 'spool.settings-storage': 1,
        'spool.remote-targets': 1 };
    const current = account('ua', 'token', declared);
    const wrong = account('ua', 'token', { 'spool.artwork-owners': 2, 'spool.speed-test': '1', 'future.feature': 1 });
    check(Object.keys(legacy.describe().extensions).length === 0
        && Object.keys(declared).every(id => legacy.extensionStatus().missingHost.indexOf(id) >= 0),
        'absent host extensions require an update regardless of device version');
    check(Object.keys(wrong.extensionStatus().enabled).length === 0, 'only exact supported wire majors enable features');
    check(current.describe().extensions['spool.artwork-owners'] === 1
        && current.extensionStatus().enabled['spool.speed-test'] === 1
        && current.extensionStatus().missingHost.length === 0, 'supported declarations become account offers');
    const raw = { Id: 'episode', Type: 'Episode', SeriesId: 'series', SeriesPrimaryImageTag: 'series-poster',
        AlbumId: 'album', AlbumPrimaryImageTag: 'album-poster', ImageTags: { Primary: 'own-poster' },
        ParentThumbItemId: 'season', ParentThumbImageTag: 'parent-thumb',
        ParentBackdropItemId: 'series', ParentBackdropImageTags: ['parent-backdrop'] };
    const fixture = server({ 'GET /Users/ua/Items': { Items: [raw], TotalRecordCount: 1 },
        'GET /Users/ua/Items/episode': raw });
    let probes = 0;
    fixture.host.speedTest = options => {
        ++probes;
        check(options.url === 'https://media.example/emby/Playback/BitrateTest?Size={bytes}&_={nonce}'
            && options.headers['X-Emby-Token'] === 'token', 'negotiated probes preserve authenticated Emby endpoint');
        return Promise.resolve({ bitrate: 36000000, parallelRequests: 2 });
    };
    return fails(() => legacy.speedTest({}, fixture.host), 'unsupported_extension')
        .then(() => fails(() => wrong.speedTest({}, fixture.host), 'unsupported_extension')).then(() => {
            check(fixture.calls.length === 0 && probes === 0, 'unsupported speed tests fail before HTTP or native probes');
            return current.speedTest({}, fixture.host);
        }).then(() => Promise.all([legacy.browse({ limit: 5 }, fixture.host), current.browse({ limit: 5 }, fixture.host),
            legacy.details({ itemId: 'episode' }, fixture.host), current.details({ itemId: 'episode' }, fixture.host)]))
        .then(results => {
            for (const row of [results[0].items[0], results[2].item]) {
                check(!row.thumbTag && !row.backdropTag && !row.thumbItemId && !row.backdropItemId,
                    'legacy pages and details never attach inherited images to the child');
                check(row.posterTag === 'own-poster' && row.seriesPosterTag === 'series-poster'
                    && row.albumPosterTag === 'album-poster', 'own images and baseline poster fallbacks remain');
            }
            for (const row of [results[1].items[0], results[3].item])
                check(row.thumbItemId === 'season' && row.thumbTag === 'parent-thumb'
                    && row.backdropItemId === 'series' && row.backdropTag === 'parent-backdrop',
                    'each source applies its own negotiated artwork options');
        });
}

function lanDiscovery() {
    step = 'consented local discovery';
    const source = createSource({}, { device: device, extensions: { 'spool.lan-probe': 1 } });
    const response = (id, overrides) => ({ origin: 'http://127.0.0.1:8096', status: 200,
        body: JSON.stringify(Object.assign({ Id: id, ServerName: 'Local server', Version: '4.8.0',
            ProductName: 'Emby Server', LocalAddress: 'http://untrusted.example' }, overrides || {})) });
    const pages = [
        { responses: [response('one'), response('one'), response('foreign', { ProductName: 'Jellyfin' }),
            response('invalid', { ServerName: 42 }), response('', {}),
            { origin: 'http://127.0.0.1:8096', status: 200, body: 'not json' },
            Object.assign(response('redirect'), { status: 302 })], cursor: 'opaque:next', exhausted: false },
        { responses: [response('one'), response('two')], cursor: null, exhausted: true },
        { responses: [response('one')], cursor: null, exhausted: true }
    ];
    let calls = 0;
    const host = { probeLocalHttp: options => {
        check(options.port === 8096 && options.path === '/emby/System/Info/Public' && options.limit === 32,
            'bounded public-info discovery uses the unauthenticated native probe');
        check(calls === 1 ? options.cursor === 'opaque:next' : options.cursor === undefined,
            'opaque continuation is forwarded; fresh searches do not carry a cursor');
        return Promise.resolve(pages[calls++]);
    } };
    return fails(() => createSource({}, { device: device }).discoverMore({}, host), 'unsupported_extension')
        .then(() => fails(() => createSource({}, { extensions: { 'spool.lan-probe': 2 } }).discoverMore({}, host),
            'unsupported_extension'))
        .then(() => fails(() => source.discoverMore({}, {}), 'unsupported_extension'))
        .then(() => {
            check(calls === 0, 'old hosts cannot start local probing');
            return source.discoverMore({}, host);
        }).then(first => {
            check(first.servers.length === 1 && first.servers[0].id === 'one'
                && first.servers[0].address === 'http://127.0.0.1:8096'
                && first.cursor === 'opaque:next' && first.exhausted === false,
                'only validated Emby public info is offered, using the probed origin rather than advertised URLs');
            return source.discoverMore({ cursor: first.cursor }, host);
        }).then(second => {
            check(second.servers.length === 1 && second.servers[0].id === 'two'
                && second.cursor === null && second.exhausted === true,
                'duplicate server IDs across pages are omitted without losing terminal state');
            return source.discoverMore({}, host);
        }).then(restarted => {
            check(restarted.servers.length === 1 && restarted.servers[0].id === 'one', 'fresh scans reset seen IDs');
            return source.discoverMore({}, { probeLocalHttp: () =>
                Promise.resolve({ responses: [], cursor: null, exhausted: true }) });
        })
        .then(empty => check(empty.servers.length === 0 && empty.exhausted === true,
            'no local interfaces leaves an empty completed search'));
}

function previewContracts() {
    step = 'item-scoped Emby BIF descriptors';
    let thumbnails = { AspectRatio: 16 / 9, Thumbnails: [{ PositionTicks: 0, ImageTag: 'first' }] };
    let metadata = { Id: 'film', MediaSources: [{ Id: 'film' }, { Id: 'alternate' }] };
    const fixture = server({
        'POST /Items/film/PlaybackInfo': { MediaSources: ['film', 'alternate'].map(Id => ({ Id: Id, SupportsDirectPlay: true })) },
        'GET /Users/ua/Items/film': () => respond(metadata),
        'GET /Items/film/ThumbnailSet': call => {
            check(call.url.indexOf('Width=320') > 0, 'thumbnail discovery specifies the requested width');
            check(call.options.headers['X-Emby-Token'] === 'preview-token',
                'thumbnail availability discovery is account-authenticated');
            return thumbnails ? respond(thumbnails) : respond({}, 404);
        }
    });
    const source = account('ua', 'preview-token');
    const resolve = (variantId, videoPreviews = true) => source.resolve({
        itemId: 'film', variantId: variantId, positionTicks: '0', videoPreviews: videoPreviews
    }, fixture.host);
    return resolve('film').then(result => {
        check(result.trickplay.format === 'bif'
            && result.trickplay.url === 'https://media.example/emby/Videos/film/index.bif?Width=320',
            'available item thumbnails resolve the documented whole BIF endpoint');
        check(result.trickplay.headers['X-Emby-Token'] === 'preview-token'
            && result.trickplay.url.indexOf('preview-token') < 0, 'BIF authorization never enters the URL');
        return resolve('alternate');
    }).then(result => {
        check(result.trickplay === undefined && result.playMethod === 'DirectPlay',
            'an alternate version cannot use a different item-scoped index');
        metadata = { Id: 'another-item', MediaSources: [{ Id: 'film' }] };
        return resolve('film');
    }).then(result => {
        check(result.trickplay === undefined && result.playMethod === 'DirectPlay',
            'mismatched item metadata cannot redirect the selected item index');
        metadata = { Id: 'film', MediaSources: [{ Id: 'film' }] };
        thumbnails = { Thumbnails: [] };
        return resolve('film');
    }).then(result => {
        check(result.trickplay === undefined && result.playMethod === 'DirectPlay', 'empty indexes do not fail playback');
        thumbnails = null;
        return resolve('film');
    }).then(result => {
        check(result.trickplay === undefined && result.playMethod === 'DirectPlay',
            'unsupported thumbnail discovery does not fail playback');
        thumbnails = { Thumbnails: [{ PositionTicks: 0 }] };
        metadata = { Id: 'film', MediaSources: [{ Id: 'film' }] };
        const before = fixture.calls.filter(call => call.path.endsWith('/ThumbnailSet')).length;
        return resolve('film', false).then(result => {
            check(!result.trickplay && result.playMethod === 'DirectPlay', 'disabled previews do not alter playback');
            check(fixture.calls.filter(call => call.path.endsWith('/ThumbnailSet')).length === before,
                'disabled local previews make no thumbnail discovery request');
            return source.details({ itemId: 'film', videoPreviews: false }, fixture.host);
        }).then(result => check(result.item.id === 'film',
            'disabled previews retain ordinary details without thumbnail discovery'));
    });
}

export function run() {
    step = 'inherited artwork owners';
    const inherited = { Id: 'episode', Type: 'Episode', SeriesId: 'series',
        ParentBackdropItemId: 'series', ParentBackdropImageTags: ['series-backdrop'],
        ParentThumbItemId: 'season', ParentThumbImageTag: 'season-thumb' };
    const inheritedImages = item(inherited, { artworkOwners: true });
    check(inheritedImages.backdropItemId === 'series' && inheritedImages.backdropTag === 'series-backdrop'
        && inheritedImages.thumbItemId === 'season' && inheritedImages.thumbTag === 'season-thumb',
        'inherited thumbnail and backdrop keep their distinct owners');
    const ownImages = item(Object.assign({}, inherited, { ImageTags: { Thumb: 'own-thumb' },
        BackdropImageTags: ['own-backdrop'] }), { artworkOwners: true });
    check(!ownImages.thumbItemId && !ownImages.backdropItemId && ownImages.thumbTag === 'own-thumb'
        && ownImages.backdropTag === 'own-backdrop', 'own images never inherit a parent owner');
    const ownerless = item({ Id: 'episode', ParentThumbImageTag: 'unknown',
        ParentBackdropImageTags: ['unknown'] }, { artworkOwners: true });
    check(!ownerless.thumbTag && !ownerless.backdropTag, 'unknown parent ownership cannot create a child image URL');
    step = 'server address';
    check(normalizeServer('emby.local') === 'https://emby.local', 'a bare DNS host tries HTTPS first');
    check(normalizeServer('https://emby.example/emby/') === 'https://emby.example', 'the /emby suffix goes');
    check(normalizeServer('http://emby.local:9000') === 'http://emby.local:9000', 'an explicit port stays');
    check(normalizeServer('[::1]') === 'http://[::1]:8096', 'IPv6 gets the default port');
    check(normalizeServer('http://proxy.example/media/emby') === 'http://proxy.example/media', 'proxy base path stays');
    for (const address of ['', 'ftp://server', 'https://name:password@server', 'https://server?api_key=secret',
        'https://server:99999', 'https://server\\@elsewhere']) {
        let rejected = false;
        try {
            normalizeServer(address);
        } catch (error) {
            rejected = error.message === 'invalid_server';
        }
        check(rejected, 'unsafe server address is rejected: ' + address);
    }

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
        'GET /Users/ua': { Policy: { EnableContentDeletion: true } },
        'GET /Users/ua/Items/list-1': { Id: 'list-1', Type: 'Playlist', CanEditItems: true },
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

    step = 'browse';
    return Promise.all([a.browse({ limit: 1 }, emby.host), b.browse({ limit: 1 }, emby.host)])
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
            return a.browse({ limit: 1, cursor: page.cursor }, emby.host);
        }).then(() => {
            check(emby.calls[emby.calls.length - 1].url.indexOf('StartIndex=1') > 0, 'the cursor is the next offset');
            return fails(() => a.browse({ cursor: '../1' }, emby.host), 'invalid_cursor');
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
            check(emby.calls[emby.calls.length - 1].url.indexOf('Ids=film') > 0, 'with the item in it');
            return a.runItemAction({ action: 'playlist', itemId: 'film', targetId: 'list-1', targetName: 'Mine' },
                emby.host);
        }).then(result => {
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
            return fails(() => a.libraries({}, { device: device, log: () => {}, http: () => respond({}, 401) }), 'http_401');
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
                check(found.server === 'https://emby.local' && found.name === 'Home', 'probe finds the server');
                check(found.users[0].hasPassword === false, 'public users');
                check(!setup.calls[0].options.headers['X-Emby-Token'], 'no token before sign-in');
                return fails(() => login.authenticate({ server: 'emby.local', username: 'Ann', password: 'wrong' },
                    setup.host), 'http_401');
            }).then(() => login.authenticate({ server: 'emby.local', username: 'Ann', password: 'right' }, setup.host))
                .then(result => {
                    check(result.account === 'u1@server-id' && result.group === 'server-id', 'account identity');
                    check(result.label === 'Ann' && result.detail === 'Home', 'account label');
                    check(result.configuration.token === 'new-token'
                        && result.configuration.server === 'https://emby.local', 'configuration');
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
        }).then(qualityContract).then(baselineRepairs).then(extensionCompatibility).then(lanDiscovery)
        .then(previewContracts).then(downloadContracts).then(catalogueContracts).then(() => settingsContracts(true)).then(() => remoteContracts(true)).then(connectContracts);
}

function qualityContract() {
    step = 'quality precedence';
    const measured = { measuredBitrate: 7000000 };
    check(maxBitrate(measured) === 7000000, 'automatic quality uses measured throughput');
    check(maxBitrate(Object.assign({}, measured, { preferredMaxBitrate: 12000000 })) === 12000000,
        'a standing preference wins over measurement');
    const local = Object.assign({}, measured, { unlimitedLocalNetwork: true, preferredMaxBitrate: 12000000 });
    check(maxBitrate(local, true) === 1000000000 && maxBitrate(local, false) === 12000000,
        'the LAN bypass needs positive server classification');
    check(maxBitrate(Object.assign({}, local, { maxBitrate: 3000000 }), true) === 3000000,
        'an explicit quality wins even on an unlimited LAN');
    check(maxHeight({ maxHeight: 720, preferredMaxHeight: 1080 }) === 720, 'explicit height wins');
    check(maxHeight({ preferredMaxHeight: 1080 }) === 1080, 'standing height remains in automatic mode');
    const profile = deviceProfile({ maxBitrate: 500000, maxHeight: 720,
        videoCodecs: ['vp8'], restrictVideoCodecs: true });
    check(profile.MaxStaticBitrate === 500000 && profile.MaxStreamingBitrate === 500000,
        'a sub-megabit explicit ceiling is never rounded up');
    check(!profile.TranscodingProfiles.some(p => p.Type === 'Video'), 'no forbidden h264 fallback for a vp8-only device');
    check(profile.CodecProfiles[0].Conditions[0].IsRequired, 'unknown height cannot defeat a ceiling');
    const video = { Id: 'edition', Bitrate: 8000000, SupportsDirectPlay: true, SupportsDirectStream: true,
        Container: 'mkv', MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'hevc', Height: 2160 }] };
    check(!canCopySource(video, { maxBitrate: 4000000 }), 'original above bitrate ceiling cannot be copied');
    check(!canCopySource(video, { maxHeight: 1080 }), 'original above height ceiling cannot be copied');
    check(!canCopySource(video, { restrictVideoCodecs: true, videoCodecs: ['h264'] }), 'unsupported codec cannot be copied');
    check(canCopySource(video, { maxBitrate: 8000000, maxHeight: 2160 }), 'exact quality boundary can direct play');

    const source = account('ua', 'token-a');
    let media = Object.assign({}, video);
    let endpoint = { IsInNetwork: false };
    const requests = server({
        'GET /Users/ua/Items/film': { Id: 'film', Type: 'Movie' },
        'GET /System/Endpoint': () => endpoint === null ? respond({}, 404) : respond(endpoint),
        'POST /Items/film/PlaybackInfo': () => respond({ PlaySessionId: 'quality-session', MediaSources: [media] }),
        'POST /Sessions/Playing/Stopped': {},
        'DELETE /Videos/ActiveEncodings': {},
        'POST /LiveStreams/Close': {}
    });
    const resolve = args => source.resolve(Object.assign({ itemId: 'film', variantId: 'edition' }, args), requests.host);
    step = 'forced transcode';
    return fails(() => resolve({ forceTranscode: true, preferRemux: true }), 'selected_variant_unplayable').then(() => {
        const body = requests.calls.find(c => c.path.indexOf('PlaybackInfo') >= 0).body;
        check(!body.AllowVideoStreamCopy, 'a forced transcode must disable video copying');
        media.TranscodingUrl = '/videos/film/master.m3u8?VideoCodec=h264';
        media.TranscodingContainer = 'mp4';
        return resolve({ maxBitrate: 4000000, maxHeight: 1080, preferRemux: true });
    }).then(result => {
        check(result.playMethod === 'Transcode' && result.url.indexOf('master.m3u8') > 0 && result.container === 'mp4',
            'remux preference cannot bypass bitrate or height with a static original');
        return fails(() => resolve({ variantId: 'missing' }), 'selected_variant_unavailable');
    }).then(() => {
        media.SupportsDirectPlay = false;
        media.DirectStreamUrl = '/videos/film/stream.ts?VideoCodec=copy';
        step = 'negotiated remux';
        return resolve({ preferRemux: true });
    }).then(result => {
        check(result.playMethod === 'DirectStream' && result.url.indexOf('stream.ts?VideoCodec=copy') > 0,
            'direct streaming uses the negotiated remux endpoint');
        delete media.DirectStreamUrl;
        media.TranscodingUrl = '/videos/film/master.m3u8?VideoCodec=copy';
        return resolve({});
    }).then(result => {
        check(result.playMethod === 'DirectStream', 'HLS video copy is reported as DirectStream');
        return fails(() => resolve({ maxBitrate: 4000000, preferRemux: true }), 'selected_variant_unplayable');
    }).then(() => {
        return fails(() => resolve({ forceTranscode: true }), 'selected_variant_unplayable');
    }).then(() => {
        step = 'stream origin safety';
        const urls = ['//elsewhere.example/stream', 'ftp://media.example/file', '\\\\elsewhere.example\\stream',
            'https://media.example.attacker/stream'];
        return urls.reduce((pending, url) => pending.then(() => {
            media.TranscodingUrl = url;
            return fails(() => resolve({ forceTranscode: true }), 'cross_origin_stream');
        }), Promise.resolve());
    }).then(() => {
        media = { Id: 'edition', SupportsDirectPlay: true, Container: 'flac',
            MediaStreams: [{ Index: 0, Type: 'Audio', Codec: 'flac' }] };
        step = 'audio playback';
        return resolve({});
    }).then(result => {
        check(result.url.indexOf('/emby/Audio/film/stream?') > 0 && result.playMethod === 'DirectPlay',
            'audio uses the audio endpoint, not Videos');
        media = Object.assign({}, video, { SupportsDirectPlay: false, RequiresClosing: true, LiveStreamId: 'live-1',
            TranscodingUrl: '/videos/film/master.m3u8?VideoCodec=h264' });
        endpoint = { IsInNetwork: true };
        step = 'local network ceiling';
        return resolve(local);
    }).then(() => {
        check(requests.calls[requests.calls.length - 1].body.MaxStreamingBitrate === 1000000000,
            'server-classified LAN receives the unlimited ceiling');
        endpoint = null;
        return resolve(local);
    }).then(() => {
        check(requests.calls[requests.calls.length - 1].body.MaxStreamingBitrate === 12000000,
            'unavailable classification preserves the standing ceiling');
        return source.report({ event: 'stop', itemId: 'film', variantId: 'edition', playSessionId: 'quality-session',
            positionTicks: '100', subtitleStreamIndex: -1 }, requests.host);
    }).then(() => {
        const stopped = requests.calls.find(c => c.path === '/Sessions/Playing/Stopped');
        check(stopped.body.SubtitleStreamIndex === -1, 'turning subtitles off stays off in reports');
        check(requests.calls.some(c => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings'
            && c.url.indexOf('PlaySessionId=quality-session') > 0), 'stopping frees the session encoder');
        check(requests.calls.some(c => c.path === '/LiveStreams/Close' && c.url.indexOf('LiveStreamId=live-1') > 0),
            'stopping closes a live source opened during negotiation');
    });
}

function baselineRepairs() {
    step = 'exact positions and playlist entries';
    const entries = [0, 'opaque/second:entry'].map(entry => item({ Id: 'film', PlaylistItemId: entry }));
    check(entries[0].id === entries[1].id && entries[0].entryId === '0'
        && entries[1].entryId === 'opaque/second:entry', 'duplicate media occurrences keep separate opaque entry IDs');
    check(item({ Id: 'film' }).entryId === undefined, 'ordinary media has no invented entry ID');
    const source = account('ua', 'token');
    const fixture = server({
        'GET /Users/ua/Items/film': { Id: 'film', Type: 'Movie' },
        'POST /Items/film/PlaybackInfo': { MediaSources: [{ Id: 'edition', SupportsDirectPlay: true,
            Container: 'mp4', Bitrate: 1000, MediaStreams: [{ Type: 'Video', Codec: 'h264', Height: 720 }] }] },
        'POST /Sessions/Playing': {},
        'POST /Sessions/Playing/Progress': {},
        'POST /Sessions/Playing/Stopped': {},
        'POST /Users/ua/Items/film/UserData': {}
    });
    const decimal = '9007199254740993';
    return source.resolve({ itemId: 'film', positionTicks: decimal, subtitleStreamIndex: -1 }, fixture.host).then(() => {
        const call = fixture.calls.find(c => c.path === '/Items/film/PlaybackInfo');
        check(call.options.body.indexOf('"StartTimeTicks":' + decimal + ',') >= 0,
            'resolve sends an exact unquoted decimal above the safe integer limit');
        check(call.body.SubtitleStreamIndex === -1, 'resolve preserves subtitle Off');
        return ['start', 'progress', 'stop'].reduce((pending, event) => pending.then(() =>
            source.report({ event: event, itemId: 'film"\\\n', positionTicks: decimal, subtitleStreamIndex: -1 },
                fixture.host).then(() => {
                const call = fixture.calls[fixture.calls.length - 1];
                check(call.options.body.indexOf('"PositionTicks":' + decimal + ',') >= 0,
                    event + ' sends exact decimal ticks');
                check(call.body.ItemId === 'film"\\\n' && call.body.SubtitleStreamIndex === -1,
                    'ordinary strings retain JSON escaping and subtitle Off remains -1');
            })), Promise.resolve());
    }).then(() => source.progress({ itemId: 'film', positionTicks: '9223372036854775807' }, fixture.host)).then(() => {
        check(fixture.calls[fixture.calls.length - 1].options.body === '{"PlaybackPositionTicks":9223372036854775807}',
            'progress preserves the int64 upper boundary');
        return source.progress({ itemId: 'film', positionTicks: '-9223372036854775808' }, fixture.host);
    }).then(() => {
        check(fixture.calls[fixture.calls.length - 1].options.body === '{"PlaybackPositionTicks":-9223372036854775808}',
            'signed int64 lower boundary is encoded exactly');
        const count = fixture.calls.length;
        return ['', '1.5', '1e3', ' 1', '+1', '01', '9223372036854775808', '-9223372036854775809',
            '0,"injected":true', null, 9007199254740992].reduce((pending, invalid) => pending.then(() =>
            fails(() => source.resolve({ itemId: 'film', positionTicks: invalid, unlimitedLocalNetwork: true }, fixture.host),
                'invalid_position')
                .then(() => fails(() => source.report({ event: 'start', itemId: 'film', positionTicks: invalid },
                    fixture.host), 'invalid_position'))
                .then(() => fails(() => source.progress({ itemId: 'film', positionTicks: invalid }, fixture.host),
                    'invalid_position'))), Promise.resolve()).then(() =>
            check(fixture.calls.length === count, 'invalid positions fail before any metadata, LAN, or playback HTTP'));
    }).then(() => {
        step = 'discovery addresses';
        const source = createSource({}, { device: device });
        const candidates = input => source.serverCandidates({ server: input }).servers.join('|');
        check(candidates('media.example/base/emby') === 'https://media.example/base|http://media.example:8096/base|http://media.example/base',
            'DNS fallback preserves the reverse-proxy path');
        check(candidates('media.example:9000/base') === 'https://media.example:9000/base|http://media.example:9000/base',
            'a supplied port is never substituted');
        check(candidates('192.168.1.2/base') === 'http://192.168.1.2:8096/base|https://192.168.1.2/base|http://192.168.1.2/base',
            'private literals try the native HTTP port first');
        check(candidates('localhost') === 'http://localhost:8096|https://localhost|http://localhost',
            'localhost follows the private-address order');
        check(candidates('https://media.example:9443/base') === 'https://media.example:9443/base',
            'explicit HTTPS cannot downgrade');
        check(candidates('http://media.example/base') === 'http://media.example/base',
            'explicit HTTP keeps its default port and path');
        return source.discover({}, { discover: () => Promise.resolve([
            { address: '192.168.1.3', text: JSON.stringify({ Id: 'ip', Address: 'https://10.0.0.2:9443/base/emby' }) },
            { address: '192.168.1.3', text: JSON.stringify({ Id: 'dns', Address: 'https://media.example:9443/base' }) },
            { address: 'fd00::3', text: JSON.stringify({ Id: 'ipv6', Address: 'http://[fd00::2]:8096/base' }) },
            { address: '192.168.1.3', text: JSON.stringify({ Id: 'unsafe', Address: 'https://name:password@server' }) }
        ]) }).then(result => {
            check(result.servers.find(s => s.id === 'ip').address === 'https://192.168.1.3:9443/base/emby',
                'UDP sender replaces a literal while preserving scheme, port and base path');
            check(result.servers.find(s => s.id === 'dns').address === 'https://media.example:9443/base',
                'UDP sender never replaces a DNS name');
            check(result.servers.find(s => s.id === 'ipv6').address === 'http://[fd00::3]:8096/base',
                'IPv6 UDP senders remain bracketed');
            check(!result.servers.some(s => s.id === 'unsafe'), 'unsafe announcements are not offered for origin approval');
        });
    });
}
