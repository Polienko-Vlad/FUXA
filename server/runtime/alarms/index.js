/*
* Alarms manager: check ... and save
*/

'use strict';

const alarmstorage = require('./alarmstorage');
var utils = require('./../utils');

var ALARMS_CHECK_STATUS_INTERVAL = 1000;
var TimeMultiplier	= 1000;		//1000 = rates are in seconds - alpaslanske
const SEPARATOR = '^~^';

function AlarmsManager(_runtime) {
    var runtime = _runtime;
    var devices = runtime.devices;      // Devices to ask variable value
    var events = runtime.events;        // Events to commit change to runtime
    var settings = runtime.settings;    // Settings
    var logger = runtime.logger;        // Logger
    var alarmsCheckStatus = null;       // TimerInterval to check Alarms status
    var alarmsLoading = false;          // Flag to check if loading
    var working = false;                // Working flag to manage overloading of check alarms status
    var alarms = {};                    // Alarms matrix, grupped by variable to check, [variable][...AlarmSubProperty + permission]
    var alarmsProperty = {};            // Alarms property list, key = alarm name + ^~^ + type
    var status = AlarmsStatusEnum.INIT; // Current status (StateMachine)
    var clearAlarms = false;            // Flag to clear current alarms from DB
    var actionsProperty = {};           // Actions property list, key = alarm name + ^~^ + type
    var externalAlarms = {};
    var externalAlarmsHistory = [];
    var externalAlarmsInitialized = false;


    /**
     * Start TimerInterval to check Alarms
     */
    this.start = function () {
        return new Promise(function (resolve, reject) {
            logger.info('alarms check start', true);
            alarmsCheckStatus = setInterval(function () {
                _checkStatus();
            }, ALARMS_CHECK_STATUS_INTERVAL);
        });
    }

    /**
     * Stop StateMachine, break TimerInterval (_checkStatus)
     */
    this.stop = function () {
        return new Promise(function (resolve, reject) {
            logger.info('alarms.stop-checkstatus!', true);
            if (alarmsCheckStatus) {
                clearInterval(alarmsCheckStatus);
                alarmsCheckStatus = null;
                status = AlarmsStatusEnum.INIT;
                working = false;
            }
            resolve();
        });
    }

    this.reset = function () {
        this.clear();
        status = AlarmsStatusEnum.LOAD;
    }

    this.clear = function () {
        clearAlarms = true;
    }

    /**
     * Return the alarms status (active/passive alarms count), { highhigh: <count>, high: <count>, low: <count>, info: <count> }
     */
    this.getAlarmsStatus = function () {
        return new Promise(function (resolve, reject) {
            alarmstorage.getAlarms().then(function (alrs) {
                var result = { highhigh: 0, high: 0, low: 0, info: 0, actions: [] };
                if (alrs) {
                    Object.values(alrs).forEach(alr => {
                        result[alr.type]++;
                        if (alr.type === AlarmsTypes.ACTION && !alr.offtime) {
                            var action = actionsProperty[alr.nametype];
                            if (action.subproperty) {
                                if (action.subproperty.type === ActionsTypes.POPUP || action.subproperty.type === ActionsTypes.SET_VIEW || action.subproperty.type === ActionsTypes.TOAST_MESSAGE) {
                                    result.actions.push({ type: action.subproperty.type, params: action.subproperty.actparam, options: action.subproperty.actoptions });
                                }
                            }
                        }
                    });
                }
                _getExternalAlarmsValues(-1).forEach(alr => {
                    if (alr.type !== AlarmsTypes.ACTION && result[alr.type] !== undefined) {
                        result[alr.type]++;
                    }
                });
                resolve(result);
            }).catch(function (err) {
                reject(err);
            });
        });
    }

    /**
     * Return the current active alarms values
     */
    this.getAlarmsValues = function (filter, permission) {
        var result = [];
        Object.keys(alarms).forEach(alrkey => {
            alarms[alrkey].forEach(alr => {
                if (alr.status && alr.type !== AlarmsTypes.ACTION) {
                    var alritem = { name: alr.getId(), type: alr.type, ontime: alr.ontime, offtime: alr.offtime, acktime: alr.acktime,
                        status: alr.status, text: alr.subproperty.text, group: alr.subproperty.group,
                        bkcolor: alr.subproperty.bkcolor, color: alr.subproperty.color, toack: alr.isToAck(), value: alr.value };
                    var alrPermission = { show: true, enabled: true };
                    if (alr.tagproperty) {
                        alrPermission = runtime.checkPermission(permission, alr.tagproperty);
                    }
                    if (alrPermission.show && (!filter || _filterAlarm(alr.type, alr.subproperty.text, alr.subproperty.group, alr.tagproperty.variableId, filter))) {
                        if (!alrPermission.enabled) {
                            alritem.toack = 0;
                        }
                        result.push(alritem);
                    }
                }
            });
        });
        _getExternalAlarmsValues(permission, filter).forEach(alr => result.push(alr));
        return result;
    }

    this.getAlarmsString = function (type) {
        var result = '';
        Object.keys(alarms).forEach(alrkey => {
            alarms[alrkey].forEach(alr => {
                if (alr.status && alr.type === type && alr.ontime) {
                    var ontime = new Date(alr.ontime);
                    result += `${ontime.toLocaleString()} - ${alr.type} - ${alr.subproperty.text || ''} - ${alr.status} - ${alr.subproperty.group || ''}\n`;
                }
            });
        });
        _getExternalAlarmsValues(-1).forEach(alr => {
            if (alr.status && alr.type === type && alr.ontime) {
                var ontime = new Date(alr.ontime);
                result += `${ontime.toLocaleString()} - ${alr.type} - ${alr.text || ''} - ${alr.status} - ${alr.group || ''}\n`;
            }
        });
        return result;
    }

    /**
     * Return the alarms history
     */
    this.getAlarmsHistory = function (query, permission) {
        return new Promise(function (resolve, reject) {
            var history = [];
            alarmstorage.getAlarmsHistory(query.start, query.end).then(result => {
                for (var i = 0; i < result.length; i++) {
                    var alr = new AlarmHistory(result[i].nametype);
                    alr.status = result[i].status;
                    alr.text = result[i].text;
                    alr.ontime = result[i].ontime;
                    alr.offtime = result[i].offtime;
                    alr.acktime = result[i].acktime;
                    alr.userack = result[i].userack;
                    alr.group = result[i].grp;
                    alr.value = result[i].value;
                    if (alr.ontime) {
                        var alrPermission = { show: true, enabled: true };
                        if (alarmsProperty[alr.name]) {
                            alrPermission = runtime.checkPermission(permission, alarmsProperty[alr.name].property);
                        }
                        if (alrPermission.show) {
                            history.push(alr);
                        }
                    }
                    // add action or defined colors
                    if (alr.type === AlarmsTypes.ACTION) {
                        alr.text = `${alr.name}`;
                        alr.group = `Actions`;
                    } else if (alarmsProperty[alr.name] && alarmsProperty[alr.name][alr.type]) {
                        alr.bkcolor = alarmsProperty[alr.name][alr.type].bkcolor;
                        alr.color = alarmsProperty[alr.name][alr.type].color;
                    }
                }
                resolve(history);
            }).catch(function (err) {
                logger.error('alarms.load-current.failed: ' + err);
                reject(err);
            });
        });
    }

    /**
     * Set Ack to alarm
     * @param {*} alarmName
     * @returns
     */
    this.setAlarmAck = async function (alarmName, userId, permission) {
        var changed = [];
        var authError = false;
        Object.keys(alarms).forEach(alrkey => {
            alarms[alrkey].forEach(alr => {
                if (alarmName === null || alr.getId() === alarmName) {
                    var alrPermission = { show: true, enabled: true };
                    if (alarmsProperty[alr.name]) {
                        alrPermission = runtime.checkPermission(permission, alr.tagproperty);
                    }
                    if (alrPermission.enabled) {
                        if (alr.isToAck() > 0) {
                            alr.setAck(userId);
                            changed.push(alr);
                        }
                    } else {
                        authError = true;
                    }
                }
            });
        });

        var externalToAck = _getExternalAlarmsToAck(alarmName, permission);
        if (externalToAck.authError) {
            authError = true;
        }

        if (authError) {
            throw {code: 401, error:"unauthorized_error", message: "Unauthorized!"};
        }

        if (changed.length) {
            await alarmstorage.setAlarms(changed);
        }

        var externalChanged = false;
        var refreshedExternalDevices = {};
        for (var i = 0; i < externalToAck.items.length; i++) {
            var ext = externalToAck.items[i];
            var result = await devices.setDeviceErrorCommand(ext.deviceId, {
                deviceId: ext.deviceId,
                command: 'accept',
                objectType: ext.objectType,
                objectNumber: ext.objectNumber,
                objectAlarmNumber: ext.objectAlarmNumber
            });
            if (!result) {
                throw new Error(`alarm ack failed for ${ext.name}`);
            }
            var ackTime = Date.now();
            var currentExternal = externalAlarms[ext.name] ? Object.assign({}, externalAlarms[ext.name]) : Object.assign({}, ext);
            currentExternal.status = AlarmStatusEnum.ACK;
            currentExternal.acktime = currentExternal.acktime || ackTime;
            currentExternal.userack = userId || '';
            currentExternal.toack = 0;
            externalAlarms[ext.name] = currentExternal;
            if (externalAlarmsInitialized) {
                _queueExternalAlarmHistory(currentExternal, {
                    status: AlarmStatusEnum.ACK,
                    eventtime: currentExternal.acktime,
                    acktime: currentExternal.acktime,
                    offtime: 0,
                    userack: currentExternal.userack
                });
            }
            externalChanged = true;
            refreshedExternalDevices[ext.deviceId] = true;
        }

        var refreshedExternalDeviceIds = Object.keys(refreshedExternalDevices);
        for (var i = 0; i < refreshedExternalDeviceIds.length; i++) {
            if (devices.getDeviceErrors) {
                await devices.getDeviceErrors(refreshedExternalDeviceIds[i], true);
            }
        }

        if (changed.length || externalChanged) {
            _syncExternalAlarms();
            await _flushExternalAlarmsHistory();
            _emitAlarmsChanged();
        }

        return Boolean(changed.length || externalChanged);
    }

    this.clearAlarms = function (all) {
        return new Promise(function (resolve, reject) {
            alarmstorage.clearAlarms(all).then((result) => {
                resolve(true);
            }).catch(function (err) {
                reject(err);
            });
        });
    }

    /**
     * Clear Alarm history
     */
    this.checkRetention = function () {
        return new Promise(async function (resolve, reject) {
            if (settings.alarms && settings.alarms.retention !== 'none') {
                alarmstorage.clearAlarmsHistory(utils.getRetentionLimit(settings.alarms.retention)).then((result) => {
                    logger.info(`alarms.checkRetention processed`);
                    resolve(true);
                }).catch(function (err) {
                    reject(err);
                });
            } else {
                resolve();
            }
        });
    }

    this.getIdSeparator = () => {
        return SEPARATOR;
    }

    /**
     * Check the Alarms state machine
     */
    var _checkStatus = function () {
        if (status === AlarmsStatusEnum.INIT) {
            if (_checkWorking(true)) {
                _init().then(function () {
                    status = AlarmsStatusEnum.LOAD;
                    _checkWorking(false);
                }).catch(function (err) {
                    // devices.woking = null;
                    _checkWorking(false);
                });
            }
        } else if (status === AlarmsStatusEnum.LOAD) {
            if (_checkWorking(true)) {
                _loadProperty().then(function () {
                    _loadAlarms().then(function () {
                        status = AlarmsStatusEnum.IDLE;
                        _emitAlarmsChanged();
                        _checkWorking(false);
                    }).catch(function (err) {
                        _checkWorking(false);
                    });
                }).catch(function (err) {
                    _checkWorking(false);
                });
            }
        } else if (status === AlarmsStatusEnum.IDLE) {
            if (_checkWorking(true)) {
                _checkAlarms().then(function (changed) {
                    if (changed) {
                        _emitAlarmsChanged(true);
                    }
                    _checkWorking(false);
                }).catch(function (err) {
                    _checkWorking(false);
                });
            }
        }
    }

    /**
     * Check Alarms status
     */
    var _checkAlarms = function () {
        return new Promise(async function (resolve, reject) {
            var time = new Date().getTime();
            var changed = [];
            var externalChanged = _syncExternalAlarms();
            Object.keys(alarms).forEach(alrkey => {
                var groupalarms = alarms[alrkey];
                var tag = devices.getDeviceValue(alarms[alrkey]['variableSource'], alrkey);
                if (tag !== null) {
                    groupalarms.forEach(alr => {
                        var value = _checkBitmask(alr, tag.value);
                        if (alr.check(time, tag.ts, value, tag.value)) {
                            changed.push(alr);
                        }
                    });
                }
            });
            try {
                if (changed.length) {
                    _checkActions(changed);
                    await alarmstorage.setAlarms(changed);
                    changed.forEach(alr => {
                        if (alr.toremove) {
                            alr.init();
                        }
                    });
                }
                var externalHistoryChanged = await _flushExternalAlarmsHistory();
                resolve(Boolean(changed.length || externalChanged || externalHistoryChanged));
            } catch (err) {
                reject(err);
            }
        });
    }

    var _checkBitmask = function(alarm, value) {
        if (alarm.tagproperty.bitmask) {
            return (value & alarm.tagproperty.bitmask) ? 1 : 0;
        }
        return Number(value);
    }

    /**
     * Init Alarm database
     */
    var _init = function () {
        return new Promise(function (resolve, reject) {
            alarmstorage.init(settings, logger).then(result => {
                logger.info('alarms.alarmstorage-init-successful!', true);
                resolve();
            }).catch(function (err) {
                logger.error('project.prjstorage.failed-to-init: ' + err);
                reject(err);
            });
        });
    }

    /**
     * Load Alarms property in local for check
     */
    var _loadProperty = function () {
        return new Promise(function (resolve, reject) {
            alarms = {};
            alarmsProperty = {};
            externalAlarms = {};
            externalAlarmsHistory = [];
            externalAlarmsInitialized = false;
            runtime.project.getAlarms().then(function (result) {
                var alarmsFound = 0;
                if (result) {
                    result.forEach(alr => {
                        if (alr.property && alr.property.variableId) {
                            if (!alarms[alr.property.variableId]) {
                                alarms[alr.property.variableId] = [];
                                var deviceId = devices.getDeviceIdFromTag(alr.property.variableId);
                                if (deviceId) {
                                    // help for a fast get value
                                    alarms[alr.property.variableId]['variableSource'] = deviceId;
                                }
                            }
                            if (_isAlarmEnabled(alr.highhigh)) {
                                var alarm = new Alarm(alr.name, AlarmsTypes.HIGH_HIGH, alr.highhigh, alr.property);
                                alarms[alr.property.variableId].push(alarm);
                                alarmsFound++;
                            }
                            if (_isAlarmEnabled(alr.high)) {
                                var alarm = new Alarm(alr.name, AlarmsTypes.HIGH, alr.high, alr.property);
                                alarms[alr.property.variableId].push(alarm);
                                alarmsFound++;
                            }
                            if (_isAlarmEnabled(alr.low)) {
                                var alarm = new Alarm(alr.name, AlarmsTypes.LOW, alr.low, alr.property);
                                alarms[alr.property.variableId].push(alarm);
                                alarmsFound++;
                            }
                            if (_isAlarmEnabled(alr.info)) {
                                var alarm = new Alarm(alr.name, AlarmsTypes.INFO, alr.info, alr.property);
                                alarms[alr.property.variableId].push(alarm);
                                alarmsFound++;
                            }
                            if (_isAlarmActionsEnabled(alr.actions)) {
                                for (var i = 0; i < alr.actions.values.length; i++) {
                                    if (_isActionsValid(alr.actions.values[i])) {
                                        var alarm = new Alarm(`${alr.name} - ${i}`, AlarmsTypes.ACTION, alr.actions.values[i], alr.property);
                                        alarms[alr.property.variableId].push(alarm);
                                        alarmsFound++;
                                        actionsProperty[alarm.getId()] = alarm;
                                    }

                                }
                            }
                            alarmsProperty[alr.name] = alr;
                        }
                    });
                }
                resolve();
            }).catch(function (err) {
                reject(err);
            });
        });
    }

    /**
     * Load current Alarms and merge with loaded property
     */
    var _loadAlarms = function () {
        return new Promise(function (resolve, reject) {
            if (clearAlarms) {
                alarmstorage.clearAlarms().then(result => {
                    resolve();
                    clearAlarms = false;
                }).catch(function (err) {
                    logger.error('alarms.clear-current.failed: ' + err);
                    reject(err);
                });
            } else {
                alarmstorage.getAlarms().then(result => {
                    Object.keys(alarms).forEach(alrkey => {
                        var groupalarms = alarms[alrkey];
                        groupalarms.forEach(alr => {
                            var alrid = alr.getId();
                            var curalr = result.find(ca => ca.nametype === alrid);
                            if (curalr) {
                                alr.status = curalr.status;
                                alr.ontime = curalr.ontime;
                                alr.offtime = curalr.offtime;
                                alr.acktime = curalr.acktime;
                            }
                        });
                    });
                    resolve();
                }).catch(function (err) {
                    logger.error('alarms.load-current.failed: ' + err);
                    reject(err);
                });
            }
        });
    }

    var _checkActions = function (alarms) {
        for (var i = 0; i < alarms.length; i++) {
            if (alarms[i].type === AlarmsTypes.ACTION && alarms[i].subproperty && !alarms[i].offtime) {
                if (alarms[i].subproperty.type === ActionsTypes.SET_VALUE) {
                    var deviceId = devices.getDeviceIdFromTag(alarms[i].subproperty.variableId);
                    if (deviceId) {
                        devices.setDeviceValue(deviceId, alarms[i].subproperty.variableId, alarms[i].subproperty.actparam);
                    } else {
                        logger.error(`alarms.action.deviceId not found: ${alarms[i].name}`);
                    }
                } else if (alarms[i].subproperty.type === ActionsTypes.RUN_SCRIPT) {
                    const script = {
                        id: alarms[i].subproperty.actparam,
                        name: null,
                        parameters: alarms[i].subproperty.actoptions ? alarms[i].subproperty.actoptions.params : null,
                        notLog: true
                    };
                    try {
                        runtime.scriptsMgr.runScript(script);
                    } catch (error) {
                        runtime.logger.error(`alarm action: script error! ${error.toString()}`);
                    }
                }
            }
        }
    }

    var _checkWorking = function (check) {
        if (check && working) {
            logger.warn('alarms working (check) overload!');
            return false;
        }
        working = check;
        return true;
    }

    var _getExternalAlarmType = function (priority) {
        if (priority < 250) {
            return AlarmsTypes.HIGH_HIGH;
        }
        if (priority < 500) {
            return AlarmsTypes.HIGH;
        }
        if (priority < 750) {
            return AlarmsTypes.LOW;
        }
        return AlarmsTypes.INFO;
    }

    var _getExternalAlarmStatus = function (state) {
        if (state === 1) {
            return AlarmStatusEnum.ON;
        }
        if (state === 2) {
            return AlarmStatusEnum.OFF;
        }
        if (state === 3) {
            return AlarmStatusEnum.ACK;
        }
        return AlarmStatusEnum.VOID;
    }

    var _getExternalAlarmPermission = function (permission, deviceId) {
        try {
            var allDevices = runtime.project.getDevices();
            var device = allDevices ? allDevices[deviceId] : null;
            return runtime.checkPermission(permission, device ? device.property : null);
        } catch (error) {
            return { show: true, enabled: true };
        }
    }

    var _getExternalAlarmDeviceProperty = function (deviceId) {
        try {
            var allDevices = runtime.project.getDevices();
            var device = allDevices ? allDevices[deviceId] : null;
            return device ? device.property : null;
        } catch (error) {
            return null;
        }
    }

    var _normalizeExternalAlarmGroup = function (group, type) {
        var normalized = String(group || '').trim().toLowerCase();
        if (normalized.indexOf('сообщ') !== -1 || normalized.indexOf('message') !== -1) {
            return 'message';
        }
        if (normalized.indexOf('ответ') !== -1 || normalized.indexOf('answer') !== -1) {
            return 'answer';
        }
        if (normalized.indexOf('трев') !== -1 || normalized.indexOf('alarm') !== -1) {
            return 'alarm';
        }
        if (type === AlarmsTypes.INFO) {
            return 'message';
        }
        return 'alarm';
    }

    var _getExternalAlarmStyleValue = function (style, key) {
        if (!style || style[key] === undefined || style[key] === null || style[key] === '') {
            return undefined;
        }
        return style[key];
    }

    var _getExternalAlarmStyle = function (deviceId, group, type) {
        var property = _getExternalAlarmDeviceProperty(deviceId);
        var alarms = property && property.alarms ? property.alarms : null;
        var groupKey = _normalizeExternalAlarmGroup(group, type);
        var groupStyle = alarms && alarms[groupKey] ? alarms[groupKey] : null;
        var message = alarms && alarms.message ? alarms.message : null;
        return {
            color: _getExternalAlarmStyleValue(groupStyle, 'color') || _getExternalAlarmStyleValue(message, 'color'),
            bkcolor: _getExternalAlarmStyleValue(groupStyle, 'bkcolor')
        };
    }

    var _isExternalConnectionAlarm = function (alarm) {
        return String(alarm && alarm.group || '').trim().toLowerCase() === 'connection';
    }

    var _getExternalAlarmRecoveryText = function (alarm) {
        if (_isExternalConnectionAlarm(alarm)) {
            var deviceName = alarm && (alarm.deviceName || alarm.deviceId || alarm.text || 'Device');
            return `${deviceName} connection restored`;
        }
        return alarm && alarm.text ? alarm.text : '';
    }

    var _createExternalAlarmStorageItem = function (alarm, options) {
        var source = Object.assign({}, alarm, options);
        var alarmId = source.name;
        return {
            type: source.type,
            status: source.status,
            ontime: source.eventtime || source.ontime || source.offtime || source.acktime || Date.now(),
            offtime: source.offtime || 0,
            acktime: source.acktime || 0,
            userack: source.userack || '',
            historyOnly: true,
            subproperty: {
                text: source.text || '',
                group: source.group || ''
            },
            getId: function () {
                return alarmId;
            }
        };
    }

    var _queueExternalAlarmHistory = function (alarm, options) {
        var status = options && options.status !== undefined ? options.status : alarm.status;
        var eventTime = options && options.eventtime !== undefined ? options.eventtime : (status === AlarmStatusEnum.ACK ? (alarm.acktime || Date.now()) : (status === AlarmStatusEnum.OFF ? (alarm.offtime || Date.now()) : (alarm.ontime || Date.now())));
        externalAlarmsHistory.push(_createExternalAlarmStorageItem(alarm, Object.assign({
            status: status,
            eventtime: eventTime,
            ontime: eventTime,
            offtime: status === AlarmStatusEnum.OFF ? (alarm.offtime || eventTime) : 0,
            acktime: status === AlarmStatusEnum.ACK ? (alarm.acktime || eventTime) : 0,
            userack: status === AlarmStatusEnum.ACK ? (alarm.userack || '') : (alarm.userack || '')
        }, options)));
    }

    var _flushExternalAlarmsHistory = async function () {
        if (!externalAlarmsHistory.length) {
            return false;
        }
        var pending = externalAlarmsHistory.splice(0, externalAlarmsHistory.length);
        try {
            await alarmstorage.setAlarms(pending);
            return pending.length > 0;
        } catch (error) {
            externalAlarmsHistory = pending.concat(externalAlarmsHistory);
            throw error;
        }
    }

    var _syncExternalAlarms = function () {
        var snapshot = devices.getDevicesErrorsSnapshot ? devices.getDevicesErrorsSnapshot() : [];
        var seen = {};
        var changed = false;
        var now = Date.now();
        var shouldLogHistory = externalAlarmsInitialized;

        snapshot.forEach(error => {
            if (!error || !error.id) {
                return;
            }
            var type = _getExternalAlarmType(error.priority);
            var alarmId = `${error.id}${SEPARATOR}${type}`;
            var status = _getExternalAlarmStatus(error.state);
            if (!status) {
                return;
            }

            seen[alarmId] = true;
            var previous = externalAlarms[alarmId];
            var record = previous ? Object.assign({}, previous) : {
                name: alarmId,
                deviceId: error.deviceId,
                deviceName: error.deviceName || '',
                objectType: error.objectType,
                objectNumber: error.objectNumber,
                objectAlarmNumber: error.objectAlarmNumber,
                ontime: now,
                offtime: 0,
                acktime: 0,
                userack: ''
            };

            record.type = type;
            record.status = status;
            record.deviceName = error.deviceName || record.deviceName || '';
            record.text = error.description || error.deviceName || error.id;
            record.group = error.group || '';
            record.suppress = Boolean(error.suppress);
            record.toack = record.suppress ? 0 : ((status === AlarmStatusEnum.ON || status === AlarmStatusEnum.OFF) ? 1 : 0);
            var style = _getExternalAlarmStyle(error.deviceId, record.group, record.type);
            record.color = style.color;
            record.bkcolor = style.bkcolor;

            if (!previous || previous.status !== status) {
                changed = true;
                if (status === AlarmStatusEnum.ON) {
                    record.ontime = now;
                    record.offtime = 0;
                    record.acktime = 0;
                    record.userack = '';
                } else if (status === AlarmStatusEnum.OFF) {
                    record.offtime = previous && previous.offtime ? previous.offtime : now;
                } else if (status === AlarmStatusEnum.ACK) {
                    record.acktime = previous && previous.acktime ? previous.acktime : now;
                }
                if (shouldLogHistory) {
                    _queueExternalAlarmHistory(record, {
                        status: status,
                        eventtime: status === AlarmStatusEnum.ACK ? record.acktime : (status === AlarmStatusEnum.OFF ? record.offtime : record.ontime)
                    });
                }
            }

            if (previous && (previous.text !== record.text || previous.group !== record.group || previous.suppress !== record.suppress || previous.toack !== record.toack || previous.color !== record.color || previous.bkcolor !== record.bkcolor)) {
                changed = true;
            }

            externalAlarms[alarmId] = record;
        });

        Object.keys(externalAlarms).forEach(alarmId => {
            if (!seen[alarmId]) {
                var removedAlarm = externalAlarms[alarmId];
                if (shouldLogHistory && removedAlarm && removedAlarm.status !== AlarmStatusEnum.OFF) {
                    removedAlarm = Object.assign({}, removedAlarm, {
                        status: AlarmStatusEnum.OFF,
                        offtime: removedAlarm.offtime || now,
                        text: _getExternalAlarmRecoveryText(removedAlarm)
                    });
                    _queueExternalAlarmHistory(removedAlarm, {
                        status: AlarmStatusEnum.OFF,
                        eventtime: removedAlarm.offtime,
                        text: removedAlarm.text
                    });
                }
                delete externalAlarms[alarmId];
                changed = true;
            }
        });

        externalAlarmsInitialized = true;

        return changed;
    }

    var _getExternalAlarmsValues = function (permission, filter) {
        var result = [];
        _syncExternalAlarms();
        if (filter && filter.tagIds && filter.tagIds.length) {
            return result;
        }
        Object.keys(externalAlarms).forEach(alarmId => {
            var alr = externalAlarms[alarmId];
            var alrPermission = _getExternalAlarmPermission(permission, alr.deviceId);
            if (alrPermission.show && (!filter || _filterAlarm(alr.type, alr.text, alr.group, null, filter))) {
                result.push({
                    name: alr.name,
                    type: alr.type,
                    ontime: alr.ontime,
                    offtime: alr.offtime,
                    acktime: alr.acktime,
                    status: alr.status,
                    text: alr.text,
                    group: alr.group,
                    bkcolor: alr.bkcolor,
                    color: alr.color,
                    toack: alrPermission.enabled ? alr.toack : 0
                });
            }
        });
        return result;
    }

    var _getExternalAlarmsToAck = function (alarmName, permission) {
        var result = { items: [], authError: false };
        _syncExternalAlarms();
        Object.keys(externalAlarms).forEach(alarmId => {
            var alr = externalAlarms[alarmId];
            if (alarmName === null || alarmId === alarmName) {
                var alrPermission = _getExternalAlarmPermission(permission, alr.deviceId);
                if (!alrPermission.enabled) {
                    result.authError = true;
                } else if (alr.toack > 0) {
                    result.items.push(alr);
                }
            }
        });
        return result;
    }

    var _isAlarmEnabled = function (alarm) {
        if (alarm && alarm.enabled && alarm.checkdelay > 0 && utils.isValidRange(alarm.min, alarm.max)) {
            return true;
        }
        return false;
    }

    var _isAlarmActionsEnabled = function (alarm) {
        if (alarm && alarm.enabled && alarm.values && alarm.values.length > 0) {
            return true;
        }
        return false;
    }

    var _isActionsValid = function (action) {
        if (action && action.checkdelay > 0 && utils.isValidRange(action.min, action.max)) {
            return true;
        }
        return false;
    }

    var _emitAlarmsChanged = function () {
        events.emit('alarms-status:changed');
    }

    var _filterAlarm = function (alarmType, alarmText, alarmGroup, alarmTagId, filter) {
        var available = true;
        if (filter) {
            if (filter.priority && filter.priority.length && filter.priority.indexOf(alarmType) === -1) {
                available = false;
            } else if (filter.text && (!alarmText || alarmText.toLowerCase().indexOf(filter.text.toLowerCase()) === -1)) {
                available = false;
            } else if (filter.group && (!alarmGroup || alarmGroup.toLowerCase().indexOf(filter.group.toLowerCase()) === -1)) {
                available = false;
            } else if (filter.tagIds && filter.tagIds.length && alarmTagId && filter.tagIds.indexOf(alarmTagId) === -1) {
                available = false;
            }
        }
        return available;
    }

    var _formatDateTime = function (dt) {
        var dt = new Date(dt);
        return dt.toLocaleDateString() + '-' + dt.toLocaleTimeString();
    }
}

