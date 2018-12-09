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
var logRefreshCronJob = new CronJob('0 */30 * * * *', function () {
    apiReq.get('thermostat/log/refresh');
}, null, true, 'Europe/Paris');

var rtcUpdateThermostatCronJob = new CronJob('0 5 0 * * *', function () {
    updateThermostatRtc();
}, null, true, 'Europe/Paris');

var rtcUpdateAquariumCronJob = new CronJob('0 6 0 * * *', function () {
    updateAquariumClock();
}, null, true, 'Europe/Paris');

//GLOBAL VARS
var capteurs = [];
var thermostats = [];

//SOCKETIO LISTENERS
io.sockets.on('connection', function (socket) {

    var clientIp = socket.request.connection.remoteAddress;
    logger.logToFile(config.rootPath + config.logPath, 'New connection from ' + clientIp, true);

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

    socket.on('messageAll', function (message) {
        logger.logToFile(config.rootPath + config.logPath, 'messageAll From : ' + clientIp + ' ' + message, true);
        socket.broadcast.emit("message", message);
    }).on('command', function (message) {
        writeAndDrain(message, function () {
        });
    }).on('updateDimmer', function (dimmerObject) {
        updateDimmer(dimmerObject, socket, false);
    }).on('updateDimmerPersist', function (dimmerObject) {
        updateDimmerPersist(dimmerObject, socket);
    }).on('updateInter', function (interObject) {
        updateInter(interObject, socket);
    }).on("updateScenario", function (scenario) {
        updateScenario(scenario, socket);
    }).on("updateTherCons", function (thermostat) {
        updateThermostat(thermostat, socket, "cons");
    }).on("updateTherDelta", function (thermostat) {
        updateThermostat(thermostat, socket, "delta");
    }).on("updateTherTempext", function (thermostat) {
        updateThermostat(thermostat, socket, "temp");
    }).on("updateTherInterne", function (thermostat) {
        updateThermostat(thermostat, socket, "int");
    }).on("updateTherMode", function (id) {
        updateThermostatMode(id);
    }).on("syncTherModes", function (id) {
        syncThermostatModes();
    }).on("updateTherPlan", function (id) {
        updateThermostatPlan(id);
    }).on("refreshTher", function () {
        refreshThermostat();
    }).on("updateTherClock", function (id) {
        updateThermostatRtc();
    }).on("getTherClock", function (id) {
        getThermostatClock();
    }).on("updateAquaClock", function (id) {
        updateAquariumClock();
    }).on("getAquaClock", function (id) {
        getAquariumClock();
    }).on('disconnect', function () {
        var clientIp = socket.request.connection.remoteAddress;
        logger.logToFile(config.rootPath + config.logPath, clientIp + ' Disconnected', true);
    });
});
server.listen(5901);

var port = new SerialPort(config.portPath, {
    baudRate: 9600
});

port.on('open', function () {
    logger.logToFile(config.rootPath + config.logPath, "port " + config.portPath + " opened", true);
}).on('error', function (err) {
    logger.logToFile(config.rootPath + config.logPath, err.message, true);
}).on('close', function () {
    logger.logToFile(config.rootPath + config.logPath, "port " + config.portPath + " closed", true);
}).on('data', function (data) {

    var datastr = data.toString();
    datastr = datastr.replace(/[\n\r]+/g, '');
    var dataTab = datastr.split(" ");
    var dataObj = {
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

        dataStr = dataObj.valeur1 + " " + dataObj.valeur2;
        io.sockets.emit("therclock", dataStr);
    }
    if (datastr != "") {
        var fullHour = df.stringifiedHour();
        io.sockets.emit("messageConsole", fullHour + " " + datastr);
        logger.logToFile(config.rootPath + config.logPath, datastr, true);
    }
});

function updateActionneur(actionneur, socket) {
    if (actionneur.categorie.includes("inter")) {
        updateInter(actionneur, socket);
    }
    if (actionneur.categorie.includes("dimmer")) {
        updateDimmerPersist(actionneur, socket);
    }
}

//UPDATE DU DIMMER
function updateDimmer(dimmerObject, socket, fromPersist) {
    if (dimmerObject.etat >= 0 && dimmerObject.etat <= 255) {
        var commande = [dimmerObject.module,
            dimmerObject.radioid,
            dimmerObject.etat
        ].join('/') + '/';
        writeAndDrain(commande + '/', function () {
            var clientIp = socket.request.connection.remoteAddress;

            if (!fromPersist) socket.broadcast.emit('dimmer', dimmerObject);
            else io.sockets.emit('dimmer', dimmerObject);
        });
    } else {
        logger.logToFile(config.rootPath + config.logPath,
            'In updateDimmer : value must be between 0 and 255',
            true);
    }
}

