// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

// Signing in to an Emby server: one found on the network or typed, then a
// user and password.
FocusScope {
    id: root

    property var provider
    property string step: "server"
    property var servers: []
    property bool busy: false
    property string error: ""
    property var server: ({})

    readonly property var messages: ({
                                         "http_401": "Wrong username or password",
                                         "invalid_credentials": "Wrong username or password",
                                         "not_emby": "Not an Emby server",
                                         "origin_denied": "Not a server address"
                                     })

    function fail(code) {
        busy = false
        error = messages[code] || "Couldn't reach the server"
    }

    // Same rule as normalizeServer() in logic/provider.mjs, so the origin
    // allowed here is the one requests go to.
    function normalized(input) {
        let text = String(input || "").trim().replace(/\/+$/, "").replace(/\/emby$/i, "")
        if (!/^https?:\/\//i.test(text))
            text = "http://" + text
        if (/^http:\/\/[^/:]+$/i.test(text))
            text += ":8096"
        return text
    }

    function connect(input) {
        if (String(input).trim().length === 0)
            return
        const address = normalized(input)
        busy = true
        error = ""
        provider.allowOrigin(address).then(() => provider.request("probe", {
                                                                      "server": address
                                                                  })).then(result => {
                                                                      busy = false
                                                                      server = result
                                                                      step = "account"
                                                                      Qt.callLater(() => (server.users || []).length
                                                                              > 0 ? InputKeys.focus(users) :
                                                                                    usernameField.focusRow())
                                                                  }, fail)
    }

    function signIn(name, password) {
        busy = true
        error = ""
        provider.request("authenticate", {
                             "server": server.server,
                             "username": name,
                             "password": password
                         }).then(account => provider.complete(account), fail)
    }

    function back() {
        if (step === "server")
            return false
        error = ""
        step = "server"
        return true
    }

    function activate() {
        const item = Window.activeFocusItem
        if (item && typeof item.activate === "function")
            item.activate()
        else if (item && typeof item.clicked === "function")
            item.clicked()
        else if (item && typeof item.accepted === "function")
            item.accepted()
    }

    Component.onCompleted: {
        provider.request("discover").then(result => servers = result.servers || [], () => {})
        Qt.callLater(address.focusRow)
    }

    Flickable {
        anchors.fill: parent
        contentHeight: column.implicitHeight + Metrics.pageMarginPx * 2
        boundsBehavior: Flickable.StopAtBounds
        clip: true

        ColumnLayout {
            id: column
            x: Math.max(Metrics.pageMarginPx, (parent.width - width) / 2)
            y: Metrics.pageMarginPx
            width: Math.min(root.width - Metrics.pageMarginPx * 2, Metrics.scaled(560))
            spacing: Metrics.scaled(12)

            AppText {
                Layout.fillWidth: true
                Layout.bottomMargin: Metrics.scaled(8)
                visible: root.step === "account"
                text: root.server.name || ""
                font.pixelSize: Metrics.titleSizePx
                font.weight: Font.DemiBold
                elide: Text.ElideRight
            }

            Repeater {
                model: root.step === "server" ? root.servers : []
                delegate: ServerCard {
                    required property var modelData
                    Layout.fillWidth: true
                    title: modelData.name
                    serverAddress: modelData.address
                    onAccepted: root.connect(modelData.address)
                }
            }

            TextFieldRow {
                id: address
                Layout.fillWidth: true
                visible: root.step === "server"
                label: "Server"
                placeholderText: "192.168.1.20"
                inputMethodHints: Qt.ImhUrlCharactersOnly | Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                onAccepted: root.connect(text)
            }

            ActionButton {
                Layout.alignment: Qt.AlignRight
                visible: root.step === "server"
                kind: "primary"
                text: "Connect"
                enabled: !root.busy && address.text.trim().length > 0
                onClicked: root.connect(address.text)
            }

            Flow {
                id: users
                Layout.fillWidth: true
                visible: root.step === "account" && (root.server.users || []).length > 0
                spacing: Metrics.scaled(16)
                Repeater {
                    model: users.visible ? root.server.users : []
                    delegate: ProfileTile {
                        required property var modelData
                        tileSize: Metrics.scaled(96)
                        username: modelData.name
                        onAccepted: {
                            usernameField.text = modelData.name
                            if (modelData.hasPassword)
                                passwordField.focusRow()
                            else
                                root.signIn(modelData.name, "")
                        }
                    }
                }
            }

            TextFieldRow {
                id: usernameField
                Layout.fillWidth: true
                visible: root.step === "account"
                label: "Username"
                inputMethodHints: Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                onAccepted: passwordField.focusRow()
            }

            TextFieldRow {
                id: passwordField
                Layout.fillWidth: true
                visible: root.step === "account"
                label: "Password"
                echoMode: TextInput.Password
                onAccepted: root.signIn(usernameField.text, text)
            }

            ActionButton {
                Layout.alignment: Qt.AlignRight
                visible: root.step === "account"
                kind: "primary"
                text: "Sign in"
                enabled: !root.busy && usernameField.text.trim().length > 0
                onClicked: root.signIn(usernameField.text, passwordField.text)
            }

            BusySpinner {
                Layout.alignment: Qt.AlignHCenter
                Layout.preferredWidth: Metrics.scaled(24)
                Layout.preferredHeight: Metrics.scaled(24)
                running: root.busy
                visible: running
            }

            SecondaryText {
                Layout.fillWidth: true
                visible: root.error.length > 0
                text: root.error
                color: Theme.errorText
                wrapMode: Text.Wrap
            }
        }
    }
}
