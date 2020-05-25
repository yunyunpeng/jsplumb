import {Endpoint} from "./endpoint/endpoint-impl";
import {_timestamp, Dictionary, ExtendedOffset, jsPlumbInstance, Offset, PointXY, SortFunction} from "./core";
import {Connection} from "./connector/connection-impl";
import {ComputedAnchorPosition, Face} from "./factory/anchor-factory";
import { DynamicAnchor } from "./anchor/dynamic-anchor";
import {addToList, findWithFunction, removeWithFunction, sortHelper} from "./util";
import {ContinuousAnchor} from "./anchor/continuous-anchor";
import {lineLength} from "./geom";

export interface AnchorManagerOptions { }

function placeAnchorsOnLine(desc:any, elementDimensions:any, elementPosition:any, connections:any, horizontal:any, otherMultiplier:any, reverse:any):any {
    let a = [], step = elementDimensions[horizontal ? 0 : 1] / (connections.length + 1);

    for (let i = 0; i < connections.length; i++) {
        let val = (i + 1) * step, other = otherMultiplier * elementDimensions[horizontal ? 1 : 0];
        if (reverse) {
            val = elementDimensions[horizontal ? 0 : 1] - val;
        }

        const dx = (horizontal ? val : other), x = elementPosition[0] + dx, xp = dx / elementDimensions[0];
        const dy = (horizontal ? other : val), y = elementPosition[1] + dy, yp = dy / elementDimensions[1];

        a.push([ x, y, xp, yp, connections[i][1], connections[i][2] ]);
    }

    return a;
}

function rightAndBottomSort (a:any, b:any):number {
    return b[0][0] - a[0][0];
}

    // used by edgeSortFunctions
function leftAndTopSort (a:any, b:any):number {
    let p1 = a[0][0] < 0 ? -Math.PI - a[0][0] : Math.PI - a[0][0],
        p2 = b[0][0] < 0 ? -Math.PI - b[0][0] : Math.PI - b[0][0];

    return p1 - p2;
}

// used by placeAnchors
const edgeSortFunctions:Dictionary<SortFunction> = {
    "top": leftAndTopSort,
    "right": rightAndBottomSort,
    "bottom": rightAndBottomSort,
    "left": leftAndTopSort
};


export class ContinuousAnchorFactory<E> {

    private continuousAnchorLocations:Dictionary<ComputedAnchorPosition> = {};

    constructor(private manager:AnchorManager<E>) {}

    clear(endpointId:string) {
        delete this.continuousAnchorLocations[endpointId];
    }

    set(endpointId:string, pos:ComputedAnchorPosition) {
        this.continuousAnchorLocations[endpointId] = pos;
    }

    get(instance:jsPlumbInstance<E>, params?:any):ContinuousAnchor {
        return new ContinuousAnchor(instance, params);
    }
}


export class AnchorManager<E> {
    _amEndpoints:Dictionary<Array<Endpoint<E>>> = {};

    continuousAnchorLocations:any = {};
    continuousAnchorOrientations:any = {};

    private anchorLists:any = {};

    private floatingConnections:Dictionary<Connection<E>> = {};

    continuousAnchorFactory:ContinuousAnchorFactory<E>;


    constructor(private instance:jsPlumbInstance<E>, params?:AnchorManagerOptions) {

        this.continuousAnchorFactory = new ContinuousAnchorFactory(this);
    }

    reset () {
        this._amEndpoints = {};
        this.anchorLists = {};
    }

