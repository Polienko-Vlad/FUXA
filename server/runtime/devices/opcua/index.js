/**
 * OPC UA Client Driver
 */
var opcua;

const async = require('async');
const utils = require('../../utils');
const deviceUtils = require('../device-utils');

function OpcUAclient(_data, _logger, _events, _runtime) {

    var runtime = _runtime;
    var data = _data;                   // Current Device data { id, name, tags, enabled, ... }
    var logger = _logger;               // Logger
    var working = false;                // Working flag to manage overloading polling and connection
    var connected = false;              // Connected flag
    var monitored = false;              // Monitored flag
    var lastStatus = '';                // Last Device status
    var events = _events;               // Events to commit change to runtime
    var the_session;
    var the_subscription = null;
    var extraSubs = [];                 // Additional subscriptions used when monitored items exceed a single subscription limit
    var lastStaleRefresh = 0;           // Last timestamp of the stale tags refresh
    var options = { connectionStrategy: { maxRetry: 1 }, keepSessionAlive: true, endpointMustExist: false };  // Connections options
    var client = opcua.OPCUAClient.create(options);
    const attributeKeys = Object.keys(opcua.AttributeIds).filter((x) => x === 'DataType' || x === 'AccessLevel' || x === 'UserAccessLevel');//x !== "INVALID" && x[0].match(/[a-zA-Z]/));

    var varsValue = {};                 // Signals to send to frontend { id, type, value }
    var getProperty = null;             // Function to ask property (security)
    var lastTimestampValue;             // Last Timestamp of asked values
    var tagsIdMap = {};                 // Map of tag id with opc nodeId

    /**
     * Connect the client to OPC UA server
     * Open Session, Create Subscription, Emit connection status, Clear the memory Tags value
     */
    this.connect = function () {
        var self = this;
        return new Promise(function (resolve, reject) {
            if (!_checkWorking(true)) {
                reject();
            } else {
                var property = null;
                async.series([
                    // step 1 check property
                    function (callback) {
                        if (getProperty) {
                            getProperty({query: 'security', name: data.id}).then(result => {
                                if (result && result.value && result.value !== 'null') {
                                    // property security mode
                                    property = JSON.parse(result.value);
                                    var opts = {
                                        // applicationName: 'Myclient',
                                        endpointMustExist: false,
                                        keepSessionAlive: true,
                                        connectionStrategy: { maxRetry: 1 } };
                                    if (property.mode) {
                                        if (property.mode.securityMode) {
                                            opts['securityMode'] = property.mode.securityMode;
                                        }
                                        if (property.mode.securityPolicy) {
                                            opts['securityPolicy'] = property.mode.securityPolicy;
                                        }
                                    }
                                    client = opcua.OPCUAClient.create(opts);
                                }
                                callback();
                            }).catch(function (err) {
                                callback(err);
                            });
                        } else {
                            callback();
                        }
                    },
                    // step 2 connect
                    function (callback) {
                        const endpoint = data.property.address;
                        client.connect(endpoint, function (err) {
                            if (err) {
                                _clearVarsValue();
                                logger.error(`'${data.name}' connect failure! ${err}`);
                            } else {
                                logger.info(`'${data.name}' connection`, true);
                            }
                            callback(err);
                        });
                        client.on("connection_lost", () => {
                            logger.error(`'${data.name}' connection lost!`);
                            self.disconnect().then(function () { });
                        });
                        client.on("backoff", (retry, delay) => {
                            logger.error(`'${data.name}' retry to connect! ${retry}`);
                        });
                    },
                    // step 3 create session
                    function (callback) {
                        const userIdentityInfo = { };
                        if (property && property.uid && property.pwd) {
                            userIdentityInfo['userName'] = property.uid;
                            userIdentityInfo['password'] = property.pwd;
                        }
                        client.createSession(userIdentityInfo, function (err, session) {
                            if (err) {
                                _clearVarsValue();
                                logger.error(`'${data.name}' createSession failure! ${err}`);
                            } else {
                                the_session = session;
                                the_session.on('session_closed', () => {
                                    logger.warn(`'${data.name}' Warning => Session closed`);
                                });
                                the_session.on('keepalive', () => {
                                    logger.info(`'${data.name}' session keepalive`, true);
                                });
                                the_session.on('keepalive_failure', () => {
                                    logger.error(`'${data.name}' session keepalive failure!`);
                                    self.disconnect().then(function () { });
                                });
                                the_session.on("terminated", function() {
                                    console.log("terminated");
                                });
                                _createSubscription();
                            }
                            callback(err);
                        });
                    }],
                    function (err) {
                        if (err) {
                            logger.error(`'${data.name}' try to connect error! ${err}`);
                            _emitStatus('connect-error');
                            _clearVarsValue();
                            connected = false;
                            reject();
                            client.disconnect(function () { });
                        } else {
                            logger.info(`'${data.name}' connected!`, true);
                            _emitStatus('connect-ok');
                            connected = true;
                            resolve();
                        }
                        _checkWorking(false);
                    });
            }
        });
    }

    /**
     * Disconnect the OPC UA server
     * Emit connection status, Clear the memory Tags value
     */
    this.disconnect = function () {
        return new Promise(function (resolve, reject) {
            _disconnect(function (err) {
                if (err) {
                    logger.error(`'${data.name}' disconnect failure! ${err}`);
                }
                connected = false;
                monitored = false;
                _checkWorking(false);
                _emitStatus('connect-off');
                _clearVarsValue();
                resolve(true);
            });
        });
    }

    /**
     * Browse Server Nodes, read the childres of gived node
     * The browser callback have a children nodes count limit and have to use _browseNext
     */
    this.browse = function (node) {
        let nodeId = (node) ? node.id : opcua.resolveNodeId('RootFolder');
        return new Promise(function (resolve, reject) {
            // "RootFolder"
            if (the_session) {
                the_session.browse(nodeId, function (err, browseResult) {
                    if (!err) {
                        let opcNodes = [];
                        browseResult.references.forEach(function (reference) {
                            let node = new OpcNode(reference.browseName.toString());
                            if (reference.displayName) {
                                node.name = reference.displayName.text;
                            }
                            node.id = reference.nodeId;
                            node.class = reference.nodeClass;
                            opcNodes.push(node);
                        });

                        if (browseResult.continuationPoint) {
                            var nextresult = _browseNext(browseResult.continuationPoint).then(nodes => {
                                for (let i = 0; i < nodes.length; i++) {
                                    opcNodes.push(nodes[i]);
                                }
                                resolve(opcNodes);
                            });
                        } else {
                            resolve(opcNodes);
                        }
                    } else {
                        reject(err);
                    }
                });
            } else {
                reject('Session Error');
            }
        });
    }

    /**
     * Browser the next children nodes after contipoint position
     * @param {*} contipoint
     */
    var _browseNext = function (contipoint) {
        var opcNodes = [];
        var browseNextRequest = new opcua.BrowseNextRequest({
            continuationPoints: [contipoint]
        });
        return new Promise(function (resolve, reject) {
            the_session.performMessageTransaction(browseNextRequest, function (err, response) {
                if (err) {
                    reject(err);
                } else {
                    if (response.results && response.results[0]) {
                        let browseResult = response.results[0];
                        browseResult.references.forEach(function (reference) {
                            let node = new OpcNode(reference.browseName.toString());
                            if (reference.displayName) {
                                node.name = reference.displayName.text;
                            }
                            node.id = reference.nodeId;
                            node.class = reference.nodeClass;
                            opcNodes.push(node);
                        });
                        if (browseResult.continuationPoint) {
                            _browseNext(browseResult.continuationPoint).then(nodes => {
                                for (let i = 0; i < nodes.length; i++) {
                                    opcNodes.push(nodes[i]);
                                }
                                return resolve(opcNodes);
                            });
                        } else {
                            return resolve(opcNodes);
                        }
                    } else {
                        return resolve(opcNodes);
                    }
                }
            });
        });
    }

    /**
     * Read node attribute
     */
    this.readAttribute = function (node) {

        const attr = [];

        const nodesToRead = attributeKeys.map((attr) => ({
            nodeId: node.id,
            attributeId: opcua.AttributeIds[attr]
        }));

        return new Promise(function (resolve, reject) {

            the_session.read(nodesToRead, function (err, dataValues) {
                if (err) {
                    reject('#readAllAttributes returned ' + err.message);
                } else {
                    node.attribute = {};
                    for (let i = 0; i < nodesToRead.length; i++) {
                        const obj = _attrToObject(nodesToRead[i].attributeId, dataValues[i]);
                        if (obj) {
                            node.attribute[nodesToRead[i].attributeId] = obj.attribute;
                        }
                        // if (dataValue.statusCode !== opcua.StatusCodes.Good) {
                        //     continue;
                        // }
                        // const s = toString1(nodeToRead.attributeId, dataValue);
                        // append_text(attributeIdtoString[nodeToRead.attributeId], s, attr);
                    }
                    resolve(node);
                }
            });
        });
    }

    /**
     * Take the current Tags value (only changed), Reset the change flag, Emit Tags value
     * Save DAQ value
     */
    this.polling = async function () {
        if (_checkWorking(true)) {
            if (!monitored) {
                _startMonitor().then(ok => {
                    if (ok && connected) {
                        monitored = true;
                    }
                    _checkWorking(false);
                }).catch(function (err) {
                    logger.error(`'${data.name}' polling error (_startMonitor): ${err}`);
                    _checkWorking(false);
                });
            } else if (the_session && client) {
                try {
                    await _refreshStaleTags();
                    var varsValueChanged = await _checkVarsChanged();
                    lastTimestampValue = new Date().getTime();
                    _emitValues(varsValue);

                    if (this.addDaq && !utils.isEmptyObject(varsValueChanged)) {
                        this.addDaq(varsValueChanged, data.name, data.id);
                    }
                } catch (err) {
                    logger.error(`'${data.name}' polling error: ${err}`);
                }
                _checkWorking(false);
            } else {
                _checkWorking(false);
            }
        }
    }

    /**
     * Load Tags to read by polling
     */
    this.load = function (_data) {
        data = JSON.parse(JSON.stringify(_data));
        try {
            var count = Object.keys(data.tags).length;
            logger.info(`'${data.name}' data loaded (${count})`, true);
        } catch (err) {
            logger.error(`'${data.name}' load error! ${err}`);
        }
    }

    /**
     * Return Tags values array { id: <name>, value: <value>, type: <type> }
     */
    this.getValues = function () {
        return data.tags;
    }

    /**
     * Return Tag value { id: <name>, value: <value>, ts: <lastTimestampValue> }
     */
    this.getValue = function (id) {
        if (varsValue[id]) {
            return {id: id, value: varsValue[id].value, ts: lastTimestampValue };
        }
        return null;
    }

    /**
     * Return Device status Connected/Disconnected 'connect-off', 'connect-ok', 'connect-error'
     */
    this.getStatus = function () {
        return lastStatus;
    }

    /**
     * Return Tag property
     */
    this.getTagProperty = function (id) {
        if (data.tags[id]) {
            return { id: id, name: data.tags[id].name, type: data.tags[id].type, format: data.tags[id].format };
        } else {
            return null;
        }
    }

    /**
     * Set Tag value, used to set value from frontend
     */
    this.setValue = async function (tagId, value) {
        if (the_session && data.tags[tagId]) {
            let opcType = _toDataType(data.tags[tagId].type);
            if (data.tags[tagId].dataType) {
                opcType = data.tags[tagId].dataType; // use the actual dataType from read
            }
            let valueToSend = _toValue(opcType, value);
            valueToSend = await deviceUtils.tagRawCalculator(valueToSend, data.tags[tagId], runtime);
            if (opcType === opcua.DataType.String || opcType === opcua.DataType.ByteString) {
                valueToSend = valueToSend?.toString();
            }
            var nodesToWrite = [
                {
                    nodeId: data.tags[tagId].address,
                    attributeId: opcua.AttributeIds.Value,
                    value: /*new DataValue(*/{
                        value: {/* Variant */
                            dataType: opcType,
                            value: valueToSend
                        }
                    }
                }
            ];

            the_session.write(nodesToWrite, function (err, statusCodes) {
                if (err) {
                    logger.error(`'${data.name}' setValue error! ${err}`);
                } else {
                    logger.info(`'${data.name}' setValue(${tagId}, ${value})`, true, true);
                }
            });
            return true;
        }
        return false;
    }

    /**
     * Is Connected true/false
     */
    this.isConnected = function () {
        return connected;
    }

    /**
     * Set the callback to set value to DAQ
     */
    this.bindAddDaq = function (fnc) {
        this.addDaq = fnc;                          // Add the DAQ value to db history
    }
    this.addDaq = null;                             // Callback to add the DAQ value to db history


    /**
     * Return the timestamp of last read tag operation on polling
     * @returns
     */
     this.lastReadTimestamp = () => {
        return lastTimestampValue;
    }

    /**
     * Set function to ask property (security)
     */
    this.bindGetProperty = function (fnc) {
        getProperty = fnc;
    }

    /**
     * Return the Daq settings of Tag
     * @returns
     */
    this.getTagDaqSettings = (tagId) => {
        return data.tags[tagId] ? data.tags[tagId].daq : null;
    }

    /**
     * Set Daq settings of Tag
     * @returns
     */
    this.setTagDaqSettings = (tagId, settings) => {
        if (data.tags[tagId]) {
            utils.mergeObjectsValues(data.tags[tagId].daq, settings);
        }
    }

    /**
     * Disconnect the OPC UA client and close session if used
     * @param {*} callback
     */
    var _disconnect = function (callback) {
        if (!the_session) {
            client.disconnect(function (err) {
                callback(err);
            });
        } else {
            the_session.close(function () {
                client.disconnect(function (err) {
                    callback(err);
                });
            });
        }
    }

    /**
     * Create a session subscription to refresh Tags value.
     *
     * The subscription's `requestedPublishingInterval` follows the device's
     * polling rate (`data.polling`) so the device-level "update rate" UI
     * setting actually propagates to the OPC-UA subscription. Falls back to
     * 100 ms — the OPC-UA protocol minimum in most servers — when the user
     * hasn't configured a polling rate.
     *
     * Previously this was hard-coded to 500 ms regardless of UI input,
     * capping subscription updates at 2 Hz no matter what the user picked.
     */
    var _createSubscription = function () {
        if (the_session) {
            const parameters = {
                requestedPublishingInterval: data.polling || 500,
                requestedLifetimeCount: 600,
                requestedMaxKeepAliveCount: 10,
                maxNotificationsPerPublish: 0,
                publishingEnabled: true,
                priority: 0
            };
            the_session.createSubscription2(
                parameters,
                (err, subscription) => {
                    if (err) {
                        logger.error(`'${data.name}' can't create subscription! ${err.message}`);
                        return;
                    }
                    the_subscription = subscription;
                    logger.info(`'${data.name}' subscription created!`, true);
                });
        }
    }

    /**
     * Start the monitor by subsribe the Tags to check if value change
     * samplingInterval = 1000 msec.
     *
     * Handles the case where the total number of monitored items exceeds a
     * single subscription's item limit (~1000 in most servers) by creating
     * additional subscriptions and distributing the items across them.
     * Also expands virtual "TU_Number"-style array tags into 20 single-item
     * character monitors, combining them back into a string value.
     *
     * @param {*} callback
     */
    var _startMonitor = function () {
        return new Promise(async function (resolve, reject) {
            if (!the_session || !the_subscription) {
                return reject();
            }

            const SUBSCRIPTION_ITEM_LIMIT = 1000;

            for (const s of extraSubs) {
                try { await s.terminate(); } catch (e) { }
            }
            extraSubs = [];

            tagsIdMap = {};

            var items = [];
            var expectedCount = 0;

            for (var id in data.tags) {
                var nodeId = data.tags[id].address;
                if (!nodeId) continue;

                var isVirtualCharArray = /TU_Number"?$/.test(nodeId);

                if (isVirtualCharArray) {
                    data.tags[id].isCharArray = true;
                    data.tags[id].charBuffer = new Array(20).fill('');
                    for (var i = 0; i < 20; i++) {
                        items.push({ nodeId: nodeId + '[' + i + ']', tagId: id, charIndex: i });
                    }
                    expectedCount += 20;
                } else {
                    items.push({ nodeId: nodeId, tagId: id, charIndex: null });
                    expectedCount += 1;
                }
            }

            logger.info(`'${data.name}' preparing ${items.length} monitored items from ${Object.keys(data.tags).length} tags`);

            var subscriptions = [the_subscription];
            var neededSubs = Math.ceil(expectedCount / SUBSCRIPTION_ITEM_LIMIT);
            for (var s = 1; s < neededSubs; s++) {
                try {
                    var sub = await new Promise((res, rej) => {
                        the_session.createSubscription2({
                            requestedPublishingInterval: data.polling || 500,
                            requestedLifetimeCount: 600,
                            requestedMaxKeepAliveCount: 10,
                            maxNotificationsPerPublish: 0,
                            publishingEnabled: true,
                            priority: 0
                        }, (err, subscription) => {
                            if (err) rej(err); else res(subscription);
                        });
                    });
                    subscriptions.push(sub);
                } catch (err) {
                    logger.error(`'${data.name}' failed to create additional subscription #${s + 1}: ${err.message}`);
                }
            }
            extraSubs = subscriptions.slice(1);
            logger.info(`'${data.name}' using ${subscriptions.length} subscription(s) for ${items.length} monitored items`);

            var promises = [];
            var subscribedOk = 0;
            var subscribedBad = 0;

            for (var k = 0; k < items.length; k++) {
                var it = items[k];
                var sub = subscriptions[k % subscriptions.length];
                tagsIdMap[it.nodeId] = it.tagId;

                const itemId = it.nodeId;
                const itemCharIndex = it.charIndex;

                promises.push(
                    sub.monitor(
                        { nodeId: itemId, attributeId: opcua.AttributeIds.Value },
                        { samplingInterval: data.polling || 1000, discardOldest: true, queueSize: 1 },
                        opcua.TimestampsToReturn.Both
                    ).then(monitoredItem => {
                        monitoredItem.on('changed', _monitorcallback(itemId, itemCharIndex));
                        try {
                            const st = monitoredItem.statusCode;
                            if (st && st.isBad && st.isBad()) {
                                subscribedBad++;
                                logger.error(`'${itemId}' monitored item rejected by server: ${st.toString()}`);
                            } else {
                                subscribedOk++;
                            }
                        } catch (e) {
                            subscribedOk++;
                        }
                    }).catch(err => {
                        subscribedBad++;
                        logger.error(`'${itemId}' subscribe failed: ${err.message || err}`);
                    })
                );
            }

            await Promise.all(promises);

            logger.info(`'${data.name}' subscribed: ${subscribedOk} ok, ${subscribedBad} rejected/failed (total ${items.length})`);
            if (subscribedBad > 0) {
                logger.warn(`'${data.name}' ${subscribedBad} items not subscribed - they will be served by fallback polling read`);
            }

            resolve(true);
        });
    }

    /**
     * Apply a received DataValue to the local Tag
     * Handles both plain values and virtual char-array tags
     * @param {*} id
     * @param {*} index
     * @param {*} dataValue
     */
    var _applyDataValue = function (id, index, dataValue) {
        if (!dataValue || !dataValue.value) return;
        if (dataValue.statusCode && dataValue.statusCode.isBad && dataValue.statusCode.isBad()) return;
        if (!data.tags[id]) return;

        let rawVal = dataValue.value.value;

        if (data.tags[id].isCharArray && index !== null) {
            let code = null;
            if (typeof rawVal === 'number') {
                code = rawVal;
            } else if (typeof rawVal === 'string' && rawVal.length > 0) {
                code = rawVal.charCodeAt(0);
            } else if (rawVal && typeof rawVal === 'object' && rawVal.value !== undefined) {
                code = rawVal.value;
            }
            let ch = '';
            if (code !== null && code >= 32 && code <= 126) {
                ch = String.fromCharCode(code);
            }
            if (!data.tags[id].charBuffer) data.tags[id].charBuffer = new Array(20).fill('');
            data.tags[id].charBuffer[index] = ch;
            data.tags[id].rawValue = data.tags[id].charBuffer.join('');
            data.tags[id].dataType = opcua.DataType.String;
        } else {
            if (Array.isArray(rawVal) && rawVal.length > 0) {
                rawVal = rawVal[rawVal.length - 1];
            }
            data.tags[id].rawValue = rawVal;
            data.tags[id].dataType = dataValue.value.dataType;
        }

        data.tags[id].serverTimestamp = dataValue.serverTimestamp ? dataValue.serverTimestamp.toString() : new Date().toString();
        data.tags[id].timestamp = new Date().getTime();
        data.tags[id].changed = true;
    }

    /**
     * Callback from monitor of changed Tag value
     * And set the changed value to local Tags
     * @param {*} _nodeId
     * @param {*} _index
     */
    var _monitorcallback = function (_nodeId, _index) {
        var nodeId = _nodeId;
        var index = _index;
        return function (dataValue) {
            let id = tagsIdMap[nodeId];
            if (!id) return;
            _applyDataValue(id, index, dataValue);
        };
    }

    /**
     * Refresh tags that have not been updated for a while by reading them
     * directly. Acts as a fallback for items the server did not accept for
     * monitoring or whose notifications never arrived.
     */
    var _refreshStaleTags = async function () {
        if (!the_session) return;
        const now = new Date().getTime();
        if (now - lastStaleRefresh < 5000) return;
        lastStaleRefresh = now;

        const STALE_MS = 15000;
        var nodesToRead = [];

        for (var id in data.tags) {
            const tag = data.tags[id];
            if (!tag.address) continue;
            const ts = tag.timestamp || 0;
            if (now - ts < STALE_MS) continue;
            if (tag.isCharArray) {
                for (var i = 0; i < 20; i++) {
                    nodesToRead.push({ nodeId: tag.address + '[' + i + ']', tagId: id, index: i });
                }
            } else {
                nodesToRead.push({ nodeId: tag.address, tagId: id, index: null });
            }
        }
        if (!nodesToRead.length) return;

        const CHUNK = 500;
        var badCount = 0;
        for (var c = 0; c < nodesToRead.length; c += CHUNK) {
            const chunk = nodesToRead.slice(c, c + CHUNK);
            try {
                const dataValues = await the_session.read(chunk.map(n => ({ nodeId: n.nodeId, attributeId: opcua.AttributeIds.Value })));
                for (var j = 0; j < chunk.length; j++) {
                    const dv = dataValues[j];
                    if (dv && dv.statusCode && dv.statusCode.isBad && dv.statusCode.isBad()) {
                        badCount++;
                    }
                    _applyDataValue(chunk[j].tagId, chunk[j].index, dv);
                }
            } catch (err) {
                logger.error(`'${data.name}' stale refresh read error: ${err}`);
            }
        }
        logger.info(`'${data.name}' stale refresh: read ${nodesToRead.length} nodes, ${badCount} bad statuses`);
    }

    /**
     * Clear local Tags value by set all to null
     */
    var _clearVarsValue = function () {
        for (let id in varsValue) {
            varsValue[id].value = null;
        }
        _emitValues(varsValue);
    }

    /**
     * Return the Tags that have value changed and clear value changed flag of all Tags
     */
    var _checkVarsChanged = async () => {
        const timestamp = new Date().getTime();
        var result = {};
        for (var id in data.tags) {
            data.tags[id].value = await deviceUtils.tagValueCompose(data.tags[id].rawValue, varsValue[id] ? varsValue[id].value : null, data.tags[id], runtime);
            if (this.addDaq && !utils.isNullOrUndefined(data.tags[id].value) && deviceUtils.tagDaqToSave(data.tags[id], timestamp)) {
                result[id] = data.tags[id];
            }
            data.tags[id].changed = false;
            varsValue[id] = data.tags[id];
        }
        return result;
    }

    /**
     * To manage a overloading connection
     * @param {*} check
     */
    var _checkWorking = function (check) {
        if (check && working) {
            if (monitored) {
                logger.warn(`'${data.name}' working (connection || polling) overload!`);
            }
            return false;
        }
        working = check;
        return true;
    }

    /**
     * Emit Tags in application
     * @param {*} values
     */
    var _emitValues = function (values) {
        events.emit('device-value:changed', { id: data.id, values: values });
    }

    /**
     * Emit status in application
     * @param {*} status
     */
    var _emitStatus = function (status) {
        lastStatus = status;
        events.emit('device-status:changed', { id: data.id, status: status });
    }

    /**
     * Return formatted Tag attribute
     * @param {*} attribute
     * @param {*} dataValue
     */
    var _attrToObject = function (attribute, dataValue) {

        if (!dataValue || !dataValue.value || !dataValue.value.hasOwnProperty('value')) {
            return null;
        }
        switch (attribute) {
            case opcua.AttributeIds.DataType:
                let dtype = opcua.DataType[dataValue.value.value.value];
                return { attribute: dtype };
            // case opcua.AttributeIds.NodeClass:
            //     return NodeClass[dataValue.value.value] + " (" + dataValue.value.value + ")";
            // case opcua.AttributeIds.IsAbstract:
            // case opcua.AttributeIds.Historizing:
            // case opcua.AttributeIds.EventNotifier:
            //     return dataValue.value.value ? "true" : "false"
            // case opcua.AttributeIds.WriteMask:
            // case opcua.AttributeIds.UserWriteMask:
            //     return " (" + dataValue.value.value + ")";
            // case opcua.AttributeIds.NodeId:
            // case opcua.AttributeIds.BrowseName:
            // case opcua.AttributeIds.DisplayName:
            // case opcua.AttributeIds.Description:
            // case opcua.AttributeIds.ValueRank:
            // case opcua.AttributeIds.ArrayDimensions:
            // case opcua.AttributeIds.Executable:
            // case opcua.AttributeIds.UserExecutable:
            // case opcua.AttributeIds.MinimumSamplingInterval:
            //     if (!dataValue.value.value) {
            //         return "null";
            //     }
            //     return dataValue.value.value.toString();
            case opcua.AttributeIds.UserAccessLevel:
            case opcua.AttributeIds.AccessLevel:
                if (!dataValue.value.value) {
                    return null;
                }
                let rlev = opcua.AccessLevelFlag[dataValue.value.value & 1];
                let wlev = opcua.AccessLevelFlag[dataValue.value.value & 2];
                let lev = '';
                if (rlev) {
                    lev += 'R';
                }
                if (wlev) {
                    if (rlev) {
                        lev += '/';
                    }
                    lev += 'W';
                }
                return { attribute: lev };
            default:
                return null;
        }
    }

    /**
     * Convert OPCUA data type from string
     * @param {*} type
     */
    var _toDataType = function (type) {
        if (type === 'Boolean') {
            return opcua.DataType.Boolean;
        } else if (type === 'SByte') {
            return opcua.DataType.SByte;
        } else if (type === 'Byte') {
            return opcua.DataType.Byte;
        } else if (type === 'Int16') {
            return opcua.DataType.Int16;
        } else if (type === 'UInt16') {
            return opcua.DataType.UInt16;
        } else if (type === 'Int32') {
            return opcua.DataType.Int32;
        } else if (type === 'UInt32') {
            return opcua.DataType.UInt32;
        } else if (type === 'Int64') {
            return opcua.DataType.Int64;
        } else if (type === 'UInt64') {
            return opcua.DataType.UInt64;
        } else if (type === 'Float') {
            return opcua.DataType.Float;
        } else if (type === 'Double') {
            return opcua.DataType.Double;
        } else if (type === 'String') {
            return opcua.DataType.String;
        } else if (type === 'DateTime') {
            return opcua.DataType.DateTime;
        } else if (type === 'Guid') {
            return opcua.DataType.Guid;
        } else if (type === 'ByteString') {
            return opcua.DataType.ByteString;
        }
    }

    /**
     * Convert value from string depending of type
     * @param {*} type
     * @param {*} value
     */
    var _toValue = function (type, value) {
        switch (type) {
            case opcua.DataType.Boolean:
                if (typeof value === 'boolean') {
                    return value;
                }
                if (typeof value === 'string') {
                    const val = value.toLowerCase();
                    return val === 'true' || val === '1';
                }
                if (typeof value === 'number') {
                    return value === 1;
                }
                return false;
            case opcua.DataType.SByte:
            case opcua.DataType.Byte:
            case opcua.DataType.Int16:
            case opcua.DataType.UInt16:
            case opcua.DataType.Int32:
            case opcua.DataType.UInt32:
            case opcua.DataType.Int64:
            case opcua.DataType.UInt64:
                return parseInt(value);
            case opcua.DataType.Float:
            case opcua.DataType.Double:
                return parseFloat(value);
            default:
                return value;
        }
    }
}

