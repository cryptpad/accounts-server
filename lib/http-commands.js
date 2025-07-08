// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Nacl = require("tweetnacl/nacl-fast");
const NaclUtil = require("tweetnacl-util");

let commands = {};

const Util = {
    clone: o => {
        if (o === undefined || o === null) { return o; }
        return JSON.parse(JSON.stringify(o));
    },
    serializeError: err => {
        if (!(err instanceof Error)) { return err; }
        var ser = {};
        Object.getOwnPropertyNames(err).forEach(function (key) {
            ser[key] = err[key];
        });
        return ser;
    }
};

const CHALLENGE_TIMEOUT = 2*60*1000; // 2min
const challenges = {};
const addChallenge = (txid, body) => {
    //console.log("Add challenge", txid, body);
    challenges[txid] = body;
};
const getChallenge = (txid) => {
    const body = challenges[txid];
    delete challenges[txid];
    //console.log("Get challenge", txid, body);
    return body;
};

// Every 15s, check for deprecated challenges
setInterval(() => {
    const timeout = +new Date() - CHALLENGE_TIMEOUT;
    Object.keys(challenges).forEach(txid => {
        const data = challenges[txid];
        if (!data.date || data.date < timeout) {
            delete challenges[txid];
            return;
        }
    });
}, 15*1000);


var randomToken = () => NaclUtil.encodeBase64(Nacl.randomBytes(24)).replace(/\//g, '-');

// this function handles the first stage of the protocol
// (the server's validation of the client's request and the generation of its challenge)
var handleCommand = function (req, res) {
    var body = req.body;
    var command = body.command;


    // reject if the command does not have a corresponding function
    if (typeof(commands[command]) !== 'function') {
        console.error('CHALLENGE_UNSUPPORTED_COMMAND', command);
        return void res.status(500).json({
            error: 'invalid command',
        });
    }

    var publicKey = body.publicKey;
    // reject if they did not provide a valid public key
    if (!publicKey || typeof(publicKey) !== 'string' || publicKey.length !== 44) {
        console.error('CHALLENGE_INVALID_KEY', publicKey);
        return void res.status(500).json({
            error: 'Invalid key',
        });
    }

    var txid = randomToken();
    var date = +new Date();

    var copy = Util.clone(body);
    copy.txid = txid;
    copy.date = date;

    const copyTxt = JSON.stringify(copy);
    const length = copyTxt.length;
    if (length > 10000) {
        console.error('CHALLENGE_COMMAND_EXECUTION_ERROR', {
            publicKey,
            length
        });
        return void res.status(500).json({
            error: 'TOO_LONG',
        });
    }

    // Write the command and challenge to disk, because the challenge protocol
    // is interactive and the subsequent response might be handled by a different http worker
    // this makes it so we can avoid holding state in memory
    addChallenge(txid, copyTxt);
    return void res.status(200).json({
        txid: txid,
        date: date,
    });
};

// this function handles the second stage of the protocol
// (the client's response to the server's challenge)
var handleResponse = function (ctx, req, res, isUpload) {
    var body = req.body;

    if (Object.keys(body).some(k => !/(sig|txid)/.test(k))) {
        console.error("CHALLENGE_RESPONSE_DEBUGGING", body);
        // we expect the response to only have two keys
        // if any more are present then the response is malformed
        return void res.status(500).json({
            error: 'extraneous parameters',
        });
    }

    // transaction ids are issued to the client by the server
    // they allow it to recall the full details of the challenge
    // to which the client is responding
    var txid = body.txid;

    // if no txid is present, then the server can't look up the corresponding challenge
    // the response is definitely malformed, so reject it.
    // Additionally, we expect txids to be 32 characters long (24 Uint8s as base64)
    // reject txids of any other length
    if (!txid || typeof(txid) !== 'string' || txid.length !== 32) {
        console.error('CHALLENGE_RESPONSE_BAD_TXID', body);
        return void res.status(500).json({
            error: "Invalid txid",
        });
    }

    var sig = body.sig;
    if (!sig || typeof(sig) !== 'string' || sig.length !== 88) {
        console.error("CHALLENGE_RESPONSE_BAD_SIG", body);
        return void res.status(500).json({
            error: "Missing signature",
        });
    }

    const text = getChallenge(txid);
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        console.error("CHALLENGE_READ_ERROR", {
            text: text,
            txid: txid,
            error: Util.serializeError(e),
        });
        return void res.status(500).json({
            error: "Unexpected response",
        });
    }

    const publicKey = json.publicKey;
    if (!publicKey || typeof(publicKey) !== 'string') {
        // This shouldn't happen, as we expect that the server
        // will have validated the key to an extent before storing the challenge
        console.error('CHALLENGE_INVALID_PUBLICKEY', {
            publicKey: publicKey,
        });
        return res.status(500).json({
            error: "Invalid public key",
        });
    }

    if (isUpload && req.file) {
        json.file = req.file;
    }


    const action = commands[json.command];

    if (typeof(action) !== 'function') {
        console.error("CHALLENGE_RESPONSE_ACTION_NOT_IMPLEMENTED", json.command);
        return res.status(501).json({
            error: 'Not implemented',
        });
    }

    var u8_toVerify,
        u8_sig,
        u8_publicKey;

    try {
        u8_toVerify = NaclUtil.decodeUTF8(text);
        u8_sig = NaclUtil.decodeBase64(sig);
        u8_publicKey = NaclUtil.decodeBase64(publicKey);
    } catch (err3) {
        console.error('CHALLENGE_RESPONSE_DECODING_ERROR', {
            text: text,
            sig: sig,
            publicKey: publicKey,
            error: Util.serializeError(err3),
        });
        return res.status(500).json({
            error: "decoding error"
        });
    }

    // validate the response
    var success = Nacl.sign.detached.verify(u8_toVerify, u8_sig, u8_publicKey);
    if (success !== true) {
        console.error("CHALLENGE_RESPONSE_SIGNATURE_FAILURE", {
            publicKey,
        });
        return void res.status(500).json({
            error: 'Failed signature validation',
        });
    }

    // execute the command
    let called = false;
    action(ctx, json, function (err, content, download) {
        if (called) { return; }
        called = true;
        if (err) {
            console.error("CHALLENGE_RESPONSE_ACTION_ERROR", {
                error: Util.serializeError(err),
            });
            return res.status(500).json({
                error: 'Execution error',
                errorCode: Util.serializeError(err)
            });
        }
        if (download?.path) {
            return res.download(download?.path);
        }
        res.status(200).json(content);
    }, req, res);
};


const setCommands = (_commands) => {
    commands = _commands;
};
const handle = function (ctx, req, res, isUpload) {
    var body = req.body;
    // we expect that the client has posted some JSON data
    if (!body) {
        return void res.status(500).json({
            error: 'invalid request',
        });
    }

    // we only expect responses to challenges to have a 'txid' attribute
    // further validation is performed in handleResponse
    if (body.txid) {
        return void handleResponse(ctx, req, res, isUpload);
    }

    // we only expect initial requests to have a 'command' attribute
    // further validation is performed in handleCommand
    if (body.command) {
        return void handleCommand(req, res, isUpload);
    }

    // if a request is neither a command nor a response, then reject it with an error
    res.status(500).json({
        error: 'invalid request',
    });
};

module.exports = {
    setCommands,
    handle
};
