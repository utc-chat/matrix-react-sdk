/*
Copyright 2017 Vector Creations Ltd
Copyright 2017, 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

import React, { ReactNode } from "react";
import { Store } from 'flux/utils';
import { MatrixError } from "matrix-js-sdk/src/http-api";
import { logger } from "matrix-js-sdk/src/logger";
import { ViewRoom as ViewRoomEvent } from "matrix-analytics-events/types/typescript/ViewRoom";
import { JoinedRoom as JoinedRoomEvent } from "matrix-analytics-events/types/typescript/JoinedRoom";
import { JoinRule } from "matrix-js-sdk/src/@types/partials";
import { Room } from "matrix-js-sdk/src/models/room";
import { ClientEvent } from "matrix-js-sdk/src/client";

import dis from '../dispatcher/dispatcher';
import { MatrixClientPeg } from '../MatrixClientPeg';
import * as sdk from '../index';
import Modal from '../Modal';
import { _t } from '../languageHandler';
import { getCachedRoomIDForAlias, storeRoomAliasInCache } from '../RoomAliasCache';
import { ActionPayload } from "../dispatcher/payloads";
import { Action } from "../dispatcher/actions";
import { retry } from "../utils/promise";
import { TimelineRenderingType } from "../contexts/RoomContext";
import { PosthogAnalytics } from "../PosthogAnalytics";
import { ViewRoomPayload } from "../dispatcher/payloads/ViewRoomPayload";
import DMRoomMap from "../utils/DMRoomMap";
import SpaceStore from "./spaces/SpaceStore";
import { isMetaSpace, MetaSpace } from "./spaces";
import { JoinRoomPayload } from "../dispatcher/payloads/JoinRoomPayload";
import { JoinRoomReadyPayload } from "../dispatcher/payloads/JoinRoomReadyPayload";
import { JoinRoomErrorPayload } from "../dispatcher/payloads/JoinRoomErrorPayload";
import { ViewRoomErrorPayload } from "../dispatcher/payloads/ViewRoomErrorPayload";

const NUM_JOIN_RETRY = 5;

const INITIAL_STATE = {
    // Whether we're joining the currently viewed room (see isJoining())
    joining: false,
    // Any error that has occurred during joining
    joinError: null,
    // The room ID of the room currently being viewed
    roomId: null,

    // The event to scroll to when the room is first viewed
    initialEventId: null,
    initialEventPixelOffset: null,
    // Whether to highlight the initial event
    isInitialEventHighlighted: false,

    // The room alias of the room (or null if not originally specified in view_room)
    roomAlias: null,
    // Whether the current room is loading
    roomLoading: false,
    // Any error that has occurred during loading
    roomLoadError: null,

    quotingEvent: null,

    replyingToEvent: null,

    shouldPeek: false,

    viaServers: [],

    wasContextSwitch: false,
};

/**
 * A class for storing application state for RoomView. This is the RoomView's interface
*  with a subset of the js-sdk.
 *  ```
 */
class RoomViewStore extends Store<ActionPayload> {
    private state = INITIAL_STATE; // initialize state

    constructor() {
        super(dis);
    }

    setState(newState: Partial<typeof INITIAL_STATE>) {
        // If values haven't changed, there's nothing to do.
        // This only tries a shallow comparison, so unchanged objects will slip
        // through, but that's probably okay for now.
        let stateChanged = false;
        for (const key of Object.keys(newState)) {
            if (this.state[key] !== newState[key]) {
                stateChanged = true;
                break;
            }
        }
        if (!stateChanged) {
            return;
        }

        this.state = Object.assign(this.state, newState);
        this.__emitChange();
    }

