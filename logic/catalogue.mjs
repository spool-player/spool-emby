// SPDX-License-Identifier: MPL-2.0
// Optional catalogue contracts. All IDs here are server IDs, never host-scoped IDs.
export function createCatalogue({ request, list, userPath, segment, capabilities, userId, emby = false }) {
    let policy = null;
    let policyGeneration = 0;
    let queue = null;
    function invalidate() {
        policy = null;
        ++policyGeneration;
    }
    function requireCapability(id) {
        if (capabilities[id] !== true)
            throw new Error('unsupported_capability');
    }
    function userPolicy(host) {
        if (policy)
            return Promise.resolve(policy);
        const generation = policyGeneration;
        return request(host, 'GET', userPath('')).then(user => {
            if (generation !== policyGeneration)
                throw new Error('permissions_changed');
            policy = user.Policy || {};
            return policy;
        });
    }
    const rawItem = (host, id) => request(host, 'GET', userPath('/Items/' + segment(id)));
    function collectionAllowed(p) {
        return p.EnableCollectionManagement === true || p.IsAdministrator === true;
    }
    function deleteAllowed(raw, p) {
        if (raw.CanDelete === false)
            return false;
        return raw.CanDelete === true || p.EnableContentDeletion === true;
    }
    function editablePlaylist(host, raw) {
        if (raw.CanEditItems === false)
            return Promise.resolve(false);
        const fallback = () => {
            if (typeof raw.CanEditItems === 'boolean')
                return Promise.resolve(raw.CanEditItems);
            return userPolicy(host).then(p =>
                String(raw.OwnerUserId || raw.UserId || '') === userId || p.IsAdministrator === true);
        };
        if (emby)
            return fallback();
        return request(host, 'GET', '/Playlists/' + segment(String(raw.Id)) + '/Users/' + segment(userId))
            .then(permission => typeof permission.CanEdit === 'boolean' ? permission.CanEdit : fallback(), error => {
                if (error.message === 'http_403')
                    return false;
                if (error.message === 'http_404' || error.message === 'http_405')
                    return fallback();
                throw error;
            });
    }
    function container(host, id) {
        return rawItem(host, id).then(raw => {
            if (raw.Type !== 'Playlist' && raw.Type !== 'BoxSet')
                throw new Error('unsupported_collection');
            const ordered = raw.Type === 'Playlist';
            const permission = ordered ? editablePlaylist(host, raw)
                : userPolicy(host).then(p => raw.CanEditItems !== false && collectionAllowed(p));
            return permission.then(removable => ({
                ordered: ordered, removable: removable, moveMode: ordered && removable ? 'index' : 'none'
            }));
        });
    }
    const playlistTypes = ['Movie', 'Episode', 'Series', 'Season', 'Audio', 'MusicAlbum', 'MusicVideo', 'Video'];
    function allowedActions(host, raw) {
        return userPolicy(host).then(p => {
            const actions = [];
            if (playlistTypes.indexOf(raw.Type) >= 0 && p.EnablePlaylistAccess !== false)
                actions.push({ id: 'playlist', label: 'Add to playlist', icon: 'playlist_add' });
            if (['Movie', 'Series'].indexOf(raw.Type) >= 0 && collectionAllowed(p))
                actions.push({ id: 'collection', label: 'Add to collection', icon: 'library_add' });
            const permission = raw.Type === 'Playlist' ? editablePlaylist(host, raw)
                : Promise.resolve(raw.Type === 'BoxSet' && raw.CanEditItems !== false && collectionAllowed(p));
            return permission.then(editable => {
                if (editable)
                    actions.push({ id: 'rename', label: 'Rename', icon: 'drive_file_rename_outline' });
                if (deleteAllowed(raw, p))
                    actions.push({ id: 'delete', label: 'Delete from server', icon: 'delete' });
                return actions;
            });
        });
    }
    function authorizeAction(args, host) {
        if (['playlist', 'collection', 'rename', 'delete'].indexOf(args.action) < 0)
            throw new Error('unsupported_action');
        return rawItem(host, args.itemId).then(raw => allowedActions(host, raw)).then(actions => {
            if (!actions.some(action => action.id === args.action))
                throw new Error('permission_denied');
            if (args.targetId && (args.action === 'playlist' || args.action === 'collection')) {
                return rawItem(host, args.targetId).then(raw => {
                    if (raw.Type !== (args.action === 'playlist' ? 'Playlist' : 'BoxSet'))
                        throw new Error('unsupported_collection');
                    return args.action === 'playlist' ? editablePlaylist(host, raw)
                        : userPolicy(host).then(p => raw.CanEditItems !== false && collectionAllowed(p));
                }).then(allowed => {
                    if (!allowed)
                        throw new Error('permission_denied');
                });
            }
        });
    }
    function queueFields(args) {
        if (args.event === 'stop')
            return {};
        if (args.queue !== undefined || args.queueIndex !== undefined)
            requireCapability('playbackQueueReporting');
        if (args.queue !== undefined) {
            const snapshot = args.queue;
            if (!snapshot || typeof snapshot.revision !== 'string' || !snapshot.revision
                || !Array.isArray(snapshot.items) || snapshot.items.length > 10000)
                throw new Error('invalid_queue');
            if (!queue || snapshot.revision !== queue.revision) {
                const items = snapshot.items.map(row => {
                    if (!row || typeof row.itemId !== 'string' || !row.itemId
                        || (row.mediaType !== 'audio' && row.mediaType !== 'video')
                        || (row.entryId !== undefined && (typeof row.entryId !== 'string' || !row.entryId)))
                        throw new Error('invalid_queue');
                    return Object.freeze({ Id: row.itemId, PlaylistItemId: row.entryId });
                });
                queue = Object.freeze({ revision: snapshot.revision, items: Object.freeze(items) });
            }
        }
        if (args.queueIndex !== undefined && (!Number.isInteger(args.queueIndex) || args.queueIndex < 0
            || (queue && args.queueIndex >= queue.items.length)))
            throw new Error('invalid_queue');
        return queue ? { NowPlayingQueue: queue.items, PlaylistIndex: args.queueIndex,
            PlaylistLength: queue.items.length } : {};
    }
    function boundedLimit(args, maximum) {
        return Math.min(maximum, Math.max(1, Number.isInteger(args.limit) ? args.limit : maximum));
    }
    return {
        invalidate: invalidate,
        authorizeAction: authorizeAction,
        queueFields: queueFields,
        search: (args, host) => {
            const limit = boundedLimit(args, 100);
            const parameters = { SearchTerm: args.query, Recursive: true, EnableTotalRecordCount: false };
            return Promise.all([
                list(host, userPath('/Items'), { limit: limit }, Object.assign({}, parameters, { IncludeItemTypes: 'Series' })),
                list(host, userPath('/Items'), { limit: limit }, Object.assign({}, parameters, {
                    IncludeItemTypes: 'Movie,Series,Episode,MusicVideo,Video,Audio,MusicAlbum,MusicArtist,Book,AudioBook,BoxSet,Playlist,Season,Folder,Person,Trailer'
                }))
            ]).then(results => {
                const seen = new Set();
                const items = [];
                for (const result of results) {
                    for (const row of result.items) {
                        if (!seen.has(row.id) && items.length < limit) {
                            seen.add(row.id);
                            items.push(row);
                        }
                    }
                }
                return { items: items, cursor: null, exhausted: true };
            });
        },
        suggestions: (args, host) => {
            requireCapability('suggestions');
            const limit = boundedLimit(args, 60);
            return list(host, userPath('/Items'), { limit: limit }, {
                Recursive: true, IncludeItemTypes: 'Movie,Series', MediaTypes: 'Video',
                SortBy: 'IsFavoriteOrLiked,Random', EnableTotalRecordCount: false
            }).then(result => ({ items: result.items.slice(0, limit), cursor: null, exhausted: true }));
        },
        itemActions: (args, host) => {
            requireCapability('itemActions');
            return rawItem(host, args.itemId).then(raw => allowedActions(host, raw)).then(actions => ({ actions: actions }));
        },
        collectionInfo: (args, host) => {
            requireCapability('collectionEditing');
            return container(host, args.containerId);
        },
        collectionEntries: (args, host) => {
            requireCapability('collectionEditing');
            return container(host, args.containerId).then(info =>
                list(host, info.ordered ? '/Playlists/' + segment(args.containerId) + '/Items'
                    : userPath('/Items'), args, info.ordered ? {} : { ParentId: args.containerId, Recursive: false })
                    .then(result => {
                        for (const row of result.items) {
                            if (!info.ordered)
                                row.entryId = row.id;
                            if (typeof row.entryId !== 'string' || !row.entryId)
                                throw new Error('missing_entry_id');
                        }
                        return result;
                    }));
        },
        collectionRemove: (args, host) => {
            requireCapability('collectionEditing');
            segment(args.entryId);
            return container(host, args.containerId).then(info => {
                if (!info.removable)
                    throw new Error('permission_denied');
                const parameters = info.ordered ? (emby ? { EntryIds: args.entryId } : { entryIds: args.entryId })
                    : (emby ? { Ids: args.entryId } : { ids: args.entryId });
                return request(host, 'DELETE', (info.ordered ? '/Playlists/' : '/Collections/')
                    + segment(args.containerId) + '/Items', parameters).then(() => ({}));
            });
        },
        collectionMove: (args, host) => {
            requireCapability('collectionEditing');
            if (!Number.isInteger(args.index) || args.index < 0)
                throw new Error('invalid_index');
            return container(host, args.containerId).then(info => {
                if (info.moveMode !== 'index')
                    throw new Error('permission_denied');
                return request(host, 'POST', '/Playlists/' + segment(args.containerId) + '/Items/'
                    + segment(args.entryId) + '/Move/' + args.index).then(() => ({}));
            });
        }
    };
}
