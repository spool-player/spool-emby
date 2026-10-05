// SPDX-License-Identifier: MPL-2.0
// Outbound session control. Inbound websocket commands remain in events.mjs.
import { ticks } from './items.mjs';
import { tickInteger, wireJson } from './wire.mjs';

const transport = { pause: 'Pause', unpause: 'Unpause', stop: 'Stop', next: 'NextTrack', previous: 'PreviousTrack' };
const advanced = {
    MoveUp: 'Up', MoveDown: 'Down', MoveLeft: 'Left', MoveRight: 'Right', Select: 'Select', Back: 'Back',
    PageUp: 'Page up', PageDown: 'Page down', PreviousLetter: 'Previous letter', NextLetter: 'Next letter',
    GoHome: 'Home', GoToSettings: 'Settings', GoToSearch: 'Search', ToggleOsd: 'Playback controls',
    ToggleOsdMenu: 'Playback menu', ToggleContextMenu: 'Context menu', ToggleStats: 'Playback statistics',
    ToggleFullscreen: 'Fullscreen', VolumeUp: 'Volume up', VolumeDown: 'Volume down'
};
const repeatModes = ['RepeatNone', 'RepeatAll', 'RepeatOne'];
function identity(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value
        : Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}
function position(value) {
    if (typeof value !== 'string' || value[0] === '-')
        throw new Error('invalid_position');
    return wireJson(tickInteger(value));
}
function rows(value) {
    return Array.isArray(value) ? value : value && Array.isArray(value.Items) ? value.Items : [];
}
function knownTicks(value) {
    const decimal = ticks(value);
    if (decimal === undefined)
        return undefined;
    try { return position(decimal); } catch (error) { return undefined; }
}