    private placeAnchors (instance:jsPlumbInstance<E>, elementId:string, _anchorLists:any):any {
        let cd = instance.getCachedData(elementId), sS = cd.s, sO = cd.o,
            placeSomeAnchors = (desc:any, elementDimensions:any, elementPosition:any, unsortedConnections:any, isHorizontal:any, otherMultiplier:any, orientation:any) => {
                if (unsortedConnections.length > 0) {
                    let sc = sortHelper(unsortedConnections, edgeSortFunctions[desc]), // puts them in order based on the target element's pos on screen
                        reverse = desc === "right" || desc === "top",
                        anchors = placeAnchorsOnLine(desc, elementDimensions,
                            elementPosition, sc,
                            isHorizontal, otherMultiplier, reverse);

                    // takes a computed anchor position and adjusts it for parent offset and scroll, then stores it.
                    let _setAnchorLocation = (endpoint:any, anchorPos:any) => {
                        this.continuousAnchorLocations[endpoint.id] = [ anchorPos[0], anchorPos[1], anchorPos[2], anchorPos[3] ];
                        this.continuousAnchorOrientations[endpoint.id] = orientation;
                    };

                    for (let i = 0; i < anchors.length; i++) {
                        let c = anchors[i][4], weAreSource = c.endpoints[0].elementId === elementId, weAreTarget = c.endpoints[1].elementId === elementId;
                        if (weAreSource) {
                            _setAnchorLocation(c.endpoints[0], anchors[i]);
                        }
                        if (weAreTarget) {
                            _setAnchorLocation(c.endpoints[1], anchors[i]);
                        }
                    }
                }
            };

        placeSomeAnchors("bottom", sS, [sO.left, sO.top], _anchorLists.bottom, true, 1, [0, 1]);
        placeSomeAnchors("top", sS, [sO.left, sO.top], _anchorLists.top, true, 0, [0, -1]);
        placeSomeAnchors("left", sS, [sO.left, sO.top], _anchorLists.left, false, 0, [-1, 0]);
        placeSomeAnchors("right", sS, [sO.left, sO.top], _anchorLists.right, false, 1, [1, 0]);
    }

    addFloatingConnection (key:string, conn:Connection<E>) {
        this.floatingConnections[key] = conn;
    };
    removeFloatingConnection (key:string) {
        delete this.floatingConnections[key];
    }

    newConnection (conn:Connection<E>):void {
        let sourceId = conn.sourceId, targetId = conn.targetId,
            ep = conn.endpoints,
            doRegisterTarget = true,
            registerConnection = (otherIndex:any, otherEndpoint:any, otherAnchor:any, elId:any, c:any) => {
                if ((sourceId === targetId) && otherAnchor.isContinuous) {
                    // remove the target endpoint's canvas.  we dont need it.
                    this.instance.renderer.destroyEndpoint(ep[1] as any);
                    doRegisterTarget = false;
                }
            };

        registerConnection(0, ep[0], ep[0].anchor, targetId, conn);
        if (doRegisterTarget) {
            registerConnection(1, ep[1], ep[1].anchor, sourceId, conn);
        }
    }

    removeEndpointFromAnchorLists (endpoint:any) {
        (function (list, eId) {
            if (list) {  // transient anchors dont get entries in this list.
                let f = (e:any) => {
                    return e[4] === eId;
                };
                removeWithFunction(list.top, f);
                removeWithFunction(list.left, f);
                removeWithFunction(list.bottom, f);
                removeWithFunction(list.right, f);
            }
        })(this.anchorLists[endpoint.elementId], endpoint.id);
    }

    connectionDetached (connInfo:any, doNotRedraw?:boolean) {
        let connection = connInfo.connection || connInfo,
            sourceId = connInfo.sourceId,
            targetId = connInfo.targetId,
            ep = connection.endpoints;

        if (connection.floatingId) {
            this.removeEndpointFromAnchorLists(connection.floatingEndpoint);
        }

        // remove from anchorLists
        this.removeEndpointFromAnchorLists(connection.endpoints[0]);
        this.removeEndpointFromAnchorLists(connection.endpoints[1]);

        if (!doNotRedraw) {
            this.redraw(connection.sourceId);
            if (connection.targetId !== connection.sourceId) {
                this.redraw(connection.targetId);
            }
        }
    }

    add (endpoint:any, elementId:string) {
        addToList(this._amEndpoints, elementId, endpoint);
    }

    changeId (oldId:string, newId:string) {
        this._amEndpoints[newId] = this._amEndpoints[oldId];
        delete this._amEndpoints[oldId];
    }

    deleteEndpoint (endpoint:Endpoint<E>) {
        removeWithFunction(this._amEndpoints[endpoint.elementId], function (e) {
            return e.id === endpoint.id;
        });
        this.removeEndpointFromAnchorLists(endpoint);
    }