module.exports = {
    create: function (runtime) {
        return new AlarmsManager(runtime);
    }
}

/**
 * State of StateMachine
 */
var AlarmsStatusEnum = {
    INIT: 'init',
    LOAD: 'load',
    IDLE: 'idle',
}

function Alarm(name, type, subprop, tagprop) {
    this.name = name;
    this.type = type;
    this.subproperty = subprop;
    this.tagproperty = tagprop;
    this.ontime = 0;
    this.offtime = 0;
    this.acktime = 0;
    this.status = AlarmStatusEnum.VOID;
    this.lastcheck = 0;
    this.toremove = false;
    this.userack;
    this.value;

    this.getId = function () {
        return this.name + '^~^' + this.type;
    }

    this.check = function (time, dt, value, displayValue) {
        if (this.lastcheck + (this.subproperty.checkdelay * TimeMultiplier) > time) {
            return false;
        }
        this.lastcheck = time;
        this.toremove = false;
        var onrange = (value >= this.subproperty.min && value <= this.subproperty.max);
        switch(this.status) {
            case AlarmStatusEnum.VOID:
                //  check to activate
                if (!onrange) {
                    this.ontime = 0;
                    return false;
                } else if (!this.ontime) {
                    this.ontime = dt;
                    return false;
                }
                if (this.ontime + (this.subproperty.timedelay * TimeMultiplier) <= time) {
                    this.status = AlarmStatusEnum.ON;
                    this.value = displayValue;
                    return true;
                }
            case AlarmStatusEnum.ON:
                // check to deactivate
                if (!onrange) {
                    this.status = AlarmStatusEnum.OFF;
					if (this.offtime == 0) {
						this.offtime = time;
					}
                    // remove if float or already acknowledged
                    if (this.subproperty.ackmode === AlarmAckModeEnum.float || this.acktime) {
                        this.toRemove();
                    }
                    return true;
                }
                if (this.acktime) {
                    this.status = AlarmStatusEnum.ACK;
                    return true;
                }
                return false;
            case AlarmStatusEnum.OFF:
                // check to reactivate
                if (onrange) {
                    this.status = AlarmStatusEnum.ON;
                    this.acktime = 0;
					this.offtime = 0;
                    this.ontime = time;
                    this.userack = '';
                    this.value = displayValue;
                    return true;
                }
                // remove if acknowledged
                if (this.acktime || this.type === AlarmsTypes.ACTION) {
                    this.toRemove();
                    return true;
                }
                return false;
            case AlarmStatusEnum.ACK:
                // remove if deactivate
                if (!onrange) {
					if (this.offtime == 0) {
						this.offtime = time;
					}
                    this.status = AlarmStatusEnum.ON;
                    return true;
                }
                return false;
        }
    }

    this.init = function () {
        this.toremove = false;
        this.ontime = 0;
        this.offtime = 0;
        this.acktime = 0;
        this.status = AlarmStatusEnum.VOID;
        this.lastcheck = 0;
        this.userack = '';
        this.value = undefined;
    }

    this.toRemove = function () {
        this.toremove = true;
    }

    this.setAck = function (user) {
        if (!this.acktime) {
            this.acktime = new Date().getTime();
            this.lastcheck = 0;
            this.userack = user;
        }
    }

    this.isToAck = function () {
        if (this.subproperty.ackmode === AlarmAckModeEnum.float) {
            return -1;
        }
        if (this.subproperty.ackmode === AlarmAckModeEnum.ackpassive && this.status === AlarmStatusEnum.OFF) {
            return 1;
        }
        if (this.subproperty.ackmode === AlarmAckModeEnum.ackactive && (this.status === AlarmStatusEnum.OFF || this.status === AlarmStatusEnum.ON)) {
            return 1;
        }
        return 0;
    }
}

function AlarmHistory(id) {
    this.name;
    this.type;
    this.laststatus;
    this.alarmtext;
    this.ontime = 0;
    this.offtime = 0;
    this.acktime = 0;
    this.userack;

    var ids = id.split('^~^');
    this.name = ids[0];
    this.type = ids[1];
}

var AlarmStatusEnum = {
    VOID: '',
    ON: 'N',
    OFF: 'NF',
    ACK: 'NA'
}

var AlarmAckModeEnum = {
    float: 'float',
    ackactive: 'ackactive',
    ackpassive: 'ackpassive'
}

const AlarmsTypes = {
    HIGH_HIGH: 'highhigh',
    HIGH: 'high',
    LOW: 'low',
    INFO: 'info',
    ACTION: 'action'
}

const ActionsTypes = {
    POPUP: 'popup',
    SET_VALUE: 'setValue',
    SET_VIEW: 'setView',
    SEND_MSG: 'sendMsg',
    TOAST_MESSAGE: 'toastMessage',
    RUN_SCRIPT: 'runScript'
}
