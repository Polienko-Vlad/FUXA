/**
 * Module to manage the events in a database
 * Table: 'events'
 */

'use strict';

const fs = require('fs');
const path = require('path');
var sqlite3 = require('sqlite3').verbose();

var settings        // Application settings
var logger;         // Application logger
var db_events;      // Database of events

function _run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db_events.run(sql, params, function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(this);
            }
        });
    });
}

/**
 * Init and bind the database resource
 * @param {*} _settings 
 * @param {*} _log 
 */
function init(_settings, _log) {
    settings = _settings;
    logger = _log;

    return _bind();
}

/**
 * Bind the database resource by create the table if not exist
 */
function _bind() {
    return new Promise(function (resolve, reject) {
        if (settings.dbDir && !fs.existsSync(settings.dbDir)) {
            fs.mkdirSync(settings.dbDir, { recursive: true });
        }
        var dbfile = path.join(settings.dbDir || settings.workDir, 'events.fuxap.db');
        var dbfileExist = fs.existsSync(dbfile);

        db_events = new sqlite3.Database(dbfile, function (err) {
            if (err) {
                logger.error('eventstorage.failed-to-bind: ' + err);
                reject();
            }
            logger.info('eventstorage.connected-to ' + dbfile + ' database.', true);
        });
        // prepare query
        var sql = "CREATE TABLE if not exists events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, type TEXT, category TEXT, user TEXT, message TEXT, details TEXT);";
        db_events.exec(sql, function (err) {
            if (err) {
                logger.error('eventstorage.failed-to-bind: ' + err);
                reject();
            } else {
                resolve(dbfileExist);
            }
        });
    });
}

/**
 * Add event to database
 * @param {*} event 
 */
function addEvent(event) {
    return new Promise(function (resolve, reject) {
        if (!db_events) {
            reject(false);
        } else {
            var sql = "INSERT INTO events (timestamp, type, category, user, message, details) VALUES (?, ?, ?, ?, ?, ?)";
            db_events.run(sql, [event.timestamp || Date.now(), event.type, event.category || '', event.user || '', event.message || '', JSON.stringify(event.details || {})], function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
        }
    });
}

/**
 * Return the events list
 * @param {*} from 
 * @param {*} to 
 * @param {*} filter 
 */
function getEvents(from, to, filter, userFilter) {
    return new Promise(function (resolve, reject) {
        if (!db_events) {
            reject(false);
        } else {
            var start = from || 0;
            var end = to || Number.MAX_SAFE_INTEGER;
            var sql = "SELECT * FROM events WHERE timestamp BETWEEN ? and ?";
            var params = [start, end];
            if (filter) {
                sql += " AND (type LIKE ? OR message LIKE ? OR details LIKE ? OR user LIKE ?)";
                var likeFilter = '%' + filter + '%';
                params.push(likeFilter, likeFilter, likeFilter, likeFilter);
            }
            if (userFilter) {
                sql += " AND user LIKE ?";
                params.push('%' + userFilter + '%');
            }
            sql += " ORDER BY timestamp DESC";
            db_events.all(sql, params, function (err, rows) {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        }
    });
}

/**
 * Clear events history
 * @param {*} dtlimit 
 */
function clearEventsHistory(dtlimit) {
    return new Promise(function (resolve, reject) {
        if (!db_events) {
            reject(false);
        } else {
            var sql = "DELETE FROM events WHERE timestamp < ?";
            db_events.run(sql, [dtlimit.getTime()], function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        }
    });
}

/**
 * Close database
 */
function close() {
    if (db_events) {
        db_events.close();
    }
}

module.exports = {
    init: init,
    addEvent: addEvent,
    getEvents: getEvents,
    clearEventsHistory: clearEventsHistory,
    close: close
};