    clearFor (elementId:string) {
        delete this._amEndpoints[elementId];
        this._amEndpoints[elementId] = [];
    };
    // updates the given anchor list by either updating an existing anchor's info, or adding it. this function
    // also removes the anchor from its previous list, if the edge it is on has changed.
    // all connections found along the way (those that are connected to one of the faces this function
    // operates on) are added to the connsToPaint list, as are their endpoints. in this way we know to repaint
    // them wthout having to calculate anything else about them.
    private _updateAnchorList (lists:any, theta:any, order:any, conn:any, aBoolean:any, otherElId:any, idx:any, reverse:any, edgeId:any, connsToPaint:Set<Connection<E>>, endpointsToPaint:Set<Endpoint<E>>) {
        // first try to find the exact match, but keep track of the first index of a matching element id along the way.s
        let exactIdx = -1,
            firstMatchingElIdx = -1,
            endpoint = conn.endpoints[idx],
            endpointId = endpoint.id,
            oIdx = [1, 0][idx],
            values = [
                [ theta, order ],
                conn,
                aBoolean,
                otherElId,
                endpointId
            ],
            listToAddTo = lists[edgeId],
            listToRemoveFrom = endpoint._continuousAnchorEdge ? lists[endpoint._continuousAnchorEdge] : null,
            i,
            candidate:any;

        if (listToRemoveFrom) {
            let rIdx = findWithFunction(listToRemoveFrom, function (e) {
                return e[4] === endpointId;
            });
            if (rIdx !== -1) {
                listToRemoveFrom.splice(rIdx, 1);
                // get all connections from this list
                for (let i = 0; i < listToRemoveFrom.length; i++) {
                    candidate = listToRemoveFrom[i][1];

                    connsToPaint.add(candidate);
                    endpointsToPaint.add(listToRemoveFrom[i][1].endpoints[idx]);
                    endpointsToPaint.add(listToRemoveFrom[i][1].endpoints[oIdx]);
                }
            }
        }

        for (let i = 0; i < listToAddTo.length; i++) {
            candidate = listToAddTo[i][1];

            connsToPaint.add(candidate);

            endpointsToPaint.add(listToAddTo[i][1].endpoints[idx]);
            endpointsToPaint.add(listToAddTo[i][1].endpoints[oIdx]);
        }
        if (exactIdx !== -1) {
            listToAddTo[exactIdx] = values;
        }
        else {
            let insertIdx = reverse ? firstMatchingElIdx !== -1 ? firstMatchingElIdx : 0 : listToAddTo.length; // of course we will get this from having looked through the array shortly.
            listToAddTo.splice(insertIdx, 0, values);
        }

        // store this for next time.
        endpoint._continuousAnchorEdge = edgeId;
    };

    //
    // moves the given endpoint from `currentId` to `element`.
    // This involves:
    //
    // 1. changing the key in _amEndpoints under which the endpoint is stored
    // 2. changing the source or target values in all of the endpoint's connections
    // 3. changing the array in connectionsByElementId in which the endpoint's connections
    //    are stored (done by either sourceChanged or updateOtherEndpoint)
    //
    rehomeEndpoint (ep:Endpoint<E>, currentId:string, element:E) {
        let eps = this._amEndpoints[currentId] || [],
            elementId = this.instance.getId(element);

        if (elementId !== currentId) {
            let idx = eps.indexOf(ep);
            if (idx > -1) {
                let _ep = eps.splice(idx, 1)[0];
                this.add(_ep, elementId);
            }
        }

        for (let i = 0; i < ep.connections.length; i++) {
            if (ep.connections[i].sourceId === currentId) {
                this.instance.sourceChanged(currentId, ep.elementId, ep.connections[i], ep.element);
            }
            else if (ep.connections[i].targetId === currentId) {
                ep.connections[i].targetId = ep.elementId;
                ep.connections[i].target = ep.element;
                ep.connections[i].updateConnectedClass();
            }
        }
    };

