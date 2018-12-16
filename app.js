var http = require('http');
var config = require('./config/config');
var SerialPort = require('serialport');
var CronJob = require('cron').CronJob;
var logger = require('./logger/logger');
var df = require('./dateFactory/dateFactory');
var APIRequest = require('./httpRequest/apiRequest');

//SERVER INIT
var server = http.createServer();
var apiReq = new APIRequest(http, 'localhost', '/activapi.fr/api/');
var io = require('socket.io').listen(server);

//CRONJOBS
var logRefreshCronJob = new CronJob('0 */30 * * * *', () => {
    apiReq.get('thermostat/log/refresh');
}, null, true, 'Europe/Paris');

var rtcUpdateThermostatCronJob = new CronJob('0 5 0 * * *', () => {
    updateThermostatRtc();
}, null, true, 'Europe/Paris');

var rtcUpdateAquariumCronJob = new CronJob('0 6 0 * * *', () => {
    updateAquariumClock();
}, null, true, 'Europe/Paris');

//GLOBAL VARS
var capteurs = [];
var thermostats = [];

//SOCKETIO LISTENERS
io.sockets.on('connection', socket => {

    var clientIp = socket.request.connection.remoteAddress;
    logger.log('New connection from ' + clientIp);

    apiReq.get('actionneurs/', (res) => {
        res.setEncoding('utf8');
        var rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
            actionneurs = JSON.parse(rawData);
        });
    }).get('mesures/get-sensors', (res) => {
        res.setEncoding('utf8');
        var rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
            capteurs = JSON.parse(rawData);
        });
    }).get('thermostat', (res) => {
        res.setEncoding('utf8');
        var rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
            thermostats = JSON.parse(rawData);
        });
    });

    socket.on('messageAll', message => {
        logger.log('messageAll From : ' + clientIp + ' ' + message);
        socket.broadcast.emit("message", message);
    }).on('command', message => {
        writeAndDrain(message, () => {
        });
    }).on('updateDimmer', dimmerObject => {
        updateDimmer(dimmerObject, socket, false);
    }).on('updateDimmerPersist', dimmerObject => {
        updateDimmerPersist(dimmerObject, socket);
    }).on('updateInter', interObject => {
        updateInter(interObject, socket);
    }).on("updateScenario", scenario => {
        updateScenario(scenario, socket);
    }).on("updateTherCons", thermostat => {
        updateThermostat(thermostat, socket, "cons");
    }).on("updateTherDelta", thermostat => {
        updateThermostat(thermostat, socket, "delta");
    }).on("updateTherTempext", thermostat => {
        updateThermostat(thermostat, socket, "temp");
    }).on("updateTherInterne", thermostat => {
        updateThermostat(thermostat, socket, "int");
    }).on("updateTherMode", id => {
        updateThermostatMode(id);
    }).on("syncTherModes", id => {
        syncThermostatModes();
    }).on("updateTherPlan", id => {
        updateThermostatPlan(id);
    }).on("refreshTher", () => {
        refreshThermostat();
    }).on("updateTherClock", id => {
        updateThermostatRtc();
    }).on("getTherClock", id => {
        getThermostatClock();
    }).on("updateAquaClock", id => {
        updateAquariumClock();
    }).on("getAquaClock", id => {
        getAquariumClock();
    }).on('disconnect', () => {
        let clientIp = socket.request.connection.remoteAddress;
        logger.log(clientIp + ' Disconnected');
    });
});
server.listen(5901);

var port = new SerialPort(config.portPath, {
    baudRate: 9600
});