    __onDispatch(payload) { // eslint-disable-line @typescript-eslint/naming-convention
        switch (payload.action) {
            // view_room:
            //      - room_alias:   '#somealias:matrix.org'
            //      - room_id:      '!roomid123:matrix.org'
            //      - event_id:     '$213456782:matrix.org'
            //      - event_offset: 100
            //      - highlighted:  true
            case Action.ViewRoom:
                this.viewRoom(payload);
                break;
            // for these events blank out the roomId as we are no longer in the RoomView
            case 'view_create_group':
            case 'view_welcome_page':
            case Action.ViewHomePage:
            case 'view_my_groups':
            case 'view_group':
                this.setState({
                    roomId: null,
                    roomAlias: null,
                    viaServers: [],
                    wasContextSwitch: false,
                });
                break;
            case Action.ViewRoomError:
                this.viewRoomError(payload);
                break;
            case 'will_join':
                this.setState({
                    joining: true,
                });
                break;
            case 'cancel_join':
                this.setState({
                    joining: false,
                });
                break;
            // join_room:
            //      - opts: options for joinRoom
            case Action.JoinRoom:
                this.joinRoom(payload);
                break;
            case Action.JoinRoomError:
                this.joinRoomError(payload);
                break;
            case Action.JoinRoomReady: {
                if (this.state.roomId === payload.roomId) {
                    this.setState({ shouldPeek: false });
                }

                const cli = MatrixClientPeg.get();

                const updateMetrics = () => {
                    const room = cli.getRoom(payload.roomId);
                    const numMembers = room.getJoinedMemberCount();
                    const roomSize = numMembers > 1000 ? "MoreThanAThousand"
                        : numMembers > 100 ? "OneHundredAndOneToAThousand"
                            : numMembers > 10 ? "ElevenToOneHundred"
                                : numMembers > 2 ? "ThreeToTen"
                                    : numMembers > 1 ? "Two"
                                        : "One";

                    PosthogAnalytics.instance.trackEvent<JoinedRoomEvent>({
                        eventName: "JoinedRoom",
                        trigger: payload.metricsTrigger,
                        roomSize,
                        isDM: !!DMRoomMap.shared().getUserIdForRoomId(room.roomId),
                        isSpace: room.isSpaceRoom(),
                    });

                    cli.off(ClientEvent.Room, updateMetrics);
                };

                if (cli.getRoom(payload.roomId)) {
                    updateMetrics();
                } else {
                    cli.on(ClientEvent.Room, updateMetrics);
                }

                break;
            }
            case 'on_client_not_viable':
            case 'on_logged_out':
                this.reset();
                break;
            case 'reply_to_event':
                // If currently viewed room does not match the room in which we wish to reply then change rooms
                // this can happen when performing a search across all rooms. Persist the data from this event for
                // both room and search timeline rendering types, search will get auto-closed by RoomView at this time.
                if ([TimelineRenderingType.Room, TimelineRenderingType.Search].includes(payload.context)) {
                    if (payload.event && payload.event.getRoomId() !== this.state.roomId) {
                        dis.dispatch<ViewRoomPayload>({
                            action: Action.ViewRoom,
                            room_id: payload.event.getRoomId(),
                            replyingToEvent: payload.event,
                            metricsTrigger: undefined, // room doesn't change
                        });
                    } else {
                        this.setState({
                            replyingToEvent: payload.event,
                        });
                    }
                }
                break;
            case 'open_room_settings': {
                // FIXME: Using an import will result in test failures
                const RoomSettingsDialog = sdk.getComponent("dialogs.RoomSettingsDialog");
                Modal.createTrackedDialog('Room settings', '', RoomSettingsDialog, {
                    roomId: payload.room_id || this.state.roomId,
                    initialTabId: payload.initial_tab_id,
                }, /*className=*/null, /*isPriority=*/false, /*isStatic=*/true);
                break;
            }
        }
    }