    redraw (elementId:string, ui?:any, timestamp?:string, offsetToUI?:Offset, doNotRecalcEndpoint?:boolean) {

        if (!this.instance._suspendDrawing) {

            let connectionsToPaint:Set<Connection<E>> = new Set(),
                endpointsToPaint:Set<Endpoint<E>> = new Set(),
                anchorsToUpdate:Set<string> = new Set();

            // get all the endpoints for this element
            let ep = this._amEndpoints[elementId] || [];

            timestamp = timestamp || _timestamp();
            // offsetToUI are values that would have been calculated in the dragManager when registering
            // an endpoint for an element that had a parent (somewhere in the hierarchy) that had been
            // registered as draggable.
            offsetToUI = offsetToUI || {left: 0, top: 0};
            if (ui) {
                ui = {
                    left: ui.left + offsetToUI.left,
                    top: ui.top + offsetToUI.top
                };
            }

            // valid for one paint cycle.
            let myOffset = this.instance.updateOffset({ elId: elementId, offset: ui, recalc: false, timestamp: timestamp }),
                orientationCache = {};

            for(let anEndpoint of ep) {

                endpointsToPaint.add(anEndpoint);

                if (anEndpoint.connections.length === 0) {
                    if (anEndpoint.anchor.isContinuous) {
                        if (!this.anchorLists[elementId]) {
                            this.anchorLists[elementId] = { top: [], right: [], bottom: [], left: [] };
                        }
                        this._updateAnchorList(this.anchorLists[elementId], -Math.PI / 2, 0, {endpoints: [anEndpoint, anEndpoint], paint: function () {
                        }}, false, elementId, 0, false, (<ContinuousAnchor>anEndpoint.anchor).getDefaultFace(), connectionsToPaint, endpointsToPaint);
                        anchorsToUpdate.add(elementId);
                    }

                } else {
                    for (let i = 0; i < anEndpoint.connections.length; i++) {
                        let conn = anEndpoint.connections[i],
                            sourceId = conn.sourceId,
                            targetId = conn.targetId,
                            sourceContinuous = conn.endpoints[0].anchor.isContinuous,
                            targetContinuous = conn.endpoints[1].anchor.isContinuous;

                        if (sourceContinuous || targetContinuous) {
                            let oKey = sourceId + "_" + targetId,
                                o = orientationCache[oKey],
                                oIdx = conn.sourceId === elementId ? 1 : 0;

                            if (sourceContinuous && !this.anchorLists[sourceId]) {
                                this.anchorLists[sourceId] = { top: [], right: [], bottom: [], left: [] };
                            }
                            if (targetContinuous && !this.anchorLists[targetId]) {
                                this.anchorLists[targetId] = { top: [], right: [], bottom: [], left: [] };
                            }

                            if (elementId !== targetId) {
                                this.instance.updateOffset({ elId: targetId, timestamp: timestamp });
                            }
                            if (elementId !== sourceId) {
                                this.instance.updateOffset({ elId: sourceId, timestamp: timestamp });
                            }

                            let td = this.instance.getCachedData(targetId),
                                sd = this.instance.getCachedData(sourceId);

                            if (targetId === sourceId && (sourceContinuous || targetContinuous)) {
                                // here we may want to improve this by somehow determining the face we'd like
                                // to put the connector on.  ideally, when drawing, the face should be calculated
                                // by determining which face is closest to the point at which the mouse button
                                // was released.  for now, we're putting it on the top face.
                                this._updateAnchorList( this.anchorLists[sourceId], -Math.PI / 2, 0, conn, false, targetId, 0, false, "top", connectionsToPaint, endpointsToPaint);
                                this._updateAnchorList( this.anchorLists[targetId], -Math.PI / 2, 0, conn, false, sourceId, 1, false, "top", connectionsToPaint, endpointsToPaint);
                            }
                            else {
                                if (!o) {
                                    o = this.calculateOrientation(sourceId, targetId, sd.o, td.o, conn.endpoints[0].anchor, conn.endpoints[1].anchor, conn);
                                    orientationCache[oKey] = o;
                                }
                                if (sourceContinuous) {
                                    this._updateAnchorList(this.anchorLists[sourceId], o.theta, 0, conn, false, targetId, 0, false, o.a[0], connectionsToPaint, endpointsToPaint);
                                }
                                if (targetContinuous) {
                                    this._updateAnchorList(this.anchorLists[targetId], o.theta2, -1, conn, true, sourceId, 1, true, o.a[1], connectionsToPaint, endpointsToPaint);
                                }
                            }

                            if (sourceContinuous) {
                                anchorsToUpdate.add(sourceId);
                            }
                            if (targetContinuous) {
                                anchorsToUpdate.add(targetId);
                            }

                            connectionsToPaint.add(conn);

                            if ((sourceContinuous && oIdx === 0) || (targetContinuous && oIdx === 1)) {
                                endpointsToPaint.add(conn.endpoints[oIdx]);
                            }
                        }
                        else {
                            let otherEndpoint = anEndpoint.connections[i].endpoints[conn.sourceId === elementId ? 1 : 0];

                            if (otherEndpoint.anchor.constructor === DynamicAnchor) {

                                otherEndpoint.paint({ elementWithPrecedence: elementId, timestamp: timestamp });

                                connectionsToPaint.add(anEndpoint.connections[i]);

                                // all the connections for the other endpoint now need to be repainted
                                for (let k = 0; k < otherEndpoint.connections.length; k++) {
                                    if (otherEndpoint.connections[k] !== anEndpoint.connections[i]) {
                                        connectionsToPaint.add(otherEndpoint.connections[k]);
                                    }
                                }
                            } else {
                                connectionsToPaint.add(anEndpoint.connections[i]);
                            }
                        }
                    }
                }
            }

            // now place all the continuous anchors we need to;
            for (let anchor of anchorsToUpdate) {
                this.placeAnchors(this.instance, anchor, this.anchorLists[anchor]);
            }

            // now that continuous anchors have been placed, paint all the endpoints for this element and any other endpoints we came across as a result of the continuous anchors.
            for (let ep of endpointsToPaint) {
                let cd = this.instance.getCachedData(ep.elementId);
                ep.paint({ timestamp: timestamp, offset: cd, dimensions: cd.s });
            }

            // paint current floating connection for this element, if there is one.
            let fc = this.floatingConnections[elementId];
            if (fc) {
                fc.paint({timestamp: timestamp, recalc: false, elId: elementId});
            }

            // paint all the connections
            for (let c of connectionsToPaint) {
                c.paint({elId: elementId, timestamp: timestamp, recalc: false});
            }
        }
    }

