// SPDX-License-Identifier: MPL-2.0
// The DeviceProfile Jellyfin negotiates playback against, built from what
// Spool reports this device decodes and the ceiling the viewer chose.

const hlsPreference = ['hevc', 'h264', 'av1', 'vp9'];
const subtitleFormats = ['srt', 'ass', 'ssa', 'vtt', 'pgssub', 'dvdsub'];

export function maxBitrate(context) {
    return context.maxBitrate || context.preferredMaxBitrate || 120000000;
}

export function maxHeight(context) {
    return context.maxHeight || context.preferredMaxHeight || 0;
}

export function deviceProfile(context) {
    const bitrate = Math.min(Math.max(maxBitrate(context), 1000000), 1000000000);
    const height = maxHeight(context);
    const codecs = (context.videoCodecs || []).map(c => String(c).trim().toLowerCase()).filter(Boolean);
    const restrict = Boolean(context.restrictVideoCodecs);
    // mpv decodes every audio format itself, so audio never forces a transcode.
    const directPlay = [{ Type: 'Audio' }];
    if (!restrict)
        directPlay.unshift({ Type: 'Video' });
    else if (codecs.length > 0)
        directPlay.unshift({ Type: 'Video', VideoCodec: codecs.join(',') });
    let output = restrict ? hlsPreference.filter(c => codecs.indexOf(c) >= 0) : hlsPreference;
    if (output.length === 0)
        output = ['h264'];
    return {
        Name: 'Spool',
        MaxStreamingBitrate: bitrate,
        MaxStaticBitrate: bitrate,
        MusicStreamingTranscodingBitrate: 1280000,
        DirectPlayProfiles: directPlay,
        TranscodingProfiles: [{
            Type: 'Video', Container: 'mp4', Protocol: 'hls', Context: 'Streaming',
            AudioCodec: 'aac,ac3,eac3,mp3,flac,opus,dts,truehd', VideoCodec: output.join(','),
            MaxAudioChannels: '6', MinSegments: 2, BreakOnNonKeyFrames: false
        }],
        ContainerProfiles: [],
        // A source already under the ceiling direct plays rather than being
        // transcoded up to it, so the height condition is not required.
        CodecProfiles: height > 0 ? [{ Type: 'Video', Conditions: [{
            Condition: 'LessThanEqual', Property: 'Height', Value: String(height), IsRequired: false
        }] }] : [],
        // Qt's engine has no Array.prototype.flatMap.
        SubtitleProfiles: [].concat(...subtitleFormats.map(f => [{ Format: f, Method: 'Embed' },
            { Format: f, Method: 'External' }])),
        ResponseProfiles: []
    };
}
