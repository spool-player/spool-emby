// SPDX-License-Identifier: MPL-2.0
// Offline files use their own HTTP profile and device/session, never playback HLS.
export function createDownloads({ request, userPath, segment, query, streamUrl, server, token, device }) {
    let sequence = 0;
    const devicePrefix = (device.id || 'spool') + '-download-';
    function finite(raw, source) {
        return raw && raw.IsFolder !== true && raw.Type !== 'LiveTvChannel' && raw.Type !== 'TvChannel'
            && !(raw.PartCount > 1) && !(raw.AdditionalPartCount > 0) && !(source.PartCount > 1)
            && !source.IsInfiniteStream && !source.RequiresOpening && !source.RequiresClosing
            && !source.LiveStreamId && !source.RequiresLooping && !source.IsRemote && source.Protocol === 'File'
            && (!source.VideoType || source.VideoType === 'VideoFile');
    }
    function profile(args) {
        const bitrate = args.maxBitrate || 8000000;
        return { Name: 'Spool offline', MaxStreamingBitrate: bitrate, MaxStaticBitrate: bitrate,
            DirectPlayProfiles: [], ContainerProfiles: [], CodecProfiles: [], ResponseProfiles: [],
            SubtitleProfiles: [], TranscodingProfiles: [{ Type: 'Video', Container: 'mp4', Protocol: 'http',
                Context: 'Streaming', VideoCodec: 'h264', AudioCodec: 'aac', MaxAudioChannels: '2',
                MaxHeight: args.maxHeight || undefined, EstimateContentLength: false }] };
    }
    function progressive(source, playback, args, downloadDevice) {
        if (!source.SupportsTranscoding || source.TranscodingContainer !== 'mp4'
            || source.TranscodingSubProtocol !== 'http' || !playback.PlaySessionId || !source.TranscodingUrl)
            throw new Error('download_transcode_unavailable');
        const url = streamUrl(source.TranscodingUrl);
        const pieces = url.split('?');
        if (pieces.length !== 2 || !/\/Videos\/[^/]+\/stream\.mp4$/i.test(pieces[0])
            || pieces[0] !== server + '/emby/Videos/' + segment(args.itemId) + '/stream.mp4')
            throw new Error('download_transcode_unavailable');
        const parameters = {};
        for (const pair of pieces[1].split('&')) {
            const split = pair.indexOf('=');
            const name = decodeURIComponent(split < 0 ? pair : pair.slice(0, split));
            if (/^(api_key|token|access_token)$/i.test(name))
                continue;
            parameters[name] = decodeURIComponent(split < 0 ? '' : pair.slice(split + 1));
        }
        // Remove case-insensitive copies before writing the promised full-file settings.
        const overrides = { Static: false, StartTimeTicks: 0, DeviceId: downloadDevice,
            PlaySessionId: playback.PlaySessionId, MediaSourceId: source.Id, VideoCodec: 'h264', AudioCodec: 'aac',
            EnableAutoStreamCopy: false, AllowVideoStreamCopy: false, AllowAudioStreamCopy: false,
            SubtitleStreamIndex: -1 };
        const negotiated = name => {
            const key = Object.keys(parameters).find(key => key.toLowerCase() === name.toLowerCase());
            const value = Number(key && parameters[key]);
            return value > 0 && Number.isFinite(value) ? value : undefined;
        };
        if (args.maxHeight)
            overrides.MaxHeight = Math.min(args.maxHeight, negotiated('MaxHeight') || args.maxHeight);
        const bitrate = args.maxBitrate || 8000000;
        const audio = Math.min(negotiated('AudioBitrate') || 128000, Math.floor(bitrate / 4));
        overrides.AudioBitRate = audio;
        overrides.VideoBitRate = Math.min(negotiated('VideoBitrate') || bitrate - audio, bitrate - audio);
        for (const name of Object.keys(parameters)) {
            if (Object.keys(overrides).some(key => key.toLowerCase() === name.toLowerCase()))
                delete parameters[name];
        }
        return pieces[0] + '?' + query(Object.assign(parameters, overrides));
    }
    return {
        download: (args, host) => {
            if (args.mode !== 'original' && args.mode !== 'transcoded')
                throw new Error('invalid_download_mode');
            return Promise.all([request(host, 'GET', userPath('')),
                request(host, 'GET', userPath('/Items/' + segment(args.itemId)), { Fields: 'MediaSources' })])
                .then(([user, raw]) => {
                    if (!raw || String(raw.Id) !== args.itemId)
                        throw new Error('download_finite_file_unavailable');
                    const policy = user.Policy || {};
                    if (policy.EnableContentDownloading !== true || raw.CanDownload === false) {
                        host.log('warn', 'Emby download denied by server permissions', { mode: args.mode });
                        throw new Error('download_not_permitted');
                    }
                    const sources = (raw.MediaSources || []).filter(source => typeof source.Id === 'string' && source.Id);
                    const eligible = sources.filter(source => finite(raw, source));
                    if (args.variantId && !sources.some(source => String(source.Id) === args.variantId))
                        throw new Error('selected_variant_unavailable');
                    const source = args.variantId ? eligible.find(source => String(source.Id) === args.variantId)
                        : eligible.length === 1 && eligible[0];
                    if (!source) {
                        if (!args.variantId && eligible.length > 1)
                            return { pick: { kind: 'download', title: 'Choose version', itemId: args.itemId,
                                variants: eligible.map(source => ({ id: String(source.Id),
                                    label: source.Name || 'Version ' + (sources.indexOf(source) + 1),
                                    detail: (source.MediaStreams || []).filter(stream => stream.Type === 'Video')
                                        .map(stream => [stream.Height ? stream.Height + 'p' : '', stream.Codec || '']
                                            .filter(Boolean).join(' · ')).join(', ') })) } };
                        throw new Error('download_finite_file_unavailable');
                    }
                    const container = String(source.Container || '').toLowerCase();
                    if (!/^[a-z0-9]+$/.test(container) || /^(m3u8|mpd|hls)$/.test(container))
                        throw new Error('download_finite_file_unavailable');
                    if (args.mode === 'original') {
                        host.log('debug', 'Emby original download selected', { container: container });
                        return { url: server + '/emby/' + (raw.MediaType === 'Audio' || raw.Type === 'Audio' ? 'Audio/' : 'Videos/')
                            + segment(args.itemId) + '/stream?' + query({ Static: true, MediaSourceId: source.Id }),
                        headers: { 'X-Emby-Token': token }, container: container,
                        size: Number.isSafeInteger(source.Size) && source.Size > 0 ? source.Size : undefined };
                    }
                    if (raw.MediaType === 'Audio' || policy.EnableVideoPlaybackTranscoding !== true
                        || policy.EnableAudioPlaybackTranscoding !== true || policy.EnableSyncTranscoding === false)
                        throw new Error('download_transcode_not_permitted');
                    const downloadDevice = devicePrefix + Date.now().toString(36) + '-' + (++sequence);
                    host.log('trace', 'Negotiating Emby finite HTTP download', { mode: args.mode,
                        maxBitrate: args.maxBitrate || 8000000, maxHeight: args.maxHeight || 0 });
                    return request(host, 'POST', '/Items/' + segment(args.itemId) + '/PlaybackInfo',
                        { UserId: user.UserId || user.Id, DeviceId: downloadDevice }, {
                            UserId: user.Id, MediaSourceId: source.Id, StartTimeTicks: 0,
                            MaxStreamingBitrate: args.maxBitrate || 8000000, DeviceProfile: profile(args),
                            EnableDirectPlay: false, EnableDirectStream: false, EnableTranscoding: true,
                            IsPlayback: false, AutoOpenLiveStream: false, AllowVideoStreamCopy: false,
                            AllowAudioStreamCopy: false, SubtitleStreamIndex: -1
                        }).then(playback => {
                        const selected = (playback.MediaSources || []).find(value => String(value.Id) === String(source.Id));
                        if (playback.ErrorCode || !selected || !finite(raw, selected))
                            throw new Error('download_transcode_unavailable');
                        const url = progressive(selected, playback, args, downloadDevice);
                        host.log('debug', 'Emby progressive download ready', { container: 'mp4', protocol: 'http' });
                        return { url: url, container: 'mp4', headers: { 'X-Emby-Token': token },
                            cleanup: { deviceId: downloadDevice, playSessionId: playback.PlaySessionId } };
                    });
                });
        },
        downloadRelease: (args, host) => {
            const cleanup = args.cleanup || {};
            if (typeof cleanup.deviceId !== 'string' || cleanup.deviceId.indexOf(devicePrefix) !== 0
                || typeof cleanup.playSessionId !== 'string' || !cleanup.playSessionId)
                throw new Error('invalid_download_cleanup');
            return request(host, 'DELETE', '/Videos/ActiveEncodings', {
                DeviceId: cleanup.deviceId, PlaySessionId: cleanup.playSessionId
            }).then(() => {
                host.log('debug', 'Emby download encoder released');
                return {};
            });
        }
    };
}
