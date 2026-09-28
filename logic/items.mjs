// SPDX-License-Identifier: MPL-2.0
// Emby JSON to Spool's normalized shapes (see sdk/provider.d.ts).

export const fields = 'SortName,Overview,ProductionYear,PremiereDate,EndDate,Status,DateCreated,DateLastContentAdded,'
    + 'ImageTags,BackdropImageTags,ParentBackdropImageTags,ParentThumbImageTag,SeriesPrimaryImageTag,UserData,'
    + 'RunTimeTicks,ChildCount,RecursiveItemCount,LocationType,Genres,Tags,Studios,ProviderIds,'
    + 'OfficialRating,CommunityRating,CriticRating,AlbumPrimaryImageTag';

export const detailFields = fields + ',People,MediaSources,ExternalUrls,Chapters';

export const collectionTypes = {
    movies: 'Movie', tvshows: 'Series', playlists: 'Playlist', boxsets: 'BoxSet',
    music: 'MusicAlbum', books: 'Book,AudioBook', photos: 'PhotoAlbum,Photo', musicvideos: 'MusicVideo',
    homevideos: 'Folder,Video,PhotoAlbum,Photo'
};

// Ticks can exceed JS's safe integers; pass them on as decimal strings.
export function ticks(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'string' && /^\d+$/.test(value))
        return value;
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}

function id(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return String(value);
    return typeof value === 'string' && value ? value : undefined;
}

// Emby names HDR formats differently from the rest of Spool's providers.
const rangeTypes = { DolbyVision: 'DOVI', Hdr10: 'HDR10', Hdr10Plus: 'HDR10Plus', HyperLogGamma: 'HLG' };

export function stream(raw) {
    return {
        index: raw.Index, type: raw.Type, codec: raw.Codec || '', profile: raw.Profile || '',
        language: raw.Language || '', title: raw.DisplayTitle || raw.Title || '',
        width: raw.Width || 0, height: raw.Height || 0, frameRate: raw.RealFrameRate || raw.AverageFrameRate || 0,
        bitrate: raw.BitRate || 0, bitDepth: raw.BitDepth || 0, channels: raw.Channels || 0,
        sampleRate: raw.SampleRate || 0, range: raw.VideoRange || '',
        rangeType: rangeTypes[raw.ExtendedVideoType] || raw.VideoRange || '',
        default: Boolean(raw.IsDefault), forced: Boolean(raw.IsForced), external: Boolean(raw.IsExternal),
        interlaced: Boolean(raw.IsInterlaced)
    };
}

// Only the file name leaves the server: full paths reveal its layout.
function variant(raw) {
    return {
        id: String(raw.Id), label: raw.Name || '', container: (raw.Container || '').split(',')[0],
        filename: (raw.Path || '').split(/[\\/]/).pop(), sizeBytes: ticks(raw.Size),
        bitrate: raw.Bitrate || 0, runtimeTicks: ticks(raw.RunTimeTicks),
        streams: (raw.MediaStreams || []).map(stream)
    };
}

export function item(raw, features = {}) {
    const itemId = id(raw.Id);
    if (!itemId)
        throw new Error('missing_id');
    const user = raw.UserData || {};
    const images = raw.ImageTags || {};
    const result = {
        id: itemId, title: raw.Name || '', sortName: raw.SortName || '', type: raw.Type || 'Folder',
        entryId: id(raw.PlaylistItemId),
        overview: raw.Overview || '', year: raw.ProductionYear || 0,
        runtimeTicks: ticks(raw.RunTimeTicks), resumeTicks: ticks(user.PlaybackPositionTicks),
        favorite: Boolean(user.IsFavorite), played: Boolean(user.Played), playCount: user.PlayCount || 0,
        datePlayed: user.LastPlayedDate || '', dateCreated: raw.DateCreated || '',
        dateUpdated: raw.DateLastContentAdded || '', premiereDate: raw.PremiereDate || '', endDate: raw.EndDate || '',
        status: raw.Status || '', childCount: raw.ChildCount || raw.RecursiveItemCount || 0,
        virtual: raw.LocationType === 'Virtual',
        seriesId: id(raw.SeriesId), seriesName: raw.SeriesName || '', seasonId: id(raw.SeasonId),
        // Season 0 holds specials; keep it rather than reading it as missing.
        season: Number.isInteger(raw.ParentIndexNumber) ? raw.ParentIndexNumber : undefined,
        episode: Number.isInteger(raw.IndexNumber) ? raw.IndexNumber : undefined,
        album: raw.Album || '', albumId: id(raw.AlbumId), albumArtist: raw.AlbumArtist || '',
        posterTag: images.Primary || '', logoTag: images.Logo || '', bannerTag: images.Banner || '',
        thumbTag: images.Thumb || (features.artworkOwners && id(raw.ParentThumbItemId) ? raw.ParentThumbImageTag : '') || '',
        thumbItemId: images.Thumb || !features.artworkOwners ? undefined : id(raw.ParentThumbItemId),
        backdropTag: (raw.BackdropImageTags || [])[0]
            || (features.artworkOwners && id(raw.ParentBackdropItemId) ? (raw.ParentBackdropImageTags || [])[0] : '') || '',
        backdropItemId: (raw.BackdropImageTags || [])[0] || !features.artworkOwners ? undefined : id(raw.ParentBackdropItemId),
        seriesPosterTag: raw.SeriesPrimaryImageTag || '', albumPosterTag: raw.AlbumPrimaryImageTag || '',
        genres: raw.Genres || [], tags: raw.Tags || [], studios: (raw.Studios || []).map(s => s.Name),
        officialRating: raw.OfficialRating || '', communityRating: raw.CommunityRating || 0,
        criticRating: raw.CriticRating || 0, externalIds: raw.ProviderIds || {}
    };
    if (raw.People)
        result.people = raw.People.filter(p => id(p.Id)).map(p => ({
            id: id(p.Id), name: p.Name || '', type: p.Type || '', role: p.Role || '', imageTag: p.PrimaryImageTag || ''
        }));
    if (raw.MediaSources)
        result.variants = raw.MediaSources.map(variant);
    if (raw.ExternalUrls)
        result.links = raw.ExternalUrls.map(link => ({ name: link.Name || '', url: link.Url || '' }));
    return result;
}

export function page(result, start, limit, features = {}) {
    const rows = Array.isArray(result) ? result : result.Items || [];
    const total = Number.isSafeInteger(result.TotalRecordCount) ? result.TotalRecordCount : null;
    const exhausted = total !== null ? start + rows.length >= total : rows.length < limit;
    return { items: rows.filter(row => id(row.Id)).map(row => item(row, features)), total: total,
        exhausted: exhausted, cursor: exhausted ? null : String(start + rows.length) };
}

// Emby marks intros and credits as chapters rather than as segments.
export function segments(raw) {
    const chapters = (raw && raw.Chapters) || [];
    const at = type => {
        const chapter = chapters.find(c => c.MarkerType === type);
        return chapter ? ticks(chapter.StartPositionTicks) : undefined;
    };
    const result = [];
    const introStart = at('IntroStart');
    const introEnd = at('IntroEnd');
    if (introStart !== undefined && introEnd !== undefined && Number(introEnd) > Number(introStart))
        result.push({ type: 'Intro', startTicks: introStart, endTicks: introEnd });
    const credits = at('CreditsStart');
    const runtime = ticks(raw && raw.RunTimeTicks);
    if (credits !== undefined && runtime !== undefined && Number(runtime) > Number(credits))
        result.push({ type: 'Outro', startTicks: credits, endTicks: runtime });
    return result;
}
