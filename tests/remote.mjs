// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';

function check(value, message) {
    if (!value)
        throw new Error('remote contract: ' + message);
}
function fails(operation, code) {
    return Promise.resolve().then(operation).then(() => {
        throw new Error('remote contract: expected ' + code);
    }, error => check(error.message === code, 'expected ' + code + ', got ' + error.message));
}
function parameters(url) {
    const result = {};
    for (const field of (url.split('?')[1] || '').split('&')) {
        const split = field.indexOf('=');
        if (split >= 0)
            result[decodeURIComponent(field.slice(0, split))] = decodeURIComponent(field.slice(split + 1));
    }
    return result;
}
const response = (value, status = 200) => Promise.resolve({ status: status, body: JSON.stringify(value) });

export function remoteContracts(emby = false) {
    const calls = [];
    const events = [];
    const sockets = [];
    const supported = ['SetVolume', 'Mute', 'Unmute', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex',
        'SetRepeatMode', 'SetShuffleQueue', 'MoveUp', 'MoveDown', 'MoveLeft', 'MoveRight', 'Select', 'Back',
        'GoHome', 'SendString', 'DisplayMessage'];
    const streams = [{ Type: 'Audio', Index: 2, DisplayTitle: 'French' },
        { Type: 'Subtitle', Index: 7, DisplayTitle: 'English' }];
    let entries = [{ Id: 'film', PlaylistItemId: 0 }, { Id: 'film', PlaylistItemId: 'second' },
        { Id: 'other', PlaylistItemId: 'third' }];
    let playing = { PositionTicks: '9007199254740993', IsPaused: true, CanSeek: true,
        AudioStreamIndex: 2, SubtitleStreamIndex: -1, MediaSourceId: 'variant' };
    let current = 1;
    let hidden = false;
    let pending = null;
    let confirmationReads = 0;
    let queueReads = 0;
    let metadataReads = 0;
    let replacementCount = 0;
    let mediaSourceId = 'variant';
    const metadata = id => ({ Id: id, Name: id === 'film' ? 'A film' : id, Type: 'Movie',
        MediaSources: [{ Id: mediaSourceId, MediaStreams: streams }] });
    function target() {
        const raw = { Id: 'target', DeviceId: 'peer', DeviceName: 'Living room', Client: 'Client', UserName: 'Viewer',
            PlayState: playing, PlaylistIndex: current, PlaylistLength: entries.length,
            PlaylistItemId: entries[current] && entries[current].PlaylistItemId,
            NowPlayingItem: entries[current] ? { Id: entries[current].Id, Name: 'Playing', Type: 'Movie' } : undefined };
        if (emby) {
            raw.SupportsRemoteControl = true;
            raw.SupportedCommands = supported;
            // A misleading embedded queue must not be used by the Emby adapter.
            raw.NowPlayingQueue = [{ Id: 'wrong', PlaylistItemId: 'wrong' }];
        } else {
            raw.Capabilities = { SupportsMediaControl: true, SupportedCommands: supported };
            raw.NowPlayingQueue = entries;
        }
        return raw;
    }
    const host = {
        device: { id: 'self', name: 'Controller' }, capabilities: { 'remoteTargets': true },
        isLogEnabled: () => false, log: () => {},
        emit: (name, data) => events.push({ name: name, data: data }),
        delay: () => Promise.resolve(),
        socket: () => {
            const socket = { send: () => {}, close: () => {} };
            sockets.push(socket);
            return socket;
        },
        http: (url, options) => {
            const path = url.replace(/^https:\/\/media.example\/base(?:\/emby)?/, '').split('?')[0];
            const query = parameters(url);
            const body = options.body ? JSON.parse(options.body) : {};
            calls.push({ path: path, query: query, body: body, wireBody: options.body, method: options.method });
            if (path === '/Sessions/Capabilities/Full')
                return response({});
            if (path === '/Sessions') {
                check(query[emby ? 'ControllableByUserId' : 'controllableByUserId'] === 'u', 'account-scoped session filter');
                if (emby && query.Id)
                    check(query.Id === 'target', 'exact Emby session ID filter');
                if (pending && ++confirmationReads === 2) {
                    entries = pending.ids.map((id, index) => ({ Id: id, PlaylistItemId: 'replacement-' + replacementCount + '-' + index }));
                    current = pending.index;
                    playing.PositionTicks = pending.position;
                    playing.IsPaused = false;
                    pending = null;
                }
                const peer = target();
                const self = Object.assign({}, peer, { Id: 'own', DeviceId: 'self' });
                const wrongShape = emby ? { Id: 'nested-only', DeviceId: 'other', Capabilities: { SupportsMediaControl: true } }
                    : { Id: 'flat-only', DeviceId: 'other', SupportsRemoteControl: true, SupportedCommands: supported };
                return response(hidden ? [self, wrongShape] : [self, wrongShape, peer]);
            }
            if (path === '/Sessions/PlayQueue') {
                check(emby && query.Id === 'target', 'Emby queue endpoint is selected-session scoped');
                ++queueReads;
                return response({ Items: entries.map(entry => Object.assign(metadata(entry.Id), entry)), TotalRecordCount: entries.length });
            }
            if (path === '/Users/u/Items') {
                const ids = query.Ids.split(',');
                check(ids.length <= 50 && new Set(ids).size === ids.length, 'queue metadata batches contain at most 50 unique IDs');
                ++metadataReads;
                return response({ Items: ids.slice().reverse().map(metadata) });
            }
            if (path.indexOf('/Users/u/Items/') === 0)
                return response(metadata(decodeURIComponent(path.slice('/Users/u/Items/'.length))));
            if (/^\/Items\/[^/]+\/ThumbnailSet$/.test(path)) {
                check(query.Width === '320' && options.headers['X-Emby-Token'] === 'account-token',
                    'remote thumbnail discovery uses the requested width and account authentication');
                return response({ Thumbnails: [{ PositionTicks: 0, ImageTag: 'first' }] });
            }
            if (path === '/Sessions/target/Playing') {
                check(!pending, 'mutations are not blindly repeated');
                ++replacementCount;
                const index = emby ? body.StartIndex : Number(query.startIndex);
                const ids = query[emby ? 'ItemIds' : 'itemIds'].split(',');
                const position = query[emby ? 'StartPositionTicks' : 'startPositionTicks'];
                if (query[emby ? 'PlayCommand' : 'playCommand'] === 'PlayNow') {
                    pending = { ids: ids, index: index, position: position };
                    confirmationReads = 0;
                }
                return response({});
            }
            if (path === '/Sessions/target/Playing/Pause') {
                check(!pending, 'pause restoration waits until the replacement occurrence is confirmed');
                playing.IsPaused = true;
                return response({});
            }
            if (path === '/Sessions/target/Playing/Stop') {
                entries = [];
                current = -1;
                return response({});
            }
            if (path === '/Sessions/target/Playing/Seek' || path === '/Sessions/target/Command')
                return response({});
            throw new Error('unexpected_http:' + options.method + ':' + path);
        }
    };
    const configuration = { server: 'https://media.example/base', token: 'account-token', userId: 'u' };
    const source = createSource(configuration, host);
    const command = value => source.remoteCommand({ targetId: 'target', command: value }, host);
    const mutationCalls = () => calls.filter(call => call.method === 'POST' && call.path !== '/Sessions/Capabilities/Full');
    let cursor;
    let before;
    let mutationsBefore;
    return source.remoteTargets({}, host).then(result => {
        check(result.targets.length === 1 && result.targets[0].id === 'target', 'exclude self and the other service capability shape');
        check(result.targets[0].queueEditing === 'replace' && result.targets[0].customControls, 'replacement editing and advanced navigation offered');
        before = mutationCalls().length;
        return source.remoteConnect({ targetId: 'target' }, host);
    }).then(state => {
        check(mutationCalls().length === before, 'selection never starts or transfers media');
        check(state.state === 'paused' && state.positionTicks === '9007199254740993', 'snapshot preserves known exact position');
        check(state.volume === undefined && state.runtimeTicks === undefined && state.queueRevision === undefined
            && state.commandSequence === undefined, 'unknown values, queue revisions and acknowledgements remain absent');
        check(state.audioTracks[0].id === '2' && state.audioTracks[0].selected
            && state.subtitleTracks[0].id === '7' && !state.subtitleTracks[0].selected, 'tracks use native stream indices and Off remains unselected');
        check(state.preview.format === 'bif'
            && state.preview.url === 'https://media.example/base/emby/Videos/film/index.bif?Width=320'
            && state.preview.headers['X-Emby-Token'] === 'account-token',
            'remote previews use the known playing item and account-scoped BIF credentials');
        const previewsBefore = calls.filter(call => call.path.endsWith('/ThumbnailSet')).length;
        return source.remoteState({ targetId: 'target', videoPreviews: false }, host).then(state => {
            check(!state.preview && state.audioTracks.length > 0, 'disabled remote previews preserve playback tracks');
            check(calls.filter(call => call.path.endsWith('/ThumbnailSet')).length === previewsBefore,
                'disabled remote state does not fetch thumbnails');
            return source.remoteConnect({ targetId: 'target', videoPreviews: false }, host);
        }).then(state => check(!state.preview, 'disabled remote connection cannot reuse a cached descriptor'));
    }).then(() => {
        playing.MediaSourceId = 'unknown-version';
        return source.remoteState({ targetId: 'target' }, host);
    }).then(state => {
        check(state.preview === undefined, 'unknown remote versions never borrow the item index');
        playing.MediaSourceId = undefined;
        mediaSourceId = undefined;
        return source.remoteState({ targetId: 'target' }, host);
    }).then(state => {
        check(state.preview === undefined, 'missing playing and metadata source IDs never authorize an index');
        mediaSourceId = 'variant';
        playing.MediaSourceId = 'variant';
        return source.remoteState({ targetId: 'target' }, host);
    }).then(() => {
        return source.remoteQueue({ targetId: 'target', limit: 2 }, host);
    }).then(page => {
        check(page.items.map(row => row.id).join(',') === 'film,film'
            && page.items.map(row => row.entryId).join(',') === '0,second', 'duplicate media occurrences retain distinct string entry IDs');
        check(!page.exhausted && page.total === 3, 'snapshot pages retain continuation');
        cursor = page.cursor;
        before = queueReads;
        return source.remoteQueue({ targetId: 'target', limit: 2, cursor: cursor }, host);
    }).then(page => {
        check(page.exhausted && page.items[0].id === 'other' && page.items[0].entryId === 'third', 'last queue page is terminal');
        check(queueReads === before, 'cursor pages reuse the same bounded snapshot');
        return command({ action: 'subtitleTrack', trackId: null });
    }).then(() => {
        const call = mutationCalls().slice(-1)[0];
        check(call.body.Name === 'SetSubtitleStreamIndex' && call.body.Arguments.Index === '-1', 'subtitle Off reaches native general command');
        return fails(() => source.remoteQueue({ targetId: 'target', cursor: cursor }, host), 'invalid_cursor');
    }).then(() => {
        before = calls.length;
        return fails(() => command({ action: 'audioTrack', trackId: null }), 'invalid_track');
    }).then(() => fails(() => command({ action: 'seek', positionTicks: '9223372036854775808' }), 'invalid_position'))
        .then(() => fails(() => command({ action: 'play', itemIds: ['film'], index: 1, positionTicks: '0', mode: 'now' }), 'invalid_command'))
        .then(() => {
            check(calls.length === before, 'malformed commands reject before any HTTP');
            return command({ action: 'seek', positionTicks: '9007199254740993' });
        }).then(() => {
            const seek = mutationCalls().slice(-1)[0];
            check(emby ? seek.wireBody.indexOf('"SeekPositionTicks":9007199254740993') >= 0
                && seek.body.Command === 'Seek' : seek.query.seekPositionTicks === '9007199254740993',
                'seek encodes exact decimal ticks in the documented service transport');
            return command({ action: 'queueMove', entryId: 'second', index: 2, afterEntryId: 'third' });
        }).then(() => {
            const call = mutationCalls().find(call => call.path === '/Sessions/target/Playing');
            check(call.query[emby ? 'ItemIds' : 'itemIds'] === 'film,other,film', 'move preserves both duplicate media occurrences');
            check((emby ? call.body.StartIndex : Number(call.query.startIndex)) === 2
                && call.query[emby ? 'StartPositionTicks' : 'startPositionTicks'] === '9007199254740993', 'move preserves exact current occurrence and position');
            check(playing.IsPaused && confirmationReads >= 2, 'paused playback restored after delayed replacement confirmation');
            return command({ action: 'queueRemove', entryId: entries[current].PlaylistItemId });
        }).then(() => {
            const call = mutationCalls().filter(call => call.path === '/Sessions/target/Playing').slice(-1)[0];
            check(call.query[emby ? 'ItemIds' : 'itemIds'] === 'film,other'
                && call.query[emby ? 'StartPositionTicks' : 'startPositionTicks'] === '0', 'removing current occurrence restarts surviving successor at zero');
            check(playing.IsPaused, 'remove also restores paused state');
            return source.remoteControls({ targetId: 'target' }, host);
        }).then(controls => {
            check(controls.text && controls.message && controls.controls.some(row => row.id === 'MoveLeft'), 'advanced picker exposes supported D-pad and text controls');
            return source.remoteControl({ targetId: 'target', name: 'SendString', value: 'Text "with quotes"' }, host);
        }).then(() => {
            check(mutationCalls().slice(-1)[0].body.Arguments.String === 'Text "with quotes"', 'text commands preserve JSON escaping');
            mutationsBefore = mutationCalls().length;
            supported.splice(supported.indexOf('SetVolume'), 1);
            return fails(() => command({ action: 'volume', value: 50 }), 'command_unavailable');
        }).then(() => {
            check(mutationCalls().length === mutationsBefore, 'lost capabilities never dispatch mutations');
            entries = [{ Id: 'only', PlaylistItemId: 'last' }];
            current = 0;
            return command({ action: 'queueRemove', entryId: 'last' });
        }).then(() => {
            check(mutationCalls().slice(-1)[0].path === '/Sessions/target/Playing/Stop', 'removing the final entry stops rather than sending an empty play');
            entries = [];
            for (let index = 0; index < 101; ++index)
                entries.push({ Id: 'item-' + index, PlaylistItemId: 'entry-' + index });
            entries.push({ Id: 'item-0', PlaylistItemId: 'duplicate' });
            current = 0;
            metadataReads = 0;
            return source.remoteQueue({ targetId: 'target', limit: 100 }, host);
        }).then(page => {
            check(page.items[99].id === 'item-99' && (emby ? metadataReads === 0 : metadataReads === 3), 'metadata batches preserve original queue order');
            return source.remoteQueue({ targetId: 'target', limit: 100, cursor: page.cursor }, host);
        }).then(page => {
            check(page.items[1].id === 'item-0' && page.items[1].entryId === 'duplicate', 'last duplicate is not deduplicated');
            const beforeEvents = events.length;
            sockets[0].onmessage(JSON.stringify({ MessageType: 'Sessions', Data: [target()] }));
            check(events.length === beforeEvents + 1 && events[beforeEvents].name === 'remoteChanged'
                && events[beforeEvents].data.targetId === 'target', 'session notifications invalidate outbound target only');
            sockets[0].onmessage(JSON.stringify({ MessageType: 'Playstate', Data: { Command: 'Pause' } }));
            check(events.slice(-1)[0].name === 'remote' && events.slice(-1)[0].data.command === 'pause', 'inbound remote remains independent');
            hidden = true;
            return fails(() => source.remoteState({ targetId: 'target' }, host), 'target_unavailable');
        }).then(() => {
            const legacy = createSource(configuration, { device: {} });
            before = calls.length;
            return fails(() => legacy.remoteTargets({}, host), 'unsupported_capability')
                .then(() => fails(() => legacy.remoteConnect({ targetId: 'target' }, host), 'unsupported_capability'))
                .then(() => fails(() => legacy.remoteState({ targetId: 'target' }, host), 'unsupported_capability'))
                .then(() => fails(() => legacy.remoteQueue({ targetId: 'target' }, host), 'unsupported_capability'))
                .then(() => fails(() => legacy.remoteCommand({ targetId: 'target', command: { action: 'pause' } }, host), 'unsupported_capability'))
                .then(() => fails(() => legacy.remoteControls({ targetId: 'target' }, host), 'unsupported_capability'))
                .then(() => fails(() => legacy.remoteControl({ targetId: 'target', name: 'MoveUp' }, host), 'unsupported_capability'));
        }).then(() => check(calls.length === before, 'all outbound extension methods reject legacy hosts without HTTP'));
}
