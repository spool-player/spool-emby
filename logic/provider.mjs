// SPDX-License-Identifier: MPL-2.0
// Emby for Spool: one source per signed-in user.

import { collectionTypes, detailFields, fields, item, page, segments, stream } from './items.mjs';
import { canCopySource, deviceProfile, maxBitrate } from './profile.mjs';
import { connect, remoteCommands } from './events.mjs';

// sdk BrowseFilters keys this server takes as they are (its query names are
// case-insensitive); lists of names are joined with |, the rest with commas.
const browseFilters = ['filters', 'genres', 'officialRatings', 'tags', 'years', 'studioIds', 'seriesStatus',
    'videoTypes', 'includeItemTypes', 'isHd', 'is4K', 'is3D', 'hasSubtitles', 'hasTrailer', 'hasSpecialFeature',
    'hasThemeSong', 'hasThemeVideo', 'isMissing', 'isUnaired'];
const pipeLists = ['genres', 'officialRatings', 'tags', 'studioIds'];

function quoted(value) {
    return String(value || '').replace(/["\\\r\n]/g, '');
}

function query(values) {
    return Object.keys(values).filter(key => values[key] !== undefined && values[key] !== null && values[key] !== '')
        .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(String(values[key]))).join('&');
}

function segment(value) {
    if (typeof value !== 'string' || !value)
        throw new Error('missing_id');
    return encodeURIComponent(value);
}

function start(args) {
    const cursor = args.cursor ? String(args.cursor) : '0';
    if (!/^\d+$/.test(cursor))
        throw new Error('invalid_cursor');
    return Number(cursor);
}

export function normalizeServer(input) {
    let text = String(input || '').trim().replace(/\/+$/, '').replace(/\/emby$/i, '');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
        text = 'http://' + text;
    const parts = /^(https?):\/\/(\[[0-9a-f:]+\]|[^/:?#@\s\\]+)(:\d+)?(\/[^?#\\\s]*)?$/i.exec(text);
    if (!parts || (parts[3] && (Number(parts[3].slice(1)) < 1 || Number(parts[3].slice(1)) > 65535)))
        throw new Error('invalid_server');
    return parts[1].toLowerCase() + '://' + parts[2]
        + (parts[3] || (parts[1].toLowerCase() === 'http' && !parts[4] ? ':8096' : '')) + (parts[4] || '');
}

export function createSource(configuration, sourceHost) {
    const server = configuration.server ? normalizeServer(configuration.server) : '';
    const device = sourceHost.device || {};
    const token = configuration.token || '';
    const userId = configuration.userId || '';
    const sessions = new Map();

    function streamUrl(value) {
        const path = String(value || '');
        if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
            if (!/^https?:\/\//i.test(path) || path.indexOf(server + '/') !== 0 || /[\\\r\n]/.test(path))
                throw new Error('cross_origin_stream');
            return path;
        }
        if (/^[\\/]{2}|\\|[\r\n]/.test(path))
            throw new Error('cross_origin_stream');
        return server + '/emby/' + path.replace(/^\/+/, '').replace(/^emby\//i, '');
    }

    function headers(withToken) {
        const result = {
            'X-Emby-Authorization': 'MediaBrowser Client="Spool", Device="' + quoted(device.name || 'Spool')
                + '", DeviceId="' + quoted(device.id || 'spool') + '", Version="' + quoted(device.version || '0') + '"',
            'Content-Type': 'application/json', Accept: 'application/json'
        };
        if (withToken && token)
            result['X-Emby-Token'] = token;
        return result;
    }

    // Every API path lives under /emby. `base` lets sign-in talk to a server
    // before the account exists.
    function request(host, method, path, parameters, body, base) {
        const suffix = query(parameters || {});
        return host.http((base || server) + '/emby' + path + (suffix ? '?' + suffix : ''), {
            method: method, headers: headers(!base), body: body === undefined ? '' : JSON.stringify(body)
        }).then(response => {
            if (response.status < 200 || response.status >= 300)
                throw new Error('http_' + response.status);
            return response.body ? JSON.parse(response.body) : {};
        });
    }

    const userPath = path => '/Users/' + segment(userId) + path;

    function list(host, path, args, parameters) {
        const first = start(args);
        const limit = Math.min(Math.max(args.limit || 72, 1), 100);
        const values = Object.assign({ UserId: userId, Fields: fields, EnableImageTypes: 'Primary,Backdrop,Logo,Thumb',
            ImageTypeLimit: 1, EnableUserData: true }, parameters || {}, { StartIndex: first, Limit: limit });
        return request(host, 'GET', path, values).then(result => page(result, first, limit));
    }

    function info(host, base) {
        return request(host, 'GET', '/System/Info/Public', {}, undefined, base).then(result => {
            // Jellyfin still answers under /emby; it has its own provider.
            if (!result.Id || /jellyfin/i.test(result.ProductName || ''))
                throw new Error('not_emby');
            return result;
        });
    }

    // Live updates and remote commands arrive here.
    let disconnect = null;
    if (server && token && sourceHost.socket) {
        const socketUrl = server.replace(/^http/i, 'ws') + '/embywebsocket?' + query({ api_key: token, deviceId: device.id });
        disconnect = connect(sourceHost, socketUrl, headers(true));
        // Tell the server what this client can be asked to do.
        sourceHost.http(server + '/emby/Sessions/Capabilities/Full', {
            method: 'POST', headers: headers(true),
            body: JSON.stringify({ PlayableMediaTypes: ['Video', 'Audio'], SupportedCommands: remoteCommands,
                SupportsMediaControl: true, SupportsPersistentIdentifier: true })
        }).then(() => {}, () => {});
    }

    return {
        describe: () => ({
            artwork: server + '/emby/Items/{itemId}/Images/{type}?tag={tag}&maxWidth={width}&quality={quality}&format={format}'
        }),

        // Sign-in. These run before the account exists, against `server`
        // given in the arguments, once the screen has allowed that origin.
        discover: (args, host) => host.discover({ port: 7359, message: 'who is EmbyServer?', timeout: 1500 })
            .then(replies => {
                const servers = {};
                for (const reply of replies) {
                    try {
                        const found = JSON.parse(reply.text);
                        if (found.Id && found.Address)
                            servers[found.Id] = { id: found.Id, name: found.Name || found.Address, address: found.Address };
                    } catch (error) {}
                }
                return { servers: Object.values(servers) };
            }),
        probe: (args, host) => {
            const base = normalizeServer(args.server);
            return info(host, base).then(found => request(host, 'GET', '/Users/Public', {}, undefined, base)
                .then(users => ({
                    server: base, id: found.Id, name: found.ServerName || '', version: found.Version || '',
                    users: (Array.isArray(users) ? users : []).map(u => ({ id: u.Id, name: u.Name,
                        hasPassword: u.HasPassword !== false }))
                }), () => ({ server: base, id: found.Id, name: found.ServerName || '', users: [] })));
        },
        authenticate: (args, host) => {
            const base = normalizeServer(args.server);
            return request(host, 'POST', '/Users/AuthenticateByName', {},
                { Username: args.username, Pw: args.password || '' }, base).then(result => {
                if (!result.AccessToken || !result.User || !result.User.Id)
                    throw new Error('invalid_credentials');
                return info(host, base).then(found => {
                    const serverId = result.ServerId || found.Id;
                    return {
                        account: result.User.Id + '@' + serverId, group: serverId, label: result.User.Name || '',
                        detail: found.ServerName || base.replace(/^https?:\/\//, ''),
                        configuration: { server: base, userId: result.User.Id, token: result.AccessToken,
                            userName: result.User.Name || '', serverId: serverId, serverName: found.ServerName || '' }
                    };
                });
            });
        },

        libraries: (args, host) => request(host, 'GET', userPath('/Views')).then(result => ({
            items: (result.Items || []).map(row => ({ id: String(row.Id), title: row.Name || '',
                collectionType: row.CollectionType || '', posterTag: (row.ImageTags || {}).Primary || '' }))
        })),
        browse: (args, host) => {
            const filters = args.filters || {};
            const parameters = { ParentId: args.parentId, Recursive: args.recursive !== false,
                IncludeItemTypes: collectionTypes[args.collectionType], SortBy: args.sortBy || 'SortName',
                SortOrder: args.sortOrder || 'Ascending', Genres: args.genre, Studios: args.studio };
            for (const key of browseFilters) {
                const value = filters[key];
                if (value !== undefined && value !== null && value !== false)
                    parameters[key] = Array.isArray(value) ? value.join(pipeLists.indexOf(key) >= 0 ? '|' : ',') : value;
            }
            if (filters.specialEpisode)
                parameters.ParentIndexNumber = 0;
            if (filters.alphabet === '#')
                parameters.NameLessThan = 'A';
            else if (filters.alphabet)
                parameters.NameStartsWith = filters.alphabet;
            return list(host, userPath('/Items'), args, parameters);
        },
        items: (args, host) => list(host, userPath('/Items'), args, { Ids: (args.ids || []).join(',') }),
        search: (args, host) => list(host, userPath('/Items'), args, { SearchTerm: args.query, Recursive: true,
            IncludeItemTypes: 'Movie,Series,Episode,MusicVideo,Video,Audio,MusicAlbum,MusicArtist,Book,AudioBook,BoxSet,Playlist' }),
        details: (args, host) => request(host, 'GET', userPath('/Items/' + segment(args.itemId)), { Fields: detailFields })
            .then(raw => ({ item: item(raw) })),
        seasons: (args, host) => list(host, '/Shows/' + segment(args.seriesId) + '/Seasons', args),
        episodes: (args, host) => list(host, '/Shows/' + segment(args.seriesId) + '/Episodes', args,
            { SeasonId: args.seasonId, Fields: fields + ',MediaSources' }),
        resume: (args, host) => list(host, userPath('/Items/Resume'), args, { MediaTypes: 'Video' }),
        nextUp: (args, host) => list(host, '/Shows/NextUp', args),
        latest: (args, host) => {
            const limit = Math.min(Math.max(args.limit || 24, 1), 100);
            return request(host, 'GET', userPath('/Items/Latest'), { ParentId: args.parentId, Limit: limit,
                Fields: fields, EnableUserData: true }).then(rows => page(rows, 0, limit + 1));
        },
        similar: (args, host) => list(host, '/Items/' + segment(args.itemId) + '/Similar', args),
        personItems: (args, host) => list(host, userPath('/Items'), args, { PersonIds: args.personId, Recursive: true,
            SortBy: 'PremiereDate,ProductionYear,SortName', SortOrder: 'Descending' }),
        filterOptions: (args, host) => {
            const scope = { UserId: userId, ParentId: args.parentId, IncludeItemTypes: collectionTypes[args.collectionType],
                Recursive: true };
            const names = path => request(host, 'GET', path, scope).then(r => (r.Items || []).map(row => row.Name), () => []);
            return Promise.all([names('/Genres'), names('/OfficialRatings'), names('/Tags'), names('/Years')])
                .then(([genres, ratings, tags, years]) => ({ genres: genres, officialRatings: ratings, tags: tags,
                    years: years.map(Number).filter(Number.isInteger) }));
        },
        speedTest: (args, host) => host.speedTest({
            url: server + '/emby/Playback/BitrateTest?Size={bytes}&_={nonce}',
            headers: { 'X-Emby-Token': token }
        }),

        resolve: (args, host) => {
            const localNetwork = args.unlimitedLocalNetwork && !args.maxBitrate
                ? request(host, 'GET', '/System/Endpoint').then(
                    endpoint => endpoint.IsLocal === true || endpoint.IsInNetwork === true, () => false)
                : Promise.resolve(false);
            const playbackInfo = localNetwork.then(local => request(host, 'POST',
                '/Items/' + segment(args.itemId) + '/PlaybackInfo', { UserId: userId }, {
                    UserId: userId, MediaSourceId: args.variantId, StartTimeTicks: Number(args.positionTicks) || 0,
                    MaxStreamingBitrate: maxBitrate(args, local), DeviceProfile: deviceProfile(args, local),
                    AudioStreamIndex: args.audioStreamIndex, SubtitleStreamIndex: args.subtitleStreamIndex,
                    EnableDirectPlay: !args.forceTranscode, EnableDirectStream: !args.forceTranscode,
                    EnableTranscoding: true, IsPlayback: true, AutoOpenLiveStream: true,
                    AllowVideoStreamCopy: !args.forceTranscode, AllowAudioStreamCopy: true
                }));
            // Item type distinguishes audio, and chapters carry Emby's skip markers.
            const details = request(host, 'GET', userPath('/Items/' + segment(args.itemId)), { Fields: 'Chapters' })
                .then(raw => raw, () => null);
            return Promise.all([playbackInfo, details, localNetwork]).then(([playback, raw, local]) => {
                if (playback.ErrorCode)
                    throw new Error('playback_unavailable');
                const sources = playback.MediaSources || [];
                const source = args.variantId ? sources.find(s => String(s.Id) === args.variantId) : sources[0];
                if (!source)
                    throw new Error('selected_variant_unavailable');
                let url;
                let playMethod;
                const copy = !args.forceTranscode && canCopySource(source, args, local);
                if (copy && source.SupportsDirectPlay) {
                    const audio = (raw && (raw.MediaType === 'Audio' || raw.Type === 'Audio' || raw.Type === 'AudioBook'))
                        || ((source.MediaStreams || []).some(s => s.Type === 'Audio')
                            && !(source.MediaStreams || []).some(s => s.Type === 'Video'));
                    url = server + '/emby/' + (audio ? 'Audio/' : 'Videos/') + segment(args.itemId) + '/stream?'
                        + query({ static: true, MediaSourceId: source.Id, DeviceId: device.id,
                            PlaySessionId: playback.PlaySessionId, LiveStreamId: source.LiveStreamId });
                    playMethod = 'DirectPlay';
                } else if (copy && source.SupportsDirectStream && source.DirectStreamUrl
                    && (args.preferRemux || !source.TranscodingUrl)) {
                    url = streamUrl(source.DirectStreamUrl);
                    playMethod = 'DirectStream';
                } else if (source.TranscodingUrl) {
                    url = streamUrl(source.TranscodingUrl);
                    playMethod = /[?&]VideoCodec=copy(?:&|$)/i.test(url) ? 'DirectStream' : 'Transcode';
                    if (!copy && playMethod === 'DirectStream')
                        throw new Error('selected_variant_unplayable');
                } else {
                    // SupportsDirectStream alone never authorizes a static original-file fallback.
                    throw new Error('selected_variant_unplayable');
                }
                if (playback.PlaySessionId)
                    sessions.set(playback.PlaySessionId, { liveStreamId: source.RequiresClosing ? source.LiveStreamId : '',
                        transcoding: playMethod !== 'DirectPlay' });
                return { url: url, headers: { 'X-Emby-Token': token }, variantId: String(source.Id),
                    playSessionId: playback.PlaySessionId || '', playMethod: playMethod,
                    container: ((playMethod === 'DirectPlay' ? source.Container : source.TranscodingContainer)
                        || source.Container || '').split(',')[0],
                    streams: (source.MediaStreams || []).map(stream),
                    segments: segments(source.Chapters ? source : raw) };
            });
        },
        segments: (args, host) => request(host, 'GET', userPath('/Items/' + segment(args.itemId)), { Fields: 'Chapters' })
            .then(raw => ({ segments: segments(raw) })),
        report: (args, host) => {
            const endpoint = { start: '/Sessions/Playing', progress: '/Sessions/Playing/Progress',
                stop: '/Sessions/Playing/Stopped' }[args.event];
            if (!endpoint)
                throw new Error('invalid_report');
            const index = value => (Number.isInteger(value) && value >= 0 ? value : undefined);
            return request(host, 'POST', endpoint, {}, {
                ItemId: args.itemId, MediaSourceId: args.variantId, PlaySessionId: args.playSessionId,
                PositionTicks: Number(args.positionTicks) || 0, IsPaused: Boolean(args.paused),
                IsMuted: Boolean(args.muted), VolumeLevel: args.volume, PlaybackRate: args.rate || 1,
                PlayMethod: args.playMethod, AudioStreamIndex: index(args.audioStreamIndex),
                SubtitleStreamIndex: args.subtitleStreamIndex === -1 ? -1 : index(args.subtitleStreamIndex),
                CanSeek: true, Failed: Boolean(args.failed)
            }).then(() => {
                if (args.event !== 'stop')
                    return {};
                const session = sessions.get(args.playSessionId);
                sessions.delete(args.playSessionId);
                const cleanup = [];
                if (args.playSessionId && ((session && session.transcoding)
                    || args.playMethod === 'Transcode' || args.playMethod === 'DirectStream'))
                    cleanup.push(request(host, 'DELETE', '/Videos/ActiveEncodings', {
                        DeviceId: device.id, PlaySessionId: args.playSessionId }));
                if (session && session.liveStreamId)
                    cleanup.push(request(host, 'POST', '/LiveStreams/Close', {
                        LiveStreamId: session.liveStreamId, PlaySessionId: args.playSessionId }));
                return Promise.all(cleanup).then(() => ({}));
            });
        },

        favorite: (args, host) => request(host, args.value ? 'POST' : 'DELETE',
            userPath('/FavoriteItems/' + segment(args.itemId))).then(() => ({})),
        played: (args, host) => request(host, args.value ? 'POST' : 'DELETE',
            userPath('/PlayedItems/' + segment(args.itemId))).then(() => ({})),
        progress: (args, host) => request(host, 'POST', userPath('/Items/' + segment(args.itemId) + '/UserData'), {},
            { PlaybackPositionTicks: Number(args.positionTicks) || 0 }).then(() => ({})),

        // Item menu actions from manifest.json; `pick` shows ui/Picker.qml.
        runItemAction: (args, host) => {
            const id = segment(args.itemId);
            const path = args.action === 'playlist' ? '/Playlists' : '/Collections';
            switch (args.action) {
            case 'playlist':
            case 'collection':
                if (!args.targetId && !args.newName)
                    return { pick: { kind: args.action, itemId: args.itemId } };
                if (args.newName)
                    return request(host, 'POST', path, { Name: args.newName, Ids: args.itemId, UserId: userId })
                        .then(() => ({ message: 'Added to ' + args.newName }));
                return request(host, 'POST', path + '/' + segment(args.targetId) + '/Items',
                    { Ids: args.itemId, UserId: userId })
                    .then(() => ({ message: 'Added to ' + (args.targetName || args.action) }));
            case 'rename':
                if (!args.newName)
                    return { pick: { kind: 'rename', itemId: args.itemId } };
                return request(host, 'GET', userPath('/Items/' + id)).then(raw => {
                    raw.Name = args.newName;
                    return request(host, 'POST', '/Items/' + id, {}, raw);
                }).then(() => ({ changed: true, itemId: args.itemId, message: 'Renamed' }));
            case 'delete':
                if (!args.confirmed)
                    return { pick: { kind: 'confirm', itemId: args.itemId } };
                return request(host, 'POST', '/Items/' + id + '/Delete').then(() => ({ changed: true, message: 'Deleted' }));
            default:
                throw new Error('unsupported_action');
            }
        },
        // Where an item could be added, for the picker.
        targets: (args, host) => request(host, 'GET', userPath('/Items'), { Recursive: true,
            IncludeItemTypes: args.kind === 'playlist' ? 'Playlist' : 'BoxSet', SortBy: 'SortName', Limit: 500 })
            .then(result => ({ items: (result.Items || []).map(row => ({ id: String(row.Id), title: row.Name || '' })) })),

        signOut: (args, host) => {
            if (disconnect)
                disconnect();
            return request(host, 'POST', '/Sessions/Logout').then(() => ({}), () => ({}));
        }
    };
}
