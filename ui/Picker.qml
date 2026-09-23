// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

// Finishes an item action: which playlist or collection to add to (or a new
// one), a new name, or confirming a delete. Completes with the choice.
FocusScope {
    id: root

    property var provider
    readonly property string kind: provider ? String(provider.arguments.kind || "") : ""
    readonly property bool choosing: kind === "playlist" || kind === "collection"

    function activate() {
        const item = Window.activeFocusItem
        if (item && typeof item.activate === "function")
            item.activate()
        else if (item && typeof item.clicked === "function")
            item.clicked()
    }

    Component.onCompleted: {
        if (choosing)
            provider.requestList("targets", {
                                     "kind": kind
                                 })
        Qt.callLater(() => choosing ? InputKeys.focus(list) : kind === "rename" ? name.focusRow() : InputKeys.focus(
                                                                                      confirm))
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Metrics.pageMarginPx
        spacing: Metrics.scaled(12)

        AppText {
            text: ({
                       "playlist": "Add to playlist",
                       "collection": "Add to collection",
                       "rename": "Rename",
                       "confirm": "Delete from the server?"
                   })[root.kind] || ""
            font.pixelSize: Metrics.titleSizePx
            font.weight: Font.DemiBold
        }

        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: root.choosing
            clip: true
            model: root.provider ? root.provider.rows : null
            focus: true
            keyNavigationEnabled: true
            delegate: MenuRow {
                required property var record
                required property int index
                width: list.width
                label: record.title
                iconName: "playlist_play"
                highlighted: ListView.isCurrentItem && list.activeFocus
                onHovered: list.currentIndex = index
                onActivated: root.provider.complete({
                                                        "targetId": record.id,
                                                        "targetName": record.title
                                                    })
            }
            function activate() {
                if (currentItem)
                    currentItem.activated()
            }
        }

        TextFieldRow {
            id: name
            Layout.fillWidth: true
            visible: root.choosing || root.kind === "rename"
            label: root.choosing ? "New " + root.kind : "Name"
            onAccepted: if (text.trim().length > 0)
                            root.provider.complete({
                                                       "newName": text.trim()
                                                   })
        }

        RowLayout {
            Layout.alignment: Qt.AlignRight
            spacing: Metrics.scaled(10)
            ActionButton {
                text: "Cancel"
                kind: "flat"
                onClicked: root.provider.close()
            }
            ActionButton {
                id: confirm
                visible: root.kind === "confirm" || name.text.trim().length > 0
                kind: root.kind === "confirm" ? "danger" : "primary"
                text: root.kind === "confirm" ? "Delete" : root.choosing ? "Create" : "Save"
                onClicked: root.provider.complete(root.kind === "confirm" ? {
                                                                                "confirmed": true
                                                                            } : {
                                                      "newName": name.text.trim()
                                                  })
            }
        }
    }
}