function updateDimmerPersist(dimmerObject, socket) {
    if (typeof (dimmerObject) === 'string') {
        dimmerObject = JSON.parse(dimmerObject);
    }
    if (dimmerObject.etat >= 0 && dimmerObject.etat <= 255) {
        updateDimmer(dimmerObject, socket, true);
        apiReq.post('actionneurs/update', dimmerObject);
        logger.logToFile(config.rootPath + config.logPath, dimmerObject.nom + ' ' + dimmerObject.etat, true);
        io.sockets.emit("messageConsole", df.stringifiedHour() + " " + dimmerObject.nom + ' ' + dimmerObject.etat);
    } else {
        logger.logToFile(config.rootPath + config.logPath,
            'In updateDimmerPersist : value must be between 0 and 255',
            true);
    }
}

//UPDATE INTER
function updateInter(interObject, socket) {
    if (typeof (interObject) === 'string') {
        interObject = JSON.parse(interObject);
    }
    var commande;
    if (interObject.etat >= 0 && interObject.etat <= 1) {
        switch (interObject.type) {
            case "relay":
                commande = [interObject.module,
                    interObject.protocole,
                    interObject.adresse,
                    interObject.radioid,
                    interObject.etat
                ].join('/');
                break;
            case "aqua":

                commande = [interObject.module,
                    interObject.protocole,
                    interObject.adresse,
                    interObject.type,
                    "set", "leds"
                ].join('/');
                break;
            default:
                logger.logToFile(config.rootPath + config.logPath, "Unknown Actuator type " + interObject.type, true);
                return;

        }
        logger.logToFile(config.rootPath + config.logPath, "update" + interObject.type + " " + interObject.nom, true);
        writeAndDrain(commande + '/', function () {
        });
        io.sockets.emit("messageConsole", df.stringifiedHour() + " " + interObject.nom + ' ' + interObject.etat);
        io.sockets.emit('inter', interObject);
        apiReq.post('actionneurs/update', interObject);
    } else {
        logger.logToFile(config.rootPath + config.logPath,
            'In updateInter : value must be 0 or 1',
            true);
    }
}

//UPDATE SCENARIOS
var lastCall = new Date().getTime();

function updateScenario(scenario, socket) {
    var now = new Date().getTime();
    var diff = now - lastCall;
    if (diff <= 2000) {
        logger.logToFile(config.rootPath + config.logPath, "Please wait before two scenarios calls", true);
        return;
    }

    if (typeof scenario === "undefined") {
        logger.logToFile(config.rootPath + config.logPath, "malformed scenario = " + scenario, true);
        return
    }

    if (typeof (scenario) === 'string') {
        scenario = JSON.parse(scenario);
    }

    var time = 0;
    io.sockets.emit("messageConsole", df.stringifiedHour() + 'updateScenario ' + scenario.nom);
    logger.logToFile(config.rootPath + config.logPath, 'updateScenario ' + scenario.nom, true);
    var items = [];
    for (var idx in scenario.data) {
        items.push(scenario.data[idx]);
    }
    items.forEach(function (val) {
        setTimeout(function () {
            updateActionneur(val, socket);
        }, time * 500);
        time++;
    });
    lastCall = new Date().getTime();
}

//THERMOSTAT
function updateThermostat(thermostat, socket, part) {
    if (typeof (thermostat) === 'string') {
        thermostat = JSON.parse(thermostat);
    }
    var val = null;
    if (part.includes("cons")) {
        val = thermostat.consigne;
    }
    if (val != null) {
        var commande = ["nrf24", "node", "2Nodw", "ther", "set", part, val].join('/');
        writeAndDrain(commande + '/', function () {
        });
    } else {
        logger.logToFile(config.rootPath + config.logPath, "given value is null", true);
    }
}

function updateAllThermostat(thermostat, socket) {
    updateThermostat(thermostat, socket, "cons");
    updateThermostat(thermostat, socket, "delta");
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
    writeAndDrain(commande + '/', function () {
    });
}

