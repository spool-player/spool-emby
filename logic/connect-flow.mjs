// SPDX-License-Identifier: MPL-2.0
// Owned by Login.qml, not by the recreatable provider source. Timer callbacks
// and every completion carry a generation; cancelling never completes a login.
export function createConnectFlow(ui) {
    let generation = 0;
    let pin = '';
    let memberships = [];
    let phase = 'idle';
    let busy = false;

    function publish(error) {
        ui.changed({ phase: phase, busy: busy, pin: pin, memberships: memberships, error: error || '' });
    }
    function current(id) { return generation === id && !ui.closed(); }
    function cancel() {
        ++generation;
        ui.stopTimer();
        pin = '';
        memberships = [];
        phase = 'idle';
        busy = false;
    }
    function fail(id, error) {
        if (!current(id))
            return;
        ui.stopTimer();
        busy = false;
        if (phase !== 'members') {
            phase = 'error';
            pin = '';
        }
        publish(typeof error === 'string' ? error : error.message);
    }
    function schedule(id) {
        ui.schedule(() => poll(id), 2000);
    }
    function poll(id) {
        if (!current(id) || phase !== 'pin')
            return Promise.resolve();
        // Schedule the next poll only after this request finishes, never on a
        // repeating timer that could overlap requests on a slow connection.
        return ui.request('connectPoll', { pin: pin }).then(result => {
            if (!current(id))
                return;
            if (result.expired)
                throw new Error('connect_expired');
            if (!result.confirmed) {
                schedule(id);
                return;
            }
            phase = 'authenticating';
            busy = true;
            publish();
            return ui.request('connectAuthenticate', { pin: pin }).then(result => {
                if (!current(id))
                    return;
                pin = '';
                memberships = result.memberships;
                phase = 'members';
                busy = false;
                publish();
            });
        }).catch(error => fail(id, error));
    }
    function start() {
        cancel();
        const id = generation;
        phase = 'creating';
        busy = true;
        publish();
        return ui.request('connectPin', {}).then(result => {
            if (!current(id))
                return;
            pin = result.pin;
            phase = 'pin';
            busy = false;
            publish();
            schedule(id);
        }).catch(error => fail(id, error));
    }
    function select(index, addressIndex) {
        if (phase !== 'members' || busy || !memberships[index] || !memberships[index].addresses[addressIndex])
            return Promise.resolve();
        const member = memberships[index];
        const address = member.addresses[addressIndex];
        const id = generation;
        busy = true;
        publish();
        return ui.approve(address).then(() => {
            if (!current(id))
                return;
            return ui.request('connectExchange', { server: address, serverId: member.id,
                userId: member.userId, accessKey: member.accessKey }).then(account => {
                if (!current(id))
                    return;
                cancel();
                ui.complete(account);
            });
        }).catch(error => fail(id, error));
    }
    return { start: start, cancel: cancel, select: select };
}
