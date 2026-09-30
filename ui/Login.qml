// SPDX-License-Identifier: MPL-2.0
import QtQuick
import Spool
import "../logic/connect-flow.mjs" as ConnectFlow

ServerLogin {
    id: root
    serviceName: "Emby"
    errorMessages: ({
                        not_emby: "Not an Emby server"
                    })
    alternateLabel: "Sign in with Emby Connect"
    alternateScreen: Component {
        ProviderLinkScreen {
            id: connect
            provider: root.provider
            title: "Emby Connect"
            property var flow: null
            property var state: ({
                                     phase: "idle",
                                     pin: "",
                                     memberships: [],
                                     busy: false
                                 })
            property var callback: null
            property var connections: {
                const out = []
                for (let i = 0; i < state.memberships.length; ++i) {
                    const member = state.memberships[i]
                    for (let j = 0; j < member.addresses.length; ++j)
                        out.push({
                                     title: member.name,
                                     address: member.addresses[j],
                                     member: i,
                                     connection: j
                                 })
                }
                return out
            }
            code: state.pin
            busy: state.busy
            choices: connections
            backText: "Back to server sign-in"
            instructions: state.phase === "members" ? (connections.length
                                                       ? "Choose a server connection. Only the address you choose will be approved." :
                                                         "No server memberships are available for this Emby Connect account.") :
                                                      typeof linkUrl === "string" ? "" :
                                                                                    "Open emby.media/pin on another device and enter this code."
            error: ({
                        connect_expired: "This code has expired. Get a new code to try again.",
                        connect_server_mismatch: "This address belongs to a different server. No account was added.",
                        invalid_connect_response: "Emby Connect returned an invalid sign-in response."
                    })[state.error] || (state.error
                                        ? "Emby Connect or the selected server couldn't be reached. Try again." : "")
            onRetryRequested: flow.start()
            onBackRequested: root.back()
            onChoiceSelected: index => flow.select(connections[index].member, connections[index].connection)
            Component.onCompleted: {
                // Link-aware Spool builds show the address as a link.
                if (typeof linkUrl === "string")
                    linkUrl = "https://emby.media/pin"
                flow = ConnectFlow.createConnectFlow({
                                                         request: (operation, args) => provider.request(operation, args),
                                                         approve: address => provider.allowOrigin(address),
                                                         closed: () => !provider || provider.closed,
                                                         complete: account => provider.complete(account),
                                                         stopTimer: () => {
                                                             poll.stop()
                                                             callback = null
                                                         },
                                                         schedule: (action, milliseconds) => {
                                                             callback = action
                                                             poll.interval = milliseconds
                                                             poll.start()
                                                         },
                                                         changed: value => {
                                                             state = value
                                                         }
                                                     })
                flow.start()
            }
            Component.onDestruction: {
                if (flow)
                    flow.cancel()
            }
            Timer {
                id: poll
                onTriggered: {
                    const action = connect.callback
                    connect.callback = null
                    if (action)
                        action()
                }
            }
        }
    }
}