function getThermostatClock() {
    var commande = ["nrf24", "node", "2Nodw", "ther", "get", "rtc"].join('/');
    writeAndDrain(commande + '/', function () {
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
    writeAndDrain(commande + '/', function () {
    });
}

function getAquariumClock() {
    var commande = ["nrf24", "node", "3Nodw", "aqua", "get", "rtc"].join('/');
    writeAndDrain(commande + '/', function () {
    });
}

function refreshThermostat() {
    var commande = ["nrf24", "node", "2Nodw", "ther", "get", "info"].join('/');
    writeAndDrain(commande + '/', function () {
    });
}

//THERMOSTAT PERSISTANCE
function persistThermostat(dataObj) {
    apiReq.get('thermostat', (res) => {
        res.setEncoding('utf8');
        var rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
            thermostats = JSON.parse(rawData);
            thermostats.forEach(function (thermostat, index) {
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
    //THERMOPLANIFS
    apiReq.get("thermostat/mode/" + parseInt(id, 10), (res) => {
        res.setEncoding('utf8');
        var rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
            var mode = JSON.parse(rawData);
            if (id != null && id > 0 && id < 254) {
                var commande = ["nrf24", "node", "2Nodw", "ther", "sel", "mode", mode.id].join('/');
                writeAndDrain(commande + '/', function () {
                });
                refreshThermostat();
            } else {
                logger.logToFile(config.rootPath + config.logPath, "given value is null or out of bounds", true);
            }
        });
    });
}

function syncThermostatModes() {
    var time = 0;
    //THERMOPLANIFS
    apiReq.get("thermostat/mode/", (res) => {
        res.setEncoding('utf8');
        var rawData = '';
        res.on('data', (chunk) => {
            rawData += chunk;
            var modes = objToArray(JSON.parse(rawData));
            modes.forEach(function (mode) {
                setTimeout(function () {
                    var commande = ["nrf24", "node", "2Nodw", "ther", "put", "mode", mode.id, mode.consigne, mode.delta].join('/');
                    writeAndDrain(commande + '/', function () {
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
        logger.logToFile(config.rootPath + config.logPath, "given value is null or out of bounds", true);
        return;
    }

    if (id === 0) {
        var commande = ["nrf24", "node", "2Nodw", "ther", "set", "plan", id].join('/');
        writeAndDrain(commande + '/', function () {
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
            writeAndDrain(com + '/', function () {
            });
            var count = 1;
            setTimeout(function () {
                plans.forEach(function (plan) {
                    setTimeout(function () {
                        h1Start = plan.heure1Start;
                        h1Stop = plan.heure1Stop;
                        h2Start = plan.heure2Start;
                        h2Stop = plan.heure2Stop;
                        if (plan.heure1Start === null || plan.heure1Start == "") h1Start = "XX:XX";
                        if (plan.heure1Stop === null || plan.heure1Stop == "") h1Stop = "XX:XX";
                        if (plan.heure2Start === null || plan.heure2Start == "") h2Start = "XX:XX";
                        if (plan.heure2Stop === null || plan.heure2Stop == "") h2Stop = "XX:XX";
                        var commande = ["nrf24", "node", "2Nodw", "ther", "put", "plan",
                            plan.jour, plan.modeid, plan.defaultModeid,
                            h1Start, h1Stop, h2Start, h2Stop
                        ].join('/');
                        writeAndDrain(commande + '/', function () {
                        });

                        if (parseInt(plan.jour) < 7) {
                            return;
                        }

                        setTimeout(function () {
                            commande = ["nrf24", "node", "2Nodw", "ther", "save", "plan"].join('/');
                            writeAndDrain(commande + '/', function () {
                                logger.logToFile(config.rootPath + config.logPath, "savePlan " + plan.jour, true);
                            });
                        }, 200);

                    }, time * 120);
                    time++;
                });
            }, 500);
        });
    });
}

//SENSOR PERSISTANCE
function persistSensor(dataTab, dataObj) {
    var uri = 'mesures/add-' + dataObj.radioid + '-' + dataObj.valeur1;
    if (dataTab.length > 2) uri += '-' + dataObj.valeur2;
    apiReq.get(uri);
    capteurs.forEach(function (capteur, index) {
        if (capteur.radioid === dataObj.radioid) {
            capteur.valeur1 = dataObj.valeur1;
            capteur.valeur2 = dataObj.valeur2;
            if (capteur.valeur2 == undefined) {
                capteur.valeur2 = "";
            }
            capteur.releve = df.nowDatetime();
            capteur.actif = 1;
            if (dataObj.radioid.includes("ctn10") ||
                dataObj.radioid.includes("dht11")) {
                io.sockets.emit('thermo', capteur);
            }
            if (dataObj.radioid.includes("tinfo")) {
                io.sockets.emit('teleinfo', capteur);
            }
            if (dataObj.radioid.includes("therm")) {
                io.sockets.emit('chaudiere', capteur);
            }
        }
    });
}

function writeAndDrain(data, callback) {
    port.write(data, function () {
    });
    port.drain(callback);
}