    calculateOrientation (sourceId:string, targetId:string, sd:any, td:any, sourceAnchor:any, targetAnchor:any, connection?:Connection<E>):{orientation?:string, a:[Face, Face], theta?:number, theta2?:number} {

        let Orientation = { HORIZONTAL: "horizontal", VERTICAL: "vertical", DIAGONAL: "diagonal", IDENTITY: "identity" };

        if (sourceId === targetId) {
            return {
                orientation: Orientation.IDENTITY,
                a: ["top", "top"]
            };
        }

        let theta = Math.atan2((td.centery - sd.centery), (td.centerx - sd.centerx)),
            theta2 = Math.atan2((sd.centery - td.centery), (sd.centerx - td.centerx));

// --------------------------------------------------------------------------------------

        // improved face calculation. get midpoints of each face for source and target, then put in an array with all combinations of
        // source/target faces. sort this array by distance between midpoints. the entry at index 0 is our preferred option. we can
        // go through the array one by one until we find an entry in which each requested face is supported.
        let candidates:Array<{source:Face, target:Face, dist:number}> = [], midpoints:Dictionary<{
            top:PointXY,
            left:PointXY,
            right:PointXY,
            bottom:PointXY
        }> = { };
        (function (types:Array<string>, dim:Array<ExtendedOffset>) {
            for (let i = 0; i < types.length; i++) {
                midpoints[types[i]] = {
                    "left": {x:dim[i].left, y:dim[i].centery },
                    "right": {x:dim[i].right, y:dim[i].centery },
                    "top": {x:dim[i].centerx, y:dim[i].top },
                    "bottom": {x:dim[i].centerx , y:dim[i].bottom}
                };
            }
        })([ "source", "target" ], [ sd, td ]);

        let FACES:Array<Face> = [ "top", "right", "left", "bottom" ];

        for (let sf = 0; sf < FACES.length; sf++) {
            for (let tf = 0; tf < FACES.length; tf++) {
                candidates.push({
                    source: FACES[sf],
                    target: FACES[tf],
                    dist: lineLength(midpoints.source[FACES[sf]], midpoints.target[FACES[tf]])
                });
            }
        }

        candidates.sort(function (a, b) {
            return a.dist < b.dist ? -1 : a.dist > b.dist ? 1 : 0;
        });

        // now go through this list and try to get an entry that satisfies both (there will be one, unless one of the anchors
        // declares no available faces)
        let sourceEdge = candidates[0].source, targetEdge = candidates[0].target;
        for (let i = 0; i < candidates.length; i++) {

            if (!sourceAnchor.isContinuous || sourceAnchor.isEdgeSupported(candidates[i].source)) {
                sourceEdge = candidates[i].source;
            }
            else {
                sourceEdge = null;
            }

            if (!targetAnchor.isContinuous || targetAnchor.isEdgeSupported(candidates[i].target)) {
                targetEdge = candidates[i].target;
            }
            else {
                targetEdge = null;
            }

            if (sourceEdge != null && targetEdge != null) {
                break;
            }
        }

        if (sourceAnchor.isContinuous) {
            sourceAnchor.setCurrentFace(sourceEdge);
        }

        if (targetAnchor.isContinuous) {
            targetAnchor.setCurrentFace(targetEdge);
        }

// --------------------------------------------------------------------------------------

        return {
            a: [ sourceEdge, targetEdge ],
            theta: theta,
            theta2: theta2
        };
    }
}