port.on('open', () => {
    logger.log("port " + config.portPath + " opened");
}).on('error', err => {
    logger.log(err.message);
}).on('close', () => {
    logger.log("port " + config.portPath + " closed");
}).on('data', data => {
    let datastr = data.toString();
    if (!datastr || /^\s*$/.test(datastr)) {
        return;
    }
    datastr = datastr.replace(/[\n\r]+/g, '');
    let dataTab = datastr.split(" ");
    let dataObj = {
        'radioid': dataTab[0],
        'valeur1': dataTab[1],
        'valeur2': dataTab[2],
        'valeur3': dataTab[3],
        'valeur4': dataTab[4],
        'valeur5': dataTab[5]
    };
    if (dataObj.radioid.includes("sensor")) {
        persistSensor(dataTab, dataObj);
    }
    if (dataObj.radioid.includes("thermostat") || dataObj.radioid.includes("thersel")) {
        persistThermostat(dataObj);
    }
    if (dataObj.radioid.includes("message")) {
        if (dataObj.valeur1.includes("tht")) {
            if (dataObj.valeur2.includes("spok")) {
                io.sockets.emit("therplansave", "OK");
            }
        }
    }
    if (dataObj.radioid.includes("therclock")) {
        let therclockStr = dataObj.valeur1 + " " + dataObj.valeur2;
        io.sockets.emit("therclock", therclockStr);
    }

    let fullHour = df.stringifiedHour();
    io.sockets.emit("messageConsole", fullHour + " " + datastr);
    logger.log(datastr);
});

function updateActionneur(actionneur, socket) {
    if (actionneur.categorie.includes("inter")) {
        updateInter(actionneur, socket);
    }
    if (actionneur.categorie.includes("dimmer")) {
        updateDimmerPersist(actionneur, socket);
    }
}

function updateDimmer(dimmerObject, socket, fromPersist) {
    if (dimmerObject.etat < 0 || dimmerObject.etat > 255) {
        logger.log('In updateDimmer : value must be between 0 and 255');
        return;
    }

    var commande = [dimmerObject.module,
        dimmerObject.radioid,
        dimmerObject.etat
    ].join('/') + '/';
    writeAndDrain(commande + '/', () => {
        if (!fromPersist) {
            socket.broadcast.emit('dimmer', dimmerObject);
            return;
        }
        io.sockets.emit('dimmer', dimmerObject);
    });
}

function updateDimmerPersist(dimmerObject, socket) {
    if (typeof (dimmerObject) === 'string') {
        dimmerObject = JSON.parse(dimmerObject);
    }

    if (dimmerObject.etat < 0 || dimmerObject.etat > 255) {
        logger.log('In updateDimmerPersist : value must be between 0 and 255');
        return;
    }

    updateDimmer(dimmerObject, socket, true);
    apiReq.post('actionneurs/update', dimmerObject);
    logger.log(dimmerObject.nom + ' ' + dimmerObject.etat);
    io.sockets.emit("messageConsole", df.stringifiedHour() + " " + dimmerObject.nom + ' ' + dimmerObject.etat);
}

function updateInter(interObject, socket) {
    if (interObject.etat < 0 || interObject.etat > 1) {
        logger.log('In updateInter : value must be 0 or 1');
    }

    if (typeof (interObject) === 'string') {
        interObject = JSON.parse(interObject);
    }

    let command = getInterCommand(interObject);
    if (command === false) {
        logger.log("Unknown Actuator type " + interObject.type);
        return;
    }

    writeAndDrain(command + '/', () => {
        logger.log("update" + interObject.type + " " + interObject.nom);
        io.sockets.emit("messageConsole", df.stringifiedHour() + " " + interObject.nom + ' ' + interObject.etat);
        io.sockets.emit('inter', interObject);
        apiReq.post('actionneurs/update', interObject);
    });
}

function getInterCommand(interObject) {
    switch (interObject.type) {
        case "relay":
            return [interObject.module,
                interObject.protocole,
                interObject.adresse,
                interObject.radioid,
                interObject.etat
            ].join('/');
        case "aqua":
            return [interObject.module,
                interObject.protocole,
                interObject.adresse,
                interObject.type,
                "set", "leds"
            ].join('/');
        default:
            return false;
    }
}

var lastCall = new Date().getTime();

