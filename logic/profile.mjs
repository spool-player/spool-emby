// SPDX-License-Identifier: MPL-2.0
// The DeviceProfile Emby negotiates playback against, built from what
// Spool reports this device decodes and the ceiling the viewer chose.

const hlsPreference = ['hevc', 'h264', 'av1', 'vp9'];
const subtitleFormats = ['srt', 'ass', 'ssa', 'vtt', 'pgssub', 'dvdsub'];

export function maxBitrate(context, inLocalNetwork) {
    return context.maxBitrate || (context.unlimitedLocalNetwork && inLocalNetwork ? 1000000000 : 0)
        || context.preferredMaxBitrate || context.measuredBitrate || 120000000;
}

export function maxHeight(context) {
    return context.maxHeight || context.preferredMaxHeight || 0;
}

export function deviceProfile(context, inLocalNetwork) {
    // Never raise an explicit ceiling, even below the speed probe's 1 Mbps floor.
    const bitrate = Math.min(maxBitrate(context, inLocalNetwork), 1000000000);
    const height = maxHeight(context);
    const codecs = (context.videoCodecs || []).map(c => String(c).trim().toLowerCase()).filter(Boolean);
    const restrict = Boolean(context.restrictVideoCodecs);
    // mpv decodes every audio format itself, so audio never forces a transcode.
    const directPlay = [{ Type: 'Audio' }];
    if (!restrict)
        directPlay.unshift({ Type: 'Video' });
    else if (codecs.length > 0)
        directPlay.unshift({ Type: 'Video', VideoCodec: codecs.join(',') });
    const output = restrict ? hlsPreference.filter(c => codecs.indexOf(c) >= 0) : hlsPreference;
    return {
        Name: 'Spool',
        MaxStreamingBitrate: bitrate,
        MaxStaticBitrate: bitrate,
        MusicStreamingTranscodingBitrate: 1280000,
        DirectPlayProfiles: directPlay,
        TranscodingProfiles: (output.length ? [{
            Type: 'Video', Container: 'mp4', Protocol: 'hls', Context: 'Streaming',
            AudioCodec: 'aac,ac3,eac3,mp3,flac,opus,dts,truehd', VideoCodec: output.join(','),
            MaxAudioChannels: '6', MinSegments: 2, BreakOnNonKeyFrames: false
        }] : []).concat([{ Type: 'Audio', Container: 'mp3', Protocol: 'http', Context: 'Streaming',
            AudioCodec: 'mp3' }]),
        ContainerProfiles: [],
        // Missing dimensions must not silently defeat an explicit height ceiling.
        CodecProfiles: height > 0 ? [{ Type: 'Video', Conditions: [{
            Condition: 'LessThanEqual', Property: 'Height', Value: String(height), IsRequired: true
        }] }] : [],
        // The host can play embedded subtitles; sidecars must be burned by Emby.
        SubtitleProfiles: [].concat(...subtitleFormats.map(f => [{ Format: f, Method: 'Embed' },
            { Format: f, Method: 'Encode' }])),
        ResponseProfiles: []
    };
}

// A remux preference is not permission to serve the unbounded original file.
export function canCopySource(source, context, inLocalNetwork) {
    if (source.Bitrate > maxBitrate(context, inLocalNetwork))
        return false;
    const height = maxHeight(context);
    const codecs = (context.videoCodecs || []).map(c => String(c).trim().toLowerCase());
    return (source.MediaStreams || []).filter(s => s.Type === 'Video').every(video =>
        (!height || (video.Height > 0 && video.Height <= height))
        && (!context.restrictVideoCodecs || codecs.indexOf(String(video.Codec || '').toLowerCase()) >= 0));
}