    private async viewRoom(payload: ViewRoomPayload): Promise<void> {
        if (payload.room_id) {
            if (payload.metricsTrigger !== null && payload.room_id !== this.state.roomId) {
                let activeSpace: ViewRoomEvent["activeSpace"];
                if (SpaceStore.instance.activeSpace === MetaSpace.Home) {
                    activeSpace = "Home";
                } else if (isMetaSpace(SpaceStore.instance.activeSpace)) {
                    activeSpace = "Meta";
                } else {
                    activeSpace = SpaceStore.instance.activeSpaceRoom.getJoinRule() === JoinRule.Public
                        ? "Public"
                        : "Private";
                }

                PosthogAnalytics.instance.trackEvent<ViewRoomEvent>({
                    eventName: "ViewRoom",
                    trigger: payload.metricsTrigger,
                    viaKeyboard: payload.metricsViaKeyboard,
                    isDM: !!DMRoomMap.shared().getUserIdForRoomId(payload.room_id),
                    isSpace: MatrixClientPeg.get().getRoom(payload.room_id)?.isSpaceRoom(),
                    activeSpace,
                });
            }

            const newState = {
                roomId: payload.room_id,
                roomAlias: payload.room_alias,
                initialEventId: payload.event_id,
                isInitialEventHighlighted: payload.highlighted,
                roomLoading: false,
                roomLoadError: null,
                // should peek by default
                shouldPeek: payload.should_peek === undefined ? true : payload.should_peek,
                // have we sent a join request for this room and are waiting for a response?
                joining: payload.joining || false,
                // Reset replyingToEvent because we don't want cross-room because bad UX
                replyingToEvent: null,
                // pull the user out of Room Settings
                isEditingSettings: false,
                viaServers: payload.via_servers,
                wasContextSwitch: payload.context_switch,
            };

            // Allow being given an event to be replied to when switching rooms but sanity check its for this room
            if (payload.replyingToEvent?.getRoomId() === payload.room_id) {
                newState.replyingToEvent = payload.replyingToEvent;
            }

            this.setState(newState);

            if (payload.auto_join) {
                dis.dispatch<JoinRoomPayload>({
                    ...payload,
                    action: Action.JoinRoom,
                    roomId: payload.room_id,
                    metricsTrigger: payload.metricsTrigger as JoinRoomPayload["metricsTrigger"],
                });
            }
        } else if (payload.room_alias) {
            // Try the room alias to room ID navigation cache first to avoid
            // blocking room navigation on the homeserver.
            let roomId = getCachedRoomIDForAlias(payload.room_alias);
            if (!roomId) {
                // Room alias cache miss, so let's ask the homeserver. Resolve the alias
                // and then do a second dispatch with the room ID acquired.
                this.setState({
                    roomId: null,
                    initialEventId: null,
                    initialEventPixelOffset: null,
                    isInitialEventHighlighted: null,
                    roomAlias: payload.room_alias,
                    roomLoading: true,
                    roomLoadError: null,
                    viaServers: payload.via_servers,
                    wasContextSwitch: payload.context_switch,
                });
                try {
                    const result = await MatrixClientPeg.get().getRoomIdForAlias(payload.room_alias);
                    storeRoomAliasInCache(payload.room_alias, result.room_id);
                    roomId = result.room_id;
                } catch (err) {
                    logger.error("RVS failed to get room id for alias: ", err);
                    dis.dispatch<ViewRoomErrorPayload>({
                        action: Action.ViewRoomError,
                        room_id: null,
                        room_alias: payload.room_alias,
                        err,
                    });
                    return;
                }
            }

            // Re-fire the payload with the newly found room_id
            dis.dispatch({
                ...payload,
                room_id: roomId,
            });
        }
    }

    private viewRoomError(payload: ViewRoomErrorPayload) {
        this.setState({
            roomId: payload.room_id,
            roomAlias: payload.room_alias,
            roomLoading: false,
            roomLoadError: payload.err,
        });
    }

    private async joinRoom(payload: JoinRoomPayload) {
        this.setState({
            joining: true,
        });

        const cli = MatrixClientPeg.get();
        // take a copy of roomAlias & roomId as they may change by the time the join is complete
        const { roomAlias, roomId } = this.state;
        const address = roomAlias || roomId;
        const viaServers = this.state.viaServers || [];
        try {
            await retry<Room, MatrixError>(() => cli.joinRoom(address, {
                viaServers,
                ...(payload.opts || {}),
            }), NUM_JOIN_RETRY, (err) => {
                // if we received a Gateway timeout then retry
                return err.httpStatus === 504;
            });

            // We do *not* clear the 'joining' flag because the Room object and/or our 'joined' member event may not
            // have come down the sync stream yet, and that's the point at which we'd consider the user joined to the
            // room.
            dis.dispatch<JoinRoomReadyPayload>({
                action: Action.JoinRoomReady,
                roomId,
                metricsTrigger: payload.metricsTrigger,
            });
        } catch (err) {
            dis.dispatch({
                action: Action.JoinRoomError,
                roomId,
                err: err,
            });
        }
    }