function updateScenario(scenario, socket) {
    var now = new Date().getTime();
    var diff = now - lastCall;
    if (diff <= 2000) {
        logger.log("Please wait before two scenarios calls");
        return;
    }

    if (typeof (scenario) === "undefined") {
        logger.log("malformed scenario = " + scenario);
        return
    }

    if (typeof (scenario) === 'string') {
        scenario = JSON.parse(scenario);
    }

    var time = 0;
    io.sockets.emit("messageConsole", df.stringifiedHour() + 'updateScenario ' + scenario.nom);
    logger.log('updateScenario ' + scenario.nom);
    var items = [];
    for (var idx in scenario.data) {
        items.push(scenario.data[idx]);
    }
    items.forEach(val => {
        setTimeout(() => {
            updateActionneur(val, socket);
        }, time * 500);
        time++;
    });
    lastCall = new Date().getTime();
}

function updateThermostat(thermostat, socket, part) {

    if (typeof (thermostat) !== 'string' || !part.includes("cons")) {
        logger.log("given value is null");
        return;
    }

    thermostat = JSON.parse(thermostat);
    var val = thermostat.consigne;
    var commande = ["nrf24", "node", "2Nodw", "ther", "set", part, val].join('/');
    writeAndDrain(commande + '/', () => {
    });
}

function updateThermostatRtc() {
    var date = new Date();
    var d = date.getDate();
    var m = date.getMonth() + 1;
    var y = date.getFullYear();
    var h = date.getHours();
    var i = date.getMinutes();
    var s = date.getSeconds();
    var commande = ["nrf24", "node", "2Nodw", "ther", "put", "rtc", y, m, d, h, i, s].join('/');
    writeAndDrain(commande + '/', () => {
    });
}

function getThermostatClock() {
    var commande = ["nrf24", "node", "2Nodw", "ther", "get", "rtc"].join('/');
    writeAndDrain(commande + '/', () => {
    });
}

function updateAquariumClock() {
    var date = new Date();
    var d = date.getDate();
    var m = date.getMonth() + 1;
    var y = date.getFullYear();
    var h = date.getHours();
    var i = date.getMinutes();
    var s = date.getSeconds();
    var commande = ["nrf24", "node", "3Nodw", "aqua", "put", "rtc", y, m, d, h, i, s].join('/');
    writeAndDrain(commande + '/', () => {
    });
}

function getAquariumClock() {
    var commande = ["nrf24", "node", "3Nodw", "aqua", "get", "rtc"].join('/');
    writeAndDrain(commande + '/', () => {
    });
}

function refreshThermostat() {
    var commande = ["nrf24", "node", "2Nodw", "ther", "get", "info"].join('/');
    writeAndDrain(commande + '/', () => {
    });
}

function persistThermostat(dataObj) {
    apiReq.get('thermostat', (res) => {
        res.setEncoding('utf8');
        var rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
            thermostats = JSON.parse(rawData);
            thermostats.forEach((thermostat, index) => {
                if (dataObj.radioid.includes("thermostat")) {
                    thermostat.consigne = dataObj.valeur1;
                    thermostat.delta = dataObj.valeur2;
                    thermostat.interne = dataObj.valeur4;
                    thermostat.etat = dataObj.valeur5;
                    io.sockets.emit('thermostat', thermostat);
                }

                if (dataObj.radioid.includes("thersel")) {
                    thermostat.modeid = dataObj.valeur1;
                    thermostat.planning = dataObj.valeur2;
                    io.sockets.emit('thersel', thermostat);
                }
                delete thermostat.sensor;
                delete thermostat.mode;
                apiReq.post('thermostat/update', thermostat);
            });
        });
    });
}

function updateThermostatMode(id) {

    if (id === null || id <= 0 || id >= 254) {
        logger.log("given value is null or out of bounds");
    }

    apiReq.get("thermostat/mode/" + parseInt(id, 10), (res) => {
        res.setEncoding('utf8');
        var rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
            var mode = JSON.parse(rawData);
            var commande = ["nrf24", "node", "2Nodw", "ther", "sel", "mode", mode.id].join('/');
            writeAndDrain(commande + '/', () => {
            });
        });
    });
}

