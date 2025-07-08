const Utils = {};
const Keys = require("./keys");
const Crypto = require('crypto');

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

module.exports = Utils;
