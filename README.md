# Emby for Spool

The Emby provider for [Spool](https://github.com/spool-player/spool): sign in to an Emby server, browse
and search its libraries, play with the server's own transcoding when needed, keep watched state and
resume points in sync, skip intros and credits Emby has marked, and let other Emby clients control
Spool.

| | |
| --- | --- |
| `manifest.json` | Identity, capabilities, screens and item actions (provider API 0.2) |
| `logic/provider.mjs` | Sign-in, catalogue, playback, item actions |
| `logic/items.mjs` | Emby JSON to Spool's item shape; intro and credit chapters to segments |
| `logic/profile.mjs` | The DeviceProfile sent with every playback request |
| `logic/events.mjs` | The server's websocket, as remote-control and change events |
| `ui/Login.qml` | Servers found on the network or typed in, then a user and password |
| `ui/Picker.qml` | Choosing a playlist or collection, renaming, confirming a delete |

Several users and several servers can be signed in at once. Users of the same server are alternatives
to each other in Spool; different servers are shown together. Emby Connect and watching together are
not supported.

## Development

The SDK under `sdk/` is pinned from Spool (`sdk.lock.json`; `tools/check-sdk.py` verifies it).

```
cmake -S sdk -B build/sdk && cmake --build build/sdk
build/sdk/provider-contract-runner tests/contract.mjs
QV4_FORCE_INTERPRETER=1 build/sdk/provider-contract-runner tests/contract.mjs
python3 sdk/spool-provider.py build .          # dist/spool.emby-<version>.tar.zst
```

To try a checkout in Spool without releasing it, configure Spool with
`-DSPOOL_PROVIDER_OVERRIDES=spool.emby=/path/to/spool-emby`.

## Releasing

Bump `version` in `manifest.json`, then push a `v<version>` tag. The workflow runs the contract,
builds the package and attaches it with `spool-provider.json` to a GitHub release.

MPL-2.0; see LICENSE and NOTICE.
