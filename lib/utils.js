const Utils = {};
const Keys = require("./keys");
const Crypto = require('crypto');
const config = require('../config/config');
const Axios = require('axios');
const Nacl = require('tweetnacl/nacl-fast');
const NaclUtil = require("tweetnacl-util");

Utils.isYearlyPlan = str => {
    return /12$/.test(str);
};
Utils.getBasePlan = str => {
    return str.replace(/12$/, '');
};
Utils.getOrgPlans = str => {
    return str.replace(/12$/, '');
};

Utils.parseUser = (user) => {
    let p /* parsed */ = Keys.parseUser(user);
    return {
        domain: p.domain,
        username: p.user, // different API clientside and serverside :/
        pubkey: p.pubkey,
    };
};
Utils.makeUser = u => {
    return Keys.serialize(u.domain, u.username, u.pubkey);
};
Utils.log = msg => {
    if (Array.isArray(msg)) { msg.push(new Date()); }
    console.log(JSON.stringify(msg));
};


const serializeError = function (err) {
    if (!(err instanceof Error)) { return err; }
    var ser = {};
    Object.getOwnPropertyNames(err).forEach(function (key) {
        ser[key] = err[key];
    });
    return ser;
};
Utils.error = (...err) => {
    const errors = err.map(serializeError);
    console.error(errors);
};

Utils.ENABLED_STATUS = [
    'active',
    'trialing', // Trial period added to Stripe
    'past_due' // Payment has failed, but Stripe will try again (15 days max)
];

Utils.now = () => (+new Date());
Utils.random = () => {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
};

Utils.getBasePlan = str => {
    return str.replace(/12$/, '');
};

Utils.mkRandomCookie = function () {
    return Crypto.randomBytes(16).toString('hex');
};

const getAuthProof = () => {
    if (!config.cryptpadSecret) { return ''; }
    const secretKey = NaclUtil.decodeBase64(config.cryptpadSecret);
    console.log(secretKey);
    const msg = NaclUtil.decodeUTF8(JSON.stringify({
        time: +new Date()
    }));
    const nonce = Nacl.randomBytes(Nacl.box.nonceLength);
    return NaclUtil.encodeBase64(nonce) + '|' +
           NaclUtil.encodeBase64(Nacl.secretbox(msg, nonce, secretKey));
};
Utils.forceCryptPadUpdate = (cb) => {
    const origin = config.cryptpadOrigin;
    if (!origin) { return; }
    let auth = getAuthProof();
    Axios.post(origin + '/api/updatequota', {
        auth
    }, {
        headers: {
            'Content-Type': 'application/json'
        }
    }).then(() => {
        Utils.log(['INFO', 'forceQuotaUpdate', 'success']);
        if (typeof(cb) === "function") { cb(); }
    }).catch((err) => {
        Utils.error(["EUPDATE", "Can't update quota on CryptPad instance", err.status]);
        if (typeof(cb) === "function") { cb('EUPDATE'); }
    });
};

module.exports = Utils;
