/*
Copyright 2016 OpenMarket Ltd
Copyright 2019, 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React from 'react';
import ReactDOM from "react-dom";
import { EventEmitter } from "events";
import * as Matrix from 'matrix-js-sdk/src/matrix';
import FakeTimers from '@sinonjs/fake-timers';
import { mount } from "enzyme";
import * as TestUtils from "react-dom/test-utils";

import { MatrixClientPeg } from '../../../src/MatrixClientPeg';
import sdk from '../../skinned-sdk';
import SettingsStore from "../../../src/settings/SettingsStore";
import MatrixClientContext from "../../../src/contexts/MatrixClientContext";
import RoomContext from "../../../src/contexts/RoomContext";
import DMRoomMap from "../../../src/utils/DMRoomMap";
import { UnwrappedEventTile } from "../../../src/components/views/rooms/EventTile";
import * as TestUtilsMatrix from "../../test-utils";

const MessagePanel = sdk.getComponent('structures.MessagePanel');

let client;
const room = new Matrix.Room("!roomId:server_name");

// wrap MessagePanel with a component which provides the MatrixClient in the context.
class WrappedMessagePanel extends React.Component {
    resizeNotifier = new EventEmitter();
    callEventGroupers = new Map();

    render() {
        const roomContext = {
            room,
            roomId: room.roomId,
            canReact: true,
            canSendMessages: true,
            showReadReceipts: true,
            showRedactions: false,
            showJoinLeaves: false,
            showAvatarChanges: false,
            showDisplaynameChanges: true,
        };

        return <MatrixClientContext.Provider value={client}>
            <RoomContext.Provider value={roomContext}>
                <MessagePanel
                    room={room}
                    {...this.props}
                    resizeNotifier={this.resizeNotifier}
                    callEventGroupers={this.callEventGroupers}
                />
            </RoomContext.Provider>
        </MatrixClientContext.Provider>;
    }
}

describe('MessagePanel', function() {
    let clock = null;
    const realSetTimeout = window.setTimeout;
    const events = mkEvents();

    beforeEach(function() {
        TestUtilsMatrix.stubClient();
        client = MatrixClientPeg.get();
        client.credentials = { userId: '@me:here' };

        // HACK: We assume all settings want to be disabled
        SettingsStore.getValue = jest.fn((arg) => {
            return arg === "showDisplaynameChanges";
        });

        DMRoomMap.makeShared();
    });

    afterEach(function() {
        if (clock) {
            clock.uninstall();
            clock = null;
        }
    });

    function mkEvents() {
        const events = [];
        const ts0 = Date.now();
        for (let i = 0; i < 10; i++) {
            events.push(TestUtilsMatrix.mkMessage(
                {
                    event: true, room: "!room:id", user: "@user:id",
                    ts: ts0 + i * 1000,
                }));
        }
        return events;
    }

    // Just to avoid breaking Dateseparator tests that might run at 00hrs
    function mkOneDayEvents() {
        const events = [];
        const ts0 = Date.parse('09 May 2004 00:12:00 GMT');
        for (let i = 0; i < 10; i++) {
            events.push(TestUtilsMatrix.mkMessage(
                {
                    event: true, room: "!room:id", user: "@user:id",
                    ts: ts0 + i * 1000,
                }));
        }
        return events;
    }

    // make a collection of events with some member events that should be collapsed with an EventListSummary
    function mkMelsEvents() {
        const events = [];
        const ts0 = Date.now();

        let i = 0;
        events.push(TestUtilsMatrix.mkMessage({
            event: true, room: "!room:id", user: "@user:id",
            ts: ts0 + ++i * 1000,
        }));

        for (i = 0; i < 10; i++) {
            events.push(TestUtilsMatrix.mkMembership({
                event: true, room: "!room:id", user: "@user:id",
                target: {
                    userId: "@user:id",
                    name: "Bob",
                    getAvatarUrl: () => {
                        return "avatar.jpeg";
                    },
                    getMxcAvatarUrl: () => 'mxc://avatar.url/image.png',
                },
                ts: ts0 + i*1000,
                mship: 'join',
                prevMship: 'join',
                name: 'A user',
            }));
        }

        events.push(TestUtilsMatrix.mkMessage({
            event: true, room: "!room:id", user: "@user:id",
            ts: ts0 + ++i*1000,
        }));

        return events;
    }

    // A list of membership events only with nothing else
    function mkMelsEventsOnly() {
        const events = [];
        const ts0 = Date.now();

        let i = 0;

        for (i = 0; i < 10; i++) {
            events.push(TestUtilsMatrix.mkMembership({
                event: true, room: "!room:id", user: "@user:id",
                target: {
                    userId: "@user:id",
                    name: "Bob",
                    getAvatarUrl: () => {
                        return "avatar.jpeg";
                    },
                    getMxcAvatarUrl: () => 'mxc://avatar.url/image.png',
                },
                ts: ts0 + i * 1000,
                mship: 'join',
                prevMship: 'join',
                name: 'A user',
            }));
        }

        return events;
    }

    // A list of room creation, encryption, and invite events.
    function mkCreationEvents() {
        const mkEvent = TestUtilsMatrix.mkEvent;
        const mkMembership = TestUtilsMatrix.mkMembership;
        const roomId = "!someroom";
        const alice = "@alice:example.org";
        const ts0 = Date.now();

        return [
            mkEvent({
                event: true,
                type: "m.room.create",
                sender: '@test:example.org',
                room: roomId,
                user: alice,
                content: {
                    creator: alice,
                    room_version: "5",
                    predecessor: {
                        room_id: "!prevroom",
                        event_id: "$someevent",
                    },
                },
                ts: ts0,
            }),
            mkMembership({
                event: true,
                room: roomId,
                user: alice,
                target: {
                    userId: alice,
                    name: "Alice",
                    getAvatarUrl: () => {
                        return "avatar.jpeg";
                    },
                    getMxcAvatarUrl: () => 'mxc://avatar.url/image.png',
                },
                ts: ts0 + 1,
                mship: 'join',
                name: 'Alice',
            }),
            mkEvent({
                event: true,
                type: "m.room.join_rules",
                room: roomId,
                user: alice,
                content: {
                    "join_rule": "invite",
                },
                ts: ts0 + 2,
            }),
            mkEvent({
                event: true,
                type: "m.room.history_visibility",
                room: roomId,
                user: alice,
                content: {
                    "history_visibility": "invited",
                },
                ts: ts0 + 3,
            }),
            mkEvent({
                event: true,
                type: "m.room.encryption",
                room: roomId,
                user: alice,
                content: {
                    "algorithm": "m.megolm.v1.aes-sha2",
                },
                ts: ts0 + 4,
            }),
            mkMembership({
                event: true,
                room: roomId,
                user: alice,
                skey: "@bob:example.org",
                target: {
                    userId: "@bob:example.org",
                    name: "Bob",
                    getAvatarUrl: () => {
                        return "avatar.jpeg";
                    },
                    getMxcAvatarUrl: () => 'mxc://avatar.url/image.png',
                },
                ts: ts0 + 5,
                mship: 'invite',
                name: 'Bob',
            }),
        ];
    }
    function isReadMarkerVisible(rmContainer) {
        return rmContainer && rmContainer.children.length > 0;
    }

    it('should show the events', function() {
        const res = TestUtils.renderIntoDocument(
            <WrappedMessagePanel className="cls" events={events} />,
        );

        // just check we have the right number of tiles for now
        const tiles = TestUtils.scryRenderedComponentsWithType(res, UnwrappedEventTile);
        expect(tiles.length).toEqual(10);
    });

    it('should collapse adjacent member events', function() {
        const res = TestUtils.renderIntoDocument(
            <WrappedMessagePanel className="cls" events={mkMelsEvents()} />,
        );

        // just check we have the right number of tiles for now
        const tiles = TestUtils.scryRenderedComponentsWithType(res, UnwrappedEventTile);
        expect(tiles.length).toEqual(2);

        const summaryTiles = TestUtils.scryRenderedComponentsWithType(
            res, sdk.getComponent('elements.EventListSummary'),
        );
        expect(summaryTiles.length).toEqual(1);
    });

    it('should insert the read-marker in the right place', function() {
        const res = TestUtils.renderIntoDocument(
            <WrappedMessagePanel
                className="cls"
                events={events}
                readMarkerEventId={events[4].getId()}
                readMarkerVisible={true}
            />,
        );

        const tiles = TestUtils.scryRenderedComponentsWithType(res, UnwrappedEventTile);

        // find the <li> which wraps the read marker
        const rm = TestUtils.findRenderedDOMComponentWithClass(res, 'mx_RoomView_myReadMarker_container');

        // it should follow the <li> which wraps the event tile for event 4
        const eventContainer = ReactDOM.findDOMNode(tiles[4]);
        expect(rm.previousSibling).toEqual(eventContainer);
    });

    it('should show the read-marker that fall in summarised events after the summary', function() {
        const melsEvents = mkMelsEvents();
        const res = TestUtils.renderIntoDocument(
            <WrappedMessagePanel
                className="cls"
                events={melsEvents}
                readMarkerEventId={melsEvents[4].getId()}
                readMarkerVisible={true}
            />,
        );

        const summary = TestUtils.findRenderedDOMComponentWithClass(res, 'mx_GenericEventListSummary');

        // find the <li> which wraps the read marker
        const rm = TestUtils.findRenderedDOMComponentWithClass(res, 'mx_RoomView_myReadMarker_container');

        expect(rm.previousSibling).toEqual(summary);

        // read marker should be visible given props and not at the last event
        expect(isReadMarkerVisible(rm)).toBeTruthy();
    });

    it('should hide the read-marker at the end of summarised events', function() {
        const melsEvents = mkMelsEventsOnly();
        const res = TestUtils.renderIntoDocument(
            <WrappedMessagePanel
                className="cls"
                events={melsEvents}
                readMarkerEventId={melsEvents[9].getId()}
                readMarkerVisible={true}
            />,
        );

        const summary = TestUtils.findRenderedDOMComponentWithClass(res, 'mx_GenericEventListSummary');

        // find the <li> which wraps the read marker
        const rm = TestUtils.findRenderedDOMComponentWithClass(res, 'mx_RoomView_myReadMarker_container');

        expect(rm.previousSibling).toEqual(summary);

        // read marker should be hidden given props and at the last event
        expect(isReadMarkerVisible(rm)).toBeFalsy();
    });

    it('shows a ghost read-marker when the read-marker moves', function(done) {
        // fake the clock so that we can test the velocity animation.
        clock = FakeTimers.install();

        const parentDiv = document.createElement('div');

        // first render with the RM in one place
        let mp = ReactDOM.render(
            <WrappedMessagePanel
                className="cls"
                events={events}
                readMarkerEventId={events[4].getId()}
                readMarkerVisible={true}
            />, parentDiv);

        const tiles = TestUtils.scryRenderedComponentsWithType(mp, UnwrappedEventTile);
        const tileContainers = tiles.map(function(t) {
            return ReactDOM.findDOMNode(t);
        });

        // find the <li> which wraps the read marker
        const rm = TestUtils.findRenderedDOMComponentWithClass(mp, 'mx_RoomView_myReadMarker_container');
        expect(rm.previousSibling).toEqual(tileContainers[4]);

        // now move the RM
        mp = ReactDOM.render(
            <WrappedMessagePanel
                className="cls"
                events={events}
                readMarkerEventId={events[6].getId()}
                readMarkerVisible={true}
            />, parentDiv);

        // now there should be two RM containers
        const found = TestUtils.scryRenderedDOMComponentsWithClass(mp, 'mx_RoomView_myReadMarker_container');
        expect(found.length).toEqual(2);

        // the first should be the ghost
        expect(found[0].previousSibling).toEqual(tileContainers[4]);
        const hr = found[0].children[0];

        // the second should be the real thing
        expect(found[1].previousSibling).toEqual(tileContainers[6]);

        // advance the clock, and then let the browser run an animation frame,
        // to let the animation start
        clock.tick(1500);

        realSetTimeout(() => {
            // then advance it again to let it complete
            clock.tick(1000);
            realSetTimeout(() => {
                // the ghost should now have finished
                expect(hr.style.opacity).toEqual('0');
                done();
            }, 100);
        }, 100);
    });

    it('should collapse creation events', function() {
        const events = mkCreationEvents();
        TestUtilsMatrix.upsertRoomStateEvents(room, events);
        const res = mount(
            <WrappedMessagePanel className="cls" events={events} />,
        );

        // we expect that
        // - the room creation event, the room encryption event, and Alice inviting Bob,
        //   should be outside of the room creation summary
        // - all other events should be inside the room creation summary

        const tiles = res.find(UnwrappedEventTile);

        expect(tiles.at(0).props().mxEvent.getType()).toEqual("m.room.create");
        expect(tiles.at(1).props().mxEvent.getType()).toEqual("m.room.encryption");

        const summaryTiles = res.find(sdk.getComponent('views.elements.GenericEventListSummary'));
        const summaryTile = summaryTiles.at(0);

        const summaryEventTiles = summaryTile.find(UnwrappedEventTile);
        // every event except for the room creation, room encryption, and Bob's
        // invite event should be in the event summary
        expect(summaryEventTiles.length).toEqual(tiles.length - 3);
    });

    it('should hide read-marker at the end of creation event summary', function() {
        const events = mkCreationEvents();
        TestUtilsMatrix.upsertRoomStateEvents(room, events);
        const res = mount(
            <WrappedMessagePanel
                className="cls"
                events={events}
                readMarkerEventId={events[5].getId()}
                readMarkerVisible={true}
            />,
        );

        // find the <li> which wraps the read marker
        const rm = res.find('.mx_RoomView_myReadMarker_container').getDOMNode();

        const rows = res.find('.mx_RoomView_MessageList').children();
        expect(rows.length).toEqual(7); // 6 events + the NewRoomIntro
        expect(rm.previousSibling).toEqual(rows.at(5).getDOMNode());

        // read marker should be hidden given props and at the last event
        expect(isReadMarkerVisible(rm)).toBeFalsy();
    });

    it('should render Date separators for the events', function() {
        const events = mkOneDayEvents();
        const res = mount(
            <WrappedMessagePanel
                className="cls"
                events={events}
            />,
        );
        const Dates = res.find(sdk.getComponent('messages.DateSeparator'));

        expect(Dates.length).toEqual(1);
    });

    it('appends events into summaries during forward pagination without changing key', () => {
        const events = mkMelsEvents().slice(1, 11);

        const res = mount(<WrappedMessagePanel events={events} />);
        let els = res.find("EventListSummary");
        expect(els.length).toEqual(1);
        expect(els.key()).toEqual("eventlistsummary-" + events[0].getId());
        expect(els.prop("events").length).toEqual(10);

        res.setProps({
            events: [
                ...events,
                TestUtilsMatrix.mkMembership({
                    event: true,
                    room: "!room:id",
                    user: "@user:id",
                    target: {
                        userId: "@user:id",
                        name: "Bob",
                        getAvatarUrl: () => {
                            return "avatar.jpeg";
                        },
                        getMxcAvatarUrl: () => 'mxc://avatar.url/image.png',
                    },
                    ts: Date.now(),
                    mship: 'join',
                    prevMship: 'join',
                    name: 'A user',
                }),
            ],
        });

        els = res.find("EventListSummary");
        expect(els.length).toEqual(1);
        expect(els.key()).toEqual("eventlistsummary-" + events[0].getId());
        expect(els.prop("events").length).toEqual(11);
    });

    it('prepends events into summaries during backward pagination without changing key', () => {
        const events = mkMelsEvents().slice(1, 11);

        const res = mount(<WrappedMessagePanel events={events} />);
        let els = res.find("EventListSummary");
        expect(els.length).toEqual(1);
        expect(els.key()).toEqual("eventlistsummary-" + events[0].getId());
        expect(els.prop("events").length).toEqual(10);

        res.setProps({
            events: [
                TestUtilsMatrix.mkMembership({
                    event: true,
                    room: "!room:id",
                    user: "@user:id",
                    target: {
                        userId: "@user:id",
                        name: "Bob",
                        getAvatarUrl: () => {
                            return "avatar.jpeg";
                        },
                        getMxcAvatarUrl: () => 'mxc://avatar.url/image.png',
                    },
                    ts: Date.now(),
                    mship: 'join',
                    prevMship: 'join',
                    name: 'A user',
                }),
                ...events,
            ],
        });

        els = res.find("EventListSummary");
        expect(els.length).toEqual(1);
        expect(els.key()).toEqual("eventlistsummary-" + events[0].getId());
        expect(els.prop("events").length).toEqual(11);
    });

    it('assigns different keys to summaries that get split up', () => {
        const events = mkMelsEvents().slice(1, 11);

        const res = mount(<WrappedMessagePanel events={events} />);
        let els = res.find("EventListSummary");
        expect(els.length).toEqual(1);
        expect(els.key()).toEqual("eventlistsummary-" + events[0].getId());
        expect(els.prop("events").length).toEqual(10);

        res.setProps({
            events: [
                ...events.slice(0, 5),
                TestUtilsMatrix.mkMessage({
                    event: true,
                    room: "!room:id",
                    user: "@user:id",
                    msg: "Hello!",
                }),
                ...events.slice(5, 10),
            ],
        });

        els = res.find("EventListSummary");
        expect(els.length).toEqual(2);
        expect(els.first().key()).not.toEqual(els.last().key());
        expect(els.first().prop("events").length).toEqual(5);
        expect(els.last().prop("events").length).toEqual(5);
    });
});