/**
 * Return security and encryption mode supported from server endpoint
 */
function getEndPoints(endpointUrl, manager) {
    return new Promise(function (resolve, reject) {
        if (loadOpcUALib(manager)) {
            let opts = { connectionStrategy: { maxRetry: 1 } };
            let epClient = opcua.OPCUAClient.create(opts);
            try {
                epClient.connect(endpointUrl, function (err) {
                    if (err) {
                        reject('getendpoints-connect-error: ' + err.message);
                    } else {
                        const endpoints = epClient.getEndpoints().then(endpoints => {
                            const reducedEndpoints = endpoints.map(endpoint => ({
                                endpointUrl: endpoint.endpointUrl,
                                securityMode: endpoint.securityMode.toString(),
                                securityPolicy: endpoint.securityPolicyUri.toString(),
                            }));
                            resolve( reducedEndpoints);
                            epClient.disconnect();
                        }, reason => {
                            reject('getendpoints-error: ' + reason);
                            epClient.disconnect();
                        });
                    }
                });
            } catch (err) {
                reject('getendpoints-error: ' + err);
            }
        } else {
            reject('getendpoints-error: node-opcua not found!');
        }
    });
}

function loadOpcUALib(manager) {
    if (!opcua) {
        try { opcua = require('node-opcua'); } catch { }
        if (!opcua && manager) { try { opcua = manager.require('node-opcua'); } catch { } }
    }
    return (opcua) ? true : false;
}

module.exports = {
    init: function (settings) {
        // deviceCloseTimeout = settings.deviceCloseTimeout || 15000;
    },
    create: function (data, logger, events, manager, runtime) {
        if (!loadOpcUALib(manager)) return null;
        return new OpcUAclient(data, logger, events, runtime);
    },
    getEndPoints: getEndPoints
}

function OpcNode(name) {
    this.name = name;
    this.id = '';
    this.class = '';
    this.type = '';
    this.value = '';
    this.timestamp = '';
    this.attribute;
}