// SPDX-License-Identifier: MPL-2.0
// Emby's websocket, translated into Spool's `remote` and `changed` events.
// The connection lives as long as the account and comes back by itself after
// a drop.

import { ticks } from './items.mjs';

const playstate = {
    Stop: 'stop', Pause: 'pause', Unpause: 'unpause', PlayPause: 'playPause', NextTrack: 'next',
    PreviousTrack: 'previous', Rewind: 'rewind', FastForward: 'fastForward'
};

const general = {
    VolumeUp: ['volumeStep', { delta: 5 }], VolumeDown: ['volumeStep', { delta: -5 }],
    Mute: ['mute', { value: true }], Unmute: ['mute', { value: false }], ToggleMute: ['toggleMute', {}],
    ToggleStats: ['stats', {}], ToggleOsd: ['navigate', { to: 'toggle-osd' }],
    ToggleOsdMenu: ['navigate', { to: 'context-menu' }], ToggleContextMenu: ['navigate', { to: 'context-menu' }],
    ToggleFullscreen: ['navigate', { to: 'fullscreen' }], GoHome: ['navigate', { to: 'home' }],
    GoToSettings: ['navigate', { to: 'settings' }], GoToSearch: ['navigate', { to: 'search' }]
};

const keys = {
    MoveUp: 'up', MoveDown: 'down', MoveLeft: 'left', MoveRight: 'right', PageUp: 'pageUp', PageDown: 'pageDown',
    PreviousLetter: 'pageUp', NextLetter: 'pageDown', Select: 'select', Back: 'back', Home: 'home', End: 'end',
    Space: 'space'
};

export const remoteCommands = Object.keys(general).concat(Object.keys(keys), ['SendKey', 'SendString', 'SetVolume',
    'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'SetRepeatMode', 'DisplayContent', 'DisplayMessage']);

function remoteGeneral(name, args) {
    if (general[name])
        return Object.assign({ command: general[name][0] }, general[name][1]);
    if (keys[name])
        return { command: 'key', name: keys[name] };
    switch (name) {
    case 'SendKey': return keys[args.Key] ? { command: 'key', name: keys[args.Key] } : null;
    case 'SendString': return { command: 'text', value: String(args.String || '') };
    case 'SetVolume': return { command: 'volume', value: Number(args.Volume) || 0 };
    case 'SetAudioStreamIndex': return { command: 'audioTrack', index: Number(args.Index) };
    case 'SetSubtitleStreamIndex': return { command: 'subtitleTrack', index: Number(args.Index) };
    case 'SetRepeatMode': return { command: 'repeat', mode: String(args.RepeatMode || 'RepeatNone') };
    case 'DisplayContent': return { command: 'show', itemId: String(args.ItemId || ''), itemType: args.ItemType || '', title: args.ItemName || '' };
    case 'DisplayMessage': return { command: 'message', text: String(args.Text || '') };
    default: return null;
    }
}

export function translate(message, emit) {
    const data = message.Data || {};
    switch (message.MessageType) {
    case 'Play':
        emit('remote', { command: 'play', itemIds: (data.ItemIds || []).map(String), index: data.StartIndex || 0,
            positionTicks: ticks(data.StartPositionTicks) || '0',
            mode: { PlayNext: 'next', PlayLast: 'last', PlayShuffle: 'shuffle' }[data.PlayCommand] || 'now' });
        break;
    case 'Playstate':
        if (data.Command === 'Seek')
            emit('remote', { command: 'seek', positionTicks: ticks(data.SeekPositionTicks) || '0' });
        else if (playstate[data.Command])
            emit('remote', { command: playstate[data.Command] });
        break;
    case 'GeneralCommand': {
        const command = remoteGeneral(data.Name, data.Arguments || {});
        if (command)
            emit('remote', command);
        break;
    }
    case 'LibraryChanged':
        emit('changed', {});
        break;
    case 'UserDataChanged':
        for (const entry of data.UserDataList || [])
            if (entry.ItemId)
                emit('changed', { itemId: String(entry.ItemId) });
        break;
    }
}

// Opens the socket, keeps it alive and reopens it after a drop, backing off
// up to a minute. Returns a function that closes it for good.
export function connect(host, url, headers, invalidatePolicy, outboundEnabled = false) {
    let socket = null;
    let stopped = false;
    let failures = 0;
    let keepAlive = 30;
    // Only the newest keep-alive loop runs: the server may ask again, and a
    // reconnect starts over.
    let pings = 0;
    const send = value => socket && socket.send(JSON.stringify(value));
    function ping(generation) {
        host.delay(keepAlive * 1000).then(() => {
            if (!stopped && socket && generation === pings) {
                send({ MessageType: 'KeepAlive' });
                ping(generation);
            }
        });
    }
    function open() {
        if (stopped)
            return;
        try {
            socket = host.socket(url, { headers: headers });
        } catch (error) {
            return;
        }
        socket.onopen = () => {
            if (invalidatePolicy)
                invalidatePolicy();
            failures = 0;
            send({ MessageType: 'KeepAlive' });
            ping(++pings);
        };
        socket.onmessage = text => {
            let message;
            try {
                message = JSON.parse(text);
            } catch (error) {
                return;
            }
            if (invalidatePolicy && ['UserUpdated', 'UserDeleted', 'UserConfigurationUpdated',
                'UserPolicyUpdated'].indexOf(message.MessageType) >= 0)
                invalidatePolicy();
            if (outboundEnabled && message.MessageType === 'Sessions' && Array.isArray(message.Data)) {
                for (const session of message.Data.slice(0, 128)) {
                    if (typeof session.Id === 'string' && session.Id && session.DeviceId !== (host.device || {}).id)
                        host.emit('remoteChanged', { targetId: session.Id });
                }
            }
            if (message.MessageType === 'ForceKeepAlive') {
                keepAlive = Math.max(5, Math.min(60, (Number(message.Data) || 60) / 2));
                send({ MessageType: 'KeepAlive' });
                ping(++pings);
            } else {
                translate(message, host.emit);
            }
        };
        socket.onclose = () => {
            socket = null;
            pings += 1;
            if (stopped)
                return;
            failures += 1;
            host.delay(Math.min(60, 2 ** Math.min(failures, 6)) * 1000).then(open);
        };
    }
    open();
    return () => {
        stopped = true;
        if (socket)
            socket.close();
    };
}
