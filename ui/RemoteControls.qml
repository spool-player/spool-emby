// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

FocusScope {
    id: root
    property var provider
    property var controls: []
    property bool textAvailable: false
    property bool messageAvailable: false
    property bool busy: false
    property string problem: ""
    readonly property string targetId: provider ? String(provider.arguments.targetId || "") : ""

    function focusFirst() {
        if (list.count > 0)
            InputKeys.focus(list)
        else if (textAvailable || messageAvailable)
            textInput.focusRow()
        else
            InputKeys.focus(closeButton)
    }
    function refresh() {
        busy = true
        problem = ""
        provider.request("remoteControls", { "targetId": targetId }).then(result => {
            controls = result.controls || []
            textAvailable = result.text === true
            messageAvailable = result.message === true
            busy = false
            Qt.callLater(focusFirst)
        }, () => {
            busy = false
            problem = "The target's advanced controls are unavailable. Refresh to try again."
            Qt.callLater(() => InputKeys.focus(refreshButton))
        })
    }
    function send(name, value) {
        if (busy)
            return
        busy = true
        problem = ""
        const args = { "targetId": targetId, "name": name }
        if (value !== undefined)
            args.value = value
        provider.request("remoteControl", args).then(() => {
            busy = false
        }, () => {
            busy = false
            problem = "The target did not accept that command. Its available controls may have changed."
        })
    }
    Component.onCompleted: refresh()

    ColumnLayout {
        anchors.fill: parent
        spacing: Metrics.scaled(12)
        AppText {
            Layout.fillWidth: true
            text: "Advanced remote controls"
            font.pixelSize: Metrics.titleSizePx
            font.weight: Font.DemiBold
        }
        SecondaryText {
            Layout.fillWidth: true
            text: "These commands act on the selected device, not on this screen. Only commands advertised by that device are shown."
            wrapMode: Text.Wrap
        }
        SecondaryText {
            Layout.fillWidth: true
            visible: root.problem.length > 0
            text: root.problem
            color: Theme.errorText
            wrapMode: Text.Wrap
        }
        BusySpinner {
            Layout.alignment: Qt.AlignHCenter
            Layout.preferredWidth: Metrics.scaled(24)
            Layout.preferredHeight: Metrics.scaled(24)
            running: root.busy
            visible: running
        }
        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            model: root.controls
            keyNavigationEnabled: true
            KeyNavigation.down: textInput.visible ? textInput : closeButton
            delegate: MenuRow {
                required property var modelData
                required property int index
                width: list.width
                label: modelData.label
                iconName: "remote_gen"
                highlighted: ListView.isCurrentItem && list.activeFocus
                onHovered: list.currentIndex = index
                onActivated: root.send(modelData.id)
            }
            function activate() {
                if (currentItem)
                    currentItem.activated()
            }
        }
        TextFieldRow {
            id: textInput
            Layout.fillWidth: true
            visible: root.textAvailable || root.messageAvailable
            label: "Text for the device"
            KeyNavigation.up: list
            KeyNavigation.down: sendText.visible ? sendText : sendMessage
            onAccepted: {
                if (text.length > 0 && text.length <= 4096)
                    root.send(root.textAvailable ? "SendString" : "DisplayMessage", text)
            }
        }
        RowLayout {
            Layout.alignment: Qt.AlignRight
            spacing: Metrics.scaled(10)
            ActionButton {
                id: sendText
                visible: root.textAvailable
                enabled: !root.busy && textInput.text.length > 0 && textInput.text.length <= 4096
                text: "Send text"
                onClicked: root.send("SendString", textInput.text)
            }
            ActionButton {
                id: sendMessage
                visible: root.messageAvailable
                enabled: !root.busy && textInput.text.length > 0 && textInput.text.length <= 4096
                text: "Show message"
                onClicked: root.send("DisplayMessage", textInput.text)
            }
            ActionButton {
                id: refreshButton
                enabled: !root.busy
                text: "Refresh"
                kind: "flat"
                onClicked: root.refresh()
            }
            ActionButton {
                id: closeButton
                text: "Close"
                kind: "flat"
                onClicked: root.provider.close()
            }
        }
    }
}