export function createRemote(options) {
    const { request, item, userPath, userId, device, extensions, server, emby } = options;
    const targets = new Map();
    const snapshots = new Map();
    const queueReads = new Map();
    const mediaCache = new Map();
    const mutations = new Set();
    let snapshotSequence = 0;
    let listGeneration = 0;
    function guard() {
        if (extensions['spool.remote-targets'] !== 1)
            throw new Error('unsupported_extension');
    }
    function targetId(args) {
        guard();
        if (typeof args.targetId !== 'string' || !identity(args.targetId))
            throw new Error('invalid_target');
        return args.targetId;
    }
    function controllable(session) {
        return session && identity(session.Id) && session.DeviceId !== (device.id || 'spool')
            && (emby ? session.SupportsRemoteControl === true
                : session.Capabilities && session.Capabilities.SupportsMediaControl === true);
    }
    function supported(session) {
        const commands = emby ? session.SupportedCommands : (session.Capabilities || {}).SupportedCommands;
        return new Set(Array.isArray(commands) ? commands.filter(name => typeof name === 'string') : []);
    }
    function query(id) {
        const result = emby ? { ControllableByUserId: userId } : { controllableByUserId: userId };
        if (id && emby)
            result.Id = id;
        else if (id && targets.has(id) && targets.get(id).DeviceId)
            result.deviceId = targets.get(id).DeviceId;
        return result;
    }
    function session(host, id) {
        return request(host, 'GET', '/Sessions', query(id)).then(result => {
            const found = rows(result).find(row => String(row.Id) === id && controllable(row));
            if (!found) {
                targets.delete(id);
                snapshots.delete(id);
                throw new Error('target_unavailable');
            }
            return found;
        });
    }
    function queueAvailable(raw) {
        return emby ? Number.isInteger(raw.PlaylistLength) && raw.PlaylistLength > 0
            : Array.isArray(raw.NowPlayingQueue) && raw.NowPlayingQueue.length > 0;
    }
    function commands(raw) {
        const names = supported(raw);
        const play = raw.PlayState || {};
        const result = ['play', 'pause', 'unpause', 'stop', 'next', 'previous'];
        if (play.CanSeek === true)
            result.push('seek');
        if (emby && Number.isInteger(raw.PlaylistIndex) && Number.isInteger(raw.PlaylistLength)) {
            if (raw.PlaylistIndex <= 0)
                result.splice(result.indexOf('previous'), 1);
            if (raw.PlaylistIndex >= raw.PlaylistLength - 1)
                result.splice(result.indexOf('next'), 1);
        }
        for (const pair of [['SetVolume', 'volume'], ['SetAudioStreamIndex', 'audioTrack'],
            ['SetSubtitleStreamIndex', 'subtitleTrack'], ['SetRepeatMode', 'repeat']]) {
            if (names.has(pair[0]))
                result.push(pair[1]);
        }
        if (names.has('Mute') && names.has('Unmute'))
            result.push('mute');
        if (names.has('SetShuffleQueue') || names.has('SetPlaybackOrder'))
            result.push('shuffle');
        if (queueAvailable(raw))
            result.push('queuePlay', 'queueRemove', 'queueMove');
        return result;
    }
    function custom(raw) {
        const names = supported(raw);
        return Object.keys(advanced).some(name => names.has(name)) || names.has('SendString') || names.has('DisplayMessage');
    }
    function currentEntry(raw, entries) {
        const current = identity(raw.PlaylistItemId);
        if (current !== undefined) {
            const index = entries.findIndex(row => row.entryId === current);
            if (index >= 0)
                return index;
        }
        if (Number.isInteger(raw.PlaylistIndex) && raw.PlaylistIndex >= 0 && raw.PlaylistIndex < entries.length
            && raw.NowPlayingItem && entries[raw.PlaylistIndex].id === String(raw.NowPlayingItem.Id))
            return raw.PlaylistIndex;
        const matches = entries.map((row, index) => row.id === String((raw.NowPlayingItem || {}).Id) ? index : -1)
            .filter(index => index >= 0);
        return matches.length === 1 ? matches[0] : -1;
    }
    function normalize(raw) {
        const play = raw.PlayState || {};
        const media = raw.NowPlayingItem;
        const result = { state: media && identity(media.Id) ? play.IsPaused === true ? 'paused' : 'playing' : 'stopped',
            commands: commands(raw) };
        if (media && identity(media.Id)) {
            result.item = item(media);
            result.runtimeTicks = knownTicks(media.RunTimeTicks);
            result.preview = raw.preview;
        }
        result.positionTicks = knownTicks(play.PositionTicks);
        if (typeof play.VolumeLevel === 'number' && Number.isFinite(play.VolumeLevel)
            && play.VolumeLevel >= 0 && play.VolumeLevel <= 100)
            result.volume = play.VolumeLevel;
        if (typeof play.IsMuted === 'boolean')
            result.muted = play.IsMuted;
        if (typeof play.PlaybackRate === 'number' && Number.isFinite(play.PlaybackRate) && play.PlaybackRate > 0)
            result.rate = play.PlaybackRate;
        if (repeatModes.indexOf(play.RepeatMode) >= 0)
            result.repeatMode = play.RepeatMode;
        if (typeof play.Shuffle === 'boolean')
            result.shuffled = play.Shuffle;
        if (play.PlaybackOrder === 'Shuffle' || play.PlaybackOrder === 'Default')
            result.shuffled = play.PlaybackOrder === 'Shuffle';
        result.currentEntryId = identity(raw.PlaylistItemId);
        const mediaSource = play.MediaSource || (media && (media.MediaSources || []).find(source => source.Id === play.MediaSourceId));
        const streams = mediaSource && mediaSource.MediaStreams || media && media.MediaStreams;
        if (Array.isArray(streams)) {
            for (const kind of ['Audio', 'Subtitle']) {
                const seen = new Set();
                result[kind === 'Audio' ? 'audioTracks' : 'subtitleTracks'] = streams.filter(stream => {
                    if (stream.Type !== kind || !Number.isInteger(stream.Index) || stream.Index < 0 || seen.has(stream.Index))
                        return false;
                    seen.add(stream.Index);
                    return true;
                }).slice(0, 128).map(stream => ({ id: String(stream.Index),
                    label: stream.DisplayTitle || stream.Title || [stream.Language, stream.Codec].filter(Boolean).join(' · ')
                        || 'Track ' + (stream.Index + 1), selected: stream.Index === play[kind + 'StreamIndex'] }));
            }
        }
        // Neither service promises a monotonic queue revision or command acknowledgement.
        return result;
    }
    function hydrate(host, id, raw) {
        const media = raw.NowPlayingItem;
        if (!media || !identity(media.Id)) {
            mediaCache.delete(id);
            return Promise.resolve(raw);
        }
        const key = String(media.Id) + ':' + String((raw.PlayState || {}).MediaSourceId || '');
        let cached = mediaCache.get(id);
        if (!cached || cached.key !== key) {
            const details = request(host, 'GET', userPath('/Items/') + encodeURIComponent(media.Id),
                { Fields: 'MediaSources' }).then(details => String(details.Id) === String(media.Id) ? details : {}, () => ({}));
            const thumbnails = request(host, 'GET', '/Items/' + encodeURIComponent(media.Id) + '/ThumbnailSet', { Width: 320 })
                .then(value => value, () => null);
            cached = { key: key, pending: Promise.all([details, thumbnails]).then(([details, thumbnails]) => ({
                media: details, preview: options.trickplay(details, (raw.PlayState || {}).MediaSourceId,
                    thumbnails, server, options.previewHeaders())
            })) };
            mediaCache.set(id, cached);
            if (mediaCache.size > 128)
                mediaCache.delete(mediaCache.keys().next().value);
        }
        return cached.pending.then(details => Object.assign({}, raw, {
            NowPlayingItem: Object.assign({}, details.media, media), preview: details.preview
        }));
    }
    function state(host, id) {
        return session(host, id).then(raw => hydrate(host, id, raw)).then(normalize);
    }
    function loadQueue(host, id, raw) {
        const pending = emby ? request(host, 'GET', '/Sessions/PlayQueue', { Id: id })
            : Promise.resolve(raw.NowPlayingQueue);
        return pending.then(value => {
            if (!Array.isArray(value) && (!value || !Array.isArray(value.Items)))
                throw new Error('remote_queue_unavailable');
            const entries = rows(value);
            if (entries.length > 10000 || (Number.isInteger(value.TotalRecordCount) && value.TotalRecordCount !== entries.length))
                throw new Error('response_limit');
            const seen = new Set();
            const metadata = new Map();
            for (const entry of entries) {
                const entryId = identity(entry.PlaylistItemId);
                if (!identity(entry.Id) || entryId === undefined || seen.has(entryId))
                    throw new Error('remote_queue_unavailable');
                seen.add(entryId);
                if (entry.Type && typeof entry.Name === 'string')
                    metadata.set(String(entry.Id), entry);
            }
            const missing = Array.from(new Set(entries.map(row => String(row.Id)))).filter(id => !metadata.has(id));
            let offset = 0;
            function batch() {
                if (offset >= missing.length)
                    return Promise.resolve();
                const ids = missing.slice(offset, offset += 50);
                return request(host, 'GET', userPath('/Items'), { Ids: ids.join(','), Fields: 'MediaSources', Limit: 50 })
                    .then(result => {
                        for (const row of rows(result)) {
                            if (ids.indexOf(String(row.Id)) >= 0)
                                metadata.set(String(row.Id), row);
                        }
                        return batch();
                    });
            }
            return Promise.all([batch(), batch()]).then(() => entries.map(entry => {
                const found = metadata.get(String(entry.Id));
                if (!found)
                    throw new Error('remote_queue_unavailable');
                return Object.assign(item(found), { entryId: identity(entry.PlaylistItemId) });
            }));
        });
    }
    function general(host, id, name, arguments_) {
        return request(host, 'POST', '/Sessions/' + encodeURIComponent(id) + '/Command', {},
            { Name: name, ControllingUserId: userId, Arguments: arguments_ || {} });
    }
    function playstate(host, id, name, decimal) {
        return request(host, 'POST', '/Sessions/' + encodeURIComponent(id) + '/Playing/' + name,
            emby ? {} : { controllingUserId: userId, seekPositionTicks: decimal },
            emby ? { Command: name, ControllingUserId: userId,
                SeekPositionTicks: decimal === undefined ? undefined : tickInteger(decimal) } : undefined);
    }
    function play(host, id, command) {
        const names = { now: 'PlayNow', next: 'PlayNext', last: 'PlayLast', shuffle: 'PlayShuffle' };
        const parameters = emby ? { ItemIds: command.itemIds.join(','), PlayCommand: names[command.mode],
            StartPositionTicks: position(command.positionTicks) }
            : { itemIds: command.itemIds.join(','), playCommand: names[command.mode],
                startPositionTicks: position(command.positionTicks), startIndex: command.index, mediaSourceId: command.variantId };
        const path = '/Sessions/' + encodeURIComponent(id) + '/Playing';
        const length = Object.keys(parameters).reduce((sum, key) => sum + key.length
            + encodeURIComponent(parameters[key] === undefined ? '' : String(parameters[key])).length + 2, server.length + path.length + 8);
        if (length > 8192)
            throw new Error('remote_queue_too_large');
        return request(host, 'POST', path, parameters, emby ? { StartIndex: command.index,
            MediaSourceId: command.variantId, ControllingUserId: userId } : undefined);
    }
    function validate(command) {
        if (!command || typeof command.action !== 'string')
            throw new Error('invalid_command');
        if (command.action === 'play') {
            if (!Array.isArray(command.itemIds) || !command.itemIds.length || command.itemIds.length > 10000
                || command.itemIds.some(id => typeof id !== 'string' || !identity(id) || id.indexOf(',') >= 0)
                || !Number.isInteger(command.index) || command.index < 0 || command.index >= command.itemIds.length
                || ['now', 'next', 'last', 'shuffle'].indexOf(command.mode) < 0
                || (command.variantId !== undefined && (typeof command.variantId !== 'string' || !identity(command.variantId))))
                throw new Error('invalid_command');
            position(command.positionTicks);
        } else if (command.action === 'seek') {
            position(command.positionTicks);
        } else if (command.action === 'volume') {
            if (!Number.isInteger(command.value) || command.value < 0 || command.value > 100)
                throw new Error('invalid_command');
        } else if (command.action === 'mute' || command.action === 'shuffle') {
            if (typeof command.value !== 'boolean')
                throw new Error('invalid_command');
        } else if (command.action === 'audioTrack' || command.action === 'subtitleTrack') {
            if (!(command.action === 'subtitleTrack' && command.trackId === null)
                && (typeof command.trackId !== 'string' || !/^(0|[1-9]\d*)$/.test(command.trackId)
                    || Number(command.trackId) > 2147483647))
                throw new Error('invalid_track');
        } else if (command.action === 'repeat') {
            if (repeatModes.indexOf(command.mode) < 0)
                throw new Error('invalid_command');
        } else if (['queuePlay', 'queueRemove', 'queueMove'].indexOf(command.action) >= 0) {
            if (typeof command.entryId !== 'string' || !identity(command.entryId))
                throw new Error('invalid_entry');
            if (command.action === 'queueMove' && (!Number.isInteger(command.index) || command.index < 0
                || (command.afterEntryId !== null && (typeof command.afterEntryId !== 'string' || !identity(command.afterEntryId)))))
                throw new Error('invalid_command');
        } else if (!Object.prototype.hasOwnProperty.call(transport, command.action)) {
            throw new Error('invalid_command');
        }
    }
    function confirmReplacement(host, id, ids, index, decimal, attempt) {
        return session(host, id).then(raw => {
            const playState = raw.PlayState || {};
            const observed = knownTicks(playState.PositionTicks);
            // Divide before numeric conversion; all signed-64-bit whole seconds
            // fit exactly. This tolerance never rounds the transmitted position.
            if (!raw.NowPlayingItem || String(raw.NowPlayingItem.Id) !== ids[index] || playState.IsPaused === true
                || observed === undefined || Math.abs(Number(observed.slice(0, -7) || '0') - Number(decimal.slice(0, -7) || '0')) > 3)
                return false;
            return loadQueue(host, id, raw).then(queue => queue.length === ids.length
                && queue.every((row, i) => row.id === ids[i]) && currentEntry(raw, queue) === index);
        }).then(confirmed => {
            if (confirmed)
                return;
            if (attempt >= 7)
                throw new Error('remote_confirmation_timeout');
            return host.delay(500).then(() => confirmReplacement(host, id, ids, index, decimal, attempt + 1));
        });
    }
    function replaceQueue(host, id, raw, command) {
        return loadQueue(host, id, raw).then(queue => {
            const source = queue.findIndex(row => row.entryId === command.entryId);
            if (source < 0)
                throw new Error('entry_unavailable');
            const current = currentEntry(raw, queue);
            if (current < 0)
                throw new Error('remote_current_entry_unknown');
            const currentId = queue[current].entryId;
            let index = current;
            let decimal = knownTicks((raw.PlayState || {}).PositionTicks);
            if (command.action === 'queueMove') {
                const moved = queue.splice(source, 1)[0];
                if (command.index > queue.length || (command.index === 0 ? command.afterEntryId !== null
                    : queue[command.index - 1].entryId !== command.afterEntryId))
                    throw new Error('invalid_command');
                queue.splice(command.index, 0, moved);
                index = queue.findIndex(row => row.entryId === currentId);
            } else if (command.action === 'queueRemove') {
                queue.splice(source, 1);
                index = queue.findIndex(row => row.entryId === currentId);
                if (index < 0) {
                    index = Math.min(source, queue.length - 1);
                    decimal = '0';
                }
            } else {
                index = source;
                decimal = '0';
            }
            if (!queue.length)
                return playstate(host, id, 'Stop');
            if (decimal === undefined)
                throw new Error('remote_position_unknown');
            const ids = queue.map(row => row.id);
            return play(host, id, { itemIds: ids, index: index, positionTicks: decimal, mode: 'now',
                variantId: queue[index].entryId === currentId ? (raw.PlayState || {}).MediaSourceId : undefined })
                .then(() => confirmReplacement(host, id, ids, index, decimal, 0))
                .then(() => (raw.PlayState || {}).IsPaused === true ? playstate(host, id, 'Pause') : undefined);
        });
    }
    function dispatch(host, id, raw, command) {
        if (commands(raw).indexOf(command.action) < 0)
            throw new Error('command_unavailable');
        if (command.action === 'play')
            return play(host, id, command);
        if (transport[command.action])
            return playstate(host, id, transport[command.action]);
        if (command.action === 'seek') {
            const maximum = knownTicks((raw.NowPlayingItem || {}).RunTimeTicks);
            const decimal = position(command.positionTicks);
            if (maximum !== undefined && (decimal.length > maximum.length || decimal.length === maximum.length && decimal > maximum))
                throw new Error('invalid_position');
            return playstate(host, id, 'Seek', decimal);
        }
        if (command.action === 'volume')
            return general(host, id, 'SetVolume', { Volume: String(command.value) });
        if (command.action === 'mute')
            return general(host, id, command.value ? 'Mute' : 'Unmute');
        if (command.action === 'repeat')
            return general(host, id, 'SetRepeatMode', { RepeatMode: command.mode });
        if (command.action === 'shuffle')
            return supported(raw).has('SetShuffleQueue')
                ? general(host, id, 'SetShuffleQueue', { ShuffleMode: command.value ? 'Shuffle' : 'Sorted' })
                : general(host, id, 'SetPlaybackOrder', { PlaybackOrder: command.value ? 'Shuffle' : 'Default' });
        if (command.action === 'audioTrack' || command.action === 'subtitleTrack') {
            return hydrate(host, id, raw).then(details => {
                const tracks = normalize(details)[command.action === 'audioTrack' ? 'audioTracks' : 'subtitleTracks'];
                if (command.trackId !== null && (!tracks || !tracks.some(track => track.id === command.trackId)))
                    throw new Error('invalid_track');
                return general(host, id, command.action === 'audioTrack' ? 'SetAudioStreamIndex' : 'SetSubtitleStreamIndex',
                    { Index: command.trackId === null ? '-1' : command.trackId });
            });
        }
        return replaceQueue(host, id, raw, command);
    }
    function mutate(id, operation) {
        if (mutations.has(id))
            throw new Error('remote_busy');
        mutations.add(id);
        snapshots.delete(id);
        queueReads.delete(id);
        return Promise.resolve().then(operation).then(() => {
            mutations.delete(id);
            if (options.emit)
                options.emit('remoteChanged', { targetId: id });
            return {};
        }, error => {
            mutations.delete(id);
            snapshots.delete(id);
            if (options.emit)
                options.emit('remoteChanged', { targetId: id });
            throw error;
        });
    }
    return {
        remoteTargets: (args, host) => {
            guard();
            const generation = ++listGeneration;
            return request(host, 'GET', '/Sessions', query()).then(result => {
                const found = rows(result).filter(controllable).slice(0, 128);
                if (generation === listGeneration) {
                    targets.clear();
                    for (const raw of found)
                        targets.set(String(raw.Id), raw);
                    for (const id of snapshots.keys())
                        if (!targets.has(id))
                            snapshots.delete(id);
                }
                return { targets: found.map(raw => ({ id: String(raw.Id), name: raw.DeviceName || raw.Client || String(raw.Id),
                    detail: [raw.Client, raw.UserName].filter(Boolean).join(' · '), commands: commands(raw),
                    queueEditing: 'replace', customControls: custom(raw) })) };
            });
        },
        remoteConnect: (args, host) => state(host, targetId(args)),
        remoteState: (args, host) => state(host, targetId(args)),
        remoteQueue: (args, host) => {
            const id = targetId(args);
            const limit = args.limit === undefined ? 50 : args.limit;
            if (!Number.isInteger(limit) || limit < 1 || limit > 100)
                throw new Error('invalid_limit');
            let first = 0;
            let pending;
            if (args.cursor !== undefined && args.cursor !== null) {
                const match = /^(\d+):(\d+)$/.exec(String(args.cursor));
                const snapshot = snapshots.get(id);
                if (!match || !snapshot || match[1] !== snapshot.id || Number(match[2]) !== snapshot.next)
                    throw new Error('invalid_cursor');
                first = snapshot.next;
                pending = Promise.resolve(snapshot);
            } else {
                const sequence = String(++snapshotSequence);
                queueReads.set(id, sequence);
                snapshots.delete(id);
                pending = session(host, id).then(raw => loadQueue(host, id, raw)).then(entries => {
                    if (queueReads.get(id) !== sequence)
                        throw new Error('invalid_cursor');
                    const snapshot = { id: sequence, entries: entries, next: 0 };
                    snapshots.set(id, snapshot);
                    return snapshot;
                });
            }
            return pending.then(snapshot => {
                const end = Math.min(first + limit, snapshot.entries.length);
                snapshot.next = end;
                return { items: snapshot.entries.slice(first, end), total: snapshot.entries.length,
                    exhausted: end === snapshot.entries.length, cursor: end === snapshot.entries.length ? null : snapshot.id + ':' + end };
            });
        },
        remoteCommand: (args, host) => {
            const id = targetId(args);
            validate(args.command);
            return mutate(id, () => session(host, id).then(raw => dispatch(host, id, raw, args.command)));
        },
        remoteControls: (args, host) => session(host, targetId(args)).then(raw => {
            const names = supported(raw);
            return { controls: Object.keys(advanced).filter(name => names.has(name)).map(name => ({ id: name, label: advanced[name] })),
                text: names.has('SendString'), message: names.has('DisplayMessage') };
        }),
        remoteControl: (args, host) => {
            const id = targetId(args);
            const text = args.name === 'SendString' || args.name === 'DisplayMessage';
            if ((!text && !Object.prototype.hasOwnProperty.call(advanced, args.name))
                || (text && (typeof args.value !== 'string' || !args.value.length || args.value.length > 4096)))
                throw new Error('invalid_command');
            return mutate(id, () => session(host, id).then(raw => {
                if (!supported(raw).has(args.name))
                    throw new Error('command_unavailable');
                return general(host, id, args.name, args.name === 'SendString' ? { String: args.value }
                    : args.name === 'DisplayMessage' ? { Text: args.value, Header: 'Spool' } : {});
            }));
        }
    };
}