    private static getInvitingUserId(roomId: string): string {
        const cli = MatrixClientPeg.get();
        const room = cli.getRoom(roomId);
        if (room && room.getMyMembership() === "invite") {
            const myMember = room.getMember(cli.getUserId());
            const inviteEvent = myMember ? myMember.events.member : null;
            return inviteEvent && inviteEvent.getSender();
        }
    }

    public showJoinRoomError(err: MatrixError, roomId: string) {
        let msg: ReactNode = err.message ? err.message : JSON.stringify(err);
        logger.log("Failed to join room:", msg);

        if (err.name === "ConnectionError") {
            msg = _t("There was an error joining the room");
        } else if (err.errcode === 'M_INCOMPATIBLE_ROOM_VERSION') {
            msg = <div>
                { _t("Sorry, your homeserver is too old to participate in this room.") }<br />
                { _t("Please contact your homeserver administrator.") }
            </div>;
        } else if (err.httpStatus === 404) {
            const invitingUserId = RoomViewStore.getInvitingUserId(roomId);
            // only provide a better error message for invites
            if (invitingUserId) {
                // if the inviting user is on the same HS, there can only be one cause: they left.
                if (invitingUserId.endsWith(`:${MatrixClientPeg.get().getDomain()}`)) {
                    msg = _t("The person who invited you already left the room.");
                } else {
                    msg = _t("The person who invited you already left the room, or their server is offline.");
                }
            }
        }

        // FIXME: Using an import will result in test failures
        const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
        Modal.createTrackedDialog('Failed to join room', '', ErrorDialog, {
            title: _t("Failed to join room"),
            description: msg,
        });
    }

    private joinRoomError(payload: JoinRoomErrorPayload) {
        this.setState({
            joining: false,
            joinError: payload.err,
        });
        this.showJoinRoomError(payload.err, payload.roomId);
    }

    public reset() {
        this.state = Object.assign({}, INITIAL_STATE);
    }

    // The room ID of the room currently being viewed
    public getRoomId() {
        return this.state.roomId;
    }

    // The event to scroll to when the room is first viewed
    public getInitialEventId() {
        return this.state.initialEventId;
    }

    // Whether to highlight the initial event
    public isInitialEventHighlighted() {
        return this.state.isInitialEventHighlighted;
    }

    // The room alias of the room (or null if not originally specified in view_room)
    public getRoomAlias() {
        return this.state.roomAlias;
    }

    // Whether the current room is loading (true whilst resolving an alias)
    public isRoomLoading() {
        return this.state.roomLoading;
    }

    // Any error that has occurred during loading
    public getRoomLoadError() {
        return this.state.roomLoadError;
    }

    // True if we're expecting the user to be joined to the room currently being
    // viewed. Note that this is left true after the join request has finished,
    // since we should still consider a join to be in progress until the room
    // & member events come down the sync.
    //
    // This flag remains true after the room has been sucessfully joined,
    // (this store doesn't listen for the appropriate member events)
    // so you should always observe the joined state from the member event
    // if a room object is present.
    // ie. The correct logic is:
    // if (room) {
    //     if (myMember.membership == 'joined') {
    //         // user is joined to the room
    //     } else {
    //         // Not joined
    //     }
    // } else {
    //     if (RoomViewStore.isJoining()) {
    //         // show spinner
    //     } else {
    //         // show join prompt
    //     }
    // }
    public isJoining() {
        return this.state.joining;
    }

    // Any error that has occurred during joining
    public getJoinError() {
        return this.state.joinError;
    }

    // The mxEvent if one is currently being replied to/quoted
    public getQuotingEvent() {
        return this.state.replyingToEvent;
    }

    public shouldPeek() {
        return this.state.shouldPeek;
    }

    public getWasContextSwitch() {
        return this.state.wasContextSwitch;
    }
}

let singletonRoomViewStore: RoomViewStore = null;
if (!singletonRoomViewStore) {
    singletonRoomViewStore = new RoomViewStore();
}
export default singletonRoomViewStore;