function syncThermostatModes() {
    var time = 0;
    apiReq.get("thermostat/mode/", (res) => {
        res.setEncoding('utf8');
        var rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
            var modes = objToArray(JSON.parse(rawData));
            modes.forEach(mode => {
                setTimeout(() => {
                    var commande = ["nrf24", "node", "2Nodw", "ther", "put", "mode", mode.id, mode.consigne, mode.delta].join('/');
                    writeAndDrain(commande + '/', () => {
                    });
                }, time * 200);
                time++;
            });
        });
    });
}

function objToArray(obj) {
    var objArray = [];
    for (var idx in obj) {
        objArray.push(obj[idx]);
    }
    return objArray;
}

function updateThermostatPlan(id) {
    var time = 0;

    if (id === null || id < 0 || id >= 254) {
        logger.log("given value is null or out of bounds");
        return;
    }

    if (id === 0) {
        var commande = ["nrf24", "node", "2Nodw", "ther", "set", "plan", id].join('/');
        writeAndDrain(commande + '/', () => {
        });
        return;
    }

    apiReq.get("thermostat/planif/" + parseInt(id, 10), (res) => {
        res.setEncoding('utf8');
        var rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
            var plans = objToArray(JSON.parse(rawData));
            var com = ["nrf24", "node", "2Nodw", "ther", "set", "plan", parseInt(id)].join('/');
            writeAndDrain(com + '/', () => {
            });

            setTimeout(() => {
                plans.forEach(plan => {
                    setTimeout(() => {
                        h1Start = plan.heure1Start;
                        h1Stop = plan.heure1Stop;
                        h2Start = plan.heure2Start;
                        h2Stop = plan.heure2Stop;
                        if (plan.heure1Start === null || plan.heure1Start === "") h1Start = "XX:XX";
                        if (plan.heure1Stop === null || plan.heure1Stop === "") h1Stop = "XX:XX";
                        if (plan.heure2Start === null || plan.heure2Start === "") h2Start = "XX:XX";
                        if (plan.heure2Stop === null || plan.heure2Stop === "") h2Stop = "XX:XX";
                        var commande = ["nrf24", "node", "2Nodw", "ther", "put", "plan",
                            plan.jour, plan.modeid, plan.defaultModeid,
                            h1Start, h1Stop, h2Start, h2Stop
                        ].join('/');
                        writeAndDrain(commande + '/', () => {
                        });

                        if (parseInt(plan.jour) < 7) {
                            return;
                        }

                        setTimeout(() => {
                            commande = ["nrf24", "node", "2Nodw", "ther", "save", "plan"].join('/');
                            writeAndDrain(commande + '/', () => {
                                logger.log("savePlan " + plan.jour);
                                plan.jour = 0;
                            });
                        }, 200);

                    }, time * 120);
                    time++;
                });
            }, 500);
        });
    });
}

function persistSensor(dataTab, dataObj) {
    var uri = 'mesures/add-' + dataObj.radioid + '-' + dataObj.valeur1;
    if (dataTab.length > 2) uri += '-' + dataObj.valeur2;
    apiReq.get(uri);
    capteurs.forEach((capteur, index) => {
        if (capteur.radioid !== dataObj.radioid) {
            return;
        }
        capteur.valeur1 = dataObj.valeur1;
        capteur.valeur2 = dataObj.valeur2;
        if (undefined === capteur.valeur2) {
            capteur.valeur2 = "";
        }
        capteur.releve = df.nowDatetime();
        capteur.actif = 1;
        if (dataObj.radioid.includes("ctn10") ||
            dataObj.radioid.includes("dht11")) {
            io.sockets.emit('thermo', capteur);
            return;
        }
        if (dataObj.radioid.includes("tinfo")) {
            io.sockets.emit('teleinfo', capteur);
            return;
        }
        if (dataObj.radioid.includes("therm")) {
            io.sockets.emit('chaudiere', capteur);
        }
    });
}

function writeAndDrain(data, callback) {
    port.write(data, () => {
    });
    port.drain(callback);
}
