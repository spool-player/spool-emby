// SPDX-License-Identifier: MPL-2.0
import QtQuick
import Spool

AppText {
    id: root

    property var provider
    property bool missingHost: false
    property int generation: 0

    visible: missingHost
    text: "Update Spool to use all features of this provider."
    wrapMode: Text.WordWrap

    function refresh() {
        const current = ++generation
        missingHost = false
        if (!provider)
            return
        provider.request("extensionStatus", {}).then(result => {
            if (current === generation)
                missingHost = Array.isArray(result.missingHost) && result.missingHost.length > 0
        }, () => {})
    }

    onProviderChanged: refresh()
    Component.onDestruction: ++generation
}
